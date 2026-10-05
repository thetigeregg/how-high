import { describe, expect, it } from "vitest";
import type { Projection } from "../geo/projection.js";
import { resample } from "../gpx/resample.js";
import { measure, score, type Measurement } from "./analyze.js";
import { DEFAULT_PARAMS, type ScoreParams } from "./score.js";
import { misfit, stretchOf, tune } from "./tune.js";

const identity: Projection = { name: "test", forward: (x, y) => [x, y], inverse: (x, y) => [x, y] };
const tan = (deg: number) => Math.tan((deg * Math.PI) / 180);
/** A 400 m traverse of a uniform slope of the given steepness. */
const slope = (deg: number) =>
  measure({ source: "synthetic", cellSize: 2, elevation: (x) => 1000 - x * tan(deg) }, resample([[0, -200], [0, 200]], 5), identity);
const peakOf = (m: Measurement, params: ScoreParams) => Math.max(0, ...score(m, params).points.map((p) => p.score ?? 0));
const typicalOf = (m: Measurement, params: ScoreParams) => {
  const values = score(m, params).points.map((p) => p.score ?? 0).sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)];
};
const scoresOf = (m: Measurement, params: ScoreParams) => ({ peak: peakOf(m, params), typical: typicalOf(m, params) });

describe("misfit", () => {
  const levels: [number, number, number] = [25, 50, 75];
  const at = (score: number) => ({ peak: score, typical: score });

  it("is zero when a stretch scores as it was marked", () => {
    expect(misfit("fine", at(30), levels)).toBe(0);
    expect(misfit("uneasy", at(48), levels)).toBe(0);
    expect(misfit("bad", at(80), levels)).toBe(0);
    expect(misfit("turned_back", at(60), levels)).toBe(0);
  });

  it("grows with how far off the score is", () => {
    expect(misfit("fine", at(65), levels)).toBe(400);
    expect(misfit("bad", at(35), levels)).toBe(400);
    expect(misfit("uneasy", at(10), levels)).toBe(400);
    expect(misfit("uneasy", at(90), levels)).toBe(400);
  });

  it("holds a long stretch marked bad to being flagged along most of its length", () => {
    // Its worst spot is clearly Exposed, but its typical point scores 10: mostly shown as Easy.
    const mostlyEasy = { peak: 70, typical: 10 };
    expect(misfit("bad", mostlyEasy, levels)).toBe(0);
    expect(misfit("bad", mostlyEasy, levels, true)).toBe(400);
    expect(misfit("bad", { peak: 70, typical: 40 }, levels, true)).toBe(0);
    // Only "bad" says it was bad throughout; an uneasy stretch may have been so in places.
    expect(misfit("uneasy", { peak: 40, typical: 10 }, levels, true)).toBe(0);
  });
});

describe("tune", () => {
  it("leaves settings alone when the marks already fit", () => {
    const result = tune([{ kind: "bad", cause: null, long: false, measurement: slope(45) }, { kind: "fine", cause: null, long: false, measurement: slope(10) }], DEFAULT_PARAMS, scoresOf);
    expect(result.params).toBe(DEFAULT_PARAMS);
    expect(result.misfitBefore).toBe(0);
  });

  it("loosens the settings when a stretch marked fine scores too high", () => {
    const stretch = slope(32);
    expect(peakOf(stretch, DEFAULT_PARAMS)).toBeGreaterThan(50);
    const result = tune([{ kind: "fine", cause: null, long: false, measurement: stretch }], DEFAULT_PARAMS, scoresOf);
    expect(result.misfitAfter).toBeLessThan(result.misfitBefore);
    expect(peakOf(stretch, result.params)).toBeLessThan(peakOf(stretch, DEFAULT_PARAMS));
    // What it takes to count went up, and nothing moved by more than 40%.
    expect(result.params.drop100M[0]).toBeGreaterThan(DEFAULT_PARAMS.drop100M[0]);
    expect(result.params.drop100M[1]).toBeLessThanOrEqual(Math.round(DEFAULT_PARAMS.drop100M[1] * 1.4));
    expect(result.params.thresholds).toEqual(DEFAULT_PARAMS.thresholds);
  });

  it("tightens the settings when a stretch marked bad scores too low", () => {
    const stretch = slope(27);
    expect(peakOf(stretch, DEFAULT_PARAMS)).toBeLessThan(50);
    const result = tune([{ kind: "bad", cause: null, long: false, measurement: stretch }], DEFAULT_PARAMS, scoresOf);
    expect(peakOf(stretch, result.params)).toBeGreaterThan(peakOf(stretch, DEFAULT_PARAMS));
  });

  it("does not trade a mark that fits for one that does not", () => {
    // A steep stretch marked bad must stay flagged while a moderate one marked fine is brought down.
    const steep = slope(45);
    const result = tune([{ kind: "fine", cause: null, long: false, measurement: slope(32) }, { kind: "bad", cause: null, long: false, measurement: steep }], DEFAULT_PARAMS, scoresOf);
    expect(peakOf(steep, result.params)).toBeGreaterThanOrEqual(55);
    expect(result.misfitAfter).toBeLessThan(result.misfitBefore);
  });
});

describe("tune on a long stretch marked bad", () => {
  it("tightens the settings until most of the stretch is flagged, not just its worst spot", () => {
    // 600 m of a 24° slope, mild throughout, with one 40 m spot that is properly steep.
    const terrain = { source: "synthetic", cellSize: 2, elevation: (x: number, y: number) => 1000 - x * tan(Math.abs(y) < 20 ? 45 : 24) };
    const hillside = measure(terrain, resample([[0, -300], [0, 300]], 5), identity);
    const before = scoresOf(hillside, DEFAULT_PARAMS);
    expect(before.peak).toBeGreaterThan(55);
    expect(before.typical).toBeLessThan(30);
    // Judged by its worst spot alone the mark already fits, so nothing would change.
    expect(tune([{ kind: "bad", cause: null, long: false, measurement: hillside }], DEFAULT_PARAMS, scoresOf).params).toBe(DEFAULT_PARAMS);
    const result = tune([{ kind: "bad", cause: null, long: true, measurement: hillside }], DEFAULT_PARAMS, scoresOf);
    expect(scoresOf(hillside, result.params).typical).toBeGreaterThan(before.typical);
    expect(result.misfitAfter).toBeLessThan(result.misfitBefore);
  });
});

describe("tune with a stated cause", () => {
  // A flat path with a wide view 300 m down, which the default settings rate only mildly.
  const viewpoint = (): Measurement => {
    const flat = measure({ source: "synthetic", cellSize: 2, elevation: () => 1000 }, resample([[0, -200], [0, 200]], 5), identity);
    flat.points[0].view = { depths: Array.from({ length: 36 }, () => [0, 300, 300]).flat(), wooded: false };
    return flat;
  };
  const byCause = (m: Measurement, params: ScoreParams, cause: "drops" | "view" | null) => {
    const points = score(m, params).points;
    const pick = cause === "drops" ? "dropScore" : cause === "view" ? "viewScore" : "score";
    const peak = Math.max(0, ...points.map((p) => p[pick] ?? 0));
    return { peak, typical: peak };
  };

  it("moves the view settings for a stretch put down to the view, and leaves the drop settings alone", () => {
    const result = tune([{ kind: "bad", cause: "view", long: false, measurement: viewpoint() }], DEFAULT_PARAMS, byCause);
    expect(result.params.viewDepthM[1]).toBeLessThan(DEFAULT_PARAMS.viewDepthM[1]);
    expect(result.params.drop100M).toEqual(DEFAULT_PARAMS.drop100M);
    expect(result.params.fallHeightM).toEqual(DEFAULT_PARAMS.fallHeightM);
  });

  it("does not credit the view for a stretch put down to the drop", () => {
    // The view scores here, but the mark blames the drop, of which there is none: nothing can be fitted.
    const result = tune([{ kind: "bad", cause: "drops", long: false, measurement: viewpoint() }], DEFAULT_PARAMS, byCause);
    expect(result.params.viewDepthM).toEqual(DEFAULT_PARAMS.viewDepthM);
    expect(result.misfitAfter).toBe(result.misfitBefore);
  });
});

describe("stretchOf", () => {
  it("cuts out the points between two distances", () => {
    const stretch = stretchOf(slope(30), 100, 200)!;
    expect(stretch.points[0].dist).toBe(100);
    expect(stretch.points[stretch.points.length - 1].dist).toBe(200);
    expect(stretchOf(slope(30), 5000, 6000)).toBeNull();
  });

  it("carries the last view measured before the stretch into it", () => {
    const measured = slope(30);
    const view = { depths: [1, 2, 3], wooded: false };
    measured.points[10].view = view;
    expect(stretchOf(measured, 100, 200)!.points[0].view).toBe(view);
  });
});
