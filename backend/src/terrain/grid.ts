/** Bare-earth elevation lookup in the metric plane of the analysis. */
export interface Terrain {
  /** Human-readable data source, shown with the result. */
  source: string;
  /** Ground distance between elevation samples, meters. */
  cellSize: number;
  /** Elevation in meters, NaN where there is no data. */
  elevation(x: number, y: number): number;
}

/**
 * A single north-up raster. `originX`/`originY` are the outer corner of the
 * top-left cell; values sit at cell centers.
 */
export class GridTerrain implements Terrain {
  constructor(
    readonly source: string,
    readonly cellSize: number,
    private readonly originX: number,
    private readonly originY: number,
    private readonly width: number,
    private readonly height: number,
    private readonly data: Float32Array,
  ) {}

  elevation(x: number, y: number): number {
    const fx = (x - this.originX) / this.cellSize - 0.5;
    const fy = (this.originY - y) / this.cellSize - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    if (x0 < 0 || y0 < 0 || x0 + 1 >= this.width || y0 + 1 >= this.height) return Number.NaN;
    const i = y0 * this.width + x0;
    return bilinear(
      this.data[i],
      this.data[i + 1],
      this.data[i + this.width],
      this.data[i + this.width + 1],
      fx - x0,
      fy - y0,
    );
  }
}

export function bilinear(v00: number, v10: number, v01: number, v11: number, tx: number, ty: number): number {
  const top = v00 + (v10 - v00) * tx;
  const bottom = v01 + (v11 - v01) * tx;
  return top + (bottom - top) * ty;
}
