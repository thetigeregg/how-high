<script lang="ts">
  import type { Analysis, Level } from "../types.js";
  import { LEVEL_COLOR, LEVEL_LABEL } from "./levels.js";

  let {
    analysis,
    levels,
    hoverIndex,
    onhover,
    onselect,
  }: {
    analysis: Analysis;
    levels: Array<Level | null>;
    hoverIndex: number | null;
    onhover: (index: number | null) => void;
    /** Called with a section index when a flagged band is clicked. */
    onselect: (section: number) => void;
  } = $props();

  // Two stacked panels on one distance axis: elevation above, score below.
  const M = { left: 46, right: 12, top: 10 };
  const ELEVATION_H = 150;
  const GAP = 26;
  const SCORE_H = 80;
  const AXIS_H = 22;
  const HEIGHT = M.top + ELEVATION_H + GAP + SCORE_H + AXIS_H;
  const SCORE_TOP = M.top + ELEVATION_H + GAP;
  // Where yellow, orange and red start; mirrors the backend defaults.
  const THRESHOLDS = [25, 50, 75];

  let width = $state(800);
  const plotW = $derived(Math.max(100, width - M.left - M.right));
  const points = $derived(analysis.points);
  const x = $derived((dist: number) => M.left + (dist / analysis.lengthM) * plotW);

  function niceTicks(min: number, max: number, count: number): number[] {
    const raw = (max - min) / count;
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? raw;
    const ticks: number[] = [];
    for (let t = Math.ceil(min / step) * step; t <= max + 1e-9; t += step) ticks.push(t);
    return ticks;
  }

  const elevationRange = $derived.by(() => {
    const values = points.flatMap((p) => (p.metrics ? [p.metrics.elevation] : []));
    const min = Math.min(...values);
    const max = Math.max(...values);
    const pad = Math.max(10, (max - min) * 0.08);
    return { min: min - pad, max: max + pad };
  });
  const yElevation = $derived(
    (e: number) => M.top + ELEVATION_H * (1 - (e - elevationRange.min) / (elevationRange.max - elevationRange.min)),
  );
  const yScore = (s: number) => SCORE_TOP + SCORE_H * (1 - s / 100);

  /** SVG path that lifts the pen across points without terrain data. */
  function path(value: (i: number) => number | null): string {
    let d = "";
    let pen = false;
    points.forEach((p, i) => {
      const v = value(i);
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(p.dist).toFixed(1)},${v.toFixed(1)}`;
      pen = true;
    });
    return d;
  }

  const elevationPath = $derived(path((i) => (points[i].metrics ? yElevation(points[i].metrics!.elevation) : null)));
  const scorePath = $derived(path((i) => (points[i].score === null ? null : yScore(points[i].score!))));
  const kmTicks = $derived(niceTicks(0, analysis.lengthM / 1000, Math.max(2, Math.floor(plotW / 90))));
  const elevationTicks = $derived(niceTicks(elevationRange.min, elevationRange.max, 4));

  const hovered = $derived(hoverIndex === null ? null : points[hoverIndex]);
  const hoveredLevel = $derived(hoverIndex === null ? null : levels[hoverIndex]);

  function indexAt(event: PointerEvent): number {
    const rect = (event.currentTarget as SVGElement).getBoundingClientRect();
    const dist = ((event.clientX - rect.left - M.left) / plotW) * analysis.lengthM;
    return Math.min(points.length - 1, Math.max(0, Math.round(dist / analysis.spacingM)));
  }

  function sectionAt(index: number): number {
    const dist = points[index].dist;
    return analysis.sections.findIndex((s) => dist >= s.startM && dist <= s.endM);
  }
</script>

<div class="profile" bind:clientWidth={width}>
  <!-- Pointer-only shortcut: the section table below offers the same selection by keyboard. -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
  <svg
    {width}
    height={HEIGHT}
    role="img"
    aria-label="Elevation and exposure score along the route"
    onpointermove={(e) => onhover(indexAt(e))}
    onpointerleave={() => onhover(null)}
    onclick={(e) => {
      const section = sectionAt(indexAt(e as unknown as PointerEvent));
      if (section >= 0) onselect(section);
    }}
  >
    <!-- Flagged sections: a tint through both panels plus a solid strip between them. -->
    {#each analysis.sections as s}
      {@const bandX = x(s.startM)}
      {@const bandW = Math.max(2, x(s.endM) - bandX)}
      <rect x={bandX} y={M.top} width={bandW} height={ELEVATION_H} fill={LEVEL_COLOR[s.level]} opacity="0.18" />
      <rect x={bandX} y={SCORE_TOP} width={bandW} height={SCORE_H} fill={LEVEL_COLOR[s.level]} opacity="0.18" />
      <rect x={bandX} y={M.top + ELEVATION_H + 4} width={bandW} height="5" rx="2" fill={LEVEL_COLOR[s.level]} />
    {/each}

    {#each elevationTicks as t}
      <line class="grid" x1={M.left} x2={M.left + plotW} y1={yElevation(t)} y2={yElevation(t)} />
      <text class="tick" x={M.left - 6} y={yElevation(t)} text-anchor="end" dominant-baseline="middle">{t}</text>
    {/each}
    <text class="label" x={M.left} y={M.top + 2} dominant-baseline="hanging">Elevation (m)</text>

    {#each THRESHOLDS as t}
      <line class="grid" x1={M.left} x2={M.left + plotW} y1={yScore(t)} y2={yScore(t)} />
      <text class="tick" x={M.left - 6} y={yScore(t)} text-anchor="end" dominant-baseline="middle">{t}</text>
    {/each}
    <line class="axis" x1={M.left} x2={M.left + plotW} y1={yScore(0)} y2={yScore(0)} />
    <text class="label" x={M.left} y={SCORE_TOP - 6}>Exposure score (0–100)</text>

    <path class="line" d={elevationPath} />
    <path class="line" d={scorePath} />

    {#each kmTicks as t}
      <text class="tick" x={x(t * 1000)} y={HEIGHT - 6} text-anchor="middle">{t} km</text>
    {/each}

    {#if hovered}
      <line class="crosshair" x1={x(hovered.dist)} x2={x(hovered.dist)} y1={M.top} y2={yScore(0)} />
      {#if hovered.metrics}
        <circle class="point" cx={x(hovered.dist)} cy={yElevation(hovered.metrics.elevation)} r="4" />
        <circle class="point" cx={x(hovered.dist)} cy={yScore(hovered.score ?? 0)} r="4" />
      {/if}
    {/if}
  </svg>

  {#if hovered}
    <div class="tooltip" class:flip={x(hovered.dist) > width * 0.6} style:left="{x(hovered.dist)}px">
      <strong>km {(hovered.dist / 1000).toFixed(2)}</strong>
      {#if hovered.metrics && hovered.score !== null}
        {#if hoveredLevel}
          <span class="row">
            <span class="dot" style:background={LEVEL_COLOR[hoveredLevel]}></span>{LEVEL_LABEL[hoveredLevel]} section
          </span>
        {/if}
        <span>Score {Math.round(hovered.score)}</span>
        <span>Elevation {Math.round(hovered.metrics.elevation)} m</span>
        <span>Fall {Math.round(Math.max(hovered.metrics.fallLeft, hovered.metrics.fallRight))} m</span>
        <span>Side slope {Math.round(hovered.metrics.crossSlopeDeg)}°</span>
        <span>Path grade {Math.round(hovered.metrics.trackGradeDeg)}°</span>
      {:else}
        <span>No terrain data</span>
      {/if}
    </div>
  {/if}
</div>

<style>
  .profile {
    position: relative;
  }
  svg {
    display: block;
    cursor: crosshair;
    touch-action: pan-y;
  }
  .grid {
    stroke: var(--border-subtle);
  }
  .axis {
    stroke: var(--border);
  }
  .tick {
    fill: var(--text-muted);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .label {
    fill: var(--text-muted);
    font-size: 11px;
  }
  .line {
    fill: none;
    stroke: var(--text);
    stroke-width: 2;
    stroke-linejoin: round;
  }
  .crosshair {
    stroke: var(--text-faint);
  }
  .point {
    fill: var(--text);
    stroke: var(--bg);
    stroke-width: 2;
  }
  .tooltip {
    position: absolute;
    top: 0.5rem;
    transform: translateX(12px);
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    padding: 0.5rem 0.65rem;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--bg);
    font-size: 0.8rem;
    white-space: nowrap;
    pointer-events: none;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
  }
  .tooltip.flip {
    transform: translateX(calc(-100% - 12px));
  }
  .tooltip span {
    color: var(--text-muted);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }
  .dot {
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 999px;
  }
</style>
