import proj4 from "proj4";

/** Converts between WGS84 lon/lat and a metric plane the terrain maths runs in. */
export interface Projection {
  name: string;
  forward(lon: number, lat: number): [number, number];
  inverse(x: number, y: number): [number, number];
}

const LV95 =
  "+proj=somerc +lat_0=46.9524055555556 +lon_0=7.43958333333333 +k_0=1 +x_0=2600000 +y_0=1200000 +ellps=bessel +towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs";

function fromProj4(name: string, def: string): Projection {
  const converter = proj4("WGS84", def);
  return {
    name,
    forward: (lon, lat) => converter.forward([lon, lat]) as [number, number],
    inverse: (x, y) => converter.inverse([x, y]) as [number, number],
  };
}

/** Swiss national grid (EPSG:2056), the native CRS of swissALTI3D. */
export const lv95: Projection = fromProj4("LV95", LV95);

/** Transverse Mercator centered on the route, for anywhere outside Switzerland. */
export function localProjection(lon: number, lat: number): Projection {
  return fromProj4("local", `+proj=tmerc +lat_0=${lat} +lon_0=${lon} +k_0=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs`);
}
