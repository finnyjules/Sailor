// The AI-restyle PROJECTIVE material injection (S7.1) — the seam that replaces S7 v1's
// treatment-stage screen composite (`restyleComposite`/`RESTYLE_FRAG`, removed). Modelled on
// finishes.ts's `applyFinish` EXACTLY: an `onBeforeCompile` CHAIN that overlays a fragment body at
// the terminal `#include <dithering_fragment>` anchor, an EAGER `baseKey` snapshot, uniforms held on
// `m.userData`, and a `customProgramCacheKey` that folds a per-injection key. See
// docs/superpowers/plans/2026-09-16-scene3d-restyle-projective.md (Task 0) for the whole slice.
//
// WHY a MATERIAL injection, not a stage pass: v1 masked a FLAT result to the object's SCREEN
// silhouette, which is correct only from the bake angle — the moment the live camera orbits the flat
// image just re-stretches into the new axis-aligned bbox and slides off. This projects the restyle
// onto the object's ACTUAL geometry from the BAKE camera (a slide-projector), so the paint sticks to
// the surface as the live camera moves. The projector is a CONSTANT world-space transform (the bake
// view-projection), so there is ZERO per-frame uniform churn — orbiting needs no uniform writes.
//
// The crux (byte-identity, the same TWO shapes as S7/S5): an object with no aiRestyle ⇒ `materialFor`
// passes `restyle: null` ⇒ this is never called ⇒ the material compiles byte-for-byte unchanged. An
// aiRestyle whose result is not cached yet (no texture) OR whose projector is unstamped (`projViewProj`
// empty) ⇒ `applyRestyleProjection` early-outs BEFORE touching the material at all (not the compile
// chain, not the cache key, not userData) — exactly `applyFinish([])`'s early-out shape.
//
// COLOUR SPACE: the injection sits at `<dithering_fragment>`, AFTER `<tonemapping_fragment>` +
// `<colorspace_fragment>`, so `gl_FragColor` is already display-encoded (sRGB). The result PNG is
// sRGB bytes, so the surface tags its cached texture `THREE.NoColorSpace` (NOT SRGBColorSpace like
// v1's LINEAR stage) and this shader samples it RAW — no `srgbToLinear`. This is the opal-ramp lesson
// (finishes.ts ~81-89): a texture tagged sRGB would be GPU-decoded to linear and blended into an
// already-encoded buffer, darkening every fragment. Verify against a plain-object `mix:1` reference.
//
// GLSL float-literal rule (the S4/S5 ANGLE trap): every float operand carries a decimal point; no JS
// number is interpolated into GLSL arithmetic at all (every value rides a uniform). Source-guarded by
// scene3d-restyle-frag-guard.unit.spec.ts (built vertex + fragment).
import * as THREE from 'three'
import type { AiRestyleTreatment } from './treatments'

// ── GLSL ────────────────────────────────────────────────────────────────────────
// Two world-space varyings, injected into the VERTEX shader so the fragment can project each
// fragment's world position through the fixed bake view-projection. World pos comes from `transformed`
// (defined by <begin_vertex>, consumed by <project_vertex>); world normal from `objectNormal`
// (defined by <beginnormal_vertex>). A varying — not a reconstruction from `vViewPosition` — is what
// makes the projector a CONSTANT uniform (camera-independent) and works on unlit materials that carry
// no `vViewPosition`.
const RESTYLE_VERT_PARS = /* glsl */ `
varying vec3 vRestyleWorldPos;
varying vec3 vRestyleWorldNormal;
`

const RESTYLE_VERT_NORMAL = /* glsl */ `
  vRestyleWorldNormal = normalize( mat3( modelMatrix ) * objectNormal );
`

const RESTYLE_VERT_POS = /* glsl */ `
  vRestyleWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
`

const RESTYLE_FRAG_PARS = /* glsl */ `
uniform sampler2D uRestyleTex;
uniform mat4 uRestyleProjVP;
uniform vec4 uRestyleRect;   // bake-canvas crop rect: x, y (TOP-left origin), w, h — px
uniform vec2 uRestyleSize;   // bake canvas size — px
uniform vec3 uRestyleForward; // projector forward (bake camera look dir), world
uniform float uRestyleMix;
varying vec3 vRestyleWorldPos;
varying vec3 vRestyleWorldNormal;
`

// Project the fragment's world position through the bake view-projection, NDC -> crop-square UV using
// v1's EXACT crop mapping (RESTYLE_FRAG's rect/size/side/off maths — only the INPUT changed from live
// screen position to the projected bake NDC), gate on the front-facing normal + UV-in-range + w>0,
// sample the result RAW (display-space, NoColorSpace texture) and blend by mix * face * inUv.
const RESTYLE_FRAG_BODY = /* glsl */ `
{
  vec4 rstClip = uRestyleProjVP * vec4( vRestyleWorldPos, 1.0 );
  vec3 rstNdc = rstClip.xyz / rstClip.w;
  vec2 rstFull = rstNdc.xy * 0.5 + 0.5;
  // full-frame [0,1] (bottom-left) -> bake pixel (top-left origin) -> crop-square UV, exactly
  // cropSquareDataUrl's map (the v1 RESTYLE_FRAG crop maths, verbatim).
  vec2 rstPix = vec2( rstFull.x * uRestyleSize.x, ( 1.0 - rstFull.y ) * uRestyleSize.y );
  float rstSide = max( uRestyleRect.z, uRestyleRect.w );
  vec2 rstOff = vec2( floor( ( rstSide - uRestyleRect.z ) * 0.5 ), floor( ( rstSide - uRestyleRect.w ) * 0.5 ) );
  vec2 rstUv = ( vec2( rstPix.x - uRestyleRect.x, rstPix.y - uRestyleRect.y ) + rstOff ) / max( rstSide, 1.0 );
  vec3 rstNormal = normalize( vRestyleWorldNormal );
  // Soft front-facing gate: 1 where the fragment squarely faces the projector, fading to 0 toward the
  // silhouette so there is no hard terminator seam.
  float rstFace = smoothstep( 0.0, 0.25, -dot( rstNormal, uRestyleForward ) );
  float rstInUv = ( rstClip.w > 0.0 && all( greaterThanEqual( rstUv, vec2( 0.0 ) ) ) && all( lessThanEqual( rstUv, vec2( 1.0 ) ) ) ) ? 1.0 : 0.0;
  // flipY as v1: the result texture is flipY = true, so flip v to read the crop square top-left.
  vec3 rstRestyle = texture2D( uRestyleTex, vec2( rstUv.x, 1.0 - rstUv.y ) ).rgb;
  gl_FragColor.rgb = mix( gl_FragColor.rgb, rstRestyle, uRestyleMix * rstFace * rstInUv );
}
`

// ── CPU twins (unit-testable, mirror the GLSL exactly) ───────────────────────────
/** CPU twin of the shader's project-then-crop maths. `projViewProj` is COLUMN-MAJOR (three's
 *  `Matrix4.toArray()` order), exactly what the treatment stores. Returns the crop-square UV
 *  `rstUv` (BEFORE the shader's `1.0 - v` texture flip — the shader samples at `(u, 1 - v)`), or
 *  `null` when the point is behind the projector (`w <= 0`) or its UV falls outside the crop
 *  square [0,1]² — the two cases the shader's `rstInUv` gate zeroes out. Pins the shader's
 *  projection so a unit can assert a known world point lands on a known UV without a GPU. */
export function projectRestyleUV(
  worldPos: readonly [number, number, number],
  projViewProj: readonly number[],
  rect: readonly [number, number, number, number],
  size: readonly [number, number],
): [number, number] | null {
  const m = projViewProj
  const [x, y, z] = worldPos
  // Column-major: element (row r, col c) = m[c * 4 + r].
  const clipX = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!
  const clipY = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!
  const clipW = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!
  if (clipW <= 0) return null // behind the projector
  const ndcX = clipX / clipW
  const ndcY = clipY / clipW
  const fullX = ndcX * 0.5 + 0.5
  const fullY = ndcY * 0.5 + 0.5
  const pixX = fullX * size[0]
  const pixY = (1 - fullY) * size[1]
  const side = Math.max(rect[2], rect[3])
  const offX = Math.floor((side - rect[2]) * 0.5)
  const offY = Math.floor((side - rect[3]) * 0.5)
  const denom = Math.max(side, 1)
  const u = (pixX - rect[0] + offX) / denom
  const v = (pixY - rect[1] + offY) / denom
  if (u < 0 || u > 1 || v < 0 || v > 1) return null // outside the crop square
  return [u, v]
}

/** CPU twin of the shader's front-facing gate: `smoothstep(0, 0.25, -dot(normalize(n), forward))`.
 *  1 where the surface squarely faces the projector, 0 where it faces away, a soft ramp across the
 *  terminator. `worldNormal` need not be pre-normalized (normalized here, as the shader does). */
export function restyleFrontFacing(
  worldNormal: readonly [number, number, number],
  forward: readonly [number, number, number],
): number {
  const len = Math.hypot(worldNormal[0], worldNormal[1], worldNormal[2]) || 1
  const nx = worldNormal[0] / len, ny = worldNormal[1] / len, nz = worldNormal[2] / len
  const facing = -(nx * forward[0] + ny * forward[1] + nz * forward[2])
  const t = Math.min(1, Math.max(0, (facing - 0) / (0.25 - 0)))
  return t * t * (3 - 2 * t)
}

// ── The rebuild-boundary key + the uniform bag ──────────────────────────────────
/** The restyle projection's contribution to `materials.ts`'s `identityKey`. Empty (contributes
 *  NOTHING — byte-identical) when there is no cached texture or the projector is unstamped
 *  (`projViewProj` empty); otherwise keyed by `resultRef` — a NEW result (a fresh bake, a new
 *  filename) is a program/uniform-bag boundary, exactly like `finishKey`'s matcap-id fold-in. */
export function restyleProjectionKey(t: AiRestyleTreatment, tex: THREE.Texture | null | undefined): string {
  if (!tex || !t.projViewProj.length) return ''
  return `|rst:${t.resultRef}`
}

interface RestyleUniformBag {
  u: Record<string, { value: unknown }>
  /** The bound texture + resultRef this bag was built for — a change to either is a REBUILD
   *  boundary `updateRestyleUniforms` catches (it swaps the sampled texture uniform, which a
   *  plain in-place write cannot do). */
  tex: THREE.Texture
  resultRef: string
}

function restyleUniformBag(t: AiRestyleTreatment, tex: THREE.Texture): Record<string, { value: unknown }> {
  return {
    uRestyleTex: { value: tex },
    uRestyleProjVP: { value: new THREE.Matrix4().fromArray(t.projViewProj) },
    uRestyleRect: { value: new THREE.Vector4(t.projRect[0] ?? 0, t.projRect[1] ?? 0, t.projRect[2] ?? 0, t.projRect[3] ?? 0) },
    uRestyleSize: { value: new THREE.Vector2(t.projSize[0] ?? 1, t.projSize[1] ?? 1) },
    uRestyleForward: { value: new THREE.Vector3(t.projForward[0] ?? 0, t.projForward[1] ?? 0, t.projForward[2] ?? -1) },
    uRestyleMix: { value: t.mix },
  }
}

/** The projective restyle seam: chains one `onBeforeCompile` overlay onto whatever injection the
 *  material already carries (base type, `applyScreen`, `applyVaryTint`, `applyFinish` — in that
 *  order, since `materialFor` calls this LAST, so the restyle is the TOPMOST coat over the object's
 *  already-lit/tinted/finished surface). Modelled on `applyFinish`, including the eager cache-key
 *  snapshot (read `applyScreen`/`applyFinish`'s comments for the `customProgramCacheKey` hazard this
 *  avoids the same way).
 *
 *  BYTE-IDENTICAL GATE: no texture, or an unstamped projector (`projViewProj` empty), never touches
 *  the material at all — not the compile chain, not the cache key, not userData — so an object with
 *  an uncached/unrun restyle builds/compiles exactly as it did before this file existed. */
export function applyRestyleProjection(m: THREE.Material, t: AiRestyleTreatment, tex: THREE.Texture | null): void {
  if (!tex || !t.projViewProj.length) return
  const u = restyleUniformBag(t, tex)
  const baseKey = String(m.customProgramCacheKey?.() ?? '')
  const prev = m.onBeforeCompile
  m.onBeforeCompile = (shader, renderer) => {
    prev.call(m, shader, renderer)
    Object.assign(shader.uniforms, u)
    // Vertex: two world varyings, injected AFTER the chunks that define their source values.
    shader.vertexShader = RESTYLE_VERT_PARS + shader.vertexShader
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n${RESTYLE_VERT_NORMAL}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${RESTYLE_VERT_POS}`)
    // Fragment: the projected sample blended at the terminal display-space anchor. `pars` prepended
    // to the top (the one site no earlier injection in the chain can have consumed), exactly as
    // applyFinish does.
    shader.fragmentShader = RESTYLE_FRAG_PARS + shader.fragmentShader
      .replace('#include <dithering_fragment>', `${RESTYLE_FRAG_BODY}\n#include <dithering_fragment>`)
  }
  m.customProgramCacheKey = () => `${baseKey}${restyleProjectionKey(t, tex)}`
  m.userData.restyleUniforms = { u, tex, resultRef: t.resultRef } as RestyleUniformBag
}

/** Writes the restyle's CURRENT `mix` into its already-bound uniform bag, IN PLACE — a mix-slider
 *  drag (or a `mix` motion track) must never rebuild. Mirrors `updateFinishUniforms`. Returns
 *  `false` (⇒ the caller, materials.ts's `updateMaterial`, must rebuild via `materialFor`) when a
 *  new injection is wanted but none is bound (a first texture), when one is bound but is no longer
 *  wanted (the texture/projector went away), or when the bound texture / resultRef / projector matrix
 *  has changed (a fresh bake) — every one of those swaps a bound texture or a constant uniform, which
 *  an in-place write cannot do. Two "no injection" states (no bag, nothing wanted) are NOT a
 *  mismatch — that is the byte-identical steady state before this feature and after a restyle clears. */
export function updateRestyleUniforms(m: THREE.Material, t: AiRestyleTreatment, tex: THREE.Texture | null): boolean {
  const bag = m.userData.restyleUniforms as RestyleUniformBag | undefined
  const wants = !!tex && t.projViewProj.length > 0
  if (!bag) return !wants // no injection bound: fine iff none is wanted; otherwise rebuild to add it
  if (!wants) return false // an injection is bound but no longer wanted — rebuild to drop it
  if (bag.tex !== tex || bag.resultRef !== t.resultRef) return false // a fresh texture/result — rebuild
  const mtx = (bag.u.uRestyleProjVP!.value as THREE.Matrix4).elements
  for (let i = 0; i < 16; i++) if (mtx[i] !== t.projViewProj[i]) return false // a fresh projector — rebuild
  bag.u.uRestyleMix!.value = t.mix // the one live, in-place dial
  return true
}
