<script lang="ts">
  import { onMount } from "svelte";
  import { deleteAnalysis, fetchAnalyses, fetchAnalysis, updateAnalysis, uploadGpx } from "./api.js";
  import ExposureProfile from "./lib/ExposureProfile.svelte";
  import HikeLibrary from "./lib/HikeLibrary.svelte";
  import LevelBadge from "./lib/LevelBadge.svelte";
  import { km, LEVEL_COLOR, LEVEL_LABEL, LEVELS, pointLevels } from "./lib/levels.js";
  import RouteMap from "./lib/RouteMap.svelte";
  import SectionList from "./lib/SectionList.svelte";
  import Upload from "./lib/Upload.svelte";
  import type { AnalysisDetail, AnalysisSummary, Rating } from "./types.js";

  let analyses = $state<AnalysisSummary[]>([]);
  let detail = $state<AnalysisDetail | null>(null);
  let selectedId = $state<number | null>(null);
  let uploading = $state(false);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let hoverIndex = $state<number | null>(null);
  let focusSection = $state<number | null>(null);

  const levels = $derived(detail ? pointLevels(detail.result) : []);
  const ratings: Array<{ value: Rating; label: string }> = [
    { value: "fine", label: "Fine" },
    { value: "uneasy", label: "Uneasy" },
    { value: "bad", label: "Bad" },
  ];

  async function run(action: () => Promise<void>) {
    error = null;
    try {
      await action();
    } catch (err) {
      error = (err as Error).message;
    }
  }

  async function select(id: number) {
    selectedId = id;
    hoverIndex = null;
    focusSection = null;
    loading = true;
    await run(async () => {
      const loaded = await fetchAnalysis(id);
      // Ignore a slow response for a hike the user has already clicked away from.
      if (selectedId === id) detail = loaded;
    });
    loading = false;
  }

  async function upload(file: File) {
    uploading = true;
    await run(async () => {
      const created = await uploadGpx(file);
      analyses = [created, ...analyses];
      await select(created.id);
    });
    uploading = false;
  }

  function replaceSummary(updated: AnalysisSummary) {
    analyses = analyses.map((a) => (a.id === updated.id ? updated : a));
    if (detail?.summary.id === updated.id) detail = { ...detail, summary: updated };
  }

  function rate(rating: Rating) {
    if (!detail) return;
    const { id, rating: current } = detail.summary;
    void run(async () => replaceSummary(await updateAnalysis(id, { rating: current === rating ? null : rating })));
  }

  function remove() {
    if (!detail || !confirm(`Delete "${detail.summary.name}"?`)) return;
    const { id } = detail.summary;
    void run(async () => {
      await deleteAnalysis(id);
      analyses = analyses.filter((a) => a.id !== id);
      detail = null;
      selectedId = null;
      if (analyses.length > 0) await select(analyses[0].id);
    });
  }

  onMount(() => {
    void run(async () => {
      analyses = await fetchAnalyses();
      if (analyses.length > 0) await select(analyses[0].id);
    });
  });
</script>

<div class="layout">
  <aside>
    <h1>How High</h1>
    <Upload busy={uploading} onfile={upload} />
    <HikeLibrary {analyses} {selectedId} onselect={select} />
  </aside>

  <main>
    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}

    {#if detail}
      {@const result = detail.result}
      <header>
        <div>
          <h2>{detail.summary.name}</h2>
          <p class="meta">
            <LevelBadge level={result.summary.level} />
            <span>peak score {result.summary.maxScore}</span>
            <span>{km(result.lengthM)}</span>
            <span>{result.terrain.source}</span>
          </p>
          {#if result.terrain.confidence === "low"}
            <p class="note">Coarse terrain data: steep mountainsides show up, small cliffs and ledges do not.</p>
          {/if}
        </div>
        <div class="actions">
          <span class="actions-label">How was it?</span>
          {#each ratings as r}
            <button type="button" class:active={detail.summary.rating === r.value} onclick={() => rate(r.value)}>
              {r.label}
            </button>
          {/each}
          <button type="button" class="danger" onclick={remove}>Delete</button>
        </div>
      </header>

      <div class="breakdown">
        <div class="bar" aria-hidden="true">
          {#each LEVELS as level}
            {#if result.summary.lengthByLevelM[level] > 0}
              <span style:flex={result.summary.lengthByLevelM[level]} style:background={LEVEL_COLOR[level]}></span>
            {/if}
          {/each}
        </div>
        <ul>
          {#each LEVELS as level}
            <li>
              <span class="dot" style:background={LEVEL_COLOR[level]}></span>
              {LEVEL_LABEL[level]}
              <strong>{km(result.summary.lengthByLevelM[level])}</strong>
            </li>
          {/each}
          {#if result.summary.noDataM > 0}
            <li>No terrain data <strong>{km(result.summary.noDataM)}</strong></li>
          {/if}
        </ul>
      </div>

      <div class="map">
        <RouteMap analysis={result} {levels} {hoverIndex} {focusSection} onhover={(i) => (hoverIndex = i)} />
        {#if focusSection !== null}
          <button type="button" class="reset" onclick={() => (focusSection = null)}>Show whole route</button>
        {/if}
      </div>

      <section>
        <ExposureProfile
          analysis={result}
          {levels}
          {hoverIndex}
          onhover={(i) => (hoverIndex = i)}
          onselect={(i) => (focusSection = i)}
        />
      </section>

      <section>
        <h3>Flagged sections</h3>
        <SectionList sections={result.sections} selected={focusSection} onselect={(i) => (focusSection = i)} />
      </section>
    {:else if loading}
      <p class="placeholder">Loading…</p>
    {:else}
      <p class="placeholder">Add a GPX file to see where a hike is exposed.</p>
    {/if}
  </main>
</div>

<style>
  .layout {
    display: grid;
    grid-template-columns: 18rem minmax(0, 1fr);
    min-height: 100vh;
  }
  aside {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 1rem;
    border-right: 1px solid var(--border);
  }
  h1 {
    margin: 0;
    font-size: 1.2rem;
  }
  main {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 1rem 1.25rem 2rem;
    min-width: 0;
  }
  header {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: flex-start;
    gap: 0.75rem 1.5rem;
  }
  h2 {
    margin: 0 0 0.35rem;
    font-size: 1.3rem;
    overflow-wrap: anywhere;
  }
  h3 {
    margin: 0 0 0.5rem;
    font-size: 1rem;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 1rem;
    margin: 0;
    color: var(--text-muted);
    font-size: 0.9rem;
  }
  .note {
    margin: 0.4rem 0 0;
    color: var(--text-muted);
    font-size: 0.85rem;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
  }
  .actions-label {
    color: var(--text-muted);
    font-size: 0.85rem;
  }
  button {
    padding: 0.35rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--bg-elevated);
    color: var(--text);
    font: inherit;
    font-size: 0.85rem;
    cursor: pointer;
  }
  button:hover {
    border-color: var(--accent);
  }
  button.active {
    border-color: var(--accent);
    background: var(--accent);
    color: #ffffff;
  }
  button.danger {
    margin-left: 0.6rem;
    color: var(--error);
  }
  .breakdown ul {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 1.25rem;
    list-style: none;
    margin: 0.5rem 0 0;
    padding: 0;
    color: var(--text-muted);
    font-size: 0.85rem;
  }
  .breakdown li {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }
  .breakdown strong {
    color: var(--text);
    font-weight: 600;
  }
  .bar {
    display: flex;
    gap: 2px;
    height: 0.6rem;
  }
  .bar span {
    border-radius: 3px;
    min-width: 3px;
  }
  .dot {
    width: 0.65rem;
    height: 0.65rem;
    border-radius: 999px;
  }
  .map {
    position: relative;
    height: 52vh;
    min-height: 320px;
  }
  .reset {
    position: absolute;
    top: 0.6rem;
    left: 0.6rem;
    background: var(--bg);
  }
  .error {
    margin: 0;
    padding: 0.6rem 0.8rem;
    border: 1px solid var(--error);
    border-radius: 0.5rem;
    color: var(--error);
  }
  .placeholder {
    color: var(--text-muted);
  }

  @media (max-width: 760px) {
    .layout {
      grid-template-columns: minmax(0, 1fr);
    }
    aside {
      border-right: none;
      border-bottom: 1px solid var(--border);
    }
    main {
      padding: 1rem;
    }
    .map {
      height: 45vh;
    }
  }
</style>
