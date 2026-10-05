import type { Analysis } from "./analyze.js";
import type { ScoreParams } from "./score.js";

/** The hardest values found anywhere along a stretch. */
export interface Profile {
  score: number;
  fallM: number;
  drop100M: number;
  crossSlopeDeg: number;
  forest: boolean;
}

export type MarkKind = "fine" | "uneasy" | "bad" | "turned_back";

/** A stretch the user has judged in person, with what the model measured there. */
export interface Reference {
  analysisId: number;
  name: string;
  kind: MarkKind;
  startM: number;
  endM: number;
  profile: Profile;
}

/** Sections whose scores differ by more than this are never called similar. */
const MAX_SCORE_GAP = 15;
/** Largest overall distance at which two stretches still count as similar. */
const MAX_DISTANCE = 0.45;
const FOREST_MISMATCH = 0.15;

/** Profile of the stretch between two distances; null if it has no terrain data. */
export function profileOf(analysis: Analysis, startM: number, endM: number): Profile | null {
  const profile: Profile = { score: 0, fallM: 0, drop100M: 0, crossSlopeDeg: 0, forest: false };
  let count = 0;
  let wooded = 0;
  for (const p of analysis.points) {
    if (p.dist < startM || p.dist > endM || !p.metrics || p.score === null) continue;
    count++;
    if (p.context?.forest) wooded++;
    profile.score = Math.max(profile.score, p.score);
    profile.fallM = Math.max(profile.fallM, p.metrics.fallLeft, p.metrics.fallRight);
    profile.drop100M = Math.max(profile.drop100M, p.metrics.drop100);
    profile.crossSlopeDeg = Math.max(profile.crossSlopeDeg, p.metrics.crossSlopeDeg);
  }
  if (count === 0) return null;
  profile.forest = wooded * 2 >= count;
  return profile;
}

/**
 * How unlike two stretches are: 0 for identical, growing with differences in
 * score and in what produces it. Each measurement is compared on the same
 * scale the score uses, so a difference only counts where it would matter.
 */
export function distance(a: Profile, b: Profile, params: ScoreParams): number {
  const onRamp = (value: number, [low, high]: [number, number]) => Math.min(1, Math.max(0, (value - low) / (high - low)));
  const gap = (pick: (p: Profile) => number, ramp: [number, number]) => Math.abs(onRamp(pick(a), ramp) - onRamp(pick(b), ramp));
  const shape =
    (gap((p) => p.fallM, params.fallHeightM) +
      gap((p) => p.drop100M, params.drop100M) +
      gap((p) => p.crossSlopeDeg, params.crossSlopeDeg)) /
    3;
  return (2 * Math.abs(a.score - b.score)) / 100 + shape + (a.forest === b.forest ? 0 : FOREST_MISMATCH);
}

/** The reference most like the given stretch, if any is close enough to be worth naming. */
export function mostSimilar(profile: Profile, references: Reference[], params: ScoreParams): Reference | null {
  let best: Reference | null = null;
  let bestDistance = MAX_DISTANCE;
  for (const reference of references) {
    if (Math.abs(reference.profile.score - profile.score) > MAX_SCORE_GAP) continue;
    const d = distance(profile, reference.profile, params);
    if (d <= bestDistance) {
      bestDistance = d;
      best = reference;
    }
  }
  return best;
}
