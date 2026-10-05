<script lang="ts">
  import { onMount } from "svelte";
  import {
    addRoute,
    createMark,
    deleteAnalysis,
    deleteMark,
    fetchAnalyses,
    fetchAnalysis,
    fetchMeta,
    reanalyse,
    updateAnalysis,
    uploadGpx,
  } from "./api.js";
  import ExposureProfile from "./lib/ExposureProfile.svelte";
  import HikeLibrary from "./lib/HikeLibrary.svelte";
  import LevelBadge from "./lib/LevelBadge.svelte";
  import { km, LEVEL_COLOR, LEVEL_LABEL, LEVELS, pointLevels } from "./lib/levels.js";
  import RouteMap from "./lib/RouteMap.svelte";
  import SectionList from "./lib/SectionList.svelte";
  import SettingsModal from "./lib/SettingsModal.svelte";
  import Upload from "./lib/Upload.svelte";
  import type { AnalysisDetail, AnalysisSummary, Mark, MarkKind, Range, Rating } from "./types.js";

  let analyses = $state<AnalysisSummary[]>([]);
  let detail = $state<AnalysisDetail | null>(null);
  let selectedId = $state<number | null>(null);
  let uploading = $state(false);
  let linksAvailable = $state(false);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let hoverIndex = $state<number | null>(null);
  // The stretch (or single point) currently picked on the chart, map or table.
  let selection = $state<Range | null>(null);

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

  async function select(id: number, then: Range | null = null) {
    selectedId = id;
    // Keeps the open hike across reloads and makes it linkable.
    history.replaceState(null, "", `#${id}`);
    hoverIndex = null;
    selection = null;
    loading = true;
    await run(async () => {
      const loaded = await fetchAnalysis(id);
      // Ignore a slow response for a hike the user has already clicked away from.
      if (selectedId !== id) return;
      detail = loaded;
      selection = then;
    });
    loading = false;
  }

  async function add(create: () => Promise<AnalysisSummary>) {
    uploading = true;
    await run(async () => {
      const created = await create();
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

  const markKinds: Array<{ value: MarkKind; label: string }> = [
    { value: "fine", label: "Fine" },
    { value: "uneasy", label: "Uneasy" },
    { value: "bad", label: "Bad" },
    { value: "turned_back", label: "Turned back here" },
  ];
  const markLabel: Record<MarkKind, string> = {
    fine: "Fine",
    uneasy: "Uneasy",
    bad: "Bad",
    turned_back: "Turned back",
  };
  const kmRange = (r: Range) =>
    r.endM > r.startM
      ? `km ${(r.startM / 1000).toFixed(2)}–${(r.endM / 1000).toFixed(2)} (${Math.round(r.endM - r.startM)} m)`
      : `km ${(r.startM / 1000).toFixed(2)}`;

  function addMark(kind: MarkKind) {
    if (!detail || !selection) return;
    const id = detail.summary.id;
    // Turning back happens at one place: the start of whatever is selected.
    const range = kind === "turned_back" ? { startM: selection.startM, endM: selection.startM } : selection;
    void run(async () => {
      const mark = await createMark(id, kind, range);
      if (detail?.summary.id === id) {
        detail = { ...detail, marks: [...detail.marks, mark].sort((a, b) => a.startM - b.startM) };
      }
      selection = null;
    });
  }

  function removeMark(mark: Mark) {
    if (!detail) return;
    const id = detail.summary.id;
    void run(async () => {
      await deleteMark(id, mark.id);
      if (detail?.summary.id === id) detail = { ...detail, marks: detail.marks.filter((m) => m.id !== mark.id) };
    });
  }

  let reanalysing = $state(false);
  let settingsOpen = $state(false);

  // Settings apply to every hike, so both the library and the open hike are stale after a change.
  function settingsChanged() {
    void run(async () => {
      analyses = await fetchAnalyses();
      if (selectedId !== null) {
        const id = selectedId;
        const loaded = await fetchAnalysis(id);
        if (selectedId === id) detail = loaded;
      }
    });
  }

  async function rerun() {
    if (!detail) return;
    const { id } = detail.summary;
    reanalysing = true;
    await run(async () => {
      replaceSummary(await reanalyse(id));
      if (selectedId === id) detail = await fetchAnalysis(id);
    });
    reanalysing = false;
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

  // While the open hike is still waiting for map context, look again now and then.
  $effect(() => {
    if (!detail || detail.result.mapContext === true) return;
    const id = detail.summary.id;
    const timer = setInterval(async () => {
      const loaded = await fetchAnalysis(id).catch(() => null);
      if (!loaded?.result.mapContext || selectedId !== id) return;
      detail = loaded;
      analyses = await fetchAnalyses().catch(() => analyses);
    }, 30_000);
    return () => clearInterval(timer);
  });

  onMount(() => {
    fetchMeta()
      .then((meta) => (linksAvailable = meta.googleMaps))
      .catch(() => {});
    void run(async () => {
      analyses = await fetchAnalyses();
      const linked = analyses.find((a) => a.id === Number(location.hash.slice(1)));
      if (analyses.length > 0) await select((linked ?? analyses[0]).id);
    });
  });
</script>

<div class="layout">
  <aside>
    <div class="title">
      <h1>How High</h1>
      <button type="button" onclick={() => (settingsOpen = true)}>Settings</button>
    </div>
    <Upload
      busy={uploading}
      links={linksAvailable}
      onfile={(file) => add(() => uploadGpx(file))}
      onlink={(url) => add(() => addRoute(url))}
    />
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
            {#if detail.summary.sourceUrl}
              <a href={detail.summary.sourceUrl} target="_blank" rel="noreferrer">Open in Google Maps</a>
            {/if}
          </p>
          {#if detail.summary.kind === "route"}
            <ol class="legs">
              {#each result.legs as leg}
                <li>
                  <button type="button" onclick={() => (selection = { startM: leg.startM, endM: leg.endM })}>
                    {leg.label}
                    <span>{km(leg.endM - leg.startM)}</span>
                  </button>
                </li>
              {/each}
            </ol>
            <p class="note">
              This is the route Google suggests now; it can differ from the one shown when the link was shared. Roads
              and railways are scored from the terrain beside them: guardrails and which side you sit on are not known.
            </p>
            {#if result.summary.noDataM > 0}
              <p class="note">
                {km(result.summary.noDataM)} of this route is not scored (grey on the map): there Google's line strays
                from the mapped road or track, so the terrain under it says nothing about the ride.
              </p>
            {/if}
          {/if}
          {#if result.mapContext !== true}
            <p class="note">
              Map data is incomplete: OpenStreetMap could not be reached for all of this route, so forest, bridges
              and tunnels are missing in places. This is retried in the background and the page updates when it
              succeeds.
            </p>
          {/if}
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
          <button type="button" class="spaced" disabled={reanalysing} onclick={rerun}>
            {reanalysing ? "Re-analysing…" : "Re-analyse"}
          </button>
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
            <li>Not scored <strong>{km(result.summary.noDataM)}</strong></li>
          {/if}
        </ul>
      </div>

      <div class="map">
        <RouteMap
          analysis={result}
          {levels}
          {hoverIndex}
          focus={selection}
          onhover={(i) => (hoverIndex = i)}
          onpick={(i) => (selection = { startM: result.points[i].dist, endM: result.points[i].dist })}
        />
        {#if selection}
          <button type="button" class="reset" onclick={() => (selection = null)}>Show whole route</button>
        {/if}
      </div>

      <section>
        <ExposureProfile
          analysis={result}
          {levels}
          {hoverIndex}
          {selection}
          marks={detail.marks}
          onhover={(i) => (hoverIndex = i)}
          onselect={(range) => (selection = range)}
        />
        <div class="marking">
          {#if selection}
            <span>How was <strong>{kmRange(selection)}</strong>?</span>
            {#each markKinds as kind}
              <button type="button" onclick={() => addMark(kind.value)}>{kind.label}</button>
            {/each}
            <button type="button" class="quiet" onclick={() => (selection = null)}>Cancel</button>
          {:else}
            <span class="hint">
              Drag across the chart to pick a stretch, or click a point or flagged section, then say how it felt.
            </span>
          {/if}
        </div>
      </section>

      {#if detail.marks.length > 0}
        <section>
          <h3>Your marks</h3>
          <ul class="marks">
            {#each detail.marks as mark (mark.id)}
              <li>
                <button type="button" class="quiet" onclick={() => (selection = { startM: mark.startM, endM: mark.endM })}>
                  <strong>{markLabel[mark.kind]}</strong>
                  {kmRange(mark)}
                </button>
                <button type="button" class="quiet" aria-label="Remove mark" onclick={() => removeMark(mark)}>Remove</button>
              </li>
            {/each}
          </ul>
        </section>
      {/if}

      <section>
        <h3>Flagged sections</h3>
        <SectionList
          sections={result.sections}
          analysisId={detail.summary.id}
          selected={selection}
          onselect={(i) => (selection = { startM: result.sections[i].startM, endM: result.sections[i].endM })}
          onopen={(id, range) => (id === selectedId ? (selection = range) : void select(id, range))}
        />
      </section>
    {:else if loading}
      <p class="placeholder">Loading…</p>
    {:else}
      <p class="placeholder">Add a GPX file to see where a hike is exposed.</p>
    {/if}
  </main>
</div>

{#if settingsOpen}
  <SettingsModal onclose={() => (settingsOpen = false)} onchange={settingsChanged} />
{/if}

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
  .title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
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
  .meta a {
    color: var(--accent);
  }
  .legs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    list-style: none;
    margin: 0.6rem 0 0;
    padding: 0;
  }
  .legs button {
    border-radius: 0.4rem;
  }
  .legs span {
    color: var(--text-muted);
    margin-left: 0.3rem;
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
  button.spaced {
    margin-left: 0.6rem;
  }
  button:disabled {
    cursor: progress;
    color: var(--text-muted);
  }
  button.danger {
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
  .marking {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
    min-height: 2.2rem;
    margin-top: 0.5rem;
    font-size: 0.9rem;
  }
  .hint {
    color: var(--text-muted);
    font-size: 0.85rem;
  }
  button.quiet {
    border-color: transparent;
    background: none;
    color: var(--text-muted);
  }
  .marks {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .marks li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    border-bottom: 1px solid var(--border-subtle);
  }
  .marks strong {
    color: var(--text);
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
