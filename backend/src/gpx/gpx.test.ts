import { describe, expect, it } from "vitest";
import { GridTerrain } from "../terrain/grid.js";
import { parseGpx } from "./parse.js";
import { writeGpx } from "./write.js";
import { resample } from "./resample.js";

describe("parseGpx", () => {
  it("joins track segments and reads the name", () => {
    const gpx = parseGpx(`<?xml version="1.0"?><gpx><trk><name>Test</name>
      <trkseg><trkpt lat="46.1" lon="7.1"/><trkpt lat="46.2" lon="7.2"><ele>900</ele></trkpt></trkseg>
      <trkseg><trkpt lat="46.3" lon="7.3"/></trkseg></trk></gpx>`);
    expect(gpx.name).toBe("Test");
    expect(gpx.points).toEqual([{ lat: 46.1, lon: 7.1 }, { lat: 46.2, lon: 7.2 }, { lat: 46.3, lon: 7.3 }]);
  });

  it("treats an empty name as no name", () => {
    const points = `<trkseg><trkpt lat="46.1" lon="7.1"/><trkpt lat="46.2" lon="7.2"/></trkseg>`;
    expect(parseGpx(`<gpx><metadata><name /></metadata><trk>${points}</trk></gpx>`).name).toBeNull();
    expect(parseGpx(`<gpx><metadata><name>From metadata</name></metadata><trk><name/>${points}</trk></gpx>`).name).toBe(
      "From metadata",
    );
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
  it("interpolates between cell centers and returns NaN outside", () => {
    // 3x2 grid of 10 m cells, top-left corner at (0, 20); values rise eastwards.
    const grid = new GridTerrain("t", 10, 0, 20, 3, 2, Float32Array.from([0, 10, 20, 0, 10, 20]));
    expect(grid.elevation(5, 15)).toBeCloseTo(0);
    expect(grid.elevation(10, 10)).toBeCloseTo(5);
    expect(grid.elevation(20, 10)).toBeCloseTo(15);
    expect(grid.elevation(-1, 10)).toBeNaN();
  });
});

describe("writeGpx", () => {
  const point = (dist: number, lat: number, lon: number, elevation: number | null) => ({
    dist,
    lat,
    lon,
    heading: [0, 1] as [number, number],
    metrics: elevation === null ? null : ({ elevation } as never),
    shifted: [null, null] as [null, null],
    context: null,
  });
  const base = {
    name: null,
    lengthM: 20,
    spacingM: 10,
    terrain: { source: "t", cellSize: 2, confidence: "high" as const },
    swiss: true,
    mapContext: true,
    params: {} as never,
    points: [point(0, 47.1, 8.1, 500.26), point(10, 47.10009, 8.1, 501), point(20, 47.10018, 8.1, null)],
  };

  it("writes the measured line with elevations, readable as a GPX again", () => {
    const gpx = writeGpx(base, "A & B <walk>", "https://maps.app.goo.gl/x?a=1&b=2");
    expect(gpx).toContain("<name>A &amp; B &lt;walk&gt;</name>");
    expect(gpx).toContain('<link href="https://maps.app.goo.gl/x?a=1&amp;b=2">');
    expect(gpx).toContain('<trkpt lat="47.100000" lon="8.100000"><ele>500.3</ele></trkpt>');
    // A point with no terrain under it is still on the line, just without a height.
    expect(gpx).toContain('<trkpt lat="47.100180" lon="8.100000"></trkpt>');
    const read = parseGpx(gpx);
    expect(read.name).toBe("A & B <walk>");
    expect(read.points).toEqual([{ lat: 47.1, lon: 8.1 }, { lat: 47.10009, lon: 8.1 }, { lat: 47.10018, lon: 8.1 }]);
  });

  it("writes one track per leg of a route, named for the leg", () => {
    const gpx = writeGpx(
      { ...base, legs: [{ mode: "rail", label: "Train R16", startM: 0, endM: 10 }, { mode: "walk", label: "Walk", startM: 20, endM: 20 }] },
      "Chur to Arosa",
      null,
    );
    expect(gpx.match(/<trk>/g)).toHaveLength(2);
    expect(gpx).toContain("<name>1. Train R16</name>");
    expect(gpx).toContain("<name>2. Walk</name>");
    expect(gpx).not.toContain("<link");
    expect(parseGpx(gpx).points).toHaveLength(3);
  });
});
