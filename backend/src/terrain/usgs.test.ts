import { afterEach, describe, expect, it, vi } from "vitest";
import { blockRange, blockWindow, orderTiles, parseTile, resampleTiles, searchPage, TileSampler, type TileMeta, type UsgsTile } from "./usgs.js";

const S3 = "https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1m/Projects";
const item = (project: string, file: string) => ({
  title: "",
  downloadURL: `${S3}/${project}/TIFF/${file}`,
  boundingBox: { minX: -113.03, minY: 37.21, maxX: -112.92, maxY: 37.3 },
});

// The Zion tile x32y413: 10012 1 m cells from (319994, 4130006) in UTM zone 12.
const ZION: TileMeta = {
  crs: "+proj=utm +zone=12 +datum=NAD83 +units=m +no_defs",
  originX: 319994,
  originY: 4130006,
  width: 5006,
  height: 5006,
  level: 1,
};

describe("parseTile", () => {
  it("reads both naming schemes", () => {
    expect(parseTile(item("UT_ZionNP_QL1_2016", "USGS_one_meter_x32y413_UT_ZionNP_QL1_2016.tif"))).toMatchObject({
      tileId: "x32y413",
      project: "UT_ZionNP_QL1_2016",
      year: 2016,
      ql: 1,
    });
    expect(parseTile(item("CO_DRCOG_2020_B20", "USGS_1M_13_x44y446_CO_DRCOG_2020_B20.tif"))).toMatchObject({
      tileId: "x44y446",
      project: "CO_DRCOG_2020_B20",
      year: 2020,
      ql: null,
    });
  });

  it("skips anything that is not a tile", () => {
    expect(parseTile({ title: "x", downloadURL: `${S3}/X_2020/metadata/x32y413.xml`, boundingBox: item("a", "b").boundingBox })).toBeNull();
    expect(parseTile({ downloadURL: `${S3}/X_2020/TIFF/USGS_1M_13_x44y446_X_2020.tif` })).toBeNull();
  });
});

describe("orderTiles", () => {
  it("puts the newest survey first, then the better quality level", () => {
    const tile = (project: string, year: number, ql: number | null): UsgsTile => ({ url: project, tileId: "x1y1", project, year, ql, bbox: [0, 0, 1, 1] });
    const ordered = orderTiles([tile("old", 2013, 1), tile("ql2", 2016, 2), tile("ql1", 2016, 1), tile("new", 2021, null)]);
    expect(ordered.map((t) => t.project)).toEqual(["new", "ql1", "ql2", "old"]);
  });
});

describe("blocks", () => {
  it("clips the last block to the image", () => {
    expect(blockWindow(ZION, 0, 0)).toEqual([0, 0, 500, 500]);
    expect(blockWindow(ZION, 10, 10)).toEqual([5000, 5000, 5006, 5006]);
  });

  it("finds the blocks under a rectangle", () => {
    // 1 km east and 1 km south of the corner lies in block (1, 1).
    expect(blockRange(ZION, 321100, 4128800, 321200, 4128900)).toEqual([1, 1, 1, 1]);
    expect(blockRange(ZION, 300000, 4000000, 300100, 4000100)).toBeNull();
  });

  it("samples across block edges", () => {
    // A plane rising 1 m per meter eastward, split over two blocks.
    const plane = (bx: number): Float32Array => {
      const [left, top, right, bottom] = blockWindow(ZION, bx, 0);
      const out = new Float32Array((right - left) * (bottom - top));
      for (let r = 0; r < bottom - top; r++) for (let c = 0; c < right - left; c++) out[r * (right - left) + c] = (left + c + 0.5) * 2;
      return out;
    };
    const sampler = new TileSampler(ZION, new Map([["0-0", plane(0)], ["1-0", plane(1)]]));
    expect(sampler.elevation(ZION.originX + 1000, ZION.originY - 10)).toBeCloseTo(1000);
    expect(sampler.elevation(ZION.originX + 999, ZION.originY - 10)).toBeCloseTo(999);
    expect(sampler.elevation(ZION.originX + 1000, ZION.originY - 1100)).toBeNaN();
  });
});

describe("resampleTiles", () => {
  it("takes the next tile where the first has no data", () => {
    const meta: TileMeta = { crs: "+proj=longlat +datum=WGS84 +no_defs", originX: 0, originY: 0, width: 10, height: 10, level: 1 };
    const fill = (value: (col: number) => number) => {
      const out = new Float32Array(100);
      for (let i = 0; i < 100; i++) out[i] = value(i % 10);
      return out;
    };
    // The tiles are in plain lon/lat, which the identity projection passes straight through; the first covers x < 10.
    const first = new TileSampler({ ...meta, width: 5 }, new Map([["0-0", fill(() => 100)]]));
    const second = new TileSampler(meta, new Map([["0-0", fill(() => 200)]]));
    const identity = { name: "test", forward: (x: number, y: number): [number, number] => [x, y], inverse: (x: number, y: number): [number, number] => [x, y] };
    const grid = resampleTiles([first, second], identity, { minX: 0, minY: -20, maxX: 20, maxY: 0 });
    expect(grid.cellSize).toBe(2);
    expect(grid.elevation(1, -1)).toBe(100);
    expect(grid.elevation(13, -5)).toBe(200);
  });
});

describe("searchPage", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const answers = (...statuses: number[]) => {
    const fetch = vi.fn();
    for (const status of statuses) {
      fetch.mockResolvedValueOnce(new Response(JSON.stringify({ total: 0, items: [] }), { status, statusText: String(status) }));
    }
    vi.stubGlobal("fetch", fetch);
    return fetch;
  };

  it("asks again after a gateway timeout", async () => {
    vi.useFakeTimers();
    const fetch = answers(504, 200);
    const page = searchPage(new URLSearchParams());
    await vi.runAllTimersAsync();
    await expect(page).resolves.toEqual({ total: 0, items: [] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("gives up after three failures", async () => {
    vi.useFakeTimers();
    const fetch = answers(504, 503, 502);
    const page = searchPage(new URLSearchParams());
    const failed = expect(page).rejects.toThrow("USGS product search failed: 502");
    await vi.runAllTimersAsync();
    await failed;
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not ask again a request the service rejects", async () => {
    const fetch = answers(400);
    await expect(searchPage(new URLSearchParams())).rejects.toThrow("USGS product search failed: 400");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
