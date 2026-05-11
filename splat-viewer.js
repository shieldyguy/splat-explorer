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

  const spark = new SparkRenderer({
    renderer,
    // depthWrite=true populates the depth buffer for outline detection.
    // sortRadial=false flips Spark from its default radial sort (fast but
    // loose) to strict back-to-front Z-sort. The combination matters:
    // with depthWrite alone + radial sort, splats that get drawn slightly
    // out of strict z-order write their depth and end up culling later-
    // drawn splats that are actually farther — which produced the chunky
    // hard-edged splat look. Strict Z-sort means every splat passes the
    // depth test against the previous one, so the depth buffer fills up
    // correctly without disrupting alpha accumulation.
    depthWrite: true,
    sortRadial: true,
    vertexShader: SPLAT_VERT_GLSL,
    fragmentShader: SPLAT_FRAG_GLSL,
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
  });
  scene.add(spark);

  const outline = createOutlinePass({ width: 1, height: 1 });

  function resize() {
    const rect = section.getBoundingClientRect();
    const dpr = renderer.getPixelRatio();
    renderer.setSize(rect.width, rect.height, false);
    camera.aspect = rect.width / rect.height;
    camera.updateProjectionMatrix();
    outline.setSize(
      Math.max(1, Math.floor(rect.width * dpr)),
      Math.max(1, Math.floor(rect.height * dpr)),
    );
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

    // Pass 1: scene → outline FBO (color + depth)
    renderer.setRenderTarget(outline.renderTarget);
    renderer.clear();
    renderer.render(scene, camera);

    // Pass 2: outline post-process → canvas
    renderer.setRenderTarget(null);
    outline.uniforms.uNear.value = camera.near;
    outline.uniforms.uFar.value = camera.far;
    renderer.render(outline.scene, outline.camera);

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
  };
}

// Build the debug panel for a set of viewers. No-ops if debug.active is false.
// opts.onSelect(viewer, index) fires when the splat selector changes.
export function setupDebugPanel(viewers, splats, opts = {}) {
  if (!debug.active) return { destroy() {}, rebuild() {} };

  // Selector lives in its own section so rebuildControls()'s clear()
  // doesn't wipe it.
  const selectorSection = debug.section();
  const splatDebug = debug.section();
  let selected = viewers[0];
  let cancelled = false;

  if (opts.onRestoreDefaults) {
    selectorSection.button("Restore defaults", {
      subtle: true,
      onClick: () => opts.onRestoreDefaults(),
    });
  }

  if (viewers.length > 1) {
    selectorSection.select(
      "Splat",
      splats.map((s) => s.label ?? s.file),
      (i) => {
        selected = viewers[i];
        rebuildControls();
        opts.onSelect?.(selected, i);
      },
    );
  }

  function rebuildControls() {
    const { camera, controls, spark, outline, splat, paletteUniforms } =
      selected;
    splatDebug.clear();

    splatDebug.slider("FOV", {
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
    splatDebug.slider("Target X", {
      min: -5,
      max: 5,
      step: 0.05,
      value: controls.target.x,
      onChange: (v) => {
        controls.target.x = v;
        selected.scheduleRender();
      },
    });
    splatDebug.slider("Target Y", {
      min: -5,
      max: 5,
      step: 0.05,
      value: controls.target.y,
      onChange: (v) => {
        controls.target.y = v;
        selected.scheduleRender();
      },
    });

    // --- Splat shape (screen-space pixel controls) ---
    const onScreenChange = () => selected.scheduleRender();
    splatDebug.slider("Splat Scale", {
      min: 0.1,
      max: 3,
      step: 0.05,
      value: spark.uniforms.screenScale.value,
      onChange: (v) => {
        spark.uniforms.screenScale.value = v;
        onScreenChange();
      },
    });
    splatDebug.slider("Isotropy", {
      min: 0,
      max: 1,
      step: 0.01,
      value: spark.uniforms.screenIsotropy.value,
      onChange: (v) => {
        spark.uniforms.screenIsotropy.value = v;
        onScreenChange();
      },
    });
    splatDebug.slider("Min Length (px)", {
      min: 0,
      max: 100,
      step: 1,
      value: spark.uniforms.screenMinLength.value,
      onChange: (v) => {
        spark.uniforms.screenMinLength.value = v;
        onScreenChange();
      },
    });
    splatDebug.slider("Max Length (px)", {
      min: 0,
      max: 100,
      step: 1,
      value: spark.uniforms.screenMaxLength.value,
      onChange: (v) => {
        spark.uniforms.screenMaxLength.value = v;
        onScreenChange();
      },
    });
    splatDebug.slider("Min Width (px)", {
      min: 0,
      max: 100,
      step: 1,
      value: spark.uniforms.screenMinWidth.value,
      onChange: (v) => {
        spark.uniforms.screenMinWidth.value = v;
        onScreenChange();
      },
    });
    splatDebug.slider("Max Width (px)", {
      min: 0,
      max: 100,
      step: 1,
      value: spark.uniforms.screenMaxWidth.value,
      onChange: (v) => {
        spark.uniforms.screenMaxWidth.value = v;
        onScreenChange();
      },
    });
    splatDebug.slider("Splat Falloff (0=flat)", {
      min: 0,
      max: 1,
      step: 0.01,
      value: spark.uniforms.splatFalloff.value,
      onChange: (v) => {
        spark.uniforms.splatFalloff.value = v;
        selected.scheduleRender();
      },
    });
    splatDebug.select(
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
    splatDebug.slider("Stroke Aspect", {
      min: 0.5,
      max: 6,
      step: 0.05,
      value: spark.uniforms.splatAspect.value,
      onChange: (v) => {
        spark.uniforms.splatAspect.value = v;
        selected.scheduleRender();
      },
    });

    // --- Color quantization (per-splat dyno modifier) ---
    const updatePalette = () => {
      splat.updateVersion();
      selected.scheduleRender();
    };
    splatDebug.checkbox("Quantize Colors", {
      value: paletteUniforms.enabled.value,
      onChange: (on) => {
        paletteUniforms.enabled.value = on;
        updatePalette();
      },
    });
    splatDebug.slider("Hue Levels", {
      min: 1,
      max: 16,
      step: 1,
      value: paletteUniforms.hueLevels.value,
      onChange: (v) => {
        paletteUniforms.hueLevels.value = v;
        updatePalette();
      },
    });
    splatDebug.slider("Tone Levels (S+V)", {
      min: 1,
      max: 8,
      step: 1,
      value: paletteUniforms.toneLevels.value,
      onChange: (v) => {
        paletteUniforms.toneLevels.value = v;
        updatePalette();
      },
    });

    // --- Outline pass ---
    const u = outline.uniforms;
    splatDebug.slider("Alpha Threshold", {
      min: 0,
      max: 1,
      step: 0.01,
      value: spark.uniforms.alphaThreshold.value,
      onChange: (v) => {
        spark.uniforms.alphaThreshold.value = v;
        selected.scheduleRender();
      },
    });
    splatDebug.slider("Min Opacity", {
      min: 0,
      max: 1,
      step: 0.01,
      value: spark.uniforms.minOpacity.value,
      onChange: (v) => {
        spark.uniforms.minOpacity.value = v;
        selected.scheduleRender();
      },
    });
    splatDebug.slider("Edge Mix (depth↔normal)", {
      min: 0,
      max: 1,
      step: 0.01,
      value: u.uEdgeMix.value,
      onChange: (v) => {
        u.uEdgeMix.value = v;
        selected.scheduleRender();
      },
    });
    splatDebug.slider("Depth Edge Threshold", {
      min: 0.001,
      max: 0.5,
      step: 0.001,
      value: u.uDepthThreshold.value,
      onChange: (v) => {
        u.uDepthThreshold.value = v;
        selected.scheduleRender();
      },
    });
    splatDebug.slider("Normal Edge Threshold", {
      min: 0.01,
      max: 2.0,
      step: 0.01,
      value: u.uNormalThreshold.value,
      onChange: (v) => {
        u.uNormalThreshold.value = v;
        selected.scheduleRender();
      },
    });
    splatDebug.slider("Sample Radius", {
      min: 0.5,
      max: 5,
      step: 0.1,
      value: u.uRadius.value,
      onChange: (v) => {
        u.uRadius.value = v;
        selected.scheduleRender();
      },
    });
    splatDebug.slider("Outline Width", {
      min: 1,
      max: 6,
      step: 0.5,
      value: u.uOutlineWidth.value,
      onChange: (v) => {
        u.uOutlineWidth.value = v;
        selected.scheduleRender();
      },
    });
    splatDebug.slider("Outline Opacity", {
      min: 0,
      max: 1,
      step: 0.05,
      value: u.uOutlineOpacity.value,
      onChange: (v) => {
        u.uOutlineOpacity.value = v;
        selected.scheduleRender();
      },
    });
    splatDebug.color("Outline Color", {
      value: "#" + u.uOutlineColor.value.getHexString(),
      onChange: (hex) => {
        u.uOutlineColor.value.set(hex);
        selected.scheduleRender();
      },
    });
    splatDebug.checkbox("Show scene color", {
      value: u.uShowColor.value,
      onChange: (v) => {
        u.uShowColor.value = v;
        selected.scheduleRender();
      },
    });
    splatDebug.checkbox("Show depth buffer", {
      value: u.uShowDepth.value,
      onChange: (v) => {
        u.uShowDepth.value = v;
        selected.scheduleRender();
      },
    });
    splatDebug.checkbox("Show normal buffer", {
      value: u.uShowNormals.value,
      onChange: (v) => {
        u.uShowNormals.value = v;
        selected.scheduleRender();
      },
    });
    splatDebug.checkbox("Outlines only (hide model)", {
      value: u.uOutlinesOnly.value,
      onChange: (v) => {
        u.uOutlinesOnly.value = v;
        selected.scheduleRender();
      },
    });
    splatDebug.checkbox("Outline enabled", {
      value: u.uEnabled.value,
      onChange: (v) => {
        u.uEnabled.value = v;
        selected.scheduleRender();
      },
    });

    splatDebug.button("Copy Link", () => {
      const demoIndex = selected.demoIndex ?? 0;
      const encoded = encodePresetFromViewer(selected, demoIndex);
      const url = `${location.origin}/splat/?p=${encoded}`;
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      splatDebug.flash("Link copied!");
    });
  }
  rebuildControls();

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
      selectorSection.remove();
      splatDebug.remove();
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
