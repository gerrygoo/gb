<script lang="ts">
  import { onMount } from 'svelte';
  import DropZone from './components/DropZone.svelte';
  import { demux } from './lib/demux';
  import { buildKeyframeIndex, createFrameDecoder } from './lib/decode';
  import { initGPU, setGPUContext, runTestShader } from './lib/gpu';
  import { frameToTexture, resize, textureToImageData } from './lib/resize';
  import { computeHistogram } from './lib/histogram';
  import { medianCut } from './lib/palette';
  import { quantize, indicesToImageData } from './lib/quantize';

  const RESIZE_PRESETS = [480, 320, 160];

  let fileName = '';
  let status = '';
  let canvas: HTMLCanvasElement;
  let gpuCanvas: HTMLCanvasElement;
  let browserCanvas: HTMLCanvasElement;
  let gpuStatus = 'initializing…';
  let resizeStatus = '';
  let targetHeight = RESIZE_PRESETS[0];

  let sourceBitmap: ImageBitmap | null = null;
  let sourceTexture: GPUTexture | null = null;
  let sourceWidth = 0;
  let sourceHeight = 0;

  let resizedTexture: GPUTexture | null = null;
  let paletteCanvas: HTMLCanvasElement;
  let palette: Uint8Array | null = null;
  let paletteStatus = '';

  let quantizedCanvas: HTMLCanvasElement;
  let sourceAbCanvas: HTMLCanvasElement;
  let quantizeStatus = '';

  // Called synchronously during component init so setContext is legal;
  // descendants await this promise to get the resolved device.
  const gpuContext = initGPU();
  setGPUContext(gpuContext);

  onMount(async () => {
    try {
      const { adapter, device } = await gpuContext;
      const count = 256;
      const result = await runTestShader(device, count);

      const expected = Uint32Array.from({ length: count }, (_, i) => i);
      const matches = result.every((v, i) => v === expected[i]);

      const info = adapter.info;
      const adapterLabel = info?.description || info?.vendor || 'unknown adapter';
      gpuStatus = matches
        ? `WebGPU ready (${adapterLabel}) — test shader readback verified (${count}/${count} values)`
        : 'WebGPU ready but test shader readback did not match expected values';
    } catch (err) {
      gpuStatus = `WebGPU unavailable: ${(err as Error).message}`;
    }
  });

  function drawFrame(bitmap: ImageBitmap) {
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx?.drawImage(bitmap, 0, 0);
  }

  function drawPalette(pal: Uint8Array) {
    const swatchSize = 16;
    const cols = 16;
    const rows = 16;
    paletteCanvas.width = cols * swatchSize;
    paletteCanvas.height = rows * swatchSize;
    const ctx = paletteCanvas.getContext('2d');
    if (!ctx) return;
    for (let i = 0; i < 256; i++) {
      const x = (i % cols) * swatchSize;
      const y = Math.floor(i / cols) * swatchSize;
      ctx.fillStyle = `rgb(${pal[i * 3]}, ${pal[i * 3 + 1]}, ${pal[i * 3 + 2]})`;
      ctx.fillRect(x, y, swatchSize, swatchSize);
    }
  }

  async function runResize(height: number) {
    if (!sourceBitmap || !sourceTexture) return;

    const width = Math.round((height * sourceWidth) / sourceHeight / 2) * 2;
    resizeStatus = `resizing to ${width}×${height}…`;
    paletteStatus = 'computing palette…';

    try {
      const { device } = await gpuContext;
      const { texture } = resize(device, sourceTexture, sourceWidth, sourceHeight, width, height);

      // Keep the resized texture alive for the histogram pass below; only
      // destroy the previous one now that a new one exists.
      resizedTexture?.destroy();
      resizedTexture = texture;

      const imageData = await textureToImageData(device, texture, width, height);

      gpuCanvas.width = width;
      gpuCanvas.height = height;
      gpuCanvas.getContext('2d')?.putImageData(imageData, 0, 0);

      sourceAbCanvas.width = width;
      sourceAbCanvas.height = height;
      sourceAbCanvas.getContext('2d')?.putImageData(imageData, 0, 0);

      browserCanvas.width = width;
      browserCanvas.height = height;
      browserCanvas.getContext('2d')?.drawImage(sourceBitmap, 0, 0, width, height);

      resizeStatus = `${width}×${height} — GPU Lanczos-3 vs. browser drawImage`;

      const histogramCounts = await computeHistogram(device, texture, width, height);
      palette = medianCut(histogramCounts);
      drawPalette(palette);
      const populatedBins = histogramCounts.filter((count) => count > 0).length;
      paletteStatus = `256-color palette · median-cut over ${populatedBins} populated histogram bins`;

      quantizeStatus = 'quantizing + dithering…';
      const indices = await quantize(device, texture, width, height, palette);
      const quantizedImageData = indicesToImageData(indices, palette, width, height);
      quantizedCanvas.width = width;
      quantizedCanvas.height = height;
      quantizedCanvas.getContext('2d')?.putImageData(quantizedImageData, 0, 0);
      quantizeStatus = `${width}×${height} · 256 colors · blue-noise dither`;
    } catch (err) {
      resizeStatus = `resize error: ${(err as Error).message}`;
      paletteStatus = '';
      quantizeStatus = '';
    }
  }

  async function handleFile(e: CustomEvent<File>) {
    const file = e.detail;
    fileName = file.name;
    status = 'demuxing…';
    resizeStatus = '';

    sourceTexture?.destroy();
    sourceTexture = null;
    resizedTexture?.destroy();
    resizedTexture = null;
    sourceBitmap?.close();
    sourceBitmap = null;
    palette = null;
    paletteStatus = '';
    quantizeStatus = '';

    try {
      const { track, chunks } = await demux(file);
      if (chunks.length === 0) {
        status = 'no frames found';
        return;
      }

      const keyframes = buildKeyframeIndex(chunks);
      status = 'decoding…';

      const frame = await new Promise<VideoFrame>((resolve, reject) => {
        const decoder = createFrameDecoder(
          {
            codec: track.codec,
            codedWidth: track.codedWidth,
            codedHeight: track.codedHeight,
            description: track.description,
          },
          (frame) => {
            decoder.close();
            resolve(frame);
          },
          reject,
        );
        decoder.decode(chunks[0]);
        // Hardware decoders may buffer output indefinitely without a flush
        // call — decode() alone doesn't guarantee the frame arrives promptly.
        // Closing the decoder in onFrame above can abort this flush with an
        // AbortError after the frame has already resolved; that's expected.
        decoder.flush().catch(() => {});
      });

      sourceBitmap = await createImageBitmap(frame);
      frame.close();

      drawFrame(sourceBitmap);
      status = `${track.codedWidth}×${track.codedHeight} · ${track.codec} · ${chunks.length} frames (${keyframes.chunkIndices.length} keyframes)`;

      const { device } = await gpuContext;
      sourceWidth = sourceBitmap.width;
      sourceHeight = sourceBitmap.height;
      sourceTexture = frameToTexture(device, sourceBitmap);
      await runResize(targetHeight);
    } catch (err) {
      status = `error: ${(err as Error).message}`;
    }
  }
</script>

<main>
  <h1>gif builder</h1>
  <p class="gpu-status">{gpuStatus}</p>
  <DropZone on:file={handleFile} />
  {#if fileName}
    <p class="file-name">{fileName}</p>
  {/if}
  {#if status}
    <p class="status">{status}</p>
  {/if}
  <canvas bind:this={canvas} class:hidden={!fileName}></canvas>

  {#if sourceBitmap}
    <div class="resize-controls">
      {#each RESIZE_PRESETS as preset}
        <button
          class:active={targetHeight === preset}
          on:click={() => {
            targetHeight = preset;
            runResize(preset);
          }}
        >
          {preset}p
        </button>
      {/each}
    </div>
    {#if resizeStatus}
      <p class="status">{resizeStatus}</p>
    {/if}
    <div class="comparison">
      <div class="comparison-pane">
        <p class="pane-label">GPU · Lanczos-3</p>
        <canvas bind:this={gpuCanvas}></canvas>
      </div>
      <div class="comparison-pane">
        <p class="pane-label">Canvas 2D · drawImage</p>
        <canvas bind:this={browserCanvas}></canvas>
      </div>
      <div class="comparison-pane">
        <p class="pane-label">Palette · median-cut (256 colors)</p>
        {#if paletteStatus}
          <p class="status">{paletteStatus}</p>
        {/if}
        <canvas bind:this={paletteCanvas} class="palette-canvas"></canvas>
      </div>
    </div>

    <h2 class="ab-heading">Source vs. quantized (256 colors, blue-noise dither)</h2>
    {#if quantizeStatus}
      <p class="status">{quantizeStatus}</p>
    {/if}
    <div class="comparison">
      <div class="comparison-pane">
        <p class="pane-label">Source · Lanczos-3 resize</p>
        <canvas bind:this={sourceAbCanvas}></canvas>
      </div>
      <div class="comparison-pane">
        <p class="pane-label">Quantized · 256 colors + blue-noise dither</p>
        <canvas bind:this={quantizedCanvas}></canvas>
      </div>
    </div>
  {/if}
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 24px;
  }

  h1 {
    font-size: 1.5rem;
    font-weight: 600;
    letter-spacing: -0.5px;
    color: #e0e0e0;
  }

  .file-name {
    font-size: 0.9rem;
    color: #888;
  }

  .status {
    font-size: 0.85rem;
    color: #666;
  }

  .gpu-status {
    font-size: 0.75rem;
    color: #666;
    text-align: center;
    max-width: 480px;
  }

  canvas {
    max-width: 90vw;
    border: 1px solid #333;
    border-radius: 4px;
  }

  canvas.hidden {
    display: none;
  }

  .resize-controls {
    display: flex;
    gap: 8px;
  }

  .resize-controls button {
    padding: 4px 12px;
    border: 1px solid #444;
    border-radius: 4px;
    background: #1a1a1a;
    color: #ccc;
    cursor: pointer;
    font-size: 0.85rem;
  }

  .resize-controls button.active {
    border-color: #888;
    color: #fff;
  }

  .ab-heading {
    font-size: 1rem;
    font-weight: 600;
    color: #ccc;
    margin: 8px 0 0;
  }

  .comparison {
    display: flex;
    gap: 24px;
    flex-wrap: wrap;
    justify-content: center;
  }

  .comparison-pane {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }

  .pane-label {
    font-size: 0.75rem;
    color: #888;
    margin: 0;
  }

  .comparison-pane canvas {
    max-width: 45vw;
    border: 1px solid #333;
    border-radius: 4px;
  }

  .palette-canvas {
    width: 256px;
    height: 256px;
    max-width: 45vw;
    image-rendering: pixelated;
  }
</style>
