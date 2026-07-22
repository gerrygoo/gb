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

- [ ] Palette size control (q4): `QualityPanel.svelte` slider/number input,
  2–256 (default 256). `palette.ts`'s median-cut already recurses to a
  target count — confirm it takes `N` as a parameter rather than
  hardcoding 256 splits; if not, generalize it. `quantize.wgsl` currently
  loops a fixed 256-entry palette for nearest-match brute force — needs
  the count passed as a uniform and the loop bound made dynamic.
- [ ] Global palette (q5): new toggle alongside the existing per-frame
  behavior. Accumulate a histogram across several sampled frames from the
  in/out range (reuse `estimate.ts`'s ~8-frame sampling strategy) instead
  of per-frame, produce one palette, reuse it for every frame's quantize
  pass. GIF side: write a single global color table in the logical screen
  descriptor instead of a local color table per frame (`gif.ts` already
  supports both per the GIF89a spec — confirm/wire the global-table path
  through `gifHeader`/`gifFrameBytes`). Tradeoff worth surfacing in the UI:
  better temporal coherence (less flicker), possible banding across scene
  changes — no special-casing needed for scene detection, just document
  the tradeoff.
- [ ] Bayer dither (q6): add an 8×8 ordered Bayer matrix as a second dither
  option alongside blue-noise. `quantize.wgsl`'s dither param moves from a
  bool to an enum (`none` / `blue-noise` / `bayer`); bake the Bayer matrix
  the same way `blueNoise.ts` bakes its texture. `QualityPanel.svelte`'s
  toggle becomes a 3-way choice.
- [ ] Color space toggle (q7): option to do the quantize-stage nearest-color
  distance calculation in linear light instead of sRGB. Needs an
  sRGB→linear conversion in `quantize.wgsl` before distance comparison
  (and likely in `histogram.wgsl` too, so the palette itself is built in
  the same space it's matched in — otherwise the two stages disagree on
  what "nearest" means). Verify visually: linear-space quantization should
  reduce banding in dark gradients specifically (that's the classic
  sRGB-quantization artifact) — a synthetic dark-gradient test clip is
  worth adding if one doesn't already exist.
- [ ] Transparency (q8): alpha threshold control. Caveat to confirm before
  building: current input path is video-only (WebCodecs `VideoFrame`s),
  which are opaque — there's no alpha channel to threshold unless/until an
  alpha-carrying source exists (e.g., VP9 with alpha, or the deferred
  image-sequence input). Worth checking with the user whether to build the
  UI/pipeline plumbing now against a synthetic alpha test source, or defer
  this item until an alpha-bearing input path actually exists.

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
