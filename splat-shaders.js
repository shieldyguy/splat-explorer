// Custom Spark splat shaders for outline post-processing.
//
// Both shaders are near-verbatim copies of Spark 2.0's splatVertex.glsl /
// splatFragment.glsl with the minimum additions needed to:
//   1. Emit per-splat view-space normal as a flat varying (vertex stage).
//   2. Discard fragments below an alpha threshold so depth/normal write
//      only at "solid" splat surfaces.
//   3. Output color to MRT location 0 and packed normal to location 1.
//
// Sources (sparkjsdev/spark v2.0.0):
//   https://github.com/sparkjsdev/spark/blob/v2.0.0/src/shaders/splatVertex.glsl
//   https://github.com/sparkjsdev/spark/blob/v2.0.0/src/shaders/splatFragment.glsl
//
// Spark exposes its view transform as `renderToViewQuat` (quaternion). The
// per-splat view-space normal is the splat's smallest-axis basis vector
// rotated by `viewQuaternion = quatQuat(renderToViewQuat, quaternion)`.
// `quatVec` is provided by <splatDefines>.

export const SPLAT_VERT_GLSL = /* glsl */ `
precision highp float;
precision highp int;
precision highp usampler2DArray;

#include <splatDefines>

out vec4 vRgba;
out vec2 vSplatUv;
out vec3 vNdc;
flat out uint vSplatIndex;
flat out float adjustedStdDev;
flat out vec3 vViewNormal;

uniform vec2 renderSize;
uniform vec4 renderToViewQuat;
uniform vec3 renderToViewPos;
uniform mat3 renderToViewBasis;
uniform float maxStdDev;
uniform float minPixelRadius;
uniform float maxPixelRadius;
uniform bool enableExtSplats;
uniform bool enableCovSplats;
uniform float time;
uniform float deltaTime;
uniform bool debugFlag;
uniform float minAlpha;
uniform bool enable2DGS;
uniform bool lodInflate;
uniform float blurAmount;
uniform float preBlurAmount;
uniform float focalDistance;
uniform float apertureAngle;
uniform float clipXY;
uniform float focalAdjustment;

uniform usampler2D ordering;
uniform usampler2DArray extSplats;
uniform usampler2DArray extSplats2;

// Screen-space size controls (operate on pixel scale1/scale2 after projection).
uniform float screenScale;
uniform float screenIsotropy;
uniform float screenMinLength;
uniform float screenMaxLength;
uniform float screenMinWidth;
uniform float screenMaxWidth;

bool isPerspectiveMatrix( mat4 m ) {
    return m[ 2 ][ 3 ] == -1.0;
}

#include <logdepthbuf_pars_vertex>

// View-space surface normal for a non-covariance splat.
// The "thinnest" axis (smallest scale) is the surface normal direction;
// rotated by the view-space quaternion gives the camera-space normal.
vec3 computeViewNormal(vec3 scales, vec4 viewQuat) {
    float s01 = step(scales.x, scales.y);
    float s02 = step(scales.x, scales.z);
    float s12 = step(scales.y, scales.z);
    float wX = s01 * s02;
    float wY = (1.0 - s01) * s12;
    float wZ = 1.0 - wX - wY;
    vec3 localNormal = vec3(wX, wY, wZ);
    return normalize(quatVec(viewQuat, localNormal));
}

void main() {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    vViewNormal = vec3(0.0, 0.0, 1.0);

    ivec2 orderingCoord = ivec2((gl_InstanceID >> 2) & 4095, gl_InstanceID >> 14);
    uint splatIndex = texelFetch(ordering, orderingCoord, 0)[gl_InstanceID & 3];
    if (splatIndex == 0xffffffffu) {
        return;
    }

    ivec3 texCoord = splatTexCoord(int(splatIndex));
    vec3 center, scales, xxyyzz, xyxzyz;
    vec4 quaternion, rgba;
    mat3 cov3D;
    bvec3 zeroScales = bvec3(false);

    if (enableExtSplats) {
        uvec4 ext1 = texelFetch(extSplats, texCoord, 0);
        float alpha = unpackSplatExtAlpha(ext1);
        if ((alpha == 0.0) || (alpha < minAlpha)) {
            return;
        }
        uvec4 ext2 = texelFetch(extSplats2, texCoord, 0);

        if (!enableCovSplats) {
            unpackSplatExt(ext1, ext2, center, scales, quaternion, rgba);
            zeroScales = equal(scales, vec3(0.0));
            if (all(zeroScales)) {
                return;
            }
        } else {
            unpackSplatExtCov(ext1, ext2, center, rgba, xxyyzz, xyxzyz);
            if (all(equal(xxyyzz, vec3(0.0))) && all(equal(xyxzyz, vec3(0.0)))) {
                return;
            }
        }
    } else {
        uvec4 packed = texelFetch(extSplats, texCoord, 0);
        if (!enableCovSplats) {
            unpackSplatEncoding(packed, center, scales, quaternion, rgba, vec4(0.0, 1.0, LN_SCALE_MIN, LN_SCALE_MAX));
            zeroScales = equal(scales, vec3(0.0));
            if (all(zeroScales)) {
                return;
            }
        } else {
            unpackSplatCovEncoding(packed, center, rgba, xxyyzz, xyxzyz, vec4(0.0, 1.0, LN_SCALE_MIN, LN_SCALE_MAX));
            if (all(equal(xxyyzz, vec3(0.0))) && all(equal(xyxzyz, vec3(0.0)))) {
                return;
            }
        }

        rgba.a *= 2.0;
        if ((rgba.a == 0.0) || (rgba.a < minAlpha)) {
            return;
        }
    }

    adjustedStdDev = maxStdDev;
    if (rgba.a > 1.0) {
        rgba.a = min(rgba.a * 4.0 - 3.0, 5.0);

        if (lodInflate) {
            float opacity = exp((rgba.a * rgba.a - 1.0) / 2.718281828459045);
            float rescale = pow(opacity, 1.0 / 3.0);
            scales *= rescale;
            rgba.a = 1.0;
        }

        adjustedStdDev = maxStdDev + 0.7 * (rgba.a - 1.0);
    }

    vec3 viewCenter = (!enableCovSplats ? quatVec(renderToViewQuat, center) : (renderToViewBasis * center)) + renderToViewPos;

    if (viewCenter.z >= 0.0) {
        return;
    }

    vec4 clipCenter = projectionMatrix * vec4(viewCenter, 1.0);

    if (abs(clipCenter.z) >= clipCenter.w) {
        return;
    }

    float clip = clipXY * clipCenter.w;
    if (abs(clipCenter.x) > clip || abs(clipCenter.y) > clip) {
        return;
    }

    vRgba = rgba;
    vSplatUv = position.xy * adjustedStdDev;
    vSplatIndex = splatIndex;

    if (!enableCovSplats) {
        vec4 viewQuaternion = quatQuat(renderToViewQuat, quaternion);
        vViewNormal = computeViewNormal(scales, viewQuaternion);

        if (enable2DGS && any(zeroScales)) {
            vec3 offset;
            if (zeroScales.z) {
                offset = vec3(vSplatUv.xy * scales.xy, 0.0);
            } else if (zeroScales.y) {
                offset = vec3(vSplatUv.x * scales.x, 0.0, vSplatUv.y * scales.z);
            } else {
                offset = vec3(0.0, vSplatUv.xy * scales.yz);
            }

            vec3 viewPos = viewCenter + quatVec(viewQuaternion, offset);
            gl_Position = projectionMatrix * vec4(viewPos, 1.0);
            vNdc = gl_Position.xyz / gl_Position.w;

            #include <logdepthbuf_vertex>
            return;
        }

        mat3 RS = scaleQuaternionToMatrix(scales, viewQuaternion);
        cov3D = RS * transpose(RS);
    } else {
        cov3D = mat3(
            xxyyzz.x, xyxzyz.x, xyxzyz.y,
            xyxzyz.x, xxyyzz.y, xyxzyz.z,
            xyxzyz.y, xyxzyz.z, xxyyzz.z
        );
        cov3D = renderToViewBasis * cov3D * transpose(renderToViewBasis);
        // No quaternion available in covariance path — fall back to camera-facing.
        vViewNormal = vec3(0.0, 0.0, 1.0);
    }

    vec2 scaledRenderSize = renderSize * focalAdjustment;
    vec2 focal = 0.5 * scaledRenderSize * vec2(projectionMatrix[0][0], projectionMatrix[1][1]);

    mat3 J;
    if (isOrthographic) {
        J = mat3(
            focal.x, 0.0, 0.0,
            0.0, focal.y, 0.0,
            0.0, 0.0, 0.0
        );
    } else {
        float invZ = 1.0 / viewCenter.z;
        vec2 J1 = focal * invZ;
        vec2 J2 = -(J1 * viewCenter.xy) * invZ;
        J = mat3(
            J1.x, 0.0, J2.x,
            0.0, J1.y, J2.y,
            0.0, 0.0, 0.0
        );
    }

    mat3 cov2D = transpose(J) * cov3D * J;
    float a = cov2D[0][0];
    float d = cov2D[1][1];
    float b = cov2D[0][1];

    a += preBlurAmount;
    d += preBlurAmount;

    float fullBlurAmount = blurAmount;
    if ((focalDistance > 0.0) && (apertureAngle > 0.0)) {
        float focusRadius = maxPixelRadius;
        if (viewCenter.z < 0.0) {
            float focusBlur = abs((-viewCenter.z - focalDistance) / viewCenter.z);
            float apertureRadius = focal.x * tan(0.5 * apertureAngle);
            focusRadius = focusBlur * apertureRadius;
        }
        fullBlurAmount = clamp(sqr(focusRadius), blurAmount, sqr(maxPixelRadius));
    }

    float detOrig = a * d - b * b;
    a += fullBlurAmount;
    d += fullBlurAmount;
    float det = a * d - b * b;

    float blurAdjust = sqrt(max(0.0, detOrig / det));
    rgba.a *= blurAdjust;
    if (rgba.a < minAlpha) {
        return;
    }
    vRgba.a = rgba.a;

    float eigenAvg = 0.5 * (a + d);
    float eigenDelta = sqrt(max(0.0, eigenAvg * eigenAvg - det));
    float eigen1 = eigenAvg + eigenDelta;
    float eigen2 = eigenAvg - eigenDelta;

    vec2 eigenVec1 = (abs(b) > 0.001) ? normalize(vec2(b, eigen1 - a))
        : ((a >= d) ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
    vec2 eigenVec2 = vec2(eigenVec1.y, -eigenVec1.x);

    float scale1 = min(maxPixelRadius, adjustedStdDev * sqrt(eigen1));
    float scale2 = min(maxPixelRadius, adjustedStdDev * sqrt(eigen2));

    // === Screen-space size controls (operate in pixels, post-projection) ===
    scale1 *= screenScale;
    scale2 *= screenScale;

    // Isotropy: lerp both axes toward their mean → square quad → screen-circle splat.
    float meanScale = (scale1 + scale2) * 0.5;
    scale1 = mix(scale1, meanScale, screenIsotropy);
    scale2 = mix(scale2, meanScale, screenIsotropy);

    // Per-axis pixel clamps (defensive against min > max).
    scale1 = clamp(scale1, min(screenMinLength, screenMaxLength),
                           max(screenMinLength, screenMaxLength));
    scale2 = clamp(scale2, min(screenMinWidth,  screenMaxWidth),
                           max(screenMinWidth,  screenMaxWidth));

    if (scale1 < minPixelRadius && scale2 < minPixelRadius) {
        return;
    }

    vec2 pixelOffset = position.x * eigenVec1 * scale1 + position.y * eigenVec2 * scale2;
    vec2 ndcOffset = (2.0 / scaledRenderSize) * pixelOffset;

    vec3 ndcCenter = clipCenter.xyz / clipCenter.w;
    vec3 ndc = vec3(ndcCenter.xy + ndcOffset, ndcCenter.z);

    vNdc = ndc;
    gl_Position = vec4(ndc.xy * clipCenter.w, clipCenter.zw);

    #include <logdepthbuf_vertex>
}
`;

export const SPLAT_FRAG_GLSL = /* glsl */ `
precision highp float;
precision highp int;

#include <splatDefines>

uniform float near;
uniform float far;
uniform bool encodeLinear;
uniform float time;
uniform bool debugFlag;
uniform float maxStdDev;
uniform float minAlpha;
uniform bool disableFalloff;
uniform float falloff;          // built-in (kept declared so Spark's setter is harmless)
uniform float splatFalloff;     // ours: 0 = flat, 1 = full gaussian
uniform float alphaThreshold;
uniform float minOpacity;       // floor on per-splat alpha (lifts everyone vs filtering)
uniform int   splatShape;       // 0=ellipse 1=stadium 2=rect 3=diamond 4=leaf 5=brush
uniform float splatAspect;      // 1 = natural, >1 = stretched along long axis

layout(location = 0) out vec4 fragColor;
layout(location = 1) out vec4 fragNormal;

in vec4 vRgba;
in vec2 vSplatUv;
in vec3 vNdc;
flat in uint vSplatIndex;
flat in float adjustedStdDev;
flat in vec3 vViewNormal;

#include <logdepthbuf_pars_fragment>

void main() {
    vec4 rgba = vRgba;

    float z2 = dot(vSplatUv, vSplatUv);
    if (z2 > (adjustedStdDev * adjustedStdDev)) {
        discard;
    }

    // --- Shape boundary in normalized [-1, +1] uv space ---
    // x is the splat's long axis, y is the short axis.
    vec2 nuv = vSplatUv / adjustedStdDev;
    float a = max(0.0001, splatAspect);
    bool keep = true;
    if (splatShape == 0) {
        float ay = a * nuv.y;
        keep = (nuv.x * nuv.x + ay * ay) <= 1.0;
    } else if (splatShape == 1) {
        // Stadium / pill
        float r = 1.0 / a;
        float halfLen = max(0.0, 1.0 - r);
        float dx = max(abs(nuv.x) - halfLen, 0.0);
        keep = (dx * dx + nuv.y * nuv.y) <= r * r;
    } else if (splatShape == 2) {
        // Rectangle
        keep = abs(nuv.x) <= 1.0 && abs(nuv.y) <= (1.0 / a);
    } else if (splatShape == 3) {
        // Diamond
        keep = (abs(nuv.x) + a * abs(nuv.y)) <= 1.0;
    } else if (splatShape == 4) {
        // Vesica / leaf — two circles offset along y, intersecting in a lens
        float a2 = a * a;
        float R = (a2 + 1.0) / (2.0 * a);
        float d = R * (a2 - 1.0) / (a2 + 1.0);
        vec2 c1 = vec2(0.0, -d);
        vec2 c2 = vec2(0.0,  d);
        keep = (distance(nuv, c1) <= R) && (distance(nuv, c2) <= R);
    } else if (splatShape == 5) {
        // Asymmetric brush — half-disc on the left, taper to point on the right
        float r = 1.0 / a;
        if (nuv.x < 0.0) {
            keep = (nuv.x * nuv.x + nuv.y * nuv.y) <= r * r;
        } else {
            float w = r * (1.0 - nuv.x);
            keep = (nuv.x <= 1.0) && (abs(nuv.y) <= w);
        }
    }
    if (!keep) discard;

    if (rgba.a <= 1.0) {
        rgba.a = mix(rgba.a, rgba.a * exp(-0.5 * z2), splatFalloff);
    } else {
        float a = exp((rgba.a*rgba.a - 1.0) / 2.718281828459045);
        float alpha = 1.0 - pow(1.0 - exp(-0.5 * z2), a);
        rgba.a = mix(1.0, alpha, splatFalloff);
    }

    // Lift everyone to at least minOpacity before discard checks — this
    // turns "alpha threshold filters them out" into "alpha threshold AND
    // min opacity together set the visible floor".
    rgba.a = max(rgba.a, minOpacity);

    if (rgba.a < minAlpha) {
        discard;
    }
    if (rgba.a < alphaThreshold) {
        discard;
    }
    if (encodeLinear) {
        rgba.rgb = srgbToLinear(rgba.rgb);
    }

    fragColor = vec4(rgba.rgb * rgba.a, rgba.a);

    // Pack view-space normal into RGB ([-1,1] → [0,1]). Alpha=1 marks "valid normal".
    fragNormal = vec4(normalize(vViewNormal) * 0.5 + 0.5, 1.0);

    #include <logdepthbuf_fragment>
}
`;
