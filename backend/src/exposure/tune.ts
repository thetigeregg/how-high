import type { Measurement } from "./analyze.js";
import type { MarkKind } from "./compare.js";
import type { ScoreParams } from "./score.js";

// Fitting the scoring settings to the user's own marks: each mark says what a
// stretch should have scored, and the settings are nudged until the scores
// agree, changing as little as possible.

/** A stretch the user has judged, cut out of its route's measurements. */
export interface MarkedStretch {
  kind: MarkKind;
  /** What the user put it down to, if they said: decides which score the mark is held against. */
  cause: Cause;
  measurement: Measurement;
}

/** 'drops' or 'view' when the user named one; null when they named both or did not say. */
export type Cause = "drops" | "view" | null;

type RangeKey = "fallHeightM" | "drop10M" | "drop30M" | "drop100M" | "crossSlopeDeg" | "viewDepthM";
type FactorKey = "forestFactor" | "viewForestFactor";
/** The settings tuning may change. Level boundaries are left alone so that a level keeps its meaning. */
export const TUNABLE_RANGES: RangeKey[] = ["fallHeightM", "drop10M", "drop30M", "drop100M", "crossSlopeDeg", "viewDepthM"];
export const TUNABLE_FACTORS: FactorKey[] = ["forestFactor", "viewForestFactor"];

/** Each setting may move at most this far from where it stands, per run. */
const MULTIPLIERS = [0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4];
/** A mark is satisfied once the score clears the level boundary by this much. */
const MARGIN = 5;
/**
 * What moving a setting costs, in the same units as a missed mark (score
 * points squared). Small against a real disagreement, so marks win, but
 * enough that of two fits the one nearer the present settings is taken.
 */
const CHANGE_COST = 60;
const PASSES = 3;

/** How far a stretch's peak score is from what its mark says it should be, squared. */
export function misfit(kind: MarkKind, peak: number, [mild, exposed, severe]: [number, number, number]): number {
  const short = (target: number) => Math.max(0, target - peak) ** 2;
  const over = (target: number) => Math.max(0, peak - target) ** 2;
  if (kind === "fine") return over(exposed - MARGIN);
  if (kind === "uneasy") return short(mild + MARGIN) + over(severe - MARGIN);
  return short(exposed + MARGIN);
}

function scaled(base: ScoreParams, multipliers: Record<string, number>): ScoreParams {
  const params = { ...base };
  for (const key of TUNABLE_RANGES) {
    const m = multipliers[key];
    const low = Math.round(base[key][0] * m);
    params[key] = [low, Math.max(low + 1, Math.round(base[key][1] * m))];
  }
  for (const key of TUNABLE_FACTORS) {
    params[key] = Math.min(1, Math.max(0, Math.round((base[key] * multipliers[key]) / 0.05) * 0.05));
    params[key] = Number(params[key].toFixed(2));
  }
  return params;
}

/**
 * Finds settings under which the marked stretches score as marked, moving
 * one setting at a time to whichever of a few steps fits best and repeating
 * until nothing improves. `peakOf` scores a stretch under given settings:
 * the drop score or the view score alone where the mark names that as the
 * cause, else the overall score.
 * Returns the present settings unchanged when nothing fits better.
 */
export function tune(
  stretches: MarkedStretch[],
  current: ScoreParams,
  peakOf: (measurement: Measurement, params: ScoreParams, cause: Cause) => number,
): { params: ScoreParams; misfitBefore: number; misfitAfter: number } {
  const total = (params: ScoreParams) =>
    stretches.reduce((sum, s) => sum + misfit(s.kind, peakOf(s.measurement, params, s.cause), params.thresholds), 0);
  const cost = (multipliers: Record<string, number>) =>
    CHANGE_COST * Object.values(multipliers).reduce((sum, m) => sum + Math.log(m) ** 2, 0);

  const keys = [...TUNABLE_RANGES, ...TUNABLE_FACTORS];
  const multipliers: Record<string, number> = Object.fromEntries(keys.map((key) => [key, 1]));
  const misfitBefore = total(current);
  let best = misfitBefore;
  if (best > 0) {
    for (let pass = 0; pass < PASSES; pass++) {
      let improved = false;
      for (const key of keys) {
        for (const m of MULTIPLIERS) {
          const trial = { ...multipliers, [key]: m };
          const value = total(scaled(current, trial)) + cost(trial);
          if (value < best - 1e-9) {
            best = value;
            multipliers[key] = m;
            improved = true;
          }
        }
      }
      if (!improved) break;
    }
  }
  const params = scaled(current, multipliers);
  const misfitAfter = total(params);
  // Rounding can undo a marginal gain; then the present settings stand.
  return misfitAfter < misfitBefore ? { params, misfitBefore, misfitAfter } : { params: current, misfitBefore, misfitAfter: misfitBefore };
}

/** Cuts the stretch between two distances out of a route's measurements, keeping what scoring needs. */
export function stretchOf(measurement: Measurement, startM: number, endM: number): Measurement | null {
  let view = null;
  const points = [];
  for (const p of measurement.points) {
    if (p.dist > endM) break;
    // Views are measured every so often; carry the latest one into the stretch.
    if (p.view !== undefined && p.dist <= startM) view = p.view;
    if (p.dist >= startM) points.push(points.length === 0 && p.view === undefined ? { ...p, view } : p);
  }
  return points.length > 0 ? { ...measurement, points } : null;
}
