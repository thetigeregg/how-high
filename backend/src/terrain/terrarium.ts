import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { config } from "../config.js";
import type { Projection } from "../geo/projection.js";
import { logger } from "../logger.js";
import { bilinear, GridTerrain, type Terrain } from "./grid.js";

// Mapzen/AWS open terrain tiles: a global mosaic (3DEP ~10 m in the US,
// ~30 m SRTM-class data in most other places) encoded as RGB PNGs.
const TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";
const ZOOM = 14;
const TILE_PX = 256;
const WORLD_PX = TILE_PX * 2 ** ZOOM;
const CELL_M = 10;
const MAX_TILES = 900;
const DOWNLOAD_CONCURRENCY = 8;

const tileDir = path.join(config.demDir, "terrarium", String(ZOOM));

function toPixel(lon: number, lat: number): [number, number] {
  const sin = Math.sin((lat * Math.PI) / 180);
  const px = ((lon + 180) / 360) * WORLD_PX;
  const py = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * WORLD_PX;
  return [px, py];
}

async function loadTile(tx: number, ty: number): Promise<Float32Array> {
  const file = path.join(tileDir, String(tx), `${ty}.png`);
  if (!fs.existsSync(file)) {
    const res = await fetch(`${TILE_URL}/${ZOOM}/${tx}/${ty}.png`);
    if (!res.ok) throw new Error(`Terrain tile download failed (${res.status}) for ${ZOOM}/${tx}/${ty}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.part`, Buffer.from(await res.arrayBuffer()));
    fs.renameSync(`${file}.part`, file);
  }
  const png = PNG.sync.read(fs.readFileSync(file));
  const out = new Float32Array(TILE_PX * TILE_PX);
  for (let i = 0; i < out.length; i++) {
    out[i] = png.data[i * 4] * 256 + png.data[i * 4 + 1] + png.data[i * 4 + 2] / 256 - 32768;
  }
  return out;
}

/**
 * Global fallback terrain: fetches the tiles under the route and resamples
 * them onto a 10 m grid in the route's local metric projection.
 */
export async function loadTerrariumTerrain(
  points: Array<[number, number]>,
  projection: Projection,
  buffer: number,
): Promise<Terrain> {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  minX -= buffer;
  minY -= buffer;
  maxX += buffer;
  maxY += buffer;

  // Tile range from the four corners of the (slightly rotated) metric bbox.
  const corners = [
    projection.inverse(minX, minY),
    projection.inverse(minX, maxY),
    projection.inverse(maxX, minY),
    projection.inverse(maxX, maxY),
  ].map(([lon, lat]) => toPixel(lon, lat));
  const tx0 = Math.floor(Math.min(...corners.map((c) => c[0])) / TILE_PX) ;
  const tx1 = Math.floor(Math.max(...corners.map((c) => c[0])) / TILE_PX);
  const ty0 = Math.floor(Math.min(...corners.map((c) => c[1])) / TILE_PX);
  const ty1 = Math.floor(Math.max(...corners.map((c) => c[1])) / TILE_PX);
  const tilesX = tx1 - tx0 + 1;
  const tilesY = ty1 - ty0 + 1;
  if (tilesX * tilesY > MAX_TILES) {
    throw new Error(`Route covers too large an area for fallback terrain (${tilesX * tilesY} tiles)`);
  }

  logger.info({ tiles: tilesX * tilesY }, "loading global terrain tiles");
  const mosaicW = tilesX * TILE_PX;
  const mosaicH = tilesY * TILE_PX;
  const mosaic = new Float32Array(mosaicW * mosaicH);
  const jobs: Array<[number, number]> = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) jobs.push([tx, ty]);
  const workers = Array.from({ length: DOWNLOAD_CONCURRENCY }, async () => {
    for (let job = jobs.pop(); job !== undefined; job = jobs.pop()) {
      const [tx, ty] = job;
      const tile = await loadTile(tx, ty);
      for (let row = 0; row < TILE_PX; row++) {
        mosaic.set(
          tile.subarray(row * TILE_PX, (row + 1) * TILE_PX),
          ((ty - ty0) * TILE_PX + row) * mosaicW + (tx - tx0) * TILE_PX,
        );
      }
    }
  });
  await Promise.all(workers);

  const width = Math.ceil((maxX - minX) / CELL_M);
  const height = Math.ceil((maxY - minY) / CELL_M);
  const data = new Float32Array(width * height);
  for (let row = 0; row < height; row++) {
    const y = maxY - (row + 0.5) * CELL_M;
    for (let col = 0; col < width; col++) {
      const [lon, lat] = projection.inverse(minX + (col + 0.5) * CELL_M, y);
      const [px, py] = toPixel(lon, lat);
      const fx = px - tx0 * TILE_PX - 0.5;
      const fy = py - ty0 * TILE_PX - 0.5;
      const x0 = Math.min(Math.max(Math.floor(fx), 0), mosaicW - 2);
      const y0 = Math.min(Math.max(Math.floor(fy), 0), mosaicH - 2);
      const i = y0 * mosaicW + x0;
      data[row * width + col] = bilinear(
        mosaic[i],
        mosaic[i + 1],
        mosaic[i + mosaicW],
        mosaic[i + mosaicW + 1],
        fx - x0,
        fy - y0,
      );
    }
  }
  return new GridTerrain("AWS Terrain Tiles (~10–30 m, global)", CELL_M, minX, maxY, width, height, data);
}
