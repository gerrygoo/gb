# Scoping — WebM Export Mode

Working doc for the `gb.ggo.blue/webm` sibling app. Decisions live here;
open questions marked **[?]**. Companion to `docs/scoping.md` (GIF) — read
that first for the shared decode/resize pipeline this reuses.

## Vision

Same tool, same trim/resize/preview UX, different output tail. Where the
GIF app quantizes to an indexed palette and LZW-encodes, the WebM app
hands resized frames straight to `VideoEncoder` (VP9) and muxes them —
no palette, no dither, no 256-color ceiling. Trades GIF's "works
everywhere, including Slack/email" for real photographic quality at a
fraction of the file size.

## Decided (from user scoping conversation, 2026-07-23)

- **Codec**: VP9 only for v1. Universal WebCodecs encode support, no
  software-encode slowdowns like AV1. Codec string lives in one config
  spot so AV1 can be added later without a rewrite.
- **Audio**: video-only, matching the GIF app's existing non-goal. No
  `AudioDecoder`/`AudioEncoder`, no audio track in the muxed output.
- **Reuse strategy**: extract the GIF app's shared orchestration (file
  load → demux → decode → seek/timeline → GPU-resize preview) into a
  `PipelineShell.svelte` **before** starting WebM-specific work, so both
  apps build on one implementation instead of forking `App.svelte`. This
  is Phase 14 in `docs/plan.md` and blocks everything else here.
- **Muxer**: [`mediabunny`](https://mediabunny.dev) rather than
  `webm-muxer` — same author, `webm-muxer` is deprecated in its favor.
  Tree-shakable (~11.4kB gzipped for WebM writing), pure TypeScript, zero
  deps. Used only for its WebM `Output`/muxer half; `mp4box.js` stays the
  demuxer for input — not in scope to consolidate onto Mediabunny's
  demux side here.
- **Deployment**: Vite multi-page build, not a client-side router. A
  second `webm/index.html` entry alongside the root `index.html`, both
  built by the existing single `npm run build` / GitHub Pages workflow.
  Static MPA output means `gb.ggo.blue/webm/` just works on GitHub Pages
  without SPA-fallback tricks.

## Reused as-is from the GIF app

| Module | Why it carries over unchanged |
|---|---|
| `lib/demux.ts` | Container demuxing is format-agnostic — same MP4/MOV input either way. |
| `lib/decode.ts`, `lib/seek.ts` | WebCodecs decode + keyframe-index seeking doesn't care what the output format is. |
| `lib/gpu.ts`, `lib/resize.ts`, `shaders/resize.wgsl` | Lanczos-3 resize is upstream of the format split — WebM wants resized frames just like GIF does. |
| `lib/status.ts`, `lib/format.ts`, `lib/sampling.ts` | Generic busy-state tracking and byte formatting. |
| `Timeline.svelte`, `DropZone.svelte`, `Preview.svelte` (source side), `SizeEstimate.svelte` (shell) | UI chrome; only the quantized-preview half of `Preview.svelte` and the estimate math are GIF-specific. |
| `quality.ts`'s `computeOutputDims`/`presetWidthFor`/resolution+fps+speed concepts | Same resolution/fps/speed knobs apply; palette/dither fields don't. |

## Not reused — GIF-only, stays out of the WebM path entirely

`lib/palette.ts`, `lib/quantize.ts`, `lib/histogram.ts`, `lib/blueNoise.ts`,
`lib/globalPalette.ts`, `lib/gif.ts`, `lib/lzw.ts`, `shaders/histogram.wgsl`,
`shaders/quantize.wgsl`, `encodeWorker.ts`/`encodeClient.ts`/
`encodeProtocol.ts` (GIF-specific message shapes — indices + palette).
WebM gets its own encode worker/client/protocol carrying resized frames,
not palette indices.

## New for WebM

### Pipeline

```
File
 → Demux (mp4box.js — unchanged)
 → WebCodecs VideoDecoder → VideoFrame
 → [Resize] Lanczos compute shader → GPUTexture at target res (unchanged)
 → resized GPUTexture → canvas/ImageBitmap → new VideoFrame(..., { timestamp })
 → VideoEncoder (VP9) → EncodedVideoChunk
 → Mediabunny WebM muxer → .webm Blob → download
```

No quantize/dither/palette stage — that's the whole point.

### Quality knobs (WebM-specific `WebmQualityPanel.svelte`)

- **Resolution / FPS / Speed** — same rows, same `quality.ts` helpers as
  GIF.
- **Bitrate** — kbps slider, bitrate-target mode
  (`VideoEncoderConfig.bitrate`). Chosen over quantizer/CRF mode for v1
  because size estimation is then pure arithmetic and reliable across
  browsers; CRF-style `bitrateMode: 'quantizer'` support is less
  consistent. Revisit if bitrate-target quality proves unpredictable in
  practice.
- **Keyframe interval** — GOP length, affects seekability + compression
  efficiency. Simple "every N frames" or "every N seconds" field.
- **No loop count** — WebM has no native loop metadata (unlike GIF's
  Netscape extension); playback looping is a consumer/embed concern.
  Row is dropped, not disabled.

### Size estimate

Trivial compared to GIF's sample-8-frames-and-extrapolate approach:
`bitrate_kbps * duration_s / 8 * 1000` bytes + a small constant for muxer
overhead. No sampling pass needed — bitrate-target mode makes this exact
enough that `estimate.ts`'s GIF machinery doesn't need to be touched or
reused.

### Frame timing

GIF's export loop tracks a per-frame delay in centiseconds; WebCodecs
`VideoEncoder` wants monotonically increasing microsecond
`timestamp`/`duration` per frame instead. Speed changes (q-equivalent of
GIF's speed knob) need to scale the timestamp stream, not a discrete
per-frame delay field — this is a real (small) divergence from how the
GIF export loop applies speed, not a drop-in reuse.

### Open question **[?]**

`VideoFrame` transfer to a worker: need to confirm `VideoFrame` survives
`postMessage` transfer (it implements the transferable/serializable
contract per spec, but worth a quick real-browser check before assuming
the GIF app's main-thread/encode-worker split ports over directly — may
need to encode on the main thread instead if transfer proves unreliable).

## Non-goals (v1)

- Audio passthrough (decided above).
- AV1 / VP8 codec options (decided above — VP9 only).
- Alpha/transparency — same blocker as GIF's q8: current input path
  (WebCodecs `VideoFrame`) is opaque, no alpha-bearing source exists yet.
- Two-pass encoding.
- Quantizer/CRF quality mode (bitrate-target only, see above).

## Deployment

- `vite.config.ts`: `build.rollupOptions.input` gets a second entry,
  `webm/index.html`, alongside the existing root `index.html`.
- New `src/webmMain.ts` mounts `WebmApp.svelte` the same way `main.ts`
  mounts the GIF app.
- Small cross-links between the two apps ("Export as WebM instead →" /
  "← Export as GIF instead") so each is discoverable from the other —
  GitHub Pages won't have a shared nav shell otherwise.
- Existing GitHub Pages workflow (`npm run build` → `upload-pages-artifact`
  on `dist/`) needs no changes — Vite's multi-page output already lands
  `dist/webm/index.html` in the right spot for `gb.ggo.blue/webm/`.
