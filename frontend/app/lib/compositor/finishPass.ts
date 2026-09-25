/**
 * Gold foil and Spot UV — print finishes lit by the Frame's one light (frameLight.ts).
 * Both are GpuPost passes over a layer's device-resolution offscreen: the layer's own alpha is
 * the mask, and a ring of alpha samples gives the pressed-in (foil) or raised (varnish) edge.
 * Look constants come from the Finish proofs prototype
 * (https://claude.ai/artifact/ARWNKLm4DiKuwEjij4bjhq) — tune by eye, one change at a time.
 *
 * Orientation: GpuPost uploads with UNPACK_FLIP_Y, so vUv.y = 1 is the TOP of the image;
 * lightWorld() already flips y to match.
 */
import { GpuPost, type GpuUniform } from './gpuPost'
import { lightWorld, type FrameLight } from './frameLight'

export type FoilMetal = 'gold' | 'silver' | 'rose' | 'copper'
export const METALS: Record<FoilMetal, readonly [string, string, string, string]> = {
  gold:   ['#241503', '#86561a', '#d8a443', '#fff1c6'],
  silver: ['#1a1d22', '#6c737d', '#c8cdd5', '#ffffff'],
  rose:   ['#28120e', '#8f5147', '#dea08d', '#fff0ea'],
  copper: ['#200e05', '#7a3a17', '#d07a3e', '#ffdcbc'],
}
export const METAL_LABELS: Record<FoilMetal, string> = { gold: 'Gold', silver: 'Silver', rose: 'Rose gold', copper: 'Copper' }

export interface FoilDials { metal: FoilMetal; brushed: number; pressed: number }
export interface SpotUvDials { gloss: number; raised: number; varnishOnly: boolean }

const COMMON = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uColor;
uniform vec2 uSize;     // device px
uniform float uScale;   // device px per logical px
uniform float uAspect;  // h / w
uniform vec3 uLight;    // world space, see lightWorld()
const vec3 CAMERA = vec3(0.0, 0.0, 2.6);
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
// Gradient of the blurred alpha (points INTO the shape), from two rings of 12 samples.
vec2 alphaGrad(vec2 uv, float rPx) {
  vec2 g = vec2(0.0);
  for (int i = 0; i < 12; i++) {
    float a = float(i) * 0.5235988;
    vec2 d = vec2(cos(a), sin(a));
    g += d * (texture(uColor, uv + d * rPx / uSize).a + texture(uColor, uv + d * 0.5 * rPx / uSize).a);
  }
  return g / 12.0;
}
vec3 worldPos(vec2 uv) { return vec3(uv.x - 0.5, (uv.y - 0.5) * uAspect, 0.0); }
`

export const FOIL_FRAG = `${COMMON}
uniform vec3 uM0;
uniform vec3 uM1;
uniform vec3 uM2;
uniform vec3 uM3;
uniform float uBrushed;
uniform float uPressed;
vec3 ramp(float t) {
  t = clamp(t, 0.0, 1.0);
  if (t < 0.33) return mix(uM0, uM1, t / 0.33);
  if (t < 0.66) return mix(uM1, uM2, (t - 0.33) / 0.33);
  return mix(uM2, uM3, (t - 0.66) / 0.34);
}
void main() {
  vec4 src = texture(uColor, vUv);
  if (src.a <= 0.0) { fragColor = vec4(0.0); return; }
  vec2 px = vUv * uSize / uScale;                       // logical px: grain size is resolution-free
  vec2 g = alphaGrad(vUv, 3.0 * uScale);
  float st = vnoise(vec2(px.x * 0.004, px.y * 0.9)) - 0.5;
  float st2 = vnoise(vec2(px.x * 0.02, px.y * 2.3) + 3.0) - 0.5;
  // Pressed in: the surface slopes DOWN into the shape, so the normal leans along +g.
  vec3 N = normalize(vec3(g * uPressed * 1.2 + vec2(0.0, (st * 0.10 + st2 * 0.05) * uBrushed), 1.0));
  vec3 P = worldPos(vUv);
  vec3 V = normalize(CAMERA - P);
  vec3 L = normalize(uLight - P);
  vec3 R = reflect(-V, N);
  float rl = dot(R, L);
  float df = max(dot(N, L), 0.0);
  float t = 0.10 + 0.25 * df * df + 0.55 * smoothstep(0.80, 0.99, rl) + 0.9 * pow(max(rl, 0.0), 140.0)
          + 0.14 * (R.y * 0.5 + 0.5) + (st + st2 * 0.5) * uBrushed * 0.2;
  vec3 c = ramp(t) * (1.0 + max(t - 1.0, 0.0) * 1.5);
  float ero = vnoise(px * 0.45) - 0.5;                  // stamped foil never has a perfect edge
  fragColor = vec4(min(c, vec3(1.0)), smoothstep(0.3, 0.7, src.a + ero * 0.3));
}`

export const SPOT_UV_FRAG = `${COMMON}
uniform float uGloss;
uniform float uRaised;
uniform float uVarnishOnly;
void main() {
  vec4 src = texture(uColor, vUv);
  if (src.a <= 0.0) { fragColor = vec4(0.0); return; }
  vec2 g = alphaGrad(vUv, 2.0 * uScale);
  // Raised: the surface slopes UP into the shape, so the normal leans along -g.
  vec3 N = normalize(vec3(-g * uRaised, 1.0));
  vec3 P = worldPos(vUv);
  vec3 V = normalize(CAMERA - P);
  vec3 L = normalize(uLight - P);
  vec3 R = reflect(-V, N);
  float rl = dot(R, L);
  float k = mix(0.10, 0.03, uGloss);
  float box = smoothstep(1.0 - k, 1.0 - k * 0.45, rl);   // the lamp's reflection
  float sharp = pow(max(rl, 0.0), mix(90.0, 1200.0, uGloss));
  float fres = 0.04 + 0.96 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
  float shine = box * mix(0.3, 0.85, uGloss) + sharp * 1.3 + fres * 0.2;
  // Edge shading relative to a flat surface, so the coat never dims the layer overall.
  float lit = 1.0 + 0.4 * (max(dot(N, L), 0.0) - max(L.z, 0.0));
  if (uVarnishOnly > 0.5) {
    // Coat only: white where it shines, a faint dark where it deepens; drawn over what is below.
    float lift = clamp(shine, 0.0, 1.0);
    float dk = clamp(0.06 + max(1.0 - lit, 0.0) * 0.5, 0.0, 1.0);
    fragColor = vec4(vec3(lift / max(lift + dk, 1e-4)), max(lift, dk) * src.a);
  } else {
    vec3 wet = pow(src.rgb, vec3(1.15)) * 1.04 * lit;   // varnish deepens the print
    fragColor = vec4(min(wet + vec3(shine), vec3(1.0)), src.a);
  }
}`

const clamp01 = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0))
function hexVec3(hex: string): { vec3: [number, number, number] } {
  const n = parseInt(hex.slice(1), 16)
  return { vec3: [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255] }
}
function shared(light: FrameLight, w: number, h: number, scale: number): Record<string, GpuUniform> {
  const aspect = h / Math.max(1, w)
  return { uSize: new Float32Array([w, h]), uScale: scale, uAspect: aspect, uLight: { vec3: lightWorld(light, aspect) } }
}

export function foilUniforms(d: FoilDials, light: FrameLight, w: number, h: number, scale: number): Record<string, GpuUniform> {
  const m = METALS[d.metal] ?? METALS.gold
  return {
    ...shared(light, w, h, scale),
    uM0: hexVec3(m[0]), uM1: hexVec3(m[1]), uM2: hexVec3(m[2]), uM3: hexVec3(m[3]),
    uBrushed: clamp01(d.brushed), uPressed: clamp01(d.pressed),
  }
}

export function spotUvUniforms(d: SpotUvDials, light: FrameLight, w: number, h: number, scale: number): Record<string, GpuUniform> {
  return { ...shared(light, w, h, scale), uGloss: clamp01(d.gloss), uRaised: clamp01(d.raised), uVarnishOnly: d.varnishOnly ? 1 : 0 }
}

let foilPass: GpuPost | null = null
let uvPass: GpuPost | null = null
const getFoil = () => (foilPass ??= new GpuPost(FOIL_FRAG))
const getUv = () => (uvPass ??= new GpuPost(SPOT_UV_FRAG))

export type FinishKind = 'gold_foil' | 'spot_uv'
const passFor = (kind: FinishKind) => (kind === 'gold_foil' ? getFoil() : getUv())

/** Per kind: one finish's shader failing must not take the other down with it. */
export function finishAvailable(kind: FinishKind): boolean { return passFor(kind).available() }
/** What the inspector tells the person when this finish cannot draw here ('' when it can). A plain
 *  sentence: the raw cause (a GLSL log, a missing context) is already console.error'd by GpuPost. */
export function finishUnavailableReason(kind: FinishKind): string {
  return finishAvailable(kind) ? '' : "Finishes need WebGL 2, which this browser can't provide right now."
}

// GpuPost always binds a second texture (DOF's depth). Finishes never read it, so hand it one
// transparent pixel rather than uploading the whole layer a second time.
let noDepth: HTMLCanvasElement | null = null
function unusedDepth(): HTMLCanvasElement {
  if (!noDepth) { noDepth = document.createElement('canvas'); noDepth.width = 1; noDepth.height = 1 }
  return noDepth
}

/** Run a finish over `off` in place. False = did not run (no WebGL2 / empty) and `off` is untouched,
 *  so the layer draws plain. The result canvas is GpuPost's and is reused, so it is copied now. */
export function applyFinish(
  off: HTMLCanvasElement, kind: FinishKind, dials: FoilDials | SpotUvDials, light: FrameLight, scale: number,
): boolean {
  const w = off.width, h = off.height
  if (w < 1 || h < 1) return false
  const out = kind === 'gold_foil'
    ? getFoil().render(off, unusedDepth(), w, h, foilUniforms(dials as FoilDials, light, w, h, scale))
    : getUv().render(off, unusedDepth(), w, h, spotUvUniforms(dials as SpotUvDials, light, w, h, scale))
  if (!out) return false
  const ctx = off.getContext('2d')
  if (!ctx) return false
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, w, h)
  ctx.drawImage(out, 0, 0)
  ctx.restore()
  return true
}
