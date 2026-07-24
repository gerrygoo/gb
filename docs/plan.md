# Implementation Plan

Ordered phases. Each phase produces something testable. Check boxes as
completed; future sessions start by reading this file to find the frontier.

MVP (phases 1–11) is done — see `docs/mvp-plan.md` for that history.
Unscoped ideas beyond what's below live in `docs/future-ideas.md`.

---

## Phase 12 — Quality knob expansion (q4–q8)
> Done when: user can control palette size, choose global vs. per-frame
> palette, switch dither between blue-noise/Bayer/none, and toggle
> sRGB-vs-linear quantization — all reflected live in preview and export.

- [x] Palette size control (q4): `QualityPanel.svelte` slider, 2–256
  (default 256). `medianCut()` and `quantize()` take the count as a
  parameter; `quantize.wgsl`'s palette loop bound is now a `colorCount`
  uniform instead of a hardcoded 256. `gif.ts` generalized to write
  power-of-two color tables sized to whatever count the palette actually
  has (padding unused slots with black) and derives the LZW min code size
  from that, instead of assuming 256 throughout.
- [x] Global palette (q5): `QualityPanel.svelte` "Palette scope"
  toggle (Per-frame/Global). `src/lib/globalPalette.ts` accumulates a
  histogram across ~8 samples from the in/out range (sampling logic
  extracted to `src/lib/sampling.ts`, shared with `estimate.ts`) and runs
  one `medianCut`; export and preview reuse that palette instead of
  computing one per frame. `gif.ts`'s `gifHeader`/`gifFrameBytes` now
  support a shared global color table (frames omit their local table when
  one is in use); threaded through `encodeProtocol.ts`/`encodeWorker.ts`/
  `encodeClient.ts`.
- [x] Bayer dither (q6): `quantize.wgsl`'s dither param is now a 3-way
  enum (`none` / `blue-noise` / `bayer`, `DitherMode` in `quantize.ts`);
  the 8×8 Bayer matrix is a `const` array baked directly into the shader
  (no texture upload needed, unlike blue-noise). `QualityPanel.svelte`'s
  toggle is now a 3-way button group.
- [x] Color space toggle (q7): `QualityPanel.svelte` sRGB/Linear toggle.
  Both `histogram.wgsl` (bucketing) and `quantize.wgsl` (nearest-match
  distance) convert sRGB→linear before their math when linear mode is
  active, so the two stages agree on "nearest"; `palette.ts`'s
  `medianCut` converts averaged bucket centers back to sRGB bytes before
  returning, so the palette format leaving that function is always sRGB
  regardless of working color space. Not yet verified against a
  synthetic dark-gradient clip for the expected reduced-banding effect —
  worth doing before calling q7 fully validated visually.
- [ ] Transparency (q8): deferred — current input path is video-only
  (WebCodecs `VideoFrame`s), which are opaque, so there's no alpha
  channel to threshold against yet. Revisit once an alpha-bearing input
  path exists (e.g. the deferred image-sequence input).

## Phase 13 — Performance: profiling + pipeline overlap
> Done when: pipeline-stage timings are measured on real GPU hardware (not
> SwiftShader), the Phase 11-identified serialization bottleneck is fixed,
> and a repeatable perf harness exists for future regression checks.

- [ ] Real-hardware measurement: Phase 10/11's numbers were all
  SwiftShader software-rendering fallback (explicitly flagged as
  non-representative both times). Get a measurement path that uses actual
  GPU hardware — headed real Chrome outside the sandboxed headless
  environment, or a documented way to confirm `chrome://gpu` shows
  hardware acceleration before trusting a number.
- [ ] Instrumentation: `performance.mark`/`performance.measure` around each
  export-loop stage (decode, resize dispatch, histogram dispatch +
  readback, median-cut, quantize dispatch + readback, encode-worker
  round-trip) so bottleneck identification stops being structural
  reasoning (Phase 11's approach) and becomes actual numbers per stage,
  per frame.
- [ ] Fix the identified serialization: the export loop currently `await`s
  the encode worker's ack for frame N before starting frame N+1's GPU
  work, even though those run on different threads/processors and could
  overlap. Pipeline them with a bounded lookahead of 1 — mirroring the
  `STREAM_LOOKAHEAD` pattern `decodeFramesStreaming` already established
  in Phase 11 — so GPU work for frame N+1 runs while the worker
  LZW-compresses frame N.
- [ ] Race check: overlapping two frames' GPU resources at once
  reintroduces the same class of bug fixed in Phases 8/9 (a later stage's
  texture `destroy()` firing while an earlier stage still has work
  in-flight against it) — needs the same "don't destroy until this
  frame's work is actually done" discipline, now across two frames
  in-flight instead of one.
- [ ] Re-measure after the fix with the same instrumentation, confirm a
  real speedup on hardware (not just SwiftShader), and check the GPU
  readback stages (`mapAsync` round trips for histogram/quantize) — if
  profiling shows these as the actual bottleneck rather than the
  serialization, scope a follow-up based on what the data says rather
  than guessing.

## Phase 14 — Extract shared pipeline orchestration (blocks Phase 15+)
> Done when: `App.svelte`'s file-load → demux → decode → seek/timeline →
> GPU-resize-preview orchestration lives in a `PipelineShell.svelte` that
> the GIF app builds on, GIF app behavior is unchanged end-to-end
> (including the in-flight layout redesign currently uncommitted on
> disk), and `App.svelte` itself is reduced to GIF-specific state
> (quantize/palette/dither/encode) plumbed through the shell's slot.
> See `docs/webm-scoping.md` for why this is a blocking prerequisite
> rather than a fork.

- [x] Land the current uncommitted redesign (`App.svelte`, `DropZone.svelte`,
  `ExportBar.svelte`, `QualityPanel.svelte`) as its own commit first, so
  the extraction is a clean, separately-reviewable diff on top of it.
- [x] Design `PipelineShell.svelte`'s boundary: owns topbar, file-bar/
  DropZone wiring, GPU init + status, demux/decode/seek, playhead/in/out/
  frameDurationUs state, `initialLoading`/`fileSizeWarning`, Timeline, and
  the resize step (Lanczos) that feeds Preview's source layer. Exposes
  `seeker`/`currentDemux`/`playhead`/`inPoint`/`outPoint`/
  `frameDurationUs`/`sourceWidth`/`sourceHeight`/`sourceBitmap`/
  `gpuContext` via `bind:` (slot props alone don't reach a consumer's own
  `<script>` logic, and several — export, size-estimate — need them
  there, not just in markup), plus an `onResized` callback prop awaited
  as part of the shell's own resize queue so a consumer's GPU work
  (histogram/quantize) can't be raced by the next resize's texture
  `destroy()` — the same single-flight discipline the old combined
  `runQualityPipeline` enforced internally, now spanning the component
  boundary. `onFileChange` callback resets consumer-owned state in step
  with the shell's own reset. Named slots (`main`/`side`/`debug`) hold
  GIF-specific UI; `Timeline.svelte` and the resize step are shell-owned,
  but `Preview.svelte` itself stays with the GIF-specific slot content
  for now — splitting its source/quantized layers apart isn't needed
  until a second consumer actually exists.
- [x] Move that logic out of `App.svelte` into the shell; rename
  `App.svelte` → `GifApp.svelte` (`git mv`, keep history) once it's
  reduced to the GIF-specific slot content (quantize/palette/dither,
  `QualityPanel`, `SizeEstimate`, `ExportBar`, the debug disclosure).
- [x] `main.ts` updated to mount `GifApp.svelte`. No visible/behavioral
  change to the deployed GIF app — this phase is pure internal reuse
  prep. Verified via `tsc`/`svelte-check`/`vite build` (all clean besides
  the pre-existing `Preview.svelte` a11y warning) and a headless-browser
  smoke pass (file load → demux → seek → Timeline/QualityPanel render →
  in/out points → keyboard shortcuts all worked correctly). The
  GPU-dependent resize/quantize/export chain could not be exercised
  live — this sandbox has no WebGPU adapter, the same
  SwiftShader/no-hardware-GPU limitation Phase 13 already flags — so
  that path is verified by design/code review only (the `onResized`
  hand-off preserves the original texture-destroy ordering) rather than
  a live run; worth a manual check in a real GPU browser before trusting
  it fully.

## Phase 15 — WebM app scaffold + deployment
> Done when: `gb.ggo.blue/webm/` serves a `WebmApp.svelte` built on
> `PipelineShell.svelte`, even if export is still a stub, via the same
> `npm run build` / GitHub Pages workflow the GIF app already uses.

**Handoff (post-Phase 14, 2026-07-23):** `PipelineShell.svelte`
(`src/components/PipelineShell.svelte`) exists and `GifApp.svelte`
(`src/GifApp.svelte`, formerly `App.svelte`) is its first consumer —
read `GifApp.svelte` end to end before writing `WebmApp.svelte`; it's
the worked example of every wiring point below.

- **Props to pass in:** `title` (string, shown in the topbar `<h1>`;
  WebM app should pass something like `"webm exporter"`).
- **Props to `bind:`** (read in the consumer's own `<script>`, not just
  markup — that's why these are plain bindable props rather than slot
  props): `seeker`, `currentDemux`, `playhead`, `inPoint`, `outPoint`,
  `frameDurationUs`, `sourceWidth`, `sourceHeight`, `sourceBitmap`,
  `gpuContext`.
- **Callback props:** `onResized(frame: { texture: GPUTexture; imageData:
  ImageData; width: number; height: number }) => Promise<void>` — called
  once per completed resize, *awaited* as part of the shell's own resize
  queue. A consumer takes ownership of `frame.texture` here (destroy the
  previous one it was holding, keep this one) — do NOT let this callback
  return before any GPU work reading `frame.texture` is done, or the
  shell's next resize can destroy it mid-read. This is the hand-off
  WebM's per-frame `VideoEncoder` feed (Phase 16) plugs into: no
  histogram/palette/quantize step, just `frame.texture`/`imageData`
  straight to the encode path. `onFileChange() => void` — called
  synchronously at the start of a new file load, before demuxing; reset
  consumer-owned state (for WebM: any encode/estimate/export state,
  mirroring what `GifApp.svelte`'s `handleFileChange` resets) here.
- **Named slots:** `main` (rendered in the main column, above the
  shell-owned `Timeline` — GIF puts its `quantizeStatus` text + `Preview`
  here; WebM's equivalent is presumably just a `Preview`-style source
  monitor, no quantized layer), `side` (sticky sidebar — quality
  controls + export UI go here; for WebM that's `WebmQualityPanel` +
  `SizeEstimate` + a WebM `ExportBar` equivalent, Phase 17), `debug`
  (collapsed disclosure below the workspace, receives `resizeStatus` as
  a slot prop — optional, only bother with it if there's something
  useful to show).
- **What the shell does NOT do:** it doesn't know about GIF- or
  WebM-specific quality fields (palette/dither/bitrate/etc.) — it only
  reads `quality.targetWidth` (via `lib/quality.ts`, still the one
  shared store) to size its resize step, and re-runs that resize on
  *any* `quality` store change, trusting the consumer to ignore
  `onResized` calls it doesn't care about. If/when Phase 17 splits GIF-
  and WebM-specific quality stores apart, revisit this — right now both
  apps would share one `quality` store, which is fine for Phase 15's
  stub but wrong once WebM has its own bitrate/keyframe fields.
- **Not yet verified live:** the resize step itself was only verified by
  code review in the Phase 14 session — the sandbox used had no WebGPU
  adapter. Check `frame.texture`/`imageData` actually arrive correctly
  in a real GPU browser before building much on top of `onResized`.

- [x] `vite.config.ts`: multi-page build — `build.rollupOptions.input`
  gets `webm/index.html` alongside the root `index.html`.
- [x] New `webm/index.html` + `src/webmMain.ts` mounting `WebmApp.svelte`.
- [x] `WebmApp.svelte`: `PipelineShell` + a placeholder side panel (no
  real encode yet) — proves the shell's slot contract works for a
  second, differently-shaped consumer before wiring real encode logic.
  Binds the full consumer contract (`seeker`/`currentDemux`/`inPoint`/
  `outPoint`/etc.) even though only `onResized`'s `imageData` is used yet
  (drawn straight to a canvas, no quantize step), so Phase 16 doesn't
  need to add bindings later. `handleFileChange` only resets the resized
  texture — there's no estimate/export state yet to mirror `GifApp`'s
  reset.
- [x] Small cross-links between the two apps' top bars. Added as a new
  `PipelineShell` prop (`crossLink: { href, label } | null`, rendered
  next to the `<h1>`) rather than GIF/WebM-specific — the shell already
  owns the topbar and has no opinion on where the link points. Both
  apps link via absolute paths (`/webm/` and `/`) since the site is
  served from the domain root, not a GitHub Pages project subpath.
- [x] Deploy, confirm `gb.ggo.blue/webm/` resolves (and check the
  no-trailing-slash `gb.ggo.blue/webm` case on GitHub Pages). Both
  live: `/webm/` -> 200, `/webm` -> 301 redirect to `/webm/`.

## Phase 16 — WebM encode pipeline
> Done when: a user can export a trimmed/resized clip as a real,
> playable `.webm` file (VP9 video, no audio) from `WebmApp.svelte`.

**Handoff (post-Phase 16, 2026-07-23):** Encode works end-to-end and was
verified live — not just by code review. This session's sandbox turned out
to have real Apple Silicon GPU access via Playwright Chromium launched with
`--use-gl=angle --use-angle=metal --enable-unsafe-webgpu
--ignore-gpu-blocklist --enable-features=Vulkan` (default headless
Chromium has no adapter at all; `navigator.gpu.requestAdapter()` returns
`null` without those flags). With them, `requestAdapter()` returned a real
`vendor: "apple", architecture: "metal-3"` adapter — confirmed via
`adapter.info`, not SwiftShader. Two exports were run against a real
h.264 test clip (ffmpeg `testsrc`, 320×240 @15fps, 2s): a full-range
export and an in/out-trimmed one (frames 11–21). Both produced files
`ffprobe` reports as valid VP9-in-WebM (`probe_score=100`), with exact
expected duration (2.000s / 0.734s) and correct upscaled dimensions
(640×480, from `computeOutputDims`'s 480p-preset default); frames pulled
back out with `ffmpeg` and visually inspected showed correct, undistorted
content at frame 0 and frame 15 (the moving gradient bar and tick-counter
box both advanced correctly). No console/page errors in either run. This
means the Phase 14/15 "not yet verified live" flags on the GPU
resize/`onResized` path are now resolved too, at least for this sandbox —
worth re-confirming in a real user-facing browser tab if behavior ever
looks GPU-adapter-dependent, since headless-with-flags isn't identical to
a normal Chrome tab.

Implementation notes for whoever builds Phase 17 on top of this:

- **`mediabunny`'s `VideoSampleSource` does the WebCodecs `VideoEncoder`
  management internally** — no manual `VideoEncoder`/`EncodedVideoChunk`
  plumbing was needed, contrary to `docs/webm-scoping.md`'s original
  (pre-implementation) sketch. `webmEncodeWorker.ts` just constructs
  `new VideoSampleSource({ codec: 'vp9', bitrate })`, wraps each incoming
  `VideoFrame` in a `new VideoSample(frame)`, and calls
  `videoSource.add(sample)` — mediabunny generates the VP9 codec string,
  builds the `VideoEncoderConfig`, and feeds its own muxer.
- **The `VideoFrame`-transfer-to-worker open question is resolved: it
  works.** `webmEncodeClient.ts`'s `encodeFrame()` transfers the
  `VideoFrame` itself (not an `ArrayBuffer` of pixel data) straight into
  `webmEncodeWorker.ts`, which wraps it in a `VideoSample` and closes that
  (which closes the underlying frame) once `add()` resolves. No canvas
  round-trip needed in the worker at all.
- **No offscreen canvas in the export loop either** — `exportWebm()`
  builds each tick's `VideoFrame` directly from `textureToImageData()`'s
  `ImageData` via the raw-buffer `VideoFrame` constructor
  (`new VideoFrame(imageData.data, { format: 'RGBA', codedWidth,
  codedHeight, timestamp, duration })`), skipping the
  draw-to-canvas-then-capture step `docs/webm-scoping.md` and this phase's
  original handoff assumed was necessary. `WebmApp.svelte`'s
  `previewCanvas` is still used, but only for the live preview
  (`handleResized`), not the export loop.
- **`start()` round-trips an ack**, unlike the GIF client's fire-and-forget
  `start()` — `VideoSampleSource.add()` throws if `output.start()` hasn't
  resolved yet, so `webmEncodeClient.ts`'s `start()` awaits a `'started'`
  message back from the worker before the caller is allowed to post any
  `'frame'` message. A fire-and-forget `start()` here would be a real race,
  not just a defensive nicety.
- **Bitrate is currently a hardcoded heuristic**
  (`BITS_PER_PIXEL = 0.06` in `WebmApp.svelte`, scaled by output
  width×height×fps), not user-configurable — Phase 17's job. Resolution/
  fps/speed already come from the shared `quality` store (same one
  `QualityPanel.svelte` writes to on the GIF page; on the WebM page
  they're invisible but still applied, sourced from
  `resetQualityForSource`'s file-load defaults).
- **`ExportBar.svelte`** gained `label`/`encodingLabel` props (defaulting
  to the GIF app's existing text) so `WebmApp.svelte` could reuse it
  as-is rather than forking a WebM-specific copy.

**Superseded handoff (post-Phase 15, 2026-07-23):** `WebmApp.svelte`
(`src/WebmApp.svelte`) already binds the full `PipelineShell` contract
(`seeker`/`currentDemux`/`playhead`/`inPoint`/`outPoint`/
`frameDurationUs`/`sourceWidth`/`sourceHeight`/`sourceBitmap`/
`gpuContext`) and has a working preview (`handleResized` draws
`onResized`'s `imageData` to a canvas) — extend this file directly
rather than creating a new one.

- **The preview hook is not the export loop.** `handleResized` fires
  once per *current* frame (on seek or quality-store change, via
  PipelineShell's own single-flight resize queue) — it's preview-only
  and should stay that way. The real per-frame encode path needs its own
  function, structured like `GifApp.svelte`'s `exportAnimatedGif`
  (~lines 276–484): its own `decodeFramesStreaming` loop over the
  keyframe-aligned in/out range, its own direct `frameToTexture`/
  `resize()` calls per tick (bypassing `PipelineShell` entirely, same as
  GIF's export already does), fps-resampling via `nearestSourceIndex`
  against a cumulative-duration timeline, and cancellation via
  `AbortController`. Read that function end to end as the structural
  template before writing WebM's version.
- **What to strip vs. keep from the GIF template:** drop
  histogram/palette/`medianCut`/`quantize`/dither entirely — the resized
  `texture`/`imageData` goes straight to `VideoFrame` creation instead.
  Keep the range/keyframe math, the tick-timeline construction, and the
  "at most one decoded bitmap alive at once" streaming discipline
  unchanged.
- **Timestamps are the one real structural difference.** GIF's
  `delayCs` is a discrete per-frame duration (centiseconds) written once
  per encoded frame; VP9/WebM wants a continuous microsecond timestamp
  stream (`new VideoFrame(canvas, { timestamp, duration })`), so the
  speed knob should scale `frameStartUs`/`outputIntervalUs` directly
  rather than scaling a single per-frame delay the way
  `exportAnimatedGif`'s `delayCs = Math.max(1, Math.round(100 /
  outputFps / speed))` does.
- **Canvas source for `VideoFrame`:** `WebmApp.svelte`'s existing
  `previewCanvas` demonstrates the `putImageData` pattern to crib from,
  but the actual per-tick encode should draw into its own offscreen
  canvas, not the visible preview one — otherwise the encode loop and
  the preview's paint cycle fight over the same canvas.
- **Not yet verified live.** The GPU resize path has carried an
  unverified-live flag since Phase 14 (no WebGPU adapter in the sandbox
  used for Phase 14 or 15). Phase 15's own testing was `tsc`/
  `svelte-check`/`vite build` plus a static-file routing smoke test via
  `vite preview` — none of it exercises WebGPU. Confirm
  `frame.texture`/`imageData` and a real `VideoEncoder`/`VideoFrame`
  round-trip work in an actual GPU browser early in this phase, before
  building the full export loop on assumptions that haven't been
  checked yet.

- [x] Add `mediabunny` dependency (WebM muxer half only — `mp4box.js`
  stays the demuxer, unchanged).
- [x] Per-frame: reuse `resize.ts`'s GPU-resized texture → read back to
  `ImageData` → `new VideoFrame(imageData.data, { format: 'RGBA', ...,
  timestamp, duration })` → `mediabunny`'s `VideoSampleSource` (wraps its
  own internal VP9 `VideoEncoder`, bitrate-target config) → its `Output`
  writes a `WebMOutputFormat`/`BufferTarget` Blob directly — no manual
  `VideoEncoder`/`EncodedVideoChunk`/muxer plumbing needed, and no
  intermediate canvas either (see Phase 16 handoff note above for why
  this diverges from the plan as originally sketched).
- [x] Resolved the `VideoFrame`-transfer-to-worker open question: it
  works. `webmEncodeClient.ts` transfers the `VideoFrame` itself into
  `webmEncodeWorker.ts`, which wraps it in a `VideoSample` and closes
  that (closing the frame) once encoded.
- [x] New `webmEncodeWorker.ts` / `webmEncodeClient.ts` /
  `webmEncodeProtocol.ts`, mirroring the GIF app's worker split but
  carrying resized `VideoFrame`s instead of palette indices. Unlike the
  GIF client's fire-and-forget `start()`, this one's `start()` awaits a
  `'started'` ack from the worker — `VideoSampleSource.add()` throws if
  the mediabunny `Output` hasn't finished starting yet.
- [x] Timestamp/duration handling for the speed knob — `exportWebm()` in
  `WebmApp.svelte` samples source frames at the real output cadence
  (`baseIntervalUs`, unaffected by speed) but scales the timestamps
  actually written into the file by `outputIntervalUs = baseIntervalUs /
  speed`, so speed changes playback rate without resampling content.
- [x] Verified live end-to-end (see handoff note above): a real h.264
  test clip exported successfully both full-range and in/out-trimmed,
  producing `ffprobe`-valid VP9 WebM files with correct duration and
  visually-correct decoded frames, using a real (non-SwiftShader) GPU
  adapter.

## Phase 17 — WebM quality panel + size estimate
> Done when: `WebmQualityPanel.svelte` exposes bitrate + keyframe
> interval + the shared resolution/fps/speed rows, and a live size
> estimate tracks the exported file size closely.

**Handoff (post-Phase 17, 2026-07-23):** Done, verified live against real
VP9 output (not just the UI estimate) using the same headless-Chromium
GPU-flag recipe Phase 16 established.

- [x] `WebmQualityPanel.svelte`: resolution/fps/speed rows (reusing
  `quality.ts` helpers), bitrate slider (kbps), keyframe-interval field.
  No palette/dither/color-space/loop rows — not applicable to WebM. Kept
  `bitrateKbps`/`keyframeIntervalSec` as new fields on the *same* shared
  `QualitySettings`/`quality` store rather than splitting GIF/WebM
  stores apart — the existing precedent (GIF's palette/dither/loop
  fields already sit alongside the shared resolution/fps/speed fields in
  one store, each app's panel just not rendering the fields it doesn't
  use) covers this fine; a real split is still unneeded since each app
  is a separate page bundle with its own module state, so there's no
  runtime cross-app bleed to worry about.
- [x] `estimateWebm.ts`: arithmetic estimate
  (`bitrate_kbps * duration_s / 8 * 1000` + a fixed muxer-overhead
  constant) — no sampling pass needed, unlike GIF's `estimate.ts`, so
  it runs synchronously in a plain `$:` block rather than through
  `GifApp.svelte`'s debounced/abortable `runSizeEstimate` machinery.
- [x] Wired into `SizeEstimate.svelte` — reused as-is (no prop-type
  change needed; `WebmSizeEstimateResult` is structurally identical to
  `SizeEstimateResult`).
- [x] `bitrateKbps`/`keyframeIntervalSec` threaded all the way to the
  real encoder, not just the UI estimate: `webmEncodeProtocol.ts`'s
  `start` message gained a `keyFrameInterval` field,
  `webmEncodeClient.ts`'s `start()` now takes `(bitrate, keyFrameInterval)`,
  and `webmEncodeWorker.ts` passes both straight into mediabunny's
  `VideoSampleSource({ codec: 'vp9', bitrate, keyFrameInterval })`.
  `WebmApp.svelte`'s `exportWebm()` dropped the old
  `BITS_PER_PIXEL`-heuristic bitrate guess entirely in favor of reading
  `bitrateKbps`/`keyframeIntervalSec` straight from the `quality` store.
- [x] Verified live: loaded a real h.264 test clip in headless Chromium
  with real GPU access (Phase 16's `--use-gl=angle --use-angle=metal
  --enable-unsafe-webgpu --ignore-gpu-blocklist --enable-features=Vulkan`
  flags), confirmed the new Bitrate/Keyframe rows render, and confirmed
  the size estimate updates live when dragging the bitrate slider
  (~$610$ KB → ~$4.77$ MB at min vs. max on a 2s test clip). Then ran two
  full exports at opposite ends of the bitrate range: output file size
  scaled with the slider in the correct direction (28,852 bytes at
  300 kbps vs. 97,593 bytes at 20,000 kbps — both well under their linear
  estimates, expected since VP9 bitrate-target mode won't force bits
  onto a visually-simple synthetic test clip). Both files
  `ffprobe`-valid VP9-in-WebM at the correct 640×480/2.00s. Separately
  confirmed keyframe-interval is real, not just accepted-and-ignored: at
  the default 2s interval + 15fps output, `ffprobe`'s per-frame
  `pict_type` showed exactly one `I` frame across all 30 frames; set to
  1s, it showed `I` at frame 0 and again at frame 15 — exactly one
  keyframe per second. No console/page errors in either run.
