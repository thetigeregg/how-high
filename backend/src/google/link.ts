/** A place on the route, as an address to look up or as exact coordinates. */
export interface Stop {
  label: string;
  latLng: [number, number] | null;
  /**
   * Points the route was dragged through on its way from this stop to the
   * next, as [lat, lon]. These are what make a hand-drawn route differ from
   * the one Google would pick by itself.
   */
  via: Array<[number, number]>;
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
  return { label: text.trim(), latLng: match ? [Number(match[1]), Number(match[2])] : null, via: [] };
}

// The "data=" part of a link is a nested list written flat: each item is
// "!<number><type><value>", and an item of type "m" says how many of the
// items after it belong inside it.
interface Item {
  id: number;
  type: string;
  value: string;
  inside: Item[];
}

function readItems(tokens: string[], from: number, count: number): Item[] {
  const items: Item[] = [];
  for (let i = from; i < from + count && i < tokens.length; ) {
    const match = /^(\d+)([a-z])(.*)$/.exec(tokens[i]);
    if (!match) return items;
    const inside = match[2] === "m" ? readItems(tokens, i + 1, Number(match[3])) : [];
    items.push({ id: Number(match[1]), type: match[2], value: match[3], inside });
    i += 1 + (match[2] === "m" ? Number(match[3]) : 0);
  }
  return items;
}

const child = (items: Item[], id: number, type: string) => items.find((item) => item.id === id && item.type === type);

/** A [lat, lon] pair from a block holding "1d<lon>" and "2d<lat>". */
function latLngIn(items: Item[] | undefined): [number, number] | null {
  const lon = Number(child(items ?? [], 1, "d")?.value);
  const lat = Number(child(items ?? [], 2, "d")?.value);
  return Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] : null;
}

/**
 * What the data part of a directions link says: for each stop its exact
 * position and the points the route was dragged through after it, and the
 * travel mode. Null where the data does not have the expected shape.
 */
function readBlob(blob: string): { stops: Array<{ latLng: [number, number] | null; via: Array<[number, number]> }>; mode: string | null } | null {
  const tokens = blob.replace(/^data=/, "").split("!").filter(Boolean);
  const directions = child(child(readItems(tokens, 0, tokens.length), 4, "m")?.inside ?? [], 4, "m")?.inside;
  if (!directions) return null;
  return {
    stops: directions
      .filter((item) => item.id === 1 && item.type === "m")
      .map((block) => ({
        latLng: latLngIn(child(block.inside, 2, "m")?.inside),
        via: block.inside
          .filter((item) => item.id === 3 && item.type === "m")
          .flatMap((dragged) => {
            const at = latLngIn(child(dragged.inside, 1, "m")?.inside);
            return at ? [at] : [];
          }),
      })),
    mode: child(directions, 3, "e")?.value ?? null,
  };
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
  // Stops come first; from the map position ("@…") on, the segments are view options and data.
  let pastStops = false;
  for (const segment of segments.slice(dir + 1)) {
    if (segment.startsWith("@")) pastStops = true;
    else if (segment.startsWith("data=")) blob = segment;
    else if (!pastStops) names.push(decodeURIComponent(segment.replace(/\+/g, " ")));
  }
  while (names.length > 0 && names[names.length - 1] === "") names.pop();
  if (names.length < 2) throw new Error("That link has no start or no destination");
  if (names.some((name) => name.trim() === "")) {
    throw new Error("That route starts from 'your location'. Set a named start point in Google Maps and share it again.");
  }

  const stops = names.map(stop);
  // The data carries exact coordinates for each stop, which beats looking the
  // name up again, and the points a hand-drawn route was dragged through.
  // It is only trusted when it describes exactly the stops named in the link.
  const data = readBlob(blob);
  if (data && data.stops.length === stops.length) {
    data.stops.forEach((described, i) => {
      stops[i].latLng ??= described.latLng;
      stops[i].via = described.via;
    });
  }
  return { stops, mode: BLOB_MODES[data?.mode ?? /!3e(\d)/.exec(blob)?.[1] ?? ""] ?? "DRIVE" };
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
