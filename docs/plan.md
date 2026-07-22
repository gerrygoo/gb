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

- [x] `lib/shaders/resize.wgsl` — separable Lanczos-3 kernel. Two passes
  (horizontal then vertical). Input: source texture + uniforms (src dims,
  dst dims, kernel radius). Output: destination texture.
- [x] `lib/resize.ts` — pipeline setup, bind groups, dispatch helper
- [x] Wire: VideoFrame → `copyExternalImageToTexture` → resize pipeline →
  `copyTextureToBuffer` → readback → draw to canvas
- [x] Visual verification: compare against browser `drawImage` resize at
  several target sizes (480p, 320p, 160p)

## Phase 5 — Histogram + palette
> Done when: drop a video, see a generated 256-color palette displayed
> as a swatch grid next to the resized frame.

- [x] `lib/shaders/histogram.wgsl` — 32³ RGB histogram, atomicAdd straight
  to the global storage buffer (one thread per pixel; shared-memory
  pre-accumulation skipped — the full histogram doesn't fit in the 16KB
  default workgroup storage limit, and this only runs on a single still
  frame so atomic contention is a non-issue)
- [x] `lib/histogram.ts` — pipeline + dispatch + readback
- [x] `lib/palette.ts` — median-cut on histogram data. Input: 32K bin
  counts. Output: `Uint8Array(256 * 3)` palette.
- [x] Wire: resized texture → histogram shader → readback → median-cut →
  render palette swatches to a `<canvas>` or DOM grid
- [x] Verify palette looks reasonable for various content (animation,
  live action, gradients, flat color)

## Phase 6 — Quantize + dither shader
> Done when: drop a video, see the first frame quantized to 256 colors
> with blue-noise dither, rendered on screen. It should look like a
> high-quality GIF frame.

- [x] Generate or embed a 64×64 blue-noise texture (bake as a constant
  array or load as a tiny asset) — generated offline via void-and-cluster,
  verified against a DFT radial power spectrum (near-zero at low
  frequencies rising to a plateau — the blue-noise signature), baked as
  base64 in `lib/blueNoise.ts`
- [x] `lib/shaders/quantize.wgsl` — per pixel: sample blue-noise, offset
  RGB, brute-force nearest in 256-entry palette, write index to storage
  buffer (`array<u32>`, not `u8` — WGSL storage buffers don't support u8
  elements)
- [x] `lib/quantize.ts` — pipeline + dispatch + readback
- [x] Wire: resized texture + palette → quantize shader → index buffer →
  reconstruct RGBA from palette on CPU → draw to canvas
- [x] A/B compare: show source frame and quantized frame side by side
- [x] Verify dither quality: gradients should be smooth, no banding, no
  obvious pattern at 1× zoom

## Phase 7 — GIF encoder
> Done when: drop a video, click "export", get a valid single-frame GIF
> file downloaded. Then extend to multi-frame.

- [x] `lib/gif.ts` — GIF89a container writer:
  - Header + logical screen descriptor
  - Netscape looping extension
  - Per-frame: graphic control extension (delay, disposal method) +
    local color table + LZW-compressed pixel data
  - Trailer byte
- [x] `lib/lzw.ts` — LZW encoder for GIF (variable-width codes, clear
  code, end code, code table reset at 4096). Subtle bug found and fixed:
  a decoder can only materialize a new dictionary entry once it has
  decoded the *next* code after the one that triggered it (needs that
  code's first symbol) — so it's always one entry behind the encoder.
  The encoder's code-size bump has to happen *before* assigning the
  triggering entry (not after), so the growth point lines up with where
  the decoder's mirrored, naturally-lagged check actually fires.
- [x] Unit test LZW: round-tripped encode → independent reference GIF
  LZW decoder (hand-rolled, in scratchpad) across empty/single-pixel/
  flat-run/ascending/pseudo-random/small-alphabet inputs, including a
  forced table-full reset at 4096 entries. This is what caught the bug
  above (flat-run inputs cross the 9→10 bit code-size boundary in a way
  smaller tests didn't).
- [x] Single-frame export: "Export current frame as GIF" reuses the
  already-quantized preview frame/palette, encodes, downloads. Verified
  with ffmpeg/ffprobe (`file` + pixel comparison against source indices)
  across all four synthetic test clips.
- [x] Multi-frame export: "Export animated GIF" decodes every chunk via
  `decodeAllFrames` (awaits `flush()` so all frames are guaranteed in
  before returning), runs resize → histogram/palette → quantize per
  frame with a fresh per-frame local color table, derives delay from
  each frame's duration, releases per-frame GPU resources (textures
  destroyed each iteration). Verified frame count via ffprobe and
  visually confirmed the mandelbrot clip's zoom actually animates
  frame-to-frame (caught and fixed a bug where `bitmap.close()` was
  called before its `width`/`height` were read for the resize call,
  which zeroes an ImageBitmap's dimensions and collapsed every frame to
  the same degenerate 0×0 resize).
- [x] Move LZW + GIF assembly into an encode Web Worker — done in Phase 10
  once export needed real progress reporting + cancellation (see Phase 10's
  notes for the worker design)

## Phase 8 — Timeline UI
> Done when: user can scrub through a video frame-by-frame, set in/out
> points, and the export respects them.

- [x] `Timeline.svelte` — horizontal strip, playhead indicator,
  click-to-seek, drag playhead
- [x] Keyboard nav: arrow keys (±1 frame), J/K/L (back/pause/forward),
  Home/End (first/last frame)
- [x] In/out handles: drag to set, or keyboard shortcuts (I/O)
- [x] Lazy thumbnail strip: decode thumbnails (~160px wide) on demand as
  the visible portion of the timeline changes. Cache decoded thumbnails.
- [x] Seeking logic: `lib/seek.ts` — cache hit returns instantly; cache
  miss decodes fresh from the nearest keyframe through the target with a
  new decoder, caching every frame along the way (so nearby subsequent
  seeks land in that cached sweep). Discovered mid-phase that Chrome's
  `VideoDecoder` requires the first `decode()` call after *any* `flush()`
  to be a keyframe again — undocumented in the spec text but enforced in
  practice — which rules out incrementally continuing one decoder across
  multiple flushes. The original design (persist one decoder, flush after
  each partial forward decode) hit this immediately in testing; the fix
  was to always start from the nearest keyframe on a cache miss rather
  than trying to resume a flushed decoder.
- [x] Export range respects in/out points — decode starts at the nearest
  keyframe at or before the in point (decoder requirement), then lead-in
  frames before the in point are closed and dropped before encoding.
- [x] Busy/idle status indicator (`lib/status.ts`, folded in from the
  previously-deferred ask): a small pill in the header shows whatever
  async work is in flight (seeking, thumbnail decode, preview pipeline,
  export) or "Idle".
- [x] Fixed a GPU race surfaced by rapid scrubbing: overlapping seeks
  could destroy a `GPUTexture` that an earlier seek's resize/quantize
  pipeline was still submitting work against. Fixed with a "latest wins"
  queue in `App.svelte` — `playhead` updates synchronously on every
  request (so the UI and keyboard-nav math never lag), but only the most
  recent target actually runs the GPU pipeline, and only one runs at a
  time.

Verified with Playwright (chromium, real Chrome channel) against four
synthetic clips including one with 8 keyframes and B-frames
(`multikey.mp4`, forced `-g 15`): click-to-seek, drag-to-scrub, drag
in/out handles, all keyboard shortcuts, rapid-fire seeking (no GPU
warnings), forward/backward seeks across GOP boundaries, and an animated
export trimmed to an in/out range confirmed byte-correct via ffprobe
(`nb_frames` matched `out − in + 1` exactly).

## Phase 9 — Quality panel + preview
> Done when: user can adjust resolution, FPS, dither on/off, and loop
> count via UI controls. Preview updates within ~100ms of the last
> slider change. A/B toggle works.

- [x] `QualityPanel.svelte`:
  - Output resolution: width input with aspect-locked height, common
    presets (480p, 320p, 240p, 160p — buttons, not a dropdown; custom
    width via the number field). Width is the driving dimension per
    `lib/quality.ts`'s `targetWidth`, height always derived from source
    aspect ratio — flipped from Phase 4–8's height-driven
    `RESIZE_PRESETS`, per this phase's own checklist wording.
  - Output FPS: range input, 1–60, defaults to source FPS on file load
    (`resetQualityForSource`)
  - Dither: toggle (blue-noise / none) — threaded all the way into
    `quantize.wgsl` as a uniform flag (`Params.ditherEnabled`), not just
    a UI-only checkbox; disabled skips the blue-noise sample entirely
  - Loop count: infinite / 1 / N (N via a number field)
- [x] `quality` store (`lib/quality.ts`) — first real Svelte store in the
  codebase, scoped to just quality state as flagged in the handoff.
  Reactive; App.svelte subscribes and drives pipeline re-runs off it.
- [x] `Preview.svelte`:
  - Two stacked canvases (source + quantized), `clip-path: inset()`
    toggled by mode
  - A/B split mode: drag the divider (pointer events) to compare
  - Mode toggle: source-only / quantized-only / split
- [x] Debounced pipeline: quality-store subscription in App.svelte
  waits 100ms after the last change, then calls a generalized
  `runQualityPipeline()` (replaces the old preset-only `runResize`).
  Both this and playhead seeks now go through a shared "latest wins"
  queue (`requestPipelineRun`/`runPipelineLoop`), mirroring Phase 8's
  seek queue — needed because a seek-triggered and a debounce-triggered
  pipeline run can otherwise race the same way overlapping seeks did
  (a later run's texture `destroy()` firing while an earlier run is
  still submitting GPU work against it).
- [x] Speed control: range input, 0.25×–4×, scales export frame delay
  (`delayCs = round(100 / fps / speed)`)
- [x] Output FPS is a real independent control, not just a delay-value
  change: `exportAnimatedGif` resamples decoded frames to the target
  rate by nearest-neighbor lookup on a synthetic timeline built from
  cumulative `VideoFrame.duration` (drops/duplicates frames as needed).
  Deliberately not `VideoFrame.timestamp` (presentation time) — this
  codebase indexes frames by chunk/decode-order position everywhere
  (Timeline, `seek.ts`, in/out trim), and for a range trimmed out of a
  B-frame stream the last chunk in the slice can carry a presentation
  timestamp far ahead of its decode-order neighbors, which threw off an
  earlier timestamp-based version of this calculation (caught via the
  `multikey.mp4` test clip — first attempt exported 24 frames for an
  exact 21-frame in/out range at matching fps; `.duration` stayed
  uniform where `.timestamp` didn't, so the fix was cumulative-duration
  instead of raw timestamps).

Verified with Playwright (chromium, real Chrome channel): resolution
presets and custom width, FPS/speed sliders, dither toggle (confirmed
visually — dithered region shows blue-noise grain, non-dithered is flat),
loop count (infinite/1/N), Preview's three modes and drag-to-compare
divider, and exported GIF bytes checked directly (dimensions, frame
count, Netscape loop count, frame delay) against the active quality
settings on both a plain clip (`bars.mp4`) and the `multikey.mp4`
B-frame/multi-keyframe clip trimmed to an in/out range. Also re-ran a
rapid-scrub-while-changing-quality storm on `multikey.mp4` (mirroring
the Phase 8 GPU-race regression test) — settled cleanly to Idle, no
console errors, no GPU validation warnings.

## Phase 10 — Size estimation + export polish
> Done when: a size estimate displays before encoding and updates live
> with quality changes. Export shows progress and produces a correct GIF.

- [x] `lib/estimate.ts`:
  - Pick ~8 evenly-spaced frames from in/out range
  - Run full pipeline + LZW on each (reuse encode worker)
  - Average bytes/frame × total frames + header overhead
  - Re-estimate on quality/timeline change (debounced)
  - Frame sampling uses `seeker.seekTo(index)` (cache-aware, per-frame)
    rather than a bulk `decodeAllFrames` over the whole range — cheaper for
    long clips where only ~8 of possibly hundreds of frames are needed.
    Total output frame count is approximated from `rangeFrameCount ×
    avgFrameDurationUs` (the mean chunk duration already tracked in
    `App.svelte`) rather than the exact cumulative-duration timeline
    `exportAnimatedGif` builds — good enough for an estimate, and avoids
    decoding the full range just to measure its duration.
  - Each estimate run gets its own throwaway `EncodeWorkerClient` (spun up
    and terminated per call) rather than sharing the real export's worker
    instance — avoids interleaving two logical encodes' state if a
    debounced re-estimate and a real export ever overlap.
- [x] `SizeEstimate.svelte` — display estimated size (KB/MB), frame
  count, output dimensions, output duration. Also surfaces the >500-frame
  warning (see edge cases below).
- [x] `ExportBar.svelte`:
  - Encode button (disabled during encode)
  - Progress bar (% of frames processed)
  - Cancel button (abort encode, clean up)
  - Download link appears on completion (object URL held open — not
    revoked immediately like the single-frame export's — so the link
    stays clickable after the auto-triggered download)
- [x] Encode pipeline: sequential decode through in/out → GPU pipeline →
  post indices + palette to encode worker → worker streams GIF bytes
  into a Blob → trigger download. Built the encode Web Worker this phase
  (Phase 7's deferred item) rather than main-thread yielding — a
  deliberate choice, confirmed with the user first, since a real
  responsive progress bar + cancel needed the LZW/GIF-assembly work off
  the main thread. `lib/gif.ts` was split into `gifHeader`/`gifFrameBytes`/
  `concatBytes` (composed by `encodeGif` for the still-synchronous
  single-frame export path) so the worker could drive the same
  frame-by-frame assembly incrementally. `lib/encodeProtocol.ts` defines
  the message types; `lib/encodeClient.ts` wraps a worker instance in a
  sequential request/response API (`start`/`encodeFrame`/`finish`) so
  neither `App.svelte` nor `estimate.ts` deal with raw `postMessage`.
  `indices`/`palette` are transferred (not cloned) per frame — both are
  always freshly-allocated, byte-offset-0 typed arrays by construction, so
  transfer is safe zero-copy.
- [x] Handle edge cases: zero-length selection (in/out clamped so this
  can't actually happen — `handleSetIn`/`handleSetOut` keep in ≤ out), a
  true single-frame selection (in === out, produces a 1-frame GIF — no
  special-casing needed, `outputFrameCount` already floors to 1), very
  long clips (`SizeEstimate` shows a warning above 500 output frames,
  matching the checklist's own threshold).
- [x] Cancellation: `AbortController` per export run, checked between
  pipeline stages each frame iteration (mirrors the per-iteration
  `resizedTexture.destroy()`/`srcTexture.destroy()` pattern already in
  the export loop — any GPU texture created before the cancel point is
  destroyed, never leaked). Found and fixed a real leak surfaced by
  Playwright's console-error watching: cancelling mid-export left
  not-yet-processed `VideoFrame`s (indices past the break point that
  were pre-counted as "used" but never converted to a bitmap) unclosed —
  `"A VideoFrame was garbage collected without being closed"` in the
  console. Fixed with a post-loop sweep that closes any used index not
  already in the bitmap cache — a no-op on a completed run (everything
  used already went through `getBitmapFor`), real cleanup on a cancelled
  one.

Verified with Playwright (chromium, real Chrome channel) against a new
long synthetic clip (`mandelbrot`, 480×270 @ 24fps, 35s, ~840 frames) plus
the existing `bars.mp4`/`multikey.mp4`: size estimate appears and changes
with a resolution-preset change, animated export via the worker produces
a byte-valid GIF89a (header/dimensions/GCE-count/loop-count/trailer
checked directly, `nb_frames` cross-checked with ffprobe against the
output frame count), the >500-frame warning shows on the long clip,
progress bar advances during encode (confirmed over a multi-second
window — this dev environment's headless Chrome falls back to
SwiftShader software rendering, much slower than real hardware, so the
window was widened accordingly), cancel mid-export leaves no stale
download link and returns cleanly to Idle, and a true single-frame (in
=== out) selection exports successfully through the same worker path.
Also re-ran the full `npm run check` (0 errors) and `npm run build` +
`vite preview` smoke test (worker bundles as its own chunk in
production, export completes with zero console errors) since Vite's
dev-server vs. production worker bundling is a known place for behavior
to diverge.

## Phase 11 — Integration + polish
> Done when: the tool is end-to-end usable. Drop a video, trim, adjust
> quality, preview, estimate size, export. No crashes on happy path.

- [x] **Decode-buffering fix** (not on the original checklist, but a
  prerequisite the file-too-large warning exposed): `exportAnimatedGif`
  used to call `decodeAllFrames` and hold the *entire* in/out range of
  `VideoFrame`s in memory before any GPU work started (a Phase 7/8
  leftover) — the thing docs/scoping.md's architecture section actually
  meant by "stream sequentially... one frame resident on GPU at a time."
  Confirmed with the user (chose the bigger refactor over a warn-only
  patch). `lib/decode.ts`'s new `decodeFramesStreaming` is an async
  generator with a bounded lookahead (`STREAM_LOOKAHEAD = 8` chunks) —
  the decoder is never fed more than that far ahead of what the consumer
  has taken, so memory is bounded by decoder pipeline depth, not by
  range length. `exportAnimatedGif` now builds its output-fps resampling
  timeline directly from the encoded chunks' own `duration` (no decode
  needed for that), then streams frames one at a time: `tickIndices` is
  non-decreasing, so needed source frames arrive in exactly consumption
  order — at most one decoded frame is ever alive, closed immediately if
  unneeded or right after its bitmap is made. This also deleted the old
  `bitmapCache`/`usedIndices` leak-sweep machinery entirely — with
  nothing buffered ahead, there's nothing left to sweep.
  Found and fixed a real bug via the VFR test clip below: breaking out of
  the `for await` early (once all needed ticks are satisfied, or on
  cancel) calls the generator's `return()`, which resumes right at the
  `yield` and skips the rest of the `while` loop — any `VideoFrame`s the
  decoder had already produced into the internal lookahead buffer but
  never yielded were leaking. Fixed by closing everything left in that
  buffer in the generator's `finally`.
- [x] Error handling:
  - Unsupported codec: `lib/decode.ts`'s `isDecodeConfigSupported` wraps
    `VideoDecoder.isConfigSupported()`, checked in `App.svelte`'s
    `handleFile` right after demux, before the seeker is created —
    surfaces a specific "this browser can't decode it, try re-encoding to
    H.264" message instead of a generic downstream failure.
    `demux.ts`'s existing no-avcC/hvcC throw also got a friendlier
    message. `DropZone.svelte` now shows an inline message for a
    non-video file instead of silently no-oping.
  - WebGPU unavailable: now a *blocking* state, not just informational
    text (the gap flagged in the handoff) — `gpuFailed` gates the drop
    zone (`disabled`, including the underlying `<input>`) and shows a
    dedicated message. Verified by forcing `navigator.gpu` to `undefined`
    via a Playwright init script (browser flags didn't reliably remove
    it) — gating renders correctly.
  - File-too-large warning, both halves per the session-recorded
    decision: (a) a cheap `file.size` check right on drop
    (`FILE_SIZE_WARN_BYTES`, 1GB, non-blocking), and (b) a decoded-range
    byte estimate (`outputWidth × outputHeight × 1.5 × frameCount`) added
    to `SizeEstimate.svelte` alongside the existing >500-frame warning,
    reusing the same `estimate` prop rather than a second reactive block.
    Threshold 1.5GB — untested against a real "browser falls over" case,
    same caveat as the original estimate.
- [x] Loading states: `initialLoading` shows a spinner + "Loading
  video…" from the start of `handleFile` through the first frame's
  seek/pipeline run. Thumbnail generation now shows a sweeping progress
  bar on the timeline track itself (`Timeline.svelte`'s `thumbsLoading`),
  in addition to the existing header status pill.
- [x] Keyboard shortcut help: `?` toggles an overlay (Escape or a
  backdrop click closes it); a small `?` FAB in the corner does the same
  by click. Verified via Playwright.
- [x] Responsive layout: `@media` queries added to `App.svelte`,
  `DropZone.svelte`, `QualityPanel.svelte`, `Timeline.svelte` (this
  codebase's first — previously zero). Verified at a 380px viewport with
  a loaded file: no horizontal scroll.
- [x] Favicon + page title: were already in place from earlier phases
  (`index.html`'s `<title>gif builder</title>` + `favicon.svg`) — no
  change needed.
- [x] Real-world input testing: existing suite was 100% ffmpeg `lavfi`
  synthetic clips, never anything genuinely variable-frame-rate. No
  camera/phone footage available in this environment, so built a
  synthetic VFR clip instead (alternating static/motion segments through
  `mpdecimate` + `-vsync vfr`, producing real non-uniform chunk
  durations — mostly 1/30s with a few multi-second holds) and ran it
  through the full pipeline including export. Output GIF verified
  byte-correct (frame count, uniform per-export delay, loop count) via a
  proper GIF block-structure parser — this is what caught the
  decode-buffering leak above.
- [x] Performance check: structural profiling (SwiftShader-only sandbox,
  see below, makes wall-clock numbers non-representative of real
  hardware — treated as smoke-test signal, not a real measurement).
  Per-frame export cost breaks down as: hardware decode (already
  overlapped with GPU work via the new streaming lookahead) → resize
  (2-pass Lanczos compute) → histogram dispatch + CPU readback →
  CPU median-cut → quantize dispatch + CPU readback → encode-worker
  round-trip (LZW, off main thread). Identified bottleneck: the export
  loop `await`s the encode worker's ack before starting the next frame's
  GPU work, serializing two stages that run on different threads and
  could otherwise overlap (GPU work for frame N+1 while the worker
  LZW-compresses frame N) — not fixed this phase (scoping.md's own
  architecture explicitly calls for one frame resident at a time, and
  this is a genuine future optimization, not a Phase 11 blocker). GPU
  readbacks (`mapAsync` round trips for histogram/quantize) are the other
  likely-expensive stage structurally, though software rendering makes
  exact proportions unreliable here. Confirmed encode doesn't lock the
  UI: measured ~40–60ms/frame at 640×480 under SwiftShader across
  `bars.mp4` (20 frames) and `multikey.mp4` (120 frames, B-frames) —
  again a software-rendering number, not a hardware one, but useful as a
  no-hang/no-freeze signal.

Verified with Playwright (chromium, real Chrome channel): full suite
re-run against `bars.mp4`, `multikey.mp4` (B-frames, trimmed in/out),
the new `vfr.mp4`, and `long.mp4` (840 frames, cancel-path leak check) —
zero console/page errors across the run once the decode-buffering leak
above was fixed. All exported GIFs checked with a real block-structure
GIF parser (not a naive byte scan — the first version of that parser
produced false-positive GCE matches inside LZW-compressed data, which
would have masked the real leak; ffprobe/PIL frame counts and delays
cross-checked to confirm). Shortcut overlay open/close, narrow-viewport
layout (no horizontal scroll at 380px), invalid-file-type messaging, and
forced-WebGPU-unavailable gating all verified directly. `npm run check`
(0 errors) and `npm run build` + `vite preview` smoke test (worker still
bundles as its own chunk, export completes with zero console errors)
also re-run per the Phase 10 precedent for dev/prod divergence.

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
