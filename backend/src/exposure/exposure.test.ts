import { describe, expect, it } from "vitest";
import { resample } from "../gpx/resample.js";
import type { Projection } from "../geo/projection.js";
import type { Terrain } from "../terrain/grid.js";
import { analyseTrack } from "./analyze.js";
import { measureTrack } from "./metrics.js";
import { findRuns } from "./score.js";

const identity: Projection = { name: "test", forward: (x, y) => [x, y], inverse: (x, y) => [x, y] };

function ground(elevation: (x: number, y: number) => number): Terrain {
  return { source: "synthetic", cellSize: 2, elevation };
}

/** A 400 m track heading north (+y) along x = `x`. */
function northbound(x: number) {
  return resample([[x, -200], [x, 200]], 5);
}

function middle<T>(items: T[]): T {
  return items[Math.floor(items.length / 2)];
}

const tan = (deg: number) => Math.tan((deg * Math.PI) / 180);

describe("exposure on synthetic terrain", () => {
  it("finds nothing on a flat plateau", () => {
    const analysis = analyseTrack(ground(() => 1000), northbound(0), identity);
    expect(analysis.sections).toEqual([]);
    expect(analysis.summary.level).toBe("green");
  });

  it("measures a 30° side slope without calling it a fall", () => {
    // Ground drops towards +x, i.e. to the right of a northbound walker.
    const m = middle(measureTrack(ground((x) => 1000 - x * tan(30)), northbound(0)))!;
    expect(m.crossSlopeDeg).toBeCloseTo(30, 1);
    expect(m.fallLeft).toBe(0);
    expect(m.fallRight).toBe(0);
    expect(m.drop100).toBeCloseTo(100 * tan(30), 0);
    expect(m.dropLeft30).toBe(0);
    expect(Math.abs(m.trackGradeDeg)).toBeLessThan(0.1);
  });

  it("rates a traverse of a 45° slope red, with the drop on the right", () => {
    const analysis = analyseTrack(ground((x) => 1000 - x), northbound(0), identity);
    expect(analysis.summary.level).toBe("red");
    expect(analysis.sections).toHaveLength(1);
    expect(analysis.sections[0].side).toBe("right");
    expect(analysis.sections[0].dropTowards).toBe("E");
    expect(analysis.sections[0].maxFallM).toBeGreaterThan(100);
  });

  it("separates walking straight up a slope from traversing it", () => {
    const m = middle(measureTrack(ground((_x, y) => 1000 + y * tan(30)), northbound(0)))!;
    expect(m.trackGradeDeg).toBeCloseTo(30, 1);
    expect(m.crossSlopeDeg).toBeCloseTo(0, 1);
  });

  // Plateau at 1000 m that breaks off at x = 0 into a 50 m wall.
  const cliff = ground((x) => (x < 0 ? 1000 : Math.max(950, 1000 - x * 5)));

  it("flags a path 5 m from a cliff edge", () => {
    const m = middle(measureTrack(cliff, northbound(-5)))!;
    expect(m.drop10).toBeCloseTo(25, 0);
    expect(analyseTrack(cliff, northbound(-5), identity).summary.level).toBe("red");
  });

  it("ignores a cliff 40 m away across flat ground", () => {
    expect(analyseTrack(cliff, northbound(-40), identity).sections).toEqual([]);
  });

  it("reports a knife ridge as exposed on both sides", () => {
    const analysis = analyseTrack(ground((x) => 1000 - Math.abs(x)), northbound(0), identity);
    expect(analysis.sections[0].side).toBe("both");
    expect(analysis.summary.level).toBe("red");
  });

  it("spots a bridge over a gully the track crosses in a straight line", () => {
    const gully = ground((_x, y) => (Math.abs(y) < 6 ? 985 : 1000));
    const analysis = analyseTrack(gully, northbound(0), identity);
    expect(analysis.sections).toHaveLength(1);
    expect(analysis.sections[0].possibleBridge).toBe(true);
    // Mid-span, 200 m in: the deck is 15 m above the gully floor.
    expect(analysis.points[40].metrics!.bridgeGap).toBeCloseTo(15, 1);
  });

  it("gives a lower 'at least' score when a GPS shift moves the track off the edge", () => {
    const section = analyseTrack(cliff, northbound(-27), identity).sections[0];
    expect(section.robustScore).toBeLessThan(section.maxScore);
  });
});

describe("findRuns", () => {
  const scores = (pattern: string) => [...pattern].map((c) => (c === "." ? 0 : c === "?" ? null : Number(c) * 10));

  it("merges runs separated by a short gap and drops single blips", () => {
    //                  0         1         2
    //                  0123456789012345678901234567
    const runs = findRuns(scores("...555..555.........5......."), 5);
    expect(runs.map((r) => [r.start, r.end])).toEqual([[3, 10]]);
  });

  it("never merges across missing terrain data", () => {
    const runs = findRuns(scores("...555?555..."), 5);
    expect(runs).toHaveLength(2);
  });
});
