import type { FrameSeeker } from './seek';
import type { ColorSpace } from './palette';
import { frameToTexture, resize } from './resize';
import { computeHistogram, HISTOGRAM_BIN_COUNT } from './histogram';
import { medianCut } from './palette';
import { sampleIndicesForRange } from './sampling';

export interface GlobalPaletteParams {
  device: GPUDevice;
  seeker: FrameSeeker;
  inPoint: number;
  outPoint: number;
  outputWidth: number;
  outputHeight: number;
  paletteSize: number;
  colorSpace: ColorSpace;
  /** Checked between samples; when aborted, returns whatever palette the samples gathered so far would produce (never throws) — callers that need to bail out entirely should check the signal themselves before using the result. */
  signal?: AbortSignal;
}

/**
 * Builds one shared palette (q5) from a histogram accumulated across ~8
 * frames sampled evenly from the in/out range, mirroring estimate.ts's
 * sampling strategy — trades per-scene color accuracy for temporal
 * coherence (less flicker) across the whole export.
 */
export async function computeGlobalPalette(params: GlobalPaletteParams): Promise<Uint8Array> {
  const { device, seeker, inPoint, outPoint, outputWidth, outputHeight, paletteSize, colorSpace, signal } = params;
  const sampleIndices = sampleIndicesForRange(inPoint, outPoint);

  const combined = new Uint32Array(HISTOGRAM_BIN_COUNT);
  for (const sourceIndex of sampleIndices) {
    if (signal?.aborted) break;

    const bitmap = await seeker.seekTo(sourceIndex);
    const srcTexture = frameToTexture(device, bitmap);
    const { texture } = resize(device, srcTexture, bitmap.width, bitmap.height, outputWidth, outputHeight);
    srcTexture.destroy();

    const counts = await computeHistogram(device, texture, outputWidth, outputHeight, colorSpace);
    texture.destroy();

    for (let i = 0; i < combined.length; i++) combined[i] += counts[i];
  }

  return medianCut(combined, paletteSize, colorSpace);
}
