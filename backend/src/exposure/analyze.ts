import type { TerrainContext, TravelKind } from "../context/context.js";
import { lv95, type Projection } from "../geo/projection.js";
import type { TrackPoint } from "../gpx/resample.js";
import type { Terrain } from "../terrain/grid.js";
import { measureView } from "./view.js";
import { DEFAULT_MEASURE, measureTrack, type MeasureParams, type PointMetrics } from "./metrics.js";
import {
  adjustScore,
  DEFAULT_PARAMS,
  scoreSide,
  scoreView,
  viewDepth,
  type View,
  findRuns,
  LEVELS,
  levelOf,
  scorePoint,
  type Level,
  type NoGoKind,
  type NoGoSettings,
  type PointContext,
  type ScoreParams,
} from "./score.js";

/** A side with less drop than this is not the exposed side. */
const EXPOSED_SIDE_MIN_DROP_M = 3;
/** How far below level Street View looks when opened at a flagged spot, degrees. */
const STREET_VIEW_PITCH = -20;

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
  /** The part of the score that comes from the ground beside the route: drops, falls, side slope. */
  dropScore: number | null;
  /** The part that comes from how much height the view shows; see `viewDepthM`. */
  viewScore: number | null;
  /** Depth of the view down across the arc that counts, metres; null where the view was not measured. */
  viewDepthM: number | null;
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
    /** Set when the stretch is a no-go outright because of how it is travelled. */
    noGo: NoGoKind | null;
  } | null;
  /** Peak score that survives the most favourable GPS shift: "at least this". */
  robustScore: number;
  maxFallM: number;
  maxDrop30M: number;
  maxDrop100M: number;
  maxCrossSlopeDeg: number;
  /** Side of the drop relative to the direction of travel, and its compass bearing. */
  side: "left" | "right" | "both";
  dropTowards: string;
  possibleBridge: boolean;
  /** What flagged this stretch: the ground beside the route, the view, or both. */
  cause: "drops" | "view" | "both";
  maxViewDepthM: number;
  /** Location of the worst point, with links for a visual check. */
  worst: { dist: number; lon: number; lat: number; elevation: number };
  links: { swisstopo: string | null; google: string; streetView: string };
}

export interface Analysis {
  name: string | null;
  lengthM: number;
  spacingM: number;
  terrain: { source: string; cellSize: number; confidence: "high" | "low" };
  /** Whether forest, bridges, tunnels and path grades from OpenStreetMap were applied. */
  mapContext: boolean;
  /** Score at which yellow, orange and red start, as used for this result. */
  thresholds: [number, number, number];
  profile: Profile;
  legs: Leg[];
  summary: {
    maxScore: number;
    level: Level;
    lengthByLevelM: Record<Level, number>;
    noDataM: number;
  };
  sections: Section[];
  points: AnalysedPoint[];
}

/**
 * Raised whenever measuring itself changes (not just the settings), so stored
 * measurements taken the old way are taken again.
 * 2: forests mapped as multipolygons are no longer missed.
 * 3: train rides follow mapped track instead of the routing service's line.
 * 4: incomplete answers from the map servers are no longer used.
 * 5: the 10 m and 100 m drops are measured for each side separately.
 * 6: the view from the route is measured.
 */
export const MEASURE_VERSION = 6;

/** The view changes slowly along a route, so it is measured only this often, metres. */
const VIEW_EVERY_M = 25;

/** How a stretch is travelled. Ferries are carried along but never scored. */
export type LegMode = "hike" | "walk" | "drive" | "bus" | "rail" | "lift" | "ferry";
/** Which family of settings a route is scored with. */
export type Profile = "hike" | "road";

/** One stretch of a route travelled in one way, e.g. a single train ride. */
export interface Leg {
  mode: LegMode;
  label: string;
  startM: number;
  endM: number;
  /**
   * For rides: which side the drops are on, per stretch between reversals of
   * direction. Set when scoring; absent for stretches on foot.
   */
  sides?: SideSummary[];
}

/** Which side of the vehicle the exposure is on along one stretch. */
export interface SideSummary {
  startM: number;
  endM: number;
  /** Flagged length with the drop on the left only, the right only, or on both sides (bridges, ridges). */
  leftM: number;
  rightM: number;
  bothM: number;
  /**
   * The side to sit on, relative to the direction of travel: the one away
   * from most of the drops. 'either' when nothing is flagged, 'none' when
   * neither side is clearly better.
   */
  sit: "left" | "right" | "either" | "none";
}

/** The kind of mapped way each leg mode is matched against; null for none. */
export const TRAVEL_KIND: Record<LegMode, TravelKind | null> = {
  hike: "foot",
  walk: "foot",
  drive: "road",
  bus: "road",
  rail: "rail",
  lift: null,
  ferry: null,
};

/**
 * What was found along a track, before any scoring. This is what gets stored:
 * scores are derived from it on demand, so settings can change freely.
 */
export interface Measurement {
  name: string | null;
  lengthM: number;
  spacingM: number;
  terrain: { source: string; cellSize: number; confidence: "high" | "low" };
  swiss: boolean;
  mapContext: boolean;
  /** The measurement settings this was taken with. */
  params: MeasureParams;
  /** `MEASURE_VERSION` at the time; absent on the oldest measurements. */
  version?: number;
  /** Absent on hikes measured before routes existed; read as a single hike leg. */
  profile?: Profile;
  legs?: Leg[];
  points: MeasuredPoint[];
}

export interface MeasuredPoint {
  dist: number;
  lon: number;
  lat: number;
  /** Unit vector of travel in the metric plane. */
  heading: [number, number];
  metrics: PointMetrics | null;
  /** The same measurements with the track shifted left and right by the GPS error. */
  shifted: [PointMetrics | null, PointMetrics | null];
  context: PointContext | null;
  /** The view from here; present only on the points where it was measured. */
  view?: View | null;
}

function buildSection(points: AnalysedPoint[], headings: Array<[number, number]>, start: number, end: number, peak: number, spacing: number, swiss: boolean, params: ScoreParams): Section {
  let worstIndex = start;
  let robustScore = 0, rawMaxScore = 0, maxFallM = 0, maxDrop30M = 0, maxDrop100M = 0, maxCrossSlopeDeg = 0, bridge = false;
  let known = 0, wooded = 0, wide = 0;
  let maxViewDepthM = 0, byDrops = false, byView = false;
  const context = { forest: false, tunnel: false, bridge: false, wideTrack: false, sacGrade: null as number | null, aided: false, cliff: false, noGo: null as NoGoKind | null };
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
      context.noGo ??= p.context.noGo;
      if (p.context.sacGrade !== null) context.sacGrade = Math.max(context.sacGrade ?? 0, p.context.sacGrade);
    }
    robustScore = Math.max(robustScore, p.scoreLow ?? 0);
    maxFallM = Math.max(maxFallM, p.metrics.fallLeft, p.metrics.fallRight);
    maxDrop30M = Math.max(maxDrop30M, p.metrics.drop30);
    maxDrop100M = Math.max(maxDrop100M, p.metrics.drop100);
    maxCrossSlopeDeg = Math.max(maxCrossSlopeDeg, p.metrics.crossSlopeDeg);
    bridge ||= p.metrics.bridgeGap > 0;
    maxViewDepthM = Math.max(maxViewDepthM, p.viewDepthM ?? 0);
    if ((p.dropScore ?? 0) >= params.thresholds[0]) byDrops = true;
    if ((p.viewScore ?? 0) >= params.thresholds[0]) byView = true;
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
  const [tx, ty] = headings[worstIndex];
  const [vx, vy] = side === "right" ? [ty, -tx] : [-ty, tx];
  const bearing = (Math.atan2(vx, vy) * 180) / Math.PI;
  const dropTowards = COMPASS[Math.round(((bearing + 360) % 360) / 45) % 8];

  // Street View opens facing the drop and tilted down at it; where the drop
  // is on both sides (a ridge, a bridge) it faces the way of travel instead.
  const lookAt = side === "both" ? (Math.atan2(tx, ty) * 180) / Math.PI : bearing;
  const heading = Math.round((lookAt + 360) % 360);

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
    maxDrop100M: Math.round(maxDrop100M),
    maxCrossSlopeDeg: Math.round(maxCrossSlopeDeg),
    cause: byDrops && byView ? "both" : byView ? "view" : "drops",
    maxViewDepthM: Math.round(maxViewDepthM),
    side,
    dropTowards,
    possibleBridge: bridge,
    worst: { dist: worst.dist, lon: worst.lon, lat: worst.lat, elevation: Math.round(m.elevation) },
    links: {
      swisstopo: swiss
        ? `https://map.geo.admin.ch/#/map?lang=en&center=${e.toFixed(0)},${n.toFixed(0)}&z=11&bgLayer=ch.swisstopo.pixelkarte-farbe&crosshair=marker`
        : null,
      google: `https://www.google.com/maps/@?api=1&map_action=map&center=${worst.lat.toFixed(6)},${worst.lon.toFixed(6)}&zoom=17&basemap=terrain`,
      // Opens the nearest panorama, if Google has one; there is no telling from here whether it does.
      streetView: `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${worst.lat.toFixed(6)},${worst.lon.toFixed(6)}&heading=${heading}&pitch=${STREET_VIEW_PITCH}&fov=90`,
    },
  };
}

/** Looks up what the map knows about one track point, given which way it is exposed. */
function describePoint(
  context: TerrainContext,
  p: TrackPoint,
  m: PointMetrics,
  forestCheckM: number,
  kind: TravelKind | null,
): PointContext {
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
      : sides.every((s) => wooded(s, forestCheckM / 2) && wooded(s, forestCheckM));
  const path = kind ? context.pathAt(p.x, p.y, kind) : null;
  return {
    forest,
    matched: path !== null,
    tunnel: path?.tunnel ?? false,
    bridge: path?.bridge ?? false,
    wide: path?.wide ?? false,
    sacGrade: path?.sacGrade ?? null,
    aided: path?.aided ?? false,
    cliff: context.cliffNear(p.x, p.y),
    noGo: path?.funicular ? "funiculars" : path?.rack ? "rackRailways" : null,
  };
}

/**
 * Measures an already-prepared track against a terrain. Pure, so tests can
 * feed it synthetic ground. The result holds no scores, only what was found.
 */
export function measure(
  terrain: Terrain,
  track: TrackPoint[],
  projection: Projection,
  options: { name?: string | null; swiss?: boolean; context?: TerrainContext; params?: MeasureParams } = {},
): Measurement {
  const params = options.params ?? DEFAULT_MEASURE;
  return {
    name: options.name ?? null,
    lengthM: track[track.length - 1].dist,
    spacingM: track[1].dist - track[0].dist,
    terrain: { source: terrain.source, cellSize: terrain.cellSize, confidence: options.swiss ? "high" : "low" },
    swiss: options.swiss ?? false,
    mapContext: options.context !== undefined,
    params,
    version: MEASURE_VERSION,
    profile: "hike",
    legs: [{ mode: "hike", label: "Hike", startM: 0, endM: track[track.length - 1].dist }],
    points: measurePoints(terrain, track, projection, options.context, params, () => "foot"),
  };
}

/**
 * Measures every point of a stretch of track against one terrain and, when
 * available, map context. `kindAt` says which kind of mapped way each point
 * should be matched to.
 */
export function measurePoints(
  terrain: Terrain,
  track: TrackPoint[],
  projection: Projection,
  context: TerrainContext | undefined,
  params: MeasureParams,
  kindAt: (index: number) => TravelKind | null,
  far?: Terrain,
): MeasuredPoint[] {
  const viewEvery = Math.max(1, Math.round(VIEW_EVERY_M / (track.length > 1 ? track[1].dist - track[0].dist : 1)));
  const centre = measureTrack(terrain, track, 0, params);
  const left = measureTrack(terrain, track, params.gpsErrorM, params);
  const right = measureTrack(terrain, track, -params.gpsErrorM, params);
  return track.map((p, i) => {
    const [lon, lat] = projection.inverse(p.x, p.y);
    const metrics = centre[i];
    return {
      dist: p.dist,
      lon,
      lat,
      heading: [p.tx, p.ty],
      metrics,
      shifted: [left[i], right[i]],
      context: metrics && context ? describePoint(context, p, metrics, params.forestCheckM, kindAt(i)) : null,
      // Counted from the start of the route, so the measured points do not depend on how it was cut into pieces.
      ...(far && Math.round(p.dist / (track[1].dist - track[0].dist)) % viewEvery === 0
        ? { view: viewFrom(terrain, far, p, context) }
        : {}),
    };
  });
}

function viewFrom(near: Terrain, far: Terrain, p: TrackPoint, context: TerrainContext | undefined): View | null {
  const depths = measureView(near, far, p.x, p.y);
  return depths && { depths, wooded: context?.inForest(p.x, p.y) ?? false };
}

/** A side needs this much flagged length before it is worth recommending the other. */
const SIDE_MIN_M = 200;
/** ...and this many times more than the other side. */
const SIDE_RATIO = 2;
// A train reversing at a terminus turns round on the spot: two points this
// far apart along the track end up close together, heading opposite ways.
// The span is kept short so that a horseshoe curve, where a mountain railway
// also comes back on itself but over a few hundred metres, is not mistaken for one.
const REVERSAL_SPAN_M = 60;
const REVERSAL_MAX_CHORD = 0.5;

/** Indexes within a rail leg where the train reverses its direction of travel. */
function reversals(measurement: Measurement, first: number, last: number): number[] {
  const { points, spacingM } = measurement;
  const half = Math.round(REVERSAL_SPAN_M / 2 / spacingM);
  const found: number[] = [];
  for (let i = first + half; i + half <= last; i++) {
    const a = points[i - half];
    const b = points[i + half];
    const chord = Math.hypot((a.lat - b.lat) * 111_320, (a.lon - b.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180));
    const opposed = a.heading[0] * b.heading[0] + a.heading[1] * b.heading[1] < -0.8;
    if (opposed && chord < REVERSAL_MAX_CHORD * REVERSAL_SPAN_M) {
      found.push(i);
      i += Math.round(200 / spacingM); // one reversal, not a run of detections around it
    }
  }
  return found;
}

/**
 * Sums up, for one ride, how much flagged length has its drop on each side.
 * Left and right are relative to the direction of travel, so the leg is cut
 * where a train reverses: after that, the same seat faces the other side.
 */
function summariseSides(measurement: Measurement, scored: AnalysedPoint[], leg: Leg, params: ScoreParams): SideSummary[] {
  const { spacingM } = measurement;
  const first = Math.round(leg.startM / spacingM);
  const last = Math.min(scored.length - 1, Math.round(leg.endM / spacingM));
  const cuts = leg.mode === "rail" ? reversals(measurement, first, last) : [];
  const flagged = params.thresholds[0];

  const summaries: SideSummary[] = [];
  const bounds = [first, ...cuts, last];
  for (let b = 0; b + 1 < bounds.length; b++) {
    let leftM = 0, rightM = 0, bothM = 0;
    for (let i = bounds[b]; i <= bounds[b + 1]; i++) {
      const p = scored[i];
      if (!p.metrics || p.score === null || p.context?.tunnel) continue;
      const left = adjustScore(scoreSide(p.metrics, "left", params), p.context, params) >= flagged;
      const right = adjustScore(scoreSide(p.metrics, "right", params), p.context, params) >= flagged;
      // On a bridge the view down is the same from either window.
      const bridge = p.score >= flagged && (p.context?.bridge === true || p.metrics.bridgeGap > 0);
      if (bridge || (left && right)) bothM += spacingM;
      else if (left) leftM += spacingM;
      else if (right) rightM += spacingM;
    }
    const sit =
      leftM + rightM + bothM < SIDE_MIN_M
        ? "either"
        : rightM >= SIDE_MIN_M && rightM >= SIDE_RATIO * leftM
          ? "left"
          : leftM >= SIDE_MIN_M && leftM >= SIDE_RATIO * rightM
            ? "right"
            : "none";
    summaries.push({ startM: bounds[b] * spacingM, endM: bounds[b + 1] * spacingM, leftM, rightM, bothM, sit });
  }
  return summaries;
}

/** Ground steeper than this is not somewhere a road or track lies; a line drawn on it is a few metres off. */
const MAX_PATH_SLOPE_DEG = 45;
/** ...and is only moved if one of the positions beside it is at least this much gentler. */
const MIN_GENTLER_DEG = 10;

/**
 * The measurements to score a point by. Where a road, railway or wide track
 * is drawn on ground too steep to carry one, e.g. a few metres into the
 * cliff it runs along the foot of, it is taken to be at whichever position a
 * GPS error to either side has it on the gentlest ground: that is where its
 * bed will be. Footpaths are left alone: a narrow path can cross ground this
 * steep on a ledge too small for the terrain data to show, and moving it
 * would hide real exposure. So are mapped bridges and tunnels, where the
 * ground under the line is not what carries it.
 */
function placed(p: MeasuredPoint, vehicleWidth: boolean): PointMetrics {
  const centre = p.metrics!;
  if (!vehicleWidth || centre.slopeDeg <= MAX_PATH_SLOPE_DEG || p.context?.bridge || p.context?.tunnel) return centre;
  const gentlest = p.shifted.reduce<PointMetrics>((best, m) => (m && m.slopeDeg < best.slopeDeg ? m : best), centre);
  return gentlest.slopeDeg <= centre.slopeDeg - MIN_GENTLER_DEG ? gentlest : centre;
}

const UNSCORED = {
  score: null, rawScore: null, dropScore: null, viewScore: null, viewDepthM: null, context: null,
  scoreLow: null, scoreHigh: null, level: null, metrics: null,
};

/** Stand-in measurements for a no-go point that has no terrain data. */
const FLAT: PointMetrics = {
  elevation: 0, slopeDeg: 0, crossSlopeDeg: 0, fallLeft: 0, fallRight: 0, drop10: 0, drop30: 0, drop100: 0,
  dropLeft30: 0, dropRight30: 0, dropLeft10: 0, dropRight10: 0, dropLeft100: 0, dropRight100: 0, trackGradeDeg: 0, bridgeGap: 0,
};

export interface ScoreOptions {
  /** Settings for the stretches of a road route that are walked; defaults to `params`. */
  walkParams?: ScoreParams;
  /** Which kinds of transport are a no-go outright; defaults to all of them. */
  noGo?: NoGoSettings;
}

const ALL_NO_GO: NoGoSettings = { cableCars: true, funiculars: true, rackRailways: true };

/**
 * Turns measurements into scores, levels and flagged sections under the given
 * settings. `params` are those of the route's profile; they set the levels
 * and sectioning for the whole route.
 */
export function score(measurement: Measurement, params: ScoreParams = DEFAULT_PARAMS, options: ScoreOptions = {}): Analysis {
  const { spacingM: spacing, lengthM } = measurement;
  const noGo = options.noGo ?? ALL_NO_GO;
  const legs = measurement.legs ?? [{ mode: "hike" as const, label: "Hike", startM: 0, endM: lengthM }];
  const routeParams = params;
  let legIndex = 0;
  let view: View | null = null;

  const points: AnalysedPoint[] = measurement.points.map((p) => {
    const { dist, lon, lat, context } = p;
    while (legIndex < legs.length - 1 && dist > legs[legIndex].endM) legIndex++;
    const mode = legs[legIndex].mode;
    const params = mode === "walk" || mode === "hike" ? (options.walkParams ?? routeParams) : routeParams;
    // A road or rail point with no mapped road or track beside it means the
    // line from the routing service has strayed from where the vehicle really
    // runs, so the terrain measured there says nothing about the ride.
    const kind = TRAVEL_KIND[mode];
    const strayed = (kind === "road" || kind === "rail") && context !== null && !context.matched && !context.noGo;
    if (mode === "ferry" || strayed) return { ...UNSCORED, dist, lon, lat };
    if (context?.noGo && noGo[context.noGo]) {
      return { ...UNSCORED, dist, lon, lat, score: 100, rawScore: 100, dropScore: 100, context, scoreLow: 100, scoreHigh: 100, level: "red", metrics: p.metrics ?? FLAT };
    }
    if (!p.metrics) return { ...UNSCORED, dist, lon, lat };
    // The view is measured every so often; each point takes the latest one before it.
    if (p.view !== undefined) view = p.view;
    const viewScore = scoreView(view, params);
    // The terrain-only bridge guess is dropped where the map shows a path that is not a bridge.
    const disproved = context !== null && context.matched && !context.bridge;
    const settle = (m: PointMetrics) => (disproved ? { ...m, bridgeGap: 0 } : m);
    const metrics = settle(placed(p, kind === "road" || kind === "rail" || context?.wide === true));
    const rawScore = scorePoint(metrics, params);
    const dropScore = adjustScore(rawScore, context, params);
    // Whichever is worse decides: a wide view over a valley bothers on a safe path, and so does a drop in a forest.
    const adjusted = Math.max(dropScore, viewScore);
    // A view does not change if the line is a few metres off, so it sets a floor under every variant.
    const variants = [
      adjusted,
      ...p.shifted.flatMap((m) => (m ? [Math.max(adjustScore(scorePoint(settle(m), params), context, params), viewScore)] : [])),
    ];
    return {
      dist,
      lon,
      lat,
      score: adjusted,
      rawScore,
      dropScore,
      viewScore,
      viewDepthM: view ? viewDepth(view, params) : null,
      context,
      scoreLow: Math.min(...variants),
      scoreHigh: Math.max(...variants),
      level: levelOf(adjusted, routeParams),
      metrics,
    };
  });

  const headings = measurement.points.map((p) => p.heading);
  const runs = findRuns(points.map((p) => p.score), spacing, params);
  const sections = runs.map((run) =>
    buildSection(points, headings, run.start, run.end, run.peak, spacing, measurement.swiss, params),
  );

  // Length per level comes from the sections, so it matches what is listed.
  const lengthByLevelM = Object.fromEntries(LEVELS.map((level) => [level, 0])) as Record<Level, number>;
  for (const section of sections) lengthByLevelM[section.level] += section.lengthM;
  const noDataM = points.filter((p) => p.score === null).length * spacing;
  lengthByLevelM.green = Math.max(0, lengthM - noDataM - lengthByLevelM.yellow - lengthByLevelM.orange - lengthByLevelM.red);
  const maxScore = Math.max(0, ...sections.map((s) => s.maxScore));

  return {
    name: measurement.name,
    lengthM,
    spacingM: spacing,
    terrain: measurement.terrain,
    mapContext: measurement.mapContext,
    thresholds: params.thresholds,
    profile: measurement.profile ?? "hike",
    legs: legs.map((leg) =>
      TRAVEL_KIND[leg.mode] === "road" || TRAVEL_KIND[leg.mode] === "rail"
        ? { ...leg, sides: summariseSides(measurement, points, leg, params) }
        : leg,
    ),
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

/** Measures and scores in one go. */
export function analyseTrack(
  terrain: Terrain,
  track: TrackPoint[],
  projection: Projection,
  options: { name?: string | null; swiss?: boolean; params?: ScoreParams; context?: TerrainContext; measure?: MeasureParams } = {},
): Analysis {
  return score(measure(terrain, track, projection, { ...options, params: options.measure }), options.params);
}

