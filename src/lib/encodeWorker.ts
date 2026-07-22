/// <reference lib="webworker" />
// Runs LZW + GIF89a assembly (the CPU-heavy synchronous part of `gif.ts`) off
// the main thread. Driven incrementally so the caller can report per-frame
// progress and stream a final Blob without holding a giant array of frames
// in memory at once. See `encodeClient.ts` for the request/response wrapper
// that talks to this worker.

import { gifHeader, gifFrameBytes, concatBytes, GIF_TRAILER, type GifFrame } from './gif';
import type { EncodeInMessage, EncodeOutMessage } from './encodeProtocol';

const worker = self as unknown as DedicatedWorkerGlobalScope;

let chunks: Uint8Array[] = [];
let frameWidth = 0;
let frameHeight = 0;
let framesEncoded = 0;
let useGlobalColorTable = false;

function post(message: EncodeOutMessage, transfer: Transferable[] = []): void {
  worker.postMessage(message, transfer);
}

worker.onmessage = (e: MessageEvent<EncodeInMessage>) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'start': {
        frameWidth = msg.width;
        frameHeight = msg.height;
        useGlobalColorTable = !!msg.globalPalette;
        const globalPalette = msg.globalPalette ? new Uint8Array(msg.globalPalette) : undefined;
        chunks = [gifHeader(msg.width, msg.height, msg.loopCount, globalPalette)];
        framesEncoded = 0;
        break;
      }
      case 'frame': {
        const frame: GifFrame = {
          indices: new Uint8Array(msg.indices),
          palette: new Uint8Array(msg.palette),
          delayCs: msg.delayCs,
        };
        const frameBytes = gifFrameBytes(frameWidth, frameHeight, frame, useGlobalColorTable);
        chunks.push(frameBytes);
        framesEncoded++;
        post({ type: 'progress', framesEncoded, bytesForFrame: frameBytes.length });
        break;
      }
      case 'finish': {
        chunks.push(Uint8Array.of(GIF_TRAILER));
        const bytes = concatBytes(chunks);
        chunks = [];
        const buffer = bytes.buffer as ArrayBuffer;
        post({ type: 'done', bytes: buffer }, [buffer]);
        break;
      }
    }
  } catch (err) {
    post({ type: 'error', message: (err as Error).message });
  }
};
