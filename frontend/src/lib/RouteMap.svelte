<script lang="ts">
  import maplibregl from "maplibre-gl";
  import "maplibre-gl/dist/maplibre-gl.css";
  import { onMount } from "svelte";
  import type { Analysis, Level, Range } from "../types.js";
  import { LEVEL_COLOR, NO_DATA_COLOR } from "./levels.js";

  let {
    analysis,
    levels,
    hoverIndex,
    focus,
    onhover,
    onpick,
  }: {
    analysis: Analysis;
    levels: Array<Level | null>;
    hoverIndex: number | null;
    /** Stretch to zoom to, or null for the whole route. */
    focus: Range | null;
    onhover: (index: number | null) => void;
    /** Called with a point index when the route is clicked. */
    onpick: (index: number) => void;
  } = $props();

  let container: HTMLDivElement;
  let map: maplibregl.Map | undefined;
  let marker: maplibregl.Marker | undefined;
  let ready = $state(false);

  const swiss = $derived(analysis.terrain.source.startsWith("swissALTI3D"));

  /** One line feature per run of equally-rated points, overlapping by a point so runs join up. */
  function routeFeatures(): GeoJSON.FeatureCollection {
    const features: GeoJSON.Feature[] = [];
    const { points } = analysis;
    let start = 0;
    for (let i = 1; i <= points.length; i++) {
      if (i < points.length && levels[i] === levels[start]) continue;
      const end = Math.min(i, points.length - 1);
      features.push({
        type: "Feature",
        properties: { color: levels[start] ? LEVEL_COLOR[levels[start]!] : NO_DATA_COLOR },
        geometry: { type: "LineString", coordinates: points.slice(start, end + 1).map((p) => [p.lon, p.lat]) },
      });
      start = i;
    }
    return { type: "FeatureCollection", features };
  }

  function boundsOf(from: number, to: number): maplibregl.LngLatBounds {
    const bounds = new maplibregl.LngLatBounds();
    for (let i = from; i <= to; i++) bounds.extend([analysis.points[i].lon, analysis.points[i].lat]);
    return bounds;
  }

  function nearestIndex(lngLat: maplibregl.LngLat): number {
    let best = 0;
    let bestDist = Infinity;
    const scale = Math.cos((lngLat.lat * Math.PI) / 180);
    analysis.points.forEach((p, i) => {
      const d = ((p.lon - lngLat.lng) * scale) ** 2 + (p.lat - lngLat.lat) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    return best;
  }

  onMount(() => {
    const raster = (tiles: string, attribution: string, maxzoom: number) => ({
      type: "raster" as const,
      tiles: [tiles],
      tileSize: 256,
      attribution,
      maxzoom,
    });
    map = new maplibregl.Map({
      container,
      style: {
        version: 8,
        sources: {
          swisstopo: raster(
            "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg",
            "© swisstopo",
            18,
          ),
          osm: raster("https://tile.openstreetmap.org/{z}/{x}/{y}.png", "© OpenStreetMap contributors", 19),
          route: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
        },
        layers: [
          { id: "osm", type: "raster", source: "osm", layout: { visibility: "none" } },
          { id: "swisstopo", type: "raster", source: "swisstopo", layout: { visibility: "none" } },
          {
            id: "route-casing",
            type: "line",
            source: "route",
            layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": "#ffffff", "line-width": 8 },
          },
          {
            id: "route",
            type: "line",
            source: "route",
            layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": ["get", "color"], "line-width": 5 },
          },
        ],
      },
      center: [8.3, 46.8],
      zoom: 7,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new maplibregl.ScaleControl(), "bottom-left");
    map.on("load", () => (ready = true));
    map.on("mousemove", "route-casing", (e) => onhover(nearestIndex(e.lngLat)));
    map.on("mouseleave", "route-casing", () => onhover(null));
    map.on("click", "route-casing", (e) => onpick(nearestIndex(e.lngLat)));

    const dot = document.createElement("div");
    dot.className = "route-marker";
    marker = new maplibregl.Marker({ element: dot });

    return () => map?.remove();
  });

  $effect(() => {
    if (!ready || !map) return;
    (map.getSource("route") as maplibregl.GeoJSONSource).setData(routeFeatures());
    map.setLayoutProperty("swisstopo", "visibility", swiss ? "visible" : "none");
    map.setLayoutProperty("osm", "visibility", swiss ? "none" : "visible");
  });

  $effect(() => {
    if (!ready || !map) return;
    if (focus) {
      const from = Math.round(focus.startM / analysis.spacingM);
      const to = Math.min(analysis.points.length - 1, Math.round(focus.endM / analysis.spacingM));
      map.fitBounds(boundsOf(from, to), { padding: 80, maxZoom: 16.5, duration: 600 });
    } else {
      map.fitBounds(boundsOf(0, analysis.points.length - 1), { padding: 40, duration: 0 });
    }
  });

  $effect(() => {
    if (!ready || !map || !marker) return;
    const point = hoverIndex === null ? null : analysis.points[hoverIndex];
    if (point) marker.setLngLat([point.lon, point.lat]).addTo(map);
    else marker.remove();
  });
</script>

<div class="map" bind:this={container}></div>

<style>
  .map {
    height: 100%;
    min-height: 320px;
    border-radius: 0.6rem;
    overflow: hidden;
    border: 1px solid var(--border);
  }
  :global(.route-marker) {
    width: 14px;
    height: 14px;
    border-radius: 999px;
    background: #18181b;
    border: 3px solid #ffffff;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4);
    pointer-events: none;
  }
</style>
