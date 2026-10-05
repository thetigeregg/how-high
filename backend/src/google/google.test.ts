import { describe, expect, it } from "vitest";
import { parseDirectionsUrl } from "./link.js";
import { decodePolyline, transitLegs } from "./routes.js";

describe("parseDirectionsUrl", () => {
  it("reads stops, exact coordinates and travel mode from a shared directions link", () => {
    const directions = parseDirectionsUrl(
      "https://www.google.com/maps/dir/Chur,+Switzerland/Arosa,+Switzerland/@46.8,9.5,11z/data=!3m1!4b1!4m14!4m13!1m5!1m1!1s0x4784c7:0x1!2m2!1d9.5329!2d46.8508!1m5!1m1!1s0x4784d1:0x2!2m2!1d9.6732!2d46.7782!3e3",
    );
    expect(directions.mode).toBe("TRANSIT");
    expect(directions.stops).toEqual([
      { label: "Chur, Switzerland", latLng: [46.8508, 9.5329] },
      { label: "Arosa, Switzerland", latLng: [46.7782, 9.6732] },
    ]);
  });

  it("falls back to names when the link carries no coordinates, and to driving", () => {
    const directions = parseDirectionsUrl("https://www.google.ch/maps/dir/Thusis/46.6741,9.6403/Tiefencastel/");
    expect(directions.mode).toBe("DRIVE");
    expect(directions.stops.map((s) => s.latLng)).toEqual([null, [46.6741, 9.6403], null]);
  });

  it("reads the documented query form", () => {
    const directions = parseDirectionsUrl(
      "https://www.google.com/maps/dir/?api=1&origin=Zürich+HB&destination=Bern&waypoints=Olten%7CBurgdorf&travelmode=walking",
    );
    expect(directions.stops.map((s) => s.label)).toEqual(["Zürich HB", "Olten", "Burgdorf", "Bern"]);
    expect(directions.mode).toBe("WALK");
  });

  it("explains links it cannot use", () => {
    expect(() => parseDirectionsUrl("https://example.com/maps/dir/A/B")).toThrow(/not a Google Maps link/);
    expect(() => parseDirectionsUrl("https://www.google.com/maps/place/Bern")).toThrow(/not a route/);
    expect(() => parseDirectionsUrl("https://www.google.com/maps/dir//Bern")).toThrow(/your location/);
  });
});

describe("Google routes", () => {
  // Google's documented example: (38.5, -120.2), (40.7, -120.95), (43.252, -126.453).
  const encoded = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";

  it("decodes polylines", () => {
    expect(decodePolyline(encoded)).toEqual([
      { lat: 38.5, lon: -120.2 },
      { lat: 40.7, lon: -120.95 },
      { lat: 43.252, lon: -126.453 },
    ]);
  });

  it("builds legs from transit steps, joining walks and marking no-go transport", () => {
    const polyline = { encodedPolyline: encoded };
    const ride = (type: string, nameShort: string) => ({
      travelMode: "TRANSIT",
      polyline,
      transitDetails: {
        transitLine: { vehicle: { type }, nameShort },
        stopDetails: { departureStop: { name: "A" }, arrivalStop: { name: "B" } },
      },
    });
    const legs = transitLegs([
      { travelMode: "WALK", polyline },
      { travelMode: "WALK", polyline },
      ride("HEAVY_RAIL", "R16"),
      ride("GONDOLA_LIFT", "LAW"),
      ride("FUNICULAR", "F1"),
      ride("BUS", "12"),
    ]);
    expect(legs.map((l) => [l.mode, l.label, l.noGo])).toEqual([
      ["walk", "Walk", null],
      ["rail", "Train R16, A to B", null],
      ["lift", "Gondola LAW, A to B", "cableCars"],
      ["rail", "Funicular F1, A to B", "funiculars"],
      ["bus", "Bus 12, A to B", null],
    ]);
    expect(legs[0].points).toHaveLength(6);
  });
});
