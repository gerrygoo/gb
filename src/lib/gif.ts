import { lzwEncode } from './lzw';

export interface GifFrame {
  /** One palette index (0–255) per pixel, row-major. */
  indices: Uint8Array;
  /** 256×3 RGB palette, this frame's local color table. */
  palette: Uint8Array;
  /** Frame delay in centiseconds (1/100 s), per the GIF spec's time unit. */
  delayCs: number;
}

const GIF_HEADER = 'GIF89a';
const GLOBAL_COLOR_TABLE_FLAG = 0x80;
const LOCAL_COLOR_TABLE_FLAG = 0x80;
const DISPOSAL_DO_NOT_DISPOSE = 0x04; // disposal method 1, in bits 4-2 of the GCE packed byte

/**
 * GIF color tables must be a power-of-two size from 2 to 256 (the 3-bit
 * size field encodes 2^(field+1)). `colorCount` may be any value in that
 * range (q4's arbitrary palette size) — this finds the smallest table that
 * fits it. `size` is always >= colorCount; the caller pads the unused
 * table slots.
 */
function colorTableSizing(colorCount: number): { field: number; size: number } {
  let field = 0;
  while (1 << (field + 1) < colorCount && field < 7) field++;
  return { field, size: 1 << (field + 1) };
}

/** Pads an RGB color table (`colorCount`×3 bytes) with black entries up to `size`×3 bytes — GIF table sizes must be a power of two, but the real palette (q4) may be smaller. Unused slots are never referenced by any pixel index, so their value doesn't matter. */
function paddedColorTable(palette: Uint8Array, size: number): Uint8Array {
  const neededBytes = size * 3;
  if (palette.length === neededBytes) return palette;
  const table = new Uint8Array(neededBytes);
  table.set(palette.subarray(0, Math.min(palette.length, neededBytes)));
  return table;
}

function appendBytes(dest: number[], src: Uint8Array | ArrayLike<number>): void {
  for (let i = 0; i < src.length; i++) dest.push(src[i]);
}

function appendAscii(dest: number[], text: string): void {
  for (let i = 0; i < text.length; i++) dest.push(text.charCodeAt(i));
}

function appendUint16LE(dest: number[], value: number): void {
  dest.push(value & 0xff, (value >> 8) & 0xff);
}

/** Splits `data` into GIF's length-prefixed sub-blocks (max 255 bytes each), terminated by a zero-length block. */
function appendSubBlocks(dest: number[], data: Uint8Array): void {
  let offset = 0;
  while (offset < data.length) {
    const chunkSize = Math.min(255, data.length - offset);
    dest.push(chunkSize);
    for (let i = 0; i < chunkSize; i++) dest.push(data[offset + i]);
    offset += chunkSize;
  }
  dest.push(0x00);
}

/** GIF89a trailer byte. */
export const GIF_TRAILER = 0x3b;

/**
 * Header + Logical Screen Descriptor + Netscape looping extension — the
 * part of a GIF89a file that precedes any frame data. Pass `globalPalette`
 * (q5) to write a single shared color table here and have every frame
 * reference it instead of carrying its own local one (better temporal
 * coherence, at the cost of per-frame color accuracy on scene changes);
 * omit it to keep the legacy per-frame local color table behavior.
 */
export function gifHeader(width: number, height: number, loopCount = 0, globalPalette?: Uint8Array): Uint8Array {
  const bytes: number[] = [];
  appendAscii(bytes, GIF_HEADER);

  appendUint16LE(bytes, width);
  appendUint16LE(bytes, height);

  if (globalPalette && globalPalette.length > 0) {
    const { field, size } = colorTableSizing(globalPalette.length / 3);
    bytes.push(GLOBAL_COLOR_TABLE_FLAG | field); // packed: GCT present, color resolution 0, not sorted, GCT size field
    bytes.push(0x00); // background color index
    bytes.push(0x00); // pixel aspect ratio
    appendBytes(bytes, paddedColorTable(globalPalette, size));
  } else {
    bytes.push(0x00); // packed: no global color table, color resolution 0, no sort, GCT size 0
    bytes.push(0x00); // background color index
    bytes.push(0x00); // pixel aspect ratio
  }

  // Netscape looping extension — required for animated (multi-frame) GIFs
  // to loop at all; harmless on a single-frame GIF.
  bytes.push(0x21, 0xff, 0x0b);
  appendAscii(bytes, 'NETSCAPE2.0');
  bytes.push(0x03, 0x01);
  appendUint16LE(bytes, loopCount);
  bytes.push(0x00);

  return Uint8Array.from(bytes);
}

/**
 * Graphic Control Extension + Image Descriptor + (optional Local Color
 * Table) + LZW image data for one frame. `width`/`height` are the shared
 * canvas size (Image Descriptor's own dimensions), same for every frame in
 * this codebase. `frame.palette` may be any size from 2 to 256 colors
 * (q4) — the LZW minimum code size and, when writing a local table, the
 * table's padded size are both derived from it. Pass `useGlobalColorTable:
 * true` (q5) when `gifHeader` was given a `globalPalette` — this omits the
 * per-frame local table and its bytes; `frame.palette` must then be that
 * same global palette, since it still determines the LZW code size.
 */
export function gifFrameBytes(width: number, height: number, frame: GifFrame, useGlobalColorTable = false): Uint8Array {
  const bytes: number[] = [];
  const { field, size } = colorTableSizing(frame.palette.length / 3);
  const minCodeSize = Math.max(2, field + 1);

  bytes.push(0x21, 0xf9, 0x04);
  bytes.push(DISPOSAL_DO_NOT_DISPOSE);
  appendUint16LE(bytes, frame.delayCs);
  bytes.push(0x00); // transparent color index (unused)
  bytes.push(0x00); // block terminator

  bytes.push(0x2c);
  appendUint16LE(bytes, 0); // left
  appendUint16LE(bytes, 0); // top
  appendUint16LE(bytes, width);
  appendUint16LE(bytes, height);
  bytes.push(useGlobalColorTable ? 0x00 : LOCAL_COLOR_TABLE_FLAG | field);

  if (!useGlobalColorTable) {
    appendBytes(bytes, paddedColorTable(frame.palette, size));
  }

  bytes.push(minCodeSize);
  const compressed = lzwEncode(frame.indices, minCodeSize);
  appendSubBlocks(bytes, compressed);

  return Uint8Array.from(bytes);
}

/** Concatenates byte chunks into one contiguous array (avoids the call-stack risk of spreading large arrays). */
export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Encodes `frames` as a GIF89a file. Each frame carries its own local color
 * table (no global color table) since frames may be quantized against
 * independent palettes. Thin synchronous wrapper over `gifHeader`/
 * `gifFrameBytes`/`GIF_TRAILER` for callers that don't need the incremental,
 * off-main-thread version those power (see `encodeWorker.ts`).
 */
export function encodeGif(width: number, height: number, frames: GifFrame[], loopCount = 0): Uint8Array {
  const chunks = [gifHeader(width, height, loopCount)];
  for (const frame of frames) chunks.push(gifFrameBytes(width, height, frame));
  chunks.push(Uint8Array.of(GIF_TRAILER));
  return concatBytes(chunks);
}
