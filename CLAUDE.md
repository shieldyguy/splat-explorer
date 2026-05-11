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
- **Diagnostic flags** (one per pipeline variable, used by the DIAGNOSTICS section in the debug panel): `customFrag`, `customVert`, `depthWrite`, `strictSort`, `mrt`, `passthrough`, `twoPass`. Default values live in `DIAG_DEFAULTS` in `splat.js`. Toggling a checkbox in the panel sets the param and reloads the viewer with that one variable changed; flags at default are stripped from the URL. Useful for hunting regressions or A/B-ing pipeline variants.

## Architecture

Single-viewer playground. `splat.js` owns the lifecycle (one viewer at a time, `disposeCurrent()` before swap). `splat-viewer.js` builds the renderer/scene/camera/controls + post-process; `setupDebugPanel` wires every uniform to a slider/toggle.

**Three-pass render pipeline** (default, when `twoPass=true`):
1. **Color pass** → single-attachment `colorTarget` FBO. Three's `renderer.state.buffers.depth` is masked off (`setMask(false)`, `setTest(false)`) so splats alpha-integrate cleanly with no depth-test culling. This is the visible image — wacky shapes, custom alpha, palette quantization, all of it.
2. **Geometry pass** → MRT `outline.renderTarget` (normal at attachment 1, depth texture). Depth is re-enabled with `LessEqualDepth` so the closest passing fragment wins per pixel, giving a clean "front-surface" depth + normal buffer for edge detection. Color attachment 0 also gets written but the composite ignores it.
3. **Composite pass** → canvas. `outline-pass.js`'s fullscreen quad samples color from `colorTarget`, depth and normal from the MRT, runs Sobel on both, mixes via `uEdgeMix` (0=depth, 1=normal), composites outline over scene.

**Why two passes**: a single-pass render with `depthWrite=true` causes depth-test culling to drop translucent splat contributions that should integrate, producing bright halos around splats. Strict z-sort masks the symptom but introduces orbit flicker (sort flips on near-coincident splats). The two-pass split decouples the "I need a clean color" requirement from the "I need a depth buffer" requirement and resolves both. Spark caches `depthWrite` at construction so we can't toggle it at runtime — instead we construct with `depthWrite: true` (capability on) and gate it per-pass via Three's renderer state buffer API.

**Custom Spark splat shaders** (`splat-shaders.js`): near-verbatim copies of Spark 2.0's `splatVertex.glsl` / `splatFragment.glsl` with three additions: emit per-splat view-space normal as a flat varying, alpha-threshold discard so depth/normal only write at "solid" splat surfaces, MRT outputs (`fragColor` at location 0, packed `fragNormal` at location 1).

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
