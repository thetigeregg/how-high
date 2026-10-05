import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type Database from "better-sqlite3";
import { z } from "zod";
import { config } from "./config.js";
import { MEASURE_VERSION } from "./exposure/analyze.js";
import { gpxPath, invalidateReferences, refreshAll, routePath } from "./hikes.js";
import { loadSettings, saveSettings, settingsSchema } from "./settings.js";

// Moving a library between installations: everything the user has added and
// said, in one file. Terrain and map caches are left behind; they are large
// and fetched again when needed.

const FORMAT = "how-high-export";
const FORMAT_VERSION = 1;
const BACKUPS_KEPT = 3;

const entrySchema = z.object({
  name: z.string(),
  createdAt: z.string(),
  kind: z.enum(["hike", "route"]),
  sourceUrl: z.string().nullable(),
  status: z.enum(["planned", "done"]),
  rating: z.enum(["fine", "uneasy", "bad"]).nullable(),
  lengthM: z.number(),
  level: z.string(),
  maxScore: z.number(),
  terrainSource: z.string(),
  confidence: z.string(),
  /** What the entry was made from, as stored: GPX text for a hike, the fetched route as JSON text for a link. */
  source: z.object({ type: z.enum(["gpx", "route"]), text: z.string() }).nullable(),
  /** The stored measurement, passed through untouched. */
  measurement: z.unknown(),
  marks: z.array(
    z.object({
      kind: z.enum(["fine", "uneasy", "bad", "turned_back"]),
      startM: z.number(),
      endM: z.number(),
      note: z.string().nullable(),
      cause: z.enum(["drops", "view", "both", "other"]).nullable(),
      createdAt: z.string(),
    }),
  ),
});

const fileSchema = z.object({
  format: z.literal(FORMAT),
  version: z.literal(FORMAT_VERSION),
  exportedAt: z.string(),
  measureVersion: z.number(),
  settings: settingsSchema,
  entries: z.array(entrySchema),
});

export type ExportFile = z.infer<typeof fileSchema>;
type Entry = ExportFile["entries"][number];

interface Row {
  id: number;
  name: string;
  created_at: string;
  length_m: number;
  level: string;
  max_score: number;
  terrain_source: string;
  confidence: string;
  rating: Entry["rating"];
  result: string;
  kind: Entry["kind"];
  source_url: string | null;
  status: Entry["status"];
}

interface MarkRow {
  kind: Entry["marks"][number]["kind"];
  start_m: number;
  end_m: number;
  note: string | null;
  cause: Entry["marks"][number]["cause"];
  created_at: string;
}

function readSource(id: number): Entry["source"] {
  if (fs.existsSync(gpxPath(id))) return { type: "gpx", text: fs.readFileSync(gpxPath(id), "utf-8") };
  if (fs.existsSync(routePath(id))) return { type: "route", text: fs.readFileSync(routePath(id), "utf-8") };
  return null;
}

/**
 * What makes two entries the same hike or route: the file or route they were
 * made from. Names can be edited and dates differ between installations.
 */
const keyOf = (entry: Pick<Entry, "source" | "name" | "createdAt">) =>
  createHash("sha1")
    .update(entry.source ? entry.source.text : `${entry.name}\n${entry.createdAt}`)
    .digest("hex");

function collect(db: Database.Database): ExportFile {
  const rows = db.prepare("SELECT * FROM analyses ORDER BY id").all() as Row[];
  const marks = db.prepare("SELECT kind, start_m, end_m, note, cause, created_at FROM marks WHERE analysis_id = ? ORDER BY start_m, id");
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    measureVersion: MEASURE_VERSION,
    settings: loadSettings(db),
    entries: rows.map((row) => ({
      name: row.name,
      createdAt: row.created_at,
      kind: row.kind,
      sourceUrl: row.source_url,
      status: row.status,
      rating: row.rating,
      lengthM: row.length_m,
      level: row.level,
      maxScore: row.max_score,
      terrainSource: row.terrain_source,
      confidence: row.confidence,
      source: readSource(row.id),
      measurement: JSON.parse(row.result) as unknown,
      marks: (marks.all(row.id) as MarkRow[]).map((m) => ({
        kind: m.kind,
        startM: m.start_m,
        endM: m.end_m,
        note: m.note,
        cause: m.cause,
        createdAt: m.created_at,
      })),
    })),
  };
}

/** The whole library and the settings as one compressed file. */
export function buildExport(db: Database.Database): Buffer {
  return gzipSync(JSON.stringify(collect(db)));
}

/** Reads and checks an export file. Throws with a plain message when it is not one. */
export function readExport(buffer: Buffer): ExportFile {
  let parsed: unknown;
  try {
    // 0x1f 0x8b marks a gzip file; an export unpacked by hand is accepted too.
    const text = buffer[0] === 0x1f && buffer[1] === 0x8b ? gunzipSync(buffer).toString("utf-8") : buffer.toString("utf-8");
    parsed = JSON.parse(text);
  } catch {
    throw new Error("That file is not a How High export");
  }
  const result = fileSchema.safeParse(parsed);
  if (!result.success) {
    const other = (parsed as { format?: unknown; version?: unknown } | null) ?? {};
    throw new Error(
      other.format === FORMAT
        ? `That export is from a different version of How High (file format ${String(other.version)}); it cannot be read here`
        : "That file is not a How High export",
    );
  }
  return result.data;
}

/** The id of each entry here, by what it was made from. */
function entriesHere(db: Database.Database): Map<string, number> {
  const rows = db.prepare("SELECT id, name, created_at FROM analyses").all() as Array<Pick<Row, "id" | "name" | "created_at">>;
  return new Map(rows.map((row) => [keyOf({ source: readSource(row.id), name: row.name, createdAt: row.created_at }), row.id]));
}

/** What a file contains and what each way of importing it would do. Changes nothing. */
export function previewImport(db: Database.Database, data: ExportFile) {
  const here = entriesHere(db);
  const shared = data.entries.filter((entry) => here.has(keyOf(entry))).length;
  return {
    file: {
      exportedAt: data.exportedAt,
      hikes: data.entries.filter((e) => e.kind === "hike").length,
      routes: data.entries.filter((e) => e.kind === "route").length,
      marks: data.entries.reduce((sum, e) => sum + e.marks.length, 0),
      // Entries measured the old way are measured again on first use, which needs terrain downloads.
      measuredDifferently: data.measureVersion !== MEASURE_VERSION,
    },
    here: { entries: here.size, marks: (db.prepare("SELECT COUNT(*) AS n FROM marks").get() as { n: number }).n },
    merge: { added: data.entries.length - shared, updated: shared, kept: here.size - shared },
    replace: { added: data.entries.length, removed: here.size },
  };
}

function writeBackup(db: Database.Database): string {
  fs.mkdirSync(config.backupsDir, { recursive: true });
  const name = `before-import-${new Date().toISOString().replace(/[:.]/g, "-")}.json.gz`;
  fs.writeFileSync(path.join(config.backupsDir, name), buildExport(db));
  const old = fs.readdirSync(config.backupsDir).filter((f) => f.startsWith("before-import-")).sort().reverse().slice(BACKUPS_KEPT);
  for (const file of old) fs.rmSync(path.join(config.backupsDir, file));
  return name;
}

/**
 * Brings a file's contents into this installation. In 'merge' mode entries
 * here that the file also has are updated from it and the rest are kept; in
 * 'replace' mode the library here is emptied first. The state before is
 * always saved as a backup export.
 */
export async function applyImport(db: Database.Database, data: ExportFile, options: { mode: "merge" | "replace"; settings: boolean }) {
  const backup = writeBackup(db);
  const here = options.mode === "merge" ? entriesHere(db) : new Map<string, number>();
  const removed = options.mode === "replace" ? (db.prepare("SELECT id FROM analyses").all() as Array<{ id: number }>).map((r) => r.id) : [];

  const insert = db.prepare(
    `INSERT INTO analyses (name, created_at, length_m, level, max_score, terrain_source, confidence, rating, result, kind, source_url, status)
     VALUES (@name, @createdAt, @lengthM, @level, @maxScore, @terrainSource, @confidence, @rating, @result, @kind, @sourceUrl, @status)`,
  );
  const update = db.prepare(
    `UPDATE analyses SET name = @name, length_m = @lengthM, level = @level, max_score = @maxScore, terrain_source = @terrainSource,
       confidence = @confidence, rating = @rating, result = @result, source_url = @sourceUrl, status = @status
     WHERE id = @id`,
  );
  const insertMark = db.prepare(
    "INSERT INTO marks (analysis_id, kind, start_m, end_m, note, cause, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );

  const written: Array<{ id: number; source: Entry["source"] }> = [];
  let added = 0, updated = 0, marks = 0;
  db.transaction(() => {
    if (options.mode === "replace") {
      db.prepare("DELETE FROM marks").run();
      db.prepare("DELETE FROM analyses").run();
    }
    for (const entry of data.entries) {
      const { source, measurement, marks: entryMarks, ...fields } = entry;
      const values = { ...fields, result: JSON.stringify(measurement) };
      let id = here.get(keyOf(entry));
      if (id === undefined) {
        id = Number(insert.run(values).lastInsertRowid);
        added++;
      } else {
        update.run({ ...values, id });
        db.prepare("DELETE FROM marks WHERE analysis_id = ?").run(id);
        updated++;
      }
      for (const m of entryMarks) insertMark.run(id, m.kind, m.startM, m.endM, m.note, m.cause, m.createdAt);
      marks += entryMarks.length;
      written.push({ id, source });
    }
    if (options.settings) saveSettings(db, data.settings);
  })();

  // Files follow once the database has accepted everything.
  for (const id of removed) {
    fs.rmSync(gpxPath(id), { force: true });
    fs.rmSync(routePath(id), { force: true });
  }
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  for (const { id, source } of written) {
    if (source) fs.writeFileSync(source.type === "gpx" ? gpxPath(id) : routePath(id), source.text);
  }

  invalidateReferences();
  // Brings each entry's cached level in line with the settings now in force,
  // and measures again anything the file's installation measured differently.
  await refreshAll(db);
  return { added, updated, removed: removed.length, marks, settings: options.settings, backup };
}
