import type { Measurement } from "../exposure/analyze.js";

const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Writes a measured route as a GPX file, for entries that were not made from
 * one (those from a Google Maps link). The line is the one that was measured,
 * a point every few metres, so a train leg follows the mapped track; each
 * point carries the terrain elevation found under it. One track per leg.
 */
export function writeGpx(measurement: Measurement, name: string, link: string | null): string {
  const legs = measurement.legs ?? [{ mode: "hike" as const, label: name, startM: 0, endM: measurement.lengthM }];
  const tracks = legs.map((leg, index) => {
    const points = measurement.points
      .filter((p) => p.dist >= leg.startM && p.dist <= leg.endM)
      .map((p) => {
        const ele = p.metrics ? `<ele>${p.metrics.elevation.toFixed(1)}</ele>` : "";
        return `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}">${ele}</trkpt>`;
      });
    // A single leg is the route itself; several are named for what each is.
    const trackName = legs.length === 1 ? name : `${index + 1}. ${leg.label}`;
    return `  <trk>\n    <name>${escape(trackName)}</name>\n    <trkseg>\n${points.join("\n")}\n    </trkseg>\n  </trk>`;
  });
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<gpx version="1.1" creator="How High" xmlns="http://www.topografix.com/GPX/1/1">`,
    `  <metadata>`,
    `    <name>${escape(name)}</name>`,
    ...(link ? [`    <link href="${escape(link)}"><text>Google Maps</text></link>`] : []),
    `  </metadata>`,
    ...tracks,
    `</gpx>`,
    "",
  ].join("\n");
}
