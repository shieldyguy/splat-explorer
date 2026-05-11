// Splat Playground — pick a demo or load your own .ply.
// One viewer at a time; switching disposes the previous one cleanly.

import {
  createSplatViewer,
  createVanillaSplatViewer,
  setupDebugPanel,
} from "./splat-viewer.js";
import {
  decodePreset,
  applyPresetToViewer,
  encodePresetFromViewer,
} from "./preset.js";

// Diagnostic flag: when present in the URL (e.g. /splat/?vanilla), bypass
// our entire customization stack — no custom splat shaders, no FBO, no
// outline pass, no palette modifier, no debug pane. Renders pure Spark
// default into the canvas. For comparing artifacts against our pipeline.
const VANILLA = new URLSearchParams(location.search).has("vanilla");
if (VANILLA) document.body.classList.add("vanilla");

// Per-knob diagnostic flags read from the URL. Defaults are production
// behavior — flipping one reloads the viewer with that single pipeline
// variable changed, useful for poking at the renderer or hunting regressions.
//
// History note: depthWrite=true with single-pass rendering caused bright
// halos around splats (depth-test culling dropped contributions that should
// have integrated). Strict z-sort masked the symptom but introduced orbit
// flicker. The fix is twoPass=true: render color with depth fully off, then
// render geometry into the MRT with depth on. See CLAUDE.md.
const DIAG_DEFAULTS = {
  customFrag: true,
  customVert: true,
  depthWrite: true,   // ignored when twoPass=true; only affects single-pass mode
  strictSort: false,  // radial (Spark default); only matters when twoPass=false
  mrt: true,
  passthrough: false, // composite passthrough — debug only
  twoPass: true,      // the fix
};
function readDiag() {
  const p = new URLSearchParams(location.search);
  const out = {};
  for (const [k, def] of Object.entries(DIAG_DEFAULTS)) {
    const v = p.get(k);
    out[k] = v === null ? def : !(v === "0" || v === "off" || v === "false");
  }
  return out;
}
function writeDiagFlag(key, on, def) {
  const url = new URL(location);
  if (on === def) url.searchParams.delete(key);
  else url.searchParams.set(key, on ? "1" : "0");
  history.replaceState(null, "", url);
}

// Hardcoded demos. Big files live on Cloudflare R2; the small Pebbles demo
// is in the repo so the homepage can serve it directly without a network hop.
//
// URLs are fully absolutized — Spark loads .ply inside a Web Worker and
// worker URL resolution against a blob-sourced worker location is flaky.
const ABS = (path) => new URL(path, location.origin).href;
const R2 = "https://pub-b08f19b575cc4201913c259c197f3823.r2.dev";

const DEMOS = [
  {
    label: "Pebbles",
    file: ABS("/pebbles.ply"),
    fov: 35,
    pos: [0.3, 3.64, -3.06],
    target: [0.1, 0, 0],
    minDist: 0.05,
    maxDist: 1000,
  },
  {
    label: "Montesino Rocks",
    file: `${R2}/montesino_rocks.ply`,
    fov: 35,
    pos: [0.3, 3.64, -3.06],
    target: [0.1, 0, 0],
    minDist: 0.05,
    maxDist: 1000,
  },
  {
    label: "Selected Places to Sit",
    file: `${R2}/sspts_splat.ply`,
    fov: 50,
    pos: [0, 1, 4],
    target: [0, 0, 0],
    minDist: 0.05,
    maxDist: 1000,
  },
  {
    label: "SVFs",
    file: `${R2}/svf_splat_2.ply`,
    fov: 50,
    pos: [0, 1, 4],
    target: [0, 0, 0],
    minDist: 0.05,
    maxDist: 1000,
  },
];

// Sane defaults for a user-loaded splat (we don't know its geometry).
const USER_DEFAULTS = {
  fov: 50,
  pos: [0, 1, 4],
  target: [0, 0, 0],
  minDist: 0.05,
  maxDist: 1000,
};

const mount = document.getElementById("splat-mount");
const picker = document.getElementById("picker");
const reopenBtn = document.getElementById("reopen-picker");
const cancelBtn = document.getElementById("cancel-picker");
const fileInput = document.getElementById("file-input");
const progressBar = document.getElementById("progress-bar");
const progressFill = progressBar.querySelector(".progress-fill");
const progressLabel = document.getElementById("progress-label");

function showProgress() {
  progressBar.hidden = false;
  progressLabel.hidden = false;
  progressFill.style.width = "0%";
  progressLabel.textContent = "starting…";
}
function hideProgress() {
  progressBar.hidden = true;
  progressLabel.hidden = true;
}
function updateProgress({ loaded, total }) {
  const mb = (n) => (n / 1_000_000).toFixed(1);
  if (total > 0) {
    const pct = Math.min(100, (loaded / total) * 100);
    progressFill.style.width = pct.toFixed(1) + "%";
    progressLabel.textContent = `${mb(loaded)} / ${mb(total)} MB · ${Math.round(pct)}%`;
  } else {
    progressLabel.textContent = `${mb(loaded)} MB`;
  }
}

let currentViewer = null;
let currentDebug = null;
// `defaultsPreset` is captured from the very first viewer's freshly-created
// uniform values — i.e. the baked-in defaults from splat-viewer.js,
// outline-pass.js, splat-modifier.js. Used by Restore defaults.
let defaultsPreset = null;
// `inheritedSettings` is what the user had on the previous splat. Carried
// forward across swaps so the lens persists; reset by Restore defaults.
let inheritedSettings = null;

function handleRestoreDefaults() {
  if (!defaultsPreset || !currentViewer) return;
  applyPresetToViewer(currentViewer, defaultsPreset, { keepCamera: true });
  // Clear the carried-over lens so future swaps start from defaults too.
  inheritedSettings = null;
  currentDebug?.rebuild();
}

function disposeCurrent() {
  if (currentDebug) {
    currentDebug.destroy();
    currentDebug = null;
  }
  if (currentViewer) {
    currentViewer.destroy();
    currentViewer = null;
  }
}

function loadCfg(cfg, demoIndex = null, loadOpts = {}) {
  // keepCamera defaults to true (demo-swap behavior). diag-reload sets it
  // false so the user's current framing carries across the rebuild.
  const keepCamera = loadOpts.keepCamera ?? true;

  // Capture the outgoing viewer's settings before we destroy it so the
  // user's lens carries forward to the next splat.
  if (currentViewer && !VANILLA) {
    inheritedSettings = decodePreset(
      encodePresetFromViewer(currentViewer, demoIndex ?? 0),
    );
  }

  disposeCurrent();
  const isUrlLoad = !!cfg.file && !cfg.fileBytes;
  if (isUrlLoad) showProgress();

  const factory = VANILLA ? createVanillaSplatViewer : createSplatViewer;
  const viewer = factory(cfg, mount, {
    minDist: cfg.minDist ?? 0.05,
    maxDist: cfg.maxDist ?? 1000,
    enablePan: true,
    enableDamping: false,
    frameInterval: 1000 / 24,
    onProgress: isUrlLoad ? updateProgress : undefined,
    diag: readDiag(),
  });
  viewer.demoIndex = demoIndex;
  currentViewer = viewer;

  if (!VANILLA) {
    // First viewer ever: snapshot baked defaults BEFORE applying any
    // inherited settings, so Restore can return to the original state.
    if (!defaultsPreset) {
      defaultsPreset = decodePreset(encodePresetFromViewer(viewer, 0));
    }
    // Apply carried-over settings. keepCamera=true (default) preserves
    // the new splat's framing on demo swap; false forces inheriting the
    // outgoing camera (used for diag-toggle reloads on the same splat).
    if (inheritedSettings) {
      applyPresetToViewer(viewer, inheritedSettings, { keepCamera });
    }
    currentDebug = setupDebugPanel([viewer], [cfg], {
      onSelect: undefined,
      onRestoreDefaults: handleRestoreDefaults,
      onDiagToggle: (key, on, def, opts2 = {}) => {
        writeDiagFlag(key, on, def);
        if (!opts2.skipReload) reloadViewerForDiag();
      },
      onDiagReset: () => {
        const url = new URL(location);
        for (const k of Object.keys(DIAG_DEFAULTS)) url.searchParams.delete(k);
        history.replaceState(null, "", url);
        reloadViewerForDiag();
      },
    });
  }
  hidePicker();
  reopenBtn.hidden = false;

  if (isUrlLoad && viewer.splat?.initialized) {
    viewer.splat.initialized.finally(hideProgress);
  } else {
    hideProgress();
  }
  return viewer;
}

// Re-create the viewer with whatever DIAG flags are currently in the URL.
// Carries the user's current camera + uniforms forward so a diag flip
// doesn't yank framing out from under them.
function reloadViewerForDiag() {
  if (!currentViewer) return;
  loadCfg(currentViewer.cfg, currentViewer.demoIndex, { keepCamera: false });
}

async function loadFile(file) {
  if (!file.name.toLowerCase().endsWith(".ply")) {
    alert("Please pick a .ply file (Gaussian splat).");
    return;
  }
  // Read the file into a Uint8Array and hand it to Spark directly via
  // `fileBytes` — bypasses the worker-fetch path entirely, which is more
  // reliable than relying on a blob: URL surviving the worker boundary.
  const buf = await file.arrayBuffer();
  loadCfg({
    label: file.name,
    fileName: file.name,
    fileBytes: new Uint8Array(buf),
    ...USER_DEFAULTS,
  });
}

function showPicker() {
  picker.style.display = "flex";
  cancelBtn.hidden = !currentViewer;
}

function hidePicker() {
  picker.style.display = "none";
}

// --- Wire up controls ---

// Render one button per DEMO entry into the picker.
const demoButtons = document.getElementById("demo-buttons");
DEMOS.forEach((demo, i) => {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.dataset.demoIndex = String(i);
  btn.innerHTML = `<span>${demo.label}</span>`;
  btn.addEventListener("click", () => loadCfg(DEMOS[i], i));
  demoButtons.appendChild(btn);
});

fileInput.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) loadFile(file);
  // Reset so picking the same file twice still fires `change`.
  e.target.value = "";
});

cancelBtn.addEventListener("click", () => {
  if (currentViewer) hidePicker();
});

reopenBtn.addEventListener("click", showPicker);

// Drag-and-drop anywhere on the page.
let dragDepth = 0;
document.body.addEventListener("dragenter", (e) => {
  if (!e.dataTransfer?.types.includes("Files")) return;
  dragDepth++;
  document.body.classList.add("dragging");
});
document.body.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) document.body.classList.remove("dragging");
});
document.body.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
});
document.body.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging");
  const file = e.dataTransfer?.files?.[0];
  if (file) loadFile(file);
});

// Initial state — if a ?p= preset is in the URL, decode and load it; otherwise
// show the picker.
const presetParam = new URLSearchParams(location.search).get("p");
let presetLoaded = false;
if (presetParam) {
  try {
    const preset = decodePreset(presetParam);
    const idx = preset.demoIndex < DEMOS.length ? preset.demoIndex : 0;
    const baseCfg = DEMOS[idx];
    const cfg = {
      ...baseCfg,
      fov: preset.camera.fov,
      pos: preset.camera.pos,
      target: preset.camera.target,
      minDist: preset.camera.minDist,
      maxDist: preset.camera.maxDist,
    };
    const viewer = loadCfg(cfg, idx);
    // Vanilla mode doesn't have our uniforms — skip the apply, camera-
    // only changes still take effect via cfg.
    if (!VANILLA) {
      applyPresetToViewer(viewer, preset);
      // Sliders / toggles were built with the cfg's defaults — refresh them
      // so they reflect the just-applied preset values.
      currentDebug?.rebuild();
    }
    // Strip ?p= from the URL so a refresh / "swap splat" doesn't re-apply.
    history.replaceState(null, "", location.search.includes("vanilla") ? "?vanilla" : location.pathname);
    presetLoaded = true;
  } catch (e) {
    console.error("Failed to decode preset:", e);
  }
}
if (!presetLoaded) showPicker();
