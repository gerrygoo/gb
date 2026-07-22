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
