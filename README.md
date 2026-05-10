# splat-explorer

Interactive Gaussian-splat playground. Live: [splat.lunchfirm.com](https://splat.lunchfirm.com).

A real-time tool for non-photorealistic rendering of `.ply` Gaussian-splat
files. Pick a demo or drop in your own `.ply`, then tune dozens of shape,
shading, and outline parameters to find a look. Share what you find via
copy-link.

## Features

- **Pick a demo** or drag-and-drop your own `.ply` (Gaussian-splat format
  only — point clouds won't render).
- **Custom splat shaders** for shape (ellipse / stadium / rectangle /
  diamond / leaf / brush), screen-space size clamps, alpha threshold,
  isotropy, and falloff control.
- **Outline post-process** with depth + normal-buffer edge detection.
- **HSV palette quantization** for poster-style color limiting.
- **Shareable preset URLs** — every slider state encodes to ~62 chars
  in `?p=...`.
- **Always-on debug pane** for live tuning.
- **Vanilla mode** at `?vanilla` — bypasses all customizations and
  renders Spark default, useful for diagnosing rendering issues.

## Tech

- [Three.js](https://threejs.org/) + [Spark](https://sparkjs.dev/) for
  Gaussian-splat rendering, both loaded from CDN via importmap (no build
  step).
- Pure static — index.html + a few `.js` modules served as-is.
- Big demo splats live on Cloudflare R2 (zero-egress hosting); URLs
  baked into `splat.js`'s `DEMOS` array.

## Local dev

Any static-file server works. Easiest:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Deploy

Pure static — Vercel (or anywhere that serves static files) auto-detects
and deploys with no config. Just connect the repo and push.

## Files

- `index.html` — page shell + importmap + debug panel + picker overlay
- `splat.js` — entry point: picker UI, file load, URL preset decode
- `splat-viewer.js` — viewer factory + debug panel setup
- `splat-shaders.js` — custom GLSL splat vertex + fragment shaders (MRT)
- `outline-pass.js` — fullscreen post-process for depth / normal Sobel
- `splat-modifier.js` — Spark dyno modifier for HSV palette quantization
- `preset.js` — binary preset encode / decode for shareable URLs
- `debug.js` — minimal debug-panel widget library (sliders / colors /
  toggles / etc.)
- `pebbles.ply` — the small built-in Pebbles demo
