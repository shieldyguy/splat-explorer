// Splat playground preset — binary URL encoding (~47 bytes → ~62 char Base64).
//
// Layout (v1):
//   0:        version (= 1)
//   1:        demoIndex into DEMOS (0 = Pebbles fallback for user-file shares)
//   2:        camera fov         (uint8)
//   3..14:    pos.xyz, target.xyz   (each int16 * 100, range ±327.67)
//   15..16:   minDistance        (uint16 * 10, range 0..6553.5)
//   17..18:   maxDistance        (uint16 * 10)
//   19:       alphaThreshold * 100   (uint8)
//   20:       minOpacity * 100       (uint8)
//   21:       splatFalloff * 100     (uint8)
//   22:       splatShape             (uint8, 0..5)
//   23:       splatAspect * 25       (uint8, range 0..10.2)
//   24:       screenScale * 50       (uint8, range 0..5.1)
//   25:       screenIsotropy * 100   (uint8)
//   26:       screenMinLength px     (uint8)
//   27..28:   screenMaxLength px     (uint16)
//   29:       screenMinWidth px      (uint8)
//   30..31:   screenMaxWidth px      (uint16)
//   32..33:   uDepthThreshold * 1000 (uint16)
//   34..35:   uNormalThreshold * 100 (uint16)
//   36:       uEdgeMix * 100         (uint8)
//   37:       uRadius * 25           (uint8, range 0..10.2)
//   38:       uOutlineWidth * 25     (uint8, range 0..10.2)
//   39..41:   uOutlineColor RGB      (3× uint8)
//   42:       uOutlineOpacity * 100  (uint8)
//   43:       outline bools bitmask: bit0=showDepth bit1=showNormals
//             bit2=showColor bit3=outlinesOnly bit4=enabled
//   44:       palette.enabled        (uint8)
//   45:       palette.hueLevels      (uint8, 1..16)
//   46:       palette.toneLevels     (uint8, 1..8)
//
// IMPORTANT: when adding new demos to DEMOS, only append — never reorder
// or delete — or old shared links will point at the wrong splat.
//
// To extend the schema, bump VERSION + BYTE_LEN, write a new branch in the
// decoder while keeping the v1 path intact for backward compat.

const VERSION = 1;
const BYTE_LEN = 47;

// ---- Base64 helpers (URL-safe, no padding) ----

function toUrlBase64(buf) {
  let bin = "";
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return btoa(bin)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromUrlBase64(s) {
  const pad = (4 - (s.length % 4)) % 4;
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}

const u8 = (v) => Math.max(0, Math.min(255, Math.round(v)));
const u16 = (v) => Math.max(0, Math.min(65535, Math.round(v)));
const i16 = (v) => Math.max(-32768, Math.min(32767, Math.round(v)));

// ---- Encode ----

export function encodePresetFromViewer(viewer, demoIndex = 0) {
  const buf = new Uint8Array(BYTE_LEN);
  const view = new DataView(buf.buffer);

  buf[0] = VERSION;
  buf[1] = u8(demoIndex);

  const cam = viewer.camera;
  const ctrl = viewer.controls;
  const su = viewer.spark.uniforms;
  const ou = viewer.outline.uniforms;
  const pu = viewer.paletteUniforms;

  // Camera
  buf[2] = u8(cam.fov);
  view.setInt16(3, i16(cam.position.x * 100));
  view.setInt16(5, i16(cam.position.y * 100));
  view.setInt16(7, i16(cam.position.z * 100));
  view.setInt16(9, i16(ctrl.target.x * 100));
  view.setInt16(11, i16(ctrl.target.y * 100));
  view.setInt16(13, i16(ctrl.target.z * 100));
  view.setUint16(15, u16(ctrl.minDistance * 10));
  view.setUint16(17, u16(ctrl.maxDistance * 10));

  // Splat shape uniforms
  buf[19] = u8(su.alphaThreshold.value * 100);
  buf[20] = u8(su.minOpacity.value * 100);
  buf[21] = u8(su.splatFalloff.value * 100);
  buf[22] = u8(su.splatShape.value);
  buf[23] = u8(su.splatAspect.value * 25);
  buf[24] = u8(su.screenScale.value * 50);
  buf[25] = u8(su.screenIsotropy.value * 100);
  buf[26] = u8(su.screenMinLength.value);
  view.setUint16(27, u16(su.screenMaxLength.value));
  buf[29] = u8(su.screenMinWidth.value);
  view.setUint16(30, u16(su.screenMaxWidth.value));

  // Outline uniforms
  view.setUint16(32, u16(ou.uDepthThreshold.value * 1000));
  view.setUint16(34, u16(ou.uNormalThreshold.value * 100));
  buf[36] = u8(ou.uEdgeMix.value * 100);
  buf[37] = u8(ou.uRadius.value * 25);
  buf[38] = u8(ou.uOutlineWidth.value * 25);
  buf[39] = u8(ou.uOutlineColor.value.r * 255);
  buf[40] = u8(ou.uOutlineColor.value.g * 255);
  buf[41] = u8(ou.uOutlineColor.value.b * 255);
  buf[42] = u8(ou.uOutlineOpacity.value * 100);
  buf[43] =
    (ou.uShowDepth.value ? 1 : 0) |
    (ou.uShowNormals.value ? 2 : 0) |
    (ou.uShowColor.value ? 4 : 0) |
    (ou.uOutlinesOnly.value ? 8 : 0) |
    (ou.uEnabled.value ? 16 : 0);

  // Palette
  buf[44] = pu.enabled.value ? 1 : 0;
  buf[45] = u8(pu.hueLevels.value);
  buf[46] = u8(pu.toneLevels.value);

  return toUrlBase64(buf);
}

// ---- Decode ----

export function decodePreset(encoded) {
  const buf = fromUrlBase64(encoded);
  if (buf.length < 1) throw new Error("preset is empty");
  if (buf[0] !== VERSION) {
    throw new Error(`unsupported preset version: ${buf[0]}`);
  }
  if (buf.length < BYTE_LEN) {
    throw new Error(`preset too short: ${buf.length} bytes`);
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  const camera = {
    fov: buf[2],
    pos: [
      view.getInt16(3) / 100,
      view.getInt16(5) / 100,
      view.getInt16(7) / 100,
    ],
    target: [
      view.getInt16(9) / 100,
      view.getInt16(11) / 100,
      view.getInt16(13) / 100,
    ],
    minDist: view.getUint16(15) / 10,
    maxDist: view.getUint16(17) / 10,
  };

  const splat = {
    alphaThreshold: buf[19] / 100,
    minOpacity: buf[20] / 100,
    splatFalloff: buf[21] / 100,
    splatShape: buf[22],
    splatAspect: buf[23] / 25,
    screenScale: buf[24] / 50,
    screenIsotropy: buf[25] / 100,
    screenMinLength: buf[26],
    screenMaxLength: view.getUint16(27),
    screenMinWidth: buf[29],
    screenMaxWidth: view.getUint16(30),
  };

  const flags = buf[43];
  const outline = {
    uDepthThreshold: view.getUint16(32) / 1000,
    uNormalThreshold: view.getUint16(34) / 100,
    uEdgeMix: buf[36] / 100,
    uRadius: buf[37] / 25,
    uOutlineWidth: buf[38] / 25,
    uOutlineColor: [buf[39] / 255, buf[40] / 255, buf[41] / 255],
    uOutlineOpacity: buf[42] / 100,
    uShowDepth: !!(flags & 1),
    uShowNormals: !!(flags & 2),
    uShowColor: !!(flags & 4),
    uOutlinesOnly: !!(flags & 8),
    uEnabled: !!(flags & 16),
  };

  const palette = {
    enabled: buf[44] === 1,
    hueLevels: buf[45],
    toneLevels: buf[46],
  };

  return { version: VERSION, demoIndex: buf[1], camera, splat, outline, palette };
}

// ---- Apply to a live viewer ----

// opts.keepCamera = true skips the camera/controls mutations and applies
// only splat / outline / palette uniforms. Used when persisting settings
// across splat swaps where each splat has its own framing.
export function applyPresetToViewer(viewer, preset, opts = {}) {
  const { camera, splat, outline, palette } = preset;

  if (!opts.keepCamera) {
    viewer.camera.fov = camera.fov;
    viewer.camera.position.set(...camera.pos);
    viewer.camera.updateProjectionMatrix();
    viewer.controls.target.set(...camera.target);
    viewer.controls.minDistance = camera.minDist;
    viewer.controls.maxDistance = camera.maxDist;
  }

  const su = viewer.spark.uniforms;
  su.alphaThreshold.value = splat.alphaThreshold;
  su.minOpacity.value = splat.minOpacity;
  su.splatFalloff.value = splat.splatFalloff;
  su.splatShape.value = splat.splatShape;
  su.splatAspect.value = splat.splatAspect;
  su.screenScale.value = splat.screenScale;
  su.screenIsotropy.value = splat.screenIsotropy;
  su.screenMinLength.value = splat.screenMinLength;
  su.screenMaxLength.value = splat.screenMaxLength;
  su.screenMinWidth.value = splat.screenMinWidth;
  su.screenMaxWidth.value = splat.screenMaxWidth;

  const ou = viewer.outline.uniforms;
  ou.uDepthThreshold.value = outline.uDepthThreshold;
  ou.uNormalThreshold.value = outline.uNormalThreshold;
  ou.uEdgeMix.value = outline.uEdgeMix;
  ou.uRadius.value = outline.uRadius;
  ou.uOutlineWidth.value = outline.uOutlineWidth;
  ou.uOutlineColor.value.setRGB(...outline.uOutlineColor);
  ou.uOutlineOpacity.value = outline.uOutlineOpacity;
  ou.uShowDepth.value = outline.uShowDepth;
  ou.uShowNormals.value = outline.uShowNormals;
  ou.uShowColor.value = outline.uShowColor;
  ou.uOutlinesOnly.value = outline.uOutlinesOnly;
  ou.uEnabled.value = outline.uEnabled;

  const pu = viewer.paletteUniforms;
  pu.enabled.value = palette.enabled;
  pu.hueLevels.value = palette.hueLevels;
  pu.toneLevels.value = palette.toneLevels;
  viewer.splat.updateVersion();

  viewer.scheduleRender();
}
