import { describe, expect, it } from "vitest";
import type { Terrain } from "../terrain/grid.js";
import { DEFAULT_PARAMS, DEFAULT_ROAD_PARAMS, scoreView, viewDepth } from "./score.js";
import { measureView, VIEW_BANDS_M, VIEW_RAYS } from "./view.js";

const ground = (elevation: (x: number, y: number) => number): Terrain => ({ source: "synthetic", cellSize: 2, elevation });
// A plateau at 1000 m that breaks off at x = 0 into a valley 500 m below.
const rim = ground((x) => (x < 0 ? 1000 : Math.max(500, 1000 - x * 10)));
const view = (terrain: Terrain, x: number) => ({ depths: measureView(terrain, terrain, x, 0)!, wooded: false });
/** Depth seen in one compass direction within 2 km; rays start at east and turn anticlockwise. */
const towards = (depths: number[], degrees: number) => depths[(degrees / 10) * VIEW_BANDS_M.length + 1];

describe("measureView", () => {
  it("sees down into the valley from the rim, and only on that side", () => {
    const { depths } = view(rim, -2);
    expect(depths).toHaveLength(VIEW_RAYS * VIEW_BANDS_M.length);
    expect(towards(depths, 0)).toBeGreaterThan(450);
    expect(towards(depths, 180)).toBeLessThan(5);
  });

  it("sees nothing of the valley from well back on the plateau", () => {
    expect(towards(view(rim, -100).depths, 0)).toBeLessThan(5);
  });

  it("records what is near separately from what is far", () => {
    // The valley floor only comes into view some 600 m out, past the foot of the slope.
    const { depths } = view(rim, -2);
    expect(depths[0]).toBeLessThan(depths[1]);
    expect(depths[1]).toBeLessThanOrEqual(depths[2]);
  });

  it("returns nothing where there is no ground to stand on", () => {
    expect(measureView(ground(() => Number.NaN), rim, 0, 0)).toBeNull();
  });
});

describe("scoreView", () => {
  it("rates a wide deep view highly and a closed-in spot not at all", () => {
    expect(viewDepth(view(rim, -2))).toBeGreaterThan(450);
    expect(scoreView(view(rim, -2))).toBe(100);
    expect(scoreView(view(rim, -100))).toBe(0);
    expect(scoreView(view(ground(() => 1000), 0))).toBe(0);
  });

  it("needs the view to be wide, not a glimpse", () => {
    // A slot 20 m wide cut into the plateau: deep, but seen in one direction only.
    const slot = ground((x, y) => (x > 0 && Math.abs(y) < 10 ? Math.max(500, 1000 - x * 10) : 1000));
    expect(scoreView(view(slot, -2))).toBe(0);
    expect(scoreView(view(slot, -2), { ...DEFAULT_PARAMS, viewArcDeg: 10 })).toBeGreaterThan(0);
  });

  it("counts less under trees, and not at all where views are switched off", () => {
    const open = view(rim, -2);
    expect(scoreView({ ...open, wooded: true })).toBe(50);
    expect(scoreView(open, DEFAULT_ROAD_PARAMS)).toBe(0);
    expect(scoreView(null)).toBe(0);
  });

  it("counts distant ground for less than ground nearby", () => {
    // The same 400 m of depth, once within 2 km and once only beyond it.
    const near = { depths: Array.from({ length: VIEW_RAYS }, () => [0, 400, 400]).flat(), wooded: false };
    const far = { depths: Array.from({ length: VIEW_RAYS }, () => [0, 0, 400]).flat(), wooded: false };
    expect(viewDepth(near)).toBe(400);
    expect(viewDepth(far)).toBe(200);
  });
});
