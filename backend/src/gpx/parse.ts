import { XMLParser } from "fast-xml-parser";

export interface GpxPoint {
  lon: number;
  lat: number;
}

export interface GpxTrack {
  name: string | null;
  points: GpxPoint[];
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

type RawPoint = { "@_lat"?: string; "@_lon"?: string };

function toPoints(raw: RawPoint[]): GpxPoint[] {
  const points: GpxPoint[] = [];
  for (const p of raw) {
    const lat = Number.parseFloat(p["@_lat"] ?? "");
    const lon = Number.parseFloat(p["@_lon"] ?? "");
    if (Number.isFinite(lat) && Number.isFinite(lon)) points.push({ lon, lat });
  }
  return points;
}

/**
 * Reads the line to analyse out of a GPX file: all track segments joined in
 * order, or the route points when the file has no track.
 */
export function parseGpx(xml: string): GpxTrack {
  const parser = new XMLParser({ ignoreAttributes: false, parseAttributeValue: false });
  const gpx = parser.parse(xml)?.gpx;
  if (!gpx) throw new Error("Not a GPX file (no <gpx> root element)");

  const tracks = asArray<{ name?: unknown; trkseg?: unknown }>(gpx.trk);
  const routes = asArray<{ name?: unknown; rtept?: unknown }>(gpx.rte);

  let points: GpxPoint[] = [];
  for (const trk of tracks) {
    for (const seg of asArray<{ trkpt?: RawPoint | RawPoint[] }>(trk.trkseg as never)) {
      points.push(...toPoints(asArray(seg.trkpt)));
    }
  }
  if (points.length === 0) {
    for (const rte of routes) points.push(...toPoints(asArray(rte.rtept as RawPoint | RawPoint[])));
  }
  if (points.length < 2) throw new Error("GPX file has no track or route with at least two points");

  // Some apps write an empty <name/>; the first name with any text in it wins.
  const name = [tracks[0]?.name, routes[0]?.name, gpx.metadata?.name]
    .map((candidate) => (candidate === undefined || candidate === null ? "" : String(candidate).trim()))
    .find((candidate) => candidate !== "");
  return { name: name ?? null, points };
}
