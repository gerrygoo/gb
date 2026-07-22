/** Default number of frames sampled when a full in/out range is too expensive to process exhaustively (size estimation, global palette). */
export const MAX_RANGE_SAMPLES = 8;

/** Picks up to `maxSamples` frame indices evenly spaced across `[inPoint, outPoint]`, always including both endpoints when more than one sample fits. */
export function sampleIndicesForRange(inPoint: number, outPoint: number, maxSamples: number = MAX_RANGE_SAMPLES): number[] {
  const rangeFrameCount = outPoint - inPoint + 1;
  const sampleCount = Math.min(maxSamples, Math.max(1, rangeFrameCount));
  const indices: number[] = [];
  for (let i = 0; i < sampleCount; i++) {
    const index = sampleCount === 1 ? inPoint : Math.round(inPoint + (i * (rangeFrameCount - 1)) / (sampleCount - 1));
    indices.push(index);
  }
  return indices;
}
