# Implementation Plan

Ordered phases. Each phase produces something testable. Check boxes as
completed; future sessions start by reading this file to find the frontier.

---

## Phase 1 — Project scaffold
> Done when: `npm run dev` serves a page with a drop zone that logs the
> file name to console.

- [x] `npm create vite` with Svelte + TypeScript template
- [x] Strip boilerplate, set up directory structure (`src/lib/`, `src/components/`)
- [x] Add `DropZone.svelte` — accepts video files, emits file handle
- [x] Verify dev server runs, drop zone works

## Phase 2 — Decode pipeline
> Done when: drop an MP4, see the first decoded frame rendered to a
> `<canvas>` on screen.

- [x] Add mp4box.js dependency
- [x] `lib/demux.ts` — wrap mp4box: open file → extract video track info
  (codec string, width, height, frame count, sample table) → emit
  `EncodedVideoChunk`s with timestamps and keyframe flags
- [x] `lib/decode.ts` — wrap `VideoDecoder`: accept chunks → emit
  `VideoFrame`s. Build keyframe index from demuxer output.
- [x] Wire into `App.svelte`: file drop → demux → decode first frame →
  draw to canvas via `drawImage(videoFrame, ...)`
- [x] Verify with a real MP4 (H.264 baseline + H.264 high + H.265 if
  browser supports)

## Phase 3 — WebGPU bootstrap
> Done when: a trivial compute shader runs and writes to a storage buffer
> that reads back correctly.

- [x] `lib/gpu.ts` — request adapter + device, handle feature detection,
  surface error messages for unsupported browsers
- [x] Write a minimal test shader (e.g., fill a buffer with thread IDs)
- [x] Read back buffer to CPU, verify values
- [x] Add GPU device to Svelte app context so all components can access it

## Phase 4 — Lanczos resize shader
> Done when: a dropped video's first frame is resized to a target
> resolution on the GPU and displayed on a canvas.

- [ ] `lib/shaders/resize.wgsl` — separable Lanczos-3 kernel. Two passes
  (horizontal then vertical). Input: source texture + uniforms (src dims,
  dst dims, kernel radius). Output: destination texture.
- [ ] `lib/resize.ts` — pipeline setup, bind groups, dispatch helper
- [ ] Wire: VideoFrame → `copyExternalImageToTexture` → resize pipeline →
  `copyTextureToBuffer` → readback → draw to canvas
- [ ] Visual verification: compare against browser `drawImage` resize at
  several target sizes (480p, 320p, 160p)

## Phase 5 — Histogram + palette
> Done when: drop a video, see a generated 256-color palette displayed
> as a swatch grid next to the resized frame.

- [ ] `lib/shaders/histogram.wgsl` — 32³ RGB histogram via shared-memory
  accumulation + atomicAdd to storage buffer
- [ ] `lib/histogram.ts` — pipeline + dispatch + readback
- [ ] `lib/palette.ts` — median-cut on histogram data. Input: 32K bin
  counts. Output: `Uint8Array(256 * 3)` palette.
- [ ] Wire: resized texture → histogram shader → readback → median-cut →
  render palette swatches to a `<canvas>` or DOM grid
- [ ] Verify palette looks reasonable for various content (animation,
  live action, gradients, flat color)

## Phase 6 — Quantize + dither shader
> Done when: drop a video, see the first frame quantized to 256 colors
> with blue-noise dither, rendered on screen. It should look like a
> high-quality GIF frame.

- [ ] Generate or embed a 64×64 blue-noise texture (bake as a constant
  array or load as a tiny asset)
- [ ] `lib/shaders/quantize.wgsl` — per pixel: sample blue-noise, offset
  RGB, brute-force nearest in 256-entry palette, write u8 index to
  storage buffer
- [ ] `lib/quantize.ts` — pipeline + dispatch + readback
- [ ] Wire: resized texture + palette → quantize shader → index buffer →
  reconstruct RGBA from palette on CPU → draw to canvas
- [ ] A/B compare: show source frame and quantized frame side by side
- [ ] Verify dither quality: gradients should be smooth, no banding, no
  obvious pattern at 1× zoom

## Phase 7 — GIF encoder
> Done when: drop a video, click "export", get a valid single-frame GIF
> file downloaded. Then extend to multi-frame.

- [ ] `lib/gif.ts` — GIF89a container writer:
  - Header + logical screen descriptor
  - Netscape looping extension
  - Per-frame: graphic control extension (delay, disposal method) +
    local color table + LZW-compressed pixel data
  - Trailer byte
- [ ] `lib/lzw.ts` — LZW encoder for GIF (variable-width codes, clear
  code, end code, code table reset at 4096)
- [ ] Unit test LZW: encode small known inputs, verify against a
  reference decoder (or just that the output GIF opens correctly)
- [ ] Single-frame export: full pipeline → one indexed frame → GIF → download
- [ ] Multi-frame export: decode N frames sequentially, pipeline each,
  write GIF with frame delays derived from source FPS. Release GPU
  resources per frame. Verify output plays correctly.
- [ ] Move LZW + GIF assembly into an encode Web Worker

## Phase 8 — Timeline UI
> Done when: user can scrub through a video frame-by-frame, set in/out
> points, and the export respects them.

- [ ] `Timeline.svelte` — horizontal strip, playhead indicator,
  click-to-seek, drag playhead
- [ ] Keyboard nav: arrow keys (±1 frame), J/K/L (back/pause/forward),
  Home/End (first/last frame)
- [ ] In/out handles: drag to set, or keyboard shortcuts (I/O)
- [ ] Lazy thumbnail strip: decode thumbnails (~160px wide) on demand as
  the visible portion of the timeline changes. Cache decoded thumbnails.
- [ ] Seeking logic: near-playhead → decode forward from cache; far seek →
  flush decoder, seek to nearest keyframe, decode forward
- [ ] Export range respects in/out points

## Phase 9 — Quality panel + preview
> Done when: user can adjust resolution, FPS, dither on/off, and loop
> count via UI controls. Preview updates within ~100ms of the last
> slider change. A/B toggle works.

- [ ] `QualityPanel.svelte`:
  - Output resolution: width input with aspect-locked height, common
    presets dropdown (480p, 320p, 240p, 160p, custom)
  - Output FPS: slider or input (1–60, default = source FPS)
  - Dither: toggle (blue-noise / none)
  - Loop count: infinite / 1 / N
- [ ] `quality` store — reactive, drives pipeline re-runs
- [ ] `Preview.svelte`:
  - Source canvas + quantized canvas
  - A/B split mode: single canvas, vertical divider, drag to compare
  - Mode toggle: source-only / quantized-only / split
- [ ] Debounced pipeline: on quality store change, wait 100ms, then
  re-run resize → histogram → palette → quantize on current frame
- [ ] Speed control: slider or input (0.25×–4×), affects frame delay in
  export

## Phase 10 — Size estimation + export polish
> Done when: a size estimate displays before encoding and updates live
> with quality changes. Export shows progress and produces a correct GIF.

- [ ] `lib/estimate.ts`:
  - Pick ~8 evenly-spaced frames from in/out range
  - Run full pipeline + LZW on each (reuse encode worker)
  - Average bytes/frame × total frames + header overhead
  - Re-estimate on quality/timeline change (debounced)
- [ ] `SizeEstimate.svelte` — display estimated size (KB/MB), frame
  count, output dimensions, output duration
- [ ] `ExportBar.svelte`:
  - Encode button (disabled during encode)
  - Progress bar (% of frames processed)
  - Cancel button (abort encode, clean up)
  - Download link appears on completion
- [ ] Encode pipeline: sequential decode through in/out → GPU pipeline →
  post indices + palette to encode worker → worker streams GIF bytes
  into a Blob → trigger download
- [ ] Handle edge cases: zero-length selection, single frame, very long
  clips (>500 frames warning?)

## Phase 11 — Integration + polish
> Done when: the tool is end-to-end usable. Drop a video, trim, adjust
> quality, preview, estimate size, export. No crashes on happy path.

- [ ] Error handling: unsupported codec message, WebGPU unavailable
  message, file-too-large warning
- [ ] Loading states: spinner during initial decode, progress during
  thumbnail generation
- [ ] Keyboard shortcut help (? key → overlay)
- [ ] Responsive layout: panels stack vertically on narrow viewports
- [ ] Favicon + page title
- [ ] Test with variety of real-world inputs: screen recordings, phone
  video, animated content, short clips, long clips
- [ ] Performance check: profile GPU pipeline, identify bottlenecks,
  ensure encode doesn't lock UI

---

## Future (post-MVP, not planned in detail)

- WebM demuxer
- Multi-segment compile (t3, t5)
- Frame deletion (t4), reverse (t6), boomerang (t7)
- Frame decimation (t9)
- Palette size control (q4), global palette (q5), Bayer dither (q6)
- Color space toggle (q7), transparency (q8)
- Crop (n1), text overlay (n2), filters (n3)
- Per-frame byte breakdown (s2), "what if" deltas (s3)
- Clipboard copy (o2), multi-size export (o3)
- Move WebGPU to worker via OffscreenCanvas
