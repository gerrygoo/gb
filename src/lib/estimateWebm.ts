import type { QualitySettings } from './quality';
import { computeOutputDims } from './quality';

export interface WebmSizeEstimateResult {
  estimatedBytes: number;
  frameCount: number;
  outputWidth: number;
  outputHeight: number;
  outputDurationSec: number;
}

/** Rough constant for WebM/Matroska container + track-header overhead — a
 * single-track file's segment/track/cue metadata is small and roughly fixed
 * regardless of duration, unlike GIF's per-frame overhead. */
const MUX_OVERHEAD_BYTES = 500;

export interface WebmEstimateParams {
  sourceWidth: number;
  sourceHeight: number;
  inPoint: number;
  outPoint: number;
  /** Average source frame duration in microseconds — same cheap stand-in `estimateGifSize` uses instead of decoding the exact range. */
  avgFrameDurationUs: number;
  quality: QualitySettings;
}

/**
 * Estimates the exported WebM's size directly from the target bitrate:
 * `bitrate_kbps * duration_s / 8 * 1000` plus a fixed muxer-overhead
 * constant. Unlike GIF's `estimateGifSize`, VP9 is a genuine bitrate-target
 * codec, so no sampling/encode pass is needed — the bitrate slider already
 * *is* the size knob.
 */
export function estimateWebmSize(params: WebmEstimateParams): WebmSizeEstimateResult {
  const { sourceWidth, sourceHeight, inPoint, outPoint, avgFrameDurationUs, quality } = params;
  const rangeFrameCount = outPoint - inPoint + 1;
  if (rangeFrameCount <= 0 || !sourceWidth || !sourceHeight) {
    return { estimatedBytes: 0, frameCount: 0, outputWidth: 0, outputHeight: 0, outputDurationSec: 0 };
  }

  const { targetWidth, fps, speed, bitrateKbps } = quality;
  const { width, height } = computeOutputDims(targetWidth, sourceWidth, sourceHeight);

  // Same output-timeline math as WebmApp.svelte's exportWebm(): source frames
  // are sampled at the real output cadence (unaffected by speed), but the
  // timestamps/durations written into the file are scaled by `speed`, so
  // speed changes the encoded duration directly.
  const totalDurationUs = rangeFrameCount * avgFrameDurationUs;
  const baseIntervalUs = 1_000_000 / fps;
  const outputFrameCount = Math.max(1, Math.round(totalDurationUs / baseIntervalUs) || 1);
  const outputDurationSec = (outputFrameCount * baseIntervalUs) / speed / 1_000_000;

  const estimatedBytes = Math.round(MUX_OVERHEAD_BYTES + ((bitrateKbps * 1000) / 8) * outputDurationSec);

  return { estimatedBytes, frameCount: outputFrameCount, outputWidth: width, outputHeight: height, outputDurationSec };
}
