import { config } from "../config.js";
import type { LegMode } from "../exposure/analyze.js";
import type { RouteSource, SourceLeg } from "../exposure/pipeline.js";
import type { NoGoKind } from "../exposure/score.js";
import type { GpxPoint } from "../gpx/parse.js";
import type { Directions, Stop, TravelMode } from "./link.js";

const ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";
const FIELDS = [
  "routes.polyline.encodedPolyline",
  "routes.legs.steps.travelMode",
  "routes.legs.steps.polyline.encodedPolyline",
  "routes.legs.steps.transitDetails.transitLine.vehicle.type",
  "routes.legs.steps.transitDetails.transitLine.nameShort",
  "routes.legs.steps.transitDetails.transitLine.name",
  "routes.legs.steps.transitDetails.stopDetails.departureStop.name",
  "routes.legs.steps.transitDetails.stopDetails.arrivalStop.name",
].join(",");

// How each Google vehicle type is travelled, what to call it, and whether it is a no-go kind.
const VEHICLES: Record<string, { mode: LegMode; word: string; noGo?: NoGoKind }> = {
  BUS: { mode: "bus", word: "Bus" },
  INTERCITY_BUS: { mode: "bus", word: "Bus" },
  TROLLEYBUS: { mode: "bus", word: "Bus" },
  SHARE_TAXI: { mode: "bus", word: "Bus" },
  CABLE_CAR: { mode: "lift", word: "Cable car", noGo: "cableCars" },
  GONDOLA_LIFT: { mode: "lift", word: "Gondola", noGo: "cableCars" },
  FUNICULAR: { mode: "rail", word: "Funicular", noGo: "funiculars" },
  FERRY: { mode: "ferry", word: "Ferry" },
  TRAM: { mode: "rail", word: "Tram" },
};
const TRAIN = { mode: "rail" as LegMode, word: "Train" };

interface ApiStep {
  travelMode?: string;
  polyline?: { encodedPolyline?: string };
  transitDetails?: {
    transitLine?: { vehicle?: { type?: string }; nameShort?: string; name?: string };
    stopDetails?: { departureStop?: { name?: string }; arrivalStop?: { name?: string } };
  };
}

/** Decodes Google's encoded polyline format into lon/lat points. */
export function decodePolyline(encoded: string): GpxPoint[] {
  const points: GpxPoint[] = [];
  let index = 0, lat = 0, lon = 0;
  const next = () => {
    let result = 0, shift = 0, byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    lat += next();
    lon += next();
    points.push({ lat: lat / 1e5, lon: lon / 1e5 });
  }
  return points;
}

const waypoint = (stop: Stop) =>
  stop.latLng
    ? { location: { latLng: { latitude: stop.latLng[0], longitude: stop.latLng[1] } } }
    : { address: stop.label };

const short = (label: string) => label.split(",")[0].trim();

/** Turns the steps of a public-transport route into legs, joining consecutive walking steps. */
export function transitLegs(steps: ApiStep[]): SourceLeg[] {
  const legs: SourceLeg[] = [];
  for (const step of steps) {
    const points = decodePolyline(step.polyline?.encodedPolyline ?? "");
    if (points.length < 2) continue;
    const details = step.transitDetails;
    if (!details) {
      const last = legs[legs.length - 1];
      if (last?.mode === "walk") last.points.push(...points);
      else legs.push({ mode: "walk", label: "Walk", noGo: null, points });
      continue;
    }
    const vehicle = VEHICLES[details.transitLine?.vehicle?.type ?? ""] ?? TRAIN;
    const line = details.transitLine?.nameShort ?? details.transitLine?.name ?? "";
    const from = details.stopDetails?.departureStop?.name;
    const to = details.stopDetails?.arrivalStop?.name;
    legs.push({
      mode: vehicle.mode,
      label: `${vehicle.word} ${line}`.trim() + (from && to ? `, ${from} to ${to}` : ""),
      noGo: vehicle.noGo ?? null,
      points,
    });
  }
  return legs;
}

interface ApiRoute {
  polyline?: { encodedPolyline?: string };
  legs?: Array<{ steps?: ApiStep[] }>;
}

async function computeRoute(stops: Stop[], mode: TravelMode): Promise<ApiRoute> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": config.googleMapsApiKey!,
      "X-Goog-FieldMask": FIELDS,
    },
    body: JSON.stringify({
      origin: waypoint(stops[0]),
      destination: waypoint(stops[stops.length - 1]),
      intermediates: stops.slice(1, -1).map(waypoint),
      travelMode: mode,
      // The detailed line: points every 15 m or so, where the default leaves gaps
      // of hundreds of metres that would be bridged by straight lines. Not offered for public transport.
      ...(mode === "TRANSIT" ? {} : { polylineQuality: "HIGH_QUALITY" }),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json()) as { routes?: ApiRoute[]; error?: { message?: string } };
  if (!res.ok) throw new Error(`Google could not compute the route: ${body.error?.message ?? `HTTP ${res.status}`}`);
  const route = body.routes?.[0];
  if (!route) throw new Error(`Google found no route from ${short(stops[0].label)} to ${short(stops[stops.length - 1].label)}`);
  return route;
}

/**
 * Asks Google for the route a link describes. Google returns its current
 * best route, which can differ from the one shown when the link was shared
 * (traffic, timetable, or an alternative the sharer picked).
 */
export async function fetchRoute(directions: Directions, url: string): Promise<RouteSource> {
  if (!config.googleMapsApiKey) throw new Error("Google Maps links are not set up (no API key)");
  const { stops, mode } = directions;
  const name = `${short(stops[0].label)} to ${short(stops[stops.length - 1].label)}`;

  if (mode === "TRANSIT") {
    // Google does not take stops in between for public transport, so each
    // stretch from one stop to the next is asked for on its own and joined.
    const legs: SourceLeg[] = [];
    for (let i = 0; i + 1 < stops.length; i++) {
      const route = await computeRoute([stops[i], stops[i + 1]], mode);
      legs.push(...transitLegs((route.legs ?? []).flatMap((leg) => leg.steps ?? [])));
    }
    if (legs.length === 0) throw new Error("Google returned a route without any line to follow");
    return { name: `${name} (public transport)`, profile: "road", url, legs };
  }

  const route = await computeRoute(stops, mode);
  const points = decodePolyline(route.polyline?.encodedPolyline ?? "");
  if (points.length < 2) throw new Error("Google returned a route without any line to follow");
  if (mode === "WALK") {
    return { name: `${name} (on foot)`, profile: "hike", url, legs: [{ mode: "hike", label: "Walk", noGo: null, points }] };
  }
  const label = mode === "BICYCLE" ? "Bicycle" : "Drive";
  return { name: `${name} (${mode === "BICYCLE" ? "by bike" : "by car"})`, profile: "road", url, legs: [{ mode: "drive", label, noGo: null, points }] };
}
