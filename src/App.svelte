<script lang="ts">
  import DropZone from './components/DropZone.svelte';
  import { demux } from './lib/demux';
  import { buildKeyframeIndex, createFrameDecoder } from './lib/decode';

  let fileName = '';
  let status = '';
  let canvas: HTMLCanvasElement;

  function drawFrame(frame: VideoFrame) {
    canvas.width = frame.displayWidth;
    canvas.height = frame.displayHeight;
    const ctx = canvas.getContext('2d');
    ctx?.drawImage(frame, 0, 0);
  }

  async function handleFile(e: CustomEvent<File>) {
    const file = e.detail;
    fileName = file.name;
    status = 'demuxing…';

    try {
      const { track, chunks } = await demux(file);
      if (chunks.length === 0) {
        status = 'no frames found';
        return;
      }

      const keyframes = buildKeyframeIndex(chunks);
      status = 'decoding…';

      const frame = await new Promise<VideoFrame>((resolve, reject) => {
        const decoder = createFrameDecoder(
          {
            codec: track.codec,
            codedWidth: track.codedWidth,
            codedHeight: track.codedHeight,
            description: track.description,
          },
          (frame) => {
            decoder.close();
            resolve(frame);
          },
          reject,
        );
        decoder.decode(chunks[0]);
      });

      drawFrame(frame);
      frame.close();
      status = `${track.codedWidth}×${track.codedHeight} · ${track.codec} · ${chunks.length} frames (${keyframes.chunkIndices.length} keyframes)`;
    } catch (err) {
      status = `error: ${(err as Error).message}`;
    }
  }
</script>

<main>
  <h1>gif builder</h1>
  <DropZone on:file={handleFile} />
  {#if fileName}
    <p class="file-name">{fileName}</p>
  {/if}
  {#if status}
    <p class="status">{status}</p>
  {/if}
  <canvas bind:this={canvas} class:hidden={!fileName}></canvas>
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

  .status {
    font-size: 0.85rem;
    color: #666;
  }

  canvas {
    max-width: 90vw;
    border: 1px solid #333;
    border-radius: 4px;
  }

  canvas.hidden {
    display: none;
  }
</style>
