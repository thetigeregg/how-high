<script lang="ts">
  import type { AnalysisSummary, Rating } from "../types.js";
  import LevelBadge from "./LevelBadge.svelte";
  import { km } from "./levels.js";

  let {
    analyses,
    selectedId,
    onselect,
    empty,
  }: {
    analyses: AnalysisSummary[];
    selectedId: number | null;
    onselect: (id: number) => void;
    /** Shown when the list has nothing in it. */
    empty: string;
  } = $props();

  const ratingLabel: Record<Rating, string> = { fine: "was fine", uneasy: "was uneasy", bad: "was bad" };
</script>

{#if analyses.length === 0}
  <p class="empty">{empty}</p>
{:else}
  <ul>
    {#each analyses as a (a.id)}
      <li>
        <button type="button" class:selected={a.id === selectedId} onclick={() => onselect(a.id)}>
          <span class="name">{a.name || "Untitled"}</span>
          <span class="meta">
            <LevelBadge level={a.level} />
            <span>{km(a.lengthM)}</span>
            {#if a.rating}<span>{ratingLabel[a.rating]}</span>{/if}
          </span>
        </button>
      </li>
    {/each}
  </ul>
{/if}

<style>
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  button {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    width: 100%;
    padding: 0.6rem 0.7rem;
    border: 1px solid transparent;
    border-radius: 0.5rem;
    background: none;
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  button:hover {
    background: var(--hover-bg);
  }
  button.selected {
    border-color: var(--accent);
    background: var(--bg-elevated);
  }
  .name {
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.75rem;
    color: var(--text-muted);
    font-size: 0.85rem;
  }
  .empty {
    color: var(--text-muted);
    font-size: 0.9rem;
  }
</style>
