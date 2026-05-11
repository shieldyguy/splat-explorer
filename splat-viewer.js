import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SplatMesh, SparkRenderer } from "@sparkjsdev/spark";
import { SPLAT_VERT_GLSL, SPLAT_FRAG_GLSL } from "./splat-shaders.js";
import { createOutlinePass } from "./outline-pass.js";
import { createPaletteModifier } from "./splat-modifier.js";
import { encodePresetFromViewer } from "./preset.js";
import * as debug from "./debug.js";

// Build one splat viewer (renderer, scene, camera, controls, post-process,
// modifier) and mount it into parentEl. Returns a viewer object that
// setupDebugPanel can hook into.
//
// Overrides take precedence over splats.json values. Currently supported:
//   minDist, maxDist  — OrbitControls zoom limits
//   pixelRatio        — clamp dpr (default 1.5)
export function createSplatViewer(cfg, parentEl, overrides = {}) {
  // Pipeline flags from the URL/diagnostic panel. Production defaults are
  // set in splat.js's DIAG_DEFAULTS; flipping any of these reloads the
  // viewer with that single variable changed.
  //
  // The default is a two-pass pipeline:
  //   Pass 1 (color)    — depth fully off, splats alpha-integrate cleanly.
  //   Pass 2 (geometry) — depth on, MRT populates normal + depth for the
  //                       outline composite to Sobel against.
  //   Pass 3 (composite)— outline shader reads color from pass 1's target
  //                       and depth/normal from pass 2's MRT.
  // Spark caches `depthWrite` at construction so we can't toggle it at
  // runtime — instead we construct with depthWrite=true (capability on)
  // and mask depth state per-pass via Three's renderer.state buffer API.
  const diag = overrides.diag ?? {};
  const useCustomFrag = diag.customFrag !== false;
  const useCustomVert = diag.customVert !== false;
  const useStrictSort = diag.strictSort === true;
  const usePassthrough = diag.passthrough === true;
  const useTwoPass = diag.twoPass !== false;
  const useMrt = useTwoPass ? true : diag.mrt !== false;
  const useDepthWrite = useTwoPass ? true : diag.depthWrite !== false;

  const section = document.createElement("section");
  section.className = "splat-section";
  const canvas = document.createElement("canvas");
  section.appendChild(canvas);
  parentEl.appendChild(section);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
  });
  renderer.setPixelRatio(
    Math.min(window.devicePixelRatio, overrides.pixelRatio ?? 1.5),
  );

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(cfg.fov ?? 50, 1, 0.1, 100);
  camera.position.set(...(cfg.pos ?? [0, 1, 4]));

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = overrides.enableDamping ?? false;
  controls.enablePan = overrides.enablePan ?? false;
  controls.minDistance = overrides.minDist ?? cfg.minDist ?? 2;
  controls.maxDistance = overrides.maxDist ?? cfg.maxDist ?? 10;
  controls.target.set(...(cfg.target ?? [0, 0, 0]));

  const sparkConfig = {
    renderer,
    depthWrite: useDepthWrite,
    sortRadial: !useStrictSort,
    extraUniforms: {
      alphaThreshold: { value: 0.0 },
      minOpacity: { value: 0.0 },
      splatFalloff: { value: 1.0 },
      splatShape: { value: 0 }, // 0=ellipse 1=stadium 2=rect 3=diamond 4=leaf 5=brush
      splatAspect: { value: 0.5 },
      // Screen-space size controls (pixels, post-projection)
      screenScale: { value: 1.0 },
      screenIsotropy: { value: 0.0 },
      screenMinLength: { value: 0.0 },
      screenMaxLength: { value: 100.0 },
      screenMinWidth: { value: 0.0 },
      screenMaxWidth: { value: 100.0 },
    },
  };
  if (useCustomVert) sparkConfig.vertexShader = SPLAT_VERT_GLSL;
  if (useCustomFrag) sparkConfig.fragmentShader = SPLAT_FRAG_GLSL;
  const spark = new SparkRenderer(sparkConfig);
  scene.add(spark);

  // Always create the outline struct so debug-panel sliders + preset
  // encode/decode keep working regardless of diag.mrt. When MRT is off
  // we just skip the FBO render path; uniforms become inert.
  const outline = createOutlinePass({ width: 1, height: 1 });
  outline.uniforms.uPassthrough.value = usePassthrough;

  // Two-pass mode: a separate single-attachment color FBO captures the
  // splat color (rendered with no depth interaction → proper alpha
  // integration, no flicker, no bright edges). The existing MRT FBO is
  // re-used for the geometry pass (depth + normal). The composite shader
  // samples color from this target and depth/normal from the MRT.
  let colorTarget = null;
  if (useTwoPass) {
    colorTarget = new THREE.WebGLRenderTarget(1, 1, {
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });
    outline.uniforms.tDiffuse.value = colorTarget.texture;
  }

  function resize() {
    const rect = section.getBoundingClientRect();
    const dpr = renderer.getPixelRatio();
    renderer.setSize(rect.width, rect.height, false);
    camera.aspect = rect.width / rect.height;
    camera.updateProjectionMatrix();
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    outline.setSize(w, h);
    if (colorTarget) colorTarget.setSize(w, h);
  }
  resize();
  window.addEventListener("resize", resize);

  // SplatMesh accepts either `url` (fetched in a worker) or `fileBytes`
  // (Uint8Array, decoded directly). We pass whichever the cfg has so user
  // files dropped via the picker can skip the worker-fetch path entirely.
  // overrides.onProgress receives { loaded, total } chunks during URL loads.
  const splat = new SplatMesh({
    url: cfg.file,
    fileBytes: cfg.fileBytes,
    fileName: cfg.fileName,
    onProgress: overrides.onProgress,
  });
  splat.rotation.x = Math.PI;
  scene.add(splat);

  const { modifier: paletteModifier, uniforms: paletteUniforms } =
    createPaletteModifier();
  splat.objectModifier = paletteModifier;
  splat.updateGenerator();

  // --- Render-on-demand (throttled to ~12fps) ---
  let renderPending = false;
  let dampingFrames = 0;
  const FRAME_INTERVAL = overrides.frameInterval ?? 1000 / 12;
  let lastRenderTime = 0;

  function scheduleRender() {
    if (!renderPending) {
      renderPending = true;
      requestAnimationFrame(render);
    }
  }

  function render(now) {
    renderPending = false;
    const elapsed = now - lastRenderTime;
    if (elapsed < FRAME_INTERVAL) {
      if (dampingFrames > 0) scheduleRender();
      return;
    }
    lastRenderTime = now;
    controls.update();

    if (useTwoPass) {
      const depth = renderer.state.buffers.depth;

      // Pass 1 — color: mask depth off so Spark's constructed-with-
      // depthWrite=true setup doesn't cull anything in this pass.
      // Three's state cache calls gl.depthMask(false) / gl.disable(DEPTH_TEST).
      depth.setMask(false);
      depth.setTest(false);
      renderer.setRenderTarget(colorTarget);
      renderer.clear();
      renderer.render(scene, camera);

      // Pass 2 — geometry: re-enable depth so depth+normal populate
      // against the closest passing splat fragment. Color attachment 0
      // of the MRT also gets written but the composite ignores it
      // (tDiffuse points at colorTarget).
      depth.setTest(true);
      depth.setMask(true);
      depth.setFunc(THREE.LessEqualDepth);
      renderer.setRenderTarget(outline.renderTarget);
      renderer.clear();
      renderer.render(scene, camera);

      // Pass 3 — composite to canvas.
      renderer.setRenderTarget(null);
      outline.uniforms.uNear.value = camera.near;
      outline.uniforms.uFar.value = camera.far;
      renderer.render(outline.scene, outline.camera);
    } else if (useMrt) {
      // Pass 1: scene → outline FBO (color + depth)
      renderer.setRenderTarget(outline.renderTarget);
      renderer.clear();
      renderer.render(scene, camera);

      // Pass 2: outline post-process → canvas
      renderer.setRenderTarget(null);
      outline.uniforms.uNear.value = camera.near;
      outline.uniforms.uFar.value = camera.far;
      renderer.render(outline.scene, outline.camera);
    } else {
      // Diag: skip the FBO + composite stack entirely. Render the splats
      // straight to the canvas — closest to vanilla Spark output, but with
      // whatever shader/depth/sort settings the rest of diag dictates.
      renderer.setRenderTarget(null);
      renderer.clear();
      renderer.render(scene, camera);
    }

    if (dampingFrames > 0) {
      dampingFrames--;
      scheduleRender();
    }
  }

  controls.addEventListener("change", () => {
    dampingFrames = 1;
    scheduleRender();
  });

  const origResize = resize;
  resize = function () {
    origResize();
    scheduleRender();
  };

  // Poll at low rate until splat loads, then stop
  const loadPoll = setInterval(() => {
    scheduleRender();
  }, 100);
  const loadPollTimeout = setTimeout(() => clearInterval(loadPoll), 15000);

  function destroy() {
    window.removeEventListener("resize", resize);
    clearInterval(loadPoll);
    clearTimeout(loadPollTimeout);
    section.remove();
    if (colorTarget) colorTarget.dispose();
    outline.dispose();
    renderer.dispose();
  }

  return {
    cfg,
    camera,
    controls,
    renderer,
    section,
    scheduleRender,
    spark,
    outline,
    splat,
    paletteUniforms,
    destroy,
    diag: {
      customFrag: useCustomFrag,
      customVert: useCustomVert,
      depthWrite: useDepthWrite,
      strictSort: useStrictSort,
      mrt: useMrt,
      passthrough: usePassthrough,
      twoPass: useTwoPass,
    },
  };
}

// Share a URL via the best mechanism available, falling back gracefully:
//   1. Web Share API (mobile + modern desktop Safari/Chrome)
//   2. Async Clipboard API (HTTPS / localhost)
//   3. document.execCommand("copy") (everywhere else, e.g. plain HTTP)
async function shareUrl(url) {
  const canWebShare =
    typeof navigator.share === "function" &&
    (typeof navigator.canShare !== "function" || navigator.canShare({ url }));
  if (canWebShare) {
    try {
      await navigator.share({ url });
      return;
    } catch (e) {
      // User dismissed the share sheet — silent. Otherwise fall through.
      if (e && e.name === "AbortError") return;
    }
  }

  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(url);
      debug.flash("Link copied");
      return;
    } catch {
      // Permission denied or non-secure context — fall through.
    }
  }

  // Legacy fallback — selectable textarea + execCommand.
  try {
    const ta = document.createElement("textarea");
    ta.value = url;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    if (!ok) throw new Error("execCommand returned false");
    debug.flash("Link copied");
  } catch {
    debug.flash("Copy failed");
  }
}

// Build the tabbed settings panel for a viewer. No-ops if debug.active is
// false. Sections: Camera · Shape · Palette · Outline (+ Diag when ?diag).
export function setupDebugPanel(viewer, opts = {}) {
  if (!debug.active) return { destroy() {}, rebuild() {} };

  const cameraSec = debug.section("Camera");
  const shapeSec = debug.section("Shape");
  const paletteSec = debug.section("Palette");
  const outlineSec = debug.section("Outline");
  const diagSec = opts.diagMode ? debug.section("Diag") : null;

  const selected = viewer;
  let cancelled = false;

  // Share action — header button. Restore lives in the Camera tab so it
  // can't be tapped by accident next to Share.
  const shareBtn = debug.action("Share", {
    icon: "↗",
    title: "Share link",
    onClick: () => {
      const demoIndex = selected.demoIndex ?? 0;
      const encoded = encodePresetFromViewer(selected, demoIndex);
      const url = `${location.origin}${location.pathname}?p=${encoded}`;
      shareUrl(url);
    },
  });

  // --- Diagnostic toggles (only when ?diag is in the URL) ---
  if (diagSec) {
    const d = selected.diag ?? {};
    // `def` mirrors splat.js's DIAG_DEFAULTS — toggles matching production
    // get stripped from the URL instead of cluttering it with `?key=1`.
    const reloadFlags = [
      { key: "customFrag", label: "Custom frag shader", def: true },
      { key: "customVert", label: "Custom vert shader", def: true },
      { key: "depthWrite", label: "Depth write",        def: true },
      { key: "strictSort", label: "Strict z-sort",      def: false },
      { key: "mrt",        label: "MRT + outline pass", def: true },
      { key: "twoPass",    label: "Two-pass geometry",  def: true },
    ];
    reloadFlags.forEach((f) => {
      diagSec.checkbox(f.label, {
        value: d[f.key] ?? f.def,
        onChange: (on) => opts.onDiagToggle?.(f.key, on, f.def),
      });
    });
    diagSec.checkbox("Composite passthrough", {
      value: d.passthrough ?? false,
      onChange: (on) => {
        if (selected.outline) {
          selected.outline.uniforms.uPassthrough.value = on;
          selected.scheduleRender();
        }
        opts.onDiagToggle?.("passthrough", on, false, { skipReload: true });
      },
    });
    diagSec.button("Reset diagnostics", {
      subtle: true,
      onClick: () => opts.onDiagReset?.(),
    });
  }

  function rebuildControls() {
    const { camera, spark, outline, splat, paletteUniforms } = selected;
    cameraSec.clear();
    shapeSec.clear();
    paletteSec.clear();
    outlineSec.clear();

    // ── Camera ────────────────────────────────────────────────────────
    cameraSec.slider("FOV", {
      min: 10,
      max: 120,
      step: 1,
      value: camera.fov,
      onChange: (v) => {
        camera.fov = v;
        camera.updateProjectionMatrix();
        selected.scheduleRender();
      },
    });
    if (opts.onRestoreDefaults) {
      cameraSec.header("Reset");
      cameraSec.button("Restore defaults", {
        subtle: true,
        onClick: () => opts.onRestoreDefaults(),
      });
    }

    // ── Shape ─────────────────────────────────────────────────────────
    // Order: categorical first, then overall sizing, then ratio knobs,
    // then pixel-space clamps, then edge/visibility cutoffs.
    const onScreenChange = () => selected.scheduleRender();
    shapeSec.select(
      "Splat Shape",
      ["Ellipse", "Stadium", "Rectangle", "Diamond", "Leaf", "Brush"],
      {
        value: spark.uniforms.splatShape.value,
        onChange: (i) => {
          spark.uniforms.splatShape.value = i;
          selected.scheduleRender();
        },
      },
    );
    shapeSec.slider("Splat Scale", {
      min: 0.1,
      max: 3,
      step: 0.05,
      value: spark.uniforms.screenScale.value,
      onChange: (v) => {
        spark.uniforms.screenScale.value = v;
        onScreenChange();
      },
    });
    shapeSec.slider("Isotropy", {
      min: 0,
      max: 1,
      step: 0.01,
      value: spark.uniforms.screenIsotropy.value,
      onChange: (v) => {
        spark.uniforms.screenIsotropy.value = v;
        onScreenChange();
      },
    });
    shapeSec.slider("Stroke Aspect", {
      min: 0.5,
      max: 6,
      step: 0.05,
      value: spark.uniforms.splatAspect.value,
      onChange: (v) => {
        spark.uniforms.splatAspect.value = v;
        selected.scheduleRender();
      },
    });
    shapeSec.slider("Falloff", {
      min: 0,
      max: 1,
      step: 0.01,
      value: spark.uniforms.splatFalloff.value,
      onChange: (v) => {
        spark.uniforms.splatFalloff.value = v;
        selected.scheduleRender();
      },
    });
    shapeSec.slider("Min Length (px)", {
      min: 0,
      max: 100,
      step: 1,
      value: spark.uniforms.screenMinLength.value,
      onChange: (v) => {
        spark.uniforms.screenMinLength.value = v;
        onScreenChange();
      },
    });
    shapeSec.slider("Max Length (px)", {
      min: 0,
      max: 100,
      step: 1,
      value: spark.uniforms.screenMaxLength.value,
      onChange: (v) => {
        spark.uniforms.screenMaxLength.value = v;
        onScreenChange();
      },
    });
    shapeSec.slider("Min Width (px)", {
      min: 0,
      max: 100,
      step: 1,
      value: spark.uniforms.screenMinWidth.value,
      onChange: (v) => {
        spark.uniforms.screenMinWidth.value = v;
        onScreenChange();
      },
    });
    shapeSec.slider("Max Width (px)", {
      min: 0,
      max: 100,
      step: 1,
      value: spark.uniforms.screenMaxWidth.value,
      onChange: (v) => {
        spark.uniforms.screenMaxWidth.value = v;
        onScreenChange();
      },
    });
    shapeSec.slider("Alpha Threshold", {
      min: 0,
      max: 1,
      step: 0.01,
      value: spark.uniforms.alphaThreshold.value,
      onChange: (v) => {
        spark.uniforms.alphaThreshold.value = v;
        selected.scheduleRender();
      },
    });
    shapeSec.slider("Min Opacity", {
      min: 0,
      max: 1,
      step: 0.01,
      value: spark.uniforms.minOpacity.value,
      onChange: (v) => {
        spark.uniforms.minOpacity.value = v;
        selected.scheduleRender();
      },
    });

    // ── Palette ───────────────────────────────────────────────────────
    const updatePalette = () => {
      splat.updateVersion();
      selected.scheduleRender();
    };
    paletteSec.checkbox("Quantize colors", {
      value: paletteUniforms.enabled.value,
      onChange: (on) => {
        paletteUniforms.enabled.value = on;
        updatePalette();
      },
    });
    paletteSec.slider("Hue Levels", {
      min: 1,
      max: 16,
      step: 1,
      value: paletteUniforms.hueLevels.value,
      onChange: (v) => {
        paletteUniforms.hueLevels.value = v;
        updatePalette();
      },
    });
    paletteSec.slider("Tone Levels (S+V)", {
      min: 1,
      max: 8,
      step: 1,
      value: paletteUniforms.toneLevels.value,
      onChange: (v) => {
        paletteUniforms.toneLevels.value = v;
        updatePalette();
      },
    });

    // ── Outline ───────────────────────────────────────────────────────
    const u = outline.uniforms;
    outlineSec.checkbox("Outline enabled", {
      value: u.uEnabled.value,
      onChange: (v) => {
        u.uEnabled.value = v;
        selected.scheduleRender();
      },
    });
    outlineSec.checkbox("Outlines only", {
      value: u.uOutlinesOnly.value,
      onChange: (v) => {
        u.uOutlinesOnly.value = v;
        selected.scheduleRender();
      },
    });
    outlineSec.color("Color", {
      value: "#" + u.uOutlineColor.value.getHexString(),
      onChange: (hex) => {
        u.uOutlineColor.value.set(hex);
        selected.scheduleRender();
      },
    });
    outlineSec.slider("Width", {
      min: 1,
      max: 6,
      step: 0.5,
      value: u.uOutlineWidth.value,
      onChange: (v) => {
        u.uOutlineWidth.value = v;
        selected.scheduleRender();
      },
    });
    outlineSec.slider("Opacity", {
      min: 0,
      max: 1,
      step: 0.05,
      value: u.uOutlineOpacity.value,
      onChange: (v) => {
        u.uOutlineOpacity.value = v;
        selected.scheduleRender();
      },
    });
    outlineSec.slider("Edge Mix", {
      min: 0,
      max: 1,
      step: 0.01,
      value: u.uEdgeMix.value,
      onChange: (v) => {
        u.uEdgeMix.value = v;
        selected.scheduleRender();
      },
    });
    outlineSec.slider("Depth Threshold", {
      min: 0.001,
      max: 0.5,
      step: 0.001,
      value: u.uDepthThreshold.value,
      onChange: (v) => {
        u.uDepthThreshold.value = v;
        selected.scheduleRender();
      },
    });
    outlineSec.slider("Normal Threshold", {
      min: 0.01,
      max: 2.0,
      step: 0.01,
      value: u.uNormalThreshold.value,
      onChange: (v) => {
        u.uNormalThreshold.value = v;
        selected.scheduleRender();
      },
    });
    outlineSec.slider("Sample Radius", {
      min: 0.5,
      max: 5,
      step: 0.1,
      value: u.uRadius.value,
      onChange: (v) => {
        u.uRadius.value = v;
        selected.scheduleRender();
      },
    });
    outlineSec.header("Debug views");
    outlineSec.checkbox("Show scene color", {
      value: u.uShowColor.value,
      onChange: (v) => {
        u.uShowColor.value = v;
        selected.scheduleRender();
      },
    });
    outlineSec.checkbox("Show depth buffer", {
      value: u.uShowDepth.value,
      onChange: (v) => {
        u.uShowDepth.value = v;
        selected.scheduleRender();
      },
    });
    outlineSec.checkbox("Show normal buffer", {
      value: u.uShowNormals.value,
      onChange: (v) => {
        u.uShowNormals.value = v;
        selected.scheduleRender();
      },
    });
  }
  rebuildControls();
  // Default tab — Shape, where most of the visual experimentation happens.
  debug.setActiveSection("Shape");

  // Live readout
  function tick() {
    if (cancelled) return;
    const { camera, controls } = selected;
    const p = camera.position;
    const t = controls.target;
    debug.log("splat", selected.cfg.label ?? selected.cfg.file);
    debug.log("pos", `${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}`);
    debug.log(
      "target",
      `${t.x.toFixed(2)}, ${t.y.toFixed(2)}, ${t.z.toFixed(2)}`,
    );
    debug.log("distance", controls.getDistance().toFixed(2));
    debug.log("fov", camera.fov);
    requestAnimationFrame(tick);
  }
  tick();

  return {
    // Re-read uniform values from the live viewer and re-render the
    // sliders / toggles. Call after externally mutating uniforms (e.g.
    // applyPresetToViewer) so the debug pane reflects the new state.
    rebuild: rebuildControls,
    destroy() {
      cancelled = true;
      cameraSec.remove();
      shapeSec.remove();
      paletteSec.remove();
      outlineSec.remove();
      diagSec?.remove();
      shareBtn?.remove();
    },
  };
}

// Diagnostic-only: a minimal Spark-default viewer with no FBO, no outline
// pass, no custom shaders, no palette modifier. Used by /splat?vanilla to
// compare our pipeline against pure Spark rendering.
export function createVanillaSplatViewer(cfg, parentEl, overrides = {}) {
  const section = document.createElement("section");
  section.className = "splat-section";
  const canvas = document.createElement("canvas");
  section.appendChild(canvas);
  parentEl.appendChild(section);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
  });
  renderer.setPixelRatio(
    Math.min(window.devicePixelRatio, overrides.pixelRatio ?? 1.5),
  );

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(cfg.fov ?? 50, 1, 0.1, 100);
  camera.position.set(...(cfg.pos ?? [0, 1, 4]));

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = overrides.enableDamping ?? false;
  controls.enablePan = overrides.enablePan ?? false;
  controls.minDistance = overrides.minDist ?? cfg.minDist ?? 2;
  controls.maxDistance = overrides.maxDist ?? cfg.maxDist ?? 10;
  controls.target.set(...(cfg.target ?? [0, 0, 0]));

  // Spark default: no vertexShader/fragmentShader override, no extraUniforms.
  const spark = new SparkRenderer({ renderer });
  scene.add(spark);

  function resize() {
    const rect = section.getBoundingClientRect();
    renderer.setSize(rect.width, rect.height, false);
    camera.aspect = rect.width / rect.height;
    camera.updateProjectionMatrix();
  }
  resize();
  window.addEventListener("resize", resize);

  const splat = new SplatMesh({
    url: cfg.file,
    fileBytes: cfg.fileBytes,
    fileName: cfg.fileName,
    onProgress: overrides.onProgress,
  });
  splat.rotation.x = Math.PI;
  scene.add(splat);

  let renderPending = false;
  let dampingFrames = 0;
  const FRAME_INTERVAL = overrides.frameInterval ?? 1000 / 24;
  let lastRenderTime = 0;

  function scheduleRender() {
    if (!renderPending) {
      renderPending = true;
      requestAnimationFrame(render);
    }
  }

  function render(now) {
    renderPending = false;
    const elapsed = now - lastRenderTime;
    if (elapsed < FRAME_INTERVAL) {
      if (dampingFrames > 0) scheduleRender();
      return;
    }
    lastRenderTime = now;
    controls.update();
    // Direct render to canvas — no FBO, no outline pass.
    renderer.render(scene, camera);
    if (dampingFrames > 0) {
      dampingFrames--;
      scheduleRender();
    }
  }

  controls.addEventListener("change", () => {
    dampingFrames = 1;
    scheduleRender();
  });

  const origResize = resize;
  resize = function () {
    origResize();
    scheduleRender();
  };

  const loadPoll = setInterval(() => {
    scheduleRender();
  }, 100);
  const loadPollTimeout = setTimeout(() => clearInterval(loadPoll), 15000);

  function destroy() {
    window.removeEventListener("resize", resize);
    clearInterval(loadPoll);
    clearTimeout(loadPollTimeout);
    section.remove();
    renderer.dispose();
  }

  return {
    cfg,
    camera,
    controls,
    renderer,
    section,
    scheduleRender,
    spark,
    splat,
    destroy,
  };
}

// --- Auto-init for the homepage (gated on data-auto-init) ---
async function autoInit() {
  const mount = document.getElementById("splat-mount");
  if (!mount || !mount.hasAttribute("data-auto-init")) return;
  const splats = await fetch("splats.json", { cache: "no-store" }).then((r) =>
    r.json(),
  );
  const viewers = splats.map((cfg) => createSplatViewer(cfg, mount));
  setupDebugPanel(viewers, splats);
}
autoInit();
