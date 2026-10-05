import type { Terrain } from "../terrain/grid.js";

// How much height a place shows you. Separate from how steep the ground
// beside the path is: a flat, safe path can still look out over a valley far
// below, and that view is what this measures.

/** Directions looked in, evenly round the compass starting at east and turning anticlockwise. */
export const VIEW_RAYS = 36;
/** How far the view is followed, metres. */
export const VIEW_RADIUS_M = 8000;
/** Depths are recorded for what is visible within each of these distances, metres. */
export const VIEW_BANDS_M = [500, 2000, VIEW_RADIUS_M];
const EYE_HEIGHT_M = 1.6;
/** Up to here the ground is read from the fine terrain beside the route; beyond, from the coarse far terrain. */
const NEAR_LIMIT_M = 200;
/** Samples start this close and move outward by this factor each time. */
const FIRST_SAMPLE_M = 1;
const SAMPLE_GROWTH = 1.07;
/** How fast the earth's surface falls away from a level line of sight, allowing for refraction. */
const CURVATURE = 0.87 / (2 * 6_371_000);

/**
 * What can be seen from one place: for each direction, how far below eye
 * level the lowest visible ground lies within each distance band. Ground
 * hidden behind nearer ground does not count, so standing back from an edge
 * shows less than standing on it. Depths are in whole metres, laid out as
 * `VIEW_RAYS` runs of `VIEW_BANDS_M.length` values.
 */
export function measureView(near: Terrain, far: Terrain, x: number, y: number): number[] | null {
  const ground = near.elevation(x, y);
  if (Number.isNaN(ground)) return null;
  const eye = ground + EYE_HEIGHT_M;
  const depths: number[] = [];

  for (let ray = 0; ray < VIEW_RAYS; ray++) {
    const angle = (ray / VIEW_RAYS) * 2 * Math.PI;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    // The steepest upward line of sight so far; anything below it is hidden.
    let horizon = -Infinity;
    let deepest = 0;
    let band = 0;
    for (let d = FIRST_SAMPLE_M; d <= VIEW_RADIUS_M; d *= SAMPLE_GROWTH) {
      while (d > VIEW_BANDS_M[band]) {
        depths.push(Math.round(deepest));
        band++;
      }
      let z = (d <= NEAR_LIMIT_M ? near : far).elevation(x + dx * d, y + dy * d);
      // Past the edge of the fine terrain the far terrain takes over; past that, the view ends.
      if (Number.isNaN(z) && d <= NEAR_LIMIT_M) z = far.elevation(x + dx * d, y + dy * d);
      if (Number.isNaN(z)) break;
      const below = eye - (z - d * d * CURVATURE);
      const slope = -below / d;
      if (slope >= horizon) {
        horizon = slope;
        if (below > deepest) deepest = below;
      }
    }
    while (band < VIEW_BANDS_M.length) {
      depths.push(Math.round(deepest));
      band++;
    }
  }
  return depths;
}
