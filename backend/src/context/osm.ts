import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { OsmElement } from "./context.js";

// Public Overpass instances, tried in order. They are rate-limited and
// occasionally down, hence the fallback and the on-disk cache.
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
// The main instance rejects requests without an identifying user agent.
const USER_AGENT = "how-high/0.1 (self-hosted hike exposure analysis)";
// Kept short: an upload waits on this, and context is optional.
const TIMEOUT_MS = 30_000;

const cacheDir = path.join(config.dataDir, "osm");

function query([west, south, east, north]: [number, number, number, number]): string {
  return `[out:json][timeout:25][bbox:${south},${west},${north},${east}];
(
  way[highway];
  way[natural=cliff];
  way[landuse=forest];
  way[natural=wood];
  relation[landuse=forest];
  relation[natural=wood];
);
out tags geom;`;
}

/**
 * Paths, forest and cliffs inside a lon/lat bounding box (west, south, east,
 * north). Throws when no Overpass instance answers; callers treat context as
 * optional.
 */
export async function fetchOsm(bbox: [number, number, number, number]): Promise<OsmElement[]> {
  const rounded = bbox.map((v) => v.toFixed(4)).join(",");
  const file = path.join(cacheDir, `${createHash("sha1").update(rounded).digest("hex")}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf-8")) as OsmElement[];

  const body = new URLSearchParams({ data: query(bbox) });
  let lastError: unknown;
  for (const endpoint of ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "User-Agent": USER_AGENT },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { elements } = (await res.json()) as { elements: OsmElement[] };
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(elements));
      return elements;
    } catch (err) {
      lastError = err;
      logger.warn({ endpoint, err: (err as Error).message }, "Overpass request failed");
    }
  }
  throw new Error(`OpenStreetMap data unavailable: ${(lastError as Error).message}`);
}
