import type { WebmEncodeOutMessage, WebmEncodeProgressMessage } from './webmEncodeProtocol';

/**
 * Thin request/response wrapper around a dedicated `webmEncodeWorker.ts`
 * instance. Calls must be sequenced by the caller (await each before issuing
 * the next) — the worker processes messages strictly in order and this
 * client only ever tracks one outstanding request at a time. Mirrors
 * `encodeClient.ts`'s `EncodeWorkerClient`, but `start()` round-trips an ack
 * (unlike the GIF client's fire-and-forget `start`) because mediabunny's
 * `VideoSampleSource.add()` throws if the Output hasn't finished starting
 * yet — firing 'frame' before that would race it.
 */
export class WebmEncodeWorkerClient {
  private worker: Worker;
  private pending: { resolve: (msg: WebmEncodeOutMessage) => void; reject: (err: Error) => void } | null = null;

  constructor() {
    this.worker = new Worker(new URL('./webmEncodeWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<WebmEncodeOutMessage>) => this.settle(e.data);
    this.worker.onerror = (e: ErrorEvent) => this.fail(new Error(e.message));
  }

  private settle(msg: WebmEncodeOutMessage): void {
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

  /** Starts the mediabunny Output; resolves once it's ready to accept frames. */
  start(bitrate: number, keyFrameInterval: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.pending = { resolve: () => resolve(), reject };
      this.worker.postMessage({ type: 'start', bitrate, keyFrameInterval });
    });
  }

  /** Encodes one frame; resolves once mediabunny is ready for the next one, with a running frame count. Transfers (detaches) `frame` — do not reuse it after calling. */
  encodeFrame(frame: VideoFrame): Promise<WebmEncodeProgressMessage> {
    return new Promise((resolve, reject) => {
      this.pending = { resolve: (msg) => resolve(msg as WebmEncodeProgressMessage), reject };
      this.worker.postMessage({ type: 'frame', frame }, [frame]);
    });
  }

  /** Finalizes the mux and resolves with the complete WebM bytes + mime type. */
  finish(): Promise<{ bytes: Uint8Array<ArrayBuffer>; mimeType: string }> {
    return new Promise((resolve, reject) => {
      this.pending = {
        resolve: (msg) =>
          resolve(
            msg.type === 'done'
              ? { bytes: new Uint8Array(msg.bytes), mimeType: msg.mimeType }
              : { bytes: new Uint8Array(0), mimeType: 'video/webm' },
          ),
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
