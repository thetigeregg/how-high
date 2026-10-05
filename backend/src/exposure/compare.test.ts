import { describe, expect, it } from "vitest";
import type { Projection } from "../geo/projection.js";
import { resample } from "../gpx/resample.js";
import { analyseTrack } from "./analyze.js";
import { distance, flaggedShare, judgeMark, mostSimilar, profileOf, verdictFor, type Profile, type Reference } from "./compare.js";
import { DEFAULT_PARAMS } from "./score.js";

const base: Profile = { score: 60, fallM: 20, drop100M: 50, crossSlopeDeg: 35, forest: false };
const reference = (kind: Reference["kind"], profile: Partial<Profile>): Reference => ({
  analysisId: 1,
  name: "Reference hike",
  kind,
  startM: 0,
  endM: 100,
  profile: { ...base, ...profile },
});

describe("comparing stretches", () => {
  it("is zero for identical stretches and grows with differences", () => {
    expect(distance(base, base, DEFAULT_PARAMS)).toBe(0);
    expect(distance(base, { ...base, score: 70 }, DEFAULT_PARAMS)).toBeCloseTo(0.2);
    expect(distance(base, { ...base, forest: true }, DEFAULT_PARAMS)).toBeCloseTo(0.15);
  });

  it("ignores differences that would not change the score", () => {
    // Both fall heights are past the point where a fall counts in full.
    expect(distance({ ...base, fallM: 80 }, { ...base, fallM: 300 }, DEFAULT_PARAMS)).toBe(0);
  });

  it("names the closest reference", () => {
    const near = reference("uneasy", { score: 63 });
    const far = reference("bad", { score: 72, fallM: 45 });
    expect(mostSimilar(base, [far, near], DEFAULT_PARAMS)).toBe(near);
  });

  it("names nothing when every reference scores very differently", () => {
    expect(mostSimilar(base, [reference("fine", { score: 20 }), reference("bad", { score: 95 })], DEFAULT_PARAMS)).toBeNull();
  });

  it("profiles a stretch by the hardest values found in it", () => {
    const identity: Projection = { name: "test", forward: (x, y) => [x, y], inverse: (x, y) => [x, y] };
    // Flat for the first half of the track, then a 45° slope falling away to the right.
    const terrain = { source: "synthetic", cellSize: 2, elevation: (x: number, y: number) => (y < 0 ? 1000 : 1000 - Math.max(0, x + 2)) };
    const analysis = analyseTrack(terrain, resample([[0, -200], [0, 200]], 5), identity);
    expect(profileOf(analysis, 0, 100)!.score).toBe(0);
    const steep = profileOf(analysis, 300, 400)!;
    expect(steep.score).toBeGreaterThan(75);
    expect(steep.fallM).toBeGreaterThan(50);
    expect(profileOf(analysis, 5000, 6000)).toBeNull();
  });
});

describe("verdict on a route not done yet", () => {
  // Only the fields the verdict reads matter here.
  const route = (...sections: Array<[robustScore: number, lengthM: number]>) =>
    ({ profile: "hike", sections: sections.map(([robustScore, lengthM], i) => ({ robustScore, lengthM, startM: i * 1000 })) }) as never;
  const marked = (kind: Reference["kind"], score: number): Reference => ({ ...reference(kind, { score }), routeProfile: "hike" });
  const marks = [marked("fine", 38), marked("uneasy", 48), marked("bad", 73), marked("turned_back", 81)];

  it("says when a route goes beyond the hardest stretch that bothered them", () => {
    const verdict = verdictFor(route([91, 3000], [60, 500]), marks)!;
    expect(verdict.tone).toBe("beyond");
    expect(verdict.reference?.kind).toBe("turned_back");
    expect(verdict.lengthAtOrAboveM).toBe(3000);
  });

  it("names the hardest bothersome stretch the route still reaches", () => {
    const verdict = verdictFor(route([75, 200], [50, 100], [30, 400]), marks)!;
    expect(verdict.tone).toBe("difficult");
    expect(verdict.reference?.kind).toBe("bad");
    expect(verdict.lengthAtOrAboveM).toBe(200);
  });

  it("calls a route fine when a stretch marked fine was at least as hard", () => {
    expect(verdictFor(route([30, 100]), marks)).toMatchObject({ tone: "fine", reference: { kind: "fine" } });
    expect(verdictFor(route(), marks)?.tone).toBe("fine");
  });

  it("admits when a route falls between what was fine and what was not", () => {
    expect(verdictFor(route([44, 100]), marks)?.tone).toBe("unknown");
  });

  it("says when the tone comes from a short spot, and how the rest stands", () => {
    // One 65 m spot at the level of a stretch marked uneasy; everything else is mild.
    const verdict = verdictFor(route([30, 200], [64, 65], [20, 80]), marks)!;
    expect(verdict.tone).toBe("difficult");
    expect(verdict.reference?.kind).toBe("uneasy");
    expect(verdict.brief).toEqual({ spots: 1, firstAtM: 1000, restTone: "fine" });
  });

  it("does not call a long difficult stretch a short spot", () => {
    expect(verdictFor(route([64, 400]), marks)!.brief).toBeNull();
    expect(verdictFor(route([30, 100]), marks)!.brief).toBeNull();
  });

  it("notes a short spot beyond everything marked on a route that is difficult anyway", () => {
    const verdict = verdictFor(route([95, 40], [75, 900]), marks)!;
    expect(verdict.tone).toBe("beyond");
    expect(verdict.brief).toMatchObject({ spots: 1, restTone: "difficult" });
  });

  it("only judges by marks of the same kind of travel, and says nothing without any", () => {
    expect(verdictFor(route([91, 100]), marks.map((m) => ({ ...m, routeProfile: "road" as const })))).toBeNull();
    expect(verdictFor(route([91, 100]), [])).toBeNull();
  });
});

describe("judging a mark against the model", () => {
  const identity: Projection = { name: "test", forward: (x, y) => [x, y], inverse: (x, y) => [x, y] };
  // 1 km of flat ground with one 100 m stretch of 45° slope in the middle.
  const terrain = { source: "synthetic", cellSize: 2, elevation: (x: number, y: number) => (Math.abs(y) < 50 ? 1000 - Math.max(0, x + 2) : 1000) };
  const analysis = analyseTrack(terrain, resample([[0, -500], [0, 500]], 5), identity);

  it("measures how much of a stretch is flagged", () => {
    expect(flaggedShare(analysis, 0, 1000)!).toBeGreaterThan(0.08);
    expect(flaggedShare(analysis, 0, 1000)!).toBeLessThan(0.2);
    expect(flaggedShare(analysis, 460, 540)).toBe(1);
    expect(flaggedShare(analysis, 0, 300)).toBe(0);
    expect(flaggedShare(analysis, 5000, 6000)).toBeNull();
  });

  it("agrees with a short bad mark on the steep spot, and with fine marks on the flat", () => {
    expect(judgeMark(analysis, "bad", 460, 540).disagreement).toBeNull();
    expect(judgeMark(analysis, "fine", 0, 300).disagreement).toBeNull();
  });

  it("disagrees when a long stretch marked bad is mostly shown as easy", () => {
    const judged = judgeMark(analysis, "bad", 0, 1000);
    expect(judged.level).toBe("red");
    expect(judged.disagreement).toBe("missed");
    // Uneasy over the same stretch may have been so in places; one flagged spot is enough.
    expect(judgeMark(analysis, "uneasy", 0, 1000).disagreement).toBeNull();
  });

  it("still catches the plain cases", () => {
    expect(judgeMark(analysis, "fine", 0, 1000).disagreement).toBe("overFlagged");
    expect(judgeMark(analysis, "uneasy", 0, 300).disagreement).toBe("missed");
  });
});
