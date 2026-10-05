import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../../config.js";
import { measureGpx, score } from "../../exposure/analyze.js";
import { parseGpx, type GpxTrack } from "../../gpx/parse.js";
import { gpxPath, loadAnalysis, remeasure } from "../../hikes.js";
import { loadSettings } from "../../settings.js";

const patchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  rating: z.enum(["fine", "uneasy", "bad"]).nullable().optional(),
});

const markSchema = z
  .object({
    kind: z.enum(["fine", "uneasy", "bad", "turned_back"]),
    startM: z.number().nonnegative(),
    endM: z.number().nonnegative(),
    note: z.string().trim().max(500).optional(),
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
}

interface MarkRow {
  id: number;
  kind: string;
  start_m: number;
  end_m: number;
  note: string | null;
  created_at: string;
}

function serializeMark(row: MarkRow) {
  return {
    id: row.id,
    kind: row.kind,
    startM: row.start_m,
    endM: row.end_m,
    note: row.note,
    createdAt: row.created_at,
  };
}

const SUMMARY_COLUMNS = "id, name, created_at, length_m, level, max_score, terrain_source, confidence, rating";

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
  };
}

export function registerAnalysesRoute(app: FastifyInstance) {
  const getRow = (id: number) =>
    app.db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM analyses WHERE id = ?`).get(id) as AnalysisRow | undefined;

  app.get("/api/analyses", async () => {
    const rows = app.db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM analyses ORDER BY id DESC`).all() as AnalysisRow[];
    return { analyses: rows.map(serialize) };
  });

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

    const settings = loadSettings(app.db);
    const measurement = await measureGpx(gpx, settings.measure);
    const analysis = score(measurement, settings.score);
    const name = analysis.name ?? path.basename(upload.filename, path.extname(upload.filename));
    const { lastInsertRowid } = app.db
      .prepare(
        `INSERT INTO analyses (name, created_at, length_m, level, max_score, terrain_source, confidence, result)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        name,
        new Date().toISOString(),
        analysis.lengthM,
        analysis.summary.level,
        analysis.summary.maxScore,
        analysis.terrain.source,
        analysis.terrain.confidence,
        JSON.stringify(measurement),
      );
    const id = Number(lastInsertRowid);
    // The original file is kept so hikes can be re-scored when the model changes.
    fs.mkdirSync(config.uploadsDir, { recursive: true });
    fs.writeFileSync(gpxPath(id), xml);

    return reply.status(201).send(serialize(getRow(id)!));
  });

  app.get("/api/analyses/:id", async (request, reply) => {
    const id = idSchema.safeParse((request.params as { id: string }).id);
    if (!id.success || !getRow(id.data)) return reply.status(404).send({ error: "not found" });
    const analysis = await loadAnalysis(app.db, id.data);
    if (!analysis) return reply.status(409).send({ error: "this hike has no stored GPX to measure again; upload it anew" });
    // Read after loading: measuring again refreshes the summary columns.
    const row = getRow(id.data)!;
    const marks = app.db
      .prepare("SELECT * FROM marks WHERE analysis_id = ? ORDER BY start_m, id")
      .all(row.id) as MarkRow[];
    return { summary: serialize(row), marks: marks.map(serializeMark), result: analysis };
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
      .prepare("INSERT INTO marks (analysis_id, kind, start_m, end_m, note, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(analysis.id, mark.kind, mark.startM, mark.endM, mark.note || null, new Date().toISOString());
    const row = app.db.prepare("SELECT * FROM marks WHERE id = ?").get(lastInsertRowid) as MarkRow;
    return reply.status(201).send(serializeMark(row));
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
    return reply.status(204).send();
  });

  // Measures the hike again from the stored GPX, e.g. to retry map context
  // that was unavailable. The hike's name, rating and marks are kept.
  app.post("/api/analyses/:id/reanalyse", async (request, reply) => {
    const id = idSchema.safeParse((request.params as { id: string }).id);
    if (!id.success || !getRow(id.data) || !fs.existsSync(gpxPath(id.data))) {
      return reply.status(404).send({ error: "not found" });
    }
    await remeasure(app.db, id.data, loadSettings(app.db));
    return serialize(getRow(id.data)!);
  });

  app.patch("/api/analyses/:id", async (request, reply) => {
    const id = idSchema.safeParse((request.params as { id: string }).id);
    if (!id.success || !getRow(id.data)) return reply.status(404).send({ error: "not found" });
    const parsed = patchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid body", details: parsed.error.flatten() });
    }
    const patch = parsed.data;
    if (patch.name !== undefined) app.db.prepare("UPDATE analyses SET name = ? WHERE id = ?").run(patch.name, id.data);
    if (patch.rating !== undefined) {
      app.db.prepare("UPDATE analyses SET rating = ? WHERE id = ?").run(patch.rating, id.data);
    }
    return serialize(getRow(id.data)!);
  });

  app.delete("/api/analyses/:id", async (request, reply) => {
    const id = idSchema.safeParse((request.params as { id: string }).id);
    if (!id.success || !getRow(id.data)) return reply.status(404).send({ error: "not found" });
    app.db.prepare("DELETE FROM analyses WHERE id = ?").run(id.data);
    fs.rmSync(gpxPath(id.data), { force: true });
    return reply.status(204).send();
  });
}
