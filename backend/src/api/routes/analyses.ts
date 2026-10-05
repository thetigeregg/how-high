import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../../config.js";
import { analyseGpx } from "../../exposure/analyze.js";
import { parseGpx, type GpxTrack } from "../../gpx/parse.js";

const patchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  rating: z.enum(["fine", "uneasy", "bad"]).nullable().optional(),
});

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

    const analysis = await analyseGpx(gpx);
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
        JSON.stringify(analysis),
      );
    const id = Number(lastInsertRowid);
    // The original file is kept so hikes can be re-scored when the model changes.
    fs.mkdirSync(config.uploadsDir, { recursive: true });
    fs.writeFileSync(path.join(config.uploadsDir, `${id}.gpx`), xml);

    return reply.status(201).send(serialize(getRow(id)!));
  });

  app.get("/api/analyses/:id", async (request, reply) => {
    const id = idSchema.safeParse((request.params as { id: string }).id);
    const row = id.success
      ? (app.db.prepare(`SELECT ${SUMMARY_COLUMNS}, result FROM analyses WHERE id = ?`).get(id.data) as
          | (AnalysisRow & { result: string })
          | undefined)
      : undefined;
    if (!row) return reply.status(404).send({ error: "not found" });
    // The stored JSON is spliced in as-is rather than parsed and re-serialised.
    return reply
      .type("application/json")
      .send(`{"summary":${JSON.stringify(serialize(row))},"result":${row.result}}`);
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
    fs.rmSync(path.join(config.uploadsDir, `${id.data}.gpx`), { force: true });
    return reply.status(204).send();
  });
}
