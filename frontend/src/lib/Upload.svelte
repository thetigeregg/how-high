<script lang="ts">
  let { busy, onfile }: { busy: boolean; onfile: (file: File) => void } = $props();

  let input = $state<HTMLInputElement | null>(null);
  let dragging = $state(false);

  function pick(files: FileList | null | undefined) {
    const file = files?.[0];
    if (file) onfile(file);
    if (input) input.value = "";
  }
</script>

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
</style>
