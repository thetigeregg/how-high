<script lang="ts">
  import type { MarkKind, NoGoKind, Range, Section } from "../types.js";
  import LevelBadge from "./LevelBadge.svelte";

  let {
    sections,
    analysisId,
    selected,
    onselect,
    onopen,
  }: {
    sections: Section[];
    /** The hike these sections belong to, so references to it can say "this hike". */
    analysisId: number;
    selected: Range | null;
    onselect: (index: number) => void;
    /** Opens a marked stretch on (possibly) another hike. */
    onopen: (analysisId: number, range: Range) => void;
  } = $props();

  // How a mark reads in "you marked this …" and "which you marked …".
  const VERDICT: Record<MarkKind, string> = {
    fine: "fine",
    uneasy: "uneasy",
    bad: "bad",
    turned_back: "where you turned back",
  };
  const verdict = (kind: MarkKind) => (kind === "turned_back" ? VERDICT[kind] : `marked ${VERDICT[kind]}`);

  const km = (m: number) => (m / 1000).toFixed(2);

  const NO_GO: Record<NoGoKind, string> = {
    cableCars: "cable car",
    funiculars: "funicular",
    rackRailways: "rack railway",
  };

  /** What the map adds about a stretch, as short labels. */
  function contextLabels(s: Section): string[] {
    const c = s.context;
    const labels: string[] = [];
    // On a no-go stretch the terrain details are beside the point.
    if (c?.noGo) return [`no-go: ${NO_GO[c.noGo]}`];
    if (c?.bridge) labels.push("bridge");
    else if (s.possibleBridge) labels.push("bridge?");
    if (!c) return labels;
    if (c.tunnel) labels.push("tunnel");
    if (c.forest) labels.push("forest");
    if (c.wideTrack) labels.push("wide track");
    if (c.cliff) labels.push("mapped cliff");
    if (c.sacGrade !== null && c.sacGrade >= 3) labels.push(`graded T${c.sacGrade}`);
    if (c.aided) labels.push("ladder or rope");
    return labels;
  }
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
          <th title="From OpenStreetMap: forest and wide tracks lower the score, tunnels clear it">Context</th>
          <th title="What your own marks say about this stretch, or about a stretch that measures much the same">
            Your experience
          </th>
          <th>Look</th>
        </tr>
      </thead>
      <tbody>
        {#each sections as s, i}
          <tr class:selected={selected?.startM === s.startM && selected?.endM === s.endM} onclick={() => onselect(i)}>
            <td><LevelBadge level={s.level} /></td>
            <td class="num">{km(s.startM)}</td>
            <td class="num">{s.lengthM} m</td>
            <td class="num">
              {s.maxScore}<span class="faint"> (≥{s.robustScore})</span>
              {#if s.rawMaxScore !== undefined && s.rawMaxScore !== s.maxScore}
                <span class="faint" title="Score from terrain alone, before map context"> · terrain {s.rawMaxScore}</span>
              {/if}
            </td>
            <td class="num">{s.maxFallM} m</td>
            <td class="num">{s.maxCrossSlopeDeg}°</td>
            <td>{s.side === "both" ? "both sides" : `${s.side}, to ${s.dropTowards}`}</td>
            <td>{contextLabels(s).join(", ")}</td>
            <td class="experience">
              {#if s.yourMark}
                <span>You: {verdict(s.yourMark)}</span>
              {/if}
              {#each [{ lead: "Like", ref: s.similar }, { lead: "Scores higher than", ref: s.harderThan }] as { lead, ref }}
                {#if ref}
                  <button
                    type="button"
                    class="similar"
                    onclick={(e) => {
                      e.stopPropagation();
                      onopen(ref.analysisId, { startM: ref.startM, endM: ref.endM });
                    }}
                  >
                    {lead} km {km(ref.startM)} of {ref.analysisId === analysisId ? "this hike" : ref.name} ({verdict(ref.kind)})
                  </button>
                {/if}
              {/each}
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
  .experience {
    white-space: normal;
    min-width: 12rem;
  }
  .experience span {
    display: block;
  }
  .similar {
    padding: 0;
    border: none;
    background: none;
    color: var(--accent);
    font: inherit;
    text-align: left;
    text-decoration: underline;
    cursor: pointer;
  }
  a {
    color: var(--accent);
  }
  .empty {
    color: var(--text-muted);
  }
</style>
