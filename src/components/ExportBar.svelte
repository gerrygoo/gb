<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { formatBytes } from '../lib/format';

  export let exporting = false;
  export let disabled = false;
  export let progress: { current: number; total: number } | null = null;
  export let statusText = '';
  export let error: string | null = null;
  export let downloadUrl: string | null = null;
  export let downloadFilename = 'animation.gif';
  export let downloadBytes: number | null = null;

  const dispatch = createEventDispatcher<{ encode: void; cancel: void }>();

  $: percent = progress && progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;
</script>

<div class="export-bar">
  <div class="row">
    <button class="primary" on:click={() => dispatch('encode')} disabled={exporting || disabled}>
      {exporting ? 'Encoding…' : 'Export animated GIF'}
    </button>
    {#if exporting}
      <button class="cancel" on:click={() => dispatch('cancel')}>Cancel</button>
    {/if}
  </div>

  {#if exporting}
    <div class="progress-track">
      <div class="progress-fill" style="width: {percent}%"></div>
    </div>
    <p class="status">{statusText || `${percent}%`}</p>
  {:else if statusText}
    <p class="status">{statusText}</p>
  {/if}

  {#if error}
    <p class="error">{error}</p>
  {/if}

  {#if downloadUrl}
    <a class="download-link" href={downloadUrl} download={downloadFilename}>
      Download {downloadFilename}{downloadBytes != null ? ` — ${formatBytes(downloadBytes)}` : ''}
    </a>
  {/if}
</div>

<style>
  .export-bar {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
    max-width: 480px;
  }

  .row {
    display: flex;
    gap: 8px;
  }

  button {
    padding: 6px 14px;
    border: 1px solid #444;
    border-radius: 4px;
    background: #1a1a1a;
    color: #ccc;
    cursor: pointer;
    font-size: 0.85rem;
  }

  button:disabled {
    opacity: 0.4;
    cursor: default;
  }

  button.primary {
    border-color: #2c6a94;
    background: #2a6ca8;
    color: #fff;
    font-weight: 600;
  }

  button.primary:hover:not(:disabled) {
    background: #3480c4;
  }

  button.cancel {
    border-color: #663333;
    color: #e08a8a;
  }

  .progress-track {
    height: 6px;
    border-radius: 3px;
    background: #262626;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: #4a9ce0;
    transition: width 120ms ease-out;
  }

  .status {
    font-size: 0.8rem;
    color: #888;
    margin: 0;
  }

  .error {
    font-size: 0.8rem;
    color: #e08a8a;
    margin: 0;
  }

  .download-link {
    align-self: flex-start;
    font-size: 0.85rem;
    color: #7ec4e0;
    text-decoration: none;
    border: 1px solid #2c4a5a;
    border-radius: 4px;
    padding: 5px 12px;
    background: rgba(126, 196, 224, 0.08);
  }

  .download-link:hover {
    text-decoration: underline;
  }
</style>
