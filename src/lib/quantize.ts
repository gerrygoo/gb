import quantizeShaderCode from './shaders/quantize.wgsl?raw';
import { BLUE_NOISE_BASE64, BLUE_NOISE_SIZE } from './blueNoise';
import { srgbToLinear, type ColorSpace } from './palette';

export type DitherMode = 'none' | 'blue-noise' | 'bayer';

const DITHER_MODE_CODES: Record<DitherMode, number> = { none: 0, 'blue-noise': 1, bayer: 2 };

export interface QuantizeOptions {
  ditherMode?: DitherMode;
  colorSpace?: ColorSpace;
}

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

/** Normalizes an 8-bit RGB palette (N×3, 0–255, always sRGB bytes — see palette.ts) to a vec4<f32> storage buffer for GPU upload, in the given working color space. Converting to linear here (once per palette entry) rather than per pixel-loop-iteration in the shader is cheaper when the palette is much smaller than the pixel count, which it always is. */
function createPaletteBuffer(device: GPUDevice, palette: Uint8Array, colorSpace: ColorSpace): GPUBuffer {
  const colorCount = palette.length / 3;
  const data = new Float32Array(colorCount * 4);
  for (let i = 0; i < colorCount; i++) {
    let r = palette[i * 3] / 255;
    let g = palette[i * 3 + 1] / 255;
    let b = palette[i * 3 + 2] / 255;
    if (colorSpace === 'linear') {
      r = srgbToLinear(r);
      g = srgbToLinear(g);
      b = srgbToLinear(b);
    }
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 0;
  }
  const buffer = device.createBuffer({
    size: data.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buffer, 0, data);
  return buffer;
}

/** Uploads dither mode, color space, and palette size as a 16-byte-aligned uniform buffer (WGSL host-shareable struct rule). */
function createParamsBuffer(device: GPUDevice, ditherMode: DitherMode, colorSpace: ColorSpace, colorCount: number): GPUBuffer {
  const buffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(
    buffer,
    0,
    new Uint32Array([DITHER_MODE_CODES[ditherMode], colorSpace === 'linear' ? 1 : 0, colorCount, 0]),
  );
  return buffer;
}

/** Quantizes an rgba16float `texture` against `palette`, optionally with dither, returning one palette index per pixel. */
export async function quantize(
  device: GPUDevice,
  texture: GPUTexture,
  width: number,
  height: number,
  palette: Uint8Array,
  options: QuantizeOptions = {},
): Promise<Uint32Array> {
  const { ditherMode = 'blue-noise', colorSpace = 'srgb' } = options;
  const colorCount = palette.length / 3;
  const { bindGroupLayout, pipeline } = getPipeline(device);
  const noiseTexture = getBlueNoiseTexture(device);
  const paletteBuffer = createPaletteBuffer(device, palette, colorSpace);
  const paramsBuffer = createParamsBuffer(device, ditherMode, colorSpace, colorCount);

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
