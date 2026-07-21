import quantizeShaderCode from './shaders/quantize.wgsl?raw';
import { BLUE_NOISE_BASE64, BLUE_NOISE_SIZE } from './blueNoise';
import { PALETTE_SIZE } from './palette';

interface QuantizePipeline {
  bindGroupLayout: GPUBindGroupLayout;
  pipeline: GPUComputePipeline;
}

let cachedPipeline: { device: GPUDevice; pipeline: QuantizePipeline } | null = null;
let cachedNoiseTexture: { device: GPUDevice; texture: GPUTexture } | null = null;

function getPipeline(device: GPUDevice): QuantizePipeline {
  if (cachedPipeline && cachedPipeline.device === device) {
    return cachedPipeline.pipeline;
  }

  const module = device.createShaderModule({ code: quantizeShaderCode });
  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    ],
  });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
  const pipeline = device.createComputePipeline({ layout, compute: { module, entryPoint: 'main' } });

  const result: QuantizePipeline = { bindGroupLayout, pipeline };
  cachedPipeline = { device, pipeline: result };
  return result;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Uploads the baked blue-noise constant to an r8unorm texture, cached per device. */
function getBlueNoiseTexture(device: GPUDevice): GPUTexture {
  if (cachedNoiseTexture && cachedNoiseTexture.device === device) {
    return cachedNoiseTexture.texture;
  }

  const bytes = base64ToBytes(BLUE_NOISE_BASE64);
  const texture = device.createTexture({
    size: [BLUE_NOISE_SIZE, BLUE_NOISE_SIZE],
    format: 'r8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture },
    bytes,
    { bytesPerRow: BLUE_NOISE_SIZE },
    { width: BLUE_NOISE_SIZE, height: BLUE_NOISE_SIZE },
  );

  cachedNoiseTexture = { device, texture };
  return texture;
}

/** Normalizes an 8-bit RGB palette (256×3, 0–255) to a vec4<f32> storage buffer (0–1, alpha unused) for GPU upload. */
function createPaletteBuffer(device: GPUDevice, palette: Uint8Array): GPUBuffer {
  const data = new Float32Array(PALETTE_SIZE * 4);
  for (let i = 0; i < PALETTE_SIZE; i++) {
    data[i * 4] = palette[i * 3] / 255;
    data[i * 4 + 1] = palette[i * 3 + 1] / 255;
    data[i * 4 + 2] = palette[i * 3 + 2] / 255;
    data[i * 4 + 3] = 0;
  }
  const buffer = device.createBuffer({
    size: data.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buffer, 0, data);
  return buffer;
}

/** Uploads the dither-enabled flag as a 16-byte-aligned uniform buffer (WGSL host-shareable struct rule). */
function createParamsBuffer(device: GPUDevice, ditherEnabled: boolean): GPUBuffer {
  const buffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buffer, 0, new Uint32Array([ditherEnabled ? 1 : 0, 0, 0, 0]));
  return buffer;
}

/** Quantizes an rgba16float `texture` against `palette`, optionally with blue-noise dither, returning one palette index per pixel. */
export async function quantize(
  device: GPUDevice,
  texture: GPUTexture,
  width: number,
  height: number,
  palette: Uint8Array,
  ditherEnabled = true,
): Promise<Uint32Array> {
  const { bindGroupLayout, pipeline } = getPipeline(device);
  const noiseTexture = getBlueNoiseTexture(device);
  const paletteBuffer = createPaletteBuffer(device, palette);
  const paramsBuffer = createParamsBuffer(device, ditherEnabled);

  const pixelCount = width * height;
  const bufferSize = pixelCount * Uint32Array.BYTES_PER_ELEMENT;

  const outBuffer = device.createBuffer({
    size: bufferSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readbackBuffer = device.createBuffer({
    size: bufferSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: texture.createView() },
      { binding: 1, resource: noiseTexture.createView() },
      { binding: 2, resource: { buffer: paletteBuffer } },
      { binding: 3, resource: { buffer: outBuffer } },
      { binding: 4, resource: { buffer: paramsBuffer } },
    ],
  });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
  pass.end();
  encoder.copyBufferToBuffer(outBuffer, 0, readbackBuffer, 0, bufferSize);
  device.queue.submit([encoder.finish()]);

  await readbackBuffer.mapAsync(GPUMapMode.READ);
  const result = new Uint32Array(readbackBuffer.getMappedRange().slice(0));
  readbackBuffer.unmap();

  paletteBuffer.destroy();
  paramsBuffer.destroy();
  outBuffer.destroy();
  readbackBuffer.destroy();

  return result;
}

/** Reconstructs displayable RGBA ImageData from palette indices — the CPU side of the "readback → reconstruct" step. */
export function indicesToImageData(
  indices: Uint32Array,
  palette: Uint8Array,
  width: number,
  height: number,
): ImageData {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i];
    rgba[i * 4] = palette[idx * 3];
    rgba[i * 4 + 1] = palette[idx * 3 + 1];
    rgba[i * 4 + 2] = palette[idx * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }
  return new ImageData(rgba, width, height);
}
