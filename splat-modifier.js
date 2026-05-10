// Per-splat dyno modifiers. Currently: palette quantization (poster look).
//
// Each splat's RGB is converted to HSV, bucket-center-quantized per channel,
// converted back to RGB. Hue and tone (S+V) are controlled independently so
// you can pick "4 hues with smooth shading" or "everything is one color".
//
// Caveat: this is a uniform HSV grid, not a content-aware palette. The hues
// are evenly spaced around the color wheel regardless of whether the splat
// is mostly green, brown, etc. For splat-aware palettes we'd need CPU-side
// k-means on a sample of the .ply colors — fine future direction, but more
// work and Spark-internals dependent.

import { dyno } from "@sparkjsdev/spark";

export function createPaletteModifier({
  enabled = false,
  hueLevels = 8.0,
  toneLevels = 4.0,
} = {}) {
  const uniforms = {
    enabled: dyno.dynoBool(enabled),
    hueLevels: dyno.dynoFloat(hueLevels),
    toneLevels: dyno.dynoFloat(toneLevels),
  };

  const node = new dyno.Dyno({
    inTypes: {
      gsplat: dyno.Gsplat,
      enabled: "bool",
      hueLevels: "float",
      toneLevels: "float",
    },
    outTypes: { gsplat: dyno.Gsplat },
    statements: ({ inputs, outputs }) => dyno.unindentLines(`
      ${outputs.gsplat} = ${inputs.gsplat};
      if (${inputs.enabled}) {
        vec3 rgb = clamp(${inputs.gsplat}.rgba.rgb, 0.0, 1.0);

        // RGB -> HSV (Sam Hocevar's branchless conversion)
        vec4 K1 = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
        vec4 p = mix(vec4(rgb.bg, K1.wz), vec4(rgb.gb, K1.xy), step(rgb.b, rgb.g));
        vec4 q = mix(vec4(p.xyw, rgb.r), vec4(rgb.r, p.yzx), step(p.x, rgb.r));
        float dd = q.x - min(q.w, q.y);
        vec3 hsv = vec3(
          abs(q.z + (q.w - q.y) / (6.0 * dd + 1e-10)),
          dd / (q.x + 1e-10),
          q.x
        );

        // Bucket-center quantize: each channel snaps to (k+0.5)/N
        // where N is the level count for that channel.
        vec3 n = vec3(
          max(1.0, ${inputs.hueLevels}),
          max(1.0, ${inputs.toneLevels}),
          max(1.0, ${inputs.toneLevels})
        );
        hsv = (floor(hsv * n) + 0.5) / n;
        hsv = clamp(hsv, 0.0, 1.0);

        // HSV -> RGB
        vec4 K2 = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
        vec3 pp = abs(fract(hsv.xxx + K2.xyz) * 6.0 - K2.www);
        rgb = hsv.z * mix(K2.xxx, clamp(pp - K2.xxx, 0.0, 1.0), hsv.y);

        ${outputs.gsplat}.rgba.rgb = rgb;
      }
    `),
  });

  const modifier = dyno.dynoBlock(
    { gsplat: dyno.Gsplat },
    { gsplat: dyno.Gsplat },
    ({ gsplat }) => {
      const out = node.apply({
        gsplat,
        enabled: uniforms.enabled,
        hueLevels: uniforms.hueLevels,
        toneLevels: uniforms.toneLevels,
      });
      return { gsplat: out.gsplat };
    },
  );

  return { modifier, uniforms };
}
