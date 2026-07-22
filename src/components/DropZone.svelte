<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  export let disabled = false;

  const dispatch = createEventDispatcher<{ file: File }>();

  let dragging = false;
  let errorMessage: string | null = null;

  function handleDragOver(e: DragEvent) {
    if (disabled) return;
    e.preventDefault();
    dragging = true;
  }

  function handleDragLeave() {
    dragging = false;
  }

  function acceptFile(file: File | null | undefined) {
    if (!file) return;
    if (!file.type.startsWith('video/')) {
      errorMessage = `"${file.name}" doesn't look like a video file (got "${file.type || 'unknown type'}"). Drop an MP4 or MOV.`;
      return;
    }
    errorMessage = null;
    dispatch('file', file);
  }

  function handleDrop(e: DragEvent) {
    if (disabled) return;
    e.preventDefault();
    dragging = false;
    acceptFile(e.dataTransfer?.files[0]);
  }

  function handleInput(e: Event) {
    acceptFile((e.target as HTMLInputElement).files?.[0]);
  }
</script>

<label
  class="drop-zone"
  class:dragging
  class:disabled
  on:dragover={handleDragOver}
  on:dragleave={handleDragLeave}
  on:drop={handleDrop}
>
  <input type="file" accept="video/*" on:change={handleInput} {disabled} />
  <span class="icon">🎬</span>
  <p>{disabled ? 'Video import unavailable' : 'Drop a video file here'}</p>
  {#if !disabled}
    <p class="sub">or click to browse</p>
  {/if}
</label>
{#if errorMessage}
  <p class="drop-error">{errorMessage}</p>
{/if}

<style>
  .drop-zone {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 400px;
    height: 240px;
    border: 2px dashed #444;
    border-radius: 12px;
    cursor: pointer;
    transition: border-color 0.2s, background 0.2s;
    padding: 24px;
  }

  .drop-zone:hover,
  .drop-zone.dragging {
    border-color: #888;
    background: rgba(255, 255, 255, 0.04);
  }

  .drop-zone.disabled {
    cursor: default;
    opacity: 0.5;
  }

  .drop-zone.disabled:hover {
    border-color: #444;
    background: none;
  }

  input[type='file'] {
    display: none;
  }

  .icon {
    font-size: 48px;
  }

  p {
    font-size: 1rem;
    color: #aaa;
  }

  .sub {
    font-size: 0.8rem;
    color: #666;
  }

  .drop-error {
    font-size: 0.8rem;
    color: #e08a8a;
    max-width: 400px;
    text-align: center;
  }

  @media (max-width: 480px) {
    .drop-zone {
      width: min(400px, 90vw);
      height: 180px;
      padding: 16px;
    }

    .icon {
      font-size: 36px;
    }
  }
</style>
