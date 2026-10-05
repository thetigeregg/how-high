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

/** Radius around the line within which ways are fetched, metres. */
const AROUND_M = 60;

/**
 * Ways are fetched only along the line (a bounding box of a long drive would
 * pull in every street of every town it passes). Forest has to come by
 * bounding box: a path deep inside a large wood is nowhere near its outline.
 */
function query(line: Array<[number, number]>, bbox: [number, number, number, number]): string {
  const around = `around:${AROUND_M},${line.map(([lon, lat]) => `${lat.toFixed(5)},${lon.toFixed(5)}`).join(",")}`;
  const [west, south, east, north] = bbox.map((v) => v.toFixed(4));
  const box = `${south},${west},${north},${east}`;
  return `[out:json][timeout:25];
(
  way(${around})[highway];
  way(${around})[railway~"^(rail|narrow_gauge|light_rail|tram|funicular|subway)$"];
  way(${around})[natural=cliff];
  way[landuse=forest](${box});
  way[natural=wood](${box});
  relation[landuse=forest](${box});
  relation[natural=wood](${box});
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
 * Paths, roads, railways and cliffs along a lon/lat line, plus forest inside
 * the bounding box (west, south, east, north) around it. Throws when no
 * Overpass instance answers; callers treat context as optional.
 *
 * Normally the instances are tried one after another with a generous
 * timeout. In quick mode all are asked at once and the first answer within a
 * few seconds wins, so an upload is never held up for long.
 */
export async function fetchOsm(
  line: Array<[number, number]>,
  bbox: [number, number, number, number],
  quick = false,
): Promise<OsmElement[]> {
  const data = query(line, bbox);
  const file = path.join(cacheDir, `${createHash("sha1").update(data).digest("hex")}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf-8")) as OsmElement[];

  const body = new URLSearchParams({ data });
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
