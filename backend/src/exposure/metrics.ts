import type { TrackPoint } from "../gpx/resample.js";
import type { Terrain } from "../terrain/grid.js";

/** Raw terrain measurements at one point of the track. All heights in metres. */
export interface PointMetrics {
  elevation: number;
  /** Steepness of the ground itself at the point. */
  slopeDeg: number;
  /** The part of that slope that runs across the direction of travel. */
  crossSlopeDeg: number;
  /** Height lost following the fall line from each side while it stays steep. */
  fallLeft: number;
  fallRight: number;
  /** Largest drop below the point within 10 / 30 / 100 m, to either side. */
  drop10: number;
  drop30: number;
  drop100: number;
  dropLeft30: number;
  dropRight30: number;
  /** The 10 m and 100 m drops for each side on its own. */
  dropLeft10: number;
  dropRight10: number;
  dropLeft100: number;
  dropRight100: number;
  /** Slope of the path itself; positive when climbing in the direction of travel. */
  trackGradeDeg: number;
  /** How far the ground dips under a straight span of track (bridge-like), else 0. */
  bridgeGap: number;
}

/** Knobs that change what is measured; altering them means measuring again. */
export interface MeasureParams {
  /** Ground steeper than this counts as "would keep falling", degrees. */
  fallSlopeDeg: number;
  /** A fall ends once this much gentler ground has been crossed, metres. */
  fallRunoutM: number;
  /** Assumed sideways GPS error the score is re-tested against, metres. */
  gpsErrorM: number;
  /** How far to the exposed side the ground must still be wooded to count as forest, metres. */
  forestCheckM: number;
}

export const DEFAULT_MEASURE: MeasureParams = {
  fallSlopeDeg: 35,
  fallRunoutM: 8,
  gpsErrorM: 5,
  forestCheckM: 20,
};

const DEG = Math.PI / 180;

/** Where the fall line starts, sideways from the track centre. */
const FALL_START_OFFSET_M = 3;
const FALL_MAX_PATH_M = 400;

const RAY_COUNT = 16;
const RAY_LENGTH_M = 100;
const FAR_DROP_MIN_NEAR_M = 5;

const GRADE_WINDOW_M = 10;
const BRIDGE_HALF_SPANS_M = [10, 20, 40, 80];
const BRIDGE_MIN_GAP_M = 4;
/** Paths rarely dip this steeply and climb straight back out; bridges do. */
const BRIDGE_MIN_GAP_RATIO = 0.3;
const BRIDGE_MIN_STRAIGHTNESS = 0.9;

function gradient(terrain: Terrain, x: number, y: number, h: number): [number, number] | null {
  const gx = (terrain.elevation(x + h, y) - terrain.elevation(x - h, y)) / (2 * h);
  const gy = (terrain.elevation(x, y + h) - terrain.elevation(x, y - h)) / (2 * h);
  return Number.isNaN(gx) || Number.isNaN(gy) ? null : [gx, gy];
}

/**
 * Follows the line of steepest descent starting just off one side of the
 * track and returns the height lost before the ground eases off.
 */
function fallHeight(terrain: Terrain, x: number, y: number, z0: number, nx: number, ny: number, params: MeasureParams): number {
  const fallSlope = Math.tan(params.fallSlopeDeg * DEG);
  const step = terrain.cellSize;
  let px = x + nx * FALL_START_OFFSET_M;
  let py = y + ny * FALL_START_OFFSET_M;
  let z = terrain.elevation(px, py);
  // Ground rising on this side: nothing to fall down.
  if (Number.isNaN(z) || z > z0 + 1) return 0;

  let lowestSteep = z0;
  let gentleRun = 0;
  for (let travelled = 0; travelled < FALL_MAX_PATH_M; travelled += step) {
    const g = gradient(terrain, px, py, step);
    if (!g) break;
    const slope = Math.hypot(g[0], g[1]);
    if (slope < 1e-3) break;
    px -= (g[0] / slope) * step;
    py -= (g[1] / slope) * step;
    const next = terrain.elevation(px, py);
    if (Number.isNaN(next) || next >= z) break;
    z = next;
    if (slope >= fallSlope) {
      gentleRun = 0;
      lowestSteep = z;
    } else {
      gentleRun += step;
      if (gentleRun >= params.fallRunoutM) break;
    }
  }
  return Math.max(0, z0 - lowestSteep);
}

type LocalMetrics = Omit<PointMetrics, "trackGradeDeg" | "bridgeGap">;

/** Everything that depends only on the terrain around one position and heading. */
export function measurePoint(
  terrain: Terrain,
  x: number,
  y: number,
  tx: number,
  ty: number,
  params: MeasureParams = DEFAULT_MEASURE,
): LocalMetrics | null {
  const z0 = terrain.elevation(x, y);
  const g = gradient(terrain, x, y, Math.max(5, terrain.cellSize));
  if (Number.isNaN(z0) || !g) return null;

  // Left of the direction of travel.
  const nx = -ty;
  const ny = tx;

  // Largest drop within 10, 30 and 100 m, kept separately for the left and right side.
  const drops = { left: [0, 0, 0], right: [0, 0, 0] };
  const step = terrain.cellSize;
  for (let k = 1; k < RAY_COUNT; k++) {
    // Straight ahead and straight behind are the path itself, not exposure.
    if (k === RAY_COUNT / 2) continue;
    const angle = (k / RAY_COUNT) * 2 * Math.PI;
    const dx = tx * Math.cos(angle) - ty * Math.sin(angle);
    const dy = tx * Math.sin(angle) + ty * Math.cos(angle);
    const side = k < RAY_COUNT / 2 ? drops.left : drops.right;
    let fallsAway = false;
    for (let d = step; d <= RAY_LENGTH_M; d += step) {
      const z = terrain.elevation(x + dx * d, y + dy * d);
      if (Number.isNaN(z)) break;
      const drop = z0 - z;
      // A far drop only counts if the ground is already falling away nearby;
      // a cliff beyond 30 m of flat ground is not exposure.
      if (d <= 30 && drop >= FAR_DROP_MIN_NEAR_M) fallsAway = true;
      if (drop > side[2] && (d <= 30 || fallsAway)) side[2] = drop;
      if (d <= 30 && drop > side[1]) side[1] = drop;
      if (d <= 10 && drop > side[0]) side[0] = drop;
    }
  }

  return {
    elevation: z0,
    slopeDeg: Math.atan(Math.hypot(g[0], g[1])) / DEG,
    crossSlopeDeg: Math.atan(Math.abs(g[0] * nx + g[1] * ny)) / DEG,
    fallLeft: fallHeight(terrain, x, y, z0, nx, ny, params),
    fallRight: fallHeight(terrain, x, y, z0, -nx, -ny, params),
    drop10: Math.max(drops.left[0], drops.right[0]),
    drop30: Math.max(drops.left[1], drops.right[1]),
    drop100: Math.max(drops.left[2], drops.right[2]),
    dropLeft30: drops.left[1],
    dropRight30: drops.right[1],
    dropLeft10: drops.left[0],
    dropRight10: drops.right[0],
    dropLeft100: drops.left[2],
    dropRight100: drops.right[2],
  };
}

/**
 * Measures every point of a resampled track. `lateralOffset` shifts the whole
 * track sideways (positive = left), used to test sensitivity to GPS error.
 * Points without terrain data come back as null.
 */
export function measureTrack(
  terrain: Terrain,
  track: TrackPoint[],
  lateralOffset = 0,
  params: MeasureParams = DEFAULT_MEASURE,
): Array<PointMetrics | null> {
  const spacing = track.length > 1 ? track[1].dist - track[0].dist : 1;
  const xs = track.map((p) => p.x - p.ty * lateralOffset);
  const ys = track.map((p) => p.y + p.tx * lateralOffset);
  const local = track.map((p, i) => measurePoint(terrain, xs[i], ys[i], p.tx, p.ty, params));
  const z = (i: number) => local[i]?.elevation ?? Number.NaN;

  const gradeSpan = Math.max(1, Math.round(GRADE_WINDOW_M / spacing));
  return local.map((m, i) => {
    if (!m) return null;

    const a = Math.max(0, i - gradeSpan);
    const b = Math.min(track.length - 1, i + gradeSpan);
    const rise = z(b) - z(a);
    const trackGradeDeg = Number.isNaN(rise) || a === b ? 0 : Math.atan(rise / ((b - a) * spacing)) / DEG;

    let bridgeGap = 0;
    for (const half of BRIDGE_HALF_SPANS_M) {
      const k = Math.round(half / spacing);
      if (k < 1 || i - k < 0 || i + k >= track.length) continue;
      const gap = (z(i - k) + z(i + k)) / 2 - m.elevation;
      const chord = Math.hypot(xs[i + k] - xs[i - k], ys[i + k] - ys[i - k]);
      const straight = chord / (2 * k * spacing) >= BRIDGE_MIN_STRAIGHTNESS;
      if (straight && gap >= BRIDGE_MIN_GAP_M && gap / half >= BRIDGE_MIN_GAP_RATIO && gap > bridgeGap) {
        bridgeGap = gap;
      }
    }
    return { ...m, trackGradeDeg, bridgeGap };
  });
}
