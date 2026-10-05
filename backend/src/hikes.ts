import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { config } from "./config.js";
import { MEASURE_VERSION, score, type Analysis, type Measurement, type Section } from "./exposure/analyze.js";
import { gpxSource, measureSource, type RouteSource } from "./exposure/pipeline.js";
import { mostSimilar, profileOf, type MarkKind, type Reference } from "./exposure/compare.js";
import { LEVELS, type Level } from "./exposure/score.js";
import { parseGpx } from "./gpx/parse.js";
import { logger } from "./logger.js";
import { loadSettings, type Settings } from "./settings.js";

// Hikes are stored as measurements; scores are worked out on demand from the
// current settings. The level and peak score columns are a cache of that for
// the library list, refreshed whenever settings change.

// What a hike or route was made from is kept so it can be measured again: the
// uploaded GPX for hikes, the fetched route as JSON for links.
export const gpxPath = (id: number) => path.join(config.uploadsDir, `${id}.gpx`);
export const routePath = (id: number) => path.join(config.uploadsDir, `${id}.json`);

export const hasSource = (id: number) => fs.existsSync(gpxPath(id)) || fs.existsSync(routePath(id));

function loadSource(id: number): RouteSource {
  if (fs.existsSync(routePath(id))) return JSON.parse(fs.readFileSync(routePath(id), "utf-8")) as RouteSource;
  return gpxSource(parseGpx(fs.readFileSync(gpxPath(id), "utf-8")));
}

/** Scores a measurement with the settings that belong to its profile. */
export function scoreWith(measurement: Measurement, settings: Settings): Analysis {
  return measurement.profile === "road"
    ? score(measurement, settings.road, { walkParams: settings.score, noGo: settings.noGo })
    : score(measurement, settings.score, { noGo: settings.noGo });
}

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
  const measurement = await measureSource(loadSource(id), settings.measure);
  writeMeasurement(db, id, measurement, scoreWith(measurement, settings));
  invalidateReferences();
  return measurement;
}

// Minutes to wait before each further attempt to fetch map context for a hike
// that was measured without it.
const CONTEXT_RETRY_MIN = [1, 5, 15, 60, 180];
const awaitingContext = new Set<number>();

/**
 * Keeps trying in the background to get map context for a hike measured
 * without it, so a slow or failing OpenStreetMap server never holds up an
 * upload. Gives up after the last delay; opening Re-analyse still works.
 */
export function retryContextLater(db: Database.Database, id: number, attempt = 0) {
  if (attempt === 0 && awaitingContext.has(id)) return;
  if (attempt >= CONTEXT_RETRY_MIN.length) {
    awaitingContext.delete(id);
    return;
  }
  awaitingContext.add(id);
  setTimeout(
    async () => {
      const exists = db.prepare("SELECT 1 FROM analyses WHERE id = ?").get(id) !== undefined;
      if (!exists || !hasSource(id)) {
        awaitingContext.delete(id);
        return;
      }
      try {
        if ((await remeasure(db, id, loadSettings(db))).mapContext) {
          logger.info({ id }, "map context added on retry");
          awaitingContext.delete(id);
          return;
        }
      } catch (err) {
        logger.error({ id, err }, "retry for map context failed");
      }
      retryContextLater(db, id, attempt + 1);
    },
    CONTEXT_RETRY_MIN[attempt] * 60_000,
  ).unref();
}

/**
 * The stored measurement for a hike, measured again first if it was taken
 * with other measurement settings (or predates measurements being stored).
 */
export async function loadMeasurement(db: Database.Database, id: number, settings: Settings): Promise<Measurement | null> {
  const row = db.prepare("SELECT result FROM analyses WHERE id = ?").get(id) as { result: string } | undefined;
  if (!row) return null;
  const stored = JSON.parse(row.result) as Measurement;
  const current = sameParams(stored.params, settings.measure) && stored.version === MEASURE_VERSION;
  if (current || !hasSource(id)) return stored;
  logger.info({ id }, "measuring again: settings or the way of measuring changed");
  return remeasure(db, id, settings);
}

export async function loadAnalysis(db: Database.Database, id: number, settings = loadSettings(db)): Promise<Analysis | null> {
  const measurement = await loadMeasurement(db, id, settings);
  // A stored result that could not be re-measured into the current format cannot be scored.
  return measurement?.params ? scoreWith(measurement, settings) : null;
}

/** Brings every hike's cached level and peak score in line with the current settings. */
export async function refreshAll(db: Database.Database, settings = loadSettings(db)) {
  invalidateReferences();
  const ids = (db.prepare("SELECT id FROM analyses").all() as Array<{ id: number }>).map((row) => row.id);
  for (const id of ids) {
    try {
      const analysis = await loadAnalysis(db, id, settings);
      if (!analysis) continue;
      if (!analysis.mapContext) retryContextLater(db, id);
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

// Every marked stretch with what the model measures there under the current
// settings. Rebuilt lazily after anything that could change it.
let references: Reference[] | null = null;

export function invalidateReferences() {
  references = null;
}

/** After turning back, the stretch this far ahead is taken as what prompted it. */
const TURNED_BACK_LOOKAHEAD_M = 300;

interface MarkRow {
  analysisId: number;
  name: string;
  kind: MarkKind;
  startM: number;
  endM: number;
}

async function loadReferences(db: Database.Database, settings: Settings): Promise<Reference[]> {
  if (references) return references;
  const marks = db
    .prepare(
      `SELECT m.analysis_id AS analysisId, a.name, m.kind, m.start_m AS startM, m.end_m AS endM
       FROM marks m JOIN analyses a ON a.id = m.analysis_id ORDER BY m.analysis_id, m.start_m`,
    )
    .all() as MarkRow[];
  const analyses = new Map<number, Analysis | null>();
  const built: Reference[] = [];
  for (const mark of marks) {
    if (!analyses.has(mark.analysisId)) analyses.set(mark.analysisId, await loadAnalysis(db, mark.analysisId, settings));
    const analysis = analyses.get(mark.analysisId);
    if (!analysis) continue;
    const endM = mark.kind === "turned_back" ? mark.startM + TURNED_BACK_LOOKAHEAD_M : mark.endM;
    const profile = profileOf(analysis, mark.startM, endM);
    if (profile) built.push({ ...mark, endM, profile });
  }
  references = built;
  return built;
}

const SEVERITY: MarkKind[] = ["fine", "uneasy", "bad", "turned_back"];

export type AnnotatedSection = Section & {
  /** The user's own verdict on this stretch, if they marked it (the most severe one). */
  yourMark: MarkKind | null;
  /** A stretch marked on another hike, or elsewhere on this one, that measures much the same. */
  similar: ReferenceLink | null;
  /**
   * Set when nothing similar is marked but this stretch scores above the
   * hardest stretch the user found uneasy, bad or turned back at.
   */
  harderThan: ReferenceLink | null;
};

type ReferenceLink = Pick<Reference, "analysisId" | "name" | "kind" | "startM" | "endM">;

const link = ({ analysisId, name, kind, startM, endM }: Reference): ReferenceLink => ({ analysisId, name, kind, startM, endM });

/** Adds to each flagged section what the user's marks say about it or about stretches like it. */
export async function annotateSections(
  db: Database.Database,
  id: number,
  analysis: Analysis,
  settings: Settings,
): Promise<AnnotatedSection[]> {
  const all = await loadReferences(db, settings);
  return analysis.sections.map((section) => {
    const overlaps = (r: Reference) => r.analysisId === id && r.startM <= section.endM && r.endM >= section.startM;
    const own = all.filter(overlaps);
    const yourMark = own.reduce<MarkKind | null>(
      (worst, r) => (worst === null || SEVERITY.indexOf(r.kind) > SEVERITY.indexOf(worst) ? r.kind : worst),
      null,
    );
    const profile = profileOf(analysis, section.startM, section.endM);
    const others = all.filter((r) => !overlaps(r));
    const match = profile ? mostSimilar(profile, others, settings.score) : null;
    const hardest = others
      .filter((r) => r.kind !== "fine")
      .reduce<Reference | null>((top, r) => (top === null || r.profile.score > top.profile.score ? r : top), null);
    const harder = !match && profile && hardest && profile.score > hardest.profile.score ? hardest : null;
    return { ...section, yourMark, similar: match && link(match), harderThan: harder && link(harder) };
  });
}
