import { config } from "../config.js";
import type { LegMode } from "../exposure/analyze.js";
import type { RouteSource, SourceLeg } from "../exposure/pipeline.js";
import type { NoGoKind } from "../exposure/score.js";
import type { GpxPoint } from "../gpx/parse.js";
import type { Directions, Stop, TravelMode, TripTime } from "./link.js";

const ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";
const FIELDS = [
  "routes.polyline.encodedPolyline",
  "routes.description",
  "routes.distanceMeters",
  "routes.duration",
  "routes.legs.steps.travelMode",
  "routes.legs.steps.polyline.encodedPolyline",
  "routes.legs.steps.transitDetails.transitLine.vehicle.type",
  "routes.legs.steps.transitDetails.transitLine.nameShort",
  "routes.legs.steps.transitDetails.transitLine.name",
  "routes.legs.steps.transitDetails.stopDetails.departureStop.name",
  "routes.legs.steps.transitDetails.stopDetails.arrivalStop.name",
  "routes.legs.steps.transitDetails.stopDetails.departureTime",
  "routes.legs.steps.transitDetails.stopDetails.arrivalTime",
  "routes.legs.steps.transitDetails.localizedValues",
].join(",");

// How each Google vehicle type is traveled, what to call it, and whether it is a no-go kind.
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

/** A time as the clock at a stop shows it, and the zone that clock is in. */
interface ApiLocalTime {
  time?: { text?: string };
  timeZone?: string;
}

interface ApiStep {
  travelMode?: string;
  polyline?: { encodedPolyline?: string };
  transitDetails?: {
    transitLine?: { vehicle?: { type?: string }; nameShort?: string; name?: string };
    stopDetails?: {
      departureStop?: { name?: string };
      arrivalStop?: { name?: string };
      departureTime?: string;
      arrivalTime?: string;
    };
    localizedValues?: { departureTime?: ApiLocalTime; arrivalTime?: ApiLocalTime };
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

const at = ([latitude, longitude]: [number, number]) => ({ location: { latLng: { latitude, longitude } } });
const waypoint = (stop: Stop) => (stop.latLng ? at(stop.latLng) : { address: stop.label });

/**
 * Everything between the first and the last stop, in order: the stops in
 * between, and the points the route was dragged through, which the route
 * must pass without counting as stops.
 */
function between(stops: Stop[]) {
  return stops.flatMap((stop, i) => [
    ...(i > 0 && i < stops.length - 1 ? [waypoint(stop)] : []),
    ...(i < stops.length - 1 ? stop.via.map((point) => ({ ...at(point), via: true })) : []),
  ]);
}

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
  description?: string;
  distanceMeters?: number;
  /** Seconds, written like "6200s". */
  duration?: string;
  legs?: Array<{ steps?: ApiStep[] }>;
}

/** A moment public transport is planned to leave at or arrive by. */
interface When {
  kind: TripTime["kind"];
  at: Date;
}

/** Google's routes for a trip, best first; more than one only where alternatives are asked for and exist. */
async function computeRoutes(stops: Stop[], mode: TravelMode, { alternatives = false, when = null as When | null } = {}): Promise<ApiRoute[]> {
  const intermediates = between(stops);
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
      intermediates,
      travelMode: mode,
      // The words Google describes a route in, which are shown when picking one.
      languageCode: "en",
      // Google offers no alternatives for a route with stops or dragged points in between.
      computeAlternativeRoutes: alternatives && intermediates.length === 0,
      ...(when ? { [when.kind === "arrival" ? "arrivalTime" : "departureTime"]: when.at.toISOString() } : {}),
      // The detailed line: points every 15 m or so, where the default leaves gaps
      // of hundreds of meters that would be bridged by straight lines. Not offered for public transport.
      ...(mode === "TRANSIT" ? {} : { polylineQuality: "HIGH_QUALITY" }),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json()) as { routes?: ApiRoute[]; error?: { message?: string } };
  if (!res.ok) throw new Error(`Google could not compute the route: ${body.error?.message ?? `HTTP ${res.status}`}`);
  if (!body.routes?.length) throw new Error(`Google found no route from ${short(stops[0].label)} to ${short(stops[stops.length - 1].label)}`);
  return body.routes;
}

const WEEK_S = 7 * 86_400;
// Google plans public transport from a week back to 100 days ahead; this stays clear of the far end.
const AHEAD_S = 90 * 86_400;
const HERE = new Intl.DateTimeFormat().resolvedOptions().timeZone;

/** How many seconds the clock in a time zone is ahead of UTC at a moment. */
function zoneOffset(zone: string, at: Date): number {
  const part = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
      .formatToParts(at)
      .map((p) => [p.type, Number(p.value)]),
  );
  return Math.round((Date.UTC(part.year, part.month - 1, part.day, part.hour, part.minute, part.second) - at.getTime()) / 1000);
}

/**
 * The moment to plan a trip for, given the clock time from a link and the
 * time zone that clock is in. A time that has passed, or lies further ahead
 * than Google plans, is moved by whole weeks: same weekday, same time of day.
 */
export function planFor(time: TripTime, zone: string, now = new Date()): Date {
  const nowClock = now.getTime() / 1000 + zoneOffset(zone, now);
  let clock = time.clock;
  if (clock < nowClock) clock += Math.ceil((nowClock - clock) / WEEK_S) * WEEK_S;
  if (clock > nowClock + AHEAD_S) clock -= Math.ceil((clock - nowClock - AHEAD_S) / WEEK_S) * WEEK_S;
  // The offset is looked up twice so that the hour comes out right across a daylight-saving change.
  const roughly = new Date((clock - zoneOffset(zone, new Date(clock * 1000))) * 1000);
  return new Date((clock - zoneOffset(zone, roughly)) * 1000);
}

const stepsOf = (route: ApiRoute) => (route.legs ?? []).flatMap((leg) => leg.steps ?? []);
const rides = (steps: ApiStep[]) => steps.flatMap((step) => (step.transitDetails ? [step.transitDetails] : []));

/**
 * Public transport between two stops for the clock time from a link. Which
 * time zone that clock is in is only known once Google names it, so the
 * request assumes this server's and is made again where that was wrong.
 */
async function plannedTransit(pair: Stop[], time: TripTime, alternatives: boolean): Promise<{ routes: ApiRoute[]; when: When; zone: string }> {
  let when: When = { kind: time.kind, at: planFor(time, HERE) };
  let routes = await computeRoutes(pair, "TRANSIT", { alternatives, when });
  const ridden = rides(stepsOf(routes[0]));
  const zone =
    (time.kind === "arrival" ? ridden[ridden.length - 1]?.localizedValues?.arrivalTime : ridden[0]?.localizedValues?.departureTime)?.timeZone ?? HERE;
  const exact = planFor(time, zone);
  if (exact.getTime() !== when.at.getTime()) {
    when = { kind: time.kind, at: exact };
    routes = await computeRoutes(pair, "TRANSIT", { alternatives, when });
  }
  return { routes, when, zone };
}

/** One of the routes Google offers for a link. */
export interface RouteOption {
  /** What sets it apart from the others: the roads it takes, or the lines and when they run. */
  label: string;
  distanceM: number | null;
  durationS: number | null;
  source: RouteSource;
}

export interface RouteOptions {
  /** Google's first choice first. */
  options: RouteOption[];
  /** In words, when public transport was planned for, if the link said. */
  planned: string | null;
}

const measures = (route: ApiRoute) => ({
  distanceM: route.distanceMeters ?? null,
  durationS: route.duration ? Number.parseInt(route.duration, 10) : null,
});

/** What the clock at a stop shows at a moment, like "09:07". */
function clockAt(moment: string | undefined, zone: string | undefined): string | null {
  if (!moment || !zone) return null;
  return new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(moment));
}

/** The lines of a public-transport route and when they run, like "Train IC3, Bus 11 (09:07–10:49)". */
function transitLabel(steps: ApiStep[], legs: SourceLeg[]): string {
  const lines = legs.filter((leg) => leg.mode !== "walk").map((leg) => leg.label.split(",")[0]);
  const ridden = rides(steps);
  const first = ridden[0];
  const last = ridden[ridden.length - 1];
  const from = clockAt(first?.stopDetails?.departureTime, first?.localizedValues?.departureTime?.timeZone);
  const to = clockAt(last?.stopDetails?.arrivalTime, last?.localizedValues?.arrivalTime?.timeZone);
  return (lines.join(", ") || "Walk") + (from && to ? ` (${from}–${to})` : "");
}

async function transitOptions(directions: Directions, name: string, url: string): Promise<RouteOptions> {
  const { stops, time } = directions;
  const source = (legs: SourceLeg[]): RouteSource => ({ name: `${name} (public transport)`, profile: "road", url, legs });
  // Google does not take stops in between for public transport, so each
  // stretch from one stop to the next is asked for on its own and joined.
  // Planned from the start for a departure time, back from the end for an arrival time.
  const order = stops.slice(0, -1).map((_, i) => i);
  if (time?.kind === "arrival") order.reverse();
  const direct = stops.length === 2;
  const stretches: SourceLeg[][] = [];
  let offered: ApiRoute[] = [];
  let when: When | null = null;
  let planned: string | null = null;
  for (const i of order) {
    // Google Maps does not let a public-transport route be dragged, so there is nothing to pass through.
    const pair = [{ ...stops[i], via: [] }, stops[i + 1]];
    if (time && !when) {
      const first = await plannedTransit(pair, time, direct);
      ({ routes: offered, when } = first);
      const at = new Intl.DateTimeFormat("en-US", { timeZone: first.zone, weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
      planned = `${time.kind === "arrival" ? "Arriving by" : "Leaving"} ${at.format(when.at)}`;
    } else {
      offered = await computeRoutes(pair, "TRANSIT", { alternatives: direct, when });
    }
    const steps = stepsOf(offered[0]);
    stretches[i] = transitLegs(steps);
    // The next stretch starts where this one lets off, or ends where this one is boarded.
    const ridden = rides(steps);
    const edge: string | undefined =
      when?.kind === "arrival" ? ridden[0]?.stopDetails?.departureTime : ridden[ridden.length - 1]?.stopDetails?.arrivalTime;
    if (when && edge) when = { kind: when.kind, at: new Date(edge) };
  }

  if (!direct) {
    const legs = stretches.flat();
    if (legs.length === 0) throw new Error("Google returned a route without any line to follow");
    return { options: [{ label: legs.filter((leg) => leg.mode !== "walk").map((leg) => leg.label.split(",")[0]).join(", ") || "Walk", distanceM: null, durationS: null, source: source(legs) }], planned };
  }
  // Google lists the same lines again for each later departure; the way they take is the same, so one is enough.
  const options = new Map<string, RouteOption>();
  for (const route of offered) {
    const steps = stepsOf(route);
    const legs = transitLegs(steps);
    const lines = legs.map((leg) => leg.label).join("|");
    if (legs.length > 0 && !options.has(lines)) options.set(lines, { label: transitLabel(steps, legs), ...measures(route), source: source(legs) });
  }
  if (options.size === 0) throw new Error("Google returned a route without any line to follow");
  return { options: [...options.values()], planned };
}

/**
 * Asks Google for the routes a link describes. The link holds what was asked
 * for, not the line that was shown, so these are the routes Google offers
 * now: its first choice and, where it has them, the alternatives. They can
 * differ from the ones shown when the link was shared (traffic, timetable).
 */
export async function fetchRoutes(directions: Directions, url: string): Promise<RouteOptions> {
  if (!config.googleMapsApiKey) throw new Error("Google Maps links are not set up (no API key)");
  const { stops, mode } = directions;
  const name = `${short(stops[0].label)} to ${short(stops[stops.length - 1].label)}`;
  if (mode === "TRANSIT") return transitOptions(directions, name, url);

  const routes = await computeRoutes(stops, mode, { alternatives: true });
  const options = routes.flatMap((route, i): RouteOption[] => {
    const points = decodePolyline(route.polyline?.encodedPolyline ?? "");
    if (points.length < 2) return [];
    const source: RouteSource =
      mode === "WALK"
        ? { name: `${name} (on foot)`, profile: "hike", url, legs: [{ mode: "hike", label: "Walk", noGo: null, points }] }
        : {
            name: `${name} (${mode === "BICYCLE" ? "by bike" : "by car"})`,
            profile: "road",
            url,
            legs: [{ mode: "drive", label: mode === "BICYCLE" ? "Bicycle" : "Drive", noGo: null, points }],
          };
    return [{ label: route.description ? `Via ${route.description}` : `Route ${i + 1}`, ...measures(route), source }];
  });
  if (options.length === 0) throw new Error("Google returned a route without any line to follow");
  return { options, planned: null };
}
