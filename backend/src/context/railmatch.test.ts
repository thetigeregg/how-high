import { describe, expect, it } from "vitest";
import type { GpxPoint } from "../gpx/parse.js";
import type { OsmElement } from "./context.js";
import { followTrack } from "./railmatch.js";

// A small flat world near 47°N: positions are given in km east and north of an origin.
const LAT0 = 47;
const LON0 = 9;
const at = (eastKm: number, northKm: number): GpxPoint => ({
  lat: LAT0 + (northKm * 1000) / 111_320,
  lon: LON0 + (eastKm * 1000) / (111_320 * Math.cos((LAT0 * Math.PI) / 180)),
});
/** A way through the given positions; each position is [node id, km east, km north]. */
const way = (...stops: Array<[number, number, number]>): OsmElement => ({
  type: "way",
  tags: { railway: "rail" },
  nodes: stops.map(([id]) => id),
  geometry: stops.map(([, east, north]) => at(east, north)),
});
const lengthKm = (line: GpxPoint[]) =>
  line.slice(1).reduce((sum, p, i) => sum + Math.hypot((p.lat - line[i].lat) * 111.32, (p.lon - line[i].lon) * 111.32 * Math.cos((LAT0 * Math.PI) / 180)), 0);

describe("followTrack", () => {
  // The sketch runs straight east for 10 km; the real track loops north on the way.
  const sketch = [at(0, 0), at(10, 0)];
  const looping = [way([1, 0, 0], [2, 3, 0], [3, 4, 1.5]), way([3, 4, 1.5], [4, 6, 1.5], [5, 7, 0], [6, 10, 0])];

  it("follows the mapped track between the two ends, loops and all", () => {
    const course = followTrack(sketch, looping)!;
    expect(course[0]).toEqual(at(0, 0));
    expect(course[course.length - 1]).toEqual(at(10, 0));
    expect(course).toContainEqual(at(4, 1.5));
    expect(lengthKm(course)).toBeCloseTo(3 + Math.hypot(1, 1.5) + 2 + Math.hypot(1, 1.5) + 3, 1);
  });

  it("prefers the line the sketch runs along over a shorter one elsewhere", () => {
    // The sketch bends north through (5, 4); a direct line along the bottom is shorter.
    const bent = [at(0, 0), at(5, 4), at(10, 0)];
    const direct = way([1, 0, 0], [9, 5, 0], [6, 10, 0]);
    const alongSketch = way([1, 0, 0], [7, 5, 4], [6, 10, 0]);
    const course = followTrack(bent, [direct, alongSketch])!;
    expect(course).toContainEqual(at(5, 4));
    expect(course).not.toContainEqual(at(5, 0));
  });

  it("gives up when the track does not connect the two ends", () => {
    expect(followTrack(sketch, [way([1, 0, 0], [2, 3, 0]), way([5, 7, 0], [6, 10, 0])])).toBeNull();
  });

  it("gives up when an end is nowhere near mapped track", () => {
    expect(followTrack([at(0, 2), at(10, 0)], looping)).toBeNull();
    expect(followTrack(sketch, [])).toBeNull();
  });

  it("gives up when the only connection is far longer than the ride could be", () => {
    const detour = way([1, 0, 0], [2, 0, 30], [3, 10, 30], [6, 10, 0]);
    expect(followTrack(sketch, [detour])).toBeNull();
  });
});
