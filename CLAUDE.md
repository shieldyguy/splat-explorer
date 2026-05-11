# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Dev / deploy

- No build step. Pure static — ES modules + importmap, Three.js + Spark loaded from CDN.
- Local: `python3 -m http.server 8000` (any static server works), then open `http://localhost:8000`.
- Deploy: connect to Vercel (or any static host) — no config, just push.

## URL flags

- `?p=<base64>` — load a shared preset (decoded by `preset.js`). Stripped from the URL after apply so refresh / "swap splat" doesn't re-trigger.
- `?vanilla` — bypass the entire customization pipeline (custom shaders, FBO, outline pass, palette modifier, debug pane). Routes to `createVanillaSplatViewer` for diagnosing whether a rendering issue is ours or Spark's.
- `?debug` — force the debug panel on (it's already on by default for this page via `<body data-debug>`).

## Architecture

Single-viewer playground. `splat.js` owns the lifecycle (one viewer at a time, `disposeCurrent()` before swap). `splat-viewer.js` builds the renderer/scene/camera/controls + post-process; `setupDebugPanel` wires every uniform to a slider/toggle.

**Two-pass render pipeline** (non-vanilla):
1. Scene → MRT `WebGLRenderTarget` (color at attachment 0, packed view-space normal at attachment 1, depth texture). Custom Spark splat shaders (`splat-shaders.js`) are near-verbatim copies of Spark 2.0's `splatVertex.glsl` / `splatFragment.glsl` with three additions: emit per-splat view-space normal, alpha-threshold discard so depth/normal only write at "solid" splat surfaces, MRT outputs.
2. Fullscreen quad (`outline-pass.js`) samples color + depth + normal, runs Sobel on both depth and normal, mixes via `uEdgeMix` (0=depth, 1=normal), composites outline over scene.

**Spark config that matters** (`splat-viewer.js`): `depthWrite: true` + `sortRadial: false`. The combination is load-bearing — `depthWrite` alone with the default radial sort writes depth out of strict z-order and culls later splats that are actually farther, which produces a chunky hard-edged look. Strict back-to-front sort + depth write fills the depth buffer correctly without breaking alpha accumulation.

**Per-splat color quantization** (`splat-modifier.js`): a Spark `dyno.Dyno` modifier on the `SplatMesh.objectModifier` slot. RGB → HSV → bucket-quantize hue and tone independently → RGB. Mutating uniforms requires `splat.updateVersion()` to re-bake.

**Render-on-demand**: viewer is event-driven, not RAF-driven. `controls.change` and `resize` call `scheduleRender()`; renders are throttled to `frameInterval` (12fps default, 24fps in `splat.js`). A 100ms `setInterval` polls during initial load and clears after 15s.

**Loading**: `SplatMesh` accepts `url` (worker-fetched, gets `onProgress` callbacks) or `fileBytes: Uint8Array` (decoded directly). Drag-drop / file-picker uses `fileBytes` — bypasses the worker-fetch path because blob URLs surviving the worker boundary is flaky. Demo URLs are absolutized via `new URL(path, location.origin).href` for the same reason.

**Settings inheritance across swaps**: when the user swaps splats, `splat.js` snapshots the outgoing viewer's settings (via `encodePresetFromViewer` → `decodePreset`) and re-applies to the incoming viewer with `keepCamera: true` so the user's lens carries forward but the new splat's framing is preserved. `defaultsPreset` is captured from the very first viewer's untouched uniforms — that's what "Restore defaults" returns to.

## Preset URL format (`preset.js`)

Fixed 47-byte binary layout, URL-safe base64 (~62 chars). Versioned (currently v1, byte 0). Byte 1 is `demoIndex` into the `DEMOS` array.

**Critical**: when adding entries to `DEMOS` in `splat.js`, **only append** — never reorder or delete — or old shared `?p=` links will point at the wrong splat. To extend the schema: bump `VERSION` and `BYTE_LEN`, branch in the decoder, keep the v1 path intact.

User-loaded files (drag-drop) share as `demoIndex: 0` (Pebbles) — the share carries the lens, not the splat.

## Demo splats

Big `.ply` files live on Cloudflare R2 (zero-egress hosting). The small `pebbles.ply` is in the repo so the homepage loads instantly without a network hop. R2 base URL is hardcoded in `splat.js`.
