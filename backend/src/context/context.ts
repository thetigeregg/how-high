import type { Projection } from "../geo/projection.js";

/** What the map says about the path a point lies on. */
export interface PathInfo {
  tunnel: boolean;
  bridge: boolean;
  /** Vehicle-width way: forestry track, road, or a path mapped at 2.5 m or wider. */
  wide: boolean;
  /** SAC hiking grade 1–6 (T1–T6) when mapped, else null. */
  sacGrade: number | null;
  /** Ladders, fixed ropes or via ferrata. */
  aided: boolean;
  /** Railway with a rack rail (cog railway). */
  rack: boolean;
  funicular: boolean;
}

/** Which mapped ways a point is matched against, by how the stretch is traveled. */
export type TravelKind = "foot" | "road" | "rail";

/** Map knowledge the terrain model cannot see, in the metric plane of the analysis. */
export interface TerrainContext {
  inForest(x: number, y: number): boolean;
  /** The mapped way of the given kind nearest to the point, or null when none is close. */
  pathAt(x: number, y: number, kind?: TravelKind): PathInfo | null;
  /** Whether a mapped cliff line runs right next to the point. */
  cliffNear(x: number, y: number): boolean;
}

/** The parts of an OpenStreetMap element (as returned by Overpass `out geom`) used here. */
export interface OsmElement {
  type: "way" | "relation";
  tags?: Record<string, string>;
  /** Node ids of a way, parallel to `geometry`. */
  nodes?: number[];
  // Overpass leaves null gaps where a node lies outside what it returned.
  geometry?: Array<{ lat: number; lon: number } | null>;
  members?: Array<{ type: string; role: string; geometry?: Array<{ lat: number; lon: number } | null> }>;
}

type Line = Array<[number, number]>;

const FOREST_CELL_M = 5;
const INDEX_CELL_M = 50;
/** A mapped way further than this from the line is some other path. */
const MATCH_RADIUS_M: Record<TravelKind, number> = { foot: 15, road: 25, rail: 30 };

const SAC_GRADES: Record<string, number> = {
  hiking: 1,
  mountain_hiking: 2,
  demanding_mountain_hiking: 3,
  alpine_hiking: 4,
  demanding_alpine_hiking: 5,
  difficult_alpine_hiking: 6,
};
const WIDE_HIGHWAYS = new Set([
  "track", "service", "unclassified", "residential", "living_street", "pedestrian",
  "tertiary", "secondary", "primary", "trunk", "cycleway",
]);
/** Ways a car or bus can be on. */
const ROADS = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|road)(_link)?$/;

function describePath(tags: Record<string, string>): PathInfo {
  const set = (key: string) => tags[key] !== undefined && tags[key] !== "no";
  const width = Number.parseFloat(tags.width ?? "");
  return {
    tunnel: set("tunnel") || tags.covered === "yes",
    bridge: set("bridge"),
    wide: WIDE_HIGHWAYS.has(tags.highway) || ROADS.test(tags.highway ?? "") || width >= 2.5,
    sacGrade: SAC_GRADES[tags.sac_scale] ?? null,
    aided: tags.highway === "via_ferrata" || set("via_ferrata_scale") || set("safety_rope") || set("ladder") || set("assisted_trail"),
    rack: set("rack"),
    funicular: tags.railway === "funicular",
  };
}

/** Area mask filled by the even-odd rule, so holes and unordered ring pieces just work. */
class Mask {
  private readonly data: Uint8Array;
  private readonly width: number;
  private readonly height: number;

  constructor(private readonly minX: number, private readonly minY: number, maxX: number, maxY: number) {
    this.width = Math.ceil((maxX - minX) / FOREST_CELL_M);
    this.height = Math.ceil((maxY - minY) / FOREST_CELL_M);
    this.data = new Uint8Array(this.width * this.height);
  }

  /** Fills one area given as the lines that together form its outer and inner rings. */
  fill(lines: Line[]) {
    const crossings = new Map<number, number[]>();
    for (const line of lines) {
      for (let i = 1; i < line.length; i++) {
        const [ax, ay] = line[i - 1];
        const [bx, by] = line[i];
        if (ay === by) continue;
        const low = Math.min(ay, by);
        const high = Math.max(ay, by);
        // Rows whose center lies in [low, high).
        const first = Math.max(0, Math.ceil((low - this.minY) / FOREST_CELL_M - 0.5));
        const last = Math.min(this.height - 1, Math.ceil((high - this.minY) / FOREST_CELL_M - 0.5) - 1);
        for (let row = first; row <= last; row++) {
          const y = this.minY + (row + 0.5) * FOREST_CELL_M;
          const x = ax + ((y - ay) / (by - ay)) * (bx - ax);
          const list = crossings.get(row);
          if (list) list.push(x);
          else crossings.set(row, [x]);
        }
      }
    }
    for (const [row, xs] of crossings) {
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const from = Math.max(0, Math.ceil((xs[i] - this.minX) / FOREST_CELL_M - 0.5));
        const to = Math.min(this.width - 1, Math.ceil((xs[i + 1] - this.minX) / FOREST_CELL_M - 0.5) - 1);
        if (to >= from) this.data.fill(1, row * this.width + from, row * this.width + to + 1);
      }
    }
  }

  at(x: number, y: number): boolean {
    const col = Math.floor((x - this.minX) / FOREST_CELL_M);
    const row = Math.floor((y - this.minY) / FOREST_CELL_M);
    return col >= 0 && row >= 0 && col < this.width && row < this.height && this.data[row * this.width + col] === 1;
  }
}

/** Line segments bucketed on a coarse grid for nearest-segment lookups. */
class SegmentIndex<T> {
  private readonly cells = new Map<string, Array<{ ax: number; ay: number; bx: number; by: number; value: T }>>();

  add(line: Line, value: T) {
    for (let i = 1; i < line.length; i++) {
      const [ax, ay] = line[i - 1];
      const [bx, by] = line[i];
      const segment = { ax, ay, bx, by, value };
      const x0 = Math.floor(Math.min(ax, bx) / INDEX_CELL_M);
      const x1 = Math.floor(Math.max(ax, bx) / INDEX_CELL_M);
      const y0 = Math.floor(Math.min(ay, by) / INDEX_CELL_M);
      const y1 = Math.floor(Math.max(ay, by) / INDEX_CELL_M);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cy = y0; cy <= y1; cy++) {
          const key = `${cx},${cy}`;
          const cell = this.cells.get(key);
          if (cell) cell.push(segment);
          else this.cells.set(key, [segment]);
        }
      }
    }
  }

  /** Value and distance of the segment nearest to the point, if one lies within the radius. */
  nearest(x: number, y: number, radius: number): { value: T; dist: number } | null {
    let best: { value: T; dist: number } | null = null;
    let bestDist = radius;
    const cx = Math.floor(x / INDEX_CELL_M);
    const cy = Math.floor(y / INDEX_CELL_M);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const s of this.cells.get(`${cx + dx},${cy + dy}`) ?? []) {
          const vx = s.bx - s.ax;
          const vy = s.by - s.ay;
          const t = Math.min(1, Math.max(0, ((x - s.ax) * vx + (y - s.ay) * vy) / (vx * vx + vy * vy || 1)));
          const dist = Math.hypot(x - (s.ax + vx * t), y - (s.ay + vy * t));
          if (dist <= bestDist) {
            bestDist = dist;
            best = { value: s.value, dist };
          }
        }
      }
    }
    return best;
  }
}

/** Turns raw OpenStreetMap elements into fast lookups over the given metric bounds. */
export function buildContext(
  elements: OsmElement[],
  projection: Projection,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
): TerrainContext {
  const project = (geometry: Array<{ lat: number; lon: number } | null>): Line =>
    geometry.flatMap((node) => (node ? [projection.forward(node.lon, node.lat)] : []));

  const forest = new Mask(bounds.minX, bounds.minY, bounds.maxX, bounds.maxY);
  const paths = new SegmentIndex<PathInfo>();
  const roads = new SegmentIndex<PathInfo>();
  const rails = new SegmentIndex<PathInfo>();
  const cliffs = new SegmentIndex<true>();

  for (const element of elements) {
    const tags = element.tags ?? {};
    if (tags.landuse === "forest" || tags.natural === "wood") {
      const lines = element.geometry
        ? [project(element.geometry)]
        : (element.members ?? []).flatMap((m) => (m.type === "way" && m.geometry ? [project(m.geometry)] : []));
      forest.fill(lines);
    } else if (element.geometry && tags.natural === "cliff") {
      cliffs.add(project(element.geometry), true);
    } else if (element.geometry && tags.railway) {
      rails.add(project(element.geometry), describePath(tags));
    } else if (element.geometry && tags.highway) {
      (ROADS.test(tags.highway) ? roads : paths).add(project(element.geometry), describePath(tags));
    }
  }

  return {
    inForest: (x, y) => forest.at(x, y),
    pathAt: (x, y, kind = "foot") => {
      const radius = MATCH_RADIUS_M[kind];
      if (kind === "rail") return rails.nearest(x, y, radius)?.value ?? null;
      if (kind === "road") return roads.nearest(x, y, radius)?.value ?? null;
      // On foot any mapped way will do; take whichever is closer.
      const path = paths.nearest(x, y, radius);
      const road = roads.nearest(x, y, radius);
      return (path && road ? (path.dist <= road.dist ? path : road) : (path ?? road))?.value ?? null;
    },
    cliffNear: (x, y) => cliffs.nearest(x, y, MATCH_RADIUS_M.foot) !== null,
  };
}
