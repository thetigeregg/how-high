import fs from "node:fs";
import { analyseGpx } from "./exposure/analyze.js";
import { parseGpx } from "./gpx/parse.js";

// Tuning tool: analyse one GPX file and print the flagged sections.
//   npm run analyze -- hike.gpx [--json out.json]

const args = process.argv.slice(2);
const jsonFlag = args.indexOf("--json");
const jsonOut = jsonFlag >= 0 ? args[jsonFlag + 1] : null;
const file = args.find((arg, i) => !arg.startsWith("--") && (jsonFlag < 0 || i !== jsonFlag + 1));

if (!file || (jsonFlag >= 0 && !jsonOut)) {
  console.error("Usage: npm run analyze -- <file.gpx> [--json <out.json>]");
  process.exit(1);
}

const km = (m: number) => (m / 1000).toFixed(2);

const analysis = await analyseGpx(parseGpx(fs.readFileSync(file, "utf-8")));
const { summary, terrain, sections } = analysis;

console.log(`\n${analysis.name ?? file} — ${km(analysis.lengthM)} km`);
console.log(`Terrain: ${terrain.source} (confidence: ${terrain.confidence})`);
console.log(`Overall: ${summary.level.toUpperCase()}, peak score ${summary.maxScore}/100`);
console.log(
  `Length by level: ${Object.entries(summary.lengthByLevelM)
    .map(([level, m]) => `${level} ${km(m)} km`)
    .join(", ")}${summary.noDataM > 0 ? `, no data ${km(summary.noDataM)} km` : ""}`,
);

if (sections.length === 0) {
  console.log("\nNo exposed sections found.");
} else {
  console.log("\nFlagged sections:");
  console.table(
    sections.map((s) => ({
      level: s.level,
      "km from": km(s.startM),
      "km to": km(s.endM),
      "length m": s.lengthM,
      score: s.maxScore,
      "at least": s.robustScore,
      "fall m": s.maxFallM,
      "drop in 30 m": s.maxDrop30M,
      "side slope °": s.maxCrossSlopeDeg,
      drop: `${s.side} (${s.dropTowards})`,
      bridge: s.possibleBridge ? "maybe" : "",
    })),
  );
  const worst = [...sections].sort((a, b) => b.maxScore - a.maxScore).slice(0, 5);
  console.log("Worst spots to look at:");
  for (const s of worst) console.log(`  km ${km(s.worst.dist)} (${s.level}): ${s.links.swisstopo ?? s.links.google}`);
}

if (jsonOut) {
  fs.writeFileSync(jsonOut, JSON.stringify(analysis));
  console.log(`\nFull result written to ${jsonOut}`);
}
