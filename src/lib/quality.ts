import { writable } from 'svelte/store';

/** Conventional height values for the resolution preset buttons. */
export const RESOLUTION_PRESETS = [480, 320, 240, 160] as const;

export interface QualitySettings {
  /** Output width in pixels (even). Height is derived from source aspect ratio. */
  targetWidth: number;
  /** Output frame rate, 1–60. */
  fps: number;
  dither: boolean;
  /** 0 = infinite, per the Netscape looping extension. */
  loopCount: number;
  /** Playback speed multiplier, 0.25–4. Scales export frame delay. */
  speed: number;
}

const DEFAULT_QUALITY: QualitySettings = {
  targetWidth: 640,
  fps: 30,
  dither: true,
  loopCount: 0,
  speed: 1,
};

export const quality = writable<QualitySettings>({ ...DEFAULT_QUALITY });

/** Output width/height for a target width, aspect-locked to the source and rounded to even (both dimensions). */
export function computeOutputDims(targetWidth: number, sourceWidth: number, sourceHeight: number): { width: number; height: number } {
  const width = Math.max(2, Math.round(targetWidth / 2) * 2);
  const height = Math.max(2, Math.round((width * sourceHeight) / sourceWidth / 2) * 2);
  return { width, height };
}

/** Width for a given conventional preset height, aspect-locked to the source and rounded to even. */
export function presetWidthFor(presetHeight: number, sourceWidth: number, sourceHeight: number): number {
  if (!sourceWidth || !sourceHeight) return presetHeight;
  return Math.max(2, Math.round((presetHeight * sourceWidth) / sourceHeight / 2) * 2);
}

/** Resets quality settings to source-derived defaults (480p-equivalent width, source fps) on file load. */
export function resetQualityForSource(sourceWidth: number, sourceHeight: number, sourceFps: number): void {
  quality.set({
    ...DEFAULT_QUALITY,
    targetWidth: presetWidthFor(RESOLUTION_PRESETS[0], sourceWidth, sourceHeight),
    fps: Math.min(60, Math.max(1, Math.round(sourceFps) || DEFAULT_QUALITY.fps)),
  });
}
