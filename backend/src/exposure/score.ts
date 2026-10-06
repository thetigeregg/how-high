import type { PointMetrics } from "./metrics.js";
import { VIEW_BANDS_M, VIEW_RAYS } from "./view.js";

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
  /** Flagged stretches closer together than this are reported as one, meters. */
  mergeGapM: number;
  /** Isolated blips shorter than this are dropped unless they reach the top level, meters. */
  minLengthM: number;
  /**
   * Open views: how far below you the visible ground must lie, across the
   * arc below, for the view to start counting and to count in full.
   */
  viewDepthM: [number, number];
  /** How wide the view down has to be, degrees of the horizon. */
  viewArcDeg: number;
  /** How much ground 2 to 8 km away counts compared with ground within 2 km. */
  viewFarWeight: number;
  /** Multiplier on the view score where the map shows forest at the spot. */
  viewForestFactor: number;
  /** Multiplier on the view score as a whole; 0 leaves views out. */
  viewFactor: number;
}

/**
 * Starting point for roads and public transport. Seen from inside a vehicle
 * and behind a guardrail, it takes a bigger drop to matter, tall bridges
 * count more, and how steep the road climbs does not count at all.
 */
export const DEFAULT_ROAD_PARAMS: ScoreParams = {
  fallHeightM: [10, 100],
  drop10M: [8, 30],
  drop30M: [15, 60],
  drop100M: [40, 120],
  crossSlopeDeg: [30, 50],
  trackGradeDeg: [80, 89],
  bridgeGapM: [10, 60],
  ridgeDropM: 15,
  ridgeFactor: 1.2,
  thresholds: [25, 50, 75],
  forestFactor: 0.8,
  wideTrackFactor: 1,
  dropWeight: 0.75,
  mergeGapM: 100,
  minLengthM: 30,
  viewDepthM: [250, 450],
  viewArcDeg: 90,
  viewFarWeight: 0.5,
  viewForestFactor: 0.5,
  // Off for rides until there is something to calibrate it against: from a
  // train window in the mountains there is a view nearly everywhere.
  viewFactor: 0,
};

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
  viewDepthM: [250, 450],
  viewArcDeg: 90,
  viewFarWeight: 0.5,
  viewForestFactor: 0.5,
  viewFactor: 1,
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
  /** Set where the stretch is traveled by a kind of transport that can be a no-go outright. */
  noGo: NoGoKind | null;
}

export type NoGoKind = "cableCars" | "funiculars" | "rackRailways";
export type NoGoSettings = Record<NoGoKind, boolean>;

/** Applies map context to a terrain-only score. Without context the score is unchanged. */
export function adjustScore(raw: number, context: PointContext | null, params: ScoreParams = DEFAULT_PARAMS): number {
  if (!context) return raw;
  if (context.tunnel) return 0;
  let score = raw;
  if (context.forest) score *= params.forestFactor;
  if (context.wide) score *= params.wideTrackFactor;
  return score;
}

/**
 * How steeply the ground falls away beside the path, degrees: the measured
 * side slope, but no more than the drop within 10 m bears out. The side slope
 * alone cannot tell a hillside falling away below from a wall rising above
 * with only a short bank under the path; at the foot of a cliff it is the
 * wall that is steep, and that is not exposure.
 */
export function fallAwayDeg(m: PointMetrics, side?: "left" | "right"): number {
  const drop = side === "left" ? m.dropLeft10 : side === "right" ? m.dropRight10 : m.drop10;
  // Measurements from before drops were kept per side fall back to the side slope as it was.
  if (drop === undefined) return m.crossSlopeDeg;
  return Math.min(m.crossSlopeDeg, (Math.atan(Math.max(0, drop) / 10) * 180) / Math.PI);
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
    100 * (params.dropWeight * Math.max(fall, drop) + (1 - params.dropWeight) * ramp(fallAwayDeg(m), params.crossSlopeDeg));
  if (Math.min(m.dropLeft30, m.dropRight30) >= params.ridgeDropM) score *= params.ridgeFactor;
  score += 10 * ramp(Math.abs(m.trackGradeDeg), params.trackGradeDeg);
  score = Math.max(score, 100 * ramp(m.bridgeGap, params.bridgeGapM));
  return Math.min(100, score);
}

/** What a place shows of the height it is at, as measured by `measureView`. */
export interface View {
  /** Depth of the lowest visible ground per direction and distance band; see `measureView`. */
  depths: number[];
  /** Whether the map shows forest at the spot, which would hide the view. */
  wooded: boolean;
}

/**
 * How deep the view down is across the widest arc that counts: with a 90°
 * arc, the depth that a quarter of the horizon reaches or exceeds. Ground
 * beyond 2 km counts for less, since a far-off plain is less present than a
 * valley at your feet.
 */
export function viewDepth(view: View, params: ScoreParams = DEFAULT_PARAMS): number {
  const bands = VIEW_BANDS_M.length;
  const felt: number[] = [];
  for (let ray = 0; ray < VIEW_RAYS; ray++) {
    const within2km = view.depths[ray * bands + 1];
    const within8km = view.depths[ray * bands + 2];
    felt.push(Math.max(within2km, within8km * params.viewFarWeight));
  }
  felt.sort((a, b) => b - a);
  const rays = Math.min(VIEW_RAYS, Math.max(1, Math.round((params.viewArcDeg / 360) * VIEW_RAYS)));
  return felt[rays - 1];
}

/** How much a place's view shows of its height, 0 (nothing) to 100. */
export function scoreView(view: View | null | undefined, params: ScoreParams = DEFAULT_PARAMS): number {
  if (!view || params.viewFactor === 0) return 0;
  const score = 100 * ramp(viewDepth(view, params), params.viewDepthM) * params.viewFactor;
  return view.wooded ? score * params.viewForestFactor : score;
}

/**
 * Exposure from one side only, as someone sitting by that window would have
 * it: the fall and drops on that side, and the side slope if that is the side
 * the ground falls to. Ridges, path steepness and bridges are left out; a
 * bridge is open on both sides and is handled by the caller.
 */
export function scoreSide(m: PointMetrics, side: "left" | "right", params: ScoreParams = DEFAULT_PARAMS): number {
  const left = side === "left";
  const worst = Math.max(
    ramp(left ? m.fallLeft : m.fallRight, params.fallHeightM),
    ramp(left ? m.dropLeft10 : m.dropRight10, params.drop10M),
    ramp(left ? m.dropLeft30 : m.dropRight30, params.drop30M),
    ramp(left ? m.dropLeft100 : m.dropRight100, params.drop100M),
  );
  const fallsThisWay = left ? m.dropLeft30 >= m.dropRight30 : m.dropRight30 >= m.dropLeft30;
  const slope = fallsThisWay ? ramp(fallAwayDeg(m, side), params.crossSlopeDeg) : 0;
  return 100 * (params.dropWeight * worst + (1 - params.dropWeight) * slope);
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
