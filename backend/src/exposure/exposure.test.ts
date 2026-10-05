import { describe, expect, it } from "vitest";
import { buildContext, type TerrainContext } from "../context/context.js";
import { lv95, type Projection } from "../geo/projection.js";
import { resample } from "../gpx/resample.js";
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

describe("map context", () => {
  const slope = ground((x) => 1000 - x);
  const path = { tunnel: false, bridge: false, wide: false, sacGrade: null, aided: false };
  const context = (overrides: Partial<TerrainContext>): TerrainContext => ({
    inForest: () => false,
    pathAt: () => null,
    cliffNear: () => false,
    ...overrides,
  });
  const terrainOnly = analyseTrack(slope, northbound(0), identity).sections[0].maxScore;

  it("lowers the score where the slope below the path is wooded, even if the path is not", () => {
    // Trees only downhill (x > 5); the path at x = 0 runs along the forest edge.
    const analysis = analyseTrack(slope, northbound(0), identity, { context: context({ inForest: (x) => x > 5 }) });
    expect(analysis.sections[0].maxScore).toBe(Math.round(terrainOnly * 0.6));
    expect(analysis.sections[0].rawMaxScore).toBe(terrainOnly);
    expect(analysis.sections[0].context?.forest).toBe(true);
  });

  it("does not count trees on the uphill side", () => {
    const analysis = analyseTrack(slope, northbound(0), identity, { context: context({ inForest: (x) => x < 5 }) });
    expect(analysis.sections[0].maxScore).toBe(terrainOnly);
  });

  it("clears tunnels", () => {
    const analysis = analyseTrack(slope, northbound(0), identity, {
      context: context({ pathAt: () => ({ ...path, tunnel: true }) }),
    });
    expect(analysis.sections).toEqual([]);
  });

  it("keeps a bridge the map confirms and drops one it disproves", () => {
    const gully = ground((_x, y) => (Math.abs(y) < 6 ? 985 : 1000));
    const confirmed = analyseTrack(gully, northbound(0), identity, {
      context: context({ pathAt: () => ({ ...path, bridge: true }) }),
    });
    expect(confirmed.sections[0].context?.bridge).toBe(true);
    expect(confirmed.points[40].metrics!.bridgeGap).toBeCloseTo(15, 1);
    const disproved = analyseTrack(gully, northbound(0), identity, { context: context({ pathAt: () => path }) });
    expect(disproved.points[40].metrics!.bridgeGap).toBe(0);
  });

  it("reports the hardest mapped grade and aids along a section", () => {
    const analysis = analyseTrack(slope, northbound(0), identity, {
      context: context({ pathAt: (_x, y) => ({ ...path, sacGrade: y > 0 ? 4 : 2, aided: y > 100 }) }),
    });
    expect(analysis.sections[0].context).toMatchObject({ sacGrade: 4, aided: true, forest: false });
  });
});

describe("buildContext", () => {
  // 0.001° is about 111 m north-south and 76 m east-west at this latitude.
  const square = (lat: number, lon: number, size: number) =>
    [[0, 0], [0, size], [size, size], [size, 0], [0, 0]].map(([a, b]) => ({ lat: lat + a, lon: lon + b }));
  const projection = lv95;
  const [x0, y0] = projection.forward(8.0, 47.0);
  const context = buildContext(
    [
      // A forest with a clearing, as a multipolygon whose outer ring arrives in two pieces.
      {
        type: "relation",
        tags: { landuse: "forest" },
        members: [
          { type: "way", role: "outer", geometry: square(47.0, 8.0, 0.004).slice(0, 3) },
          { type: "way", role: "outer", geometry: square(47.0, 8.0, 0.004).slice(2) },
          { type: "way", role: "inner", geometry: square(47.001, 8.001, 0.001) },
        ],
      },
      { type: "way", tags: { highway: "path", sac_scale: "alpine_hiking", bridge: "yes" }, geometry: [{ lat: 47.0, lon: 8.0 }, { lat: 47.004, lon: 8.0 }] },
      { type: "way", tags: { highway: "track", tunnel: "no" }, geometry: [{ lat: 47.0, lon: 8.004 }, { lat: 47.004, lon: 8.004 }] },
    ],
    projection,
    { minX: x0 - 200, minY: y0 - 200, maxX: x0 + 600, maxY: y0 + 700 },
  );
  const at = (lat: number, lon: number) => projection.forward(lon, lat);

  it("fills multipolygon forests and leaves their clearings open", () => {
    expect(context.inForest(...at(47.0005, 8.0005))).toBe(true);
    expect(context.inForest(...at(47.0015, 8.0015))).toBe(false);
    expect(context.inForest(...at(47.0035, 8.0035))).toBe(true);
    expect(context.inForest(...at(46.9995, 8.0005))).toBe(false);
  });

  it("matches the nearest mapped path and reads its tags", () => {
    expect(context.pathAt(...at(47.002, 8.00005))).toEqual({ tunnel: false, bridge: true, wide: false, sacGrade: 4, aided: false });
    expect(context.pathAt(...at(47.002, 8.00395))).toMatchObject({ wide: true, tunnel: false });
    expect(context.pathAt(...at(47.002, 8.002))).toBeNull();
  });
});
