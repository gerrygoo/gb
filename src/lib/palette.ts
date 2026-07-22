import { BINS_PER_CHANNEL } from './histogram';

export const PALETTE_SIZE = 256;
export const MIN_PALETTE_SIZE = 2;

export type ColorSpace = 'srgb' | 'linear';

/** Converts a gamma-encoded sRGB 0–1 channel value to linear light. Exported for quantize.ts, which pre-converts the (always-sRGB-bytes) palette to linear once at upload time rather than per-pixel in the shader (q7). */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Converts a linear-light 0–1 channel value back to gamma-encoded sRGB. Used to reconstruct display/GIF-storable palette bytes when the histogram/quantize working space is linear (q7) — bucket centers and averages are computed in that working space, but the returned palette is always sRGB bytes regardless. */
function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

interface Bin {
  r: number;
  g: number;
  b: number;
  count: number;
}

interface Box {
  bins: Bin[];
  count: number;
  rMin: number;
  rMax: number;
  gMin: number;
  gMax: number;
  bMin: number;
  bMax: number;
}

function bucketCenter(bucket: number): number {
  return (bucket + 0.5) / BINS_PER_CHANNEL;
}

function boxFromBins(bins: Bin[]): Box {
  let count = 0;
  let rMin = BINS_PER_CHANNEL - 1;
  let rMax = 0;
  let gMin = BINS_PER_CHANNEL - 1;
  let gMax = 0;
  let bMin = BINS_PER_CHANNEL - 1;
  let bMax = 0;
  for (const bin of bins) {
    count += bin.count;
    rMin = Math.min(rMin, bin.r);
    rMax = Math.max(rMax, bin.r);
    gMin = Math.min(gMin, bin.g);
    gMax = Math.max(gMax, bin.g);
    bMin = Math.min(bMin, bin.b);
    bMax = Math.max(bMax, bin.b);
  }
  return { bins, count, rMin, rMax, gMin, gMax, bMin, bMax };
}

function averageColor(box: Box, colorSpace: ColorSpace): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  for (const bin of box.bins) {
    r += bucketCenter(bin.r) * bin.count;
    g += bucketCenter(bin.g) * bin.count;
    b += bucketCenter(bin.b) * bin.count;
  }
  const count = Math.max(box.count, 1);
  let rAvg = r / count;
  let gAvg = g / count;
  let bAvg = b / count;
  if (colorSpace === 'linear') {
    rAvg = linearToSrgb(rAvg);
    gAvg = linearToSrgb(gAvg);
    bAvg = linearToSrgb(bAvg);
  }
  return [Math.round(rAvg * 255), Math.round(gAvg * 255), Math.round(bAvg * 255)];
}

/** Splits `box` along its longest axis at the weighted median. Returns null if the box can't be split further (single populated bin). */
function splitBox(box: Box): [Box, Box] | null {
  const rRange = box.rMax - box.rMin;
  const gRange = box.gMax - box.gMin;
  const bRange = box.bMax - box.bMin;

  let axis: 'r' | 'g' | 'b';
  let range: number;
  if (rRange >= gRange && rRange >= bRange) {
    axis = 'r';
    range = rRange;
  } else if (gRange >= bRange) {
    axis = 'g';
    range = gRange;
  } else {
    axis = 'b';
    range = bRange;
  }
  if (range === 0) {
    return null;
  }

  const sorted = [...box.bins].sort((a, b) => a[axis] - b[axis]);
  const half = box.count / 2;
  let running = 0;
  let splitIdx = sorted.length - 1;
  for (let i = 0; i < sorted.length; i++) {
    running += sorted[i].count;
    if (running >= half) {
      splitIdx = i + 1;
      break;
    }
  }
  splitIdx = Math.max(1, Math.min(splitIdx, sorted.length - 1));

  return [boxFromBins(sorted.slice(0, splitIdx)), boxFromBins(sorted.slice(splitIdx))];
}

/**
 * Median-cut quantization over a 32×32×32 histogram. Input: bin counts
 * indexed r*32*32 + g*32 + b (see histogram.wgsl), built in `colorSpace`
 * (must match the space `quantize()` will match against — see q7).
 * Output: `paletteSize` RGB colors (clamped to [2, 256]), always as sRGB
 * bytes regardless of the working color space.
 */
export function medianCut(histogram: Uint32Array, paletteSize = PALETTE_SIZE, colorSpace: ColorSpace = 'srgb'): Uint8Array {
  const targetSize = Math.max(MIN_PALETTE_SIZE, Math.min(PALETTE_SIZE, Math.round(paletteSize)));

  const bins: Bin[] = [];
  for (let r = 0; r < BINS_PER_CHANNEL; r++) {
    for (let g = 0; g < BINS_PER_CHANNEL; g++) {
      for (let b = 0; b < BINS_PER_CHANNEL; b++) {
        const idx = r * BINS_PER_CHANNEL * BINS_PER_CHANNEL + g * BINS_PER_CHANNEL + b;
        const count = histogram[idx];
        if (count > 0) {
          bins.push({ r, g, b, count });
        }
      }
    }
  }

  const palette = new Uint8Array(targetSize * 3);
  if (bins.length === 0) {
    return palette;
  }

  const boxes: Box[] = [boxFromBins(bins)];

  while (boxes.length < targetSize) {
    boxes.sort((a, b) => b.count - a.count);

    let splitIndex = -1;
    let result: [Box, Box] | null = null;
    for (let i = 0; i < boxes.length; i++) {
      result = splitBox(boxes[i]);
      if (result) {
        splitIndex = i;
        break;
      }
    }
    if (!result) {
      break; // no splittable box left — fewer than targetSize distinct colors
    }
    boxes.splice(splitIndex, 1, result[0], result[1]);
  }

  // If median-cut stops early (fewer than targetSize distinct colors in the
  // source), cycle through the real boxes to fill the remaining slots
  // instead of repeating just the last one — keeps the palette (and its
  // swatch preview) representative of the actual color spread rather than
  // collapsing into one big duplicate block.
  for (let i = 0; i < targetSize; i++) {
    const box = boxes[i % boxes.length];
    const [r, g, b] = averageColor(box, colorSpace);
    palette[i * 3] = r;
    palette[i * 3 + 1] = g;
    palette[i * 3 + 2] = b;
  }

  return palette;
}
