<script lang="ts">
  import { quality, RESOLUTION_PRESETS, presetWidthFor, MIN_PALETTE_SIZE, MAX_PALETTE_SIZE } from '../lib/quality';
  import type { DitherMode } from '../lib/quantize';
  import type { ColorSpace } from '../lib/palette';

  export let sourceWidth = 0;
  export let sourceHeight = 0;

  const DITHER_MODES: { mode: DitherMode; label: string }[] = [
    { mode: 'none', label: 'None' },
    { mode: 'blue-noise', label: 'Blue-noise' },
    { mode: 'bayer', label: 'Bayer' },
  ];

  const COLOR_SPACES: { mode: ColorSpace; label: string }[] = [
    { mode: 'srgb', label: 'sRGB' },
    { mode: 'linear', label: 'Linear' },
  ];

  $: outputHeight =
    sourceWidth && sourceHeight
      ? Math.max(2, Math.round(($quality.targetWidth * sourceHeight) / sourceWidth / 2) * 2)
      : 0;

  $: activePreset =
    RESOLUTION_PRESETS.find((h) => presetWidthFor(h, sourceWidth, sourceHeight) === $quality.targetWidth) ?? null;

  function setPreset(presetHeight: number) {
    quality.update((q) => ({ ...q, targetWidth: presetWidthFor(presetHeight, sourceWidth, sourceHeight) }));
  }

  function onWidthInput(e: Event) {
    const value = Number((e.target as HTMLInputElement).value);
    if (!Number.isFinite(value) || value <= 0) return;
    quality.update((q) => ({ ...q, targetWidth: Math.max(2, Math.round(value / 2) * 2) }));
  }

  function onFpsInput(e: Event) {
    const value = Number((e.target as HTMLInputElement).value);
    if (!Number.isFinite(value)) return;
    quality.update((q) => ({ ...q, fps: Math.min(60, Math.max(1, Math.round(value))) }));
  }

  function setDitherMode(mode: DitherMode) {
    quality.update((q) => ({ ...q, dither: mode }));
  }

  function setColorSpace(mode: ColorSpace) {
    quality.update((q) => ({ ...q, colorSpace: mode }));
  }

  function onPaletteSizeInput(e: Event) {
    const value = Number((e.target as HTMLInputElement).value);
    if (!Number.isFinite(value)) return;
    quality.update((q) => ({ ...q, paletteSize: Math.min(MAX_PALETTE_SIZE, Math.max(MIN_PALETTE_SIZE, Math.round(value))) }));
  }

  function toggleGlobalPalette() {
    quality.update((q) => ({ ...q, globalPalette: !q.globalPalette }));
  }

  type LoopMode = 'infinite' | 'once' | 'n';
  $: loopMode = ($quality.loopCount === 0 ? 'infinite' : $quality.loopCount === 1 ? 'once' : 'n') as LoopMode;

  function setLoopMode(mode: LoopMode) {
    quality.update((q) => ({
      ...q,
      loopCount: mode === 'infinite' ? 0 : mode === 'once' ? 1 : Math.max(2, q.loopCount || 2),
    }));
  }

  function onLoopNInput(e: Event) {
    const value = Math.max(1, Math.round(Number((e.target as HTMLInputElement).value) || 1));
    quality.update((q) => ({ ...q, loopCount: value }));
  }

  function onSpeedInput(e: Event) {
    const value = Number((e.target as HTMLInputElement).value);
    if (!Number.isFinite(value)) return;
    quality.update((q) => ({ ...q, speed: Math.min(4, Math.max(0.25, value)) }));
  }
</script>

<div class="quality-panel">
  <section class="group">
    <h3 class="group-label">Output</h3>
    <div class="row">
      <span class="label">Resolution</span>
      <div class="presets">
        {#each RESOLUTION_PRESETS as presetHeight}
          <button class:active={activePreset === presetHeight} on:click={() => setPreset(presetHeight)}>
            {presetHeight}p
          </button>
        {/each}
      </div>
      <label class="field">
        <input type="number" min="2" step="2" value={$quality.targetWidth} on:change={onWidthInput} />
        <span class="unit">× {outputHeight}px</span>
      </label>
    </div>

    <div class="row">
      <span class="label">Output FPS</span>
      <input
        type="range"
        min="1"
        max="60"
        value={$quality.fps}
        on:input={onFpsInput}
      />
      <span class="value">{$quality.fps} fps</span>
    </div>

    <div class="row">
      <span class="label">Speed</span>
      <input type="range" min="0.25" max="4" step="0.05" value={$quality.speed} on:input={onSpeedInput} />
      <span class="value">{$quality.speed.toFixed(2)}×</span>
    </div>
  </section>

  <section class="group">
    <h3 class="group-label">Color</h3>
    <div class="row">
      <span class="label">Palette size</span>
      <input
        type="range"
        min={MIN_PALETTE_SIZE}
        max={MAX_PALETTE_SIZE}
        value={$quality.paletteSize}
        on:input={onPaletteSizeInput}
      />
      <span class="value">{$quality.paletteSize} colors</span>
    </div>

    <div class="row">
      <span class="label">Palette scope</span>
      <button class="toggle" class:active={$quality.globalPalette} on:click={toggleGlobalPalette}>
        {$quality.globalPalette ? 'Global' : 'Per-frame'}
      </button>
    </div>

    <div class="row">
      <span class="label">Dither</span>
      <div class="presets">
        {#each DITHER_MODES as { mode, label }}
          <button class:active={$quality.dither === mode} on:click={() => setDitherMode(mode)}>{label}</button>
        {/each}
      </div>
    </div>

    <div class="row">
      <span class="label">Color space</span>
      <div class="presets">
        {#each COLOR_SPACES as { mode, label }}
          <button class:active={$quality.colorSpace === mode} on:click={() => setColorSpace(mode)}>{label}</button>
        {/each}
      </div>
    </div>
  </section>

  <section class="group">
    <h3 class="group-label">Playback</h3>
    <div class="row">
      <span class="label">Loop</span>
      <div class="presets">
        <button class:active={loopMode === 'infinite'} on:click={() => setLoopMode('infinite')}>Infinite</button>
        <button class:active={loopMode === 'once'} on:click={() => setLoopMode('once')}>1×</button>
        <button class:active={loopMode === 'n'} on:click={() => setLoopMode('n')}>N×</button>
      </div>
      {#if loopMode === 'n'}
        <input type="number" min="1" step="1" value={$quality.loopCount} on:change={onLoopNInput} />
      {/if}
    </div>
  </section>
</div>

<style>
  .quality-panel {
    display: flex;
    flex-direction: column;
    gap: 16px;
    width: 100%;
    padding: 14px 16px;
    border: 1px solid #333;
    border-radius: 6px;
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .group + .group {
    padding-top: 14px;
    border-top: 1px solid #262626;
  }

  .group-label {
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: #666;
    margin: 0;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  .label {
    font-size: 0.8rem;
    color: #888;
    width: 84px;
    flex-shrink: 0;
  }

  .value {
    font-size: 0.8rem;
    color: #ccc;
    min-width: 56px;
  }

  .presets {
    display: flex;
    gap: 6px;
  }

  .presets button,
  .toggle {
    padding: 3px 10px;
    border: 1px solid #444;
    border-radius: 4px;
    background: #1a1a1a;
    color: #ccc;
    cursor: pointer;
    font-size: 0.8rem;
  }

  .presets button.active,
  .toggle.active {
    border-color: #888;
    color: #fff;
  }

  .field {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  input[type='number'] {
    width: 64px;
    padding: 3px 6px;
    border: 1px solid #444;
    border-radius: 4px;
    background: #1a1a1a;
    color: #ccc;
    font-size: 0.8rem;
  }

  input[type='range'] {
    flex: 1;
    min-width: 100px;
  }

  .unit {
    font-size: 0.8rem;
    color: #888;
  }

  @media (max-width: 480px) {
    .quality-panel {
      padding: 10px 12px;
    }

    .label {
      width: auto;
    }

    input[type='range'] {
      min-width: 0;
      flex-basis: 100%;
    }
  }
</style>
