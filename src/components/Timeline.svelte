<script lang="ts">
  import { createEventDispatcher, onDestroy } from 'svelte';

  export let frameCount = 0;
  export let playhead = 0;
  export let inPoint = 0;
  export let outPoint = 0;
  export let getCachedThumbnail: (frameIndex: number) => ImageBitmap | undefined;
  export let loadThumbnails: (frameIndices: number[], thumbWidth?: number) => Promise<void>;
  export let frameDurationUs = 33_000;

  const dispatch = createEventDispatcher<{ seek: number; setIn: number; setOut: number }>();

  const THUMB_DISPLAY_WIDTH = 64;
  const THUMB_DECODE_WIDTH = 160;
  const HANDLE_HIT_PX = 8;
  const DRAG_SEEK_THROTTLE_MS = 40;

  let track: HTMLDivElement;
  let trackWidth = 0;
  let slotFrames: number[] = [];
  let thumbVersion = 0;
  let thumbsLoading = false;

  let dragging: 'playhead' | 'in' | 'out' | null = null;
  let lastDragSeekAt = 0;

  let playDirection: 0 | 1 | -1 = 0;
  let playTimer: ReturnType<typeof setInterval> | null = null;

  const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
  const lastFrame = () => Math.max(0, frameCount - 1);

  $: frameToX = (frame: number) => (frameCount <= 1 ? 0 : (frame / lastFrame()) * trackWidth);
  $: xToFrame = (x: number) => (frameCount <= 1 ? 0 : Math.round(clamp(x / trackWidth, 0, 1) * lastFrame()));

  $: if (trackWidth && frameCount) recomputeSlots();

  function recomputeSlots() {
    const slotCount = Math.max(1, Math.floor(trackWidth / THUMB_DISPLAY_WIDTH));
    const frames: number[] = [];
    for (let i = 0; i < slotCount; i++) {
      frames.push(Math.round((i / Math.max(1, slotCount - 1)) * lastFrame()));
    }
    slotFrames = frames;
    thumbsLoading = true;
    loadThumbnails(frames, THUMB_DECODE_WIDTH)
      .then(() => thumbVersion++)
      .catch((err) => console.error('thumbnail load failed', err))
      .finally(() => {
        thumbsLoading = false;
      });
  }

  function drawThumb(node: HTMLCanvasElement, params: { frame: number; version: number }) {
    function render() {
      const bitmap = getCachedThumbnail(params.frame);
      if (!bitmap) return;
      if (node.width !== bitmap.width || node.height !== bitmap.height) {
        node.width = bitmap.width;
        node.height = bitmap.height;
      }
      node.getContext('2d')?.drawImage(bitmap, 0, 0);
    }
    render();
    return {
      update(newParams: { frame: number; version: number }) {
        params = newParams;
        render();
      },
    };
  }

  function seekAndNotify(frame: number) {
    dispatch('seek', clamp(frame, 0, lastFrame()));
  }

  function hitTestHandle(x: number): 'playhead' | 'in' | 'out' | null {
    if (Math.abs(x - frameToX(playhead)) <= HANDLE_HIT_PX) return 'playhead';
    if (Math.abs(x - frameToX(inPoint)) <= HANDLE_HIT_PX) return 'in';
    if (Math.abs(x - frameToX(outPoint)) <= HANDLE_HIT_PX) return 'out';
    return null;
  }

  function onPointerDown(e: PointerEvent) {
    const rect = track.getBoundingClientRect();
    const x = e.clientX - rect.left;
    dragging = hitTestHandle(x) ?? 'playhead';
    applyDrag(x, true);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging) return;
    const rect = track.getBoundingClientRect();
    applyDrag(e.clientX - rect.left, false);
  }

  function onPointerUp(e: PointerEvent) {
    if (!dragging) return;
    const rect = track.getBoundingClientRect();
    applyDrag(e.clientX - rect.left, true);
    dragging = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
  }

  function applyDrag(x: number, force: boolean) {
    const now = performance.now();
    if (!force && now - lastDragSeekAt < DRAG_SEEK_THROTTLE_MS) return;
    lastDragSeekAt = now;
    const frame = xToFrame(x);
    if (dragging === 'in') {
      dispatch('setIn', Math.min(frame, outPoint));
    } else if (dragging === 'out') {
      dispatch('setOut', Math.max(frame, inPoint));
    } else {
      seekAndNotify(frame);
    }
  }

  function stopPlayback() {
    playDirection = 0;
  }

  function tick() {
    const next = playhead + playDirection;
    if (next < 0 || next > lastFrame()) {
      stopPlayback();
      return;
    }
    seekAndNotify(next);
  }

  $: {
    if (playTimer) clearInterval(playTimer);
    playTimer = playDirection !== 0 ? setInterval(tick, Math.max(16, frameDurationUs / 1000)) : null;
  }

  function isTypingTarget(el: EventTarget | null): boolean {
    if (!(el instanceof HTMLElement)) return false;
    return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
  }

  function onKeydown(e: KeyboardEvent) {
    if (isTypingTarget(e.target) || frameCount === 0) return;
    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault();
        stopPlayback();
        seekAndNotify(playhead - 1);
        break;
      case 'ArrowRight':
        e.preventDefault();
        stopPlayback();
        seekAndNotify(playhead + 1);
        break;
      case 'Home':
        e.preventDefault();
        stopPlayback();
        seekAndNotify(0);
        break;
      case 'End':
        e.preventDefault();
        stopPlayback();
        seekAndNotify(lastFrame());
        break;
      case 'i':
      case 'I':
        e.preventDefault();
        dispatch('setIn', Math.min(playhead, outPoint));
        break;
      case 'o':
      case 'O':
        e.preventDefault();
        dispatch('setOut', Math.max(playhead, inPoint));
        break;
      case 'j':
      case 'J':
        e.preventDefault();
        playDirection = playDirection === -1 ? 0 : -1;
        break;
      case 'k':
      case 'K':
        e.preventDefault();
        stopPlayback();
        break;
      case 'l':
      case 'L':
        e.preventDefault();
        playDirection = playDirection === 1 ? 0 : 1;
        break;
    }
  }

  onDestroy(() => {
    if (playTimer) clearInterval(playTimer);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('keydown', onKeydown);
  });
</script>

<svelte:window on:keydown={onKeydown} />

<div class="timeline">
  <div class="readout">
    <span>frame {playhead + 1} / {frameCount}</span>
    <span class="in-out">in {inPoint + 1} · out {outPoint + 1}</span>
  </div>

  <div
    class="track"
    bind:this={track}
    bind:clientWidth={trackWidth}
    on:pointerdown={onPointerDown}
    role="slider"
    tabindex="0"
    aria-label="Frame scrubber"
    aria-valuemin={0}
    aria-valuemax={lastFrame()}
    aria-valuenow={playhead}
  >
    <div class="thumbs">
      {#each slotFrames as frame, i (i)}
        <canvas class="thumb" use:drawThumb={{ frame, version: thumbVersion }}></canvas>
      {/each}
    </div>

    {#if thumbsLoading}
      <div class="thumb-loading" aria-hidden="true"></div>
    {/if}

    <div
      class="range-dim range-dim-left"
      style="width: {frameToX(inPoint)}px"
    ></div>
    <div
      class="range-dim range-dim-right"
      style="left: {frameToX(outPoint)}px; right: 0"
    ></div>

    <div class="handle in-handle" style="left: {frameToX(inPoint)}px" title="In point (I)"></div>
    <div class="handle out-handle" style="left: {frameToX(outPoint)}px" title="Out point (O)"></div>
    <div class="playhead" style="left: {frameToX(playhead)}px"></div>
  </div>

  <p class="hint">
    click/drag to scrub · ←/→ ±1 frame · Home/End first/last · J/K/L play back/pause/forward ·
    I/O set in/out
  </p>
</div>

<style>
  .timeline {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
    max-width: 960px;
  }

  .readout {
    display: flex;
    justify-content: space-between;
    font-size: 0.75rem;
    color: #888;
  }

  .in-out {
    color: #666;
  }

  .track {
    position: relative;
    height: 56px;
    border: 1px solid #333;
    border-radius: 4px;
    background: #111;
    overflow: hidden;
    cursor: pointer;
    touch-action: none;
  }

  .thumbs {
    position: absolute;
    inset: 0;
    display: flex;
  }

  .thumb {
    flex: 1 1 0;
    height: 100%;
    width: 100%;
    object-fit: cover;
    border-right: 1px solid #1a1a1a;
  }

  .range-dim {
    position: absolute;
    top: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.55);
    pointer-events: none;
  }

  .range-dim-left {
    left: 0;
  }

  .handle {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    background: #e0b84a;
    transform: translateX(-1px);
    pointer-events: none;
  }

  .handle::before {
    content: '';
    position: absolute;
    top: -1px;
    left: -4px;
    width: 10px;
    height: 8px;
    background: #e0b84a;
  }

  .playhead {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    background: #fff;
    transform: translateX(-1px);
    pointer-events: none;
    box-shadow: 0 0 4px rgba(255, 255, 255, 0.6);
  }

  .hint {
    font-size: 0.7rem;
    color: #555;
    margin: 0;
  }

  .thumb-loading {
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent, #7ec4e0, transparent);
    background-size: 50% 100%;
    animation: thumb-sweep 1s ease-in-out infinite;
  }

  @keyframes thumb-sweep {
    0% {
      background-position: -50% 0;
    }
    100% {
      background-position: 150% 0;
    }
  }

  @media (max-width: 600px) {
    .readout {
      flex-wrap: wrap;
      gap: 4px;
    }
  }
</style>
