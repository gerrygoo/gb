import type { EncodeOutMessage, EncodeProgressMessage } from './encodeProtocol';

/**
 * Thin request/response wrapper around a dedicated `encodeWorker.ts`
 * instance. Calls must be sequenced by the caller (await each before issuing
 * the next) — the worker processes messages strictly in order and this
 * client only ever tracks one outstanding request at a time.
 */
export class EncodeWorkerClient {
  private worker: Worker;
  private pending: { resolve: (msg: EncodeOutMessage) => void; reject: (err: Error) => void } | null = null;

  constructor() {
    this.worker = new Worker(new URL('./encodeWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<EncodeOutMessage>) => this.settle(e.data);
    this.worker.onerror = (e: ErrorEvent) => this.fail(new Error(e.message));
  }

  private settle(msg: EncodeOutMessage): void {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    if (msg.type === 'error') pending.reject(new Error(msg.message));
    else pending.resolve(msg);
  }

  private fail(err: Error): void {
    const pending = this.pending;
    this.pending = null;
    pending?.reject(err);
  }

  /** `globalPalette` (q5), if given, is transferred — pass a fresh, fully-owned array (see file header note). */
  start(width: number, height: number, loopCount: number, globalPalette?: Uint8Array): void {
    if (globalPalette) {
      this.worker.postMessage(
        { type: 'start', width, height, loopCount, globalPalette: globalPalette.buffer },
        [globalPalette.buffer],
      );
    } else {
      this.worker.postMessage({ type: 'start', width, height, loopCount });
    }
  }

  /** Encodes one frame; resolves once the worker has appended it, with a running frame count and this frame's compressed byte size. */
  encodeFrame(indices: Uint8Array, palette: Uint8Array, delayCs: number): Promise<EncodeProgressMessage> {
    return new Promise((resolve, reject) => {
      this.pending = { resolve: (msg) => resolve(msg as EncodeProgressMessage), reject };
      this.worker.postMessage(
        { type: 'frame', indices: indices.buffer, palette: palette.buffer, delayCs },
        [indices.buffer, palette.buffer],
      );
    });
  }

  /** Appends the trailer and resolves with the complete GIF bytes. */
  finish(): Promise<Uint8Array<ArrayBuffer>> {
    return new Promise((resolve, reject) => {
      this.pending = {
        resolve: (msg) => resolve(new Uint8Array(msg.type === 'done' ? msg.bytes : new ArrayBuffer(0))),
        reject,
      };
      this.worker.postMessage({ type: 'finish' });
    });
  }

  /** Immediately kills the worker, discarding any in-progress encode. Safe to call more than once. */
  terminate(): void {
    this.worker.terminate();
    this.fail(new Error('encode worker terminated'));
  }
}
