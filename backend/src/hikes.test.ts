import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The data directory is read once when the config module loads, so it has to
// point at a scratch folder before anything else is imported.
vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  process.env.DATA_DIR = mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "how-high-hikes-"));
  process.env.LOG_LEVEL = "silent";
});

const { config } = await import("./config.js");
const { openDatabase } = await import("./db/client.js");
const { MEASURE_VERSION, measure } = await import("./exposure/analyze.js");
const { resample } = await import("./gpx/resample.js");
const { gpxPath, loadMeasurement } = await import("./hikes.js");
const { dismiss, idle, listJobs, reset } = await import("./jobs.js");
const { DEFAULT_SETTINGS } = await import("./settings.js");

const identity = { name: "test", forward: (x: number, y: number): [number, number] => [x, y], inverse: (x: number, y: number): [number, number] => [x, y] };

let counter = 0;
/** An entry measured by an older version, with the given file as what it was made from. */
function staleEntry(source: string) {
  const db = openDatabase(path.join(config.dataDir, `test-${counter++}.db`));
  const measurement = {
    ...measure({ source: "synthetic", cellSize: 2, elevation: (x) => 1000 - x }, resample([[0, -100], [0, 100]], 5), identity),
    version: MEASURE_VERSION - 1,
  };
  const id = Number(
    db
      .prepare(
        `INSERT INTO analyses (name, created_at, length_m, level, max_score, terrain_source, confidence, result, kind)
         VALUES ('Old hike', '2026-01-01T00:00:00.000Z', 200, 'green', 0, 'synthetic', 'high', ?, 'hike')`,
      )
      .run(JSON.stringify(measurement)).lastInsertRowid,
  );
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  fs.writeFileSync(gpxPath(id), source);
  return { db, id };
}

beforeEach(() => reset());

describe("measuring again after the way of measuring changed", () => {
  it("answers with the stored measurement at once and queues one job for it", async () => {
    const { db, id } = staleEntry("<gpx></gpx>");
    const first = await loadMeasurement(db, id, DEFAULT_SETTINGS);
    await loadMeasurement(db, id, DEFAULT_SETTINGS);
    expect(first?.version).toBe(MEASURE_VERSION - 1);
    const jobs = listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ reanalysisOf: id, label: "Old hike", kind: "hike", state: "queued" });
    // Dropped before it starts, so nothing is measured.
    dismiss(jobs[0].id);
  });

  it("does not start a failed one over on every load", async () => {
    const { db, id } = staleEntry("not a gpx file");
    await loadMeasurement(db, id, DEFAULT_SETTINGS);
    await idle();
    expect(listJobs()[0]).toMatchObject({ reanalysisOf: id, state: "failed" });
    await loadMeasurement(db, id, DEFAULT_SETTINGS);
    expect(listJobs()).toHaveLength(1);
  });
});
