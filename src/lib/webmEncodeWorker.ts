/// <reference lib="webworker" />
// Runs the VP9 VideoEncoder + WebM muxing (via mediabunny) off the main
// thread. Frames arrive as transferred `VideoFrame`s produced by the export
// loop's per-tick GPU resize (see WebmApp.svelte's exportWebm), so this
// worker never touches WebGPU itself — it only owns the mediabunny `Output`
// lifecycle and streams back the finished file as an ArrayBuffer. Mirrors
// the GIF app's encodeWorker.ts split, but carries resized VideoFrames
// instead of palette indices. See `webmEncodeClient.ts` for the
// request/response wrapper that talks to this worker.

import { Output, WebMOutputFormat, BufferTarget, VideoSampleSource, VideoSample } from 'mediabunny';
import type { WebmEncodeInMessage, WebmEncodeOutMessage } from './webmEncodeProtocol';

const worker = self as unknown as DedicatedWorkerGlobalScope;

let output: Output | null = null;
let videoSource: VideoSampleSource | null = null;
let framesEncoded = 0;

function post(message: WebmEncodeOutMessage, transfer: Transferable[] = []): void {
  worker.postMessage(message, transfer);
}

worker.onmessage = async (e: MessageEvent<WebmEncodeInMessage>) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'start': {
        const target = new BufferTarget();
        videoSource = new VideoSampleSource({ codec: 'vp9', bitrate: msg.bitrate, keyFrameInterval: msg.keyFrameInterval });
        output = new Output({ format: new WebMOutputFormat(), target });
        output.addVideoTrack(videoSource);
        await output.start();
        framesEncoded = 0;
        post({ type: 'started' });
        break;
      }
      case 'frame': {
        if (!output || !videoSource) throw new Error('encoder not started');
        // Takes ownership of `msg.frame`: wrapping it in a VideoSample and
        // closing that sample also closes the underlying VideoFrame.
        const sample = new VideoSample(msg.frame);
        await videoSource.add(sample);
        sample.close();
        framesEncoded++;
        post({ type: 'progress', framesEncoded });
        break;
      }
      case 'finish': {
        if (!output) throw new Error('encoder not started');
        const target = output.target as BufferTarget;
        const mimeType = output.format.mimeType;
        await output.finalize();
        const bytes = target.buffer as ArrayBuffer;
        output = null;
        videoSource = null;
        post({ type: 'done', bytes, mimeType }, [bytes]);
        break;
      }
    }
  } catch (err) {
    post({ type: 'error', message: (err as Error).message });
  }
};
