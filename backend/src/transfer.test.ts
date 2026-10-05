import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// The data directory is read once when the config module loads, so it has to
// point at a scratch folder before anything else is imported.
const dataDir = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const dir = mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "how-high-transfer-"));
  process.env.DATA_DIR = dir;
  process.env.LOG_LEVEL = "silent";
  return dir as string;
});

const { openDatabase } = await import("./db/client.js");
const { measure } = await import("./exposure/analyze.js");
const { resample } = await import("./gpx/resample.js");
const { gpxPath, routePath } = await import("./hikes.js");
const { DEFAULT_SETTINGS, loadSettings, saveSettings } = await import("./settings.js");
const { applyImport, buildExport, previewImport, readExport } = await import("./transfer.js");

const identity = { name: "test", forward: (x: number, y: number): [number, number] => [x, y], inverse: (x: number, y: number): [number, number] => [x, y] };
/** A real, scoreable measurement of a short traverse of a slope of the given steepness. */
const measurementOf = (deg: number) =>
  JSON.stringify(
    measure({ source: "synthetic", cellSize: 2, elevation: (x) => 1000 - x * Math.tan((deg * Math.PI) / 180) }, resample([[0, -100], [0, 100]], 5), identity),
  );

let counter = 0;
/** A fresh, empty installation: its own database, and an emptied uploads folder. */
function installation(): Database.Database {
  fs.rmSync(path.join(dataDir, "uploads"), { recursive: true, force: true });
  fs.mkdirSync(path.join(dataDir, "uploads"), { recursive: true });
  return openDatabase(path.join(dataDir, `test-${counter++}.db`));
}

function addEntry(db: Database.Database, name: string, options: { kind?: "hike" | "route"; source?: string; rating?: string; status?: string; deg?: number } = {}) {
  const kind = options.kind ?? "hike";
  const id = Number(
    db
      .prepare(
        `INSERT INTO analyses (name, created_at, length_m, level, max_score, terrain_source, confidence, rating, result, kind, source_url, status)
         VALUES (?, '2026-01-01T00:00:00.000Z', 200, 'green', 0, 'synthetic', 'high', ?, ?, ?, NULL, ?)`,
      )
      .run(name, options.rating ?? null, measurementOf(options.deg ?? 10), kind, options.status ?? "planned").lastInsertRowid,
  );
  fs.writeFileSync(kind === "hike" ? gpxPath(id) : routePath(id), options.source ?? `<gpx><!-- ${name} --></gpx>`);
  return id;
}

const addMark = (db: Database.Database, id: number, kind: string, cause: string | null = null) =>
  db.prepare("INSERT INTO marks (analysis_id, kind, start_m, end_m, note, cause, created_at) VALUES (?, ?, 20, 80, 'a note', ?, '2026-01-02T00:00:00.000Z')").run(id, kind, cause);

const names = (db: Database.Database) => (db.prepare("SELECT name FROM analyses ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
const marksOf = (db: Database.Database, name: string) =>
  db.prepare("SELECT m.kind, m.cause, m.note, m.start_m FROM marks m JOIN analyses a ON a.id = m.analysis_id WHERE a.name = ? ORDER BY m.kind").all(name);

/** A source installation with two hikes and a route, marks, ratings and changed settings; returns its export. */
function exported(): Buffer {
  const db = installation();
  const steep = addEntry(db, "Steep hike", { deg: 45, rating: "bad", status: "done" });
  addMark(db, steep, "bad", "drops");
  addMark(db, steep, "fine");
  addEntry(db, "Gentle hike");
  const ride = addEntry(db, "Train ride", { kind: "route", source: '{"legs":[]}' });
  addMark(db, ride, "uneasy", "view");
  saveSettings(db, { ...DEFAULT_SETTINGS, score: { ...DEFAULT_SETTINGS.score, forestFactor: 0.4 } });
  const buffer = buildExport(db);
  db.close();
  return buffer;
}

let file: Buffer;
beforeEach(() => {
  file = exported();
  fs.rmSync(path.join(dataDir, "backups"), { recursive: true, force: true });
});
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

describe("export and import", () => {
  it("reproduces a library in an empty installation", async () => {
    const db = installation();
    const summary = await applyImport(db, readExport(file), { mode: "merge", settings: true });
    expect(summary).toMatchObject({ added: 3, updated: 0, removed: 0, marks: 3, settings: true });
    expect(names(db)).toEqual(["Gentle hike", "Steep hike", "Train ride"]);

    const steep = db.prepare("SELECT * FROM analyses WHERE name = 'Steep hike'").get() as Record<string, unknown>;
    expect(steep).toMatchObject({ rating: "bad", status: "done", kind: "hike" });
    // The level cache is brought in line with the measurement on import.
    expect(steep.level).toBe("red");
    expect(marksOf(db, "Steep hike")).toEqual([
      { kind: "bad", cause: "drops", note: "a note", start_m: 20 },
      { kind: "fine", cause: null, note: "a note", start_m: 20 },
    ]);
    expect(marksOf(db, "Train ride")).toEqual([{ kind: "uneasy", cause: "view", note: "a note", start_m: 20 }]);
    expect(loadSettings(db).score.forestFactor).toBe(0.4);

    // Sources are written under the new ids, so entries can be measured again later.
    expect(fs.readFileSync(gpxPath(steep.id as number), "utf-8")).toContain("Steep hike");
    const ride = db.prepare("SELECT id FROM analyses WHERE name = 'Train ride'").get() as { id: number };
    expect(fs.readFileSync(routePath(ride.id), "utf-8")).toBe('{"legs":[]}');
  });

  it("can leave the settings here as they are", async () => {
    const db = installation();
    await applyImport(db, readExport(file), { mode: "merge", settings: false });
    expect(loadSettings(db).score.forestFactor).toBe(DEFAULT_SETTINGS.score.forestFactor);
  });

  it("in merge mode updates what both sides have and keeps what is only here", async () => {
    const db = installation();
    // The same hike as in the file (same GPX), under an older name and with a mark of its own.
    const same = addEntry(db, "Old name", { source: "<gpx><!-- Steep hike --></gpx>", rating: "fine" });
    addMark(db, same, "uneasy");
    addEntry(db, "Only here");

    expect(previewImport(db, readExport(file))).toMatchObject({
      file: { hikes: 2, routes: 1, marks: 3, measuredDifferently: false },
      here: { entries: 2, marks: 1 },
      merge: { added: 2, updated: 1, kept: 1 },
      replace: { added: 3, removed: 2 },
    });
    // Looking changes nothing.
    expect(names(db)).toEqual(["Old name", "Only here"]);

    const summary = await applyImport(db, readExport(file), { mode: "merge", settings: true });
    expect(summary).toMatchObject({ added: 2, updated: 1, removed: 0 });
    expect(names(db)).toEqual(["Gentle hike", "Only here", "Steep hike", "Train ride"]);
    // The file's version of the shared hike wins, marks included, under the id it already had here.
    expect((db.prepare("SELECT id, rating FROM analyses WHERE name = 'Steep hike'").get() as { id: number; rating: string })).toEqual({ id: same, rating: "bad" });
    expect(marksOf(db, "Steep hike").map((m) => (m as { kind: string }).kind)).toEqual(["bad", "fine"]);
  });

  it("in replace mode leaves only what the file has", async () => {
    const db = installation();
    const gone = addEntry(db, "Only here");
    addMark(db, gone, "bad");
    const summary = await applyImport(db, readExport(file), { mode: "replace", settings: true });
    expect(summary).toMatchObject({ added: 3, updated: 0, removed: 1 });
    expect(names(db)).toEqual(["Gentle hike", "Steep hike", "Train ride"]);
    expect(fs.existsSync(gpxPath(gone))).toBe(false);
    expect((db.prepare("SELECT COUNT(*) AS n FROM marks").get() as { n: number }).n).toBe(3);
  });

  it("saves what was here before changing anything", async () => {
    const db = installation();
    addEntry(db, "Only here");
    const { backup } = await applyImport(db, readExport(file), { mode: "replace", settings: true });
    const saved = readExport(fs.readFileSync(path.join(dataDir, "backups", backup)));
    expect(saved.entries.map((e) => e.name)).toEqual(["Only here"]);
  });

  it("round-trips: exporting what was imported gives the same file again", async () => {
    const first = installation();
    await applyImport(first, readExport(file), { mode: "replace", settings: true });
    // Importing refreshes each entry's cached level, so the comparison starts from this export.
    const once = buildExport(first);
    const second = installation();
    await applyImport(second, readExport(once), { mode: "replace", settings: true });
    const strip = (data: ReturnType<typeof readExport>) => ({ ...data, exportedAt: "" });
    expect(strip(readExport(buildExport(second)))).toEqual(strip(readExport(once)));
  });

  it("refuses files that are not exports", () => {
    expect(() => readExport(Buffer.from("not json at all"))).toThrow(/not a How High export/);
    expect(() => readExport(Buffer.from(JSON.stringify({ hello: "world" })))).toThrow(/not a How High export/);
    expect(() => readExport(Buffer.from(JSON.stringify({ format: "how-high-export", version: 99 })))).toThrow(/different version/);
  });
});
