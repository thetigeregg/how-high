import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../../config.js";
import { gpxSource, measureSource, type RouteSource } from "../../exposure/pipeline.js";
import { parseDirectionsUrl, resolveLink } from "../../google/link.js";
import { fetchRoute } from "../../google/routes.js";
import type { Measurement } from "../../exposure/analyze.js";
import { parseGpx, type GpxTrack } from "../../gpx/parse.js";
import { writeGpx } from "../../gpx/write.js";
import { dismiss, enqueue, isBeingReanalysed, listJobs, type JobControls } from "../../jobs.js";
import {
  annotateSections,
  gpxPath,
  invalidateReferences,
  hasSource,
  loadAnalysis,
  verdictOn,
  remeasure,
  retryContextLater,
  routePath,
  scoreWith,
} from "../../hikes.js";
import { loadSettings } from "../../settings.js";

const patchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  rating: z.enum(["fine", "uneasy", "bad"]).nullable().optional(),
  status: z.enum(["planned", "done"]).optional(),
});

const causeSchema = z.enum(["drops", "view", "both", "other"]).nullable();

const markSchema = z
  .object({
    kind: z.enum(["fine", "uneasy", "bad", "turned_back"]),
    startM: z.number().nonnegative(),
    endM: z.number().nonnegative(),
    note: z.string().trim().max(500).optional(),
    cause: causeSchema.optional(),
  })
  .refine((mark) => mark.endM >= mark.startM, { message: "endM must not be before startM" });

const idSchema = z.coerce.number().int().positive();

interface AnalysisRow {
  id: number;
  name: string;
  created_at: string;
  length_m: number;
  level: string;
  max_score: number;
  terrain_source: string;
  confidence: string;
  rating: string | null;
  kind: string;
  source_url: string | null;
  status: string;
}

interface MarkRow {
  id: number;
  kind: string;
  start_m: number;
  end_m: number;
  note: string | null;
  cause: string | null;
  created_at: string;
}

function serializeMark(row: MarkRow) {
  return {
    id: row.id,
    kind: row.kind,
    startM: row.start_m,
    endM: row.end_m,
    note: row.note,
    cause: row.cause,
    createdAt: row.created_at,
  };
}

const SUMMARY_COLUMNS =
  "id, name, created_at, length_m, level, max_score, terrain_source, confidence, rating, kind, source_url, status";

function serialize(row: AnalysisRow) {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    lengthM: row.length_m,
    level: row.level,
    maxScore: row.max_score,
    terrainSource: row.terrain_source,
    confidence: row.confidence,
    rating: row.rating,
    kind: row.kind,
    sourceUrl: row.source_url,
    status: row.status,
    // Whether there is an uploaded GPX file to give back. Entries made from a
    // link have none; for those a GPX is written from the measured line.
    hasGpx: fs.existsSync(gpxPath(row.id)),
  };
}

export function registerAnalysesRoute(app: FastifyInstance) {
  const getRow = (id: number) =>
    app.db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM analyses WHERE id = ?`).get(id) as AnalysisRow | undefined;

  app.get("/api/analyses", async () => {
    const rows = app.db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM analyses ORDER BY id DESC`).all() as AnalysisRow[];
    return { analyses: rows.map(serialize) };
  });

  /**
   * Measures a new hike or route and stores it; run as a background job. Map
   * context gets only a few seconds per piece here; if it is not there in
   * time the entry is stored without it and completed later.
   */
  async function create(source: RouteSource, fallbackName: string, original: { gpx: string } | null, controls: JobControls): Promise<number> {
    const settings = loadSettings(app.db);
    const measurement = await measureSource(source, settings.measure, { quickContext: true, controls });
    const analysis = scoreWith(measurement, settings);
    const { lastInsertRowid } = app.db
      .prepare(
        `INSERT INTO analyses (name, created_at, length_m, level, max_score, terrain_source, confidence, result, kind, source_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        source.name ?? fallbackName,
        new Date().toISOString(),
        measurement.lengthM,
        analysis.summary.level,
        analysis.summary.maxScore,
        measurement.terrain.source,
        measurement.terrain.confidence,
        JSON.stringify(measurement),
        // A walking link is a hike like any other; only what it was made from differs.
        source.profile === "hike" ? "hike" : "route",
        source.url,
      );
    const id = Number(lastInsertRowid);
    fs.mkdirSync(config.uploadsDir, { recursive: true });
    if (original) fs.writeFileSync(gpxPath(id), original.gpx);
    else fs.writeFileSync(routePath(id), JSON.stringify(source));
    if (!measurement.mapContext) retryContextLater(app.db, id);
    return id;
  }

  app.post("/api/analyses", async (request, reply) => {
    const upload = await request.file();
    if (!upload) return reply.status(400).send({ error: "no file uploaded" });
    const xml = (await upload.toBuffer()).toString("utf-8");

    let gpx: GpxTrack;
    try {
      gpx = parseGpx(xml);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
    const fallback = path.basename(upload.filename, path.extname(upload.filename));
    // What is wrong with the file is said at once; the measuring happens in the background.
    const job = enqueue({ kind: "hike", label: gpx.name ?? fallback, reanalysisOf: null }, (controls) =>
      create(gpxSource(gpx), fallback, { gpx: xml }, controls),
    );
    return reply.status(202).send(job);
  });

  // A route from a shared Google Maps directions link.
  app.post("/api/routes", async (request, reply) => {
    const parsed = z.object({ url: z.string().trim().min(1).max(4000) }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "paste a Google Maps link" });
    if (!config.googleMapsApiKey) return reply.status(503).send({ error: "Google Maps links are not set up (no API key)" });

    let source: RouteSource;
    try {
      const full = await resolveLink(parsed.data.url);
      source = await fetchRoute(parseDirectionsUrl(full), parsed.data.url);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
    // The link has been read and Google has answered by now, so a bad link is refused at once.
    const kind = source.profile === "hike" ? "hike" : "route";
    const job = enqueue({ kind, label: source.name ?? "Route", reanalysisOf: null }, (controls) =>
      create(source, "Route", null, controls),
    );
    return reply.status(202).send(job);
  });

  // Background measuring: what is waiting, running, or has just ended.
  app.get("/api/jobs", async () => ({ jobs: listJobs() }));

  // Cancels a job that is waiting or running, or clears one that has ended.
  app.delete("/api/jobs/:jobId", async (request, reply) => {
    const jobId = idSchema.safeParse((request.params as { jobId: string }).jobId);
    if (!jobId.success || !dismiss(jobId.data)) return reply.status(404).send({ error: "not found" });
    return reply.status(204).send();
  });

  app.get("/api/analyses/:id", async (request, reply) => {
    const id = idSchema.safeParse((request.params as { id: string }).id);
    if (!id.success || !getRow(id.data)) return reply.status(404).send({ error: "not found" });
    const settings = loadSettings(app.db);
    const analysis = await loadAnalysis(app.db, id.data, settings);
    if (!analysis) return reply.status(409).send({ error: "this entry cannot be measured again; add it anew" });
    // Read after loading: measuring again refreshes the summary columns.
    const row = getRow(id.data)!;
    const marks = app.db
      .prepare("SELECT * FROM marks WHERE analysis_id = ? ORDER BY start_m, id")
      .all(row.id) as MarkRow[];
    const sections = await annotateSections(app.db, id.data, analysis, settings);
    // A verdict is a forecast, so it is only offered while the route is still ahead.
    const verdict = row.status === "planned" ? await verdictOn(app.db, id.data, analysis, settings) : null;
    return { summary: serialize(row), marks: marks.map(serializeMark), verdict, result: { ...analysis, sections } };
  });

  app.post("/api/analyses/:id/marks", async (request, reply) => {
    const id = idSchema.safeParse((request.params as { id: string }).id);
    const analysis = id.success ? getRow(id.data) : undefined;
    if (!analysis) return reply.status(404).send({ error: "not found" });
    const parsed = markSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid body", details: parsed.error.flatten() });
    }
    const mark = parsed.data;
    if (mark.endM > analysis.length_m) return reply.status(400).send({ error: "mark lies beyond the end of the route" });
    const { lastInsertRowid } = app.db
      .prepare("INSERT INTO marks (analysis_id, kind, start_m, end_m, note, cause, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      // A stretch that was fine has no cause to give.
      .run(analysis.id, mark.kind, mark.startM, mark.endM, mark.note || null, mark.kind === "fine" ? null : (mark.cause ?? null), new Date().toISOString());
    // Saying how a stretch felt means having been there.
    app.db.prepare("UPDATE analyses SET status = 'done' WHERE id = ?").run(analysis.id);
    invalidateReferences();
    const row = app.db.prepare("SELECT * FROM marks WHERE id = ?").get(lastInsertRowid) as MarkRow;
    return reply.status(201).send(serializeMark(row));
  });

  // Says, or changes, what it was about a marked stretch.
  app.patch("/api/analyses/:id/marks/:markId", async (request, reply) => {
    const params = request.params as { id: string; markId: string };
    const id = idSchema.safeParse(params.id);
    const markId = idSchema.safeParse(params.markId);
    const parsed = z.object({ cause: causeSchema }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid body" });
    const changed =
      id.success && markId.success
        ? app.db
            .prepare("UPDATE marks SET cause = ? WHERE id = ? AND analysis_id = ? AND kind != 'fine'")
            .run(parsed.data.cause, markId.data, id.data).changes
        : 0;
    if (changed === 0) return reply.status(404).send({ error: "not found" });
    invalidateReferences();
    return serializeMark(app.db.prepare("SELECT * FROM marks WHERE id = ?").get(markId.data) as MarkRow);
  });

  app.delete("/api/analyses/:id/marks/:markId", async (request, reply) => {
    const params = request.params as { id: string; markId: string };
    const id = idSchema.safeParse(params.id);
    const markId = idSchema.safeParse(params.markId);
    const deleted =
      id.success && markId.success
        ? app.db.prepare("DELETE FROM marks WHERE id = ? AND analysis_id = ?").run(markId.data, id.data).changes
        : 0;
    if (deleted === 0) return reply.status(404).send({ error: "not found" });
    invalidateReferences();
    return reply.status(204).send();
  });

  // The entry as a GPX file: the one it was made from, exactly as uploaded,
  // or, for an entry made from a link, one written from the line that was measured.
  app.get("/api/analyses/:id/gpx", async (request, reply) => {
    const id = idSchema.safeParse((request.params as { id: string }).id);
    const row = id.success ? getRow(id.data) : undefined;
    if (!row) return reply.status(404).send({ error: "not found" });
    let gpx: Buffer | string;
    if (fs.existsSync(gpxPath(row.id))) {
      gpx = fs.readFileSync(gpxPath(row.id));
    } else {
      const { result } = app.db.prepare("SELECT result FROM analyses WHERE id = ?").get(row.id) as { result: string };
      const measurement = JSON.parse(result) as Measurement;
      if (!measurement.points?.length) return reply.status(404).send({ error: "there is no line to export for this entry" });
      gpx = writeGpx(measurement, row.name.trim() || "Untitled", row.source_url);
    }
    // A plain-ASCII name for old clients, and the real one (accents and all) for the rest.
    const name = (row.name.trim() || "hike").replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
    const ascii = name.normalize("NFKD").replace(/[^\x20-\x7e]/g, "").replace(/"/g, "").trim() || "hike";
    return reply
      .header("Content-Type", "application/gpx+xml; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${ascii}.gpx"; filename*=UTF-8''${encodeURIComponent(`${name}.gpx`)}`)
      .send(gpx);
  });

  // Measures the entry again from what it was made from, as a background job,
  // e.g. to retry map context that was unavailable. Name, rating and marks are kept.
  app.post("/api/analyses/:id/reanalyse", async (request, reply) => {
    const id = idSchema.safeParse((request.params as { id: string }).id);
    if (!id.success || !getRow(id.data) || !hasSource(id.data)) {
      return reply.status(404).send({ error: "not found" });
    }
    const target = id.data;
    const row = getRow(target)!;
    if (isBeingReanalysed(target)) return reply.status(409).send({ error: "this is already being measured again" });
    const job = enqueue({ kind: row.kind === "route" ? "route" : "hike", label: row.name, reanalysisOf: target }, async (controls) => {
      const measurement = await remeasure(app.db, target, loadSettings(app.db), controls);
      if (!measurement.mapContext) retryContextLater(app.db, target);
      return target;
    });
    return reply.status(202).send(job);
  });

  app.patch("/api/analyses/:id", async (request, reply) => {
    const id = idSchema.safeParse((request.params as { id: string }).id);
    if (!id.success || !getRow(id.data)) return reply.status(404).send({ error: "not found" });
    const parsed = patchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid body", details: parsed.error.flatten() });
    }
    const patch = parsed.data;
    if (patch.name !== undefined) {
      app.db.prepare("UPDATE analyses SET name = ? WHERE id = ?").run(patch.name, id.data);
      invalidateReferences();
    }
    if (patch.rating !== undefined) {
      app.db.prepare("UPDATE analyses SET rating = ? WHERE id = ?").run(patch.rating, id.data);
      if (patch.rating !== null) app.db.prepare("UPDATE analyses SET status = 'done' WHERE id = ?").run(id.data);
    }
    if (patch.status !== undefined) {
      app.db.prepare("UPDATE analyses SET status = ? WHERE id = ?").run(patch.status, id.data);
    }
    return serialize(getRow(id.data)!);
  });

  app.delete("/api/analyses/:id", async (request, reply) => {
    const id = idSchema.safeParse((request.params as { id: string }).id);
    if (!id.success || !getRow(id.data)) return reply.status(404).send({ error: "not found" });
    app.db.prepare("DELETE FROM analyses WHERE id = ?").run(id.data);
    invalidateReferences();
    fs.rmSync(gpxPath(id.data), { force: true });
    fs.rmSync(routePath(id.data), { force: true });
    return reply.status(204).send();
  });
}
