<script lang="ts">
  import {
    quality,
    RESOLUTION_PRESETS,
    presetWidthFor,
    MIN_BITRATE_KBPS,
    MAX_BITRATE_KBPS,
    MIN_KEYFRAME_INTERVAL_SEC,
    MAX_KEYFRAME_INTERVAL_SEC,
  } from '../lib/quality';

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

  function onSpeedInput(e: Event) {
    const value = Number((e.target as HTMLInputElement).value);
    if (!Number.isFinite(value)) return;
    quality.update((q) => ({ ...q, speed: Math.min(4, Math.max(0.25, value)) }));
  }

  function onBitrateInput(e: Event) {
    const value = Number((e.target as HTMLInputElement).value);
    if (!Number.isFinite(value)) return;
    quality.update((q) => ({ ...q, bitrateKbps: Math.min(MAX_BITRATE_KBPS, Math.max(MIN_BITRATE_KBPS, Math.round(value))) }));
  }

  function onKeyframeIntervalInput(e: Event) {
    const value = Number((e.target as HTMLInputElement).value);
    if (!Number.isFinite(value)) return;
    quality.update((q) => ({
      ...q,
      keyframeIntervalSec: Math.min(MAX_KEYFRAME_INTERVAL_SEC, Math.max(MIN_KEYFRAME_INTERVAL_SEC, value)),
    }));
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
      <input type="range" min="1" max="60" value={$quality.fps} on:input={onFpsInput} />
      <span class="value">{$quality.fps} fps</span>
    </div>

    <div class="row">
      <span class="label">Speed</span>
      <input type="range" min="0.25" max="4" step="0.05" value={$quality.speed} on:input={onSpeedInput} />
      <span class="value">{$quality.speed.toFixed(2)}×</span>
    </div>
  </section>

  <section class="group">
    <h3 class="group-label">VP9 encode</h3>
    <div class="row">
      <span class="label">Bitrate</span>
      <input
        type="range"
        min={MIN_BITRATE_KBPS}
        max={MAX_BITRATE_KBPS}
        step="100"
        value={$quality.bitrateKbps}
        on:input={onBitrateInput}
      />
      <span class="value">{$quality.bitrateKbps} kbps</span>
    </div>

    <div class="row">
      <span class="label">Keyframe every</span>
      <input
        type="number"
        min={MIN_KEYFRAME_INTERVAL_SEC}
        max={MAX_KEYFRAME_INTERVAL_SEC}
        step="0.5"
        value={$quality.keyframeIntervalSec}
        on:change={onKeyframeIntervalInput}
      />
      <span class="unit">seconds</span>
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

  .presets button {
    padding: 3px 10px;
    border: 1px solid #444;
    border-radius: 4px;
    background: #1a1a1a;
    color: #ccc;
    cursor: pointer;
    font-size: 0.8rem;
  }

  .presets button.active {
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
