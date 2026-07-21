<script lang="ts">
  import { quality, RESOLUTION_PRESETS, presetWidthFor } from '../lib/quality';

  export let sourceWidth = 0;
  export let sourceHeight = 0;

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

  function toggleDither() {
    quality.update((q) => ({ ...q, dither: !q.dither }));
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
    <span class="label">Dither</span>
    <button class="toggle" class:active={$quality.dither} on:click={toggleDither}>
      {$quality.dither ? 'Blue-noise' : 'None'}
    </button>
  </div>

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

  <div class="row">
    <span class="label">Speed</span>
    <input type="range" min="0.25" max="4" step="0.05" value={$quality.speed} on:input={onSpeedInput} />
    <span class="value">{$quality.speed.toFixed(2)}×</span>
  </div>
</div>

<style>
  .quality-panel {
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: 100%;
    max-width: 480px;
    padding: 12px 16px;
    border: 1px solid #333;
    border-radius: 6px;
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
</style>
