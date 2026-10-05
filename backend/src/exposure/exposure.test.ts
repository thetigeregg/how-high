import { describe, expect, it } from "vitest";
import { buildContext, type TerrainContext } from "../context/context.js";
import { lv95, type Projection } from "../geo/projection.js";
import { resample } from "../gpx/resample.js";
import type { Terrain } from "../terrain/grid.js";
import { DEFAULT_SETTINGS, settingsSchema } from "../settings.js";
import { analyseTrack, measure, score } from "./analyze.js";
import { DEFAULT_MEASURE, measureTrack } from "./metrics.js";
import { DEFAULT_PARAMS, findRuns } from "./score.js";

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
  const path = { tunnel: false, bridge: false, wide: false, sacGrade: null, aided: false, rack: false, funicular: false };
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
    expect(context.pathAt(...at(47.002, 8.00005))).toEqual({
      tunnel: false, bridge: true, wide: false, sacGrade: 4, aided: false, rack: false, funicular: false,
    });
    expect(context.pathAt(...at(47.002, 8.00395))).toMatchObject({ wide: true, tunnel: false });
    expect(context.pathAt(...at(47.002, 8.002))).toBeNull();
    // Footpaths and forestry tracks are not somewhere a car or train runs.
    expect(context.pathAt(...at(47.002, 8.00005), "road")).toBeNull();
    expect(context.pathAt(...at(47.002, 8.00395), "rail")).toBeNull();
  });
});

describe("settings", () => {
  const measurement = measure(ground((x) => 1000 - x * tan(30)), northbound(0), identity);

  it("re-scores stored measurements without measuring again", () => {
    const strict = score(measurement, { ...DEFAULT_PARAMS, thresholds: [10, 20, 30] });
    const relaxed = score(measurement, { ...DEFAULT_PARAMS, thresholds: [60, 80, 95] });
    expect(strict.summary.level).toBe("red");
    expect(relaxed.summary.level).toBe("green");
    expect(strict.points[40].score).toBe(relaxed.points[40].score);
    expect(strict.thresholds).toEqual([10, 20, 30]);
  });

  it("shifts weight between drops and side slope", () => {
    const point = (dropWeight: number) => score(measurement, { ...DEFAULT_PARAMS, dropWeight }).points[40].score!;
    // On a 30° slope the side-slope share is 0.25 and the drop share about 0.55.
    expect(point(0)).toBeCloseTo(25, 0);
    expect(point(1)).toBeGreaterThan(point(0));
  });

  it("counts gentler ground as a fall when the fall steepness is lowered", () => {
    const at = (fallSlopeDeg: number) =>
      middle(measure(ground((x) => 1000 - x * tan(30)), northbound(0), identity, { params: { ...DEFAULT_MEASURE, fallSlopeDeg } }).points).metrics!;
    expect(at(35).fallRight).toBe(0);
    expect(at(25).fallRight).toBeGreaterThan(100);
  });

  it("rejects ranges and levels that are out of order", () => {
    expect(settingsSchema.safeParse(DEFAULT_SETTINGS).success).toBe(true);
    expect(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, score: { ...DEFAULT_PARAMS, drop10M: [16, 4] } }).success).toBe(false);
    expect(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, score: { ...DEFAULT_PARAMS, thresholds: [50, 25, 75] } }).success).toBe(false);
  });
});

describe("routes", () => {
  const flat = measure(ground(() => 1000), northbound(0), identity);
  const noGoContext = { forest: false, matched: false, tunnel: false, bridge: false, wide: false, sacGrade: null, aided: false, cliff: false };
  // The second half of a flat route is ridden on a cable car.
  const withLift = {
    ...flat,
    profile: "road" as const,
    legs: [
      { mode: "bus" as const, label: "Bus 1", startM: 0, endM: 195 },
      { mode: "lift" as const, label: "Cable car", startM: 200, endM: 400 },
    ],
    points: flat.points.map((p) => (p.dist >= 200 ? { ...p, context: { ...noGoContext, noGo: "cableCars" as const } } : p)),
  };

  it("rates no-go transport as severe whatever the terrain", () => {
    const analysis = score(withLift);
    expect(analysis.sections).toHaveLength(1);
    expect(analysis.sections[0]).toMatchObject({ level: "red", startM: 200, maxScore: 100 });
    expect(analysis.sections[0].context?.noGo).toBe("cableCars");
    expect(analysis.legs.map((l) => l.mode)).toEqual(["bus", "lift"]);
  });

  it("leaves it alone when that kind of transport is allowed in settings", () => {
    const analysis = score(withLift, DEFAULT_PARAMS, { noGo: { cableCars: false, funiculars: true, rackRailways: true } });
    expect(analysis.sections).toEqual([]);
  });

  it("scores walked stretches of a road route with the walking settings", () => {
    const slope = measure(ground((x) => 1000 - x), northbound(0), identity);
    const walked = { ...slope, profile: "road" as const, legs: [{ mode: "walk" as const, label: "Walk", startM: 0, endM: 400 }] };
    const lenient = { ...DEFAULT_PARAMS, fallHeightM: [900, 999] as [number, number], drop10M: [900, 999] as [number, number], drop30M: [900, 999] as [number, number], drop100M: [900, 999] as [number, number], crossSlopeDeg: [80, 89] as [number, number] };
    expect(score(walked, lenient).summary.level).toBe("green");
    expect(score(walked, lenient, { walkParams: DEFAULT_PARAMS }).summary.level).toBe("red");
  });
});

describe("route lines that stray from the map", () => {
  const slope = measure(ground((x) => 1000 - x), northbound(0), identity, {
    // A mapped track exists only along the first half of the line.
    context: { inForest: () => false, cliffNear: () => false, pathAt: (_x, y) => (y < 0 ? { tunnel: false, bridge: false, wide: false, sacGrade: null, aided: false, rack: false, funicular: false } : null) },
  });
  const asLeg = (mode: "rail" | "hike") => ({ ...slope, profile: "road" as const, legs: [{ mode, label: "x", startM: 0, endM: 400 }] });

  it("leaves a train's unmatched stretch unscored instead of rating the terrain under it", () => {
    const analysis = score(asLeg("rail"), DEFAULT_PARAMS);
    expect(analysis.points[10].score).toBeGreaterThan(50);
    expect(analysis.points[60].score).toBeNull();
    expect(analysis.summary.noDataM).toBeGreaterThan(150);
  });

  it("still scores an unmapped stretch on foot", () => {
    expect(score(asLeg("hike"), DEFAULT_PARAMS).points[60].score).toBeGreaterThan(50);
  });
});

describe("which side the drop is on", () => {
  // Reversals are found from real coordinates, so this test places its metres on the globe.
  const scaleX = 111_320 * Math.cos((47 * Math.PI) / 180);
  const globe: Projection = {
    name: "test",
    forward: (lon, lat) => [(lon - 9) * scaleX, (lat - 47) * 111_320],
    inverse: (x, y) => [9 + x / scaleX, 47 + y / 111_320],
  };
  const ride = (terrain: Terrain, track = northbound(0)) => ({
    ...measure(terrain, track, globe),
    profile: "road" as const,
    legs: [{ mode: "rail" as const, label: "Train", startM: 0, endM: track[track.length - 1].dist }],
  });
  const sides = (terrain: Terrain, track?: ReturnType<typeof northbound>) => score(ride(terrain, track)).legs[0].sides!;

  it("measures drops for each side on its own", () => {
    // Heading north with the ground falling away to the east: all of it on the right.
    const m = middle(measureTrack(ground((x) => 1000 - Math.max(0, x)), northbound(0)))!;
    expect(m.dropRight100).toBeCloseTo(100, 0);
    expect(m.dropLeft100).toBe(0);
    expect(m.dropRight10).toBeCloseTo(10, 0);
    expect(m.dropLeft10).toBe(0);
  });

  it("recommends the side away from the drop", () => {
    const [summary] = sides(ground((x) => 1000 - Math.max(0, x)));
    expect(summary.rightM).toBeGreaterThan(300);
    expect(summary.leftM).toBe(0);
    expect(summary.sit).toBe("left");
    // The same ground travelled the other way has the drop on the left.
    expect(sides(ground((x) => 1000 - Math.max(0, x)), resample([[0, 200], [0, -200]], 5))[0].sit).toBe("right");
  });

  it("has no better side on a ridge, and no preference on flat ground", () => {
    const ridge = sides(ground((x) => 1000 - Math.abs(x)))[0];
    expect(ridge.bothM).toBeGreaterThan(300);
    expect(ridge.sit).toBe("none");
    expect(sides(ground(() => 1000))[0]).toMatchObject({ leftM: 0, rightM: 0, bothM: 0, sit: "either" });
  });

  it("starts a new stretch where a train reverses", () => {
    // In to a terminus heading north, then back out heading south on the next track over.
    const terminus = [...resample([[0, -600], [0, 0]], 5), ...resample([[4, 0], [4, -600]], 5)].map((p, i) => ({ ...p, dist: i * 5 }));
    const result = sides(ground((x) => 1000 - Math.max(0, x - 2)), terminus);
    expect(result).toHaveLength(2);
    expect(Math.abs(result[0].endM - 600)).toBeLessThan(250);
    // The drop lies to the east throughout: on the right going in, on the left coming out.
    expect(result[0].sit).toBe("left");
    expect(result[1].sit).toBe("right");
  });

  it("does not take a horseshoe curve for a reversal", () => {
    // North, round a half circle of 60 m radius, and back south 120 m further east.
    const curve = Array.from({ length: 19 }, (_, k): [number, number] => {
      const angle = Math.PI - (k / 18) * Math.PI;
      return [60 + 60 * Math.cos(angle), 60 * Math.sin(angle)];
    });
    const horseshoe = resample([[0, -400], ...curve, [120, -400]], 5);
    expect(sides(ground(() => 1000), horseshoe)).toHaveLength(1);
  });

  it("gives no side advice for stretches on foot", () => {
    expect(score(measure(ground((x) => 1000 - x), northbound(0), identity)).legs[0].sides).toBeUndefined();
  });
});
