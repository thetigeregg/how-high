<script lang="ts">
  import type { AnalysisSummary, Job, Rating } from "../types.js";
  import LevelBadge from "./LevelBadge.svelte";
  import { km } from "./levels.js";

  let {
    analyses,
    pending,
    selectedId,
    onselect,
    ondismiss,
    empty,
  }: {
    analyses: AnalysisSummary[];
    /** Entries still being measured in the background, or that failed to be. */
    pending: Job[];
    /** Cancels a pending entry, or clears a failed one. */
    ondismiss: (job: Job) => void;
    selectedId: number | null;
    onselect: (id: number) => void;
    /** Shown when the list has nothing in it. */
    empty: string;
  } = $props();

  /** A rough estimate from the pieces done so far; early pieces include downloads later ones may not need. */
  function timeLeft(job: Job): string {
    if (job.state !== "running" || !job.startedAt || job.done === 0 || job.done >= job.total) return "";
    const seconds = ((Date.now() - Date.parse(job.startedAt)) / job.done) * (job.total - job.done) / 1000;
    return seconds < 60 ? ", under a minute left" : `, about ${Math.round(seconds / 60)} min left`;
  }

  const ratingLabel: Record<Rating, string> = { fine: "was fine", uneasy: "was uneasy", bad: "was bad" };
</script>

{#if pending.length > 0}
  <ul class="pending">
    {#each pending as job (job.id)}
      <li>
        <span class="name">{job.label || "Untitled"}</span>
        {#if job.state === "failed"}
          <span class="failed" role="alert">Could not be added: {job.error}</span>
          <button type="button" class="small" onclick={() => ondismiss(job)}>Dismiss</button>
        {:else}
          <!-- Without a known number of pieces the bar shows only that something is happening. -->
          <progress max={job.total || 1} value={job.total > 0 ? job.done : undefined} aria-label="Progress measuring {job.label}"></progress>
          <span class="meta">
            <span>{job.stage}{timeLeft(job)}</span>
            <button type="button" class="small" onclick={() => ondismiss(job)}>Cancel</button>
          </span>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

{#if analyses.length === 0}
  {#if pending.length === 0}<p class="empty">{empty}</p>{/if}
{:else}
  <ul>
    {#each analyses as a (a.id)}
      <li>
        <button type="button" class:selected={a.id === selectedId} onclick={() => onselect(a.id)}>
          <span class="name">{a.name || "Untitled"}</span>
          <span class="meta">
            <LevelBadge level={a.level} />
            <span>{km(a.lengthM)}</span>
            {#if a.status === "planned"}<span class="planned">planned</span>{/if}
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
  .pending {
    margin-bottom: 0.3rem;
  }
  .pending li {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding: 0.6rem 0.7rem;
    border: 1px dashed var(--border);
    border-radius: 0.5rem;
  }
  .pending .meta {
    justify-content: space-between;
    align-items: center;
  }
  progress {
    width: 100%;
    height: 0.4rem;
    accent-color: var(--accent);
  }
  .failed {
    color: var(--error);
    font-size: 0.85rem;
    overflow-wrap: anywhere;
  }
  button.small {
    display: inline;
    width: auto;
    padding: 0.15rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    font-size: 0.8rem;
    color: var(--text-muted);
  }
  .planned {
    padding: 0 0.4rem;
    border: 1px solid var(--border);
    border-radius: 999px;
  }
  .empty {
    color: var(--text-muted);
    font-size: 0.9rem;
  }
</style>
