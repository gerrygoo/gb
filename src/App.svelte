<script lang="ts">
  import { onMount } from 'svelte';
  import DropZone from './components/DropZone.svelte';
  import { demux } from './lib/demux';
  import { buildKeyframeIndex, createFrameDecoder } from './lib/decode';
  import { initGPU, setGPUContext, runTestShader } from './lib/gpu';

  let fileName = '';
  let status = '';
  let canvas: HTMLCanvasElement;
  let gpuStatus = 'initializing…';

  // Called synchronously during component init so setContext is legal;
  // descendants await this promise to get the resolved device.
  const gpuContext = initGPU();
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
    } catch (err) {
      gpuStatus = `WebGPU unavailable: ${(err as Error).message}`;
    }
  });

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
  <p class="gpu-status">{gpuStatus}</p>
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

  .gpu-status {
    font-size: 0.75rem;
    color: #666;
    text-align: center;
    max-width: 480px;
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
