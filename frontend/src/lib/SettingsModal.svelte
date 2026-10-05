<script lang="ts">
  import { onMount } from "svelte";
  import { fetchSettings, saveSettings } from "../api.js";
  import type { Disagreement, Settings, SettingsResponse } from "../types.js";
  import { LEVEL_LABEL } from "./levels.js";

  let { onclose, onchange }: { onclose: () => void; onchange: () => void } = $props();

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
  let scoreGroup = $state<"score" | "road">("score");
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

  function resetAll() {
    if (!data) return;
    draft = structuredClone($state.snapshot(data.defaults));
    scheduleSave();
  }

  const km = (m: number) => (m / 1000).toFixed(2);
  const describe = (d: Disagreement) =>
    `${d.name}, km ${km(d.startM)}–${km(d.endM)}: you marked it ${d.kind}, shown as ${LEVEL_LABEL[d.level]}`;

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
          <strong>{data.fit.missed.length}</strong> marked uneasy or bad but shown Easy.
        </p>
        {#if data.fit.overFlagged.length + data.fit.missed.length > 0}
          <ul>
            {#each [...data.fit.overFlagged, ...data.fit.missed] as d}
              <li>{describe(d)}</li>
            {/each}
          </ul>
        {/if}
      {/if}
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
      <span>Levels, drops, modifiers and sections are set separately for each. The rest is shared.</span>
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
  .error {
    margin: 0.75rem 0 0;
    padding: 0.5rem 0.7rem;
    border: 1px solid var(--error);
    border-radius: 0.5rem;
    color: var(--error);
    font-size: 0.9rem;
  }
</style>
