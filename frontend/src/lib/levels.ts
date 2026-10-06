import type { Analysis, Level } from "../types.js";

export const LEVELS: Level[] = ["green", "yellow", "orange", "red"];

export const LEVEL_LABEL: Record<Level, string> = {
  green: "Easy",
  yellow: "Mild",
  orange: "Exposed",
  red: "Severe",
};

// Status colors; always shown next to the label, never as the only cue.
export const LEVEL_COLOR: Record<Level, string> = {
  green: "#0ca30c",
  yellow: "#fab219",
  orange: "#ec835a",
  red: "#d03b3b",
};

export const NO_DATA_COLOR = "#8a8a8a";

export const km = (m: number, digits = 1) => `${(m / 1000).toFixed(digits)} km`;

/**
 * The level each point is drawn with: that of the flagged section it lies in,
 * green otherwise, null where there is no terrain data. Using sections rather
 * than raw per-point scores keeps the map and chart free of single-point noise.
 */
export function pointLevels(analysis: Analysis): Array<Level | null> {
  const levels: Array<Level | null> = analysis.points.map((p) => (p.score === null ? null : "green"));
  for (const section of analysis.sections) {
    const from = Math.round(section.startM / analysis.spacingM);
    const to = Math.round(section.endM / analysis.spacingM);
    for (let i = from; i <= to && i < levels.length; i++) {
      if (levels[i] !== null) levels[i] = section.level;
    }
  }
  return levels;
}
