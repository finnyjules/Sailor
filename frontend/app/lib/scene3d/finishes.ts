// The finish material injection — a FOURTH treatment family (beside masked/edge/buffer,
// treatments.ts) built as an onBeforeCompile CHAIN on the `applyScreen`/`applyVaryTint` model
// (materials.ts), not a treatmentStage pass. See docs/superpowers/plans/2026-09-09-scene3d-S5-
// finishes.md for the whole slice; this file is Task 1's `applyFinish` seam plus the reference
// finish, opalescence, and Task 2's foil shimmer (a diffraction-grating rainbow, ADDED over
// `gl_FragColor` rather than mixed into it — see `foilBody`/`foilShimmerRGB` below).
//
// A finish injects DISPLAY-SPACE overlay math at the TERMINAL `#include <dithering_fragment>`
// anchor — the very last chunk in every lit material's fragment `main()`, right before the
// closing brace (verified against three's real ShaderLib: `<dithering_fragment>` runs AFTER
// `<opaque_fragment>` sets `gl_FragColor`, `<tonemapping_fragment>` and `<colorspace_fragment>`).
// Nothing else in the base-type / applyScreen / applyVaryTint chain consumes that anchor — they
// use `<common>`/`<emissivemap_fragment>`, `<uv_*>`/`<opaque_fragment>`, and top-of-string +
// `<color_fragment>` respectively — so a finish composes on top of every one of them, and a
// second stacked finish's `.replace` still finds the token this one re-inserts right after its
// own body, preserving stack order.
//
// A finish reads `gl_FragColor` (already tonemapped + colour-space converted at that point) and
// the local `normal` / `vViewPosition` values every lit material's fragment shader has already
// computed by `<dithering_fragment>` — the SAME two values `OPAL_FRAG_BODY` (materials.ts, the
// `opalescent` MATERIAL type) reads, just later in the same `main()`. `vNormal` itself (the raw
// varying `normal_pars_fragment` declares) is only defined `#ifndef FLAT_SHADED` — undeclared
// identifier if a base material ever sets `flatShading` — so this reads the local `normal`
// instead: unconditionally declared by `<normal_fragment_begin>` (which runs long before
// `<dithering_fragment>`) regardless of flat/smooth shading, exactly what OPAL_FRAG_BODY relies
// on. No vertex injection, no new varyings, either way.
//
// `finishes.length === 0` is the byte-identical gate: `applyFinish` never touches the material
// at all in that case (not even to snapshot a cache key), so an object with no finish treatment
// builds/compiles exactly as it did before this file existed.
import * as THREE from 'three'
import { OPAL_DEFAULT_STOPS } from './config'
import type { FinishTreatment, OpalescenceTreatment, FoilShimmerTreatment } from './treatments'

// ── Opalescence ram­p LUT ─────────────────────────────────────────────────────
// A small, self-contained sRGB-LUT builder — deliberately NOT imported from materials.ts's
// `buildRampTexture`, which would make this module and materials.ts (which imports `applyFinish`
// from here) import each other. Same interpolation shape (sRGB lerp between sorted stops, edges
// flood) as that function, fed the fixed `OPAL_DEFAULT_STOPS` — a per-treatment custom ramp would
// need `applyFinish` to also take the host `SceneMaterial`, which the call site this task builds
// against (materials.ts's `materialFor`/`updateMaterial`) does not thread through; a follow-up.
const RAMP_WIDTH = 256

function buildOpalRamp(): THREE.DataTexture {
  const stops = [...OPAL_DEFAULT_STOPS].sort((a, b) => a.pos - b.pos).map((s) => {
    const hex = new THREE.Color(s.color).getHex(THREE.SRGBColorSpace)
    return { pos: s.pos, r: (hex >> 16) & 255, g: (hex >> 8) & 255, b: hex & 255 }
  })
  const data = new Uint8Array(RAMP_WIDTH * 4)
  const first = stops[0]!
  const last = stops[stops.length - 1]!
  let seg = 0
  for (let i = 0; i < RAMP_WIDTH; i++) {
    const x = i / (RAMP_WIDTH - 1)
    let r: number, g: number, b: number
    if (x <= first.pos) { r = first.r; g = first.g; b = first.b }
    else if (x >= last.pos) { r = last.r; g = last.g; b = last.b }
    else {
      while (seg < stops.length - 2 && x > stops[seg + 1]!.pos) seg++
      const a = stops[seg]!, c = stops[seg + 1]!
      const span = c.pos - a.pos
      const f = span > 0 ? (x - a.pos) / span : 1
      r = a.r + (c.r - a.r) * f
      g = a.g + (c.g - a.g) * f
      b = a.b + (c.b - a.b) * f
    }
    data.set([Math.round(r), Math.round(g), Math.round(b), 255], i * 4)
  }
  const t = new THREE.DataTexture(data, RAMP_WIDTH, 1, THREE.RGBAFormat)
  // Deliberately NOT SRGBColorSpace: this finish injects at the TERMINAL `<dithering_fragment>`
  // anchor, which runs AFTER `<colorspace_fragment>` has already display-encoded gl_FragColor.
  // Tagging the texture SRGBColorSpace would make the GPU decode sRGB→linear on every
  // `texture2D` sample, and the mix() below writes that decoded (linear) sample straight into
  // the display-encoded gl_FragColor.rgb — darker/desaturated at every strength > 0. Leaving
  // colorSpace at the THREE.NoColorSpace default returns the raw authored sRGB bytes untouched,
  // matching the space gl_FragColor is already in at this anchor. (Contrast materials.ts's
  // OPAL_FRAG_BODY, which injects at the pre-tonemap/scene-linear `emissivemap_fragment` and
  // correctly DOES want SRGBColorSpace there.)
  t.magFilter = t.minFilter = THREE.LinearFilter
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping
  t.needsUpdate = true
  return t
}

/** Lazily built, shared across every opalescence AND foil-shimmer finish instance — the ramp is
 *  currently fixed (OPAL_DEFAULT_STOPS), so one texture object serves every instance of either
 *  kind. Foil shimmer's grating samples the SAME spectrum as opalescence (mirroring how the
 *  `holographic`/`opalescent` MATERIAL types already share `opalStopsOf`'s ramp) — not a separate
 *  LUT, since neither finish threads a per-treatment custom ramp through `applyFinish` yet (see
 *  the module comment above). */
let opalRampCache: THREE.DataTexture | null = null
function opalRamp(): THREE.DataTexture {
  if (!opalRampCache) opalRampCache = buildOpalRamp()
  return opalRampCache
}

/** CPU twin of the opalescence finish body — mirrors the injected GLSL's math exactly (same
 *  fresnel/normal blend, same fract-wrap, same clamp order), so a unit test can assert the two
 *  agree without a GPU. `hueShift` here is PRE-NORMALISED 0..1 (degrees/360), matching the
 *  uniform the shader actually reads — not the raw treatment field (which is stored in degrees,
 *  0..360, like the material type's `opalHueShift`). `sampleRamp` stands in for the
 *  `texture2D(uFinOpalRamp_i, vec2(s, 0.5))` lookup. */
export function opalescenceRGB(
  base: readonly [number, number, number],
  normal: readonly [number, number, number],
  viewDir: readonly [number, number, number],
  params: { hueShiftNorm: number; frequency: number; angleMix: number; strength: number },
  sampleRamp: (s: number) => readonly [number, number, number],
): [number, number, number] {
  const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
  const norm = (v: readonly [number, number, number]): [number, number, number] => {
    const len = Math.hypot(v[0], v[1], v[2]) || 1
    return [v[0] / len, v[1] / len, v[2] / len]
  }
  const nrm = norm(normal)
  const vdir = norm(viewDir)
  const dot = nrm[0] * vdir[0] + nrm[1] * vdir[1] + nrm[2] * vdir[2]
  const fres = Math.pow(1 - clamp01(Math.abs(dot)), 1.5)
  const nterm = nrm[1] * 0.5 + 0.5
  const angleMix = clamp01(params.angleMix)
  const s0 = nterm + (fres - nterm) * angleMix // mix(nterm, fres, angleMix)
  const sMixed = s0 * params.frequency + params.hueShiftNorm
  const s = sMixed - Math.floor(sMixed) // fract()
  const rainbow = sampleRamp(s)
  const strength = clamp01(params.strength)
  return [
    base[0] + (rainbow[0] - base[0]) * strength,
    base[1] + (rainbow[1] - base[1]) * strength,
    base[2] + (rainbow[2] - base[2]) * strength,
  ]
}

/** CPU twin of the foil-shimmer finish body — mirrors `FOIL_FINISH_BODY`'s math exactly (same
 *  tangent frame built from the surface normal, same sun/view half-vector, same fract-wrapped
 *  band position, same gloss-driven highlight falloff), so a unit test can assert the two agree
 *  without a GPU. `hueShiftNorm` is PRE-NORMALISED 0..1 (degrees/360) and `angleDeg` is the raw
 *  stored degrees, matching what the shader's uniforms actually carry (the shader itself converts
 *  angle to radians). `lightDir: null` mirrors the shader's `#if NUM_DIR_LIGHTS > 0` guard's ELSE
 *  branch — a lightless scene falls back to a fixed forward direction rather than reading past the
 *  end of an empty array. Unlike `opalescenceRGB`'s `mix()` (replaces the base colour), this is
 *  ADDITIVE — the shimmer is a highlight added on top of whatever `base` already is, exactly as
 *  `FOIL_FINISH_BODY` writes `gl_FragColor.rgb = clamp(gl_FragColor.rgb + rainbow*env*strength, ..)`.
 *  `sampleRamp` stands in for the `texture2D(uFinFoilRamp_i, vec2(s, 0.5))` lookup. */
export function foilShimmerRGB(
  base: readonly [number, number, number],
  normal: readonly [number, number, number],
  viewDir: readonly [number, number, number],
  lightDir: readonly [number, number, number] | null,
  params: { hueShiftNorm: number; bands: number; angleDeg: number; gloss: number; strength: number },
  sampleRamp: (s: number) => readonly [number, number, number],
): [number, number, number] {
  const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
  const norm = (v: readonly [number, number, number]): [number, number, number] => {
    const len = Math.hypot(v[0], v[1], v[2]) || 1
    return [v[0] / len, v[1] / len, v[2] / len]
  }
  const add3 = (a: readonly [number, number, number], b: readonly [number, number, number]): [number, number, number] =>
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
  const cross3 = (a: readonly [number, number, number], b: readonly [number, number, number]): [number, number, number] => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
  const dot3 = (a: readonly [number, number, number], b: readonly [number, number, number]): number =>
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const smoothstep = (e0: number, e1: number, x: number): number => {
    const t = clamp01((x - e0) / (e1 - e0))
    return t * t * (3 - 2 * t)
  }

  const nrm = norm(normal)
  const vdir = norm(viewDir)
  const ldir = norm(lightDir ?? [0, 0, 1])
  const h = norm(add3(ldir, vdir))
  const ref: [number, number, number] = Math.abs(nrm[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0]
  const t0 = norm(cross3(ref, nrm))
  const b0 = cross3(nrm, t0)
  const a = (params.angleDeg * Math.PI) / 180
  const tang: [number, number, number] = [
    t0[0] * Math.cos(a) + b0[0] * Math.sin(a),
    t0[1] * Math.cos(a) + b0[1] * Math.sin(a),
    t0[2] * Math.cos(a) + b0[2] * Math.sin(a),
  ]
  const u = dot3(tang, h)
  const au = Math.abs(u)
  const sMixed = au * params.bands + params.hueShiftNorm
  const s = sMixed - Math.floor(sMixed) // fract()
  const rainbow = sampleRamp(s)
  const glossPow = 1 + (6 - 1) * clamp01(params.gloss) // mix(1.0, 6.0, gloss)
  let env = smoothstep(0.02, 0.12, au) * (1 - smoothstep(0.55, 0.95, au))
  env *= Math.pow(clamp01(dot3(nrm, h)), glossPow)
  const strength = params.strength
  return [
    clamp01(base[0] + rainbow[0] * env * strength),
    clamp01(base[1] + rainbow[1] * env * strength),
    clamp01(base[2] + rainbow[2] * env * strength),
  ]
}

// ── GLSL bodies ───────────────────────────────────────────────────────────────
// Every identifier is suffixed `_${i}` (the finish's index within the object's finish stack) so
// two finishes of the same kind stacked on one object never collide — required because uniform
// names, unlike the uniform BAG object's own keys, live in one flat GLSL namespace per program.
// No JS number is ever interpolated into a GLSL arithmetic expression here (every dial rides a
// uniform) — the S4 float÷int-from-a-bare-int-template lesson has nothing to trip on, verified by
// the source-guard unit below.
const opalPars = (i: number): string => /* glsl */ `
uniform sampler2D uFinOpalRamp_${i};
uniform float uFinOpalHueShift_${i};
uniform float uFinOpalFrequency_${i};
uniform float uFinOpalAngleMix_${i};
uniform float uFinOpalStrength_${i};
`

const opalBody = (i: number): string => /* glsl */ `
{
  vec3 finNrm_${i} = normalize( normal );
  vec3 finView_${i} = normalize( vViewPosition );
  float finFres_${i} = pow( 1.0 - clamp( abs( dot( finNrm_${i}, finView_${i} ) ), 0.0, 1.0 ), 1.5 );
  float finNterm_${i} = finNrm_${i}.y * 0.5 + 0.5;
  float finS_${i} = mix( finNterm_${i}, finFres_${i}, clamp( uFinOpalAngleMix_${i}, 0.0, 1.0 ) );
  finS_${i} = fract( finS_${i} * uFinOpalFrequency_${i} + uFinOpalHueShift_${i} );
  vec3 finRainbow_${i} = texture2D( uFinOpalRamp_${i}, vec2( finS_${i}, 0.5 ) ).rgb;
  gl_FragColor.rgb = mix( gl_FragColor.rgb, finRainbow_${i}, clamp( uFinOpalStrength_${i}, 0.0, 1.0 ) );
}
`

function opalUniformBag(t: OpalescenceTreatment, i: number): Record<string, { value: unknown }> {
  return {
    [`uFinOpalRamp_${i}`]: { value: opalRamp() },
    [`uFinOpalHueShift_${i}`]: { value: t.hueShift / 360 },
    [`uFinOpalFrequency_${i}`]: { value: t.frequency },
    [`uFinOpalAngleMix_${i}`]: { value: t.angleMix },
    [`uFinOpalStrength_${i}`]: { value: t.strength },
  }
}

// Foil shimmer: a diffraction-grating rainbow highlight, ADDED over `gl_FragColor` rather than
// mixed into it (opal's body) — the sweep is a bright streak near the key-light/view half vector,
// not a whole-surface recolour. Ported from materials.ts's HOLO_FRAG_DECL/BODY (the `holographic`
// MATERIAL type), dropping its vertex-injected `vHoloPos`/per-flake jitter (the finish seam only
// injects into the fragment shader — no vertex stage available here) and its forced
// metalness/roughness (the host material's own PBR values are left alone; see
// FoilShimmerTreatment's doc comment in treatments.ts). `directionalLights[0]` is the engine's
// sun (added at construction, so it is index 0); `#if NUM_DIR_LIGHTS > 0` guards a lightless
// scene exactly as HOLO_FRAG_BODY already does, falling back to a fixed forward direction rather
// than reading past the end of an empty array.
const foilPars = (i: number): string => /* glsl */ `
uniform sampler2D uFinFoilRamp_${i};
uniform float uFinFoilStrength_${i};
uniform float uFinFoilBands_${i};
uniform float uFinFoilAngle_${i};
uniform float uFinFoilHueShift_${i};
uniform float uFinFoilGloss_${i};
`

const foilBody = (i: number): string => /* glsl */ `
{
  vec3 finNrm_${i} = normalize( normal );
  vec3 finView_${i} = normalize( vViewPosition );
  #if NUM_DIR_LIGHTS > 0
    vec3 finLdir_${i} = normalize( directionalLights[ 0 ].direction );
  #else
    vec3 finLdir_${i} = vec3( 0.0, 0.0, 1.0 );
  #endif
  vec3 finH_${i} = normalize( finLdir_${i} + finView_${i} );
  vec3 finRef_${i} = abs( finNrm_${i}.y ) < 0.95 ? vec3( 0.0, 1.0, 0.0 ) : vec3( 1.0, 0.0, 0.0 );
  vec3 finT0_${i} = normalize( cross( finRef_${i}, finNrm_${i} ) );
  vec3 finB0_${i} = cross( finNrm_${i}, finT0_${i} );
  float finAngRad_${i} = radians( uFinFoilAngle_${i} );
  vec3 finTang_${i} = finT0_${i} * cos( finAngRad_${i} ) + finB0_${i} * sin( finAngRad_${i} );
  float finU_${i} = dot( finTang_${i}, finH_${i} );
  float finAu_${i} = abs( finU_${i} );
  float finS_${i} = fract( finAu_${i} * uFinFoilBands_${i} + uFinFoilHueShift_${i} );
  vec3 finRainbow_${i} = texture2D( uFinFoilRamp_${i}, vec2( finS_${i}, 0.5 ) ).rgb;
  float finGlossPow_${i} = mix( 1.0, 6.0, clamp( uFinFoilGloss_${i}, 0.0, 1.0 ) );
  float finEnv_${i} = smoothstep( 0.02, 0.12, finAu_${i} ) * ( 1.0 - smoothstep( 0.55, 0.95, finAu_${i} ) );
  finEnv_${i} *= pow( clamp( dot( finNrm_${i}, finH_${i} ), 0.0, 1.0 ), finGlossPow_${i} );
  gl_FragColor.rgb = clamp( gl_FragColor.rgb + finRainbow_${i} * finEnv_${i} * uFinFoilStrength_${i}, 0.0, 1.0 );
}
`

function foilUniformBag(t: FoilShimmerTreatment, i: number): Record<string, { value: unknown }> {
  return {
    [`uFinFoilRamp_${i}`]: { value: opalRamp() },
    [`uFinFoilStrength_${i}`]: { value: t.strength },
    [`uFinFoilBands_${i}`]: { value: t.bands },
    [`uFinFoilAngle_${i}`]: { value: t.angle },
    [`uFinFoilHueShift_${i}`]: { value: t.hueShift / 360 },
    [`uFinFoilGloss_${i}`]: { value: t.gloss },
  }
}

function uniformBagFor(t: FinishTreatment, i: number): Record<string, { value: unknown }> {
  switch (t.kind) {
    case 'opalescence': return opalUniformBag(t, i)
    case 'foilShimmer': return foilUniformBag(t, i)
  }
}

function glslFor(t: FinishTreatment, i: number): { pars: string; body: string } {
  switch (t.kind) {
    case 'opalescence': return { pars: opalPars(i), body: opalBody(i) }
    case 'foilShimmer': return { pars: foilPars(i), body: foilBody(i) }
  }
}

/** Writes one finish's dials into its already-bound uniform bag, in place. */
function writeFinishUniforms(t: FinishTreatment, u: Record<string, { value: unknown }>, i: number): void {
  switch (t.kind) {
    case 'opalescence':
      u[`uFinOpalHueShift_${i}`]!.value = t.hueShift / 360
      u[`uFinOpalFrequency_${i}`]!.value = t.frequency
      u[`uFinOpalAngleMix_${i}`]!.value = t.angleMix
      u[`uFinOpalStrength_${i}`]!.value = t.strength
      break
    case 'foilShimmer':
      u[`uFinFoilStrength_${i}`]!.value = t.strength
      u[`uFinFoilBands_${i}`]!.value = t.bands
      u[`uFinFoilAngle_${i}`]!.value = t.angle
      u[`uFinFoilHueShift_${i}`]!.value = t.hueShift / 360
      u[`uFinFoilGloss_${i}`]!.value = t.gloss
      break
  }
}

interface FinishUniformEntry {
  id: string
  kind: FinishTreatment['kind']
  u: Record<string, { value: unknown }>
}

/** The rebuild boundary for the finish stack, folded into materials.ts's `identityKey`: the
 *  ORDERED list of finish kinds (order-sensitive — reordering the stack changes which body reads
 *  which uniform bag). Matcap ids (Task 3) fold in here too once `matcapCoat` exists, mirroring
 *  `baseIdentityKey`'s own matcap case — an id change swaps a bound texture, so it needs a
 *  rebuild the way a plain dial change never does. Empty finishes ⇒ empty string, so a document
 *  with no finish treatment contributes NOTHING to the identity key — byte-identical. */
export function finishKey(finishes: FinishTreatment[]): string {
  if (!finishes.length) return ''
  return `|fin:${finishes.map((f) => f.kind).join(',')}`
}

/** Writes every finish's CURRENT dial values into the material's already-bound uniform bags, in
 *  place — a slider drag must never rebuild. Returns `false` when the ordered kind sequence on
 *  the material no longer matches `finishes` (a finish was added/removed/reordered, or the
 *  material never had any while `finishes` is now non-empty) — the caller (materials.ts's
 *  `updateMaterial`) must then rebuild via `materialFor`+`applyFinish` instead. Two finish-less
 *  states (no bag, no finishes) are NOT a mismatch — that is the steady state before this
 *  feature and after every finish is removed. */
export function updateFinishUniforms(m: THREE.Material, finishes: FinishTreatment[]): boolean {
  const bag = m.userData.finishUniforms as FinishUniformEntry[] | undefined
  if (!bag) return finishes.length === 0
  if (bag.length !== finishes.length) return false
  for (let i = 0; i < finishes.length; i++) {
    if (bag[i]!.kind !== finishes[i]!.kind) return false
  }
  for (let i = 0; i < finishes.length; i++) writeFinishUniforms(finishes[i]!, bag[i]!.u, i)
  return true
}

/** The finish seam: chains a stack of `onBeforeCompile` overlays onto whatever injection the
 *  material already carries (base type, `applyScreen`, `applyVaryTint` — in that order, since
 *  `materialFor` calls this LAST). Modelled on `applyScreen`/`applyVaryTint` above in materials.ts,
 *  including the eager cache-key snapshot: read materials.ts's `applyScreen` comment for the
 *  three `customProgramCacheKey` hazard this avoids the same way. */
export function applyFinish(m: THREE.Material, finishes: FinishTreatment[]): void {
  // The byte-identical gate: an empty finish list never touches the material at all — not the
  // onBeforeCompile chain, not the cache key, not userData — so an object with no finish
  // treatment builds/compiles exactly as it did before this feature existed.
  if (finishes.length === 0) return
  const entries: FinishUniformEntry[] = finishes.map((t, i) => ({
    id: t.id, kind: t.kind, u: uniformBagFor(t, i),
  }))
  const baseKey = String(m.customProgramCacheKey())
  const prev = m.onBeforeCompile
  m.onBeforeCompile = (shader, renderer) => {
    prev.call(m, shader, renderer)
    let pars = ''
    let frag = shader.fragmentShader
    for (let i = 0; i < finishes.length; i++) {
      Object.assign(shader.uniforms, entries[i]!.u)
      const { pars: p, body } = glslFor(finishes[i]!, i)
      pars += p
      // The TERMINAL anchor nothing else consumes: base types use <common>/
      // <emissivemap_fragment>, applyScreen uses <uv_*>/<opaque_fragment>, applyVaryTint uses
      // top-of-string + <color_fragment> — none of them touch <dithering_fragment>. A second
      // stacked finish's `.replace` still finds the token THIS one re-inserts right after its
      // own body, so stack order is preserved.
      frag = frag.replace('#include <dithering_fragment>', `${body}\n#include <dithering_fragment>`)
    }
    // Prepended to the top, exactly like applyVaryTint's VARY_TINT_FRAG_PARS: every anchor a
    // declaration could reasonably sit on may already be consumed by an earlier injection in the
    // chain, so the top of the string is the one site nothing can silently swallow.
    shader.fragmentShader = pars + frag
  }
  m.customProgramCacheKey = () => `${baseKey}${finishKey(finishes)}`
  m.userData.finishUniforms = entries
}
