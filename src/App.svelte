<script lang="ts">
  import { onMount } from 'svelte';
  import DropZone from './components/DropZone.svelte';
  import Timeline from './components/Timeline.svelte';
  import { demux, type DemuxResult } from './lib/demux';
  import { decodeAllFrames, nearestKeyframeAtOrBefore } from './lib/decode';
  import { createFrameSeeker, type FrameSeeker } from './lib/seek';
  import { initGPU, setGPUContext, runTestShader } from './lib/gpu';
  import { frameToTexture, resize, textureToImageData } from './lib/resize';
  import { computeHistogram } from './lib/histogram';
  import { medianCut } from './lib/palette';
  import { quantize, indicesToImageData } from './lib/quantize';
  import { encodeGif, type GifFrame } from './lib/gif';
  import { statusText, withBusy } from './lib/status';

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
  let quantizedIndices: Uint32Array | null = null;

  let currentDemux: DemuxResult | null = null;
  let exportStatus = '';
  let animExportStatus = '';
  let animExporting = false;

  let seeker: FrameSeeker | null = null;
  let playhead = 0;
  let inPoint = 0;
  let outPoint = 0;
  let frameDurationUs = 33_000;

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
    const bitmap = sourceBitmap;
    const srcTexture = sourceTexture;

    const width = Math.round((height * sourceWidth) / sourceHeight / 2) * 2;
    resizeStatus = `resizing to ${width}×${height}…`;
    paletteStatus = 'computing palette…';

    await withBusy(`processing preview (${width}×${height})…`, async () => {
      try {
        const { device } = await gpuContext;
        const { texture } = resize(device, srcTexture, sourceWidth, sourceHeight, width, height);

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
        browserCanvas.getContext('2d')?.drawImage(bitmap, 0, 0, width, height);

        resizeStatus = `${width}×${height} — GPU Lanczos-3 vs. browser drawImage`;

        const histogramCounts = await computeHistogram(device, texture, width, height);
        palette = medianCut(histogramCounts);
        drawPalette(palette);
        const populatedBins = histogramCounts.filter((count) => count > 0).length;
        paletteStatus = `256-color palette · median-cut over ${populatedBins} populated histogram bins`;

        quantizeStatus = 'quantizing + dithering…';
        const indices = await quantize(device, texture, width, height, palette);
        quantizedIndices = indices;
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
    });
  }

  function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportSingleFrameGif() {
    if (!quantizedIndices || !palette) return;
    const width = quantizedCanvas.width;
    const height = quantizedCanvas.height;
    const indices = Uint8Array.from(quantizedIndices);
    const gifBytes = encodeGif(width, height, [{ indices, palette, delayCs: 10 }], 0);
    downloadBlob(new Blob([new Uint8Array(gifBytes)], { type: 'image/gif' }), 'frame.gif');
    exportStatus = `exported ${width}×${height} single-frame GIF (frame ${playhead + 1}) — ${gifBytes.length.toLocaleString()} bytes`;
  }

  async function exportAnimatedGif() {
    if (!currentDemux || !seeker || animExporting) return;
    animExporting = true;
    exportStatus = '';
    const { track, chunks } = currentDemux;
    const from = inPoint;
    const to = outPoint;
    // Decoding must start at a keyframe, which may fall before `from` — decode
    // the full run, then drop the lead-in frames that exist only to prime the
    // decoder state, so the export starts exactly at the in point.
    const rangeStart = nearestKeyframeAtOrBefore(seeker.keyframes, from);
    const rangeChunks = chunks.slice(rangeStart, to + 1);
    const leadInCount = from - rangeStart;

    try {
      animExportStatus = `decoding ${rangeChunks.length} frames (in/out ${from + 1}–${to + 1})…`;
      const { device } = await gpuContext;
      const decodedFrames = await decodeAllFrames(
        { codec: track.codec, codedWidth: track.codedWidth, codedHeight: track.codedHeight, description: track.description },
        rangeChunks,
      );

      const leadInFrames = decodedFrames.slice(0, leadInCount);
      for (const frame of leadInFrames) frame.close();
      const framesInRange = decodedFrames.slice(leadInCount);

      const gifFrames: GifFrame[] = [];
      let width = 0;
      let height = 0;

      for (let i = 0; i < framesInRange.length; i++) {
        animExportStatus = `processing frame ${i + 1}/${framesInRange.length}…`;
        const frame = framesInRange[i];
        const durationUs = frame.duration ?? 100_000;
        const bitmap = await createImageBitmap(frame);
        frame.close();

        const srcWidth = bitmap.width;
        const srcHeight = bitmap.height;
        height = targetHeight;
        width = Math.round((height * srcWidth) / srcHeight / 2) * 2;

        const srcTexture = frameToTexture(device, bitmap);
        bitmap.close();
        const { texture: resizedTexture } = resize(device, srcTexture, srcWidth, srcHeight, width, height);
        srcTexture.destroy();

        const histogramCounts = await computeHistogram(device, resizedTexture, width, height);
        const framePalette = medianCut(histogramCounts);
        const indices32 = await quantize(device, resizedTexture, width, height, framePalette);
        resizedTexture.destroy();

        const delayCs = Math.max(1, Math.round(durationUs / 10_000));
        gifFrames.push({ indices: Uint8Array.from(indices32), palette: framePalette, delayCs });
      }

      animExportStatus = 'encoding GIF…';
      const gifBytes = encodeGif(width, height, gifFrames, 0);
      downloadBlob(new Blob([new Uint8Array(gifBytes)], { type: 'image/gif' }), 'animation.gif');
      animExportStatus = `exported ${gifFrames.length} frames, ${width}×${height} — ${gifBytes.length.toLocaleString()} bytes`;
    } catch (err) {
      animExportStatus = `export error: ${(err as Error).message}`;
    } finally {
      animExporting = false;
    }
  }

  /** Decodes + renders `target`, updating the preview canvas + pipeline.
   * `sourceBitmap` is cache-owned by `seeker` — never close it directly; the
   * seeker's LRU eviction handles that. */
  async function seekToFrame(target: number) {
    if (!seeker) return;
    try {
      const bitmap = await seeker.seekTo(target);
      sourceBitmap = bitmap;
      drawFrame(bitmap);
      sourceWidth = bitmap.width;
      sourceHeight = bitmap.height;
      const { device } = await gpuContext;
      sourceTexture?.destroy();
      sourceTexture = frameToTexture(device, bitmap);
      await runResize(targetHeight);
    } catch (err) {
      status = `seek error: ${(err as Error).message}`;
    }
  }

  // `playhead` updates immediately/synchronously on every request so the UI
  // (and Timeline's own keyboard-nav math, which reads `playhead` back as a
  // prop) always sees the latest value. The GPU pipeline, however, must
  // never have two seeks in flight at once — an overlapping seek's
  // `sourceTexture?.destroy()` can otherwise fire while an earlier seek's
  // runResize() is still submitting GPU work against that same texture.
  // Rather than queueing every intermediate frame (which would lag behind
  // during fast scrubbing), only the most recent target survives: once the
  // in-flight seek finishes, the loop jumps straight to whatever is latest.
  let pendingTarget: number | null = null;
  let seekRunning = false;
  let seekLoopPromise: Promise<void> = Promise.resolve();

  async function runSeekLoop() {
    seekRunning = true;
    try {
      while (pendingTarget !== null) {
        const target = pendingTarget;
        pendingTarget = null;
        await seekToFrame(target);
      }
    } finally {
      seekRunning = false;
    }
  }

  function queueSeek(index: number): Promise<void> {
    if (!seeker) return Promise.resolve();
    playhead = Math.min(Math.max(index, 0), seeker.frameCount - 1);
    pendingTarget = playhead;
    if (!seekRunning) {
      seekLoopPromise = runSeekLoop();
    }
    return seekLoopPromise;
  }

  function handleSetIn(e: CustomEvent<number>) {
    inPoint = Math.min(e.detail, outPoint);
  }

  function handleSetOut(e: CustomEvent<number>) {
    outPoint = Math.max(e.detail, inPoint);
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
    seeker?.destroy();
    seeker = null;
    sourceBitmap = null;
    palette = null;
    paletteStatus = '';
    quantizeStatus = '';
    quantizedIndices = null;
    currentDemux = null;
    exportStatus = '';
    animExportStatus = '';
    playhead = 0;
    inPoint = 0;
    outPoint = 0;

    try {
      const demuxResult = await withBusy('demuxing…', () => demux(file));
      const { track, chunks } = demuxResult;
      if (chunks.length === 0) {
        status = 'no frames found';
        return;
      }
      currentDemux = demuxResult;

      const config: VideoDecoderConfig = {
        codec: track.codec,
        codedWidth: track.codedWidth,
        codedHeight: track.codedHeight,
        description: track.description,
      };
      seeker = createFrameSeeker(config, chunks);
      outPoint = chunks.length - 1;
      frameDurationUs = chunks.reduce((sum, c) => sum + (c.duration ?? 33_000), 0) / chunks.length;

      status = `${track.codedWidth}×${track.codedHeight} · ${track.codec} · ${chunks.length} frames (${seeker.keyframes.chunkIndices.length} keyframes)`;

      await queueSeek(0);
    } catch (err) {
      status = `error: ${(err as Error).message}`;
    }
  }
</script>

<main>
  <h1>gif builder</h1>
  <p class="gpu-status">{gpuStatus}</p>
  <p class="busy-status" class:idle={$statusText === 'Idle'}>{$statusText}</p>
  <DropZone on:file={handleFile} />
  {#if fileName}
    <p class="file-name">{fileName}</p>
  {/if}
  {#if status}
    <p class="status">{status}</p>
  {/if}
  <canvas bind:this={canvas} class:hidden={!fileName}></canvas>

  {#if seeker}
    <Timeline
      frameCount={seeker.frameCount}
      {playhead}
      {inPoint}
      {outPoint}
      getCachedThumbnail={seeker.getCachedThumbnail}
      loadThumbnails={seeker.loadThumbnails}
      {frameDurationUs}
      on:seek={(e) => queueSeek(e.detail)}
      on:setIn={handleSetIn}
      on:setOut={handleSetOut}
    />
  {/if}

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

    <h2 class="ab-heading">Export</h2>
    <div class="export-row">
      <button on:click={exportSingleFrameGif} disabled={!quantizedIndices}>Export current frame as GIF</button>
      <button on:click={exportAnimatedGif} disabled={animExporting || !currentDemux}>
        {animExporting ? 'Exporting…' : `Export animated GIF (frames ${inPoint + 1}–${outPoint + 1})`}
      </button>
    </div>
    {#if exportStatus}
      <p class="status">{exportStatus}</p>
    {/if}
    {#if animExportStatus}
      <p class="status">{animExportStatus}</p>
    {/if}
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

  .busy-status {
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: #e0b84a;
    border: 1px solid #443c22;
    background: rgba(224, 184, 74, 0.08);
    border-radius: 999px;
    padding: 2px 12px;
    margin: -12px 0 0;
  }

  .busy-status.idle {
    color: #555;
    border-color: #2a2a2a;
    background: transparent;
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

  .export-row {
    display: flex;
    gap: 8px;
  }

  .export-row button {
    padding: 6px 14px;
    border: 1px solid #444;
    border-radius: 4px;
    background: #1a1a1a;
    color: #ccc;
    cursor: pointer;
    font-size: 0.85rem;
  }

  .export-row button:disabled {
    opacity: 0.4;
    cursor: default;
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
