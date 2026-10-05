import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { config } from "./config.js";
import { measureGpx, score, type Analysis, type Measurement } from "./exposure/analyze.js";
import { LEVELS, type Level } from "./exposure/score.js";
import { parseGpx } from "./gpx/parse.js";
import { logger } from "./logger.js";
import { loadSettings, type Settings } from "./settings.js";

// Hikes are stored as measurements; scores are worked out on demand from the
// current settings. The level and peak score columns are a cache of that for
// the library list, refreshed whenever settings change.

export const gpxPath = (id: number) => path.join(config.uploadsDir, `${id}.gpx`);

function sameParams(a: object | undefined, b: object): boolean {
  return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

function writeMeasurement(db: Database.Database, id: number, measurement: Measurement, analysis: Analysis) {
  db.prepare(
    `UPDATE analyses SET length_m = ?, level = ?, max_score = ?, terrain_source = ?, confidence = ?, result = ?
     WHERE id = ?`,
  ).run(
    measurement.lengthM,
    analysis.summary.level,
    analysis.summary.maxScore,
    measurement.terrain.source,
    measurement.terrain.confidence,
    JSON.stringify(measurement),
    id,
  );
}

/** Measures a hike again from its stored GPX and saves the result. */
export async function remeasure(db: Database.Database, id: number, settings: Settings): Promise<Measurement> {
  const measurement = await measureGpx(parseGpx(fs.readFileSync(gpxPath(id), "utf-8")), settings.measure);
  writeMeasurement(db, id, measurement, score(measurement, settings.score));
  return measurement;
}

/**
 * The stored measurement for a hike, measured again first if it was taken
 * with other measurement settings (or predates measurements being stored).
 */
export async function loadMeasurement(db: Database.Database, id: number, settings: Settings): Promise<Measurement | null> {
  const row = db.prepare("SELECT result FROM analyses WHERE id = ?").get(id) as { result: string } | undefined;
  if (!row) return null;
  const stored = JSON.parse(row.result) as Measurement;
  if (sameParams(stored.params, settings.measure) || !fs.existsSync(gpxPath(id))) return stored;
  logger.info({ id }, "measuring hike again for changed settings");
  return remeasure(db, id, settings);
}

export async function loadAnalysis(db: Database.Database, id: number, settings = loadSettings(db)): Promise<Analysis | null> {
  const measurement = await loadMeasurement(db, id, settings);
  // A stored result that could not be re-measured into the current format cannot be scored.
  return measurement?.params ? score(measurement, settings.score) : null;
}

/** Brings every hike's cached level and peak score in line with the current settings. */
export async function refreshAll(db: Database.Database, settings = loadSettings(db)) {
  const ids = (db.prepare("SELECT id FROM analyses").all() as Array<{ id: number }>).map((row) => row.id);
  for (const id of ids) {
    try {
      const analysis = await loadAnalysis(db, id, settings);
      if (!analysis) continue;
      db.prepare("UPDATE analyses SET level = ?, max_score = ? WHERE id = ?").run(
        analysis.summary.level,
        analysis.summary.maxScore,
        id,
      );
    } catch (err) {
      logger.error({ id, err }, "could not refresh hike");
    }
  }
}

export interface Disagreement {
  analysisId: number;
  name: string;
  kind: string;
  startM: number;
  endM: number;
  /** Worst level the model gives anywhere in the marked stretch. */
  level: Level;
}

/**
 * How well the current settings agree with the user's own marks: stretches
 * marked fine that the model rates exposed or severe, and stretches marked
 * uneasy or bad that the model leaves green.
 */
export async function fitAgainstMarks(db: Database.Database, settings = loadSettings(db)) {
  const marks = db
    .prepare(
      `SELECT m.analysis_id AS analysisId, a.name, m.kind, m.start_m AS startM, m.end_m AS endM
       FROM marks m JOIN analyses a ON a.id = m.analysis_id
       WHERE m.kind != 'turned_back' ORDER BY m.analysis_id, m.start_m`,
    )
    .all() as Array<Omit<Disagreement, "level">>;

  const analyses = new Map<number, Analysis | null>();
  const overFlagged: Disagreement[] = [];
  const missed: Disagreement[] = [];
  for (const mark of marks) {
    if (!analyses.has(mark.analysisId)) analyses.set(mark.analysisId, await loadAnalysis(db, mark.analysisId, settings));
    const analysis = analyses.get(mark.analysisId);
    if (!analysis) continue;
    const level = analysis.sections
      .filter((s) => s.startM <= mark.endM && s.endM >= mark.startM)
      .reduce<Level>((worst, s) => (LEVELS.indexOf(s.level) > LEVELS.indexOf(worst) ? s.level : worst), "green");
    if (mark.kind === "fine" && LEVELS.indexOf(level) >= LEVELS.indexOf("orange")) overFlagged.push({ ...mark, level });
    if (mark.kind !== "fine" && level === "green") missed.push({ ...mark, level });
  }
  return { marks: marks.length, overFlagged, missed };
}
