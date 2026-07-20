# Scoping — GIF Creation Tool

Working doc. Decisions live here; open questions marked **[?]**.

## Vision

A browser-based GIF maker for people who care about the output. Two design
axes that pull ahead of every existing web tool:

1. **Frame-level precision** — cut, drop, reorder individual frames.
2. **High-control quality** — expose the knobs that actually change output
   (palette strategy, dither, resample filter) and predict file size live.

Everything runs in the browser. No uploads, no server.

## Tech stack (decided)

- **Decode**: WebCodecs `VideoDecoder` → `VideoFrame`. Hardware-accelerated,
  no ffmpeg.wasm.
- **Pixel pipeline** (resize, palette gen, quantization, dither): WebGPU
  compute shaders.
- **LZW + GIF container**: CPU (hand-rolled TS or small WASM). Sequential
  by nature, cheap relative to the pixel work.
- **Framework**: Vite + TypeScript. No UI framework decided yet **[?]**.

## Target browsers

Modern-only. Chrome/Edge, Safari 17+, Firefox 141+ (WebGPU stable).
No CPU fallback path — the premise is quality + speed.

## Known hard constraints

- WebCodecs decodes containers the browser natively supports (MP4/H.264,
  WebM/VP9/AV1, MOV). MKV and exotic codecs are out unless we ship a
  demuxer.
- GPU memory dominates. A 1080p30 10-second clip = ~330 frames × ~8MB raw
  = ~2.6 GB if fully materialized. Pipeline must stream frames, not buffer.
- Floyd–Steinberg dither is inherently sequential (error diffuses
  diagonally). Blue-noise / ordered dither is the GPU-native choice.

## Non-goals

- Audio (GIF has none).
- Server-side anything (auth, storage, sharing links).
- Non-GIF outputs (WebP, APNG, MP4) — possible later, not MVP.
- Mobile-first UI. Desktop-first; mobile "works" but isn't tuned.
