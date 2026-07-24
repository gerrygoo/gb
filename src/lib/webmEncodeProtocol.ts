// Message shapes shared between `webmEncodeWorker.ts` and `webmEncodeClient.ts`.
// `frame` is a transferred (not cloned) VideoFrame — the sender's handle is
// detached/closed by the transfer, and the worker takes ownership of closing
// it (via the VideoSample it wraps it in — see webmEncodeWorker.ts).

export interface WebmEncodeStartMessage {
  type: 'start';
  /** Target bitrate in bits per second (VP9 bitrate-target mode). Output
   * dimensions aren't needed here — mediabunny infers them from the first
   * frame added. */
  bitrate: number;
  /** Keyframe interval in seconds, passed straight through to mediabunny's
   * `VideoEncodingConfig.keyFrameInterval` (its own default is 2s). */
  keyFrameInterval: number;
}

export interface WebmEncodeFrameMessage {
  type: 'frame';
  frame: VideoFrame;
}

export interface WebmEncodeFinishMessage {
  type: 'finish';
}

export type WebmEncodeInMessage = WebmEncodeStartMessage | WebmEncodeFrameMessage | WebmEncodeFinishMessage;

/** Ack that the mediabunny Output has started and is ready to accept frames —
 * required because `VideoSampleSource.add()` throws if the output hasn't
 * started yet, so the client must await this before posting any 'frame'
 * message rather than firing 'start' and moving on immediately. */
export interface WebmEncodeStartedMessage {
  type: 'started';
}

export interface WebmEncodeProgressMessage {
  type: 'progress';
  framesEncoded: number;
}

export interface WebmEncodeDoneMessage {
  type: 'done';
  bytes: ArrayBuffer;
  mimeType: string;
}

export interface WebmEncodeErrorMessage {
  type: 'error';
  message: string;
}

export type WebmEncodeOutMessage =
  | WebmEncodeStartedMessage
  | WebmEncodeProgressMessage
  | WebmEncodeDoneMessage
  | WebmEncodeErrorMessage;
