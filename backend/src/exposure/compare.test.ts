import { describe, expect, it } from "vitest";
import type { Projection } from "../geo/projection.js";
import { resample } from "../gpx/resample.js";
import { analyseTrack } from "./analyze.js";
import { distance, mostSimilar, profileOf, type Profile, type Reference } from "./compare.js";
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
