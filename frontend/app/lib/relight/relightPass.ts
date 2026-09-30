/**
 * Relight — lights a layer's own pixels from its depth field. Ported from the prototype
 * (frontend/app/pages/dev/relight.vue, 2026-09-29); every constant here was tuned there by eye.
 * Spec: docs/superpowers/specs/2026-09-30-relight-layer-effect-design.md ("Shader").
 */
import { GpuPost } from '~/lib/compositor/gpuPost'
import { FULL_DEPTH_RECT, type DepthRect, type FloatDepth } from './depthFieldCore'
import type { RelightEffect } from './settings'

export const RELIGHT_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uColor, uDepth;
uniform vec2 uDepthTexel, uImgTexel;
uniform vec4 uDepthRect;     // the part of the source the layer box shows: u0, v0, du, dv (top-down)
uniform float uAspect, uRelief, uKeep, uGloss, uDetail, uShadows, uLightCount;
uniform vec2 uLightPos[3];   // x, y (layer fractions, top-down)
uniform vec2 uLightHR[3];    // height, reach
uniform vec2 uLightRG[3];    // colour r, g (sRGB 0..1)
uniform vec2 uLightBP[3];    // colour b, brightness

// Lighting runs in top-down layer fractions p; textures are FLIP_Y-uploaded, so vUv.y = 1 is the top.
vec2 G(vec2 p) { return vec2(p.x, 1.0 - p.y); }
// The depth field covers the whole source image; only its lookup is remapped through the crop.
// uDepthTexel is one field texel expressed in p (box) units, so slopes still step one texel.
float H(vec2 p) { return texture(uDepth, G(uDepthRect.xy + p * uDepthRect.zw)).r; }

vec2 slopeAt(vec2 p) {
  vec2 e = uDepthTexel * 2.0;
  float dx = (H(p + vec2(e.x, 0.)) - H(p - vec2(e.x, 0.))) / (2.0 * e.x * uAspect);
  float dy = (H(p + vec2(0., e.y)) - H(p - vec2(0., e.y))) / (2.0 * e.y);
  return vec2(dx, dy) * uRelief * 0.05;
}

vec3 normalAt(vec2 p) {
  vec2 g = slopeAt(p);
  // A depth edge is a cliff, not a surface; where the photo can't separate the two sides it is
  // smeared into a ramp that lights up as a ridge line. On a cliff, borrow the slope from a few
  // texels away on the side whose depth matches this pixel.
  float cliff = smoothstep(0.6, 1.2, length(g));
  if (cliff > 0.0) {
    vec2 o = normalize(g) * uDepthTexel * 6.0;
    float hc = H(p);
    vec2 side = abs(H(p - o) - hc) < abs(H(p + o) - hc) ? p - o : p + o;
    vec2 gs = slopeAt(side);
    gs *= 1.0 - smoothstep(0.6, 1.2, length(gs));
    g = mix(g, gs, cliff);
  }
  // Fine relief from the photo itself: brighter reads raised.
  vec2 t = uImgTexel * 1.5;
  vec3 W = vec3(0.299, 0.587, 0.114);
  float lx = dot(texture(uColor, G(p + vec2(t.x, 0.))).rgb - texture(uColor, G(p - vec2(t.x, 0.))).rgb, W);
  float ly = dot(texture(uColor, G(p + vec2(0., t.y))).rgb - texture(uColor, G(p - vec2(0., t.y))).rgb, W);
  g += vec2(lx, ly) * uDetail;
  return normalize(vec3(-g, 1.0));
}

// Contact shadows only (a depth map can't place a long cast shadow), and occluders far in
// front of this pixel are skipped (subject vs wall would draw a wrong shifted silhouette).
float shadowTo(vec3 P, vec3 Lp) {
  vec3 d = normalize(Lp - P) * 0.06; float s = 1.0;
  float hP = P.z / max(uRelief * 0.05, 1e-4);
  for (int i = 1; i <= 24; i++) {
    float f = float(i) / 24.0;
    float t = f * f;                         // dense near the pixel: no bright sliver at edges
    vec3 q = P + d * t;
    vec2 p = vec2(q.x / uAspect, q.y);
    if (p.x < 0. || p.x > 1. || p.y < 0. || p.y > 1.) break;
    float hr = H(p);
    float near = 1.0 - smoothstep(0.06, 0.14, hr - hP);
    if (near <= 0.0) continue;
    float h = hr * uRelief * 0.05;
    s = min(s, mix(1.0, clamp(1.0 - (h - q.z - 0.003) * 40.0 * (1.0 - t), 0.0, 1.0), near));
  }
  return mix(0.45, 1.0, s);                  // never black: bounce light fills a shadow
}

vec3 toLin(vec3 c) { return pow(c, vec3(2.2)); }
vec3 toSrgb(vec3 c) { return pow(c, vec3(1.0 / 2.2)); }

void main() {
  vec2 p = vec2(vUv.x, 1.0 - vUv.y);
  vec4 src = texture(uColor, vUv);
  vec3 albedo = toLin(src.rgb);
  float h = H(p);
  vec3 N = normalAt(p);
  vec3 P = vec3(p.x * uAspect, p.y, h * uRelief * 0.05);
  vec3 light = vec3(uKeep);
  vec3 spec = vec3(0.);
  int count = int(uLightCount + 0.5);
  for (int i = 0; i < 3; i++) {
    if (i >= count) break;
    vec3 Lp = vec3(uLightPos[i].x * uAspect, uLightPos[i].y, uLightHR[i].x);
    vec3 d = Lp - P; float dist = length(d); vec3 L = d / dist;
    float lam = clamp((dot(N, L) + 0.25) / 1.25, 0.0, 1.0);
    float fall = 1.0 / (1.0 + pow(dist / max(uLightHR[i].y, 0.01), 2.0) * 2.0);
    float sh = (uShadows > 0.5 && uLightHR[i].x > 0.0) ? shadowTo(P, Lp) : 1.0;
    vec3 c = toLin(vec3(uLightRG[i], uLightBP[i].x)) * uLightBP[i].y * fall * sh;
    light += c * lam;
    spec += c * pow(max(dot(N, normalize(L + vec3(0., 0., 1.))), 0.0), 40.0) * uGloss;
  }
  vec3 col = albedo * light + spec;
  col = col / (1.0 + col * 0.15);            // soft shoulder instead of hard clipping
  fragColor = vec4(toSrgb(col), src.a);
}`

let pass: GpuPost | null = null
const getPass = () => (pass ??= new GpuPost(RELIGHT_FRAG))

const rgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]
}

export function packLights(fx: RelightEffect) {
  const on = fx.lights.filter(l => l.on).slice(0, 3)
  const uLightPos = new Float32Array(6), uLightHR = new Float32Array(6), uLightRG = new Float32Array(6), uLightBP = new Float32Array(6)
  on.forEach((l, i) => {
    const [r, g, b] = rgb(l.color)
    uLightPos.set([l.x, l.y], i * 2)
    uLightHR.set([l.height, l.reach], i * 2)
    uLightRG.set([r, g], i * 2)
    uLightBP.set([b, l.brightness], i * 2)
  })
  return { uLightPos, uLightHR, uLightRG, uLightBP, uLightCount: on.length }
}

export function relightShouldRun(fx: RelightEffect): boolean {
  return fx.visible !== false
}

export function relightAvailable(): boolean {
  return getPass().available()
}

export function relightUnavailableReason(): string {
  return getPass().unavailableReason()
}

/** Assertion marker: "Relight applied" vs "silently drawn plain". */
export function __relightRuns(): number {
  return getPass().runs
}

/** The crop rect and the field texel in box units (one field texel ÷ the rect's size). */
export function depthRectUniforms(rect: DepthRect, dw: number, dh: number): { uDepthRect: { vec4: [number, number, number, number] }; uDepthTexel: Float32Array } {
  const du = rect.du > 0 ? rect.du : 1, dv = rect.dv > 0 ? rect.dv : 1
  return {
    uDepthRect: { vec4: [rect.u0, rect.v0, du, dv] },
    uDepthTexel: new Float32Array([1 / (Math.max(1, dw) * du), 1 / (Math.max(1, dh) * dv)]),
  }
}

export function applyRelight(
  color: CanvasImageSource,
  depth: FloatDepth | CanvasImageSource,
  fx: RelightEffect,
  w: number,
  h: number,
  rect: DepthRect = FULL_DEPTH_RECT,
): HTMLCanvasElement | null {
  if (!relightShouldRun(fx)) return null
  const dw = 'kind' in (depth as object) ? (depth as FloatDepth).width : ((depth as HTMLImageElement).naturalWidth || (depth as HTMLCanvasElement).width)
  const dh = 'kind' in (depth as object) ? (depth as FloatDepth).height : ((depth as HTMLImageElement).naturalHeight || (depth as HTMLCanvasElement).height)
  return getPass().render(color, depth, w, h, {
    ...packLights(fx),
    ...depthRectUniforms(rect, dw, dh),
    uImgTexel: new Float32Array([1 / Math.max(1, w), 1 / Math.max(1, h)]),
    uAspect: w / Math.max(1, h),
    uRelief: fx.depth,
    uKeep: fx.keep,
    uGloss: fx.shine,
    uDetail: fx.texture,
    uShadows: fx.shadows ? 1 : 0,
  })
}
