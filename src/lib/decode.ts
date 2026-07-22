export interface KeyframeIndex {
  /** Indices into the chunk array of every sync (key) frame, in order. */
  chunkIndices: number[];
}

export function buildKeyframeIndex(chunks: EncodedVideoChunk[]): KeyframeIndex {
  const chunkIndices: number[] = [];
  chunks.forEach((chunk, i) => {
    if (chunk.type === 'key') chunkIndices.push(i);
  });
  return { chunkIndices };
}

/** Largest keyframe chunk index that is <= frameIndex. Assumes chunkIndices[0] === 0. */
export function nearestKeyframeAtOrBefore(keyframes: KeyframeIndex, frameIndex: number): number {
  const { chunkIndices } = keyframes;
  let lo = 0;
  let hi = chunkIndices.length - 1;
  let result = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (chunkIndices[mid] <= frameIndex) {
      result = chunkIndices[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

/** Wraps VideoDecoder: configured and ready to accept chunks, emitting VideoFrames via onFrame. */
export function createFrameDecoder(
  config: VideoDecoderConfig,
  onFrame: (frame: VideoFrame) => void,
  onError: (error: DOMException) => void,
): VideoDecoder {
  const decoder = new VideoDecoder({ output: onFrame, error: onError });
  decoder.configure(config);
  return decoder;
}

/** How many chunks may be in flight (submitted but not yet consumed) at once
 * in {@link decodeFramesStreaming}. Bounds resident `VideoFrame` count to
 * roughly this many regardless of how long the decoded range is — a decoder
 * with B-frames needs some reorder depth, but nothing close to hundreds of
 * frames, so this is generous headroom rather than a tight tune. */
const STREAM_LOOKAHEAD = 8;

/**
 * Decodes `chunks` in order, yielding one `VideoFrame` at a time. Unlike
 * {@link decodeAllFrames}, which submits and buffers the entire range before
 * resolving, this only stays a bounded `STREAM_LOOKAHEAD` chunks ahead of
 * whatever the consumer has taken so far — the generator won't queue more
 * decode work until the consumer asks for the next frame, so memory is
 * bounded by the decoder's internal pipeline depth, not by range length.
 * Every yielded frame is the caller's responsibility to `close()`. If the
 * consumer stops iterating early (`break`/`return` out of a `for await`),
 * the runtime calls this generator's `return()`, which resumes right at the
 * `yield` — any frames the decoder had already produced into the internal
 * lookahead buffer but never yielded are closed in the `finally` below, so
 * an early-terminated export can't leak them.
 */
export async function* decodeFramesStreaming(
  config: VideoDecoderConfig,
  chunks: EncodedVideoChunk[],
): AsyncGenerator<VideoFrame, void, void> {
  const pending: VideoFrame[] = [];
  let waiter: (() => void) | null = null;
  let decodeError: unknown = null;

  const decoder = new VideoDecoder({
    output: (frame) => {
      pending.push(frame);
      if (waiter) {
        const w = waiter;
        waiter = null;
        w();
      }
    },
    error: (err) => {
      decodeError = err;
      if (waiter) {
        const w = waiter;
        waiter = null;
        w();
      }
    },
  });
  decoder.configure(config);

  let nextChunkIndex = 0;
  let flushPromise: Promise<void> | null = null;

  function feedMore() {
    while (nextChunkIndex < chunks.length && decoder.decodeQueueSize < STREAM_LOOKAHEAD) {
      decoder.decode(chunks[nextChunkIndex]);
      nextChunkIndex++;
    }
    if (nextChunkIndex >= chunks.length && !flushPromise) {
      flushPromise = decoder.flush();
    }
  }

  try {
    feedMore();
    let consumed = 0;
    while (consumed < chunks.length) {
      if (decodeError) throw decodeError;
      if (pending.length === 0) {
        await new Promise<void>((resolve) => {
          waiter = resolve;
        });
        continue;
      }
      const frame = pending.shift()!;
      consumed++;
      feedMore();
      yield frame;
    }
    if (flushPromise) await flushPromise;
  } finally {
    // On early termination (consumer broke out of its `for await`), the
    // decoder may have already produced frames into `pending` that were
    // never shifted out and yielded — close them here rather than leaking.
    for (const frame of pending) frame.close();
    pending.length = 0;
    decoder.close();
  }
}

/** `VideoDecoder.isConfigSupported()`, resolved to a plain boolean — never
 * throws, since an unsupported or malformed config should read as "no"
 * rather than bubbling a raw browser error to the caller. */
export async function isDecodeConfigSupported(config: VideoDecoderConfig): Promise<boolean> {
  try {
    const result = await VideoDecoder.isConfigSupported(config);
    return result.supported ?? false;
  } catch {
    return false;
  }
}
