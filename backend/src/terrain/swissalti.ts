import fs from "node:fs";
import path from "node:path";
import { fromArrayBuffer } from "geotiff";
import { config } from "../config.js";
import { lv95 } from "../geo/projection.js";
import { logger } from "../logger.js";
import { bilinear, type Terrain } from "./grid.js";

const STAC_ITEMS = "https://data.geo.admin.ch/api/stac/v1/collections/ch.swisstopo.swissalti3d/items";
const TILE_M = 1000;
const CELL_M = 2;
const TILE_CELLS = TILE_M / CELL_M;
const DOWNLOAD_CONCURRENCY = 6;

const tileDir = path.join(config.demDir, "swissalti3d-2m");

/** swissALTI3D 2 m tiles, keyed by the LV95 kilometer of their south-west corner. */
class SwissTerrain implements Terrain {
  readonly source = "swissALTI3D 2 m (swisstopo)";
  readonly cellSize = CELL_M;

  constructor(private readonly tiles: Map<string, Float32Array>) {}

  private cell(gx: number, gy: number): number {
    const kx = Math.floor(gx / TILE_CELLS);
    const ky = Math.floor(gy / TILE_CELLS);
    const tile = this.tiles.get(`${kx}-${ky}`);
    if (!tile) return Number.NaN;
    const col = gx - kx * TILE_CELLS;
    const row = TILE_CELLS - 1 - (gy - ky * TILE_CELLS);
    return tile[row * TILE_CELLS + col];
  }

  elevation(x: number, y: number): number {
    const fx = x / CELL_M - 0.5;
    const fy = y / CELL_M - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    // Rows run north-to-south inside a tile, but gy counts northwards here.
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

function neededTiles(points: Array<[number, number]>, buffer: number): Set<string> {
  const keys = new Set<string>();
  for (const [x, y] of points) {
    for (const dx of [-buffer, buffer]) {
      for (const dy of [-buffer, buffer]) {
        keys.add(`${Math.floor((x + dx) / TILE_M)}-${Math.floor((y + dy) / TILE_M)}`);
      }
    }
  }
  return keys;
}

/** Looks up the newest 2 m GeoTIFF for every tile intersecting the bbox. */
async function findTileUrls(bbox: [number, number, number, number]): Promise<Map<string, string>> {
  const newest = new Map<string, { year: number; href: string }>();
  let url: string | null = `${STAC_ITEMS}?bbox=${bbox.join(",")}&limit=100`;
  while (url) {
    const res: Response = await fetch(url);
    if (!res.ok) throw new Error(`swisstopo STAC request failed: ${res.status} ${res.statusText}`);
    const page = (await res.json()) as {
      features: Array<{ id: string; assets: Record<string, { href: string }> }>;
      links?: Array<{ rel: string; href: string }>;
    };
    for (const feature of page.features) {
      const match = /^swissalti3d_(\d{4})_(\d{4})-(\d{4})$/.exec(feature.id);
      if (!match) continue;
      const asset = Object.entries(feature.assets).find(([name]) => name.endsWith("_2_2056_5728.tif"));
      if (!asset) continue;
      const year = Number(match[1]);
      const key = `${Number(match[2])}-${Number(match[3])}`;
      const known = newest.get(key);
      if (!known || year > known.year) newest.set(key, { year, href: asset[1].href });
    }
    url = page.links?.find((link) => link.rel === "next")?.href ?? null;
  }
  return new Map([...newest].map(([key, { href }]) => [key, href]));
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  const tmp = `${dest}.part`;
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(tmp, dest);
}

async function readTile(file: string): Promise<Float32Array> {
  const buffer = fs.readFileSync(file);
  const tiff = await fromArrayBuffer(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  const image = await tiff.getImage();
  if (image.getWidth() !== TILE_CELLS || image.getHeight() !== TILE_CELLS) {
    throw new Error(`Unexpected swissALTI3D tile size in ${file}`);
  }
  const raster = (await image.readRasters({ interleave: true })) as unknown as ArrayLike<number>;
  const noData = image.getGDALNoData();
  const out = new Float32Array(raster.length);
  for (let i = 0; i < raster.length; i++) {
    out[i] = raster[i] === noData || raster[i] < -1000 ? Number.NaN : raster[i];
  }
  return out;
}

/**
 * Loads swissALTI3D around a route given in LV95, downloading tiles that are
 * not cached yet. Tiles swisstopo does not publish (abroad) are simply absent,
 * and the terrain returns NaN there.
 */
export async function loadSwissTerrain(points: Array<[number, number]>, buffer: number): Promise<Terrain> {
  fs.mkdirSync(tileDir, { recursive: true });
  const keys = neededTiles(points, buffer);
  const fileFor = (key: string) => path.join(tileDir, `${key}.tif`);
  // Tiles confirmed not to exist are remembered so border routes don't re-query.
  const missingFile = path.join(tileDir, "missing.json");
  const knownMissing = new Set<string>(
    fs.existsSync(missingFile) ? (JSON.parse(fs.readFileSync(missingFile, "utf-8")) as string[]) : [],
  );

  const toFetch = [...keys].filter((key) => !fs.existsSync(fileFor(key)) && !knownMissing.has(key));
  if (toFetch.length > 0) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const key of toFetch) {
      const [kx, ky] = key.split("-").map(Number);
      minX = Math.min(minX, kx * TILE_M);
      minY = Math.min(minY, ky * TILE_M);
      maxX = Math.max(maxX, (kx + 1) * TILE_M);
      maxY = Math.max(maxY, (ky + 1) * TILE_M);
    }
    const [west, south] = lv95.inverse(minX, minY);
    const [east, north] = lv95.inverse(maxX, maxY);
    const urls = await findTileUrls([west, south, east, north]);

    const queue = toFetch.filter((key) => urls.has(key));
    for (const key of toFetch) if (!urls.has(key)) knownMissing.add(key);
    fs.writeFileSync(missingFile, JSON.stringify([...knownMissing]));

    logger.info({ tiles: queue.length }, "downloading swissALTI3D tiles");
    const workers = Array.from({ length: DOWNLOAD_CONCURRENCY }, async () => {
      for (let key = queue.pop(); key !== undefined; key = queue.pop()) {
        await download(urls.get(key)!, fileFor(key));
      }
    });
    await Promise.all(workers);
  }

  const tiles = new Map<string, Float32Array>();
  for (const key of keys) {
    if (fs.existsSync(fileFor(key))) tiles.set(key, await readTile(fileFor(key)));
  }
  return new SwissTerrain(tiles);
}
