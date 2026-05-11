// Multi-pass outline pipeline for Spark splat scenes.
//
// Pass 1: scene + splats → MRT WebGLRenderTarget
//   attachment 0 (color):   normal Spark color output
//   attachment 1 (normal):  per-splat view-space normal, packed RGB
//   depth:                  standard DepthTexture
//   The custom splat shaders (splat-shaders.js) discard fragments below
//   alphaThreshold so depth/normal write only at "solid" splat surfaces.
// Pass 2: fullscreen quad samples color + depth + normal, runs Sobel on
//   both depth and normal, mixes the two via uEdgeMix (0=depth, 1=normal),
//   composites outline over scene.

import * as THREE from "three";

const OUTLINE_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const OUTLINE_FRAG = /* glsl */ `
precision highp float;

varying vec2 vUv;

uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform sampler2D tNormal;
uniform vec2  uResolution;
uniform float uDepthThreshold;
uniform float uNormalThreshold;
uniform float uEdgeMix;          // 0 = depth edges, 1 = normal edges
uniform float uRadius;
uniform float uOutlineWidth;
uniform vec3  uOutlineColor;
uniform float uOutlineOpacity;
uniform float uNear;
uniform float uFar;
uniform bool  uShowDepth;
uniform bool  uShowNormals;
uniform bool  uShowColor;
uniform bool  uOutlinesOnly;
uniform bool  uEnabled;
uniform bool  uPassthrough;   // diag: bypass all composite math, write FBO color straight through

float linearizeDepth(float d) {
  float z = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
}

float sampleLinearDepth(vec2 uv) {
  return linearizeDepth(texture2D(tDepth, uv).r);
}

vec3 sampleNormal(vec2 uv) {
  // Decode packed normal RGB ([0,1] → [-1,1]). Returns (0,0,0) where
  // tNormal.a == 0 (no splat written here).
  vec4 n = texture2D(tNormal, uv);
  return n.a > 0.5 ? (n.rgb * 2.0 - 1.0) : vec3(0.0);
}

void main() {
  vec4 sceneColor = texture2D(tDiffuse, vUv);
  if (uPassthrough) {
    gl_FragColor = sceneColor;
    return;
  }
  vec2 texel = uRadius / uResolution;

  float dc = sampleLinearDepth(vUv);
  vec3  nc = sampleNormal(vUv);

  // Pick the base color based on the show-mode toggles. Each variant is
  // pre-masked by sceneColor.a so empty pixels stay transparent — i.e.
  // the FBO is in premultiplied alpha and we keep that contract.
  vec3 baseRgb;
  if (uShowDepth) {
    float n = clamp(dc / uFar, 0.0, 1.0);
    float v = pow(1.0 - n, 2.0);
    baseRgb = vec3(v * 0.3, v * 0.5, v * 0.8) * sceneColor.a;
  } else if (uShowNormals) {
    baseRgb = (nc * 0.5 + 0.5) * sceneColor.a;
  } else if (uShowColor) {
    baseRgb = sceneColor.rgb;  // already premultiplied
  } else {
    baseRgb = vec3(0.04) * sceneColor.a;
  }

  // Compute outline only if enabled (otherwise the show-mode renders alone).
  float outline = 0.0;
  if (uEnabled) {
    float steps = max(1.0, uOutlineWidth);
    float depthEdge  = 0.0;
    float normalEdge = 0.0;
    for (float s = 1.0; s <= 6.0; s += 1.0) {
      if (s > steps) break;
      float scale = s / steps;
      vec2 off = texel * scale;

      float dL = sampleLinearDepth(vUv + vec2(-off.x, 0.0));
      float dR = sampleLinearDepth(vUv + vec2( off.x, 0.0));
      float dU = sampleLinearDepth(vUv + vec2(0.0,  off.y));
      float dD = sampleLinearDepth(vUv + vec2(0.0, -off.y));
      float ddx = abs(dR - dL);
      float ddy = abs(dU - dD);
      depthEdge = max(depthEdge, sqrt(ddx * ddx + ddy * ddy));

      vec3 nL = sampleNormal(vUv + vec2(-off.x, 0.0));
      vec3 nR = sampleNormal(vUv + vec2( off.x, 0.0));
      vec3 nU = sampleNormal(vUv + vec2(0.0,  off.y));
      vec3 nD = sampleNormal(vUv + vec2(0.0, -off.y));
      float nx = (1.0 - dot(nL, nR));
      float ny = (1.0 - dot(nU, nD));
      normalEdge = max(normalEdge, sqrt(nx * nx + ny * ny));
    }

    float depthAdaptive = uDepthThreshold * (0.5 + dc);
    float depthOutline  = smoothstep(depthAdaptive * 0.6, depthAdaptive * 1.4, depthEdge);
    float normalOutline = smoothstep(uNormalThreshold * 0.6, uNormalThreshold * 1.4, normalEdge);
    outline = mix(depthOutline, normalOutline, uEdgeMix);
  }

  float a = outline * uOutlineOpacity;

  if (uOutlinesOnly) {
    gl_FragColor = vec4(uOutlineColor, a);
    return;
  }

  vec3 finalRgb = mix(baseRgb, uOutlineColor, a);
  float finalA = max(sceneColor.a, a);

  gl_FragColor = vec4(finalRgb, finalA);
}
`;

export function createOutlinePass({ width = 1, height = 1 } = {}) {
  const depthTexture = new THREE.DepthTexture(width, height);
  depthTexture.type = THREE.UnsignedShortType;
  depthTexture.format = THREE.DepthFormat;

  const renderTarget = new THREE.WebGLRenderTarget(width, height, {
    count: 2,
    depthTexture,
    depthBuffer: true,
    stencilBuffer: false,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
  });
  // texture[0] = color, texture[1] = packed normal (RGB) + alpha mask

  const uniforms = {
    tDiffuse: { value: renderTarget.textures[0] },
    tDepth: { value: depthTexture },
    tNormal: { value: renderTarget.textures[1] },
    uResolution: { value: new THREE.Vector2(width, height) },
    uDepthThreshold: { value: 0.03 },
    uNormalThreshold: { value: 0.4 },
    uEdgeMix: { value: 0.0 },     // default: pure depth edges
    uRadius: { value: 1.5 },
    uOutlineWidth: { value: 2.0 },
    uOutlineColor: { value: new THREE.Color("#171717") },
    uOutlineOpacity: { value: 1.0 },
    uNear: { value: 0.1 },
    uFar: { value: 100.0 },
    uShowDepth: { value: false },
    uShowNormals: { value: false },
    uShowColor: { value: true },
    uOutlinesOnly: { value: false },
    uEnabled: { value: false },
    uPassthrough: { value: false },
  };

  const material = new THREE.ShaderMaterial({
    vertexShader: OUTLINE_VERT,
    fragmentShader: OUTLINE_FRAG,
    uniforms,
    // The fullscreen quad covers the entire canvas and the FBO already
    // holds premultiplied-alpha pixels (splats blended with srcAlpha into
    // a transparent target). Writing straight through with NoBlending
    // preserves that premultiplication; using the default srcAlpha
    // blending would premultiply a second time and produce dark fringes.
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
  });

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  scene.add(quad);

  function setSize(w, h) {
    renderTarget.setSize(w, h);
    uniforms.uResolution.value.set(w, h);
  }

  function dispose() {
    renderTarget.dispose();
    depthTexture.dispose();
    material.dispose();
    quad.geometry.dispose();
  }

  return {
    renderTarget,
    scene,
    camera,
    uniforms,
    material,
    setSize,
    dispose,
  };
}
