<script lang="ts">
  import type { Level } from "../types.js";
  import { LEVEL_COLOR, LEVEL_LABEL } from "./levels.js";

  let { level }: { level: Level } = $props();
</script>

<span class="badge"><span class="dot" style:background={LEVEL_COLOR[level]}></span>{LEVEL_LABEL[level]}</span>

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    white-space: nowrap;
  }
  .dot {
    width: 0.65rem;
    height: 0.65rem;
    border-radius: 999px;
    flex-shrink: 0;
  }
</style>
