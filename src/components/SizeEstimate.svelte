<script lang="ts">
  import type { SizeEstimateResult } from '../lib/estimate';
  import { formatBytes } from '../lib/format';

  export let estimate: SizeEstimateResult | null = null;
  export let estimating = false;

  const LONG_CLIP_FRAME_THRESHOLD = 500;
  $: longClip = (estimate?.frameCount ?? 0) > LONG_CLIP_FRAME_THRESHOLD;
</script>

<div class="size-estimate">
  {#if estimate}
    <span class="size">~{formatBytes(estimate.estimatedBytes)}</span>
    <span class="detail">
      {estimate.frameCount} frames · {estimate.outputWidth}×{estimate.outputHeight} · {estimate.outputDurationSec.toFixed(2)}s
    </span>
  {/if}
  {#if estimating}
    <span class="updating">estimating…</span>
  {/if}
  {#if longClip}
    <p class="warning">Long clip ({estimate?.frameCount} frames) — encoding may take a while and produce a large file.</p>
  {/if}
</div>

<style>
  .size-estimate {
    display: flex;
    align-items: baseline;
    gap: 10px;
    flex-wrap: wrap;
    font-size: 0.85rem;
  }

  .size {
    font-weight: 600;
    color: #ccc;
  }

  .detail {
    color: #888;
    font-size: 0.8rem;
  }

  .updating {
    color: #e0b84a;
    font-size: 0.75rem;
  }

  .warning {
    width: 100%;
    margin: 2px 0 0;
    font-size: 0.8rem;
    color: #e0b84a;
  }
</style>
