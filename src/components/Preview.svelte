<script lang="ts">
  export let width = 0;
  export let height = 0;
  export let sourceImageData: ImageData | null = null;
  export let quantizedImageData: ImageData | null = null;

  let mode: 'source' | 'quantized' | 'split' = 'split';
  let splitPercent = 50;
  let dragging = false;
  let wrapper: HTMLDivElement;
  let sourceCanvas: HTMLCanvasElement;
  let quantizedCanvas: HTMLCanvasElement;

  $: if (sourceCanvas && sourceImageData) {
    sourceCanvas.width = width;
    sourceCanvas.height = height;
    sourceCanvas.getContext('2d')?.putImageData(sourceImageData, 0, 0);
  }

  $: if (quantizedCanvas && quantizedImageData) {
    quantizedCanvas.width = width;
    quantizedCanvas.height = height;
    quantizedCanvas.getContext('2d')?.putImageData(quantizedImageData, 0, 0);
  }

  $: clipPath =
    mode === 'source'
      ? 'inset(0 100% 0 0)'
      : mode === 'quantized'
        ? 'inset(0 0 0 0)'
        : `inset(0 ${100 - splitPercent}% 0 0)`;

  function updateSplit(clientX: number) {
    if (!wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    const pct = ((clientX - rect.left) / rect.width) * 100;
    splitPercent = Math.min(100, Math.max(0, pct));
  }

  function onPointerDown(e: PointerEvent) {
    if (mode !== 'split') return;
    dragging = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    updateSplit(e.clientX);
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging) return;
    updateSplit(e.clientX);
  }

  function onPointerUp() {
    dragging = false;
  }
</script>

<div class="preview">
  <div class="mode-toggle">
    <button class:active={mode === 'source'} on:click={() => (mode = 'source')}>Source</button>
    <button class:active={mode === 'split'} on:click={() => (mode = 'split')}>Split</button>
    <button class:active={mode === 'quantized'} on:click={() => (mode = 'quantized')}>Quantized</button>
  </div>
  {#if width && height}
    <div
      class="canvas-wrapper"
      class:draggable={mode === 'split'}
      bind:this={wrapper}
      style="aspect-ratio: {width} / {height};"
      on:pointerdown={onPointerDown}
      on:pointermove={onPointerMove}
      on:pointerup={onPointerUp}
      on:pointercancel={onPointerUp}
    >
      <canvas bind:this={sourceCanvas} class="layer base"></canvas>
      <canvas bind:this={quantizedCanvas} class="layer overlay" style="clip-path: {clipPath};"></canvas>
      {#if mode === 'split'}
        <div class="divider" style="left: {splitPercent}%"></div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .preview {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    width: 100%;
  }

  .mode-toggle {
    display: flex;
    gap: 8px;
  }

  .mode-toggle button {
    padding: 4px 12px;
    border: 1px solid #444;
    border-radius: 4px;
    background: #1a1a1a;
    color: #ccc;
    cursor: pointer;
    font-size: 0.85rem;
  }

  .mode-toggle button.active {
    border-color: #888;
    color: #fff;
  }

  .canvas-wrapper {
    position: relative;
    width: 100%;
    max-width: 640px;
    border: 1px solid #333;
    border-radius: 4px;
    overflow: hidden;
    touch-action: none;
  }

  .canvas-wrapper.draggable {
    cursor: ew-resize;
  }

  .layer {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
  }

  .divider {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    margin-left: -1px;
    background: #fff;
    box-shadow: 0 0 4px rgba(0, 0, 0, 0.6);
    pointer-events: none;
  }
</style>
