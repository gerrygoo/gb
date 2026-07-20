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
- **Framework**: Vite + TypeScript + Svelte (if/when we need a framework).

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

## Feature list

### Input
- [i1] Load local video file (drag/drop)
- [i2] Container support (MP4, WebM — free with WebCodecs; MOV, MKV — depends)
- [i3] Load image sequence (PNGs/JPEGs → frames)
- [i4] Load existing GIF (re-encode / re-trim)
- [i5] Screen capture (getDisplayMedia)
- [i6] Webcam capture

### Cut / timeline
- [t1] Frame-by-frame scrub, keyboard nav (J/K/L, arrow keys)
- [t2] Set single in/out point
- [t3] Multi-segment compile (pick N ranges, concatenate)
- [t4] Delete individual frames from the middle
- [t5] Reorder segments (drag on timeline)
- [t6] Reverse
- [t7] Boomerang / yoyo loop
- [t8] Speed change (2×, 0.5×, custom)
- [t9] Frame decimation (drop every Nth frame)

### Quality knobs
- [q1] Output resolution (with aspect lock + common presets)
- [q2] Downsample filter: nearest / bilinear / bicubic / Lanczos / area
- [q3] Output frame rate (independent from source)
- [q4] Palette size (2–256)
- [q5] Palette strategy: global / per-frame / adaptive (temporal-coherent)
- [q6] Dither: none / Bayer / blue-noise
- [q7] Color space: quantize in sRGB vs. linear
- [q8] Transparency handling (alpha threshold or none)
- [q9] Loop count (1 / N / infinite)

### Preview
- [p1] Live preview showing final quantized output
- [p2] Toggle source vs. quantized side-by-side or A/B
- [p3] Zoom + pan with pixel grid at high zoom

### Size / cost feedback
- [s1] Live file-size estimate before encoding
- [s2] Per-frame byte breakdown (which frames are expensive)
- [s3] "What if" — slider deltas showing size change from each knob

### Output
- [o1] Download GIF
- [o2] Copy to clipboard as GIF
- [o3] Export at multiple sizes in one shot

### Nice-to-haves
- [n1] Crop
- [n2] Text/caption overlay
- [n3] Simple filters (brightness/contrast/saturation)
- [n4] Optical-flow frame blending for smooth slowdown

## MVP scope

**In**: i1, i2, t1, t2, t8, q1, q2 (Lanczos only), q3, q5 (per-frame
256 colors), q6 (blue-noise or none), q9, p1, p2, s1, o1

**Out** (architect the pipeline to allow later): everything else.

Single in/out trim + Lanczos resize + per-frame 256-color palette +
blue-noise dither already beats every consumer GIF tool on quality.
Live preview + size estimate validates the WebGPU pipeline end-to-end.
