<script lang="ts">
  import type { RouteOffer } from "../types.js";
  import { km } from "./levels.js";

  let {
    offer,
    busy,
    onpick,
    oncancel,
  }: {
    offer: RouteOffer;
    busy: boolean;
    /** Called with the place in the list of the route to add. */
    onpick: (option: number) => void;
    oncancel: () => void;
  } = $props();

  function duration(seconds: number): string {
    const minutes = Math.round(seconds / 60);
    return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  }
</script>

<section>
  <p>
    <strong>Google offers {offer.options.length} routes</strong>{offer.name ? ` for ${offer.name}` : ""}. Pick the one to
    add.
    {#if offer.planned}<span>{offer.planned}.</span>{/if}
  </p>
  <ol>
    {#each offer.options as option, i}
      <li>
        <button type="button" disabled={busy} onclick={() => onpick(i)}>
          <strong>{option.label}</strong>
          <span>
            {[
              option.distanceM === null ? null : km(option.distanceM, 0),
              option.durationS === null ? null : duration(option.durationS),
              i === 0 ? "Google's first choice" : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </button>
      </li>
    {/each}
  </ol>
  <button type="button" class="cancel" disabled={busy} onclick={oncancel}>Cancel</button>
</section>

<style>
  section {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    font-size: 0.9rem;
  }
  p {
    margin: 0;
    color: var(--text-muted);
  }
  p strong {
    color: var(--text);
  }
  ol {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li button {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    width: 100%;
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: 0.4rem;
    background: var(--bg-elevated);
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  li button span {
    color: var(--text-muted);
    font-size: 0.85rem;
  }
  li button:hover:not(:disabled) {
    border-color: var(--accent);
  }
  li button:disabled {
    cursor: progress;
  }
  .cancel {
    align-self: flex-start;
    padding: 0;
    border: none;
    background: none;
    color: var(--text-muted);
    font: inherit;
    font-size: 0.85rem;
    text-decoration: underline;
    cursor: pointer;
  }
</style>
