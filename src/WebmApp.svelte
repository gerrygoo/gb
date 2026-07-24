<script lang="ts">
  import { onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import PipelineShell from './components/PipelineShell.svelte';
  import WebmQualityPanel from './components/WebmQualityPanel.svelte';
  import SizeEstimate from './components/SizeEstimate.svelte';
  import ExportBar from './components/ExportBar.svelte';
  import type { DemuxResult } from './lib/demux';
  import { decodeFramesStreaming, nearestKeyframeAtOrBefore } from './lib/decode';
  import type { FrameSeeker } from './lib/seek';
  import type { GPUContext } from './lib/gpu';
  import { frameToTexture, resize, textureToImageData } from './lib/resize';
  import { WebmEncodeWorkerClient } from './lib/webmEncodeClient';
  import { quality, computeOutputDims } from './lib/quality';
  import { estimateWebmSize, type WebmSizeEstimateResult } from './lib/estimateWebm';

  // Bound from PipelineShell — see GifApp.svelte / PipelineShell.svelte for
  // why plain export + bind: is used instead of slot props.
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

  let webmExportStatus = '';
  let webmExporting = false;
  let webmExportProgress: { current: number; total: number } | null = null;
  let webmExportError: string | null = null;
  let webmExportUrl: string | null = null;
  let webmExportBytes: number | null = null;
  let exportAbort: AbortController | null = null;

  let sizeEstimate: WebmSizeEstimateResult | null = null;
  // Arithmetic estimate (bitrate × duration) — unlike GIF's sampled/encoded
  // estimate, this is cheap enough to run synchronously on every relevant
  // change rather than debounced through an abortable async pass.
  $: sizeEstimate =
    sourceWidth && sourceHeight
      ? estimateWebmSize({
          sourceWidth,
          sourceHeight,
          inPoint,
          outPoint,
          avgFrameDurationUs: frameDurationUs,
          quality: $quality,
        })
      : null;

  onDestroy(() => {
    resizedTexture?.destroy();
    exportAbort?.abort();
    revokeWebmExportUrl();
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
    exportAbort?.abort();
    revokeWebmExportUrl();
    webmExportStatus = '';
    webmExportError = null;
    webmExportBytes = null;
    sizeEstimate = null;
  }

  function triggerDownload(url: string, filename: string) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
  }

  function revokeWebmExportUrl() {
    if (webmExportUrl) {
      URL.revokeObjectURL(webmExportUrl);
      webmExportUrl = null;
    }
  }

  /** The real per-frame encode path — structured like GifApp.svelte's
   * exportAnimatedGif (its own decodeFramesStreaming loop over the
   * keyframe-aligned in/out range, its own direct frameToTexture/resize()
   * calls per tick, fps-resampling against a cumulative-duration timeline),
   * but with no histogram/palette/quantize step: the resized frame goes
   * straight to a VideoFrame for VP9 encoding. Unlike GIF's discrete
   * per-frame delayCs, WebM wants a continuous microsecond timestamp
   * stream, so `speed` scales the tick interval directly rather than a
   * single per-frame delay. */
  async function exportWebm() {
    if (!currentDemux || !seeker || webmExporting) return;
    webmExporting = true;
    webmExportError = null;
    webmExportProgress = null;
    revokeWebmExportUrl();
    webmExportBytes = null;
    const abort = new AbortController();
    exportAbort = abort;
    const worker = new WebmEncodeWorkerClient();
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
      webmExportStatus = `preparing export (in/out ${from + 1}–${to + 1})…`;
      const { device } = await gpuContext;
      const { targetWidth, fps: outputFps, speed, bitrateKbps, keyframeIntervalSec } = get(quality);
      const { width, height } = computeOutputDims(targetWidth, sourceWidth, sourceHeight);

      await worker.start(bitrateKbps * 1000, keyframeIntervalSec);

      // Build the output timeline from the encoded chunks' own `duration`,
      // same approach as GIF's export (see its own comment for why `duration`
      // and not presentation `timestamp` — decode-order vs. presentation-order).
      const selectionChunks = chunks.slice(from, to + 1);
      let cursor = 0;
      const frameStartUs = selectionChunks.map((c) => {
        const start = cursor;
        cursor += c.duration ?? frameDurationUs;
        return start;
      });
      const totalDurationUs = cursor;
      // Source frames are always sampled at the real output cadence
      // (`baseIntervalUs`) regardless of speed — only the timestamps written
      // into the encoded file are scaled, so `speed` changes playback rate
      // without also resampling which content gets shown.
      const baseIntervalUs = 1_000_000 / outputFps;
      const outputIntervalUs = baseIntervalUs / speed;
      const outputFrameCount = Math.max(1, Math.round(totalDurationUs / baseIntervalUs) || 1);

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
        tickIndices.push(nearestSourceIndex(k * baseIntervalUs));
      }

      let cancelled = false;
      webmExportProgress = { current: 0, total: tickIndices.length };

      /** Runs resize → VideoFrame → encode for one output tick against an
       * already-decoded bitmap. Returns false if the export was cancelled
       * mid-stage. */
      async function processTick(bitmap: ImageBitmap, tickIndex: number): Promise<boolean> {
        const srcTexture = frameToTexture(device, bitmap);
        const { texture: resizedTex } = resize(device, srcTexture, bitmap.width, bitmap.height, width, height);
        srcTexture.destroy();

        if (abort.signal.aborted) {
          resizedTex.destroy();
          return false;
        }

        const imageData = await textureToImageData(device, resizedTex, width, height);
        resizedTex.destroy();

        if (abort.signal.aborted) return false;

        const timestamp = Math.round(tickIndex * outputIntervalUs);
        const duration = Math.round(outputIntervalUs);
        const frame = new VideoFrame(imageData.data, {
          format: 'RGBA',
          codedWidth: width,
          codedHeight: height,
          timestamp,
          duration,
        });
        const ack = await worker.encodeFrame(frame);
        webmExportProgress = { current: ack.framesEncoded, total: tickIndices.length };
        return true;
      }

      // Same "at most one decoded bitmap alive at once" streaming discipline
      // as GIF's export — see its own comment for why `tickIndices` being
      // non-decreasing guarantees that.
      webmExportStatus = `exporting ${tickIndices.length} frames (in/out ${from + 1}–${to + 1})…`;
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

        const bitmap = await createImageBitmap(frame);
        frame.close();
        try {
          while (k < tickIndices.length && tickIndices[k] === sourceIndex) {
            webmExportStatus = `processing frame ${k + 1}/${tickIndices.length}…`;
            const ok = await processTick(bitmap, k);
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
        webmExportStatus = 'export cancelled';
        return;
      }

      webmExportStatus = 'finalizing WebM…';
      const { bytes, mimeType } = await worker.finish();
      const blob = new Blob([bytes], { type: mimeType });
      webmExportUrl = URL.createObjectURL(blob);
      webmExportBytes = bytes.length;
      triggerDownload(webmExportUrl, 'video.webm');
      webmExportStatus = `exported ${tickIndices.length} frames, ${width}×${height} @ ${outputFps}fps — ${bytes.length.toLocaleString()} bytes`;
    } catch (err) {
      if (!abort.signal.aborted) {
        webmExportError = (err as Error).message;
        webmExportStatus = `export error: ${(err as Error).message}`;
      }
    } finally {
      worker.terminate();
      webmExporting = false;
      webmExportProgress = null;
      exportAbort = null;
    }
  }

  function cancelWebmExport() {
    exportAbort?.abort();
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
    <WebmQualityPanel {sourceWidth} {sourceHeight} />

    <div class="export-card">
      <SizeEstimate estimate={sizeEstimate} />
      <ExportBar
        exporting={webmExporting}
        disabled={!currentDemux}
        progress={webmExportProgress}
        statusText={webmExportStatus}
        error={webmExportError}
        downloadUrl={webmExportUrl}
        downloadFilename="video.webm"
        downloadBytes={webmExportBytes}
        label="Export WebM"
        encodingLabel="Encoding…"
        on:encode={exportWebm}
        on:cancel={cancelWebmExport}
      />
    </div>
  </svelte:fragment>
</PipelineShell>

<style>
  .preview-canvas {
    max-width: 100%;
    border: 1px solid #333;
    border-radius: 4px;
  }

  .export-card {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px 16px;
    border: 1px solid #333;
    border-radius: 6px;
  }
</style>
