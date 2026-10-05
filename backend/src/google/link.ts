/** A place on the route, as an address to look up or as exact coordinates. */
export interface Stop {
  label: string;
  latLng: [number, number] | null;
}

export type TravelMode = "DRIVE" | "BICYCLE" | "WALK" | "TRANSIT";

export interface Directions {
  stops: Stop[];
  mode: TravelMode;
}

// Google encodes the travel mode in the link's data blob as "!3e<digit>".
const BLOB_MODES: Record<string, TravelMode> = { "0": "DRIVE", "1": "BICYCLE", "2": "WALK", "3": "TRANSIT" };
const QUERY_MODES: Record<string, TravelMode> = { driving: "DRIVE", bicycling: "BICYCLE", walking: "WALK", transit: "TRANSIT" };
const LAT_LNG = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

function isGoogleMapsHost(host: string): boolean {
  return host === "maps.app.goo.gl" || host === "goo.gl" || /(^|\.)google\.[a-z.]{2,6}$/.test(host);
}

function stop(text: string): Stop {
  const match = LAT_LNG.exec(text);
  return match ? { label: text.trim(), latLng: [Number(match[1]), Number(match[2])] } : { label: text.trim(), latLng: null };
}

/**
 * Reads start, end, stops in between and travel mode out of a full Google
 * Maps directions URL. The link does not contain the route line itself, only
 * what was asked for.
 */
export function parseDirectionsUrl(input: string): Directions {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("That is not a link");
  }
  if (!isGoogleMapsHost(url.hostname)) throw new Error("That is not a Google Maps link");

  // Documented form: /maps/dir/?api=1&origin=…&destination=…&waypoints=a|b&travelmode=…
  const origin = url.searchParams.get("origin") ?? url.searchParams.get("saddr");
  const destination = url.searchParams.get("destination") ?? url.searchParams.get("daddr");
  if (origin && destination) {
    const between = (url.searchParams.get("waypoints") ?? "").split("|").filter(Boolean);
    return {
      stops: [origin, ...between, destination].map(stop),
      mode: QUERY_MODES[url.searchParams.get("travelmode") ?? ""] ?? "DRIVE",
    };
  }

  // What the share button produces: /maps/dir/<stop>/<stop>/…/@lat,lng,zoom/data=…
  const segments = url.pathname.split("/");
  const dir = segments.indexOf("dir");
  if (dir < 0) throw new Error("That link is not a route. Share the directions themselves, not a single place.");
  const names: string[] = [];
  let blob = "";
  for (const segment of segments.slice(dir + 1)) {
    if (segment.startsWith("@")) continue;
    if (segment.startsWith("data=")) blob = segment;
    else names.push(decodeURIComponent(segment.replace(/\+/g, " ")));
  }
  while (names.length > 0 && names[names.length - 1] === "") names.pop();
  if (names.length < 2) throw new Error("That link has no start or no destination");
  if (names.some((name) => name.trim() === "")) {
    throw new Error("That route starts from 'your location'. Set a named start point in Google Maps and share it again.");
  }

  const stops = names.map(stop);
  // The blob carries exact coordinates for each stop, which beats looking the
  // name up again. They are only trusted when there is exactly one per stop.
  const coordinates = [...blob.matchAll(/!2m2!1d(-?\d+(?:\.\d+)?)!2d(-?\d+(?:\.\d+)?)/g)];
  if (coordinates.length === stops.length) {
    coordinates.forEach((match, i) => (stops[i].latLng ??= [Number(match[2]), Number(match[1])]));
  }
  return { stops, mode: BLOB_MODES[/!3e(\d)/.exec(blob)?.[1] ?? ""] ?? "DRIVE" };
}

/** Follows a shared short link (maps.app.goo.gl/…) to the full URL behind it. */
export async function resolveLink(input: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("That is not a link");
  }
  if (url.protocol !== "https:" || !isGoogleMapsHost(url.hostname)) throw new Error("That is not a Google Maps link");
  if (url.pathname.includes("/dir")) return url.toString();

  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15_000) });
  const final = new URL(res.url);
  // In Europe Google may park the visitor on a cookie-consent page; the real target is in its query.
  const target = final.hostname.startsWith("consent.") ? final.searchParams.get("continue") : null;
  return target ?? final.toString();
}
