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

/** Decodes every chunk in order, awaiting flush() so all frames are guaranteed to have arrived before resolving. */
export function decodeAllFrames(config: VideoDecoderConfig, chunks: EncodedVideoChunk[]): Promise<VideoFrame[]> {
  return new Promise((resolve, reject) => {
    const frames: VideoFrame[] = [];
    const decoder = createFrameDecoder(config, (frame) => frames.push(frame), reject);
    for (const chunk of chunks) decoder.decode(chunk);
    decoder
      .flush()
      .then(() => {
        decoder.close();
        resolve(frames);
      })
      .catch(reject);
  });
}
