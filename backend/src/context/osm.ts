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
const TIMEOUT_MS = 60_000;
/** Total wait in quick mode, where someone is watching an upload. */
const QUICK_TIMEOUT_MS = 12_000;

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

async function ask(endpoint: string, body: URLSearchParams, timeoutMs: number): Promise<OsmElement[]> {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "User-Agent": USER_AGENT },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return ((await res.json()) as { elements: OsmElement[] }).elements;
  } catch (err) {
    logger.warn({ endpoint, err: (err as Error).message }, "Overpass request failed");
    throw err;
  }
}

/**
 * Paths, forest and cliffs inside a lon/lat bounding box (west, south, east,
 * north). Throws when no Overpass instance answers; callers treat context as
 * optional.
 *
 * Normally the instances are tried one after another with a generous
 * timeout. In quick mode all are asked at once and the first answer within a
 * few seconds wins, so an upload is never held up for long.
 */
export async function fetchOsm(bbox: [number, number, number, number], quick = false): Promise<OsmElement[]> {
  const rounded = bbox.map((v) => v.toFixed(4)).join(",");
  const file = path.join(cacheDir, `${createHash("sha1").update(rounded).digest("hex")}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf-8")) as OsmElement[];

  const body = new URLSearchParams({ data: query(bbox) });
  let elements: OsmElement[] | undefined;
  if (quick) {
    elements = await Promise.any(ENDPOINTS.map((endpoint) => ask(endpoint, body, QUICK_TIMEOUT_MS))).catch(() => undefined);
  } else {
    for (const endpoint of ENDPOINTS) {
      elements = await ask(endpoint, body, TIMEOUT_MS).catch(() => undefined);
      if (elements) break;
    }
  }
  if (!elements) throw new Error("OpenStreetMap data unavailable");
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(elements));
  return elements;
}
