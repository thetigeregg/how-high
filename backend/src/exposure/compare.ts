import type { Analysis, Profile as RouteProfile } from "./analyze.js";
import type { ScoreParams } from "./score.js";

/** The hardest values found anywhere along a stretch. */
export interface Profile {
  score: number;
  /** The same peak taken from the drop score alone and from the view score alone. */
  dropScore?: number;
  viewScore?: number;
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
  /**
   * What the user put a difficult stretch down to, when they named one thing:
   * it is then only compared with stretches flagged for the same thing. A
   * stretch that was uneasy for its view says nothing about a drop.
   */
  cause?: "drops" | "view" | null;
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
  /** Length of this route at or above the reference's score, meters. */
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
 * up even if the line is a few meters off, so one noisy spot does not decide
 * it. The tone goes by the worst stretch, however short, because the
 * stretches that bother someone are often short themselves; when it is only
 * a spot or two, the verdict says that too. Like is compared with like: a
 * section flagged for its drop is not judged by a stretch that was uneasy
 * for its view, nor vouched for by one that was fine only because its drops
 * were small. Returns null when there are no marks of the same kind of
 * travel to judge by.
 */
export function verdictFor(analysis: Analysis, references: Reference[]): Verdict | null {
  const relevant = references.filter((r) => r.routeProfile === analysis.profile);
  if (relevant.length === 0) return null;
  const difficult = relevant.filter((r) => r.kind !== "fine");
  const fine = relevant.filter((r) => r.kind === "fine");
  type Flagged = Analysis["sections"][number];
  const flaggedFor = (s: Flagged, what: "drops" | "view") => s.cause === undefined || s.cause === "both" || s.cause === what;

  /** The score a difficult stretch sets as its level for this section, or null if it was difficult for something else. */
  const levelOf = (r: Reference, s: Flagged): number | null => {
    if (r.cause === "view") return flaggedFor(s, "view") ? (r.profile.viewScore ?? r.profile.score) : null;
    if (r.cause === "drops") return flaggedFor(s, "drops") ? (r.profile.dropScore ?? r.profile.score) : null;
    return r.profile.score;
  };
  /** How far a stretch marked fine vouches for this section: by what it scored on the count the section is flagged for. */
  const vouchedTo = (r: Reference, s: Flagged): number => {
    const drops = r.profile.dropScore ?? r.profile.score;
    const view = r.profile.viewScore ?? r.profile.score;
    return s.cause === "drops" ? drops : s.cause === "view" ? view : s.cause === "both" ? Math.min(drops, view) : r.profile.score;
  };

  const judgeSection = (s: Flagged): { tone: Verdict["tone"]; reference: Reference | null; level: number } => {
    const levels = difficult
      .flatMap((r) => {
        const level = levelOf(r, s);
        return level === null ? [] : [{ reference: r, level }];
      })
      .sort((a, b) => a.level - b.level);
    const hardest = levels[levels.length - 1];
    if (hardest && s.robustScore > hardest.level) return { tone: "beyond", ...hardest };
    // The hardest stretch that bothered them which this section still reaches.
    const reached = levels.filter((l) => l.level <= s.robustScore).pop();
    if (reached) return { tone: "difficult", ...reached };
    const vouching = fine.filter((r) => vouchedTo(r, s) >= s.robustScore).sort((a, b) => vouchedTo(a, s) - vouchedTo(b, s))[0];
    if (vouching) return { tone: "fine", reference: vouching, level: vouchedTo(vouching, s) };
    return { tone: "unknown", reference: null, level: 0 };
  };

  const ORDER: Array<Verdict["tone"]> = ["fine", "unknown", "difficult", "beyond"];
  const judge = (sections: Flagged[]) => {
    // Nothing flagged at all is as fine as it gets, if anything has been marked fine to say so.
    if (sections.length === 0) {
      return { tone: (fine.length > 0 ? "fine" : "unknown") as Verdict["tone"], reference: fine[0] ?? null, reaching: [] as Flagged[] };
    }
    const judged = sections.map((s) => ({ s, ...judgeSection(s) }));
    const worst = judged.reduce((a, b) =>
      ORDER.indexOf(b.tone) > ORDER.indexOf(a.tone) || (b.tone === a.tone && b.level > a.level) ? b : a,
    );
    const troubling = worst.tone === "beyond" || worst.tone === "difficult";
    // The sections that reach the level of the stretch the verdict names.
    const reaching = troubling
      ? sections.filter((s) => {
          const level = levelOf(worst.reference!, s);
          return level !== null && s.robustScore >= level;
        })
      : [];
    return { tone: worst.tone, reference: worst.reference, reaching };
  };

  const { tone, reference, reaching } = judge(analysis.sections);
  const lengthAtOrAboveM = reaching.reduce((sum, s) => sum + s.lengthM, 0);
  if (reaching.length === 0 || lengthAtOrAboveM > BRIEF_M) return { tone, reference, lengthAtOrAboveM, brief: null };
  // Only a spot or two reach that level: say so, and say how the route stands without them.
  const rest = judge(analysis.sections.filter((s) => !reaching.includes(s)));
  return { tone, reference, lengthAtOrAboveM, brief: { spots: reaching.length, firstAtM: reaching[0].startM, restTone: rest.tone } };
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
    profile.dropScore = Math.max(profile.dropScore ?? 0, p.dropScore ?? 0);
    profile.viewScore = Math.max(profile.viewScore ?? 0, p.viewScore ?? 0);
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

/** A stretch marked bad over more than this is taken to have been bad along its length, not at one spot. */
export const LONG_MARK_M = 300;
/** ...and the model agrees only if at least this share of it is flagged. */
export const LONG_MARK_MIN_SHARE = 0.5;

/** The share of a stretch the model flags at all (Mild or worse), leaving out tunnels and unscored ground. */
export function flaggedShare(analysis: Analysis, startM: number, endM: number): number | null {
  let scored = 0;
  let flagged = 0;
  for (const p of analysis.points) {
    if (p.dist < startM || p.dist > endM || p.score === null || p.context?.tunnel) continue;
    scored++;
    if (p.score >= analysis.thresholds[0]) flagged++;
  }
  return scored === 0 ? null : flagged / scored;
}

/**
 * Whether the model and a mark disagree, and how.
 * - `overFlagged`: marked fine, but something in it is rated Exposed or Severe.
 * - `missed`: marked uneasy or bad, but all of it is rated Easy; or marked bad
 *   over a long stretch of which the model flags less than half. Judging a
 *   long stretch by its single worst spot would call that agreement.
 */
export function judgeMark(analysis: Analysis, kind: MarkKind, startM: number, endM: number) {
  const order = ["green", "yellow", "orange", "red"];
  const level = analysis.sections
    .filter((s) => s.startM <= endM && s.endM >= startM)
    .reduce((worst, s) => (order.indexOf(s.level) > order.indexOf(worst) ? s.level : worst), "green" as Analysis["summary"]["level"]);
  const share = flaggedShare(analysis, startM, endM);
  const underRead = kind === "bad" && endM - startM >= LONG_MARK_M && share !== null && share < LONG_MARK_MIN_SHARE;
  const disagreement =
    kind === "fine" && order.indexOf(level) >= order.indexOf("orange")
      ? ("overFlagged" as const)
      : kind !== "fine" && (level === "green" || underRead)
        ? ("missed" as const)
        : null;
  return { level, flaggedShare: share, disagreement };
}
