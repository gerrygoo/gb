// LZW encoder for GIF89a image data streams. GIF's LZW variant:
// - packs codes LSB-first (a code's low bit lands in the lowest free bit
//   of the output byte stream, unlike the MSB-first packing used by TIFF)
// - reserves a Clear code (2^minCodeSize) and End code (Clear + 1) before
//   the first code available for the dictionary
// - starts code words at minCodeSize + 1 bits, growing by 1 bit whenever
//   the next code to be assigned no longer fits, capped at 12 bits
// - resets the dictionary (emitting Clear) once it fills at 4096 entries

class BitWriter {
  private bytes: number[] = [];
  private buffer = 0;
  private bufferBits = 0;

  writeCode(code: number, size: number): void {
    this.buffer |= code << this.bufferBits;
    this.bufferBits += size;
    while (this.bufferBits >= 8) {
      this.bytes.push(this.buffer & 0xff);
      this.buffer >>= 8;
      this.bufferBits -= 8;
    }
  }

  finish(): Uint8Array {
    if (this.bufferBits > 0) {
      this.bytes.push(this.buffer & 0xff);
      this.buffer = 0;
      this.bufferBits = 0;
    }
    return Uint8Array.from(this.bytes);
  }
}

const MAX_CODE_SIZE = 12;
const MAX_DICT_SIZE = 1 << MAX_CODE_SIZE; // 4096

/** Encodes `indices` (palette indices, one byte per pixel) as a GIF LZW code stream. */
export function lzwEncode(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const writer = new BitWriter();

  let dict: Map<string, number> = new Map();
  let nextCode = 0;
  let codeSize = 0;

  function resetDict(): void {
    dict = new Map();
    for (let i = 0; i < clearCode; i++) dict.set(String(i), i);
    nextCode = endCode + 1;
    codeSize = minCodeSize + 1;
  }

  resetDict();
  writer.writeCode(clearCode, codeSize);

  if (indices.length > 0) {
    let prefix = String(indices[0]);
    for (let i = 1; i < indices.length; i++) {
      const symbol = indices[i];
      const combined = `${prefix},${symbol}`;
      if (dict.has(combined)) {
        prefix = combined;
        continue;
      }

      writer.writeCode(dict.get(prefix)!, codeSize);

      if (nextCode < MAX_DICT_SIZE) {
        // A decoder can only materialize the entry for `nextCode` once it has
        // decoded the *next* code after this one (it needs that code's first
        // symbol to complete the string) — so its dictionary is always one
        // entry behind ours at the moment it has to size-check a read. Bump
        // here, before assigning nextCode to the new entry, so the growth
        // point lines up with when the decoder's own mirrored check fires
        // (right after it — one step late relative to us — builds this same
        // entry). Bumping after incrementing, checked here too early, would
        // make us write the next code one bit wider than the decoder expects
        // and desync the whole stream.
        if (nextCode >= 1 << codeSize && codeSize < MAX_CODE_SIZE) {
          codeSize++;
        }
        dict.set(combined, nextCode);
        nextCode++;
      } else {
        writer.writeCode(clearCode, codeSize);
        resetDict();
      }

      prefix = String(symbol);
    }
    writer.writeCode(dict.get(prefix)!, codeSize);
  }

  writer.writeCode(endCode, codeSize);
  return writer.finish();
}
