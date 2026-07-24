<script lang="ts">
  import { onDestroy } from 'svelte';
  import PipelineShell from './components/PipelineShell.svelte';
  import type { DemuxResult } from './lib/demux';
  import type { FrameSeeker } from './lib/seek';
  import type { GPUContext } from './lib/gpu';

  // Bound from PipelineShell — see GifApp.svelte / PipelineShell.svelte for
  // why plain export + bind: is used instead of slot props. Most of these
  // aren't read yet (encode lands in Phase 16) but are bound now so this
  // stub matches the shell's full consumer contract from the start.
  let seeker: FrameSeeker | null = null;
  let currentDemux: DemuxResult | null = null;
  let playhead = 0;
  let inPoint = 0;
  let outPoint = 0;
  let frameDurationUs = 33_000;
  let sourceWidth = 0;
  let sourceHeight = 0;
  let sourceBitmap: ImageBitmap | null = null;
  let gpuContext: Promise<GPUContext>;

  let previewCanvas: HTMLCanvasElement;
  let resizedTexture: GPUTexture | null = null;

  onDestroy(() => {
    resizedTexture?.destroy();
  });

  /** Stub back half of what GifApp's handleResized does: no
   * histogram/palette/quantize step, just draw the resized source frame —
   * this is the hand-off point Phase 16's per-frame VideoEncoder feed plugs
   * into instead. Still takes ownership of frame.texture (destroy the
   * previous one) per the shell's single-flight contract, even though
   * nothing reads the texture yet. */
  async function handleResized(frame: { texture: GPUTexture; imageData: ImageData; width: number; height: number }) {
    const { texture, imageData, width, height } = frame;
    resizedTexture?.destroy();
    resizedTexture = texture;

    if (previewCanvas) {
      previewCanvas.width = width;
      previewCanvas.height = height;
      previewCanvas.getContext('2d')?.putImageData(imageData, 0, 0);
    }
  }

  function handleFileChange() {
    resizedTexture?.destroy();
    resizedTexture = null;
  }
</script>

<PipelineShell
  title="webm exporter"
  crossLink={{ href: '/', label: '← gif builder' }}
  bind:seeker
  bind:currentDemux
  bind:playhead
  bind:inPoint
  bind:outPoint
  bind:frameDurationUs
  bind:sourceWidth
  bind:sourceHeight
  bind:sourceBitmap
  bind:gpuContext
  onResized={handleResized}
  onFileChange={handleFileChange}
>
  <svelte:fragment slot="main">
    <canvas bind:this={previewCanvas} class="preview-canvas"></canvas>
  </svelte:fragment>

  <svelte:fragment slot="side">
    <div class="stub-panel">
      <p class="stub-title">WebM export — coming soon</p>
      <p class="stub-body">
        This scaffold proves the shared pipeline shell works for a second
        consumer. Bitrate/keyframe controls and a real VP9 export (Phase
        16/17) land next.
      </p>
    </div>
  </svelte:fragment>
</PipelineShell>

<style>
  .preview-canvas {
    max-width: 100%;
    border: 1px solid #333;
    border-radius: 4px;
  }

  .stub-panel {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 14px 16px;
    border: 1px solid #333;
    border-radius: 6px;
  }

  .stub-title {
    font-size: 0.9rem;
    font-weight: 600;
    color: #ccc;
    margin: 0;
  }

  .stub-body {
    font-size: 0.8rem;
    color: #888;
    margin: 0;
  }
</style>
