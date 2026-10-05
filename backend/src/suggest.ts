import type Database from "better-sqlite3";
import { score, type Analysis, type Measurement, type Profile } from "./exposure/analyze.js";
import { profileOf, verdictFor, type MarkKind, type Reference, type Verdict } from "./exposure/compare.js";
import { LEVELS, type Level, type ScoreParams } from "./exposure/score.js";
import { stretchOf, tune, TUNABLE_FACTORS, TUNABLE_RANGES } from "./exposure/tune.js";
import { scoreWith, type Disagreement } from "./hikes.js";
import { loadSettings, type Settings } from "./settings.js";

/** After turning back, the stretch this far ahead is taken as what prompted it. */
const TURNED_BACK_LOOKAHEAD_M = 300;

interface Entry {
  id: number;
  name: string;
  kind: string;
  status: string;
  measurement: Measurement;
}

interface Mark {
  analysisId: number;
  kind: MarkKind;
  startM: number;
  endM: number;
}

interface EntryState {
  level: Level;
  maxScore: number;
  /** Forecast tone, for entries still planned. */
  forecast: Verdict["tone"] | null;
}

export interface Proposal {
  profile: Profile;
  /**
   * 'none': no marked stretches of this kind to tune against;
   * 'fits': the present settings already agree with the marks;
   * 'changes': see `changes`.
   */
  outcome: "none" | "fits" | "changes";
  /** How many marked stretches the proposal rests on. */
  marks: number;
  changes: Array<{ key: string; current: number | [number, number]; proposed: number | [number, number] }>;
  /** The complete settings as they would be saved. */
  settings: Settings;
  /** Disagreements with marks under the present and the proposed settings. */
  before: { overFlagged: Disagreement[]; missed: Disagreement[] };
  after: { overFlagged: Disagreement[]; missed: Disagreement[] };
  /** Entries whose rating or forecast would change. */
  library: Array<{ id: number; name: string; kind: string; before: EntryState; after: EntryState }>;
}

const paramsKey = (profile: Profile) => (profile === "hike" ? "score" : "road") as "score" | "road";

function stateUnder(entries: Entry[], marks: Mark[], settings: Settings) {
  const analyses = new Map<number, Analysis>(entries.map((e) => [e.id, scoreWith(e.measurement, settings)]));
  const names = new Map(entries.map((e) => [e.id, e.name]));

  const references: Reference[] = [];
  const overFlagged: Disagreement[] = [];
  const missed: Disagreement[] = [];
  for (const mark of marks) {
    const analysis = analyses.get(mark.analysisId);
    if (!analysis) continue;
    const name = names.get(mark.analysisId) ?? "";
    const endM = mark.kind === "turned_back" ? mark.startM + TURNED_BACK_LOOKAHEAD_M : mark.endM;
    const profile = profileOf(analysis, mark.startM, endM);
    if (profile) references.push({ ...mark, name, endM, profile, routeProfile: analysis.profile });
    if (mark.kind === "turned_back") continue;
    const level = analysis.sections
      .filter((s) => s.startM <= mark.endM && s.endM >= mark.startM)
      .reduce<Level>((worst, s) => (LEVELS.indexOf(s.level) > LEVELS.indexOf(worst) ? s.level : worst), "green");
    const disagreement = { ...mark, name, level };
    if (mark.kind === "fine" && LEVELS.indexOf(level) >= LEVELS.indexOf("orange")) overFlagged.push(disagreement);
    if (mark.kind !== "fine" && level === "green") missed.push(disagreement);
  }

  const states = new Map<number, EntryState>();
  for (const entry of entries) {
    const analysis = analyses.get(entry.id)!;
    const verdict = entry.status === "planned" ? verdictFor(analysis, references.filter((r) => r.analysisId !== entry.id)) : null;
    states.set(entry.id, { level: analysis.summary.level, maxScore: analysis.summary.maxScore, forecast: verdict?.tone ?? null });
  }
  return { states, overFlagged, missed };
}

/**
 * Works out settings that fit the user's marks better, for hikes or for
 * rides, and what applying them would change. Nothing is saved.
 */
export function suggest(db: Database.Database, profile: Profile): Proposal {
  const settings = loadSettings(db);
  const entries = (
    db.prepare("SELECT id, name, kind, status, result FROM analyses ORDER BY id").all() as Array<Omit<Entry, "measurement"> & { result: string }>
  )
    .map(({ result, ...row }) => ({ ...row, measurement: JSON.parse(result) as Measurement }))
    // Entries stored in an older form have no measurements to re-score.
    .filter((entry) => entry.measurement.params !== undefined);
  const marks = db
    .prepare("SELECT analysis_id AS analysisId, kind, start_m AS startM, end_m AS endM FROM marks ORDER BY analysis_id, start_m")
    .all() as Mark[];

  const byId = new Map(entries.map((e) => [e.id, e]));
  const stretches = marks.flatMap((mark) => {
    const measurement = byId.get(mark.analysisId)?.measurement;
    if (!measurement || (measurement.profile ?? "hike") !== profile) return [];
    const endM = mark.kind === "turned_back" ? mark.startM + TURNED_BACK_LOOKAHEAD_M : mark.endM;
    const stretch = stretchOf(measurement, mark.startM, endM);
    return stretch ? [{ kind: mark.kind, measurement: stretch }] : [];
  });

  const key = paramsKey(profile);
  const peakOf = (measurement: Measurement, params: ScoreParams) => {
    const scored =
      profile === "road"
        ? score(measurement, params, { walkParams: settings.score, noGo: settings.noGo })
        : score(measurement, params, { noGo: settings.noGo });
    return Math.max(0, ...scored.points.map((p) => p.score ?? 0));
  };
  const tuned = stretches.length > 0 ? tune(stretches, settings[key], peakOf).params : settings[key];
  const proposed: Settings = { ...settings, [key]: tuned };

  const changes = [...TUNABLE_RANGES, ...TUNABLE_FACTORS]
    .filter((k) => JSON.stringify(settings[key][k]) !== JSON.stringify(tuned[k]))
    .map((k) => ({ key: k as string, current: settings[key][k], proposed: tuned[k] }));

  const before = stateUnder(entries, marks, settings);
  const after = changes.length > 0 ? stateUnder(entries, marks, proposed) : before;
  const library = entries.flatMap((entry) => {
    const a = before.states.get(entry.id)!;
    const b = after.states.get(entry.id)!;
    const same = a.level === b.level && a.forecast === b.forecast && Math.abs(a.maxScore - b.maxScore) < 1;
    return same ? [] : [{ id: entry.id, name: entry.name, kind: entry.kind, before: a, after: b }];
  });

  return {
    profile,
    outcome: stretches.length === 0 ? "none" : changes.length === 0 ? "fits" : "changes",
    marks: stretches.length,
    changes,
    settings: proposed,
    before: { overFlagged: before.overFlagged, missed: before.missed },
    after: { overFlagged: after.overFlagged, missed: after.missed },
    library,
  };
}
