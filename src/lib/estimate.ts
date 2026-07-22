import type { FrameSeeker } from './seek';
import type { QualitySettings } from './quality';
import { computeOutputDims } from './quality';
import { frameToTexture, resize } from './resize';
import { computeHistogram } from './histogram';
import { medianCut } from './palette';
import { quantize } from './quantize';
import { gifHeader } from './gif';
import { EncodeWorkerClient } from './encodeClient';

export interface SizeEstimateResult {
  estimatedBytes: number;
  frameCount: number;
  outputWidth: number;
  outputHeight: number;
  outputDurationSec: number;
}

const MAX_SAMPLES = 8;

export interface EstimateParams {
  device: GPUDevice;
  seeker: FrameSeeker;
  sourceWidth: number;
  sourceHeight: number;
  inPoint: number;
  outPoint: number;
  /** Average source frame duration in microseconds — used as a cheap stand-in for the exact in/out range duration (which would require decoding the whole range). Good enough for an estimate. */
  avgFrameDurationUs: number;
  quality: QualitySettings;
  /** Checked between samples; when aborted, the estimate stops early and returns null rather than finishing a stale run. */
  signal?: AbortSignal;
}

/**
 * Estimates the encoded GIF size by sampling ~8 evenly-spaced frames across
 * the in/out range, running each through the real resize → histogram →
 * palette → quantize → LZW pipeline (the same encode worker export uses),
 * and extrapolating: average compressed bytes/frame × total output frames +
 * header/trailer overhead.
 */
export async function estimateGifSize(params: EstimateParams): Promise<SizeEstimateResult | null> {
  const { device, seeker, sourceWidth, sourceHeight, inPoint, outPoint, avgFrameDurationUs, quality, signal } = params;
  const rangeFrameCount = outPoint - inPoint + 1;
  if (rangeFrameCount <= 0) {
    return { estimatedBytes: 0, frameCount: 0, outputWidth: 0, outputHeight: 0, outputDurationSec: 0 };
  }

  const { targetWidth, fps, dither, loopCount, speed } = quality;
  const totalDurationUs = rangeFrameCount * avgFrameDurationUs;
  const outputIntervalUs = 1_000_000 / fps;
  const outputFrameCount = Math.max(1, Math.round(totalDurationUs / outputIntervalUs) || 1);
  const delayCs = Math.max(1, Math.round(100 / fps / speed));

  const sampleCount = Math.min(MAX_SAMPLES, rangeFrameCount);
  const sampleIndices: number[] = [];
  for (let i = 0; i < sampleCount; i++) {
    const index =
      sampleCount === 1 ? inPoint : Math.round(inPoint + (i * (rangeFrameCount - 1)) / (sampleCount - 1));
    sampleIndices.push(index);
  }

  const { width, height } = computeOutputDims(targetWidth, sourceWidth, sourceHeight);
  const worker = new EncodeWorkerClient();
  try {
    let totalBytes = 0;
    let samplesEncoded = 0;

    for (const sourceIndex of sampleIndices) {
      if (signal?.aborted) return null;

      const bitmap = await seeker.seekTo(sourceIndex);
      const srcTexture = frameToTexture(device, bitmap);
      const { texture: resizedTexture } = resize(device, srcTexture, bitmap.width, bitmap.height, width, height);
      srcTexture.destroy();

      const histogramCounts = await computeHistogram(device, resizedTexture, width, height);
      const palette = medianCut(histogramCounts);
      const indices32 = await quantize(device, resizedTexture, width, height, palette, dither);
      resizedTexture.destroy();

      if (signal?.aborted) return null;

      const indices8 = Uint8Array.from(indices32);
      const ack = await worker.encodeFrame(indices8, palette, delayCs);
      totalBytes += ack.bytesForFrame;
      samplesEncoded++;
    }

    const avgBytesPerFrame = samplesEncoded > 0 ? totalBytes / samplesEncoded : 0;
    const overheadBytes = gifHeader(width, height, loopCount).length + 1; // +1 for GIF_TRAILER
    const estimatedBytes = Math.round(overheadBytes + avgBytesPerFrame * outputFrameCount);
    const outputDurationSec = (outputFrameCount * delayCs) / 100;

    return { estimatedBytes, frameCount: outputFrameCount, outputWidth: width, outputHeight: height, outputDurationSec };
  } finally {
    worker.terminate();
  }
}
