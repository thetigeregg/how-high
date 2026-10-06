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
      { label: "Chur, Switzerland", latLng: [46.8508, 9.5329], via: [] },
      { label: "Arosa, Switzerland", latLng: [46.7782, 9.6732], via: [] },
    ]);
  });

  it("ignores view options between the stops and the data", () => {
    // What the share button on the phone app produces, after its short link is followed.
    const directions = parseDirectionsUrl(
      "https://www.google.com/maps/dir/Z%C3%BCrich+HB,+Bahnhofplatz,+8001+Z%C3%BCrich/St+Moritz,+7500/@46.9303859,7.9900519,8z/am=t/data=!4m14!4m13!1m5!1m1!1s0x47900a08cc0e6e41:0xf5c698b65f8c52a7!2m2!1d8.5403767!2d47.3780356!1m5!1m1!1s0x478482076dc01a7b:0x279fdbbd3ec97825!2m2!1d9.8355079!2d46.4907973!3e3?entry=tts",
    );
    expect(directions.mode).toBe("TRANSIT");
    expect(directions.stops).toEqual([
      { label: "Zürich HB, Bahnhofplatz, 8001 Zürich", latLng: [47.3780356, 8.5403767], via: [] },
      { label: "St Moritz, 7500", latLng: [46.4907973, 9.8355079], via: [] },
    ]);
  });

  it("reads the points a hand-drawn route was dragged through", () => {
    // A walking route drawn in Google Maps by dragging the line, as shared from the app.
    const directions = parseDirectionsUrl(
      "https://www.google.com/maps/dir/N%C3%A4nikon-Greifensee,+8606+Uster/Juckerfarm,+Dorfstrasse+23,+8607+Seegr%C3%A4ben/@47.3488659,8.6943246,14.29z/data=!3m1!5s0x479abb793674d405:0xe2756087d657df1a!4m59!4m58!1m50!1m1!1s0x479aa39decee2521:0x718622c2de3ce601!2m2!1d8.6865125!2d47.3693581!3m4!1m2!1d8.6904229!2d47.3493667!3s0x479aa48489cc8383:0x32609c77517c8f12!3m4!1m2!1d8.6910744!2d47.3440306!3s0x479aa48fdfcfbf8b:0xcfa178d16e3aea4e!3m4!1m2!1d8.7049672!2d47.3392671!3s0x479aa4bde8185d5d:0xca310b378ad92d3e!3m4!1m2!1d8.7328834!2d47.3444564!3s0x479abb525276886f:0x100410d6a8ebf9c2!3m4!1m2!1d8.7378618!2d47.3458457!3s0x479abb51272c7333:0xc6eefc482347c0c4!3m4!1m2!1d8.7386323!2d47.3460121!3s0x479abb50d9a64f19:0xb5884a02f66600ed!3m4!1m2!1d8.7391795!2d47.3460774!3s0x479abb50daa2cac1:0x1bab56c64aa107e5!3m4!1m2!1d8.7555445!2d47.3454285!3s0x479abb60caa0ddf9:0x1f0e5c6ec86beee!3m4!1m2!1d8.7713849!2d47.3413161!3s0x479abb799a4c9615:0x1395c11a4ac3ffff!1m5!1m1!1s0x479abb7beca5bf51:0x28d5f8ecd9eedae6!2m2!1d8.7726798!2d47.3438324!3e2!5m1!1e4?entry=tts&g_ep=EgoyMDI2MDkzMC4wKgBIAVAD&skid=639a11d1-cdaa-42d2-9afa-1a83842a7110",
    );
    expect(directions.mode).toBe("WALK");
    expect(directions.stops.map((s) => s.label)).toEqual(["Nänikon-Greifensee, 8606 Uster", "Juckerfarm, Dorfstrasse 23, 8607 Seegräben"]);
    expect(directions.stops[0].latLng).toEqual([47.3693581, 8.6865125]);
    expect(directions.stops[1].latLng).toEqual([47.3438324, 8.7726798]);
    // Nine points between the two stops, in the order the route passes them; none after the last stop.
    expect(directions.stops[0].via).toHaveLength(9);
    expect(directions.stops[0].via[0]).toEqual([47.3493667, 8.6904229]);
    expect(directions.stops[0].via[8]).toEqual([47.3413161, 8.7713849]);
    expect(directions.stops[1].via).toEqual([]);
  });

  it("keeps dragged points with the stop they follow when there are stops in between", () => {
    const directions = parseDirectionsUrl(
      "https://www.google.com/maps/dir/A/B/C/data=!4m22!4m21!1m5!1m1!1sx!2m2!1d8.1!2d47.1!1m10!1m1!1sy!2m2!1d8.2!2d47.2!3m4!1m2!1d8.25!2d47.25!3sz!1m5!1m1!1sw!2m2!1d8.3!2d47.3!3e0",
    );
    expect(directions.mode).toBe("DRIVE");
    expect(directions.stops.map((s) => s.via)).toEqual([[], [[47.25, 8.25]], []]);
    expect(directions.stops[2].latLng).toEqual([47.3, 8.3]);
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
