import { localProjection, lv95, type Projection } from "../geo/projection.js";
import type { GpxTrack } from "../gpx/parse.js";
import { resample, type TrackPoint } from "../gpx/resample.js";
import type { Terrain } from "../terrain/grid.js";
import { loadSwissTerrain } from "../terrain/swissalti.js";
import { loadTerrariumTerrain } from "../terrain/terrarium.js";
import { measureTrack, type PointMetrics } from "./metrics.js";
import { DEFAULT_PARAMS, findRuns, LEVELS, levelOf, scorePoint, type Level, type ScoreParams } from "./score.js";

/** Terrain is needed this far around the track (longest ray plus fall traces). */
const TERRAIN_BUFFER_M = 250;
/** Assumed sideways GPS error the score is re-tested against. */
const GPS_ERROR_M = 5;
/** Swiss data is abandoned for the global fallback past this share of gaps. */
const MAX_SWISS_GAP_SHARE = 0.02;

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

export interface AnalysedPoint {
  /** Metres from the start. */
  dist: number;
  lon: number;
  lat: number;
  /** Null where there is no terrain data. */
  score: number | null;
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
  let robustScore = 0, maxFallM = 0, maxDrop30M = 0, maxCrossSlopeDeg = 0, bridge = false;
  for (let i = start; i <= end; i++) {
    const p = points[i];
    if (!p.metrics || p.score === null) continue;
    if (p.score > (points[worstIndex].score ?? -1)) worstIndex = i;
    robustScore = Math.max(robustScore, p.scoreLow ?? 0);
    maxFallM = Math.max(maxFallM, p.metrics.fallLeft, p.metrics.fallRight);
    maxDrop30M = Math.max(maxDrop30M, p.metrics.drop30);
    maxCrossSlopeDeg = Math.max(maxCrossSlopeDeg, p.metrics.crossSlopeDeg);
    bridge ||= p.metrics.bridgeGap > 0;
  }

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

/** Scores an already-prepared track against a terrain. Pure, so tests can feed it synthetic ground. */
export function analyseTrack(
  terrain: Terrain,
  track: TrackPoint[],
  projection: Projection,
  options: { name?: string | null; swiss?: boolean; params?: ScoreParams } = {},
): Analysis {
  const params = options.params ?? DEFAULT_PARAMS;
  const swiss = options.swiss ?? false;
  const spacing = track[1].dist - track[0].dist;

  const centre = measureTrack(terrain, track);
  const shifted = [measureTrack(terrain, track, GPS_ERROR_M), measureTrack(terrain, track, -GPS_ERROR_M)];

  const points: AnalysedPoint[] = track.map((p, i) => {
    const [lon, lat] = projection.inverse(p.x, p.y);
    const metrics = centre[i];
    if (!metrics) return { dist: p.dist, lon, lat, score: null, scoreLow: null, scoreHigh: null, level: null, metrics };
    const score = scorePoint(metrics, params);
    const variants = [score, ...shifted.flatMap((s) => (s[i] ? [scorePoint(s[i]!, params)] : []))];
    return {
      dist: p.dist,
      lon,
      lat,
      score,
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

/** Full pipeline for one GPX track: pick and fetch terrain, then score. */
export async function analyseGpx(gpx: GpxTrack, params?: ScoreParams): Promise<Analysis> {
  const { projection, terrain, track, swiss } = await prepare(gpx);
  return analyseTrack(terrain, track, projection, { name: gpx.name, swiss, params });
}
