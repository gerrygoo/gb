<script lang="ts">
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import DropZone from './components/DropZone.svelte';
  import Timeline from './components/Timeline.svelte';
  import QualityPanel from './components/QualityPanel.svelte';
  import Preview from './components/Preview.svelte';
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
  import { quality, resetQualityForSource } from './lib/quality';

  let fileName = '';
  let status = '';
  let canvas: HTMLCanvasElement;
  let gpuCanvas: HTMLCanvasElement;
  let browserCanvas: HTMLCanvasElement;
  let gpuStatus = 'initializing…';
  let resizeStatus = '';

  let sourceBitmap: ImageBitmap | null = null;
  let sourceTexture: GPUTexture | null = null;
  let sourceWidth = 0;
  let sourceHeight = 0;

  let resizedTexture: GPUTexture | null = null;
  let paletteCanvas: HTMLCanvasElement;
  let palette: Uint8Array | null = null;
  let paletteStatus = '';

  let quantizeStatus = '';
  let quantizedIndices: Uint32Array | null = null;
  let previewWidth = 0;
  let previewHeight = 0;
  let previewSourceImageData: ImageData | null = null;
  let previewQuantizedImageData: ImageData | null = null;

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

  /** Runs resize → histogram → palette → quantize on the current playhead frame at the
   * current quality settings. Generalizes what used to be a preset-height-only `runResize`. */
  async function runQualityPipeline() {
    if (!sourceBitmap || !sourceTexture) return;
    const bitmap = sourceBitmap;
    const srcTexture = sourceTexture;
    const { targetWidth, dither } = get(quality);

    const width = Math.max(2, Math.round(targetWidth / 2) * 2);
    const height = Math.max(2, Math.round((width * sourceHeight) / sourceWidth / 2) * 2);
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
        const indices = await quantize(device, texture, width, height, palette, dither);
        quantizedIndices = indices;
        const quantizedImageData = indicesToImageData(indices, palette, width, height);
        previewWidth = width;
        previewHeight = height;
        previewSourceImageData = imageData;
        previewQuantizedImageData = quantizedImageData;
        quantizeStatus = `${width}×${height} · 256 colors · ${dither ? 'blue-noise dither' : 'no dither'}`;
      } catch (err) {
        resizeStatus = `resize error: ${(err as Error).message}`;
        paletteStatus = '';
        quantizeStatus = '';
      }
    });
  }

  // Both a quality-store change and a playhead seek can trigger a pipeline
  // run; without serialization they can race the same way overlapping seeks
  // did in Phase 8 (a later run's `resizedTexture?.destroy()` firing while an
  // earlier run is still submitting GPU work against that texture). Mirrors
  // the seek loop's "latest wins" queue below.
  let pendingPipelineRun = false;
  let pipelineRunning = false;
  let pipelineLoopPromise: Promise<void> = Promise.resolve();

  async function runPipelineLoop() {
    pipelineRunning = true;
    try {
      while (pendingPipelineRun) {
        pendingPipelineRun = false;
        await runQualityPipeline();
      }
    } finally {
      pipelineRunning = false;
    }
  }

  function requestPipelineRun(): Promise<void> {
    pendingPipelineRun = true;
    if (!pipelineRunning) {
      pipelineLoopPromise = runPipelineLoop();
    }
    return pipelineLoopPromise;
  }

  // Debounced pipeline re-run on quality changes (Phase 9). Fires immediately
  // on subscription (Svelte store contract) — guarded by `sourceBitmap` so
  // that no-op before a file is loaded.
  let qualityDebounceHandle: ReturnType<typeof setTimeout> | null = null;
  quality.subscribe(() => {
    if (!sourceBitmap) return;
    if (qualityDebounceHandle) clearTimeout(qualityDebounceHandle);
    qualityDebounceHandle = setTimeout(() => {
      qualityDebounceHandle = null;
      requestPipelineRun();
    }, 100);
  });

  function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportSingleFrameGif() {
    if (!quantizedIndices || !palette || !previewWidth || !previewHeight) return;
    const width = previewWidth;
    const height = previewHeight;
    const { loopCount } = get(quality);
    const indices = Uint8Array.from(quantizedIndices);
    const gifBytes = encodeGif(width, height, [{ indices, palette, delayCs: 10 }], loopCount);
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

      const { targetWidth, fps: outputFps, dither, loopCount, speed } = get(quality);

      // Resample source frames to the target output FPS by nearest-neighbor
      // lookup on a synthetic timeline built from each frame's own `duration`
      // (cumulative sum in array order) — this drops or duplicates source
      // frames as needed rather than assuming output FPS == source FPS.
      //
      // Deliberately NOT using `VideoFrame.timestamp` (presentation time):
      // this codebase's "frame index" convention is chunk/decode-order
      // position (Timeline, seek.ts, and the in/out trim above all index by
      // it), not presentation order. For a range trimmed out of a B-frame
      // stream, the last chunk in the slice can have a presentation
      // timestamp far ahead of its decode-order neighbors, which would throw
      // off a timestamp-based total-duration calculation. `duration` stays
      // uniform regardless.
      let cursor = 0;
      const frameStartUs = framesInRange.map((f) => {
        const start = cursor;
        cursor += f.duration ?? frameDurationUs;
        return start;
      });
      const totalDurationUs = cursor;
      const outputIntervalUs = 1_000_000 / outputFps;
      const outputFrameCount = Math.max(1, Math.round(totalDurationUs / outputIntervalUs) || 1);

      function nearestSourceIndex(tUs: number): number {
        let lo = 0;
        let hi = frameStartUs.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (frameStartUs[mid] < tUs) lo = mid + 1;
          else hi = mid;
        }
        if (lo > 0 && Math.abs(frameStartUs[lo - 1] - tUs) <= Math.abs(frameStartUs[lo] - tUs)) {
          return lo - 1;
        }
        return lo;
      }

      const tickIndices: number[] = [];
      for (let k = 0; k < outputFrameCount; k++) {
        tickIndices.push(nearestSourceIndex(k * outputIntervalUs));
      }

      // Close decoded frames that no tick references; frames that are
      // referenced get closed lazily, exactly once, when their bitmap is made.
      const usedIndices = new Set(tickIndices);
      for (let i = 0; i < framesInRange.length; i++) {
        if (!usedIndices.has(i)) framesInRange[i].close();
      }

      const bitmapCache = new Map<number, ImageBitmap>();
      async function getBitmapFor(index: number): Promise<ImageBitmap> {
        const cached = bitmapCache.get(index);
        if (cached) return cached;
        const frame = framesInRange[index];
        const bitmap = await createImageBitmap(frame);
        frame.close();
        bitmapCache.set(index, bitmap);
        return bitmap;
      }

      const gifFrames: GifFrame[] = [];
      let width = 0;
      let height = 0;
      const delayCs = Math.max(1, Math.round(100 / outputFps / speed));

      for (let i = 0; i < tickIndices.length; i++) {
        animExportStatus = `processing frame ${i + 1}/${tickIndices.length}…`;
        const bitmap = await getBitmapFor(tickIndices[i]);

        const srcWidth = bitmap.width;
        const srcHeight = bitmap.height;
        width = Math.max(2, Math.round(targetWidth / 2) * 2);
        height = Math.max(2, Math.round((width * srcHeight) / srcWidth / 2) * 2);

        const srcTexture = frameToTexture(device, bitmap);
        const { texture: resizedTexture } = resize(device, srcTexture, srcWidth, srcHeight, width, height);
        srcTexture.destroy();

        const histogramCounts = await computeHistogram(device, resizedTexture, width, height);
        const framePalette = medianCut(histogramCounts);
        const indices32 = await quantize(device, resizedTexture, width, height, framePalette, dither);
        resizedTexture.destroy();

        gifFrames.push({ indices: Uint8Array.from(indices32), palette: framePalette, delayCs });
      }

      for (const bitmap of bitmapCache.values()) bitmap.close();

      animExportStatus = 'encoding GIF…';
      const gifBytes = encodeGif(width, height, gifFrames, loopCount);
      downloadBlob(new Blob([new Uint8Array(gifBytes)], { type: 'image/gif' }), 'animation.gif');
      animExportStatus = `exported ${gifFrames.length} frames, ${width}×${height} @ ${outputFps}fps — ${gifBytes.length.toLocaleString()} bytes`;
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
      await requestPipelineRun();
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
    previewWidth = 0;
    previewHeight = 0;
    previewSourceImageData = null;
    previewQuantizedImageData = null;
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
      resetQualityForSource(track.codedWidth, track.codedHeight, 1_000_000 / frameDurationUs);

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
    <QualityPanel {sourceWidth} {sourceHeight} />
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

    <h2 class="ab-heading">Preview</h2>
    {#if quantizeStatus}
      <p class="status">{quantizeStatus}</p>
    {/if}
    <Preview
      width={previewWidth}
      height={previewHeight}
      sourceImageData={previewSourceImageData}
      quantizedImageData={previewQuantizedImageData}
    />

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
