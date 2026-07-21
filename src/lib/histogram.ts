import histogramShaderCode from './shaders/histogram.wgsl?raw';

export const BINS_PER_CHANNEL = 32;
export const HISTOGRAM_BIN_COUNT = BINS_PER_CHANNEL ** 3; // 32768
const BIN_BYTES = HISTOGRAM_BIN_COUNT * Uint32Array.BYTES_PER_ELEMENT;

interface HistogramPipeline {
  bindGroupLayout: GPUBindGroupLayout;
  pipeline: GPUComputePipeline;
}

let cached: { device: GPUDevice; pipeline: HistogramPipeline } | null = null;

function getPipeline(device: GPUDevice): HistogramPipeline {
  if (cached && cached.device === device) {
    return cached.pipeline;
  }

  const module = device.createShaderModule({ code: histogramShaderCode });
  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ],
  });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
  const pipeline = device.createComputePipeline({ layout, compute: { module, entryPoint: 'main' } });

  const pipelines: HistogramPipeline = { bindGroupLayout, pipeline };
  cached = { device, pipeline: pipelines };
  return pipelines;
}

/** Computes a 32×32×32 RGB histogram over `texture` and reads the bin counts back to the CPU. */
export async function computeHistogram(
  device: GPUDevice,
  texture: GPUTexture,
  width: number,
  height: number,
): Promise<Uint32Array> {
  const { bindGroupLayout, pipeline } = getPipeline(device);

  // Freshly created storage buffers are zero-initialized by WebGPU, so no
  // separate clear pass is needed before the dispatch.
  const histogramBuffer = device.createBuffer({
    size: BIN_BYTES,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readbackBuffer = device.createBuffer({
    size: BIN_BYTES,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: texture.createView() },
      { binding: 1, resource: { buffer: histogramBuffer } },
    ],
  });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
  pass.end();
  encoder.copyBufferToBuffer(histogramBuffer, 0, readbackBuffer, 0, BIN_BYTES);
  device.queue.submit([encoder.finish()]);

  await readbackBuffer.mapAsync(GPUMapMode.READ);
  const result = new Uint32Array(readbackBuffer.getMappedRange().slice(0));
  readbackBuffer.unmap();

  histogramBuffer.destroy();
  readbackBuffer.destroy();

  return result;
}
