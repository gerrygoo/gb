<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import DropZone from './DropZone.svelte';
  import Timeline from './Timeline.svelte';
  import { demux, type DemuxResult } from '../lib/demux';
  import { decodeFramesStreaming, isDecodeConfigSupported } from '../lib/decode';
  import { createFrameSeeker, type FrameSeeker } from '../lib/seek';
  import { initGPU, setGPUContext, runTestShader, type GPUContext } from '../lib/gpu';
  import { frameToTexture, resize, textureToImageData } from '../lib/resize';
  import { statusText, withBusy } from '../lib/status';
  import { quality, resetQualityForSource, computeOutputDims } from '../lib/quality';

  export let title = 'video tool';

  /** Optional nav link rendered next to the title — e.g. GIF/WebM app
   * cross-links to their sibling app. Purely chrome; the shell has no
   * opinion on where it points. */
  export let crossLink: { href: string; label: string } | null = null;

  /** Fired (and awaited) once per completed resize, carrying ownership of the
   * new texture to the caller — this component keeps no reference to it once
   * handed off, so the caller is responsible for destroying it (typically
   * right before replacing it with the next one). Awaited so that a caller
   * whose downstream GPU work (e.g. quantize) is still reading the previous
   * frame can finish before this component starts the next resize — the same
   * single-flight discipline `runQualityPipeline` used to enforce internally
   * when resize and quantize lived in one function. */
  export let onResized: (frame: { texture: GPUTexture; imageData: ImageData; width: number; height: number }) => Promise<void> =
    async () => {};

  /** Called synchronously at the start of a new file load, before demuxing —
   * lets a consumer reset its own derived state (palette, quantized preview,
   * export/estimate status) in step with this component's own reset. */
  export let onFileChange: () => void = () => {};

  // Bound (read-mostly) state a consumer needs for its own slot content and
  // script logic — export/estimate functions need these directly, not just in
  // markup, so plain slot props (template-scope only) wouldn't reach them.
  export let seeker: FrameSeeker | null = null;
  export let currentDemux: DemuxResult | null = null;
  export let playhead = 0;
  export let inPoint = 0;
  export let outPoint = 0;
  export let frameDurationUs = 33_000;
  export let sourceWidth = 0;
  export let sourceHeight = 0;
  export let sourceBitmap: ImageBitmap | null = null;
  /** The pending GPU context, bound up to the consumer — it needs the same
   * device for its own downstream GPU work (histogram/quantize/encode). Also
   * registered via `setGPUContext` for any ordinary descendant of this
   * component (Timeline, DropZone) that might need it; slotted consumer
   * content doesn't inherit that context since, despite rendering inside
   * this component's DOM, it's lexically owned by whoever instantiated this
   * component — hence the explicit bind. */
  export let gpuContext: Promise<GPUContext> = initGPU();

  let fileName = '';
  let status = '';
  let gpuStatus = 'initializing…';
  let gpuFailed = false;
  let initialLoading = false;
  let fileSizeWarning: string | null = null;
  let showShortcutHelp = false;

  /** Cheap check on the dropped File's on-disk size, right on drop — before
   * demuxing even starts. Catches obviously-huge uploads fast; doesn't catch
   * a small, highly-compressed file that decodes to a huge frame range
   * (that's what SizeEstimate's decoded-range warning is for, once in/out
   * points exist). Non-blocking — informational only. */
  const FILE_SIZE_WARN_BYTES = 1_000_000_000;

  let sourceTexture: GPUTexture | null = null;
  let resizeStatus = '';

  // setContext must be called during component initialisation, i.e. here at
  // top level rather than inside onMount.
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

  /** Resizes the current source frame to the target quality's output dims and
   * hands the result off via `onResized`. Generalizes what used to be a
   * preset-height-only `runResize`. */
  async function runResizePipeline() {
    if (!sourceTexture || !seeker) return;
    const srcTexture = sourceTexture;
    const { targetWidth } = get(quality);

    const { width, height } = computeOutputDims(targetWidth, sourceWidth, sourceHeight);
    resizeStatus = `resizing to ${width}×${height}…`;

    await withBusy(`processing preview (${width}×${height})…`, async () => {
      try {
        const { device } = await gpuContext;
        const { texture } = resize(device, srcTexture, sourceWidth, sourceHeight, width, height);
        const imageData = await textureToImageData(device, texture, width, height);
        resizeStatus = `${width}×${height} — GPU Lanczos-3`;
        await onResized({ texture, imageData, width, height });
      } catch (err) {
        resizeStatus = `resize error: ${(err as Error).message}`;
      }
    });
  }

  // Both a quality-store change and a playhead seek can trigger a resize;
  // without serialization they can race the same way overlapping seeks did in
  // Phase 8 (a later run starting — and its `onResized` callback destroying
  // the previous texture — while an earlier run's downstream consumer is
  // still working against that texture). Mirrors the seek loop's "latest
  // wins" queue below.
  let pendingPipelineRun = false;
  let pipelineRunning = false;
  let pipelineLoopPromise: Promise<void> = Promise.resolve();

  async function runPipelineLoop() {
    pipelineRunning = true;
    try {
      while (pendingPipelineRun) {
        pendingPipelineRun = false;
        await runResizePipeline();
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
  // that no-op before a file is loaded. Reruns on every quality field change,
  // not just resize-relevant ones (targetWidth) — the consumer's own
  // GIF-specific fields (palette/dither/etc.) need a fresh `onResized` call
  // too, and this component has no way to know which fields matter to it.
  let qualityDebounceHandle: ReturnType<typeof setTimeout> | null = null;
  quality.subscribe(() => {
    if (!sourceBitmap) return;
    if (qualityDebounceHandle) clearTimeout(qualityDebounceHandle);
    qualityDebounceHandle = setTimeout(() => {
      qualityDebounceHandle = null;
      requestPipelineRun();
    }, 100);
  });

  /** Decodes + renders `target`, updating pipeline state. `sourceBitmap` is
   * cache-owned by `seeker` — never close it directly; the seeker's LRU
   * eviction handles that. `pin: true` keeps this specific frame exempt from
   * that eviction (see seek.ts) while it's on screen — without it, a
   * background size-estimate or global-palette sample seek elsewhere in the
   * range can evict it out from under a still-running quality pipeline,
   * which was surfacing as a "the image source is detached" resize error on
   * longer videos. */
  async function seekToFrame(target: number) {
    if (!seeker) return;
    try {
      const bitmap = await seeker.seekTo(target, { pin: true });
      sourceBitmap = bitmap;
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

    onFileChange();

    sourceTexture?.destroy();
    sourceTexture = null;
    seeker?.destroy();
    seeker = null;
    sourceBitmap = null;
    currentDemux = null;
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
  <header class="topbar">
    <h1>{title}</h1>
    {#if crossLink}
      <a class="cross-link" href={crossLink.href}>{crossLink.label}</a>
    {/if}
    <div class="topbar-status">
      <p class="gpu-status" class:gpu-failed={gpuFailed} title={gpuStatus}>
        {gpuFailed ? 'GPU unavailable' : 'GPU ready'}
      </p>
      <p class="busy-status" class:idle={$statusText === 'Idle'}>{$statusText}</p>
    </div>
  </header>

  {#if gpuFailed}
    <p class="gpu-blocking">
      This browser can't run the GPU pipeline this tool needs. Try Chrome/Edge, or Safari 17+, with
      hardware acceleration enabled.
    </p>
  {/if}

  {#if !fileName}
    <DropZone on:file={handleFile} disabled={gpuFailed} />
  {:else}
    <div class="file-bar">
      <div class="file-info">
        <span class="file-name">{fileName}</span>
        {#if status}<span class="file-meta">{status}</span>{/if}
      </div>
      <DropZone compact on:file={handleFile} disabled={gpuFailed} />
    </div>
  {/if}
  {#if fileSizeWarning}
    <p class="warning-text">{fileSizeWarning}</p>
  {/if}
  {#if initialLoading}
    <div class="loading-row">
      <span class="spinner" aria-hidden="true"></span>
      <span>Loading video…</span>
    </div>
  {/if}

  {#if seeker}
    <div class="workspace">
      <div class="main-col">
        <slot name="main" />

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
      </div>

      {#if sourceBitmap}
        <aside class="side-col">
          <slot name="side" />
        </aside>
      {/if}
    </div>

    <slot name="debug" {resizeStatus} />
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
    gap: 20px;
    width: 100%;
    max-width: 1400px;
    margin: 0 auto;
    padding: 24px 24px 60px;
    box-sizing: border-box;
  }

  h1 {
    font-size: 1.5rem;
    font-weight: 600;
    letter-spacing: -0.5px;
    color: #e0e0e0;
    margin: 0;
  }

  .topbar {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    align-self: stretch;
  }

  .cross-link {
    font-size: 0.8rem;
    color: #7ec4e0;
    text-decoration: none;
  }

  .cross-link:hover {
    text-decoration: underline;
  }

  .topbar-status {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  .file-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    align-self: stretch;
    max-width: 960px;
  }

  .file-info {
    display: flex;
    align-items: baseline;
    gap: 10px;
    min-width: 0;
    flex-wrap: wrap;
  }

  .file-name {
    font-size: 0.9rem;
    color: #ccc;
    font-weight: 600;
    white-space: nowrap;
  }

  .file-meta {
    font-size: 0.8rem;
    color: #666;
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
    margin: 0;
  }

  .busy-status.idle {
    color: #555;
    border-color: #2a2a2a;
    background: transparent;
  }

  .gpu-status {
    font-size: 0.75rem;
    color: #666;
    margin: 0;
    border: 1px solid #2a2a2a;
    border-radius: 999px;
    padding: 2px 12px;
    cursor: default;
  }

  .gpu-status.gpu-failed {
    color: #e08a8a;
    border-color: #663333;
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

  .workspace {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 320px;
    gap: 24px;
    align-self: stretch;
    align-items: start;
  }

  .main-col {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }

  .side-col {
    display: flex;
    flex-direction: column;
    gap: 16px;
    position: sticky;
    top: 20px;
  }

  @media (max-width: 900px) {
    .workspace {
      grid-template-columns: minmax(0, 1fr);
    }

    .side-col {
      position: static;
    }
  }

  @media (max-width: 700px) {
    main {
      gap: 16px;
      padding: 0 4px 40px;
    }

    .file-bar {
      flex-wrap: wrap;
    }

    .help-fab {
      right: 12px;
      bottom: 12px;
    }
  }
</style>
