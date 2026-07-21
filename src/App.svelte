<script lang="ts">
  import { onMount } from 'svelte';
  import DropZone from './components/DropZone.svelte';
  import { demux } from './lib/demux';
  import { buildKeyframeIndex, createFrameDecoder } from './lib/decode';
  import { initGPU, setGPUContext, runTestShader } from './lib/gpu';
  import { frameToTexture, resize, textureToImageData } from './lib/resize';

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

  async function runResize(height: number) {
    if (!sourceBitmap || !sourceTexture) return;

    const width = Math.round((height * sourceWidth) / sourceHeight / 2) * 2;
    resizeStatus = `resizing to ${width}×${height}…`;

    try {
      const { device } = await gpuContext;
      const { texture } = resize(device, sourceTexture, sourceWidth, sourceHeight, width, height);
      const imageData = await textureToImageData(device, texture, width, height);
      texture.destroy();

      gpuCanvas.width = width;
      gpuCanvas.height = height;
      gpuCanvas.getContext('2d')?.putImageData(imageData, 0, 0);

      browserCanvas.width = width;
      browserCanvas.height = height;
      browserCanvas.getContext('2d')?.drawImage(sourceBitmap, 0, 0, width, height);

      resizeStatus = `${width}×${height} — GPU Lanczos-3 vs. browser drawImage`;
    } catch (err) {
      resizeStatus = `resize error: ${(err as Error).message}`;
    }
  }

  async function handleFile(e: CustomEvent<File>) {
    const file = e.detail;
    fileName = file.name;
    status = 'demuxing…';
    resizeStatus = '';

    sourceTexture?.destroy();
    sourceTexture = null;
    sourceBitmap?.close();
    sourceBitmap = null;

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
</style>
