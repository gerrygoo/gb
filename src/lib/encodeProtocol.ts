// Message shapes shared between `encodeWorker.ts` and `encodeClient.ts`.
// `indices`/`palette` are transferred (not cloned) `ArrayBuffer`s — callers
// must pass fresh, fully-owned typed arrays (byteOffset 0, no other live
// references) since transfer detaches the sender's view.

export interface EncodeStartMessage {
  type: 'start';
  width: number;
  height: number;
  loopCount: number;
}

export interface EncodeFrameMessage {
  type: 'frame';
  indices: ArrayBuffer;
  palette: ArrayBuffer;
  delayCs: number;
}

export interface EncodeFinishMessage {
  type: 'finish';
}

export type EncodeInMessage = EncodeStartMessage | EncodeFrameMessage | EncodeFinishMessage;

export interface EncodeProgressMessage {
  type: 'progress';
  framesEncoded: number;
  bytesForFrame: number;
}

export interface EncodeDoneMessage {
  type: 'done';
  bytes: ArrayBuffer;
}

export interface EncodeErrorMessage {
  type: 'error';
  message: string;
}

export type EncodeOutMessage = EncodeProgressMessage | EncodeDoneMessage | EncodeErrorMessage;
