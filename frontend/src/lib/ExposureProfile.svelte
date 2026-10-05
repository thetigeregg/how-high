<script lang="ts">
  import type { Analysis, Level, Mark, Range } from "../types.js";
  import { LEVEL_COLOR, LEVEL_LABEL } from "./levels.js";

  let {
    analysis,
    levels,
    hoverIndex,
    selection,
    marks,
    onhover,
    onselect,
  }: {
    analysis: Analysis;
    levels: Array<Level | null>;
    hoverIndex: number | null;
    onhover: (index: number | null) => void;
    selection: Range | null;
    marks: Mark[];
    /**
     * Called when a stretch is chosen: by dragging, by clicking a flagged band
     * (the whole section), or by clicking elsewhere (a single point).
     */
    onselect: (range: Range) => void;
  } = $props();

  // Two stacked panels on one distance axis: elevation above, score below.
  // The top margin holds the lane the user's own marks are drawn in.
  const M = { left: 46, right: 12, top: 26 };
  const MARK_LANE_Y = 6;
  const ELEVATION_H = 150;
  const GAP = 26;
  const SCORE_H = 80;
  const AXIS_H = 22;
  const HEIGHT = M.top + ELEVATION_H + GAP + SCORE_H + AXIS_H;
  const SCORE_TOP = M.top + ELEVATION_H + GAP;

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

  // Index range being dragged out, before it becomes the selection.
  let drag = $state<{ from: number; to: number } | null>(null);
  const preview = $derived<Range | null>(
    drag
      ? { startM: points[Math.min(drag.from, drag.to)].dist, endM: points[Math.max(drag.from, drag.to)].dist }
      : selection,
  );

  function finishDrag() {
    if (!drag) return;
    const from = Math.min(drag.from, drag.to);
    const to = Math.max(drag.from, drag.to);
    drag = null;
    if (to > from) {
      onselect({ startM: points[from].dist, endM: points[to].dist });
      return;
    }
    const dist = points[from].dist;
    const section = analysis.sections.find((s) => dist >= s.startM && dist <= s.endM);
    onselect(section ? { startM: section.startM, endM: section.endM } : { startM: dist, endM: dist });
  }

  const MARK_LABEL: Record<Mark["kind"], string> = {
    fine: "Fine",
    uneasy: "Uneasy",
    bad: "Bad",
    turned_back: "Turned back",
  };
</script>

<div class="profile" bind:clientWidth={width}>
  <!-- Pointer-only: the section table below offers selection by keyboard. -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <svg
    {width}
    height={HEIGHT}
    role="img"
    aria-label="Elevation and exposure score along the route"
    onpointerdown={(e) => {
      (e.currentTarget as SVGElement).setPointerCapture(e.pointerId);
      drag = { from: indexAt(e), to: indexAt(e) };
    }}
    onpointermove={(e) => {
      const index = indexAt(e);
      onhover(index);
      if (drag) drag.to = index;
    }}
    onpointerup={finishDrag}
    onpointercancel={() => (drag = null)}
    onpointerleave={() => onhover(null)}
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

    {#each analysis.thresholds as t}
      <line class="grid" x1={M.left} x2={M.left + plotW} y1={yScore(t)} y2={yScore(t)} />
      <text class="tick" x={M.left - 6} y={yScore(t)} text-anchor="end" dominant-baseline="middle">{t}</text>
    {/each}
    <line class="axis" x1={M.left} x2={M.left + plotW} y1={yScore(0)} y2={yScore(0)} />
    <text class="label" x={M.left} y={SCORE_TOP - 6}>Exposure score (0–100)</text>

    <path class="line" d={elevationPath} />
    <path class="line" d={scorePath} />

    <!-- The user's own marks, in ink rather than colour so they never read as model levels. -->
    {#each marks as mark}
      {#if mark.kind === "turned_back"}
        <line class="turned-back" x1={x(mark.startM)} x2={x(mark.startM)} y1={MARK_LANE_Y} y2={yScore(0)} />
        <text class="mark-label" x={x(mark.startM) + 4} y={MARK_LANE_Y + 8}>↩ turned back</text>
      {:else}
        <rect
          class="mark {mark.kind}"
          x={x(mark.startM) - (mark.endM === mark.startM ? 3 : 0)}
          y={MARK_LANE_Y}
          width={Math.max(6, x(mark.endM) - x(mark.startM))}
          height="8"
          rx="2"
        >
          <title>{MARK_LABEL[mark.kind]}: km {(mark.startM / 1000).toFixed(2)}–{(mark.endM / 1000).toFixed(2)}</title>
        </rect>
      {/if}
    {/each}

    {#if preview}
      {#if preview.endM > preview.startM}
        <rect
          class="selection"
          x={x(preview.startM)}
          y={M.top}
          width={x(preview.endM) - x(preview.startM)}
          height={yScore(0) - M.top}
        />
      {:else}
        <line class="selection" x1={x(preview.startM)} x2={x(preview.startM)} y1={M.top} y2={yScore(0)} />
      {/if}
    {/if}

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
        <span>
          Score {Math.round(hovered.score)}{#if hovered.rawScore != null && Math.round(hovered.rawScore) !== Math.round(hovered.score)}
            {" "}(terrain alone {Math.round(hovered.rawScore)}){/if}
        </span>
        {#if hovered.context?.tunnel}<span>In a tunnel</span>{/if}
        {#if hovered.context?.forest}<span>Wooded slope below</span>{/if}
        {#if hovered.context?.wide}<span>Wide track</span>{/if}
        <span>Elevation {Math.round(hovered.metrics.elevation)} m</span>
        <span>Fall {Math.round(Math.max(hovered.metrics.fallLeft, hovered.metrics.fallRight))} m</span>
        <span>Side slope {Math.round(hovered.metrics.crossSlopeDeg)}°</span>
        <span>Path grade {Math.round(hovered.metrics.trackGradeDeg)}°</span>
      {:else}
        <span>Not scored here</span>
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
    user-select: none;
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
  .selection {
    fill: var(--accent);
    fill-opacity: 0.12;
    stroke: var(--accent);
    stroke-width: 1.5;
  }
  .mark {
    stroke: var(--text);
    stroke-width: 1.5;
  }
  .mark.fine {
    fill: var(--bg);
  }
  .mark.uneasy {
    fill: var(--text-faint);
  }
  .mark.bad {
    fill: var(--text);
  }
  .turned-back {
    stroke: var(--text);
    stroke-width: 1.5;
    stroke-dasharray: 4 3;
  }
  .mark-label {
    fill: var(--text);
    font-size: 11px;
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
