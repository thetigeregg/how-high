import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { OsmElement } from "./context.js";

// Public Overpass instances, tried in order. The worldwide ones are
// rate-limited and often overloaded, hence the fallbacks and the on-disk
// cache. The Swiss one is fast but only holds Switzerland.
const SWISS_ENDPOINT = "https://overpass.osm.ch/api/interpreter";
const WORLD_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
// The main instance rejects requests without an identifying user agent.
const USER_AGENT = "how-high/0.1 (self-hosted hike exposure analysis)";
const TIMEOUT_MS = 60_000;
/** Total wait in quick mode, where someone is watching an upload. */
const QUICK_TIMEOUT_MS = 12_000;

const cacheDir = path.join(config.dataDir, "osm");

/** Radius around the line within which ways are fetched, meters. */
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
out geom;`;
}

/**
 * Whether an answer covers the line at all. Any line worth asking about runs
 * on or beside some mapped way, so an answer without one means the server
 * does not hold this area (the Swiss instance, asked about ground abroad).
 */
const coversLine = (elements: OsmElement[]) => elements.some((e) => e.type === "way" && (e.tags?.highway || e.tags?.railway));

async function ask(endpoint: string, body: URLSearchParams, timeoutMs: number): Promise<OsmElement[]> {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "User-Agent": USER_AGENT },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { elements, remark } = (await res.json()) as { elements: OsmElement[]; remark?: string };
    // A query that runs out of time or memory still answers 200, with whatever
    // it had gathered so far and a remark saying so. Half an answer is worse than none.
    if (remark) throw new Error(`incomplete answer: ${remark.slice(0, 120)}`);
    if (endpoint === SWISS_ENDPOINT && !coversLine(elements)) throw new Error("area not covered");
    return elements;
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
 * `swiss` says the line lies in or near Switzerland, where the Swiss
 * instance is tried first. Normally the instances are tried one after another
 * with a generous timeout. In quick mode all are asked at once and the first answer within a
 * few seconds wins, so an upload is never held up for long.
 */
export function fetchOsm(
  line: Array<[number, number]>,
  bbox: [number, number, number, number],
  swiss: boolean,
  quick = false,
): Promise<OsmElement[]> {
  return overpass(query(line, bbox), swiss, quick);
}

/** Railway tracks within `radiusM` of a lon/lat line, with the node ids needed to join them up. */
export function fetchRailways(line: Array<[number, number]>, radiusM: number, swiss: boolean, quick = false): Promise<OsmElement[]> {
  const around = `around:${radiusM},${line.map(([lon, lat]) => `${lat.toFixed(4)},${lon.toFixed(4)}`).join(",")}`;
  return overpass(`[out:json][timeout:25];way(${around})[railway~"^(rail|narrow_gauge|light_rail|tram|funicular|subway)$"];out geom;`, swiss, quick);
}

/** Runs one Overpass query, answering from the on-disk cache when it has been run before. */
async function overpass(data: string, swiss: boolean, quick: boolean): Promise<OsmElement[]> {
  const ENDPOINTS = swiss ? [SWISS_ENDPOINT, ...WORLD_ENDPOINTS] : WORLD_ENDPOINTS;
  // The prefix is bumped to abandon everything cached so far (2: incomplete answers used to be kept).
  const file = path.join(cacheDir, `${createHash("sha1").update(`2:${data}`).digest("hex")}.json`);
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
