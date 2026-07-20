<script lang="ts">
  import DropZone from './components/DropZone.svelte';

  let fileName = '';

  function handleFile(e: CustomEvent<File>) {
    fileName = e.detail.name;
  }
</script>

<main>
  <h1>gif builder</h1>
  <DropZone on:file={handleFile} />
  {#if fileName}
    <p class="file-name">{fileName}</p>
  {/if}
</main>

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
</style>
