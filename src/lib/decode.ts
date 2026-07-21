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
