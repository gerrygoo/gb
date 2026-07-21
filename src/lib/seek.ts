import { buildKeyframeIndex, createFrameDecoder, nearestKeyframeAtOrBefore, type KeyframeIndex } from './decode';
import { beginOp } from './status';

const WORKING_CACHE_SIZE = 64;
const THUMBNAIL_CACHE_SIZE = 1024;

function touch<T extends { close(): void }>(cache: Map<number, T>, cap: number, key: number, value: T) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > cap) {
    const oldestKey = cache.keys().next().value as number;
    cache.get(oldestKey)?.close();
    cache.delete(oldestKey);
  }
}

export interface FrameSeeker {
  readonly frameCount: number;
  readonly keyframes: KeyframeIndex;
  /** Seeks the playhead decoder to `frameIndex`, returning a full-resolution bitmap.
   * The returned bitmap is cache-owned — do not close it. */
  seekTo(frameIndex: number): Promise<ImageBitmap>;
  /** Decodes and caches ~`thumbWidth`-wide thumbnails for the given (possibly
   * sparse) frame indices, skipping any already cached. Adjacent requested
   * frames are decoded as a single run so one keyframe seek covers many. */
  loadThumbnails(frameIndices: number[], thumbWidth?: number): Promise<void>;
  /** Cache-only lookup — does not trigger a decode. */
  getCachedThumbnail(frameIndex: number): ImageBitmap | undefined;
  destroy(): void;
}

export function createFrameSeeker(config: VideoDecoderConfig, chunks: EncodedVideoChunk[]): FrameSeeker {
  const keyframes = buildKeyframeIndex(chunks);
  const workingCache = new Map<number, ImageBitmap>();
  const thumbnailCache = new Map<number, ImageBitmap>();

  let playheadDecoder: VideoDecoder | null = null;
  let seekQueue: Promise<unknown> = Promise.resolve();

  // Chrome's VideoDecoder requires the first decode() after any flush() to be
  // a keyframe again (undocumented in the spec text, but enforced in
  // practice) — so a decoder can't be incrementally "continued" across
  // multiple seeks once it has flushed once. Every cache-miss seek therefore
  // decodes fresh from the nearest keyframe through the target, using a new
  // decoder, and caches every frame along the way. "Near-playhead" seeks are
  // fast because they land in that cached sweep; "far" seeks pay for a fresh
  // keyframe-to-target decode.
  async function doSeek(frameIndex: number): Promise<ImageBitmap> {
    const cached = workingCache.get(frameIndex);
    if (cached) {
      touch(workingCache, WORKING_CACHE_SIZE, frameIndex, cached);
      return cached;
    }

    const kf = nearestKeyframeAtOrBefore(keyframes, frameIndex);
    playheadDecoder?.close();
    const frames: VideoFrame[] = [];
    await new Promise<void>((resolve, reject) => {
      const decoder = createFrameDecoder(config, (f) => frames.push(f), reject);
      playheadDecoder = decoder;
      for (let i = kf; i <= frameIndex; i++) decoder.decode(chunks[i]);
      decoder
        .flush()
        .then(() => resolve())
        .catch(reject);
    });

    for (let i = 0; i < frames.length; i++) {
      const idx = kf + i;
      const bitmap = await createImageBitmap(frames[i]);
      frames[i].close();
      touch(workingCache, WORKING_CACHE_SIZE, idx, bitmap);
    }
    playheadDecoder?.close();
    playheadDecoder = null;

    const bitmap = workingCache.get(frameIndex);
    if (!bitmap) throw new Error(`seek: decode did not produce frame ${frameIndex}`);
    return bitmap;
  }

  function seekTo(frameIndex: number): Promise<ImageBitmap> {
    const end = beginOp(`seeking to frame ${frameIndex}…`);
    const result = seekQueue.then(() => doSeek(frameIndex));
    seekQueue = result.catch(() => {});
    result.finally(end);
    return result;
  }

  async function loadThumbnails(frameIndices: number[], thumbWidth = 160): Promise<void> {
    const wanted = Array.from(new Set(frameIndices))
      .filter((i) => i >= 0 && i < chunks.length)
      .sort((a, b) => a - b);
    const missing = wanted.filter((i) => !thumbnailCache.has(i));
    if (missing.length === 0) return;

    const end = beginOp(`decoding ${missing.length} thumbnail${missing.length > 1 ? 's' : ''}…`);
    try {
      // Decode contiguous runs together so one keyframe seek covers many thumbnails.
      let runStart = missing[0];
      let prev = missing[0];
      for (let i = 1; i <= missing.length; i++) {
        const cur = missing[i];
        if (cur !== undefined && cur === prev + 1) {
          prev = cur;
          continue;
        }
        await decodeThumbnailRun(runStart, prev, thumbWidth);
        if (cur !== undefined) {
          runStart = cur;
          prev = cur;
        }
      }
    } finally {
      end();
    }
  }

  async function decodeThumbnailRun(startFrame: number, endFrame: number, thumbWidth: number): Promise<void> {
    const kf = nearestKeyframeAtOrBefore(keyframes, startFrame);
    const frames: VideoFrame[] = [];
    await new Promise<void>((resolve, reject) => {
      const decoder = createFrameDecoder(config, (f) => frames.push(f), reject);
      for (let i = kf; i <= endFrame; i++) decoder.decode(chunks[i]);
      decoder
        .flush()
        .then(() => {
          decoder.close();
          resolve();
        })
        .catch(reject);
    });

    for (let i = 0; i < frames.length; i++) {
      const frameIndex = kf + i;
      const frame = frames[i];
      if (frameIndex >= startFrame && frameIndex <= endFrame && !thumbnailCache.has(frameIndex)) {
        const thumbHeight = Math.max(1, Math.round((thumbWidth * frame.displayHeight) / frame.displayWidth));
        const bitmap = await createImageBitmap(frame, {
          resizeWidth: thumbWidth,
          resizeHeight: thumbHeight,
          resizeQuality: 'low',
        });
        touch(thumbnailCache, THUMBNAIL_CACHE_SIZE, frameIndex, bitmap);
      }
      frame.close();
    }
  }

  function getCachedThumbnail(frameIndex: number): ImageBitmap | undefined {
    return thumbnailCache.get(frameIndex);
  }

  function destroy() {
    playheadDecoder?.close();
    playheadDecoder = null;
    for (const bitmap of workingCache.values()) bitmap.close();
    workingCache.clear();
    for (const bitmap of thumbnailCache.values()) bitmap.close();
    thumbnailCache.clear();
  }

  return {
    frameCount: chunks.length,
    keyframes,
    seekTo,
    loadThumbnails,
    getCachedThumbnail,
    destroy,
  };
}
