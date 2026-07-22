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
const MIN_CODE_SIZE = 8; // fixed 256-entry palette
const LOCAL_COLOR_TABLE_FLAG = 0x80;
const LOCAL_COLOR_TABLE_SIZE_FIELD = 0x07; // 2^(7+1) = 256 entries
const DISPOSAL_DO_NOT_DISPOSE = 0x04; // disposal method 1, in bits 4-2 of the GCE packed byte

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

/** Header + Logical Screen Descriptor + Netscape looping extension — the part of a GIF89a file that precedes any frame data. No global color table since frames carry their own local ones. */
export function gifHeader(width: number, height: number, loopCount = 0): Uint8Array {
  const bytes: number[] = [];
  appendAscii(bytes, GIF_HEADER);

  appendUint16LE(bytes, width);
  appendUint16LE(bytes, height);
  bytes.push(0x00); // packed: no global color table, color resolution 0, no sort, GCT size 0
  bytes.push(0x00); // background color index
  bytes.push(0x00); // pixel aspect ratio

  // Netscape looping extension — required for animated (multi-frame) GIFs
  // to loop at all; harmless on a single-frame GIF.
  bytes.push(0x21, 0xff, 0x0b);
  appendAscii(bytes, 'NETSCAPE2.0');
  bytes.push(0x03, 0x01);
  appendUint16LE(bytes, loopCount);
  bytes.push(0x00);

  return Uint8Array.from(bytes);
}

/** Graphic Control Extension + Image Descriptor + Local Color Table + LZW image data for one frame. `width`/`height` are the shared canvas size (Image Descriptor's own dimensions), same for every frame in this codebase. */
export function gifFrameBytes(width: number, height: number, frame: GifFrame): Uint8Array {
  const bytes: number[] = [];

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
  bytes.push(LOCAL_COLOR_TABLE_FLAG | LOCAL_COLOR_TABLE_SIZE_FIELD);

  appendBytes(bytes, frame.palette);

  bytes.push(MIN_CODE_SIZE);
  const compressed = lzwEncode(frame.indices, MIN_CODE_SIZE);
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
