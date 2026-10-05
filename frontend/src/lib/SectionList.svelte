<script lang="ts">
  import type { Range, Section } from "../types.js";
  import LevelBadge from "./LevelBadge.svelte";

  let {
    sections,
    selected,
    onselect,
  }: { sections: Section[]; selected: Range | null; onselect: (index: number) => void } = $props();

  const km = (m: number) => (m / 1000).toFixed(2);
</script>

{#if sections.length === 0}
  <p class="empty">No exposed sections found on this route.</p>
{:else}
  <div class="scroll">
    <table>
      <thead>
        <tr>
          <th>Level</th>
          <th class="num">From km</th>
          <th class="num">Length</th>
          <th class="num" title="Peak score, and the score that remains if the GPS line is 5 m off">Score</th>
          <th class="num" title="Height lost down the fall line before the ground eases off">Fall</th>
          <th class="num" title="Steepness of the ground across the path">Side slope</th>
          <th>Drop</th>
          <th>Look</th>
        </tr>
      </thead>
      <tbody>
        {#each sections as s, i}
          <tr class:selected={selected?.startM === s.startM && selected?.endM === s.endM} onclick={() => onselect(i)}>
            <td><LevelBadge level={s.level} /></td>
            <td class="num">{km(s.startM)}</td>
            <td class="num">{s.lengthM} m</td>
            <td class="num">{s.maxScore}<span class="faint"> (≥{s.robustScore})</span></td>
            <td class="num">{s.maxFallM} m</td>
            <td class="num">{s.maxCrossSlopeDeg}°</td>
            <td>
              {s.side === "both" ? "both sides" : `${s.side}, to ${s.dropTowards}`}{s.possibleBridge ? " · bridge?" : ""}
            </td>
            <td class="links">
              {#if s.links.swisstopo}
                <a href={s.links.swisstopo} target="_blank" rel="noreferrer" onclick={(e) => e.stopPropagation()}>swisstopo</a>
              {/if}
              <a href={s.links.google} target="_blank" rel="noreferrer" onclick={(e) => e.stopPropagation()}>Google</a>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .scroll {
    overflow-x: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9rem;
  }
  th,
  td {
    padding: 0.5rem 0.6rem;
    text-align: left;
    white-space: nowrap;
    border-bottom: 1px solid var(--border-subtle);
  }
  th {
    color: var(--text-muted);
    font-weight: 500;
    font-size: 0.8rem;
  }
  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  tbody tr {
    cursor: pointer;
  }
  tbody tr:hover {
    background: var(--hover-bg);
  }
  tbody tr.selected {
    background: var(--bg-elevated);
    box-shadow: inset 3px 0 0 var(--accent);
  }
  .faint {
    color: var(--text-faint);
  }
  .links {
    display: flex;
    gap: 0.75rem;
  }
  a {
    color: var(--accent);
  }
  .empty {
    color: var(--text-muted);
  }
</style>
