<script lang="ts">
  import { onMount } from "svelte";
  import { applySettings, fetchSettings, revertSettings, saveSettings, suggestSettings } from "../api.js";
  import type { Disagreement, EntryState, Proposal, Settings, SettingsResponse, Verdict } from "../types.js";
  import { LEVEL_LABEL } from "./levels.js";

  let {
    initial,
    onclose,
    onchange,
  }: {
    /** Which set of scoring knobs to open on: the one for what is showing behind the modal. */
    initial: "score" | "road";
    onclose: () => void;
    onchange: () => void;
  } = $props();

  type Group = "score" | "measure" | "noGo";
  interface Knob {
    group: Group;
    key: string;
    label: string;
    help: string;
    unit?: string;
    step?: number;
    /** Labels for the individual values of a multi-value knob. */
    parts?: string[];
  }
  interface Section {
    title: string;
    intro?: string;
    advanced?: boolean;
    knobs: Knob[];
  }

  const COUNTS = ["starts counting at", "counts fully at"];

  const sections: Section[] = [
    {
      title: "Levels",
      intro: "Every point gets a score from 0 to 100. These decide which scores get which colour.",
      knobs: [
        {
          group: "score",
          key: "thresholds",
          label: "Where each level starts",
          help: "Lower these to be warned earlier, raise them to be warned less.",
          parts: ["Mild from", "Exposed from", "Severe from"],
        },
      ],
    },
    {
      title: "Drops",
      intro:
        "What the terrain beside the path has to look like to count. Each has two values: below the first it adds nothing, at the second it counts in full.",
      knobs: [
        {
          group: "score",
          key: "fallHeightM",
          label: "Fall height",
          unit: "m",
          parts: COUNTS,
          help: "Height you would lose down the steep fall line right beside the path before the ground eases off.",
        },
        {
          group: "score",
          key: "drop10M",
          label: "Drop within 10 m",
          unit: "m",
          parts: COUNTS,
          help: "How far the ground falls within 10 m of you: an edge right next to the path.",
        },
        {
          group: "score",
          key: "drop30M",
          label: "Drop within 30 m",
          unit: "m",
          parts: COUNTS,
          help: "How far the ground falls within 30 m: steep ground close by.",
        },
        {
          group: "score",
          key: "drop100M",
          label: "Drop within 100 m",
          unit: "m",
          parts: COUNTS,
          help: "How far the ground falls within 100 m: a long open slope below you. Only counted where the ground already falls away nearby.",
        },
        {
          group: "score",
          key: "crossSlopeDeg",
          label: "Side slope",
          unit: "°",
          parts: COUNTS,
          help: "Steepness of the ground across the path, where you are traversing a hillside.",
        },
      ],
    },
    {
      title: "Modifiers",
      intro: "Things that raise or lower the score from the drops.",
      knobs: [
        {
          group: "score",
          key: "forestFactor",
          label: "Forest",
          unit: "×",
          step: 0.05,
          help: "Score is multiplied by this where the slope below the path is wooded. 1 means trees make no difference, 0.5 halves the score.",
        },
        {
          group: "score",
          key: "wideTrackFactor",
          label: "Wide track",
          unit: "×",
          step: 0.05,
          help: "Score is multiplied by this on forestry roads and paths mapped as at least 2.5 m wide.",
        },
        {
          group: "score",
          key: "ridgeDropM",
          label: "Ridge: drop on both sides",
          unit: "m",
          help: "A point counts as a ridge when the ground falls at least this far within 30 m on both sides.",
        },
        {
          group: "score",
          key: "ridgeFactor",
          label: "Ridge: increase",
          unit: "×",
          step: 0.05,
          help: "Score is multiplied by this on a ridge.",
        },
        {
          group: "score",
          key: "trackGradeDeg",
          label: "Steep path",
          unit: "°",
          parts: COUNTS,
          help: "Up to 10 extra points when the path itself climbs or descends this steeply.",
        },
        {
          group: "score",
          key: "bridgeGapM",
          label: "Bridge height",
          unit: "m",
          parts: COUNTS,
          help: "Height above the ground on a bridge. At the second value a bridge alone scores 100.",
        },
      ],
    },
    {
      title: "Open views",
      intro:
        "Separate from drops: how much height the view shows, even from a flat and safe path. From each spot the app works out what ground is visible and how far below you it lies.",
      knobs: [
        {
          group: "score",
          key: "viewDepthM",
          label: "Depth of the view",
          unit: "m",
          parts: COUNTS,
          help: "How far below you the visible ground lies, across the width set below. A valley floor 400 m down counts for more than fields 150 m down.",
        },
        {
          group: "score",
          key: "viewArcDeg",
          label: "Width of the view",
          unit: "°",
          step: 10,
          help: "How much of the horizon has to show that depth. 90 means a quarter of the way round; lower it and a glimpse through a gap counts too.",
        },
        {
          group: "score",
          key: "viewFarWeight",
          label: "Distant ground",
          unit: "×",
          step: 0.05,
          help: "How much ground 2 to 8 km away counts compared with ground within 2 km. 0.5 means a plain 400 m below in the distance counts like 200 m nearby.",
        },
        {
          group: "score",
          key: "viewForestFactor",
          label: "Forest",
          unit: "×",
          step: 0.05,
          help: "The view score is multiplied by this where the map shows forest at the spot, since trees hide most of a view.",
        },
        {
          group: "score",
          key: "viewFactor",
          label: "How much views count",
          unit: "×",
          step: 0.05,
          help: "The view score is multiplied by this. 0 leaves views out altogether, which is the starting point for car, bus and train.",
        },
      ],
    },
    {
      title: "Sections",
      intro: "How scored points are grouped into the flagged sections that are listed and coloured.",
      knobs: [
        {
          group: "score",
          key: "mergeGapM",
          label: "Merge gap",
          unit: "m",
          help: "Flagged stretches closer together than this are shown as one section.",
        },
        {
          group: "score",
          key: "minLengthM",
          label: "Minimum length",
          unit: "m",
          help: "Flagged stretches shorter than this are ignored, unless they reach Severe.",
        },
      ],
    },
    {
      title: "No-go transport",
      intro: "Kinds of transport that make a route a no-go outright: that stretch is rated Severe whatever the terrain. Rack railways are recognised only where the map marks the rack rail.",
      knobs: [
        { group: "noGo", key: "cableCars", label: "Cable cars, gondolas and chairlifts", help: "" },
        { group: "noGo", key: "funiculars", label: "Funiculars", help: "" },
        { group: "noGo", key: "rackRailways", label: "Rack railways", help: "" },
      ],
    },
    {
      title: "Advanced",
      advanced: true,
      intro: "The first four change what is measured, so every hike is measured again when they change. That takes a few seconds per hike.",
      knobs: [
        {
          group: "measure",
          key: "fallSlopeDeg",
          label: "Fall steepness",
          unit: "°",
          help: "Ground steeper than this counts as somewhere you would keep falling. Lower it and gentler slopes add to the fall height.",
        },
        {
          group: "measure",
          key: "fallRunoutM",
          label: "Fall run-out",
          unit: "m",
          help: "A fall ends once this much gentler ground has been crossed. Higher values let a fall continue over small ledges.",
        },
        {
          group: "measure",
          key: "gpsErrorM",
          label: "GPS error",
          unit: "m",
          help: "The route is also scored shifted this far to each side. The lowest result is the 'at least' score in the section table.",
        },
        {
          group: "measure",
          key: "forestCheckM",
          label: "Forest check distance",
          unit: "m",
          help: "Trees must reach this far down the exposed side for a point to count as wooded.",
        },
        {
          group: "score",
          key: "dropWeight",
          label: "Balance: drops versus side slope",
          step: 0.05,
          help: "Share of the score that comes from drops. The rest comes from side slope. 0.75 means 75% drops, 25% side slope.",
        },
      ],
    },
  ];

  // The Levels, Drops, Modifiers and Sections knobs exist twice: once for
  // hikes and walking, once for car, bus and train. This picks which is shown.
  // svelte-ignore state_referenced_locally (only the starting value is wanted)
  let scoreGroup = $state<"score" | "road">(initial);
  const groupOf = (knob: Knob) => (knob.group === "score" ? scoreGroup : knob.group);

  let data = $state<SettingsResponse | null>(null);
  let draft = $state<Settings | null>(null);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let dialog: HTMLDialogElement;
  let timer: ReturnType<typeof setTimeout> | undefined;

  type Value = number | boolean | number[];
  const read = (settings: Settings, knob: Knob) => (settings[groupOf(knob)] as unknown as Record<string, Value>)[knob.key];
  const write = (knob: Knob, value: Value) => {
    if (!draft) return;
    (draft[groupOf(knob)] as unknown as Record<string, Value>)[knob.key] = value;
    scheduleSave();
  };
  const isDefault = (knob: Knob) =>
    !draft || !data || JSON.stringify(read(draft, knob)) === JSON.stringify(read(data.defaults, knob));
  const format = (value: Value, unit = "") =>
    typeof value === "boolean" ? (value ? "on" : "off") : (Array.isArray(value) ? value.join(" – ") : String(value)) + (unit ? ` ${unit}` : "");

  // Saving is debounced so typing a number does not re-score on every keystroke.
  function scheduleSave() {
    clearTimeout(timer);
    timer = setTimeout(save, 500);
  }

  async function save() {
    if (!draft) return;
    saving = true;
    try {
      data = await saveSettings($state.snapshot(draft));
      error = null;
      onchange();
    } catch (err) {
      // Typically a half-typed or out-of-range value; the last valid settings stay in force.
      error = (err as Error).message === "invalid settings" ? "Some values are out of range or in the wrong order; not saved yet." : (err as Error).message;
    }
    saving = false;
  }

  // A suggestion waiting for the user's decision; nothing is saved while it is shown.
  let proposal = $state<Proposal | null>(null);
  let working = $state<"suggest" | "apply" | "revert" | null>(null);
  let confirmDialog = $state<HTMLDialogElement | null>(null);
  const knobFor = (key: string) => sections.flatMap((s) => s.knobs).find((k) => k.key === key);
  const FORECAST: Record<Verdict["tone"], string> = {
    fine: "within what was fine",
    unknown: "between fine and difficult",
    difficult: "likely difficult",
    beyond: "harder than anything marked",
  };
  const stateText = (s: EntryState) => `${LEVEL_LABEL[s.level]} (${Math.round(s.maxScore)})${s.forecast ? `, ${FORECAST[s.forecast]}` : ""}`;

  /** Runs a settings action that replaces everything shown, and reports failures in the modal. */
  async function act(kind: "suggest" | "apply" | "revert", action: () => Promise<void>) {
    clearTimeout(timer);
    working = kind;
    try {
      await action();
      error = null;
    } catch (err) {
      error = (err as Error).message;
    }
    working = null;
  }

  function adopt(loaded: SettingsResponse) {
    data = loaded;
    draft = structuredClone(loaded.settings);
    onchange();
  }

  const askForSuggestion = () =>
    act("suggest", async () => {
      // Edits not saved yet are saved first, so the suggestion starts from what is on screen.
      if (draft && data && JSON.stringify($state.snapshot(draft)) !== JSON.stringify(data.settings)) {
        data = await saveSettings($state.snapshot(draft));
      }
      proposal = await suggestSettings(scoreGroup === "score" ? "hike" : "road");
      confirmDialog?.showModal();
    });

  const applyProposal = () =>
    act("apply", async () => {
      if (!proposal) return;
      adopt(await applySettings(proposal.settings));
      confirmDialog?.close();
    });

  const revert = () => act("revert", async () => adopt(await revertSettings()));

  function resetAll() {
    if (!data) return;
    draft = structuredClone($state.snapshot(data.defaults));
    scheduleSave();
  }

  const km = (m: number) => (m / 1000).toFixed(2);
  const describe = (d: Disagreement) => {
    const where = `${d.name || "Untitled"}, km ${km(d.startM)}–${km(d.endM)}`;
    // A long stretch marked bad with something flagged in it, but most of it shown as easy.
    if (d.kind === "bad" && d.level !== "green" && d.flaggedShare !== null) {
      return `${where}: you marked all of it bad, but only ${Math.round(d.flaggedShare * 100)}% of it is flagged`;
    }
    return `${where}: you marked it ${d.kind}, shown as ${LEVEL_LABEL[d.level]}`;
  };

  onMount(() => {
    dialog.showModal();
    fetchSettings()
      .then((loaded) => {
        data = loaded;
        draft = structuredClone(loaded.settings);
      })
      .catch((err) => (error = (err as Error).message));
    return () => clearTimeout(timer);
  });
</script>

<dialog bind:this={dialog} onclose={onclose} onclick={(e) => e.target === dialog && dialog.close()}>
  <header>
    <h2>Settings</h2>
    <span class="status">{saving ? "Saving and re-scoring…" : "Changes save automatically and apply to all hikes"}</span>
    <button type="button" onclick={() => dialog.close()}>Close</button>
  </header>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  {#if data && draft}
    <section class="fit">
      <h3>Agreement with your marks</h3>
      {#if data.fit.marks === 0}
        <p>You have not marked any stretches yet. Mark how stretches felt and this shows whether the settings agree.</p>
      {:else}
        <p>
          Across {data.fit.marks} marked {data.fit.marks === 1 ? "stretch" : "stretches"}:
          <strong>{data.fit.overFlagged.length}</strong> marked fine but shown Exposed or Severe,
          <strong>{data.fit.missed.length}</strong> marked uneasy or bad but shown Easy, or mostly Easy.
        </p>
        {#if data.fit.overFlagged.length + data.fit.missed.length > 0}
          <ul>
            {#each [...data.fit.overFlagged, ...data.fit.missed] as d}
              <li>{describe(d)}</li>
            {/each}
          </ul>
        {/if}
      {/if}
      <div class="tuning">
        <button type="button" disabled={working !== null} onclick={askForSuggestion}>
          {working === "suggest" ? "Working it out…" : `Suggest settings from my marks (${scoreGroup === "score" ? "hikes" : "car, bus and train"})`}
        </button>
        {#if data.canRevert}
          <button type="button" disabled={working !== null} onclick={revert}>
            {working === "revert" ? "Reverting…" : "Revert to settings before the last suggestion"}
          </button>
        {/if}
      </div>
    </section>

    {#snippet knobs(section: Section)}
      {#if section.intro}<p class="intro">{section.intro}</p>{/if}
      {#each section.knobs as knob}
        {@const value = read(draft!, knob)}
        <div class="knob">
          <div class="text">
            <span class="label">{knob.label}</span>
            {#if knob.help}<span class="help">{knob.help}</span>{/if}
            <span class="default">
              Default {format(read(data!.defaults, knob), knob.unit)}
              {#if !isDefault(knob)}
                · <button type="button" class="link" onclick={() => write(knob, structuredClone($state.snapshot(read(data!.defaults, knob))))}>reset</button>
              {/if}
            </span>
          </div>
          <div class="inputs">
            {#if typeof value === "boolean"}
              <label class="toggle">
                <input type="checkbox" checked={value} onchange={(e) => write(knob, e.currentTarget.checked)} />
                No-go
              </label>
            {:else if Array.isArray(value)}
              {#each value as part, i}
                <label>
                  <span>{knob.parts?.[i] ?? ""}</span>
                  <span class="field">
                    <input
                      type="number"
                      step={knob.step ?? 1}
                      value={part}
                      oninput={(e) => {
                        const next = [...value];
                        next[i] = e.currentTarget.valueAsNumber;
                        if (!Number.isNaN(next[i])) write(knob, next);
                      }}
                    />
                    {knob.unit ?? ""}
                  </span>
                </label>
              {/each}
            {:else}
              <label>
                <span class="field">
                  <input
                    type="number"
                    step={knob.step ?? 1}
                    {value}
                    oninput={(e) => !Number.isNaN(e.currentTarget.valueAsNumber) && write(knob, e.currentTarget.valueAsNumber)}
                  />
                  {knob.unit ?? ""}
                </span>
              </label>
            {/if}
          </div>
        </div>
      {/each}
    {/snippet}

    <div class="tabs" role="tablist" aria-label="Which kind of travel the scoring knobs apply to">
      {#each [{ value: "score", label: "Hikes and walking" }, { value: "road", label: "Car, bus and train" }] as tab}
        <button
          type="button"
          role="tab"
          aria-selected={scoreGroup === tab.value}
          class:active={scoreGroup === tab.value}
          onclick={() => (scoreGroup = tab.value as "score" | "road")}
        >
          {tab.label}
        </button>
      {/each}
      <span>Levels, drops, modifiers, open views and sections are set separately for each. The rest is shared.</span>
    </div>

    {#each sections as section}
      {#if section.advanced}
        <details>
          <summary>{section.title}</summary>
          {@render knobs(section)}
        </details>
      {:else}
        <section>
          <h3>{section.title}</h3>
          {@render knobs(section)}
        </section>
      {/if}
    {/each}

    <footer>
      <button type="button" onclick={resetAll}>Reset everything to defaults</button>
    </footer>
  {:else if !error}
    <p class="intro">Loading…</p>
  {/if}
</dialog>

<dialog class="confirm" bind:this={confirmDialog} onclose={() => (proposal = null)}>
  {#if proposal}
    {@const kind = proposal.profile === "hike" ? "hikes" : "car, bus and train"}
    <h2>Suggested settings for {kind}</h2>
    {#if proposal.outcome === "none"}
      <p>There are no marked stretches on {proposal.profile === "hike" ? "hikes" : "routes"} to tune against. Mark how stretches felt first.</p>
    {:else if proposal.outcome === "fits"}
      <p>
        No change suggested: the present settings already agree with your {proposal.marks} marked
        {proposal.marks === 1 ? "stretch" : "stretches"}.
      </p>
    {:else}
      <p class="basis">
        Based on {proposal.marks} marked {proposal.marks === 1 ? "stretch" : "stretches"}.
        {#if proposal.marks < 10}
          That is few: several different settings would fit them equally well, so this may not hold as you mark more.
        {/if}
        Nothing is saved until you apply.
      </p>

      <h3>What would change</h3>
      <table>
        <thead>
          <tr><th>Setting</th><th>Now</th><th>Suggested</th></tr>
        </thead>
        <tbody>
          {#each proposal.changes as change}
            {@const knob = knobFor(change.key)}
            <tr>
              <td>{knob?.label ?? change.key}</td>
              <td>{format(change.current, knob?.unit)}</td>
              <td><strong>{format(change.proposed, knob?.unit)}</strong></td>
            </tr>
          {/each}
        </tbody>
      </table>

      {@const now = proposal.before.overFlagged.length + proposal.before.missed.length}
      {@const then = proposal.after.overFlagged.length + proposal.after.missed.length}
      <h3>Agreement with your marks on {proposal.profile === "hike" ? "hikes" : "routes"}</h3>
      <p>
        Disagreements now: <strong>{now}</strong>. With the suggestion: <strong>{then}</strong>.
        {#if then >= now}
          This does not settle a disagreement. It moves a marked stretch that scores close to a level boundary further
          onto the side you marked it.
        {/if}
      </p>
      {#if proposal.after.overFlagged.length + proposal.after.missed.length > 0}
        <ul>
          {#each [...proposal.after.overFlagged, ...proposal.after.missed] as d}
            <li>Still off: {describe(d)}</li>
          {/each}
        </ul>
      {/if}

      <h3>Effect on your library</h3>
      {#if proposal.library.length === 0}
        <p>No rating or forecast would change.</p>
      {:else}
        <table>
          <thead>
            <tr><th>Entry</th><th>Now</th><th>With the suggestion</th></tr>
          </thead>
          <tbody>
            {#each proposal.library as entry}
              <tr>
                <td>{entry.name || "Untitled"}</td>
                <td>{stateText(entry.before)}</td>
                <td><strong>{stateText(entry.after)}</strong></td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}

      <details>
        <summary>All settings for {kind} as they would be saved</summary>
        <table>
          <tbody>
            {#each sections.flatMap((s) => s.knobs).filter((k) => k.group === "score") as knob}
              <tr>
                <td>{knob.label}</td>
                <td>{format((proposal.settings[proposal.profile === "hike" ? "score" : "road"] as unknown as Record<string, Value>)[knob.key], knob.unit)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </details>
    {/if}

    <footer class="choices">
      {#if proposal.outcome === "changes"}
        <button type="button" class="active" disabled={working !== null} onclick={applyProposal}>
          {working === "apply" ? "Applying…" : "Apply these settings"}
        </button>
        <button type="button" onclick={() => confirmDialog?.close()}>Cancel</button>
      {:else}
        <button type="button" onclick={() => confirmDialog?.close()}>Close</button>
      {/if}
    </footer>
  {/if}
</dialog>

<style>
  dialog {
    width: min(46rem, calc(100vw - 2rem));
    max-height: calc(100vh - 2rem);
    padding: 0 1.25rem 1.25rem;
    border: 1px solid var(--border);
    border-radius: 0.8rem;
    background: var(--bg);
    color: var(--text);
  }
  dialog::backdrop {
    background: rgba(0, 0, 0, 0.45);
  }
  header {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 1rem;
    padding: 1rem 0 0.75rem;
    background: var(--bg);
    border-bottom: 1px solid var(--border-subtle);
  }
  h2 {
    margin: 0;
    font-size: 1.2rem;
  }
  h3,
  summary {
    margin: 1.25rem 0 0.25rem;
    font-size: 1rem;
    font-weight: 600;
  }
  summary {
    cursor: pointer;
  }
  .status {
    flex: 1;
    color: var(--text-muted);
    font-size: 0.85rem;
  }
  .intro,
  .fit p {
    margin: 0.25rem 0 0.5rem;
    color: var(--text-muted);
    font-size: 0.9rem;
  }
  .fit strong {
    color: var(--text);
  }
  .fit ul {
    margin: 0;
    padding-left: 1.2rem;
    color: var(--text-muted);
    font-size: 0.85rem;
  }
  .knob {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 0.5rem 1.5rem;
    padding: 0.7rem 0;
    border-bottom: 1px solid var(--border-subtle);
  }
  .text {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    flex: 1 1 16rem;
  }
  .label {
    font-weight: 500;
  }
  .help,
  .default {
    color: var(--text-muted);
    font-size: 0.85rem;
  }
  .default {
    color: var(--text-faint);
  }
  .inputs {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 0.5rem 0.9rem;
  }
  .inputs label {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    color: var(--text-muted);
    font-size: 0.8rem;
  }
  .inputs label.toggle {
    flex-direction: row;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.9rem;
    color: var(--text);
  }
  .field {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    color: var(--text-muted);
  }
  input[type="number"] {
    width: 5rem;
    padding: 0.35rem 0.45rem;
    border: 1px solid var(--border);
    border-radius: 0.4rem;
    background: var(--bg-elevated);
    color: var(--text);
    font: inherit;
    font-variant-numeric: tabular-nums;
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
  button.link {
    padding: 0;
    border: none;
    background: none;
    color: var(--accent);
    font-size: inherit;
  }
  .tabs {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
    margin-top: 1.25rem;
  }
  .tabs span {
    flex: 1 1 14rem;
    color: var(--text-muted);
    font-size: 0.85rem;
  }
  button.active {
    border-color: var(--accent);
    background: var(--accent);
    color: #ffffff;
  }
  footer {
    margin-top: 1.25rem;
  }
  .tuning,
  .choices {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }
  button:disabled {
    color: var(--text-muted);
    cursor: progress;
  }
  dialog.confirm {
    width: min(38rem, calc(100vw - 2rem));
    padding: 1.25rem;
  }
  .confirm p,
  .confirm li {
    margin: 0.25rem 0 0.5rem;
    font-size: 0.9rem;
  }
  .confirm .basis {
    color: var(--text-muted);
  }
  .confirm table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9rem;
  }
  .confirm th,
  .confirm td {
    padding: 0.35rem 0.5rem 0.35rem 0;
    text-align: left;
    border-bottom: 1px solid var(--border-subtle);
  }
  .confirm th {
    color: var(--text-muted);
    font-weight: 500;
    font-size: 0.8rem;
  }
  .confirm details {
    margin-top: 0.5rem;
  }
  .error {
    margin: 0.75rem 0 0;
    padding: 0.5rem 0.7rem;
    border: 1px solid var(--error);
    border-radius: 0.5rem;
    color: var(--error);
    font-size: 0.9rem;
  }
</style>
