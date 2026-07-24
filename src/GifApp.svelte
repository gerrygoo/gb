<script lang="ts">
  import { onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import PipelineShell from './components/PipelineShell.svelte';
  import QualityPanel from './components/QualityPanel.svelte';
  import Preview from './components/Preview.svelte';
  import SizeEstimate from './components/SizeEstimate.svelte';
  import ExportBar from './components/ExportBar.svelte';
  import type { DemuxResult } from './lib/demux';
  import { decodeFramesStreaming, nearestKeyframeAtOrBefore } from './lib/decode';
  import type { FrameSeeker } from './lib/seek';
  import type { GPUContext } from './lib/gpu';
  import { frameToTexture, resize } from './lib/resize';
  import { computeHistogram } from './lib/histogram';
  import { medianCut } from './lib/palette';
  import { quantize, indicesToImageData, type DitherMode } from './lib/quantize';
  import { computeGlobalPalette } from './lib/globalPalette';
  import { encodeGif } from './lib/gif';
  import { EncodeWorkerClient } from './lib/encodeClient';
  import { estimateGifSize, type SizeEstimateResult } from './lib/estimate';
  import { quality, computeOutputDims } from './lib/quality';

  // Bound from PipelineShell — see its own doc comments for why plain export
  // + bind: is used here instead of slot props (this component's script
  // logic, not just its markup, needs to read them).
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

  let canvas: HTMLCanvasElement;
  let gpuCanvas: HTMLCanvasElement;
  let browserCanvas: HTMLCanvasElement;

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

  let exportStatus = '';
  let animExportStatus = '';
  let animExporting = false;
  let animExportProgress: { current: number; total: number } | null = null;
  let animExportError: string | null = null;
  let animExportUrl: string | null = null;
  let animExportBytes: number | null = null;
  let exportAbort: AbortController | null = null;

  let sizeEstimate: SizeEstimateResult | null = null;
  let estimating = false;
  let estimateAbort: AbortController | null = null;
  let estimateDebounceHandle: ReturnType<typeof setTimeout> | null = null;
  let estimateRunId = 0;

  onDestroy(() => {
    exportAbort?.abort();
    estimateAbort?.abort();
    if (animExportUrl) URL.revokeObjectURL(animExportUrl);
  });

  $: if (canvas && sourceBitmap) {
    canvas.width = sourceBitmap.width;
    canvas.height = sourceBitmap.height;
    canvas.getContext('2d')?.drawImage(sourceBitmap, 0, 0);
  }

  const DITHER_LABELS: Record<DitherMode, string> = { none: 'no dither', 'blue-noise': 'blue-noise dither', bayer: 'bayer dither' };

  function drawPalette(pal: Uint8Array) {
    const colorCount = pal.length / 3;
    const swatchSize = 16;
    const cols = 16;
    const rows = Math.ceil(colorCount / cols);
    paletteCanvas.width = cols * swatchSize;
    paletteCanvas.height = rows * swatchSize;
    const ctx = paletteCanvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, paletteCanvas.width, paletteCanvas.height);
    for (let i = 0; i < colorCount; i++) {
      const x = (i % cols) * swatchSize;
      const y = Math.floor(i / cols) * swatchSize;
      ctx.fillStyle = `rgb(${pal[i * 3]}, ${pal[i * 3 + 1]}, ${pal[i * 3 + 2]})`;
      ctx.fillRect(x, y, swatchSize, swatchSize);
    }
  }

  /** Runs histogram → palette → quantize against a freshly resized source
   * frame handed off by PipelineShell, which owns resize itself (shared with
   * a future WebM consumer) — this is the GIF-specific back half of what
   * used to be one `runQualityPipeline` function. Takes ownership of
   * `frame.texture`: destroys the previous one now that this one exists,
   * exactly like the combined function used to. PipelineShell awaits this
   * before starting its next resize, so this never overlaps a resize that
   * would otherwise destroy `frame.texture` out from under the GPU work
   * below. */
  async function handleResized(frame: { texture: GPUTexture; imageData: ImageData; width: number; height: number }) {
    const { texture, imageData, width, height } = frame;
    resizedTexture?.destroy();
    resizedTexture = texture;

    if (gpuCanvas) {
      gpuCanvas.width = width;
      gpuCanvas.height = height;
      gpuCanvas.getContext('2d')?.putImageData(imageData, 0, 0);
    }
    if (browserCanvas && sourceBitmap) {
      browserCanvas.width = width;
      browserCanvas.height = height;
      browserCanvas.getContext('2d')?.drawImage(sourceBitmap, 0, 0, width, height);
    }

    paletteStatus = 'computing palette…';
    try {
      const { device } = await gpuContext;
      const { dither, paletteSize, globalPalette, colorSpace } = get(quality);

      if (globalPalette && seeker) {
        palette = await computeGlobalPalette({
          device,
          seeker,
          inPoint,
          outPoint,
          outputWidth: width,
          outputHeight: height,
          paletteSize,
          colorSpace,
        });
        drawPalette(palette);
        paletteStatus = `${paletteSize}-color global palette · median-cut over samples from the in/out range`;
      } else {
        const histogramCounts = await computeHistogram(device, texture, width, height, colorSpace);
        palette = medianCut(histogramCounts, paletteSize, colorSpace);
        drawPalette(palette);
        const populatedBins = histogramCounts.filter((count) => count > 0).length;
        paletteStatus = `${paletteSize}-color palette · median-cut over ${populatedBins} populated histogram bins`;
      }

      quantizeStatus = 'quantizing + dithering…';
      const indices = await quantize(device, texture, width, height, palette, { ditherMode: dither, colorSpace });
      quantizedIndices = indices;
      const quantizedImageData = indicesToImageData(indices, palette, width, height);
      previewWidth = width;
      previewHeight = height;
      previewSourceImageData = imageData;
      previewQuantizedImageData = quantizedImageData;
      quantizeStatus = `${width}×${height} · ${paletteSize} colors · ${DITHER_LABELS[dither]} · ${colorSpace}`;
    } catch (err) {
      paletteStatus = '';
      quantizeStatus = `error: ${(err as Error).message}`;
    }
  }

  function handleFileChange() {
    exportAbort?.abort();
    estimateAbort?.abort();
    revokeAnimExportUrl();

    resizedTexture?.destroy();
    resizedTexture = null;
    palette = null;
    paletteStatus = '';
    quantizeStatus = '';
    quantizedIndices = null;
    previewWidth = 0;
    previewHeight = 0;
    previewSourceImageData = null;
    previewQuantizedImageData = null;
    exportStatus = '';
    animExportStatus = '';
    animExportError = null;
    animExportBytes = null;
    sizeEstimate = null;
  }

  /** Samples ~8 frames from the in/out range through the real pipeline + LZW
   * (via a fresh, throwaway encode worker) and extrapolates a size estimate.
   * Superseded runs are dropped via `estimateRunId` rather than raced. */
  async function runSizeEstimate() {
    if (!seeker || !sourceWidth || !sourceHeight) return;
    const runId = ++estimateRunId;
    estimateAbort?.abort();
    const abort = new AbortController();
    estimateAbort = abort;
    estimating = true;
    try {
      const { device } = await gpuContext;
      const result = await estimateGifSize({
        device,
        seeker,
        sourceWidth,
        sourceHeight,
        inPoint,
        outPoint,
        avgFrameDurationUs: frameDurationUs,
        quality: get(quality),
        signal: abort.signal,
      });
      if (runId === estimateRunId && result) sizeEstimate = result;
    } catch (err) {
      // Best-effort UI sugar — a failed estimate shouldn't block export.
      console.error('size estimate failed', err);
    } finally {
      if (runId === estimateRunId) estimating = false;
    }
  }

  // Debounced re-estimate whenever quality settings or the in/out range
  // change, mirroring the quality-pipeline debounce in PipelineShell. The
  // scheduling itself lives in a plain function (not inlined in the `$:`
  // block) since it both reads and writes `estimateDebounceHandle` —
  // inlined, that read would make Svelte treat the block as depending on
  // its own write and re-run it every tick instead of waiting out the
  // debounce.
  function scheduleEstimate() {
    if (estimateDebounceHandle) clearTimeout(estimateDebounceHandle);
    estimateDebounceHandle = setTimeout(() => {
      estimateDebounceHandle = null;
      runSizeEstimate();
    }, 150);
  }

  $: if (seeker && sourceBitmap) {
    void $quality;
    void inPoint;
    void outPoint;
    scheduleEstimate();
  }

  function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function triggerDownload(url: string, filename: string) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
  }

  function revokeAnimExportUrl() {
    if (animExportUrl) {
      URL.revokeObjectURL(animExportUrl);
      animExportUrl = null;
    }
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
    animExportError = null;
    animExportProgress = null;
    revokeAnimExportUrl();
    animExportBytes = null;
    const abort = new AbortController();
    exportAbort = abort;
    const worker = new EncodeWorkerClient();
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
      animExportStatus = `preparing export (in/out ${from + 1}–${to + 1})…`;
      const { device } = await gpuContext;
      const { targetWidth, fps: outputFps, paletteSize, globalPalette, dither, colorSpace, loopCount, speed } = get(quality);

      // Source dimensions are already known (unlike per-frame decode
      // metadata), so output dims can be computed once up front rather than
      // on the first decoded tick — needed anyway to build the global
      // palette (q5) before any frame is quantized against it.
      const { width, height } = computeOutputDims(targetWidth, sourceWidth, sourceHeight);

      let sharedPalette: Uint8Array | null = null;
      if (globalPalette) {
        animExportStatus = 'sampling frames for global palette…';
        sharedPalette = await computeGlobalPalette({
          device,
          seeker,
          inPoint: from,
          outPoint: to,
          outputWidth: width,
          outputHeight: height,
          paletteSize,
          colorSpace,
          signal: abort.signal,
        });
        if (abort.signal.aborted) {
          animExportStatus = 'export cancelled';
          return;
        }
      }
      worker.start(width, height, loopCount, sharedPalette ? Uint8Array.from(sharedPalette) : undefined);

      // Build the output timeline from the encoded chunks' own `duration` —
      // this only needs demuxed chunk metadata, not decoded frames, so the
      // tick schedule is ready before any decoding starts. Resamples to the
      // target output FPS by nearest-neighbor lookup on a synthetic timeline
      // (cumulative duration in array order) — drops or duplicates source
      // frames as needed rather than assuming output FPS == source FPS.
      //
      // Deliberately NOT using chunk `timestamp` (presentation time): this
      // codebase's "frame index" convention is chunk/decode-order position
      // (Timeline, seek.ts, and the in/out trim above all index by it), not
      // presentation order. For a range trimmed out of a B-frame stream, the
      // last chunk in the slice can have a presentation timestamp far ahead
      // of its decode-order neighbors, which would throw off a
      // timestamp-based total-duration calculation. `duration` stays uniform
      // regardless.
      const selectionChunks = chunks.slice(from, to + 1);
      let cursor = 0;
      const frameStartUs = selectionChunks.map((c) => {
        const start = cursor;
        cursor += c.duration ?? frameDurationUs;
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

      let cancelled = false;
      const delayCs = Math.max(1, Math.round(100 / outputFps / speed));
      animExportProgress = { current: 0, total: tickIndices.length };

      /** Runs resize → (histogram → palette, unless a global one was
       * precomputed) → quantize → encode for one output tick against an
       * already-decoded bitmap. Returns false if the export was cancelled
       * mid-stage. */
      async function processTick(bitmap: ImageBitmap): Promise<boolean> {
        const srcTexture = frameToTexture(device, bitmap);
        const { texture: resizedTexture } = resize(device, srcTexture, bitmap.width, bitmap.height, width, height);
        srcTexture.destroy();

        if (abort.signal.aborted) {
          resizedTexture.destroy();
          return false;
        }

        let framePalette = sharedPalette;
        if (!framePalette) {
          const histogramCounts = await computeHistogram(device, resizedTexture, width, height, colorSpace);
          framePalette = medianCut(histogramCounts, paletteSize, colorSpace);
        }
        const indices32 = await quantize(device, resizedTexture, width, height, framePalette, { ditherMode: dither, colorSpace });
        resizedTexture.destroy();

        if (abort.signal.aborted) return false;

        // `framePalette` may be `sharedPalette`, reused for every tick —
        // copy before `encodeFrame`, which transfers (detaches) the buffer.
        const ack = await worker.encodeFrame(Uint8Array.from(indices32), Uint8Array.from(framePalette), delayCs);
        animExportProgress = { current: ack.framesEncoded, total: tickIndices.length };
        return true;
      }

      // `tickIndices` is non-decreasing (built from a monotonic output
      // timeline), so needed source frames arrive in exactly the same order
      // the decoder streams them out. That means at most one decoded frame
      // is ever alive at once here — each is closed immediately if unneeded,
      // or right after its bitmap is made — rather than the whole in/out
      // range being decoded and buffered up front.
      animExportStatus = `exporting ${tickIndices.length} frames (in/out ${from + 1}–${to + 1})…`;
      const streamConfig: VideoDecoderConfig = {
        codec: track.codec,
        codedWidth: track.codedWidth,
        codedHeight: track.codedHeight,
        description: track.description,
      };

      let k = 0;
      let pos = 0;
      decodeLoop: for await (const frame of decodeFramesStreaming(streamConfig, rangeChunks)) {
        if (abort.signal.aborted) {
          frame.close();
          cancelled = true;
          break;
        }

        const sourceIndex = pos - leadInCount;
        pos++;

        if (sourceIndex < 0 || k >= tickIndices.length || sourceIndex < tickIndices[k]) {
          frame.close();
          continue;
        }

        // sourceIndex === tickIndices[k]: the next needed source frame.
        // Reuse one bitmap for every consecutive tick that maps to it (fps
        // downsampling can repeat a source frame across several ticks).
        const bitmap = await createImageBitmap(frame);
        frame.close();
        try {
          while (k < tickIndices.length && tickIndices[k] === sourceIndex) {
            animExportStatus = `processing frame ${k + 1}/${tickIndices.length}…`;
            const ok = await processTick(bitmap);
            k++;
            if (!ok) {
              cancelled = true;
              break decodeLoop;
            }
          }
        } finally {
          bitmap.close();
        }

        if (k >= tickIndices.length) break;
      }

      if (cancelled) {
        animExportStatus = 'export cancelled';
        return;
      }

      animExportStatus = 'finalizing GIF…';
      const gifBytes = await worker.finish();
      const blob = new Blob([gifBytes], { type: 'image/gif' });
      animExportUrl = URL.createObjectURL(blob);
      animExportBytes = gifBytes.length;
      triggerDownload(animExportUrl, 'animation.gif');
      animExportStatus = `exported ${tickIndices.length} frames, ${width}×${height} @ ${outputFps}fps — ${gifBytes.length.toLocaleString()} bytes`;
    } catch (err) {
      if (!abort.signal.aborted) {
        animExportError = (err as Error).message;
        animExportStatus = `export error: ${(err as Error).message}`;
      }
    } finally {
      worker.terminate();
      animExporting = false;
      animExportProgress = null;
      exportAbort = null;
    }
  }

  function cancelAnimatedExport() {
    exportAbort?.abort();
  }
</script>

<PipelineShell
  title="gif builder"
  crossLink={{ href: '/webm/', label: 'webm exporter →' }}
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
    {#if quantizeStatus}
      <p class="status preview-status">{quantizeStatus}</p>
    {/if}
    <Preview
      width={previewWidth}
      height={previewHeight}
      sourceImageData={previewSourceImageData}
      quantizedImageData={previewQuantizedImageData}
    />
  </svelte:fragment>

  <svelte:fragment slot="side">
    <QualityPanel {sourceWidth} {sourceHeight} />

    <div class="export-card">
      <SizeEstimate estimate={sizeEstimate} {estimating} />
      <ExportBar
        exporting={animExporting}
        disabled={!currentDemux}
        progress={animExportProgress}
        statusText={animExportStatus}
        error={animExportError}
        downloadUrl={animExportUrl}
        downloadBytes={animExportBytes}
        on:encode={exportAnimatedGif}
        on:cancel={cancelAnimatedExport}
      />
      <button class="frame-export" on:click={exportSingleFrameGif} disabled={!quantizedIndices}>
        or export just the current frame
      </button>
      {#if exportStatus}
        <p class="status">{exportStatus}</p>
      {/if}
    </div>
  </svelte:fragment>

  <svelte:fragment slot="debug" let:resizeStatus>
    <details class="debug-disclosure">
      <summary>Debug: raw decode, resize comparison &amp; palette</summary>
      <div class="debug-body">
        <div class="comparison-pane">
          <p class="pane-label">Raw decoded frame</p>
          <canvas bind:this={canvas}></canvas>
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
            <p class="pane-label">Palette · median-cut</p>
            {#if paletteStatus}
              <p class="status">{paletteStatus}</p>
            {/if}
            <canvas bind:this={paletteCanvas} class="palette-canvas"></canvas>
          </div>
        </div>
      </div>
    </details>
  </svelte:fragment>
</PipelineShell>

<style>
  .status {
    font-size: 0.85rem;
    color: #666;
    margin: 0;
  }

  .preview-status {
    text-align: center;
  }

  .export-card {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px 16px;
    border: 1px solid #333;
    border-radius: 6px;
  }

  .frame-export {
    align-self: flex-start;
    background: none;
    border: none;
    color: #777;
    font-size: 0.75rem;
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
    padding: 0;
  }

  .frame-export:hover:not(:disabled) {
    color: #aaa;
  }

  .frame-export:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .debug-disclosure {
    align-self: stretch;
    border: 1px solid #262626;
    border-radius: 6px;
    padding: 4px 16px;
  }

  .debug-disclosure summary {
    font-size: 0.75rem;
    color: #666;
    cursor: pointer;
    padding: 8px 0;
  }

  .debug-disclosure summary:hover {
    color: #999;
  }

  .debug-body {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 8px 0 16px;
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

  canvas {
    max-width: 90vw;
    border: 1px solid #333;
    border-radius: 4px;
  }

  .palette-canvas {
    width: 256px;
    height: 256px;
    max-width: 45vw;
    image-rendering: pixelated;
  }

  @media (max-width: 700px) {
    .comparison {
      gap: 16px;
    }

    .comparison-pane canvas,
    .palette-canvas {
      max-width: 90vw;
    }
  }
</style>
