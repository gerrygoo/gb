import { getContext, setContext } from 'svelte';
import testFillShader from './shaders/testFill.wgsl?raw';

export interface GPUContext {
  adapter: GPUAdapter;
  device: GPUDevice;
}

const GPU_CONTEXT_KEY = Symbol('gpu');

/** Requests an adapter + device. Throws with a browser-facing message on failure. */
export async function initGPU(): Promise<GPUContext> {
  if (!navigator.gpu) {
    throw new Error(
      'WebGPU is not available in this browser. Use Chrome/Edge, or Safari 17+.',
    );
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new Error('No WebGPU adapter found (GPU or driver may be unsupported).');
  }

  const device = await adapter.requestDevice();
  device.lost.then((info) => {
    console.error(`WebGPU device lost: ${info.message}`);
  });

  return { adapter, device };
}

/** Registers the (pending) GPU context so descendant components can read it via getGPUContext(). */
export function setGPUContext(context: Promise<GPUContext>) {
  setContext(GPU_CONTEXT_KEY, context);
}

export function getGPUContext(): Promise<GPUContext> {
  return getContext(GPU_CONTEXT_KEY);
}

/** Dispatches the test-fill shader over `count` threads and reads the result back to the CPU. */
export async function runTestShader(device: GPUDevice, count: number): Promise<Uint32Array> {
  const bufferSize = count * Uint32Array.BYTES_PER_ELEMENT;

  const storageBuffer = device.createBuffer({
    size: bufferSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });

  const readbackBuffer = device.createBuffer({
    size: bufferSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const module = device.createShaderModule({ code: testFillShader });
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  });

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: storageBuffer } }],
  });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(Math.ceil(count / 64));
  pass.end();
  encoder.copyBufferToBuffer(storageBuffer, 0, readbackBuffer, 0, bufferSize);
  device.queue.submit([encoder.finish()]);

  await readbackBuffer.mapAsync(GPUMapMode.READ);
  const result = new Uint32Array(readbackBuffer.getMappedRange().slice(0));
  readbackBuffer.unmap();

  storageBuffer.destroy();
  readbackBuffer.destroy();

  return result;
}
