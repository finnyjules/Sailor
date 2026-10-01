/**
 * Frame light layers, stage 3: Gold foil and Spot UV lit by the Frame's light layers instead of
 * the one hidden light (frameLight.ts). Used only when the Frame has a visible light layer; with
 * none, finishPass.ts's `FOIL_FRAG` / `SPOT_UV_FRAG` / `applyFinish` run exactly as before.
 *
 * Each light is sent twice, in the two spaces the two passes use:
 *   - `uA/uB/uC` — verbatim from `packLightUniforms` (shade.ts): the lighting pass's space, Frame
 *     widths with y DOWN, a point at (x, y·aspect, z), lamp z = 0.04 + height·0.9. Falloff and the
 *     spot cone are computed here with `LIGHTING_FRAG`'s code, so a finish dims with distance
 *     exactly as the picture around it does.
 *   - `uW` — the same light in the finish shaders' world space (`lightWorld`): Frame width 1,
 *     centred, y UP, spanning ±aspect/2, camera at z 2.6. Lamp / spot position
 *     (x − 0.5, (0.5 − y)·aspect, 0.3 + height·1.7) — the very mapping `lightWorld` gives the
 *     hidden light, so a lamp at its default (.15, .1, height .6) lands exactly where the hidden
 *     light was and the highlight sits in the same place. A sun is a direction: the lighting
 *     pass's direction toward it with y flipped up. `uW.w` is the type code.
 * Directions (diffuse, the mirror highlight) use `uW`; radiance uses `uA/uB/uC`.
 *
 * Ambient is the lighting pass's `1 − darkness·0.92`, so Darkness darkens the finishes too.
 */
import { GpuPost, type GpuUniform } from './gpuPost'
import {
  FINISH_COMMON, finishFrameUniforms, finishSharedUniforms, foilUniforms, spotUvUniforms,
  type FinishFrame, type FinishKind, type FoilDials, type SpotUvDials,
} from './finishPass'
import { DEFAULT_FRAME_LIGHT } from './frameLight'
import { MAX_SHADER_LIGHTS, packLight, packLightUniforms, type Vec3 } from '~/lib/frame/lighting/shade'
import type { FrameLighting, LightLayer } from '~/lib/frame/lighting/settings'

const HIDDEN_LIGHT_DECL = 'uniform vec3 uLight;    // world space, see lightWorld()\n'

const LIGHTS_DECL = `uniform vec4 uA[6];   // lighting-pass space (y down): x, y*aspect, z, type (1 lamp, 2 spot, 3 sun)
uniform vec4 uB[6];   // linear r, g, b * brightness, reach
uniform vec4 uC[6];   // aimX, aimY*aspect, cosOuter, cosInner
uniform vec4 uW[6];   // finish world space (y up): lamp/spot position, sun direction; w = type
uniform float uCount, uDark;
`

/**
 * A gain on every light's radiance, per finish, in the finish shaders only (the lighting pass is
 * untouched). The lighting pass's falloff gives a lamp about 0.35–0.5 of its brightness across a
 * Frame, where the hidden light lit the finishes at a weight of 1; these bring the toolbar's
 * default lamp (white, brightness 1.6) at the hidden light's default spot, Darkness 0.45, back to
 * today's look. Measured in a Chromium harness (stage-3 Task 1 report, fix round 2): foil's
 * ambient base terms now scale with Darkness, so foil needs more gain than Spot UV.
 */
export const FOIL_LIGHT_GAIN = 2
export const SPOT_UV_LIGHT_GAIN = 1.25

/** FINISH_COMMON with the hidden light swapped for the light layers; '' if FINISH_COMMON no
 *  longer declares the hidden light as expected (then the lit shaders are empty, `applyFinishLit`
 *  answers false so the caller falls back, and the unit tests fail loudly). Never throws at import. */
function litCommon(gain: number): string {
  if (!FINISH_COMMON.includes(HIDDEN_LIGHT_DECL)) return ''
  return FINISH_COMMON.replace(HIDDEN_LIGHT_DECL, LIGHTS_DECL) + `const float LIGHT_GAIN = ${gain.toFixed(4)};
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
// Light i at frame uv fu (y up) and world point P: its radiance (linear rgb), and L, the world
// direction toward it. Falloff and cone are LIGHTING_FRAG's, in the lighting pass's own space.
vec3 lightE(int i, vec2 fu, vec3 P, out vec3 L) {
  vec3 Q = vec3(fu.x, (1.0 - fu.y) * uAspect, 0.0);
  vec3 Lp = uA[i].xyz;
  float kind = uA[i].w;
  float att = 1.0;
  if (kind > 2.5) { L = normalize(uW[i].xyz); }
  else {
    L = normalize(uW[i].xyz - P);
    vec3 d = Lp - Q; float dist = length(d); vec3 Lq = d / dist;
    float r = uB[i].w; att = r * r / (r * r + dist * dist * 3.0);
    if (kind > 1.5) {
      vec3 aimP = vec3(uC[i].x, uC[i].y, 0.0);
      vec3 axis = normalize(aimP - Lp);
      float c = dot(-Lq, axis);
      att *= smoothstep(uC[i].z, uC[i].w, c);
    }
  }
  return uB[i].rgb * att * LIGHT_GAIN;
}
`
}

const FOIL_COMMON_LIT = litCommon(FOIL_LIGHT_GAIN)
const SPOT_UV_COMMON_LIT = litCommon(SPOT_UV_LIGHT_GAIN)

export const FOIL_LIT_FRAG = !FOIL_COMMON_LIT ? '' : `${FOIL_COMMON_LIT}
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
  vec2 px = (vUv * uSize + uOrigin) / uScale;
  vec2 g = alphaGrad(vUv, 3.0 * uScale);
  float st = vnoise(vec2(px.x * 0.004, px.y * 0.9)) - 0.5;
  float st2 = vnoise(vec2(px.x * 0.02, px.y * 2.3) + 3.0) - 0.5;
  vec3 N = normalize(vec3(g * uPressed * 1.2 + vec2(0.0, (st * 0.10 + st2 * 0.05) * uBrushed) + (vec2(hash(floor(px*1.5)), hash(floor(px*1.5) + 7.0)) - 0.5) * uGrain * 0.5, 1.0));
  vec2 fu = frameUv(vUv);
  vec3 P = worldPos(fu);
  vec3 V = normalize(CAMERA - P);
  vec3 R = reflect(-V, N);
  float amb = 1.0 - uDark * 0.92;
  float lt = 0.0;
  vec3 sumE = vec3(0.0);
  int count = int(uCount + 0.5);
  for (int i = 0; i < 6; i++) {
    if (i >= count) break;
    vec3 L;
    vec3 E = lightE(i, fu, P, L);
    float rl = dot(R, L);
    float df = max(dot(N, L), 0.0);
    lt += lum(E) * (0.25 * df * df + 0.55 * smoothstep(0.80, 0.99, rl) + 0.9 * pow(max(rl, 0.0), 140.0));
    sumE += E;
  }
  float t = 0.10 * amb + lt + 0.14 * (R.y * 0.5 + 0.5) * amb + (st + st2 * 0.5) * uBrushed * 0.2;
  t += (hash(floor(px*1.5) + 3.0) - 0.5) * uGrain * 0.45;
  // The lights' colour tints the metal (radiance-weighted, brightest channel = 1).
  float mx = max(sumE.r, max(sumE.g, sumE.b));
  vec3 tint = mx > 1e-4 ? mix(vec3(1.0), sumE / mx, 0.6) : vec3(1.0);
  vec3 c = ramp(t) * (1.0 + max(t - 1.0, 0.0) * 1.5) * tint;
  float ero = vnoise(px * 0.45) - 0.5;
  fragColor = vec4(min(c, vec3(1.0)), smoothstep(0.3, 0.7, src.a + ero * 0.3));
}`

export const SPOT_UV_LIT_FRAG = !SPOT_UV_COMMON_LIT ? '' : `${SPOT_UV_COMMON_LIT}
uniform float uGloss;
uniform float uRaised;
uniform float uVarnishOnly;
void main() {
  vec4 src = texture(uColor, vUv);
  if (src.a <= 0.0) { fragColor = vec4(0.0); return; }
  vec2 g = alphaGrad(vUv, 2.0 * uScale);
  vec3 N = normalize(vec3(-g * uRaised, 1.0));
  vec2 fu = frameUv(vUv);
  vec3 P = worldPos(fu);
  vec3 V = normalize(CAMERA - P);
  vec3 R = reflect(-V, N);
  float amb = 1.0 - uDark * 0.92;
  float k = mix(0.10, 0.03, uGloss);
  float sp = mix(90.0, 1200.0, uGloss);
  vec3 lit = vec3(amb);
  vec3 shine = vec3(0.0);
  float edge = 0.0, wsum = 0.0;   // varnish-only: today's flat-normalised edge term, light-weighted
  int count = int(uCount + 0.5);
  for (int i = 0; i < 6; i++) {
    if (i >= count) break;
    vec3 L;
    vec3 E = lightE(i, fu, P, L);
    float rl = dot(R, L);
    lit += max(dot(N, L), 0.0) * E;
    float w = lum(E);
    edge += w * (max(dot(N, L), 0.0) - max(L.z, 0.0));
    wsum += w;
    float box = smoothstep(1.0 - k, 1.0 - k * 0.45, rl);   // the lamp's reflection
    float sharp = pow(max(rl, 0.0), sp);
    float emx = max(E.r, max(E.g, E.b));
    vec3 hue = emx > 1e-4 ? E / emx : vec3(0.0);           // the light's colour, brightest channel = 1
    shine += lum(E) * (box * mix(0.3, 0.85, uGloss) + sharp * 1.3) * hue;
  }
  float fres = 0.04 + 0.96 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
  shine += vec3(fres * 0.2 * amb);
  if (uVarnishOnly > 0.5) {
    float lift = clamp(lum(shine), 0.0, 1.0);
    // The dark term is today's, relative to a flat surface (flat = exactly 0.06): the coat is drawn
    // over a picture the lighting pass already darkened, so Darkness and distance never add a veil.
    float flatLit = 1.0 + 0.4 * (wsum > 1e-5 ? edge / wsum : 0.0);
    float dk = clamp(0.06 + max(1.0 - flatLit, 0.0) * 0.5, 0.0, 1.0);
    fragColor = vec4(vec3(lift / max(lift + dk, 1e-4)), max(lift, dk) * src.a);
  } else {
    vec3 wet = pow(src.rgb, vec3(1.15)) * 1.04 * lit + shine;
    fragColor = vec4(min(wet, vec3(1.0)), src.a);
  }
}`

/** A light layer in the finish shaders' world space (see the header): lamp / spot position, or
 *  a sun's direction toward it. Same mapping as `lightWorld` for the hidden light. */
export function finishLightWorld(layer: LightLayer, aspect: number): Vec3 {
  if (layer.light.type === 'sun') {
    const p = packLight(layer, aspect).pos
    return [p[0], -p[1], p[2]]
  }
  return [layer.x - 0.5, (0.5 - layer.y) * aspect, 0.3 + layer.light.height * 1.7]
}

/**
 * TS mirror of the varnish-only Spot UV dark term: `0.06 + max(1 − flatLit, 0)·0.5`, flatLit =
 * `1 + 0.4·Σ ŵ_i·(max(N·L_i, 0) − max(L_i.z, 0))` with ŵ_i each light's luminance weight
 * normalised over the lights. A flat surface is exactly 0.06 whatever the Darkness or distance.
 */
export function varnishDarkTerm(N: Vec3, lights: readonly { L: Vec3; weight: number }[]): number {
  let edge = 0, wsum = 0
  for (const { L, weight } of lights) {
    edge += weight * (Math.max(N[0] * L[0] + N[1] * L[1] + N[2] * L[2], 0) - Math.max(L[2], 0))
    wsum += weight
  }
  const flatLit = 1 + 0.4 * (wsum > 1e-5 ? edge / wsum : 0)
  return Math.min(1, Math.max(0, 0.06 + Math.max(1 - flatLit, 0) * 0.5))
}

const TYPE_CODE = { lamp: 1, spot: 2, sun: 3 } as const

/**
 * The lit shaders' light and placement uniforms (not the dials): `uSize/uOrigin/uFull/uScale/
 * uAspect` as the unlit finishes send them, `uA[i]/uB[i]/uC[i]` exactly as the lighting pass packs
 * them, `uW[i]` in world space, `uCount` (at most 6) and `uDark`. Every slot 0..5 is sent; unused
 * ones are zero. Pure, for the tests.
 */
export function finishLightUniforms(
  lights: readonly LightLayer[], lighting: FrameLighting, w: number, h: number, scale: number, frame?: FinishFrame | null,
): Record<string, GpuUniform> {
  const { uLight: _hidden, ...shared } = finishSharedUniforms(DEFAULT_FRAME_LIGHT, w, h, scale, frame)
  const { full } = finishFrameUniforms(w, h, frame)
  const aspect = full[1] / Math.max(1, full[0])
  const p = packLightUniforms(lights, lighting, aspect, 0)
  const out: Record<string, GpuUniform> = { ...shared, uCount: p.uCount, uDark: p.uDark }
  const at = (a: Float32Array, i: number) => [a[i * 4]!, a[i * 4 + 1]!, a[i * 4 + 2]!, a[i * 4 + 3]!] as const
  for (let i = 0; i < MAX_SHADER_LIGHTS; i++) {
    out[`uA[${i}]`] = { vec4: at(p.uA, i) }
    out[`uB[${i}]`] = { vec4: at(p.uB, i) }
    out[`uC[${i}]`] = { vec4: at(p.uC, i) }
    const layer = i < p.uCount ? lights[i] : undefined
    const wv = layer ? finishLightWorld(layer, aspect) : [0, 0, 0]
    out[`uW[${i}]`] = { vec4: [wv[0]!, wv[1]!, wv[2]!, layer ? TYPE_CODE[layer.light.type] : 0] }
  }
  return out
}

let foilPass: GpuPost | null = null
let uvPass: GpuPost | null = null
const getFoil = () => (foilPass ??= new GpuPost(FOIL_LIT_FRAG))
const getUv = () => (uvPass ??= new GpuPost(SPOT_UV_LIT_FRAG))

// GpuPost always binds a second texture; the finishes never read it (as in finishPass.ts).
let noDepth: HTMLCanvasElement | null = null
function unusedDepth(): HTMLCanvasElement {
  if (!noDepth) { noDepth = document.createElement('canvas'); noDepth.width = 1; noDepth.height = 1 }
  return noDepth
}

/** The dial uniforms of a finish, without the hidden light. */
function dialUniforms(kind: FinishKind, dials: FoilDials | SpotUvDials, w: number, h: number, scale: number, frame?: FinishFrame | null) {
  const { uLight: _hidden, ...rest } = kind === 'gold_foil'
    ? foilUniforms(dials as FoilDials, DEFAULT_FRAME_LIGHT, w, h, scale, frame)
    : spotUvUniforms(dials as SpotUvDials, DEFAULT_FRAME_LIGHT, w, h, scale, frame)
  return rest
}

/**
 * `applyFinish`'s contract, lit by the Frame's light layers: runs over `off` in place; false =
 * did not run (no WebGL2 / empty) and `off` is untouched, so the caller falls back.
 * `lights`: the visible light layers in stack order (only the first 6 are used).
 */
export function applyFinishLit(
  off: HTMLCanvasElement, kind: FinishKind, dials: FoilDials | SpotUvDials,
  lights: readonly LightLayer[], lighting: FrameLighting, scale: number, frame?: FinishFrame | null,
): boolean {
  const w = off.width, h = off.height
  if (w < 1 || h < 1) return false
  if (!FOIL_LIT_FRAG || !SPOT_UV_LIT_FRAG) return false
  const uniforms = { ...dialUniforms(kind, dials, w, h, scale, frame), ...finishLightUniforms(lights, lighting, w, h, scale, frame) }
  const out = (kind === 'gold_foil' ? getFoil() : getUv()).render(off, unusedDepth(), w, h, uniforms)
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
