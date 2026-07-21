import resizeShaderCode from './shaders/resize.wgsl?raw';

const KERNEL_RADIUS = 3; // Lanczos-3
const PARAMS_SIZE = 32; // matches ResizeParams struct layout in resize.wgsl
const BYTES_PER_PIXEL = 8; // rgba16float

export interface ResizeOutput {
  texture: GPUTexture;
  width: number;
  height: number;
}

interface ResizePipelines {
  bindGroupLayout: GPUBindGroupLayout;
  horizontal: GPUComputePipeline;
  vertical: GPUComputePipeline;
}

let cached: { device: GPUDevice; pipelines: ResizePipelines } | null = null;

function getPipelines(device: GPUDevice): ResizePipelines {
  if (cached && cached.device === device) {
    return cached.pipelines;
  }

  const module = device.createShaderModule({ code: resizeShaderCode });
  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: { access: 'write-only', format: 'rgba16float' },
      },
    ],
  });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });

  const pipelines: ResizePipelines = {
    bindGroupLayout,
    horizontal: device.createComputePipeline({ layout, compute: { module, entryPoint: 'resizeHorizontal' } }),
    vertical: device.createComputePipeline({ layout, compute: { module, entryPoint: 'resizeVertical' } }),
  };
  cached = { device, pipelines };
  return pipelines;
}

function createParamsBuffer(
  device: GPUDevice,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number,
): GPUBuffer {
  const buffer = device.createBuffer({
    size: PARAMS_SIZE,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const data = new ArrayBuffer(PARAMS_SIZE);
  const view = new DataView(data);
  view.setUint32(0, srcWidth, true);
  view.setUint32(4, srcHeight, true);
  view.setUint32(8, dstWidth, true);
  view.setUint32(12, dstHeight, true);
  view.setFloat32(16, KERNEL_RADIUS, true);
  device.queue.writeBuffer(buffer, 0, data);
  return buffer;
}

/** Uploads a VideoFrame (or ImageBitmap) to a sampleable rgba8unorm source texture. */
export function frameToTexture(device: GPUDevice, source: VideoFrame | ImageBitmap): GPUTexture {
  const width = 'displayWidth' in source ? source.displayWidth : source.width;
  const height = 'displayHeight' in source ? source.displayHeight : source.height;

  const texture = device.createTexture({
    size: [width, height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  device.queue.copyExternalImageToTexture({ source }, { texture }, [width, height]);
  return texture;
}

/** Resizes an rgba8unorm source texture to dstWidth×dstHeight via separable Lanczos-3, returning a new rgba16float texture. */
export function resize(
  device: GPUDevice,
  sourceTexture: GPUTexture,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number,
): ResizeOutput {
  const { bindGroupLayout, horizontal, vertical } = getPipelines(device);

  const intermediateTexture = device.createTexture({
    size: [dstWidth, srcHeight],
    format: 'rgba16float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
  });
  const outputTexture = device.createTexture({
    size: [dstWidth, dstHeight],
    format: 'rgba16float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
  });

  const hParams = createParamsBuffer(device, srcWidth, srcHeight, dstWidth, srcHeight);
  const vParams = createParamsBuffer(device, dstWidth, srcHeight, dstWidth, dstHeight);

  const hBindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: hParams } },
      { binding: 1, resource: sourceTexture.createView() },
      { binding: 2, resource: intermediateTexture.createView() },
    ],
  });
  const vBindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: vParams } },
      { binding: 1, resource: intermediateTexture.createView() },
      { binding: 2, resource: outputTexture.createView() },
    ],
  });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();

  pass.setPipeline(horizontal);
  pass.setBindGroup(0, hBindGroup);
  pass.dispatchWorkgroups(Math.ceil(dstWidth / 8), Math.ceil(srcHeight / 8));

  pass.setPipeline(vertical);
  pass.setBindGroup(0, vBindGroup);
  pass.dispatchWorkgroups(Math.ceil(dstWidth / 8), Math.ceil(dstHeight / 8));

  pass.end();
  device.queue.submit([encoder.finish()]);

  hParams.destroy();
  vParams.destroy();
  intermediateTexture.destroy();

  return { texture: outputTexture, width: dstWidth, height: dstHeight };
}

// IEEE 754 half-precision → JS number. Readback buffers come back as raw
// rgba16float bytes; there's no browser-universal typed array for that yet.
function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exponent = (h >> 10) & 0x1f;
  const fraction = h & 0x3ff;

  if (exponent === 0) {
    return sign * Math.pow(2, -14) * (fraction / 1024);
  }
  if (exponent === 0x1f) {
    return fraction ? NaN : sign * Infinity;
  }
  return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
}

/** Reads an rgba16float texture back to the CPU as displayable 8-bit ImageData. */
export async function textureToImageData(
  device: GPUDevice,
  texture: GPUTexture,
  width: number,
  height: number,
): Promise<ImageData> {
  const unpaddedBytesPerRow = width * BYTES_PER_PIXEL;
  const bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;
  const bufferSize = bytesPerRow * height;

  const readbackBuffer = device.createBuffer({
    size: bufferSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer: readbackBuffer, bytesPerRow, rowsPerImage: height }, {
    width,
    height,
  });
  device.queue.submit([encoder.finish()]);

  await readbackBuffer.mapAsync(GPUMapMode.READ);
  const raw = new Uint16Array(readbackBuffer.getMappedRange().slice(0));
  readbackBuffer.unmap();
  readbackBuffer.destroy();

  const rgba = new Uint8ClampedArray(width * height * 4);
  const uint16PerRow = bytesPerRow / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const srcIdx = y * uint16PerRow + x * 4;
      const dstIdx = (y * width + x) * 4;
      rgba[dstIdx] = Math.round(halfToFloat(raw[srcIdx]) * 255);
      rgba[dstIdx + 1] = Math.round(halfToFloat(raw[srcIdx + 1]) * 255);
      rgba[dstIdx + 2] = Math.round(halfToFloat(raw[srcIdx + 2]) * 255);
      rgba[dstIdx + 3] = Math.round(halfToFloat(raw[srcIdx + 3]) * 255);
    }
  }

  return new ImageData(rgba, width, height);
}
