<script lang="ts">
  import { applyImport, EXPORT_URL, previewImport } from "../api.js";
  import type { ImportMode, ImportPreview, ImportSummary } from "../types.js";

  /** Called after an import has changed the library and possibly the settings. */
  let { onimported }: { onimported: () => void } = $props();

  let input = $state<HTMLInputElement | null>(null);
  let dialog = $state<HTMLDialogElement | null>(null);
  // The file chosen and what the server says it would do; nothing is changed while this is shown.
  let file = $state<File | null>(null);
  let preview = $state<ImportPreview | null>(null);
  let mode = $state<ImportMode>("merge");
  let withSettings = $state(true);
  let working = $state<"reading" | "importing" | null>(null);
  let error = $state<string | null>(null);
  let done = $state<ImportSummary | null>(null);

  const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const date = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

  async function choose() {
    const chosen = input?.files?.[0];
    if (input) input.value = "";
    if (!chosen) return;
    error = null;
    done = null;
    working = "reading";
    try {
      preview = await previewImport(chosen);
      file = chosen;
      mode = "merge";
      withSettings = true;
      dialog?.showModal();
    } catch (err) {
      error = (err as Error).message;
    }
    working = null;
  }

  async function apply() {
    if (!file) return;
    working = "importing";
    try {
      done = await applyImport(file, mode, withSettings);
      dialog?.close();
      onimported();
    } catch (err) {
      error = (err as Error).message;
      dialog?.close();
    }
    working = null;
  }
</script>

<section>
  <h3>Transfer</h3>
  <p class="intro">
    Move everything to another installation of How High: your hikes and routes, marks, ratings and settings, in one
    file. Both installations should be running the same version.
  </p>
  <div class="actions">
    <a class="button" href={EXPORT_URL} download>Export everything</a>
    <button type="button" disabled={working !== null} onclick={() => input?.click()}>
      {working === "reading" ? "Reading the file…" : "Import a file…"}
    </button>
    <input bind:this={input} type="file" accept=".gz,.json,application/gzip,application/json" hidden onchange={choose} />
  </div>
  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}
  {#if done}
    <p class="intro" role="status">
      Imported: {done.added} added, {done.updated} updated, {done.removed} removed, {count(done.marks, "mark")}{done.settings
        ? ", settings taken from the file"
        : ""}. What was here before is saved on the server as {done.backup}.
    </p>
  {/if}
</section>

<dialog bind:this={dialog} onclose={() => ((file = null), (preview = null))}>
  {#if preview && file}
    <h2>Import {file.name}</h2>
    <p>
      The file was exported on {date(preview.file.exportedAt)} and holds {count(preview.file.hikes, "hike")},
      {count(preview.file.routes, "route")} and {count(preview.file.marks, "mark")}. Here there
      {preview.here.entries === 1 ? "is" : "are"} now {count(preview.here.entries, "entry", "entries")} and
      {count(preview.here.marks, "mark")}.
    </p>

    <fieldset>
      <legend>How to import</legend>
      <label>
        <input type="radio" bind:group={mode} value="merge" />
        <span>
          <strong>Add and update</strong>
          {preview.merge.added} added, {preview.merge.updated} updated from the file (name, rating, marks),
          {preview.merge.kept} here left as {preview.merge.kept === 1 ? "it is" : "they are"}.
        </span>
      </label>
      <label>
        <input type="radio" bind:group={mode} value="replace" />
        <span>
          <strong>Replace everything</strong>
          All {count(preview.replace.removed, "entry", "entries")} here {preview.replace.removed === 1 ? "is" : "are"} removed
          with {preview.replace.removed === 1 ? "its" : "their"} marks, and the {preview.replace.added} from the file take their place.
        </span>
      </label>
    </fieldset>

    <label class="check">
      <input type="checkbox" bind:checked={withSettings} />
      Also take the settings from the file, replacing the ones here
    </label>

    {#if preview.file.measuredDifferently}
      <p class="note">
        The file comes from a different version of How High. Its entries will be measured again here, which downloads
        terrain and can take a few minutes for long routes.
      </p>
    {/if}
    <p class="note">What is here now is saved on the server as a backup export before anything changes.</p>

    <footer>
      <button type="button" class="primary" disabled={working !== null} onclick={apply}>
        {working === "importing" ? "Importing…" : mode === "replace" ? "Replace everything" : "Import"}
      </button>
      <button type="button" disabled={working !== null} onclick={() => dialog?.close()}>Cancel</button>
    </footer>
  {/if}
</dialog>

<style>
  h3 {
    margin: 1.25rem 0 0.25rem;
    font-size: 1rem;
  }
  .intro,
  .note,
  dialog p {
    margin: 0.25rem 0 0.6rem;
    color: var(--text-muted);
    font-size: 0.9rem;
  }
  .actions,
  footer {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  footer {
    margin-top: 1rem;
  }
  button,
  .button {
    padding: 0.35rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--bg-elevated);
    color: var(--text);
    font: inherit;
    font-size: 0.85rem;
    text-decoration: none;
    cursor: pointer;
  }
  button:hover:not(:disabled),
  .button:hover {
    border-color: var(--accent);
  }
  button:disabled {
    color: var(--text-muted);
    cursor: progress;
  }
  button.primary {
    border-color: var(--accent);
    background: var(--accent);
    color: #ffffff;
  }
  dialog {
    width: min(36rem, calc(100vw - 2rem));
    padding: 1.25rem;
    border: 1px solid var(--border);
    border-radius: 0.8rem;
    background: var(--bg);
    color: var(--text);
  }
  dialog::backdrop {
    background: rgba(0, 0, 0, 0.45);
  }
  h2 {
    margin: 0 0 0.5rem;
    font-size: 1.1rem;
    overflow-wrap: anywhere;
  }
  fieldset {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    margin: 0.75rem 0;
    padding: 0.75rem;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
  }
  legend {
    padding: 0 0.3rem;
    color: var(--text-muted);
    font-size: 0.85rem;
  }
  fieldset label,
  .check {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    font-size: 0.9rem;
  }
  fieldset strong {
    display: block;
  }
  fieldset span {
    color: var(--text-muted);
  }
  fieldset strong {
    color: var(--text);
  }
  .error {
    margin: 0.5rem 0 0;
    padding: 0.5rem 0.7rem;
    border: 1px solid var(--error);
    border-radius: 0.5rem;
    color: var(--error);
    font-size: 0.9rem;
  }
</style>
