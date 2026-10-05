<script lang="ts">
  let {
    busy,
    kind,
    links,
    onfile,
    onlink,
  }: {
    busy: boolean;
    /** Which list is showing: hikes are added as GPX files, routes as links. */
    kind: "hike" | "route";
    /** Whether routes from Google Maps links are available. */
    links: boolean;
    onfile: (file: File) => void;
    onlink: (url: string) => void;
  } = $props();

  let link = $state("");

  function submitLink(event: SubmitEvent) {
    event.preventDefault();
    if (link.trim() === "" || busy) return;
    onlink(link.trim());
    link = "";
  }

  let input = $state<HTMLInputElement | null>(null);
  let dragging = $state(false);

  function pick(files: FileList | null | undefined) {
    const file = files?.[0];
    if (file) onfile(file);
    if (input) input.value = "";
  }
</script>

{#if kind === "hike"}
<button
  class="drop"
  class:dragging
  type="button"
  disabled={busy}
  onclick={() => input?.click()}
  ondragover={(e) => {
    e.preventDefault();
    dragging = true;
  }}
  ondragleave={() => (dragging = false)}
  ondrop={(e) => {
    e.preventDefault();
    dragging = false;
    if (!busy) pick(e.dataTransfer?.files);
  }}
>
  {#if busy}
    Analysing… fetching terrain can take a moment
  {:else}
    <strong>Add a hike</strong>
    <span>Drop a .gpx file here or click to choose</span>
  {/if}
</button>
<input bind:this={input} type="file" accept=".gpx,application/gpx+xml" hidden onchange={() => pick(input?.files)} />
{:else if links}
  <form onsubmit={submitLink}>
    <label for="route-link"><strong>Add a route</strong> by car, bus or train</label>
    <div class="row">
      <input id="route-link" type="url" placeholder="Paste a Google Maps directions link" bind:value={link} disabled={busy} />
      <button type="submit" disabled={busy || link.trim() === ""}>Add</button>
    </div>
    {#if busy}<span class="wait">Fetching and analysing… a long route can take a few minutes the first time</span>{/if}
  </form>
{:else}
  <p class="wait">Adding routes needs a Google Maps API key; see the README.</p>
{/if}

<style>
  .drop {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    width: 100%;
    padding: 0.9rem;
    border: 1px dashed var(--border);
    border-radius: 0.6rem;
    background: var(--bg-elevated);
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .drop span {
    color: var(--text-muted);
    font-size: 0.85rem;
  }
  .drop:hover:not(:disabled),
  .drop.dragging {
    border-color: var(--accent);
  }
  .drop:disabled {
    cursor: progress;
    color: var(--text-muted);
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    font-size: 0.9rem;
  }
  form label {
    color: var(--text-muted);
  }
  form strong {
    color: var(--text);
  }
  .row {
    display: flex;
    gap: 0.4rem;
  }
  .wait {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.85rem;
  }
  .row input {
    flex: 1;
    min-width: 0;
    padding: 0.4rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: 0.4rem;
    background: var(--bg-elevated);
    color: var(--text);
    font: inherit;
    font-size: 0.85rem;
  }
  .row button {
    padding: 0.4rem 0.8rem;
    border: 1px solid var(--border);
    border-radius: 0.4rem;
    background: var(--bg-elevated);
    color: var(--text);
    font: inherit;
    cursor: pointer;
  }
  .row button:disabled {
    color: var(--text-faint);
    cursor: default;
  }
</style>
