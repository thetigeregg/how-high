import type { GpxPoint } from "../gpx/parse.js";
import type { OsmElement } from "./context.js";

// The line a routing service draws for a train is often a rough sketch that
// cuts across the terrain. What is reliable is where the ride starts and
// ends, so the real course is found by following mapped track between the two.

/** A station further than this from any mapped track means the map does not cover it. */
const MAX_STATION_OFFSET_M = 400;
/** The sketch is sampled this densely to judge how far a piece of track lies from it. */
const SKETCH_STEP_M = 200;
/**
 * Track far from the sketch costs more, so that between two lines joining the
 * same stations the one the sketch runs along wins. Every this many metres
 * away adds the track's own length again; the detour must be worth it.
 */
const STRAY_SCALE_M = 1500;
/** A result this much shorter or longer than the sketch is not the same ride. */
const LENGTH_RATIO = { min: 0.7, max: 4 };

const EARTH_M = 111_320;

interface Node {
  x: number;
  y: number;
  lat: number;
  lon: number;
  edges: number[];
}

/** Binary min-heap of [cost, node index]. */
class Queue {
  private readonly items: Array<[number, number]> = [];

  get size() {
    return this.items.length;
  }

  push(item: [number, number]) {
    const items = this.items;
    items.push(item);
    for (let i = items.length - 1; i > 0; ) {
      const parent = (i - 1) >> 1;
      if (items[parent][0] <= items[i][0]) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }

  pop(): [number, number] {
    const items = this.items;
    const top = items[0];
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      for (let i = 0; ; ) {
        const left = 2 * i + 1;
        const right = left + 1;
        let least = i;
        if (left < items.length && items[left][0] < items[least][0]) least = left;
        if (right < items.length && items[right][0] < items[least][0]) least = right;
        if (least === i) break;
        [items[least], items[i]] = [items[i], items[least]];
        i = least;
      }
    }
    return top;
  }
}

/**
 * The course of a train ride along mapped track, given the rough line from
 * the routing service and the railway ways around it. Returns null when the
 * map has no connected track between the two ends, or what it finds is too
 * unlike the sketch to be the same ride.
 */
export function followTrack(sketch: GpxPoint[], railways: OsmElement[]): GpxPoint[] | null {
  if (sketch.length < 2) return null;
  // Plain metres east and north of the first point; accurate enough over one ride.
  const lat0 = sketch[0].lat;
  const scaleX = EARTH_M * Math.cos((lat0 * Math.PI) / 180);
  const toXY = (p: GpxPoint): [number, number] => [(p.lon - sketch[0].lon) * scaleX, (p.lat - lat0) * EARTH_M];

  // The sketch, densified and bucketed, for "how far is this point from it".
  const cell = 2 * SKETCH_STEP_M;
  const buckets = new Map<string, Array<[number, number]>>();
  let sketchLength = 0;
  for (let i = 1; i < sketch.length; i++) {
    const [ax, ay] = toXY(sketch[i - 1]);
    const [bx, by] = toXY(sketch[i]);
    const length = Math.hypot(bx - ax, by - ay);
    sketchLength += length;
    const steps = Math.max(1, Math.ceil(length / SKETCH_STEP_M));
    for (let s = 0; s <= steps; s++) {
      const x = ax + ((bx - ax) * s) / steps;
      const y = ay + ((by - ay) * s) / steps;
      const key = `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
      const bucket = buckets.get(key);
      if (bucket) bucket.push([x, y]);
      else buckets.set(key, [[x, y]]);
    }
  }
  /** Distance to the sketch, looked for in widening rings and capped once it stops mattering. */
  const stray = (x: number, y: number): number => {
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    let best = Infinity;
    for (let ring = 0; ring <= 8; ring++) {
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          for (const [px, py] of buckets.get(`${cx + dx},${cy + dy}`) ?? []) {
            best = Math.min(best, Math.hypot(px - x, py - y));
          }
        }
      }
      if (best <= ring * cell) break;
    }
    return Math.min(best, 8 * cell);
  };

  // The track network: one node per map node, joined along each way.
  const index = new Map<number, number>();
  const nodes: Node[] = [];
  for (const way of railways) {
    if (way.type !== "way" || !way.nodes || !way.geometry) continue;
    let previous = -1;
    for (let i = 0; i < way.nodes.length; i++) {
      const at = way.geometry[i];
      if (!at) {
        previous = -1;
        continue;
      }
      let node = index.get(way.nodes[i]);
      if (node === undefined) {
        const [x, y] = toXY(at);
        node = nodes.push({ x, y, lat: at.lat, lon: at.lon, edges: [] }) - 1;
        index.set(way.nodes[i], node);
      }
      if (previous >= 0 && previous !== node) {
        nodes[previous].edges.push(node);
        nodes[node].edges.push(previous);
      }
      previous = node;
    }
  }
  if (nodes.length === 0) return null;

  const nearest = ([x, y]: [number, number]): number | null => {
    let best = -1;
    let bestDist = MAX_STATION_OFFSET_M;
    nodes.forEach((n, i) => {
      const d = Math.hypot(n.x - x, n.y - y);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    return best >= 0 ? best : null;
  };
  const start = nearest(toXY(sketch[0]));
  const end = nearest(toXY(sketch[sketch.length - 1]));
  if (start === null || end === null || start === end) return null;

  // Cheapest way along the track from one end to the other.
  const cost = new Float64Array(nodes.length).fill(Infinity);
  const from = new Int32Array(nodes.length).fill(-1);
  const strayOf = new Float64Array(nodes.length).fill(-1);
  const strayAt = (i: number) => (strayOf[i] >= 0 ? strayOf[i] : (strayOf[i] = stray(nodes[i].x, nodes[i].y)));
  const queue = new Queue();
  cost[start] = 0;
  queue.push([0, start]);
  while (queue.size > 0) {
    const [c, u] = queue.pop();
    if (u === end) break;
    if (c > cost[u]) continue;
    for (const v of nodes[u].edges) {
      const length = Math.hypot(nodes[v].x - nodes[u].x, nodes[v].y - nodes[u].y);
      const next = c + length * (1 + (strayAt(u) + strayAt(v)) / 2 / STRAY_SCALE_M);
      if (next < cost[v]) {
        cost[v] = next;
        from[v] = u;
        queue.push([next, v]);
      }
    }
  }
  if (cost[end] === Infinity) return null;

  const course: GpxPoint[] = [];
  let length = 0;
  for (let at = end; at >= 0; at = from[at]) {
    course.push({ lat: nodes[at].lat, lon: nodes[at].lon });
    if (from[at] >= 0) length += Math.hypot(nodes[at].x - nodes[from[at]].x, nodes[at].y - nodes[from[at]].y);
  }
  if (length < sketchLength * LENGTH_RATIO.min || length > sketchLength * LENGTH_RATIO.max) return null;
  return course.reverse();
}
