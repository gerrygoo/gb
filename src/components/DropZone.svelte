<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  const dispatch = createEventDispatcher<{ file: File }>();

  let dragging = false;

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    dragging = true;
  }

  function handleDragLeave() {
    dragging = false;
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    const file = e.dataTransfer?.files[0];
    if (file && file.type.startsWith('video/')) {
      console.log('dropped file:', file.name);
      dispatch('file', file);
    }
  }

  function handleInput(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) {
      console.log('selected file:', file.name);
      dispatch('file', file);
    }
  }
</script>

<label
  class="drop-zone"
  class:dragging
  on:dragover={handleDragOver}
  on:dragleave={handleDragLeave}
  on:drop={handleDrop}
>
  <input type="file" accept="video/*" on:change={handleInput} />
  <span class="icon">🎬</span>
  <p>Drop a video file here</p>
  <p class="sub">or click to browse</p>
</label>

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
</style>
