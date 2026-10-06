export interface TrackPoint {
  x: number;
  y: number;
  /** Distance from the start along the track, meters. */
  dist: number;
  /** Unit vector in the direction of travel. */
  tx: number;
  ty: number;
}

/** Half-width of the window the direction of travel is measured over, meters. */
const HEADING_WINDOW_M = 10;

/**
 * Re-spaces a polyline (metric coordinates) to one point every `spacing`
 * meters, so every metric downstream is per-distance rather than per-GPS-fix.
 */
export function resample(line: Array<[number, number]>, spacing: number): TrackPoint[] {
  const cleaned: Array<[number, number]> = [];
  for (const p of line) {
    const last = cleaned[cleaned.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.01) cleaned.push(p);
  }
  if (cleaned.length < 2) throw new Error("Track has no length");

  const positions: Array<[number, number]> = [cleaned[0]];
  let carried = 0;
  for (let i = 1; i < cleaned.length; i++) {
    const [ax, ay] = cleaned[i - 1];
    const [bx, by] = cleaned[i];
    const segment = Math.hypot(bx - ax, by - ay);
    let along = spacing - carried;
    while (along <= segment) {
      const t = along / segment;
      positions.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
      along += spacing;
    }
    carried = (carried + segment) % spacing;
  }

  const span = Math.max(1, Math.round(HEADING_WINDOW_M / spacing));
  return positions.map(([x, y], i) => {
    const a = positions[Math.max(0, i - span)];
    const b = positions[Math.min(positions.length - 1, i + span)];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return { x, y, dist: i * spacing, tx: (b[0] - a[0]) / len, ty: (b[1] - a[1]) / len };
  });
}
