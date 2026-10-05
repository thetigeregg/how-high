import type { PointMetrics } from "./metrics.js";

export type Level = "green" | "yellow" | "orange" | "red";
export const LEVELS: Level[] = ["green", "yellow", "orange", "red"];

/**
 * Everything personal about the score. Each [low, high] pair is the range a
 * measurement is ramped over: at or below `low` it contributes nothing, at or
 * above `high` it is maxed out. These are starting guesses, meant to be tuned
 * against hikes with a known outcome.
 */
export interface ScoreParams {
  fallHeightM: [number, number];
  drop10M: [number, number];
  drop30M: [number, number];
  drop100M: [number, number];
  crossSlopeDeg: [number, number];
  trackGradeDeg: [number, number];
  bridgeGapM: [number, number];
  /** Drop within 30 m needed on *both* sides to count as a ridge. */
  ridgeDropM: number;
  ridgeFactor: number;
  /** Score at which yellow, orange and red start. */
  thresholds: [number, number, number];
  /** Multiplier where the ground below the path is wooded. */
  forestFactor: number;
  /** Multiplier on vehicle-width tracks and roads. */
  wideTrackFactor: number;
  /** Share of the score that comes from drops; the rest comes from side slope. */
  dropWeight: number;
  /** Flagged stretches closer together than this are reported as one, metres. */
  mergeGapM: number;
  /** Isolated blips shorter than this are dropped unless they reach the top level, metres. */
  minLengthM: number;
}

export const DEFAULT_PARAMS: ScoreParams = {
  fallHeightM: [3, 50],
  drop10M: [4, 16],
  drop30M: [8, 35],
  drop100M: [30, 80],
  crossSlopeDeg: [25, 45],
  trackGradeDeg: [20, 35],
  bridgeGapM: [4, 20],
  ridgeDropM: 8,
  ridgeFactor: 1.2,
  thresholds: [25, 50, 75],
  forestFactor: 0.6,
  wideTrackFactor: 0.85,
  dropWeight: 0.75,
  mergeGapM: 30,
  minLengthM: 10,
};

function ramp(value: number, [low, high]: [number, number]): number {
  return Math.min(1, Math.max(0, (value - low) / (high - low)));
}

/** What the map adds to the terrain at one point. */
export interface PointContext {
  /** The ground on the exposed side(s) of the path is wooded. */
  forest: boolean;
  /** Whether a mapped path was found here; the fields below are only meaningful if so. */
  matched: boolean;
  tunnel: boolean;
  bridge: boolean;
  wide: boolean;
  sacGrade: number | null;
  aided: boolean;
  cliff: boolean;
}

/** Applies map context to a terrain-only score. Without context the score is unchanged. */
export function adjustScore(raw: number, context: PointContext | null, params: ScoreParams = DEFAULT_PARAMS): number {
  if (!context) return raw;
  if (context.tunnel) return 0;
  let score = raw;
  if (context.forest) score *= params.forestFactor;
  if (context.wide) score *= params.wideTrackFactor;
  return score;
}

/** Exposure of a single point from terrain alone, 0 (none) to 100. */
export function scorePoint(m: PointMetrics, params: ScoreParams = DEFAULT_PARAMS): number {
  const fall = ramp(Math.max(m.fallLeft, m.fallRight), params.fallHeightM);
  const drop = Math.max(
    ramp(m.drop10, params.drop10M),
    ramp(m.drop30, params.drop30M),
    ramp(m.drop100, params.drop100M),
  );
  let score =
    100 * (params.dropWeight * Math.max(fall, drop) + (1 - params.dropWeight) * ramp(m.crossSlopeDeg, params.crossSlopeDeg));
  if (Math.min(m.dropLeft30, m.dropRight30) >= params.ridgeDropM) score *= params.ridgeFactor;
  score += 10 * ramp(Math.abs(m.trackGradeDeg), params.trackGradeDeg);
  score = Math.max(score, 100 * ramp(m.bridgeGap, params.bridgeGapM));
  return Math.min(100, score);
}

export function levelOf(score: number, params: ScoreParams = DEFAULT_PARAMS): Level {
  const [yellow, orange, red] = params.thresholds;
  if (score >= red) return "red";
  if (score >= orange) return "orange";
  if (score >= yellow) return "yellow";
  return "green";
}

/** A contiguous run of flagged points, as index range [start, end] inclusive. */
export interface Run {
  start: number;
  end: number;
  /** Peak of the smoothed score inside the run. */
  peak: number;
}

/**
 * Groups per-point scores into flagged stretches. Scores are median-smoothed,
 * short gaps are bridged and single-sample blips dropped, so the result reads
 * as sections of trail rather than individual points. A null score (no
 * terrain data) always ends a run.
 */
export function findRuns(scores: Array<number | null>, spacing: number, params: ScoreParams = DEFAULT_PARAMS): Run[] {
  const smoothed = scores.map((s, i) => {
    if (s === null) return null;
    const window = [scores[i - 1] ?? s, s, scores[i + 1] ?? s].sort((a, b) => a - b);
    return window[1];
  });

  const flagged = params.thresholds[0];
  const runs: Run[] = [];
  let current: Run | null = null;
  for (let i = 0; i < smoothed.length; i++) {
    const s = smoothed[i];
    if (s !== null && s >= flagged) {
      if (current) {
        current.end = i;
        current.peak = Math.max(current.peak, s);
      } else {
        current = { start: i, end: i, peak: s };
      }
    } else if (current) {
      runs.push(current);
      current = null;
    }
  }
  if (current) runs.push(current);

  const merged: Run[] = [];
  for (const run of runs) {
    const prev = merged[merged.length - 1];
    const gapHasData = prev && smoothed.slice(prev.end + 1, run.start).every((s) => s !== null);
    if (prev && gapHasData && (run.start - prev.end - 1) * spacing <= params.mergeGapM) {
      prev.end = run.end;
      prev.peak = Math.max(prev.peak, run.peak);
    } else {
      merged.push({ ...run });
    }
  }
  return merged.filter(
    (run) => (run.end - run.start + 1) * spacing >= params.minLengthM || run.peak >= params.thresholds[2],
  );
}
