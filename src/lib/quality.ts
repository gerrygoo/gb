import { writable } from 'svelte/store';
import type { DitherMode } from './quantize';
import type { ColorSpace } from './palette';
import { PALETTE_SIZE as MAX_PALETTE_SIZE, MIN_PALETTE_SIZE } from './palette';

/** Conventional height values for the resolution preset buttons. */
export const RESOLUTION_PRESETS = [480, 320, 240, 160] as const;

export { MAX_PALETTE_SIZE, MIN_PALETTE_SIZE };

export interface QualitySettings {
  /** Output width in pixels (even). Height is derived from source aspect ratio. */
  targetWidth: number;
  /** Output frame rate, 1–60. */
  fps: number;
  /** Colors in the generated palette, 2–256 (q4). */
  paletteSize: number;
  /** When true, one palette is built from samples across the whole in/out range and shared by every frame (q5); when false (default), each frame gets its own palette. */
  globalPalette: boolean;
  dither: DitherMode;
  /** Color space the palette/quantize nearest-match distance is computed in (q7). */
  colorSpace: ColorSpace;
  /** 0 = infinite, per the Netscape looping extension. */
  loopCount: number;
  /** Playback speed multiplier, 0.25–4. Scales export frame delay. */
  speed: number;
}

const DEFAULT_QUALITY: QualitySettings = {
  targetWidth: 640,
  fps: 30,
  paletteSize: MAX_PALETTE_SIZE,
  globalPalette: false,
  dither: 'blue-noise',
  colorSpace: 'srgb',
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
