import fs from "node:fs";
import path from "node:path";
import { fromUrl, type GeoTIFF, type GeoTIFFImage } from "geotiff";
import proj4 from "proj4";
import { config } from "../config.js";
import type { Projection } from "../geo/projection.js";
import { logger } from "../logger.js";
import { bilinear, GridTerrain, type Terrain } from "./grid.js";

// USGS 3DEP 1 m lidar elevation model: 10 km tiles in NAD83 / UTM, published
// per lidar project as Cloud-Optimized GeoTIFFs. Each file carries a 2 m
// level, which is read piecewise by HTTP range requests so the whole file
// (hundreds of MB) is never downloaded. Projects overlap; the newest wins.
const TNM_PRODUCTS = "https://tnmaccess.nationalmap.gov/api/v1/products";
const DATASET = "Digital Elevation Model (DEM) 1 meter";
const TNM_PAGE = 200;
const CELL_M = 2;
/** Cached blocks are this many 2 m cells square, i.e. 1 km. */
const BLOCK_CELLS = 500;
/** Tile lookups are cached in cells of this many degrees. */
const INDEX_CELL_DEG = 0.05;
const DOWNLOAD_CONCURRENCY = 6;
/** Attempts per block; range requests over a long route now and then drop a connection. */
const BLOCK_ATTEMPTS = 3;
/** Every this many cells of a block are checked when deciding whether a better tile already covers it. */
const COVER_STEP = 10;
/** Routes whose terrain grid would exceed this many cells are left to the global tiles. */
const MAX_GRID_CELLS = 12_000_000;

const rootDir = path.join(config.demDir, "usgs-1m");
const indexDir = path.join(rootDir, "index");

/** One published 1 m tile, as the product search lists it. */
export interface UsgsTile {
  url: string;
  /** e.g. "x32y413": the tile's place in the 10 km grid of its UTM zone. */
  tileId: string;
  project: string;
  year: number;
  /** Lidar quality level, lower is better; absent from newer names. */
  ql: number | null;
  /** [west, south, east, north] in degrees. */
  bbox: [number, number, number, number];
}

/** Where a tile's 2 m level sits in its UTM zone, read once from the file. */
export interface TileMeta {
  /** proj4 definition of the tile's UTM zone. */
  crs: string;
  /** Outer corner of the top-left 2 m cell. */
  originX: number;
  originY: number;
  width: number;
  height: number;
  /** Index of the 2 m overview, or null when the base image has to be averaged down. */
  level: number | null;
}

interface TnmItem {
  title?: string;
  downloadURL?: string;
  boundingBox?: { minX: number; minY: number; maxX: number; maxY: number };
}

/** Reads one product search result; null for anything that is not a usable tile. */
export function parseTile(item: TnmItem): UsgsTile | null {
  const url = item.downloadURL;
  const box = item.boundingBox;
  if (!url || !box || !url.toLowerCase().endsWith(".tif")) return null;
  const project = /\/Projects\/([^/]+)\//.exec(url)?.[1];
  const tileId = /_(x\d+y\d+)_/.exec(url)?.[1];
  if (!project || !tileId) return null;
  const year = Number(/(?:^|_)((?:19|20)\d{2})(?:_|$)/.exec(project)?.[1] ?? /((?:19|20)\d{2})/.exec(project)?.[1] ?? 0);
  const ql = /(?:^|_)QL(\d)(?:_|$)/.exec(project)?.[1];
  return { url, tileId, project, year, ql: ql === undefined ? null : Number(ql), bbox: [box.minX, box.minY, box.maxX, box.maxY] };
}

/** Preference among overlapping tiles: newest survey first, then the better quality level. */
export function orderTiles(tiles: UsgsTile[]): UsgsTile[] {
  return [...tiles].sort((a, b) => b.year - a.year || (a.ql ?? 9) - (b.ql ?? 9) || a.url.localeCompare(b.url));
}

/** The 2 m cell window [left, top, right, bottom] of a block, clipped to the image. */
export function blockWindow(meta: TileMeta, bx: number, by: number): [number, number, number, number] {
  return [
    bx * BLOCK_CELLS,
    by * BLOCK_CELLS,
    Math.min((bx + 1) * BLOCK_CELLS, meta.width),
    Math.min((by + 1) * BLOCK_CELLS, meta.height),
  ];
}

/** Block indexes [bx0, by0, bx1, by1] covering a UTM rectangle, clipped to the image; null if outside it. */
export function blockRange(meta: TileMeta, minE: number, minN: number, maxE: number, maxN: number): [number, number, number, number] | null {
  const col0 = Math.max(0, Math.floor((minE - meta.originX) / CELL_M) - 1);
  const col1 = Math.min(meta.width - 1, Math.floor((maxE - meta.originX) / CELL_M) + 1);
  const row0 = Math.max(0, Math.floor((meta.originY - maxN) / CELL_M) - 1);
  const row1 = Math.min(meta.height - 1, Math.floor((meta.originY - minN) / CELL_M) + 1);
  if (col0 > col1 || row0 > row1) return null;
  return [Math.floor(col0 / BLOCK_CELLS), Math.floor(row0 / BLOCK_CELLS), Math.floor(col1 / BLOCK_CELLS), Math.floor(row1 / BLOCK_CELLS)];
}

/** Elevation lookup in one tile's UTM coordinates, over the blocks that were loaded. */
export class TileSampler {
  constructor(
    readonly meta: TileMeta,
    private readonly blocks: Map<string, Float32Array>,
  ) {}

  private cell(col: number, row: number): number {
    if (col < 0 || row < 0 || col >= this.meta.width || row >= this.meta.height) return Number.NaN;
    const bx = Math.floor(col / BLOCK_CELLS);
    const by = Math.floor(row / BLOCK_CELLS);
    const block = this.blocks.get(`${bx}-${by}`);
    if (!block) return Number.NaN;
    const [left, top, right] = blockWindow(this.meta, bx, by);
    return block[(row - top) * (right - left) + (col - left)];
  }

  elevation(e: number, n: number): number {
    const fx = (e - this.meta.originX) / CELL_M - 0.5;
    const fy = (this.meta.originY - n) / CELL_M - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    return bilinear(
      this.cell(x0, y0),
      this.cell(x0 + 1, y0),
      this.cell(x0, y0 + 1),
      this.cell(x0 + 1, y0 + 1),
      fx - x0,
      fy - y0,
    );
  }
}

/**
 * Resamples tiles onto a north-up 2 m grid in the route's projection. Each
 * cell takes the first tile, in the order given, that has data there, so the
 * ragged edge of one project falls through to the next.
 */
export function resampleTiles(
  samplers: TileSampler[],
  projection: Projection,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
): GridTerrain {
  const { minX, minY, maxX, maxY } = bounds;
  const width = Math.ceil((maxX - minX) / CELL_M);
  const height = Math.ceil((maxY - minY) / CELL_M);
  const data = new Float32Array(width * height).fill(Number.NaN);
  const converters = new Map<string, proj4.Converter>();
  const toTile = samplers.map(({ meta }) => {
    if (!converters.has(meta.crs)) converters.set(meta.crs, proj4("WGS84", meta.crs));
    return converters.get(meta.crs)!;
  });
  for (let row = 0; row < height; row++) {
    const y = maxY - (row + 0.5) * CELL_M;
    for (let col = 0; col < width; col++) {
      const lonLat = projection.inverse(minX + (col + 0.5) * CELL_M, y);
      for (const [i, sampler] of samplers.entries()) {
        const [e, n] = toTile[i].forward(lonLat) as [number, number];
        const z = sampler.elevation(e, n);
        if (!Number.isNaN(z)) {
          data[row * width + col] = z;
          break;
        }
      }
    }
  }
  return new GridTerrain("USGS 3DEP lidar 2 m (USGS)", CELL_M, minX, maxY, width, height, data);
}

const indexKey = (lon: number, lat: number) => `${Math.floor(lon / INDEX_CELL_DEG)}_${Math.floor(lat / INDEX_CELL_DEG)}`;

const intersects = (a: [number, number, number, number], b: [number, number, number, number]) =>
  a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

async function searchTiles(bbox: [number, number, number, number]): Promise<UsgsTile[]> {
  const tiles: UsgsTile[] = [];
  for (let offset = 0; ; offset += TNM_PAGE) {
    const params = new URLSearchParams({
      datasets: DATASET,
      bbox: bbox.map((v) => v.toFixed(5)).join(","),
      max: String(TNM_PAGE),
      offset: String(offset),
      outputFormat: "JSON",
    });
    const res = await fetch(`${TNM_PRODUCTS}?${params}`, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`USGS product search failed: ${res.status} ${res.statusText}`);
    const page = (await res.json()) as { total?: number; items?: TnmItem[] };
    const items = page.items ?? [];
    for (const item of items) {
      const tile = parseTile(item);
      if (tile) tiles.push(tile);
    }
    if (items.length < TNM_PAGE || offset + items.length >= (page.total ?? 0)) return tiles;
  }
}

/** The tiles touching a lon/lat box, from the on-disk index where it has been asked before. */
async function tilesFor(bbox: [number, number, number, number]): Promise<UsgsTile[]> {
  fs.mkdirSync(indexDir, { recursive: true });
  const cells: Array<{ key: string; box: [number, number, number, number] }> = [];
  for (let i = Math.floor(bbox[0] / INDEX_CELL_DEG); i <= Math.floor(bbox[2] / INDEX_CELL_DEG); i++) {
    for (let j = Math.floor(bbox[1] / INDEX_CELL_DEG); j <= Math.floor(bbox[3] / INDEX_CELL_DEG); j++) {
      const box: [number, number, number, number] = [i * INDEX_CELL_DEG, j * INDEX_CELL_DEG, (i + 1) * INDEX_CELL_DEG, (j + 1) * INDEX_CELL_DEG];
      cells.push({ key: indexKey(box[0] + INDEX_CELL_DEG / 2, box[1] + INDEX_CELL_DEG / 2), box });
    }
  }
  const fileFor = (key: string) => path.join(indexDir, `${key}.json`);
  const unknown = cells.filter(({ key }) => !fs.existsSync(fileFor(key)));
  if (unknown.length > 0) {
    // Asked as one box; a failed search throws before anything is cached, so it is asked again next time.
    const found = await searchTiles([
      Math.min(...unknown.map((c) => c.box[0])),
      Math.min(...unknown.map((c) => c.box[1])),
      Math.max(...unknown.map((c) => c.box[2])),
      Math.max(...unknown.map((c) => c.box[3])),
    ]);
    for (const { key, box } of unknown) {
      fs.writeFileSync(fileFor(key), JSON.stringify(found.filter((t) => intersects(t.bbox, box))));
    }
  }
  const byUrl = new Map<string, UsgsTile>();
  for (const { key } of cells) {
    for (const tile of JSON.parse(fs.readFileSync(fileFor(key), "utf-8")) as UsgsTile[]) {
      if (intersects(tile.bbox, bbox)) byUrl.set(tile.url, tile);
    }
  }
  return orderTiles([...byUrl.values()]);
}

const tileDir = (tile: UsgsTile) => path.join(rootDir, tile.project, tile.tileId);

/** The tile's UTM zone, as proj4 understands it; null for a grid this loader does not know. */
function crsOf(image: GeoTIFFImage): string | null {
  const code = image.getGeoKeys()?.ProjectedCSTypeGeoKey as number | undefined;
  if (code && code > 26900 && code <= 26923) return `+proj=utm +zone=${code - 26900} +datum=NAD83 +units=m +no_defs`;
  if (code && code > 32600 && code <= 32660) return `+proj=utm +zone=${code - 32600} +datum=WGS84 +units=m +no_defs`;
  return null;
}

async function readMeta(tiff: GeoTIFF, tile: UsgsTile): Promise<TileMeta | null> {
  const base = await tiff.getImage(0);
  const crs = crsOf(base);
  const [resX] = base.getResolution();
  if (!crs || Math.abs(resX - 1) > 0.01) {
    logger.warn({ url: tile.url }, "skipping a USGS tile in an unexpected grid");
    return null;
  }
  const [originX, originY] = base.getOrigin();
  let level: number | null = null;
  const count = await tiff.getImageCount();
  for (let i = 1; i < count; i++) {
    const image = await tiff.getImage(i);
    if (Math.abs(base.getWidth() / image.getWidth() - CELL_M) < 0.01) level = i;
  }
  return { crs, originX, originY, width: Math.floor(base.getWidth() / CELL_M), height: Math.floor(base.getHeight() / CELL_M), level };
}

/** Reads one block at 2 m: from the overview if the file has one, otherwise averaging the 1 m base. */
async function readBlock(tiff: GeoTIFF, meta: TileMeta, bx: number, by: number): Promise<Float32Array> {
  const [left, top, right, bottom] = blockWindow(meta, bx, by);
  const w = right - left;
  const h = bottom - top;
  const out = new Float32Array(w * h);
  const valid = (v: number) => (v < -1000 || !Number.isFinite(v) ? Number.NaN : v);
  if (meta.level !== null) {
    const image = await tiff.getImage(meta.level);
    const [raster] = (await image.readRasters({ window: [left, top, right, bottom] })) as unknown as Array<ArrayLike<number>>;
    for (let i = 0; i < out.length; i++) out[i] = valid(raster[i]);
    return out;
  }
  const image = await tiff.getImage(0);
  const [raster] = (await image.readRasters({ window: [left * 2, top * 2, right * 2, bottom * 2] })) as unknown as Array<ArrayLike<number>>;
  const rw = w * 2;
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const i = r * 2 * rw + c * 2;
      out[r * w + c] = (valid(raster[i]) + valid(raster[i + 1]) + valid(raster[i + rw]) + valid(raster[i + rw + 1])) / 4;
    }
  }
  return out;
}

async function readBlockRetrying(tiff: GeoTIFF, meta: TileMeta, bx: number, by: number): Promise<Float32Array> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await readBlock(tiff, meta, bx, by);
    } catch (err) {
      if (attempt >= BLOCK_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
}

/** The 2 m cell window [left, top, right, bottom] of a tile that the piece's UTM outline spans. */
function utmWindow(meta: TileMeta, utm: Array<[number, number]>): [number, number, number, number] {
  return [
    Math.floor((Math.min(...utm.map((p) => p[0])) - meta.originX) / CELL_M),
    Math.floor((meta.originY - Math.max(...utm.map((p) => p[1]))) / CELL_M),
    Math.ceil((Math.max(...utm.map((p) => p[0])) - meta.originX) / CELL_M),
    Math.ceil((meta.originY - Math.min(...utm.map((p) => p[1]))) / CELL_M),
  ];
}

/** Whether better tiles already have data across the part of a block the piece needs, checked on a sparse lattice. */
function coveredByBetter(
  meta: TileMeta,
  toTile: proj4.Converter,
  bx: number,
  by: number,
  needed: [number, number, number, number],
  better: Array<{ sampler: TileSampler; converter: proj4.Converter }>,
): boolean {
  const [left, top, right, bottom] = blockWindow(meta, bx, by);
  for (let row = Math.max(top, needed[1]); row < Math.min(bottom, needed[3]); row += COVER_STEP) {
    for (let col = Math.max(left, needed[0]); col < Math.min(right, needed[2]); col += COVER_STEP) {
      const lonLat = toTile.inverse([meta.originX + (col + 0.5) * CELL_M, meta.originY - (row + 0.5) * CELL_M]) as [number, number];
      const has = better.some(({ sampler, converter }) => {
        const [e, n] = converter.forward(lonLat) as [number, number];
        return !Number.isNaN(sampler.elevation(e, n));
      });
      if (!has) return false;
    }
  }
  return true;
}

/** A cached block; null for one remembered as having no data. */
function readCachedBlock(file: string): Float32Array | null {
  const buffer = fs.readFileSync(file);
  if (buffer.byteLength === 0) return null;
  return new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}

/**
 * Loads USGS lidar terrain around a route, fetching the blocks that are not
 * cached yet. Ground no published tile covers is NaN. Throws when the USGS
 * servers cannot be reached, so the caller can fall back to the global tiles.
 */
export async function loadUsgsTerrain(points: Array<[number, number]>, projection: Projection, buffer: number): Promise<Terrain> {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x - buffer);
    minY = Math.min(minY, y - buffer);
    maxX = Math.max(maxX, x + buffer);
    maxY = Math.max(maxY, y + buffer);
  }
  const bounds = { minX, minY, maxX, maxY };
  if (((maxX - minX) / CELL_M) * ((maxY - minY) / CELL_M) > MAX_GRID_CELLS) {
    throw new Error("Route piece covers too large an area for lidar terrain");
  }
  // The outline of the box, in degrees, with points along each edge for the curvature of the projection.
  const outline: Array<[number, number]> = [];
  for (let t = 0; t <= 1; t += 0.25) {
    outline.push(
      projection.inverse(minX + (maxX - minX) * t, minY),
      projection.inverse(minX + (maxX - minX) * t, maxY),
      projection.inverse(minX, minY + (maxY - minY) * t),
      projection.inverse(maxX, minY + (maxY - minY) * t),
    );
  }
  const lonLatBox: [number, number, number, number] = [
    Math.min(...outline.map((p) => p[0])),
    Math.min(...outline.map((p) => p[1])),
    Math.max(...outline.map((p) => p[0])),
    Math.max(...outline.map((p) => p[1])),
  ];
  const tiles = await tilesFor(lonLatBox);

  const tiffs = new Map<string, Promise<GeoTIFF>>();
  const open = (tile: UsgsTile) => {
    if (!tiffs.has(tile.url)) tiffs.set(tile.url, fromUrl(tile.url));
    return tiffs.get(tile.url)!;
  };

  // Tiles are loaded best first, so where a better one already has the ground,
  // the blocks of the overlapping ones need not be downloaded.
  const samplers: TileSampler[] = [];
  const better: Array<{ sampler: TileSampler; converter: proj4.Converter }> = [];
  for (const tile of tiles) {
    const dir = tileDir(tile);
    const metaFile = path.join(dir, "meta.json");
    let meta: TileMeta | null;
    if (fs.existsSync(metaFile)) {
      meta = JSON.parse(fs.readFileSync(metaFile, "utf-8")) as TileMeta | null;
    } else {
      meta = await readMeta(await open(tile), tile);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(metaFile, JSON.stringify(meta));
    }
    if (!meta) continue;

    const toTile = proj4("WGS84", meta.crs);
    const utm = outline.map((p) => toTile.forward(p) as [number, number]);
    const range = blockRange(
      meta,
      Math.min(...utm.map((p) => p[0])),
      Math.min(...utm.map((p) => p[1])),
      Math.max(...utm.map((p) => p[0])),
      Math.max(...utm.map((p) => p[1])),
    );
    if (!range) continue;
    const tileMeta = meta;
    const blocks = new Map<string, Float32Array>();
    const jobs: Array<() => Promise<void>> = [];
    const window = utmWindow(meta, utm);
    for (let by = range[1]; by <= range[3]; by++) {
      for (let bx = range[0]; bx <= range[2]; bx++) {
        const key = `${bx}-${by}`;
        const file = path.join(dir, `${key}.f32`);
        if (fs.existsSync(file)) {
          const cached = readCachedBlock(file);
          if (cached) blocks.set(key, cached);
          continue;
        }
        if (better.length > 0 && coveredByBetter(meta, toTile, bx, by, window, better)) continue;
        jobs.push(async () => {
          const block = await readBlockRetrying(await open(tile), tileMeta, bx, by);
          // A block the survey did not reach is remembered as an empty file rather than 1 MB of nothing.
          const empty = block.every(Number.isNaN);
          fs.writeFileSync(`${file}.part`, empty ? Buffer.alloc(0) : Buffer.from(block.buffer));
          fs.renameSync(`${file}.part`, file);
          if (!empty) blocks.set(key, block);
        });
      }
    }
    if (jobs.length > 0) {
      logger.info({ blocks: jobs.length, tile: `${tile.project} ${tile.tileId}` }, "downloading USGS lidar terrain");
      const workers = Array.from({ length: DOWNLOAD_CONCURRENCY }, async () => {
        for (let job = jobs.pop(); job !== undefined; job = jobs.pop()) await job();
      });
      await Promise.all(workers);
    }
    const sampler = new TileSampler(meta, blocks);
    samplers.push(sampler);
    better.push({ sampler, converter: toTile });
  }
  return resampleTiles(samplers, projection, bounds);
}
