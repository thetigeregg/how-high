import type Database from "better-sqlite3";
import { z } from "zod";
import { DEFAULT_MEASURE, type MeasureParams } from "./exposure/metrics.js";
import { DEFAULT_PARAMS, DEFAULT_ROAD_PARAMS, type ScoreParams } from "./exposure/score.js";

/** Every tweakable knob. One set applies to all hikes. */
export interface Settings {
  /** Applied when scoring hikes and walked stretches; changes take effect immediately. */
  score: ScoreParams;
  /** The same knobs for stretches by car, bus and train. */
  road: ScoreParams;
  /** Applied when measuring; changes mean every hike is measured again. */
  measure: MeasureParams;
  /** Kinds of transport that make a route a no-go outright. */
  noGo: { cableCars: boolean; funiculars: boolean; rackRailways: boolean };
}

export const DEFAULT_SETTINGS: Settings = {
  score: DEFAULT_PARAMS,
  road: DEFAULT_ROAD_PARAMS,
  measure: DEFAULT_MEASURE,
  noGo: { cableCars: true, funiculars: true, rackRailways: true },
};

/** A [starts counting, counts fully] pair within the given bounds. */
const range = (min: number, max: number) =>
  z.tuple([z.number().min(min).max(max), z.number().min(min).max(max)]).refine(([low, high]) => low < high, {
    message: "the first value must be below the second",
  });

const scoreSchema = z.object({
    fallHeightM: range(0, 500),
    drop10M: range(0, 100),
    drop30M: range(0, 200),
    drop100M: range(0, 500),
    crossSlopeDeg: range(0, 89),
    trackGradeDeg: range(0, 89),
    bridgeGapM: range(0, 200),
    ridgeDropM: z.number().min(0).max(100),
    ridgeFactor: z.number().min(1).max(2),
    thresholds: z
      .tuple([z.number().min(1).max(100), z.number().min(1).max(100), z.number().min(1).max(100)])
      .refine(([yellow, orange, red]) => yellow < orange && orange < red, { message: "levels must be in rising order" }),
    forestFactor: z.number().min(0).max(1),
    wideTrackFactor: z.number().min(0).max(1),
    dropWeight: z.number().min(0).max(1),
    mergeGapM: z.number().min(0).max(500),
    minLengthM: z.number().min(0).max(500),
});

export const settingsSchema = z.object({
  score: scoreSchema,
  road: scoreSchema,
  measure: z.object({
    fallSlopeDeg: z.number().min(10).max(80),
    fallRunoutM: z.number().min(2).max(100),
    gpsErrorM: z.number().min(0).max(30),
    forestCheckM: z.number().min(2).max(100),
  }),
  noGo: z.object({ cableCars: z.boolean(), funiculars: z.boolean(), rackRailways: z.boolean() }),
});

export function loadSettings(db: Database.Database): Settings {
  const row = db.prepare("SELECT data FROM settings WHERE id = 1").get() as { data: string };
  const stored = JSON.parse(row.data) as Partial<Settings>;
  // Knobs added since the settings were last saved take their defaults.
  return {
    score: { ...DEFAULT_SETTINGS.score, ...stored.score },
    road: { ...DEFAULT_SETTINGS.road, ...stored.road },
    measure: { ...DEFAULT_SETTINGS.measure, ...stored.measure },
    noGo: { ...DEFAULT_SETTINGS.noGo, ...stored.noGo },
  };
}

export function saveSettings(db: Database.Database, settings: Settings) {
  db.prepare("UPDATE settings SET data = ? WHERE id = 1").run(JSON.stringify(settings));
}
