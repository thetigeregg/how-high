import type { Analysis, Profile as RouteProfile } from "./analyze.js";
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
  /** Hikes and rides are scored on different scales, so they are only compared with their own kind. */
  routeProfile: RouteProfile;
}

/**
 * Where a route not yet done stands against what the user has marked:
 * - `beyond`: harder than the hardest stretch that bothered them
 * - `difficult`: at least as hard as a stretch that bothered them
 * - `unknown`: harder than anything marked fine, milder than anything that bothered them
 * - `fine`: nothing harder than a stretch marked fine
 */
export interface Verdict {
  tone: "beyond" | "difficult" | "unknown" | "fine";
  /** The marked stretch the verdict is measured against. */
  reference: Reference | null;
  /** Length of this route at or above the reference's score, metres. */
  lengthAtOrAboveM: number;
  /**
   * Set when that length is so short that the tone describes a spot or two,
   * not the route: how many sections it is, where the first starts, and how
   * the rest of the route stands without them.
   */
  brief: { spots: number; firstAtM: number; restTone: Verdict["tone"] } | null;
}

/** Up to this much at or above the reference level counts as a short spot rather than the character of the route. */
const BRIEF_M = 150;

/**
 * Judges a route by its flagged sections' "at least" scores, i.e. what holds
 * up even if the line is a few metres off, so one noisy spot does not decide
 * it. The tone goes by the worst stretch, however short, because the
 * stretches that bother someone are often short themselves; when it is only
 * a spot or two, the verdict says that too. Returns null when there are no
 * marks of the same kind to judge by.
 */
export function verdictFor(analysis: Analysis, references: Reference[]): Verdict | null {
  const relevant = references.filter((r) => r.routeProfile === analysis.profile);
  if (relevant.length === 0) return null;
  const byScore = (a: Reference, b: Reference) => a.profile.score - b.profile.score;
  const difficult = relevant.filter((r) => r.kind !== "fine").sort(byScore);
  const fine = relevant.filter((r) => r.kind === "fine").sort(byScore);

  const judge = (sections: Analysis["sections"]): Omit<Verdict, "brief"> => {
    const peak = Math.max(0, ...sections.map((s) => s.robustScore));
    const lengthAtOrAbove = (score: number) =>
      sections.filter((s) => s.robustScore >= score).reduce((sum, s) => sum + s.lengthM, 0);
    const hardest = difficult[difficult.length - 1];
    if (hardest && peak > hardest.profile.score) {
      return { tone: "beyond", reference: hardest, lengthAtOrAboveM: lengthAtOrAbove(hardest.profile.score) };
    }
    // The hardest stretch that bothered them which this route still reaches.
    const reached = difficult.filter((r) => r.profile.score <= peak).pop();
    if (reached) return { tone: "difficult", reference: reached, lengthAtOrAboveM: lengthAtOrAbove(reached.profile.score) };
    const easiestFineAbove = fine.find((r) => r.profile.score >= peak);
    if (easiestFineAbove) return { tone: "fine", reference: easiestFineAbove, lengthAtOrAboveM: 0 };
    return { tone: "unknown", reference: fine[fine.length - 1] ?? difficult[0] ?? null, lengthAtOrAboveM: 0 };
  };

  const verdict = judge(analysis.sections);
  const level = verdict.reference?.profile.score ?? 0;
  const troubling = verdict.tone === "beyond" || verdict.tone === "difficult";
  if (!troubling || verdict.lengthAtOrAboveM > BRIEF_M) return { ...verdict, brief: null };
  // Only a spot or two reach that level: say so, and say how the route stands without them.
  const spots = analysis.sections.filter((s) => s.robustScore >= level);
  const rest = judge(analysis.sections.filter((s) => s.robustScore < level));
  return { ...verdict, brief: { spots: spots.length, firstAtM: spots[0].startM, restTone: rest.tone } };
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
