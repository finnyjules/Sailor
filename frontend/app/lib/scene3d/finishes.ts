// The finish material injection — a FOURTH treatment family (beside masked/edge/buffer,
// treatments.ts) built as an onBeforeCompile CHAIN on the `applyScreen`/`applyVaryTint` model
// (materials.ts), not a treatmentStage pass. See docs/superpowers/plans/2026-09-09-scene3d-S5-
// finishes.md for the whole slice; this file is Task 1's `applyFinish` seam plus the reference
// finish, opalescence.
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
import type { FinishTreatment, OpalescenceTreatment } from './treatments'

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
  t.colorSpace = THREE.SRGBColorSpace
  t.magFilter = t.minFilter = THREE.LinearFilter
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping
  t.needsUpdate = true
  return t
}

/** Lazily built, shared across every opalescence finish — the ramp is currently fixed
 *  (OPAL_DEFAULT_STOPS), so one texture object serves every instance. */
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

function uniformBagFor(t: FinishTreatment, i: number): Record<string, { value: unknown }> {
  switch (t.kind) {
    case 'opalescence': return opalUniformBag(t, i)
  }
}

function glslFor(t: FinishTreatment, i: number): { pars: string; body: string } {
  switch (t.kind) {
    case 'opalescence': return { pars: opalPars(i), body: opalBody(i) }
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
