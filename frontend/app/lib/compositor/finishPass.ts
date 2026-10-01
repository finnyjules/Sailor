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

// The dials of a foil paint (paint.ts's `FoilFill`). `grain` is required: the only caller is the
// foil paint, which always carries one. `foilUniforms` still reads a malformed stored value
// (missing / NaN) as 0 rather than trusting it.
export interface FoilDials { metal: FoilMetal; brushed: number; pressed: number; grain: number }
export interface SpotUvDials { gloss: number; raised: number; varnishOnly: boolean }

export const FINISH_COMMON = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uColor;
uniform vec2 uSize;     // device px of THIS texture (a region's box, or the whole frame)
uniform vec2 uOrigin;   // the texture's bottom-left inside the frame, device px (y up)
uniform vec2 uFull;     // the whole frame, device px
uniform float uScale;   // device px per logical px
uniform float uAspect;  // frame h / frame w
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
// Texture uv -> FRAME uv: lighting, grain and the foil's edge wear are laid out over the whole
// frame, so a region rendered in its own box looks exactly as it would in a full-frame pass.
// (uOrigin 0, uFull = uSize: the identity.) frameUvOf() in TS mirrors this for the tests.
vec2 frameUv(vec2 uv) { return (uv * uSize + uOrigin) / uFull; }
vec3 worldPos(vec2 uv) { return vec3(uv.x - 0.5, (uv.y - 0.5) * uAspect, 0.0); }
`

export const FOIL_FRAG = `${FINISH_COMMON}
uniform vec3 uM0;
uniform vec3 uM1;
uniform vec3 uM2;
uniform vec3 uM3;
uniform float uBrushed;
uniform float uPressed;
uniform float uGrain;
vec3 ramp(float t) {
  t = clamp(t, 0.0, 1.0);
  if (t < 0.33) return mix(uM0, uM1, t / 0.33);
  if (t < 0.66) return mix(uM1, uM2, (t - 0.33) / 0.33);
  return mix(uM2, uM3, (t - 0.66) / 0.34);
}
void main() {
  vec4 src = texture(uColor, vUv);
  if (src.a <= 0.0) { fragColor = vec4(0.0); return; }
  vec2 px = (vUv * uSize + uOrigin) / uScale;           // frame logical px: grain size is resolution-free
  vec2 g = alphaGrad(vUv, 3.0 * uScale);
  float st = vnoise(vec2(px.x * 0.004, px.y * 0.9)) - 0.5;
  float st2 = vnoise(vec2(px.x * 0.02, px.y * 2.3) + 3.0) - 0.5;
  // Pressed in: the surface slopes DOWN into the shape, so the normal leans along +g.
  vec3 N = normalize(vec3(g * uPressed * 1.2 + vec2(0.0, (st * 0.10 + st2 * 0.05) * uBrushed) + (vec2(hash(floor(px*1.5)), hash(floor(px*1.5) + 7.0)) - 0.5) * uGrain * 0.5, 1.0));
  vec3 P = worldPos(frameUv(vUv));
  vec3 V = normalize(CAMERA - P);
  vec3 L = normalize(uLight - P);
  vec3 R = reflect(-V, N);
  float rl = dot(R, L);
  float df = max(dot(N, L), 0.0);
  float t = 0.10 + 0.25 * df * df + 0.55 * smoothstep(0.80, 0.99, rl) + 0.9 * pow(max(rl, 0.0), 140.0)
          + 0.14 * (R.y * 0.5 + 0.5) + (st + st2 * 0.5) * uBrushed * 0.2;
  t += (hash(floor(px*1.5) + 3.0) - 0.5) * uGrain * 0.45;
  vec3 c = ramp(t) * (1.0 + max(t - 1.0, 0.0) * 1.5);
  float ero = vnoise(px * 0.45) - 0.5;                  // stamped foil never has a perfect edge
  fragColor = vec4(min(c, vec3(1.0)), smoothstep(0.3, 0.7, src.a + ero * 0.3));
}`

export const SPOT_UV_FRAG = `${FINISH_COMMON}
uniform float uGloss;
uniform float uRaised;
uniform float uVarnishOnly;
void main() {
  vec4 src = texture(uColor, vUv);
  if (src.a <= 0.0) { fragColor = vec4(0.0); return; }
  vec2 g = alphaGrad(vUv, 2.0 * uScale);
  // Raised: the surface slopes UP into the shape, so the normal leans along -g.
  vec3 N = normalize(vec3(-g * uRaised, 1.0));
  vec3 P = worldPos(frameUv(vUv));
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
/**
 * Where a finish's texture sits inside the Frame, in device px: `x`/`y` are the texture's
 * TOP-LEFT (canvas convention, y down) and `frameW`/`frameH` the whole frame. Absent ⇒ the
 * texture IS the frame. Lets a foil region run its GPU pass over its own box while the light,
 * grain and edge wear stay laid out over the frame.
 */
export interface FinishFrame { x: number; y: number; frameW: number; frameH: number }

/** The shader's `uOrigin` / `uFull` for a `w`×`h` texture placed by `frame`. GL's y runs UP, so
 *  the origin is the texture's BOTTOM edge measured from the frame's bottom. */
export function finishFrameUniforms(w: number, h: number, frame?: FinishFrame | null): { origin: [number, number]; full: [number, number] } {
  if (!frame) return { origin: [0, 0], full: [w, h] }
  return { origin: [frame.x, frame.frameH - (frame.y + h)], full: [frame.frameW, frame.frameH] }
}

/** TS mirror of the shader's `frameUv` (texture uv, y up → frame uv, y up). Pure; for the tests. */
export function frameUvOf(uv: readonly [number, number], w: number, h: number, frame?: FinishFrame | null): [number, number] {
  const { origin, full } = finishFrameUniforms(w, h, frame)
  return [(uv[0] * w + origin[0]) / full[0], (uv[1] * h + origin[1]) / full[1]]
}

/** A 2D affine, as `CanvasRenderingContext2D.getTransform()` returns it. */
export interface Affine2D { a: number; b: number; c: number; d: number; e: number; f: number }
export interface DeviceRect { x: number; y: number; w: number; h: number }

/**
 * The DEVICE box a foil region needs its pass over: `box` (in the drawing's current user units)
 * mapped through `m`, grown by `marginPx` (room for the bevel's alpha ring and the edge wear, so
 * the texture edge is transparent exactly where a full-frame pass would be), snapped OUT to whole
 * pixels and clamped to the `cw`×`ch` canvas.
 *
 * `null` ⇒ the region lies wholly off the canvas (nothing to draw). A box or matrix that is not
 * finite answers the whole canvas — unknown bounds never cut ink off.
 */
export function finishRegionRect(box: DeviceRect, m: Affine2D, marginPx: number, cw: number, ch: number): DeviceRect | null {
  const full: DeviceRect = { x: 0, y: 0, w: cw, h: ch }
  const vals = [box.x, box.y, box.w, box.h, m.a, m.b, m.c, m.d, m.e, m.f, marginPx]
  if (vals.some(v => !Number.isFinite(v))) return full
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [u, v] of [[box.x, box.y], [box.x + box.w, box.y], [box.x, box.y + box.h], [box.x + box.w, box.y + box.h]] as const) {
    const X = m.a * u + m.c * v + m.e, Y = m.b * u + m.d * v + m.f
    if (X < x0) x0 = X
    if (X > x1) x1 = X
    if (Y < y0) y0 = Y
    if (Y > y1) y1 = Y
  }
  const mg = Math.max(0, marginPx)
  const l = Math.max(0, Math.floor(x0 - mg)), t = Math.max(0, Math.floor(y0 - mg))
  const r = Math.min(cw, Math.ceil(x1 + mg)), b = Math.min(ch, Math.ceil(y1 + mg))
  return r > l && b > t ? { x: l, y: t, w: r - l, h: b - t } : null
}

export function finishSharedUniforms(light: FrameLight, w: number, h: number, scale: number, frame?: FinishFrame | null): Record<string, GpuUniform> {
  const { origin, full } = finishFrameUniforms(w, h, frame)
  const aspect = full[1] / Math.max(1, full[0])
  return {
    uSize: new Float32Array([w, h]), uOrigin: new Float32Array(origin), uFull: new Float32Array(full),
    uScale: scale, uAspect: aspect, uLight: { vec3: lightWorld(light, aspect) },
  }
}

export function foilUniforms(d: FoilDials, light: FrameLight, w: number, h: number, scale: number, frame?: FinishFrame | null): Record<string, GpuUniform> {
  const m = METALS[d.metal] ?? METALS.gold
  return {
    ...finishSharedUniforms(light, w, h, scale, frame),
    uM0: hexVec3(m[0]), uM1: hexVec3(m[1]), uM2: hexVec3(m[2]), uM3: hexVec3(m[3]),
    uBrushed: clamp01(d.brushed), uPressed: clamp01(d.pressed), uGrain: clamp01(d.grain ?? 0),
  }
}

export function spotUvUniforms(d: SpotUvDials, light: FrameLight, w: number, h: number, scale: number, frame?: FinishFrame | null): Record<string, GpuUniform> {
  return { ...finishSharedUniforms(light, w, h, scale, frame), uGloss: clamp01(d.gloss), uRaised: clamp01(d.raised), uVarnishOnly: d.varnishOnly ? 1 : 0 }
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
 *  so the layer draws plain. The result canvas is GpuPost's and is reused, so it is copied now.
 *  `frame`: where `off` sits in the Frame when it is only a region's box (see `FinishFrame`);
 *  absent ⇒ `off` is the whole frame. */
export function applyFinish(
  off: HTMLCanvasElement, kind: FinishKind, dials: FoilDials | SpotUvDials, light: FrameLight, scale: number,
  frame?: FinishFrame | null,
): boolean {
  const w = off.width, h = off.height
  if (w < 1 || h < 1) return false
  const out = kind === 'gold_foil'
    ? getFoil().render(off, unusedDepth(), w, h, foilUniforms(dials as FoilDials, light, w, h, scale, frame))
    : getUv().render(off, unusedDepth(), w, h, spotUvUniforms(dials as SpotUvDials, light, w, h, scale, frame))
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
