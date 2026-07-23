# CLAUDE.md

## Project

Browser-based video-to-GIF/WebM creation tool, deployed as two sibling
apps sharing one pipeline: `gb.ggo.blue/` exports GIF, `gb.ggo.blue/webm/`
exports WebM (VP9). See `docs/scoping.md` for the GIF app's design
decisions, `docs/webm-scoping.md` for the WebM app's, and `docs/plan.md`
for the phased implementation plan covering both.

## Workflow

Solo developer repo. Push directly to `main`. Do not create pull requests
unless explicitly asked.

## Tech stack

Vite (multi-page build) + TypeScript + Svelte, WebCodecs, WebGPU,
mp4box.js (demux), Mediabunny (WebM mux).
