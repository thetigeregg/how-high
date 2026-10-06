<script lang="ts">
  // The name of another hike or route, mentioned in running text. Set apart
  // from the words around it so it reads as a name, and clickable to go there.
  let { name, onclick }: { name: string; onclick: () => void } = $props();
</script>

<button
  type="button"
  title="Open {name || 'this entry'} at that stretch"
  onclick={(e) => {
    e.stopPropagation();
    onclick();
  }}>{name || "Untitled"}</button
>

<style>
  button {
    display: inline;
    padding: 0.05rem 0.4rem;
    border: 1px solid var(--border);
    border-radius: 0.35rem;
    background: var(--bg-elevated);
    color: var(--text);
    font: inherit;
    font-weight: 600;
    line-height: inherit;
    text-align: left;
    cursor: pointer;
    /* A long name wraps like text, keeping its outline on each line. */
    box-decoration-break: clone;
    -webkit-box-decoration-break: clone;
  }
  button:hover,
  button:focus-visible {
    border-color: var(--accent);
    color: var(--accent);
  }
</style>
