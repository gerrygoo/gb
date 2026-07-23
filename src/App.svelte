<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import DropZone from './components/DropZone.svelte';
  import Timeline from './components/Timeline.svelte';
  import QualityPanel from './components/QualityPanel.svelte';
  import Preview from './components/Preview.svelte';
  import SizeEstimate from './components/SizeEstimate.svelte';
  import ExportBar from './components/ExportBar.svelte';
  import { demux, type DemuxResult } from './lib/demux';
  import { decodeFramesStreaming, isDecodeConfigSupported, nearestKeyframeAtOrBefore } from './lib/decode';
  import { createFrameSeeker, type FrameSeeker } from './lib/seek';
  import { initGPU, setGPUContext, runTestShader } from './lib/gpu';
  import { frameToTexture, resize, textureToImageData } from './lib/resize';
  import { computeHistogram } from './lib/histogram';
  import { medianCut } from './lib/palette';
  import { quantize, indicesToImageData, type DitherMode } from './lib/quantize';
  import { computeGlobalPalette } from './lib/globalPalette';
  import { encodeGif } from './lib/gif';
  import { EncodeWorkerClient } from './lib/encodeClient';
  import { estimateGifSize, type SizeEstimateResult } from './lib/estimate';
  import { statusText, withBusy } from './lib/status';
  import { quality, resetQualityForSource, computeOutputDims } from './lib/quality';

  let fileName = '';
  let status = '';
  let canvas: HTMLCanvasElement;
  let gpuCanvas: HTMLCanvasElement;
  let browserCanvas: HTMLCanvasElement;
  let gpuStatus = 'initializing…';
  let gpuFailed = false;
  let resizeStatus = '';
  let initialLoading = false;
  let fileSizeWarning: string | null = null;
  let showShortcutHelp = false;

  /** Cheap check on the dropped File's on-disk size, right on drop — before
   * demuxing even starts. Catches obviously-huge uploads fast; doesn't catch
   * a small, highly-compressed file that decodes to a huge frame range
   * (that's what SizeEstimate's decoded-range warning is for, once in/out
   * points exist). Non-blocking — informational only. */
  const FILE_SIZE_WARN_BYTES = 1_000_000_000;

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
      if (!matches) gpuFailed = true;
    } catch (err) {
      gpuStatus = `WebGPU unavailable: ${(err as Error).message}`;
      gpuFailed = true;
    }
  });

  onDestroy(() => {
    exportAbort?.abort();
    estimateAbort?.abort();
    if (animExportUrl) URL.revokeObjectURL(animExportUrl);
  });

  function drawFrame(bitmap: ImageBitmap) {
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx?.drawImage(bitmap, 0, 0);
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

  /** Runs resize → histogram → palette → quantize on the current playhead frame at the
   * current quality settings. Generalizes what used to be a preset-height-only `runResize`. */
  async function runQualityPipeline() {
    if (!sourceBitmap || !sourceTexture || !seeker) return;
    const bitmap = sourceBitmap;
    const srcTexture = sourceTexture;
    const activeSeeker = seeker;
    const { targetWidth, dither, paletteSize, globalPalette, colorSpace } = get(quality);

    const { width, height } = computeOutputDims(targetWidth, sourceWidth, sourceHeight);
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

        if (globalPalette) {
          palette = await computeGlobalPalette({
            device,
            seeker: activeSeeker,
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
  // change, mirroring the quality-pipeline debounce above. The scheduling
  // itself lives in a plain function (not inlined in the `$:` block) since
  // it both reads and writes `estimateDebounceHandle` — inlined, that read
  // would make Svelte treat the block as depending on its own write and
  // re-run it every tick instead of waiting out the debounce.
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

  /** Decodes + renders `target`, updating the preview canvas + pipeline.
   * `sourceBitmap` is cache-owned by `seeker` — never close it directly; the
   * seeker's LRU eviction handles that. `pin: true` keeps this specific
   * frame exempt from that eviction (see seek.ts) while it's on screen —
   * without it, a background size-estimate or global-palette sample seek
   * elsewhere in the range can evict it out from under a still-running
   * quality pipeline, which was surfacing as a "the image source is
   * detached" resize error on longer videos. */
  async function seekToFrame(target: number) {
    if (!seeker) return;
    try {
      const bitmap = await seeker.seekTo(target, { pin: true });
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
    initialLoading = true;
    fileSizeWarning =
      file.size > FILE_SIZE_WARN_BYTES
        ? `Large file (${(file.size / 1024 ** 2).toFixed(0)} MB) — demuxing/decoding may be slow.`
        : null;

    exportAbort?.abort();
    estimateAbort?.abort();
    revokeAnimExportUrl();

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
    animExportError = null;
    animExportBytes = null;
    sizeEstimate = null;
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

      const supported = await withBusy('checking codec support…', () => isDecodeConfigSupported(config));
      if (!supported) {
        status = `error: unsupported codec "${track.codec}" — this browser can't decode it. Try re-encoding to H.264 with ffmpeg/HandBrake, or use a different browser.`;
        return;
      }

      seeker = createFrameSeeker(config, chunks);
      outPoint = chunks.length - 1;
      frameDurationUs = chunks.reduce((sum, c) => sum + (c.duration ?? 33_000), 0) / chunks.length;
      resetQualityForSource(track.codedWidth, track.codedHeight, 1_000_000 / frameDurationUs);

      status = `${track.codedWidth}×${track.codedHeight} · ${track.codec} · ${chunks.length} frames (${seeker.keyframes.chunkIndices.length} keyframes)`;

      await queueSeek(0);
    } catch (err) {
      status = `error: ${(err as Error).message}`;
    } finally {
      initialLoading = false;
    }
  }

  function isTypingTarget(el: EventTarget | null): boolean {
    if (!(el instanceof HTMLElement)) return false;
    return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
  }

  function onGlobalKeydown(e: KeyboardEvent) {
    if (e.key === '?' && !isTypingTarget(e.target)) {
      e.preventDefault();
      showShortcutHelp = !showShortcutHelp;
    } else if (e.key === 'Escape' && showShortcutHelp) {
      showShortcutHelp = false;
    }
  }
</script>

<svelte:window on:keydown={onGlobalKeydown} />

<main>
  <h1>gif builder</h1>
  <p class="gpu-status" class:gpu-failed={gpuFailed}>{gpuStatus}</p>
  {#if gpuFailed}
    <p class="gpu-blocking">
      This browser can't run the GPU pipeline this tool needs. Try Chrome/Edge, or Safari 17+, with
      hardware acceleration enabled.
    </p>
  {/if}
  <p class="busy-status" class:idle={$statusText === 'Idle'}>{$statusText}</p>
  <DropZone on:file={handleFile} disabled={gpuFailed} />
  {#if fileName}
    <p class="file-name">{fileName}</p>
  {/if}
  {#if fileSizeWarning}
    <p class="warning-text">{fileSizeWarning}</p>
  {/if}
  {#if status}
    <p class="status">{status}</p>
  {/if}
  {#if initialLoading}
    <div class="loading-row">
      <span class="spinner" aria-hidden="true"></span>
      <span>Loading video…</span>
    </div>
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
    </div>
    {#if exportStatus}
      <p class="status">{exportStatus}</p>
    {/if}

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
  {/if}
</main>

<button
  class="help-fab"
  title="Keyboard shortcuts (?)"
  aria-label="Show keyboard shortcuts"
  on:click={() => (showShortcutHelp = !showShortcutHelp)}
>
  ?
</button>

{#if showShortcutHelp}
  <div
    class="shortcut-overlay"
    on:click={() => (showShortcutHelp = false)}
    on:keydown={(e) => e.key === 'Enter' && (showShortcutHelp = false)}
    role="button"
    tabindex="0"
    aria-label="Close keyboard shortcuts"
  >
    <div
      class="shortcut-panel"
      on:click|stopPropagation
      on:keydown|stopPropagation
      role="dialog"
      tabindex="-1"
      aria-label="Keyboard shortcuts"
    >
      <div class="shortcut-header">
        <h2>Keyboard shortcuts</h2>
        <button class="close" aria-label="Close" on:click={() => (showShortcutHelp = false)}>×</button>
      </div>
      <dl>
        <dt>← / →</dt><dd>Step ±1 frame</dd>
        <dt>Home / End</dt><dd>Jump to first / last frame</dd>
        <dt>J / L</dt><dd>Play backward / forward</dd>
        <dt>K</dt><dd>Pause playback</dd>
        <dt>I / O</dt><dd>Set in / out point at playhead</dd>
        <dt>?</dt><dd>Toggle this help</dd>
        <dt>Esc</dt><dd>Close this help</dd>
      </dl>
    </div>
  </div>
{/if}

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

  .gpu-status.gpu-failed {
    color: #e08a8a;
  }

  .gpu-blocking {
    font-size: 0.85rem;
    color: #e08a8a;
    text-align: center;
    max-width: 480px;
    border: 1px solid #663333;
    background: rgba(224, 138, 138, 0.08);
    border-radius: 6px;
    padding: 8px 14px;
    margin: -12px 0 0;
  }

  .warning-text {
    font-size: 0.8rem;
    color: #e0b84a;
    text-align: center;
    max-width: 480px;
  }

  .loading-row {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 0.9rem;
    color: #aaa;
  }

  .spinner {
    width: 16px;
    height: 16px;
    border: 2px solid #333;
    border-top-color: #7ec4e0;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .help-fab {
    position: fixed;
    right: 20px;
    bottom: 20px;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    border: 1px solid #444;
    background: #1a1a1a;
    color: #ccc;
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
    z-index: 10;
  }

  .help-fab:hover {
    border-color: #888;
    color: #fff;
  }

  .shortcut-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 20;
  }

  .shortcut-panel {
    background: #1a1a1a;
    border: 1px solid #444;
    border-radius: 8px;
    padding: 20px 24px;
    max-width: 360px;
    width: 90vw;
  }

  .shortcut-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }

  .shortcut-header h2 {
    font-size: 1rem;
    font-weight: 600;
    color: #e0e0e0;
    margin: 0;
  }

  .shortcut-header .close {
    background: none;
    border: none;
    color: #888;
    font-size: 1.2rem;
    cursor: pointer;
    line-height: 1;
    padding: 0 4px;
  }

  .shortcut-header .close:hover {
    color: #fff;
  }

  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 6px 16px;
    margin: 0;
  }

  dt {
    font-size: 0.85rem;
    color: #ccc;
    font-weight: 600;
    white-space: nowrap;
  }

  dd {
    font-size: 0.85rem;
    color: #999;
    margin: 0;
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

  @media (max-width: 700px) {
    main {
      gap: 16px;
      padding: 0 4px;
    }

    .comparison {
      gap: 16px;
    }

    .comparison-pane canvas,
    .palette-canvas {
      max-width: 90vw;
    }

    .help-fab {
      right: 12px;
      bottom: 12px;
    }
  }
</style>
