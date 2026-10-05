import { describe, expect, it } from "vitest";
import { GridTerrain } from "../terrain/grid.js";
import { parseGpx } from "./parse.js";
import { resample } from "./resample.js";

describe("parseGpx", () => {
  it("joins track segments and reads the name", () => {
    const gpx = parseGpx(`<?xml version="1.0"?><gpx><trk><name>Test</name>
      <trkseg><trkpt lat="46.1" lon="7.1"/><trkpt lat="46.2" lon="7.2"><ele>900</ele></trkpt></trkseg>
      <trkseg><trkpt lat="46.3" lon="7.3"/></trkseg></trk></gpx>`);
    expect(gpx.name).toBe("Test");
    expect(gpx.points).toEqual([{ lat: 46.1, lon: 7.1 }, { lat: 46.2, lon: 7.2 }, { lat: 46.3, lon: 7.3 }]);
  });

  it("falls back to route points", () => {
    const gpx = parseGpx(`<gpx><rte><rtept lat="46.1" lon="7.1"/><rtept lat="46.2" lon="7.2"/></rte></gpx>`);
    expect(gpx.points).toHaveLength(2);
  });

  it("rejects files without a usable line", () => {
    expect(() => parseGpx("<gpx><wpt lat='1' lon='1'/></gpx>")).toThrow(/no track or route/);
    expect(() => parseGpx("<html/>")).toThrow(/Not a GPX/);
  });
});

describe("resample", () => {
  it("spaces points evenly around a corner and tracks the heading", () => {
    const track = resample([[0, 0], [0, 0], [100, 0], [100, 100]], 5);
    expect(track).toHaveLength(41);
    expect(track[20]).toMatchObject({ x: 100, y: 0, dist: 100 });
    expect(track[5].tx).toBeCloseTo(1);
    expect(track[35].ty).toBeCloseTo(1);
  });
});

describe("GridTerrain", () => {
  it("interpolates between cell centres and returns NaN outside", () => {
    // 3x2 grid of 10 m cells, top-left corner at (0, 20); values rise eastwards.
    const grid = new GridTerrain("t", 10, 0, 20, 3, 2, Float32Array.from([0, 10, 20, 0, 10, 20]));
    expect(grid.elevation(5, 15)).toBeCloseTo(0);
    expect(grid.elevation(10, 10)).toBeCloseTo(5);
    expect(grid.elevation(20, 10)).toBeCloseTo(15);
    expect(grid.elevation(-1, 10)).toBeNaN();
  });
});
