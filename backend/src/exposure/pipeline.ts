import { buildContext, type TerrainContext } from "../context/context.js";
import { fetchOsm, fetchRailways } from "../context/osm.js";
import { followTrack } from "../context/railmatch.js";
import { localProjection, lv95, type Projection } from "../geo/projection.js";
import type { GpxPoint, GpxTrack } from "../gpx/parse.js";
import { resample, type TrackPoint } from "../gpx/resample.js";
import { logger } from "../logger.js";
import type { Terrain } from "../terrain/grid.js";
import { loadSwissTerrain } from "../terrain/swissalti.js";
import { loadTerrariumTerrain } from "../terrain/terrarium.js";
import { MEASURE_VERSION, measurePoints, TRAVEL_KIND, type Leg, type LegMode, type MeasuredPoint, type Measurement, type Profile } from "./analyze.js";
import { DEFAULT_MEASURE, type MeasureParams, type PointMetrics } from "./metrics.js";
import type { NoGoKind, PointContext } from "./score.js";

/** One stretch of a route as it comes from a GPX file or a routing service. */
export interface SourceLeg {
  mode: LegMode;
  label: string;
  /** Set when the transport itself is a no-go, whatever the terrain. */
  noGo: NoGoKind | null;
  points: GpxPoint[];
}

/** Everything needed to measure a route again later; this is what is kept on disk. */
export interface RouteSource {
  name: string | null;
  profile: Profile;
  /** The link the route came from, if any. */
  url: string | null;
  legs: SourceLeg[];
}

export function gpxSource(gpx: GpxTrack): RouteSource {
  return { name: gpx.name, profile: "hike", url: null, legs: [{ mode: "hike", label: "Hike", noGo: null, points: gpx.points }] };
}

/** Terrain is needed this far around the track (longest ray plus fall traces). */
const TERRAIN_BUFFER_M = 250;
/** Forest is fetched this far around the track. */
const CONTEXT_BUFFER_M = 100;
/** Swiss data is abandoned for the global fallback past this share of gaps (hikes only). */
const MAX_SWISS_GAP_SHARE = 0.02;
/** Point spacing in metres by profile: [with Swiss terrain, with global terrain]. */
const SPACING: Record<Profile, [number, number]> = { hike: [5, 15], road: [10, 20] };
// Long routes are measured in pieces so only the terrain and map data for one
// piece is in memory at a time. Pieces overlap so that measurements which
// look along the track (path grade, bridges) are not cut off at the joins.
// Pieces are kept short because the forest for each is asked for by bounding
// box, and a big box over wooded country is more than the map servers answer in time.
const CHUNK_POINTS = 500;
const CHUNK_OVERLAP = 20;
/** Spacing of the simplified line sent to OpenStreetMap, metres. */
const OSM_LINE_STEP_M = 100;
/** How far around a train's rough line mapped track is fetched; the real track can loop well away from it. */
const RAIL_CORRIDOR_M = 3000;
/** The rough line is thinned to about this spacing for that request, and cut into pieces of this many points. */
const RAIL_LINE_STEP_M = 1000;
const RAIL_LINE_POINTS = 40;

const NO_CONTEXT: PointContext = {
  forest: false, matched: false, tunnel: false, bridge: false, wide: false, sacGrade: null, aided: false, cliff: false, noGo: null,
};

async function loadContext(
  track: TrackPoint[],
  projection: Projection,
  spacing: number,
  swiss: boolean,
  quick: boolean,
): Promise<TerrainContext | undefined> {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of track) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const bounds = {
    minX: minX - CONTEXT_BUFFER_M,
    minY: minY - CONTEXT_BUFFER_M,
    maxX: maxX + CONTEXT_BUFFER_M,
    maxY: maxY + CONTEXT_BUFFER_M,
  };
  const corners = [
    projection.inverse(bounds.minX, bounds.minY),
    projection.inverse(bounds.minX, bounds.maxY),
    projection.inverse(bounds.maxX, bounds.minY),
    projection.inverse(bounds.maxX, bounds.maxY),
  ];
  const lons = corners.map((c) => c[0]);
  const lats = corners.map((c) => c[1]);
  const step = Math.max(1, Math.round(OSM_LINE_STEP_M / spacing));
  const line = track.filter((_, i) => i % step === 0 || i === track.length - 1).map((p) => projection.inverse(p.x, p.y));
  try {
    const elements = await fetchOsm(line, [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)], swiss, quick);
    return buildContext(elements, projection, bounds);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "measuring without map context");
    return undefined;
  }
}

/** Rough distance in metres between two lon/lat points. */
function gap(a: GpxPoint, b: GpxPoint): number {
  return Math.hypot((a.lat - b.lat) * 111_320, (a.lon - b.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180));
}

/**
 * Replaces the rough line of a train ride with its course along mapped
 * track. Returns the leg unchanged when the map shows no connected track
 * between its ends; throws when the map could not be asked at all.
 */
async function onTrack(leg: SourceLeg, swiss: boolean, quick: boolean): Promise<SourceLeg> {
  const thinned: GpxPoint[] = [leg.points[0]];
  for (const p of leg.points) {
    // Long straight strokes of the sketch are filled in so the corridor has no holes.
    let last = thinned[thinned.length - 1];
    for (let d = gap(last, p); d > RAIL_LINE_STEP_M; d = gap(last, p)) {
      const t = RAIL_LINE_STEP_M / d;
      last = { lat: last.lat + (p.lat - last.lat) * t, lon: last.lon + (p.lon - last.lon) * t };
      thinned.push(last);
    }
  }
  thinned.push(leg.points[leg.points.length - 1]);

  const railways = [];
  for (let i = 0; i < thinned.length - 1; i += RAIL_LINE_POINTS) {
    const piece = thinned.slice(i, i + RAIL_LINE_POINTS + 1).map((p): [number, number] => [p.lon, p.lat]);
    railways.push(...(await fetchRailways(piece, RAIL_CORRIDOR_M, swiss, quick)));
  }
  const course = followTrack(leg.points, railways);
  if (!course) logger.warn({ leg: leg.label }, "no connected track found; keeping the routing service's line");
  return course ? { ...leg, points: course } : leg;
}

/**
 * On a mapped bridge the deck height is known better than the terrain-only
 * guess: it runs straight between the ground at both ends, however long the
 * bridge is. Raises `bridgeGap` accordingly along every run of bridge points.
 */
function measureBridgeDecks(points: MeasuredPoint[]) {
  const ground = (i: number) => points[i]?.metrics?.elevation;
  for (let start = 0; start < points.length; start++) {
    if (!points[start].context?.bridge) continue;
    let end = start;
    while (end + 1 < points.length && points[end + 1].context?.bridge) end++;
    const from = ground(start - 1) ?? ground(start);
    const to = ground(end + 1) ?? ground(end);
    if (from !== undefined && to !== undefined) {
      for (let i = start; i <= end; i++) {
        const deck = from + ((to - from) * (i - start + 1)) / (end - start + 2);
        const raise = (m: PointMetrics | null) => {
          if (m) m.bridgeGap = Math.max(m.bridgeGap, deck - m.elevation);
        };
        raise(points[i].metrics);
        points[i].shifted.forEach(raise);
      }
    }
    start = end;
  }
}

/**
 * Everything slow for one route: fetch terrain and map context, then measure.
 * With `quickContext`, map context is given only a few seconds before the
 * route is measured without it.
 */
export async function measureSource(
  source: RouteSource,
  params: MeasureParams = DEFAULT_MEASURE,
  quickContext = false,
  forceGlobal = false,
): Promise<Measurement> {
  const all = source.legs.flatMap((leg) => leg.points);
  const swiss = !forceGlobal && all.every(({ lon, lat }) => lon > 5.8 && lon < 10.6 && lat > 45.7 && lat < 47.9);
  const lons = all.map((p) => p.lon);
  const lats = all.map((p) => p.lat);
  const projection = swiss
    ? lv95
    : localProjection((Math.min(...lons) + Math.max(...lons)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2);
  const spacing = SPACING[source.profile][swiss ? 0 : 1];
  let mapContext = true;

  const sourceLegs: SourceLeg[] = [];
  for (const leg of source.legs) {
    // Funiculars and lifts are no-gos whatever their course; only real train rides are worth tracing.
    if (leg.mode !== "rail" || leg.noGo || (quickContext && !mapContext)) {
      sourceLegs.push(leg);
      continue;
    }
    try {
      sourceLegs.push(await onTrack(leg, swiss, quickContext));
    } catch (err) {
      logger.warn({ leg: leg.label, err: (err as Error).message }, "could not fetch track for a train ride");
      mapContext = false;
      sourceLegs.push(leg);
    }
  }

  // Each leg is resampled on its own so that leg boundaries fall on points.
  const track: TrackPoint[] = [];
  const legs: Leg[] = [];
  const legOf: number[] = [];
  for (const [index, leg] of sourceLegs.entries()) {
    const line = leg.points.map(({ lon, lat }) => projection.forward(lon, lat));
    let piece: TrackPoint[];
    try {
      piece = resample(line, spacing);
    } catch {
      continue; // a leg with no length, e.g. a transfer on the spot
    }
    if (piece.length < 2) continue;
    const offset = track.length === 0 ? 0 : track[track.length - 1].dist + spacing;
    for (const p of piece) {
      track.push({ ...p, dist: p.dist + offset });
      legOf.push(index);
    }
    legs.push({ mode: leg.mode, label: leg.label, startM: offset, endM: track[track.length - 1].dist });
  }
  if (track.length < 2) throw new Error("Route has no length");

  const points: MeasuredPoint[] = [];
  let terrainInfo: Measurement["terrain"] | null = null;
  for (let start = 0; start < track.length; start += CHUNK_POINTS) {
    const end = Math.min(track.length, start + CHUNK_POINTS);
    const from = Math.max(0, start - CHUNK_OVERLAP);
    const to = Math.min(track.length, end + CHUNK_OVERLAP);
    const piece = track.slice(from, to);
    const xy = piece.map((p): [number, number] => [p.x, p.y]);
    const terrain: Terrain = swiss
      ? await loadSwissTerrain(xy, TERRAIN_BUFFER_M)
      : await loadTerrariumTerrain(xy, projection, TERRAIN_BUFFER_M);
    terrainInfo ??= { source: terrain.source, cellSize: terrain.cellSize, confidence: swiss ? "high" : "low" };
    // In quick mode one failure is taken as the servers being down: the rest
    // of the route is not held up asking again, and the background retry fills it in.
    const context: TerrainContext | undefined = quickContext && !mapContext ? undefined : await loadContext(piece, projection, spacing, swiss, quickContext);
    mapContext &&= context !== undefined;
    const measured = measurePoints(terrain, piece, projection, context, params, (i) => TRAVEL_KIND[sourceLegs[legOf[from + i]].mode]);
    points.push(...measured.slice(start - from, end - from));
  }

  // Border hikes: where swisstopo has too many gaps, the coarser global data is the better picture.
  if (swiss && source.profile === "hike") {
    const gaps = points.filter((p) => p.metrics === null).length;
    if (gaps / points.length > MAX_SWISS_GAP_SHARE) return measureSource(source, params, quickContext, true);
  }

  measureBridgeDecks(points);
  for (const [i, p] of points.entries()) {
    const { noGo } = sourceLegs[legOf[i]];
    if (noGo) p.context = { ...(p.context ?? NO_CONTEXT), noGo };
  }

  return {
    name: source.name,
    lengthM: track[track.length - 1].dist,
    spacingM: spacing,
    terrain: terrainInfo!,
    swiss,
    mapContext,
    params,
    version: MEASURE_VERSION,
    profile: source.profile,
    legs,
    points,
  };
}
