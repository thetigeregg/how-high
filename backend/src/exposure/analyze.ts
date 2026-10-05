import { buildContext, type TerrainContext } from "../context/context.js";
import { fetchOsm } from "../context/osm.js";
import { localProjection, lv95, type Projection } from "../geo/projection.js";
import type { GpxTrack } from "../gpx/parse.js";
import { resample, type TrackPoint } from "../gpx/resample.js";
import type { Terrain } from "../terrain/grid.js";
import { loadSwissTerrain } from "../terrain/swissalti.js";
import { loadTerrariumTerrain } from "../terrain/terrarium.js";
import { measureTrack, type PointMetrics } from "./metrics.js";
import { logger } from "../logger.js";
import {
  adjustScore,
  DEFAULT_PARAMS,
  findRuns,
  LEVELS,
  levelOf,
  scorePoint,
  type Level,
  type PointContext,
  type ScoreParams,
} from "./score.js";

/** Terrain is needed this far around the track (longest ray plus fall traces). */
const TERRAIN_BUFFER_M = 250;
/** Assumed sideways GPS error the score is re-tested against. */
const GPS_ERROR_M = 5;
/** Swiss data is abandoned for the global fallback past this share of gaps. */
const MAX_SWISS_GAP_SHARE = 0.02;

/** How far to the exposed side the ground must still be wooded to count as forest. */
const FOREST_SIDE_CHECK_M = 20;
/** A side with less drop than this is not the exposed side. */
const EXPOSED_SIDE_MIN_DROP_M = 3;
/** Map context is fetched this far around the track. */
const CONTEXT_BUFFER_M = 100;

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

export interface AnalysedPoint {
  /** Metres from the start. */
  dist: number;
  lon: number;
  lat: number;
  /** Null where there is no terrain data. */
  score: number | null;
  /** The score from terrain alone, before forest, tunnels and track width are applied. */
  rawScore: number | null;
  /** Null where map context was unavailable. */
  context: PointContext | null;
  /** Lowest and highest score when the track is shifted sideways by GPS error. */
  scoreLow: number | null;
  scoreHigh: number | null;
  level: Level | null;
  metrics: PointMetrics | null;
}

export interface Section {
  level: Level;
  startM: number;
  endM: number;
  lengthM: number;
  maxScore: number;
  /** Peak terrain-only score, before map context was applied. */
  rawMaxScore: number;
  /** What the map says about this stretch; null when map context was unavailable. */
  context: {
    forest: boolean;
    tunnel: boolean;
    bridge: boolean;
    wideTrack: boolean;
    /** Highest SAC grade (1–6) mapped along the stretch. */
    sacGrade: number | null;
    aided: boolean;
    cliff: boolean;
  } | null;
  /** Peak score that survives the most favourable GPS shift: "at least this". */
  robustScore: number;
  maxFallM: number;
  maxDrop30M: number;
  maxCrossSlopeDeg: number;
  /** Side of the drop relative to the direction of travel, and its compass bearing. */
  side: "left" | "right" | "both";
  dropTowards: string;
  possibleBridge: boolean;
  /** Location of the worst point, with links for a visual check. */
  worst: { dist: number; lon: number; lat: number; elevation: number };
  links: { swisstopo: string | null; google: string };
}

export interface Analysis {
  name: string | null;
  lengthM: number;
  spacingM: number;
  terrain: { source: string; cellSize: number; confidence: "high" | "low" };
  /** Whether forest, bridges, tunnels and path grades from OpenStreetMap were applied. */
  mapContext: boolean;
  summary: {
    maxScore: number;
    level: Level;
    lengthByLevelM: Record<Level, number>;
    noDataM: number;
  };
  sections: Section[];
  points: AnalysedPoint[];
}

interface Prepared {
  projection: Projection;
  terrain: Terrain;
  track: TrackPoint[];
  swiss: boolean;
}

async function prepare(gpx: GpxTrack): Promise<Prepared> {
  const inSwissGrid = gpx.points.every(({ lon, lat }) => lon > 5.8 && lon < 10.6 && lat > 45.7 && lat < 47.9);
  if (inSwissGrid) {
    const track = resample(gpx.points.map(({ lon, lat }) => lv95.forward(lon, lat)), 5);
    const terrain = await loadSwissTerrain(track.map((p) => [p.x, p.y]), TERRAIN_BUFFER_M);
    const gaps = track.filter((p) => Number.isNaN(terrain.elevation(p.x, p.y))).length;
    if (gaps / track.length <= MAX_SWISS_GAP_SHARE) return { projection: lv95, terrain, track, swiss: true };
  }

  const lons = gpx.points.map((p) => p.lon);
  const lats = gpx.points.map((p) => p.lat);
  const projection = localProjection(
    (Math.min(...lons) + Math.max(...lons)) / 2,
    (Math.min(...lats) + Math.max(...lats)) / 2,
  );
  const track = resample(gpx.points.map(({ lon, lat }) => projection.forward(lon, lat)), 15);
  const terrain = await loadTerrariumTerrain(track.map((p) => [p.x, p.y]), projection, TERRAIN_BUFFER_M);
  return { projection, terrain, track, swiss: false };
}

function buildSection(points: AnalysedPoint[], track: TrackPoint[], start: number, end: number, peak: number, spacing: number, swiss: boolean, params: ScoreParams): Section {
  let worstIndex = start;
  let robustScore = 0, rawMaxScore = 0, maxFallM = 0, maxDrop30M = 0, maxCrossSlopeDeg = 0, bridge = false;
  let known = 0, wooded = 0, wide = 0;
  const context = { forest: false, tunnel: false, bridge: false, wideTrack: false, sacGrade: null as number | null, aided: false, cliff: false };
  for (let i = start; i <= end; i++) {
    const p = points[i];
    if (!p.metrics || p.score === null) continue;
    if (p.score > (points[worstIndex].score ?? -1)) worstIndex = i;
    rawMaxScore = Math.max(rawMaxScore, p.rawScore ?? 0);
    if (p.context) {
      known++;
      if (p.context.forest) wooded++;
      if (p.context.wide) wide++;
      context.tunnel ||= p.context.tunnel;
      context.bridge ||= p.context.bridge;
      context.aided ||= p.context.aided;
      context.cliff ||= p.context.cliff;
      if (p.context.sacGrade !== null) context.sacGrade = Math.max(context.sacGrade ?? 0, p.context.sacGrade);
    }
    robustScore = Math.max(robustScore, p.scoreLow ?? 0);
    maxFallM = Math.max(maxFallM, p.metrics.fallLeft, p.metrics.fallRight);
    maxDrop30M = Math.max(maxDrop30M, p.metrics.drop30);
    maxCrossSlopeDeg = Math.max(maxCrossSlopeDeg, p.metrics.crossSlopeDeg);
    bridge ||= p.metrics.bridgeGap > 0;
  }
  // Forest and track width describe the stretch as a whole, not a stray point.
  context.forest = wooded * 2 >= known && wooded > 0;
  context.wideTrack = wide * 2 >= known && wide > 0;

  const worst = points[worstIndex];
  const m = worst.metrics!;
  const left = Math.max(m.fallLeft, m.dropLeft30);
  const right = Math.max(m.fallRight, m.dropRight30);
  const lesser = Math.min(left, right);
  const side = lesser >= params.ridgeDropM && lesser >= 0.6 * Math.max(left, right) ? "both" : left >= right ? "left" : "right";

  // Bearing of the drop: the track's left or right normal, clockwise from north.
  const { tx, ty } = track[worstIndex];
  const [vx, vy] = side === "right" ? [ty, -tx] : [-ty, tx];
  const bearing = (Math.atan2(vx, vy) * 180) / Math.PI;
  const dropTowards = COMPASS[Math.round(((bearing + 360) % 360) / 45) % 8];

  const [e, n] = lv95.forward(worst.lon, worst.lat);
  return {
    level: levelOf(peak, params),
    startM: start * spacing,
    endM: end * spacing,
    lengthM: (end - start + 1) * spacing,
    maxScore: Math.round(worst.score ?? peak),
    rawMaxScore: Math.round(rawMaxScore),
    context: known > 0 ? context : null,
    robustScore: Math.round(robustScore),
    maxFallM: Math.round(maxFallM),
    maxDrop30M: Math.round(maxDrop30M),
    maxCrossSlopeDeg: Math.round(maxCrossSlopeDeg),
    side,
    dropTowards,
    possibleBridge: bridge,
    worst: { dist: worst.dist, lon: worst.lon, lat: worst.lat, elevation: Math.round(m.elevation) },
    links: {
      swisstopo: swiss
        ? `https://map.geo.admin.ch/#/map?lang=en&center=${e.toFixed(0)},${n.toFixed(0)}&z=11&bgLayer=ch.swisstopo.pixelkarte-farbe&crosshair=marker`
        : null,
      google: `https://www.google.com/maps/@?api=1&map_action=map&center=${worst.lat.toFixed(6)},${worst.lon.toFixed(6)}&zoom=17&basemap=terrain`,
    },
  };
}

/** Looks up what the map knows about one track point, given which way it is exposed. */
function describePoint(context: TerrainContext, p: TrackPoint, m: PointMetrics): PointContext {
  const left = Math.max(m.fallLeft, m.dropLeft30);
  const right = Math.max(m.fallRight, m.dropRight30);
  // Trees only hide a drop if they also stand on the side(s) it is on.
  const sides = [left >= EXPOSED_SIDE_MIN_DROP_M ? 1 : 0, right >= EXPOSED_SIDE_MIN_DROP_M ? -1 : 0].filter((s) => s !== 0);
  // The path itself may run along the forest edge; what matters is the slope below it.
  const wooded = (side: number, offset: number) =>
    context.inForest(p.x - p.ty * side * offset, p.y + p.tx * side * offset);
  const forest =
    sides.length === 0
      ? context.inForest(p.x, p.y)
      : sides.every((s) => wooded(s, FOREST_SIDE_CHECK_M / 2) && wooded(s, FOREST_SIDE_CHECK_M));
  const path = context.pathAt(p.x, p.y);
  return {
    forest,
    matched: path !== null,
    tunnel: path?.tunnel ?? false,
    bridge: path?.bridge ?? false,
    wide: path?.wide ?? false,
    sacGrade: path?.sacGrade ?? null,
    aided: path?.aided ?? false,
    cliff: context.cliffNear(p.x, p.y),
  };
}

/** Scores an already-prepared track against a terrain. Pure, so tests can feed it synthetic ground. */
export function analyseTrack(
  terrain: Terrain,
  track: TrackPoint[],
  projection: Projection,
  options: { name?: string | null; swiss?: boolean; params?: ScoreParams; context?: TerrainContext } = {},
): Analysis {
  const params = options.params ?? DEFAULT_PARAMS;
  const swiss = options.swiss ?? false;
  const spacing = track[1].dist - track[0].dist;

  const centre = measureTrack(terrain, track);
  const shifted = [measureTrack(terrain, track, GPS_ERROR_M), measureTrack(terrain, track, -GPS_ERROR_M)];

  const points: AnalysedPoint[] = track.map((p, i) => {
    const [lon, lat] = projection.inverse(p.x, p.y);
    const measured = centre[i];
    if (!measured) {
      return { dist: p.dist, lon, lat, score: null, rawScore: null, context: null, scoreLow: null, scoreHigh: null, level: null, metrics: null };
    }
    const context = options.context ? describePoint(options.context, p, measured) : null;
    // The terrain-only bridge guess is dropped where the map shows a path that is not a bridge.
    const disproved = context !== null && context.matched && !context.bridge;
    const settle = (m: PointMetrics) => (disproved ? { ...m, bridgeGap: 0 } : m);
    const metrics = settle(measured);
    const rawScore = scorePoint(metrics, params);
    const score = adjustScore(rawScore, context, params);
    const variants = [
      score,
      ...shifted.flatMap((s) => (s[i] ? [adjustScore(scorePoint(settle(s[i]!), params), context, params)] : [])),
    ];
    return {
      dist: p.dist,
      lon,
      lat,
      score,
      rawScore,
      context,
      scoreLow: Math.min(...variants),
      scoreHigh: Math.max(...variants),
      level: levelOf(score, params),
      metrics,
    };
  });

  const runs = findRuns(points.map((p) => p.score), spacing, params);
  const sections = runs.map((run) => buildSection(points, track, run.start, run.end, run.peak, spacing, swiss, params));

  // Length per level comes from the sections, so it matches what is listed.
  const lengthByLevelM = Object.fromEntries(LEVELS.map((level) => [level, 0])) as Record<Level, number>;
  for (const section of sections) lengthByLevelM[section.level] += section.lengthM;
  const noDataM = points.filter((p) => p.score === null).length * spacing;
  const lengthM = track[track.length - 1].dist;
  lengthByLevelM.green = Math.max(0, lengthM - noDataM - lengthByLevelM.yellow - lengthByLevelM.orange - lengthByLevelM.red);
  const maxScore = Math.max(0, ...sections.map((s) => s.maxScore));

  return {
    name: options.name ?? null,
    lengthM,
    spacingM: spacing,
    terrain: { source: terrain.source, cellSize: terrain.cellSize, confidence: swiss ? "high" : "low" },
    mapContext: options.context !== undefined,
    summary: {
      maxScore,
      level: sections.reduce<Level>((worst, s) => (LEVELS.indexOf(s.level) > LEVELS.indexOf(worst) ? s.level : worst), "green"),
      lengthByLevelM,
      noDataM,
    },
    sections,
    points,
  };
}

/** Map context around the track, or undefined when OpenStreetMap cannot be reached. */
async function loadContext(track: TrackPoint[], projection: Projection): Promise<TerrainContext | undefined> {
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
  try {
    const elements = await fetchOsm([Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)]);
    return buildContext(elements, projection, bounds);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "analysing without map context");
    return undefined;
  }
}

/** Full pipeline for one GPX track: pick and fetch terrain, then score. */
export async function analyseGpx(gpx: GpxTrack, params?: ScoreParams): Promise<Analysis> {
  const { projection, terrain, track, swiss } = await prepare(gpx);
  return analyseTrack(terrain, track, projection, {
    name: gpx.name,
    swiss,
    params,
    context: await loadContext(track, projection),
  });
}
