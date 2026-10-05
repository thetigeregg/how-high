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
    setMarkCause,
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
  import type {
    AnalysisDetail,
    AnalysisSummary,
    Leg,
    Mark,
    MarkCause,
    MarkKind,
    Range,
    Rating,
    SideSummary,
    Status,
    Verdict,
  } from "./types.js";

  let analyses = $state<AnalysisSummary[]>([]);
  let detail = $state<AnalysisDetail | null>(null);
  let selectedId = $state<number | null>(null);
  let uploading = $state(false);
  let linksAvailable = $state(false);
  // Hikes and routes are listed separately; this is the list showing in the sidebar.
  let tab = $state<"hike" | "route">("hike");
  const listed = $derived(analyses.filter((a) => a.kind === tab));
  const counts = $derived({
    hike: analyses.filter((a) => a.kind === "hike").length,
    route: analyses.filter((a) => a.kind === "route").length,
  });

  function showTab(kind: "hike" | "route") {
    tab = kind;
    // Keep the open entry in step with the list, when the list has anything.
    const first = analyses.find((a) => a.kind === kind);
    if (first && analyses.find((a) => a.id === selectedId)?.kind !== kind) void select(first.id);
  }
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
    // Following a link to a stretch on the other list switches lists with it.
    tab = analyses.find((a) => a.id === id)?.kind ?? tab;
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

  // Rating or marking something implies it has been done, and done entries
  // carry no forecast, so the whole entry is fetched again after either.
  async function refresh(id: number) {
    const loaded = await fetchAnalysis(id);
    replaceSummary(loaded.summary);
    if (selectedId === id) detail = loaded;
  }

  function rate(rating: Rating) {
    if (!detail) return;
    const { id, rating: current } = detail.summary;
    void run(async () => {
      await updateAnalysis(id, { rating: current === rating ? null : rating });
      await refresh(id);
    });
  }

  function setStatus(status: Status) {
    if (!detail || detail.summary.status === status) return;
    const { id } = detail.summary;
    void run(async () => {
      await updateAnalysis(id, { status });
      await refresh(id);
    });
  }

  /** Where the drops are along one stretch of a ride, and what follows from it. */
  function sideText(leg: Leg, side: SideSummary): string {
    if (side.sit === "either") return "Nothing flagged; either side is fine.";
    const parts = [
      side.rightM > 0 ? `on the right for ${km(side.rightM)}` : "",
      side.leftM > 0 ? `on the left for ${km(side.leftM)}` : "",
      side.bothM > 0 ? `on both sides for ${km(side.bothM)}` : "",
    ].filter(Boolean);
    const where = `Drops are ${parts.join(", ")}.`;
    if (side.sit === "none") return `No better side. ${where}`;
    // For a car the choice of seat is rarely open, so it is described rather than advised.
    if (leg.mode === "drive") return `Drops are mostly on the ${side.sit === "left" ? "right" : "left"}. ${where}`;
    return `Sit on the ${side.sit}. ${where}`;
  }

  const VERDICT_WORD: Record<MarkKind, string> = {
    fine: "you marked fine",
    uneasy: "you marked uneasy",
    bad: "you marked bad",
    turned_back: "is where you turned back",
  };
  const VERDICT_TITLE: Record<Verdict["tone"], string> = {
    beyond: "Harder than anything you have marked",
    difficult: "Likely to be difficult",
    unknown: "Between what was fine and what was not",
    fine: "Within what you have found fine",
  };

  // How the route stands apart from its short spots, as the start of a headline and as a closing sentence.
  const REST_TITLE: Record<Verdict["tone"], string> = {
    fine: "Mostly within what you have found fine",
    unknown: "Mostly milder than anything that bothered you",
    difficult: "Likely to be difficult",
    beyond: "Harder than anything you have marked",
  };
  const REST_TEXT: Record<Verdict["tone"], string> = {
    fine: "The rest scores no higher than stretches you marked fine.",
    unknown: "The rest scores above what you marked fine, but below everything that bothered you.",
    difficult: "The rest still reaches levels that bothered you.",
    beyond: "The rest is also harder than anything you have marked.",
  };

  function verdictTitle(verdict: Verdict): string {
    if (!verdict.brief) return VERDICT_TITLE[verdict.tone];
    const spots = verdict.brief.spots === 1 ? "one short spot" : `${verdict.brief.spots} short spots`;
    return `${REST_TITLE[verdict.brief.restTone]}, apart from ${spots}`;
  }

  function verdictText(verdict: Verdict): string {
    const ref = verdict.reference;
    const where = ref ? `km ${(ref.startM / 1000).toFixed(2)} of ${ref.name || "an untitled hike"}, which ${VERDICT_WORD[ref.kind]}` : "";
    if (verdict.brief) {
      const metres = `${Math.round(verdict.lengthAtOrAboveM)} m`;
      const at = `${verdict.brief.spots === 1 ? "at" : "starting at"} km ${(verdict.brief.firstAtM / 1000).toFixed(2)}`;
      const reach = verdict.tone === "beyond" ? "scores above" : "reaches the level of";
      return `${metres} ${at} ${reach} ${where}. ${REST_TEXT[verdict.brief.restTone]}`;
    }
    const length = `${km(verdict.lengthAtOrAboveM)} of this is at or above that level`;
    if (verdict.tone === "beyond") return `Its worst stretch scores above ${where}. ${length}.`;
    if (verdict.tone === "difficult") return `It reaches the level of ${where}. ${length}.`;
    if (verdict.tone === "fine") return `Nothing here scores above ${where}.`;
    return "It scores above everything you have marked fine, but below everything that bothered you. There is nothing to compare it with yet.";
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

  // A stretch that was not fine is asked one more thing before it is saved:
  // what it was. This holds the answer to the first question meanwhile.
  let pendingKind = $state<MarkKind | null>(null);
  const causes: Array<{ value: MarkCause; label: string }> = [
    { value: "drops", label: "The drop beside me" },
    { value: "view", label: "The view" },
    { value: "both", label: "Both" },
    { value: "other", label: "Something else" },
  ];
  const causeLabel: Record<MarkCause, string> = {
    drops: "the drop beside me",
    view: "the view",
    both: "the drop and the view",
    other: "something else",
  };

  $effect(() => {
    // A new selection starts the question over.
    void selection;
    pendingKind = null;
  });

  function addMark(kind: MarkKind, cause: MarkCause | null = null) {
    if (!detail || !selection) return;
    const id = detail.summary.id;
    // Turning back happens at one place: the start of whatever is selected.
    const range = kind === "turned_back" ? { startM: selection.startM, endM: selection.startM } : selection;
    void run(async () => {
      await createMark(id, kind, range, cause);
      await refresh(id);
      selection = null;
    });
  }

  /**
   * For a long stretch marked as difficult: how much of it the model flags at
   * all. Shown beside the mark, so a stretch that was bad throughout but is
   * mostly rated Easy stands out.
   */
  function flaggedShare(mark: Mark): number | null {
    if (!detail || mark.kind === "fine" || mark.endM - mark.startM < 300) return null;
    const { points, thresholds } = detail.result;
    let scored = 0;
    let flagged = 0;
    for (const p of points) {
      if (p.dist < mark.startM || p.dist > mark.endM || p.score === null || p.context?.tunnel) continue;
      scored++;
      if (p.score >= thresholds[0]) flagged++;
    }
    return scored === 0 ? null : flagged / scored;
  }

  function changeCause(mark: Mark, cause: MarkCause | null) {
    if (!detail) return;
    const id = detail.summary.id;
    void run(async () => {
      await setMarkCause(id, mark.id, cause);
      await refresh(id);
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

  function rename() {
    if (!detail) return;
    const { id, name } = detail.summary;
    const next = prompt("Name", name)?.trim();
    if (!next || next === name) return;
    void run(async () => replaceSummary(await updateAnalysis(id, { name: next })));
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
      const next = analyses.find((a) => a.kind === tab) ?? analyses[0];
      if (next) await select(next.id);
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
      const first = linked ?? analyses.find((a) => a.kind === "hike") ?? analyses[0];
      if (first) await select(first.id);
    });
  });
</script>

<div class="layout">
  <aside>
    <div class="title">
      <h1>How High</h1>
      <button type="button" onclick={() => (settingsOpen = true)}>Settings</button>
    </div>
    {#if linksAvailable || counts.route > 0}
      <div class="tabs" role="tablist" aria-label="What to list">
        {#each [{ kind: "hike", label: "Hikes" }, { kind: "route", label: "Routes" }] as const as t}
          <button
            type="button"
            role="tab"
            aria-selected={tab === t.kind}
            class:active={tab === t.kind}
            onclick={() => showTab(t.kind)}
          >
            {t.label} <span>{counts[t.kind]}</span>
          </button>
        {/each}
      </div>
    {/if}
    <Upload
      busy={uploading}
      kind={tab}
      links={linksAvailable}
      onfile={(file) => add(() => uploadGpx(file))}
      onlink={(url) => add(() => addRoute(url))}
    />
    <HikeLibrary
      analyses={listed}
      {selectedId}
      onselect={select}
      empty={tab === "hike" ? "No hikes yet." : "No routes yet."}
    />
  </aside>

  <main>
    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}

    {#if detail}
      {@const result = detail.result}
      <header>
        <div>
          <h2>
            {detail.summary.name || "Untitled"}
            <button type="button" class="rename" onclick={rename}>Rename</button>
          </h2>
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
            {#if result.legs.some((leg) => leg.sides)}
              <div class="sides">
                <strong>Which side the drops are on</strong>
                <ul>
                  {#each result.legs as leg}
                    {#each leg.sides ?? [] as side, i}
                      <li>
                        <button type="button" class="quiet" onclick={() => (selection = { startM: side.startM, endM: side.endM })}>
                          {leg.label}{(leg.sides?.length ?? 0) > 1
                            ? `, ${i === 0 ? "up to" : "after the train reverses at"} km ${((i === 0 ? side.endM : side.startM) / 1000).toFixed(1)}`
                            : ""}
                        </button>
                        <span>{sideText(leg, side)}</span>
                      </li>
                    {/each}
                  {/each}
                </ul>
                <span class="basis">
                  Left and right are as you face the direction of travel. Tunnels are left out.
                  {#if result.legs.some((leg) => leg.mode === "bus")}In a bus the right-hand seats are also nearer the edge of the road.{/if}
                </span>
              </div>
            {/if}
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
          <div class="status" role="group" aria-label="Whether you have done this">
            {#each [{ value: "planned", label: "Planned" }, { value: "done", label: "Done" }] as const as s}
              <button type="button" class:active={detail.summary.status === s.value} onclick={() => setStatus(s.value)}>
                {s.label}
              </button>
            {/each}
          </div>
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

      {#if detail.verdict}
        {@const verdict = detail.verdict}
        <div class="verdict {verdict.brief?.restTone ?? verdict.tone}">
          <strong>{verdictTitle(verdict)}</strong>
          <span>
            {verdictText(verdict)}
            {#if verdict.reference}
              {@const ref = verdict.reference}
              <button type="button" class="quiet" onclick={() => select(ref.analysisId, { startM: ref.startM, endM: ref.endM })}>
                Show that stretch
              </button>
            {/if}
          </span>
          <span class="basis">
            Judged by the score that holds even if the line is a few metres off, against stretches you have marked on
            other {detail.summary.kind === "route" ? "routes" : "hikes"}.
          </span>
        </div>
      {:else if detail.summary.status === "planned"}
        <p class="note">
          No forecast yet: there are no marked {detail.summary.kind === "route" ? "routes" : "hikes"} to judge this
          against. Mark how stretches felt on ones you have done.
        </p>
      {/if}

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
          {#if selection && pendingKind}
            {@const kind = pendingKind}
            <span>
              <strong>{markLabel[kind]}</strong> at {kmRange(selection)}. What was it?
            </span>
            {#each causes as cause}
              <button type="button" onclick={() => addMark(kind, cause.value)}>{cause.label}</button>
            {/each}
            <button type="button" class="quiet" onclick={() => addMark(kind)}>Not sure</button>
            <button type="button" class="quiet" onclick={() => (pendingKind = null)}>Back</button>
          {:else if selection}
            <span>How was <strong>{kmRange(selection)}</strong>?</span>
            {#each markKinds as kind}
              <button type="button" onclick={() => (kind.value === "fine" ? addMark("fine") : (pendingKind = kind.value))}>
                {kind.label}
              </button>
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
                {#if mark.kind !== "fine"}
                  {@const share = flaggedShare(mark)}
                  {#if share !== null}
                    <span class="share">the model flags {Math.round(share * 100)}% of it</span>
                  {/if}
                  <label class="cause">
                    because of
                    <select
                      value={mark.cause ?? ""}
                      onchange={(e) => changeCause(mark, (e.currentTarget.value || null) as MarkCause | null)}
                    >
                      <option value="">not said</option>
                      {#each causes as cause}
                        <option value={cause.value}>{causeLabel[cause.value]}</option>
                      {/each}
                    </select>
                  </label>
                {/if}
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
  .tabs {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2px;
    padding: 2px;
    border-radius: 0.6rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
  }
  .tabs button {
    border: none;
    border-radius: 0.45rem;
    background: none;
    font-size: 0.9rem;
  }
  .tabs button.active {
    background: var(--bg);
    color: var(--text);
    font-weight: 600;
    box-shadow: 0 0 0 1px var(--border);
  }
  .tabs span {
    color: var(--text-muted);
    font-weight: 400;
    margin-left: 0.2rem;
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
  .status {
    display: inline-flex;
    margin-right: 0.6rem;
  }
  .status button:first-child {
    border-radius: 999px 0 0 999px;
    border-right: none;
  }
  .status button:last-child {
    border-radius: 0 999px 999px 0;
  }
  .verdict {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.7rem 0.9rem;
    border: 1px solid var(--border);
    border-left-width: 4px;
    border-radius: 0.5rem;
    font-size: 0.95rem;
  }
  /* The edge colour repeats what the title says in words. */
  .verdict.beyond {
    border-left-color: #d03b3b;
  }
  .verdict.difficult {
    border-left-color: #ec835a;
  }
  .verdict.unknown {
    border-left-color: var(--text-faint);
  }
  .verdict.fine {
    border-left-color: #0ca30c;
  }
  .sides {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin-top: 0.7rem;
    font-size: 0.9rem;
  }
  .sides ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .sides li {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.1rem 0.6rem;
  }
  .sides button {
    padding: 0;
    color: var(--text);
    font-weight: 600;
    font-size: inherit;
    text-align: left;
  }
  .sides li span {
    color: var(--text-muted);
  }
  .sides .basis,
  .verdict .basis {
    color: var(--text-muted);
    font-size: 0.8rem;
  }
  .verdict button {
    padding: 0;
    text-decoration: underline;
    color: var(--accent);
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
  button.rename {
    margin-left: 0.4rem;
    vertical-align: middle;
    font-weight: 400;
    color: var(--text-muted);
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
  .cause {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    margin-right: auto;
    color: var(--text-muted);
    font-size: 0.85rem;
  }
  .share {
    color: var(--text-muted);
    font-size: 0.85rem;
  }
  .cause select {
    padding: 0.2rem 0.4rem;
    border: 1px solid var(--border);
    border-radius: 0.4rem;
    background: var(--bg-elevated);
    color: var(--text);
    font: inherit;
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
