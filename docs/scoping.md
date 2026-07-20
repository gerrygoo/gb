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

## Architecture

### Pipeline

```
File
 → Demux (mp4box.js — MP4/MOV only for MVP)
 → WebCodecs VideoDecoder → VideoFrame
 → [Resize] Lanczos compute shader → GPUTexture at target res
 → [Palette] GPU histogram (32³ bins) → readback → CPU median-cut → 256 colors
 → [Quantize + Dither] compute shader: blue-noise offset + nearest palette → u8 indices
 → [Readback] GPU → CPU (Uint8Array of palette indices per frame)
 → [LZW + GIF assembly] CPU, in encode worker
 → Blob → download
```

Two modes share the pipeline:

- **Preview** — process one frame on demand as user scrubs or adjusts
  knobs. Debounced (~100ms). Output → canvas, not LZW.
- **Encode** — stream sequentially through in→out range. One frame
  resident on GPU at a time; release before decoding next. Peak memory
  ≈ 1 frame at source res + 1 at target res.

### Frame management

Three tiers, never fully materialized:

| Tier | Resolution | Storage | Lifecycle |
|------|-----------|---------|-----------|
| Thumbnails | ~160px wide | CPU `ImageBitmap[]` | Lazy-decoded as timeline scrolls |
| Working frame | Full source | GPU texture, 3–5 max (LRU) | Around playhead, evicted on seek |
| Encode stream | Full source | 1 GPU texture | Per-frame, released immediately |

Random access: on file load, build a **keyframe index** from the demuxer.
Scrubbing near playhead decodes forward from cache. Far seeks flush the
decoder, seek to nearest keyframe, decode forward to target.

### WebGPU compute shaders

1. **resize.wgsl** — Lanczos-3 separable filter. One dispatch per output
   pixel. Input: source GPUTexture + target dims. Output: resized GPUTexture.
2. **histogram.wgsl** — 32×32×32 RGB histogram. Workgroups tile the image,
   accumulate in shared memory, atomicAdd to a storage buffer (32K × u32).
3. **quantize.wgsl** — per-pixel: add blue-noise offset (tiled 64×64
   texture, baked in), brute-force nearest among 256 palette entries.
   Output: u8 index buffer.

Palette generation (median-cut on 32K histogram bins) stays on CPU —
recursive, branch-heavy, microseconds on the readback data.

### Worker layout

```
Main thread                  Decode worker           Encode worker
─────────────                ─────────────           ─────────────
Svelte UI                    mp4box.js demuxer       LZW compress
WebGPU device + queue        VideoDecoder            GIF89a assembly
Canvas rendering             → VideoFrames to main   → Blob / progress
User interaction
```

WebGPU on main thread for MVP — `copyExternalImageToTexture` needs
VideoFrame and device on the same thread. GPU dispatches are async /
non-blocking so UI stays responsive.

### Svelte structure

**Stores**: `project`, `timeline`, `quality`, `preview`, `encode`

**Components**:
- `App.svelte` — layout shell + drop zone
- `Preview.svelte` — dual canvas, A/B split
- `Timeline.svelte` — lazy thumbnail strip, in/out handles, playhead, keys
- `QualityPanel.svelte` — resolution, fps, dither toggle, loop count
- `SizeEstimate.svelte` — live readout (updates on debounced knob changes)
- `ExportBar.svelte` — encode trigger, progress, download

**Lib modules**:
- `lib/decode.ts` — decoder worker wrapper, keyframe index, seek
- `lib/gpu.ts` — device init, pipeline creation, shader modules
- `lib/resize.wgsl`, `lib/histogram.wgsl`, `lib/quantize.wgsl`
- `lib/palette.ts` — median-cut on histogram (CPU)
- `lib/gif.ts` — LZW encoder + GIF89a container
- `lib/estimate.ts` — sample 8 frames, LZW-encode, extrapolate

### Size estimation

Sample-based: pick ~8 evenly-spaced frames from in/out range, run full
pipeline including LZW, average bytes-per-frame × total frames + header.
Re-run on same samples when knobs change. Accurate to ~10–15%.

### Decisions log

- **Demuxer**: mp4box.js only (MP4/MOV). WebM demuxer deferred.
- **Thumbnails**: lazy-decode as timeline scrolls (not eager on load).
- **Preview latency**: ~100ms debounce on knob changes, not realtime.
- **Palette gen**: GPU histogram + CPU median-cut (not GPU k-means).
- **GPU thread**: main thread for MVP (avoids VideoFrame transfer cost).
