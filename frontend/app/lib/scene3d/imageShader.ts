import * as THREE from 'three'
import { MATERIAL_DEFAULTS, type SceneMaterial } from './config'

/**
 * The GLSL the `image` material injects through `onBeforeCompile`, and the uniform bucket
 * behind it. Strings and plain objects only — no DOM dependency — so the whole module is
 * unit-testable in the node environment (it does import `three` itself now, for
 * `THREE.Matrix3`/`THREE.Vector3` uniform values and `syncImageMapMatrix`'s texture read).
 *
 * The adjustment chunk is injected UNCONDITIONALLY, with identity defaults, rather than
 * only when an adjustment is non-neutral. That is deliberate: making injection conditional
 * would put the three sliders on a program-define boundary, so the first pixel of a
 * brightness drag would recompile the shader. Three extra arithmetic ops per fragment is a
 * far better trade than a mid-drag stall.
 *
 * Projection (Task 11) piggybacks on the same injection point: `.map` samples the mesh's
 * own UV attribute, which is a poor or absent coordinate on much of the geometry this
 * studio produces (ExtrudeGeometry sidewalls, ConvexGeometry with no UVs at all). Instead
 * the fragment can derive its own coordinate from object-space position — flat, cylinder,
 * sphere, or (a separate program) a triplanar box blend.
 */

const PROJ_MODE: Record<string, number> = { uv: 0, planar: 1, cylindrical: 2, spherical: 3, box: 0 }
const PROJ_AXIS: Record<string, number> = { x: 0, y: 1, z: 2 }

export interface ImageUniforms {
  uImgBrightness: { value: number }
  uImgContrast: { value: number }
  uImgSaturation: { value: number }
  /** 0 mesh UVs, 1 flat, 2 cylinder, 3 sphere. 'box' is a separate PROGRAM (three
   *  texture samples), not a mode here, so it reports 0 and never reaches the branch. */
  uImgProjMode: { value: number }
  uImgProjAxis: { value: number }
  /** Our own copy of the texture's UV matrix. three declares `mapTransform` in the VERTEX
   *  shader only, and the projection has to reproduce the transform per fragment. Kept in
   *  step by syncImageMapMatrix. */
  uImgMapTx: { value: THREE.Matrix3 }
  /** Object-space bounds, so a projection spans the object rather than raw world units.
   *  Computed from the geometry at BUILD time, then kept FRESH by `refreshImageBounds`
   *  below — engine.ts calls it every sync, right where it does the same for the gradient
   *  material's `uBoxMin`/`uBoxMax` (see engine.ts's per-sync bbox refresh). That refresh
   *  exists precisely because a geometry can swap in place (params, modifiers) without a
   *  material rebuild — so, despite an EARLIER version of this comment claiming otherwise,
   *  there is no "reads once, stays stale until the next rebuild" limitation here to match
   *  the gradient material's: both are refreshed in place, every sync. */
  uImgBoundsMin: { value: THREE.Vector3 }
  uImgBoundsSize: { value: THREE.Vector3 }
  uImgBoxBlend: { value: number }
}

export function imageUniforms(mat: SceneMaterial, geometry?: THREE.BufferGeometry): ImageUniforms {
  const min = new THREE.Vector3(-0.5, -0.5, -0.5)
  const size = new THREE.Vector3(1, 1, 1)
  if (geometry) {
    if (!geometry.boundingBox) geometry.computeBoundingBox()
    const bb = geometry.boundingBox
    if (bb) {
      min.copy(bb.min)
      size.subVectors(bb.max, bb.min)
      // A flat object (a plane, a decal card) has a zero extent on one axis; dividing by it
      // would produce infinities across the whole projection.
      size.set(Math.max(size.x, 1e-4), Math.max(size.y, 1e-4), Math.max(size.z, 1e-4))
    }
  }
  return {
    uImgBrightness: { value: mat.imageBrightness ?? MATERIAL_DEFAULTS.imageBrightness },
    uImgContrast: { value: mat.imageContrast ?? MATERIAL_DEFAULTS.imageContrast },
    uImgSaturation: { value: mat.imageSaturation ?? MATERIAL_DEFAULTS.imageSaturation },
    uImgProjMode: { value: PROJ_MODE[mat.imageProjection ?? MATERIAL_DEFAULTS.imageProjection] ?? 0 },
    uImgProjAxis: { value: PROJ_AXIS[mat.imageProjectionAxis ?? MATERIAL_DEFAULTS.imageProjectionAxis] ?? 1 },
    uImgMapTx: { value: new THREE.Matrix3() },
    uImgBoundsMin: { value: min },
    uImgBoundsSize: { value: size },
    uImgBoxBlend: { value: mat.imageBoxBlend ?? MATERIAL_DEFAULTS.imageBoxBlend },
  }
}

/** Recompute `uImgBoundsMin`/`uImgBoundsSize` from the CURRENT geometry and write them into
 *  the uniforms IN PLACE (mutating the existing Vector3 objects, exactly like
 *  `writeImageUniforms` — the compiled program holds these by reference). Important 2 of the
 *  final review: without this, a geometry edit (width/height/segments, or a modifier) while
 *  Wrapping is Flat/Cylinder/Sphere/Box left the projection scaled to the OLD bounds — a
 *  geometry swaps in place without a material rebuild (see engine.ts), so `imageUniforms`'s
 *  build-time-only read never saw the change. Call this from the same per-sync spot engine.ts
 *  already refreshes the gradient material's `uBoxMin`/`uBoxMax` from. Applies the SAME 1e-4
 *  floor `imageUniforms` uses on each axis, so a flat object (zero extent on one axis) can
 *  never divide by zero in the shader. */
export function refreshImageBounds(u: ImageUniforms, geometry: THREE.BufferGeometry): void {
  if (!geometry.boundingBox) geometry.computeBoundingBox()
  const bb = geometry.boundingBox
  if (!bb) return
  u.uImgBoundsMin.value.copy(bb.min)
  u.uImgBoundsSize.value.subVectors(bb.max, bb.min)
  u.uImgBoundsSize.value.set(
    Math.max(u.uImgBoundsSize.value.x, 1e-4),
    Math.max(u.uImgBoundsSize.value.y, 1e-4),
    Math.max(u.uImgBoundsSize.value.z, 1e-4),
  )
}

/** Mutate the bucket the compiled program holds BY REFERENCE. Never replace the inner
 *  objects — the program keeps the references it was compiled with. */
export function writeImageUniforms(u: ImageUniforms, mat: SceneMaterial): void {
  u.uImgBrightness.value = mat.imageBrightness ?? MATERIAL_DEFAULTS.imageBrightness
  u.uImgContrast.value = mat.imageContrast ?? MATERIAL_DEFAULTS.imageContrast
  u.uImgSaturation.value = mat.imageSaturation ?? MATERIAL_DEFAULTS.imageSaturation
  u.uImgProjMode.value = PROJ_MODE[mat.imageProjection ?? MATERIAL_DEFAULTS.imageProjection] ?? 0
  u.uImgProjAxis.value = PROJ_AXIS[mat.imageProjectionAxis ?? MATERIAL_DEFAULTS.imageProjectionAxis] ?? 1
  u.uImgBoxBlend.value = mat.imageBoxBlend ?? MATERIAL_DEFAULTS.imageBoxBlend
}

/** Copy the texture's own UV matrix into the uniform the fragment projection reads.
 *  `updateMatrix` must run first: three only refreshes it during rendering. */
export function syncImageMapMatrix(u: ImageUniforms, tex: THREE.Texture | null | undefined): void {
  if (!tex) return
  tex.updateMatrix()
  u.uImgMapTx.value.copy(tex.matrix)
}

export const IMAGE_PROJECT_VERTEX_GLSL = `
varying vec3 vImgPos;
varying vec3 vImgNrm;
`

/** Spliced in after `#include <begin_vertex>`, where `position` and `normal` are in scope. */
export const IMAGE_PROJECT_VERTEX_CALL = `#include <begin_vertex>
  vImgPos = position;
  vImgNrm = normal;`

/**
 * Prepended to the fragment shader, ahead of `void main()`. Despite the old name
 * (`IMAGE_ADJUST_GLSL`), this now carries the whole projection library too — nine
 * uniforms, two varyings and four projection functions, not just the brightness/
 * contrast/saturation adjustment. Renamed `IMAGE_FRAGMENT_PARS` to say so.
 *
 * Rec. 709 luma for the saturation pivot — the same weights the studio's post stack uses.
 *
 * `sailorImageUv` and the triplanar helpers below exist so BOTH the diffuse splice
 * (`imageMapFragment`) and the emissive splice (`imageEmissiveMapFragment`) sample through
 * the identical projected coordinate / blend weights — see those functions' docs for why
 * that must hold.
 */
export const IMAGE_FRAGMENT_PARS = `
uniform float uImgBrightness;
uniform float uImgContrast;
uniform float uImgSaturation;
uniform float uImgProjMode;
uniform float uImgProjAxis;
uniform float uImgBoxBlend;
uniform mat3 uImgMapTx;
uniform vec3 uImgBoundsMin;
uniform vec3 uImgBoundsSize;
varying vec3 vImgPos;
varying vec3 vImgNrm;

vec3 sailorImageAdjust( vec3 c ) {
  c = ( c - 0.5 ) * uImgContrast + 0.5;
  c += uImgBrightness;
  float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
  c = mix( vec3( l ), c, uImgSaturation );
  return clamp( c, 0.0, 1.0 );
}

/** Object-space position, normalised to 0..1 across the object's own bounds. */
vec3 sailorImageUnit( vec3 p ) {
  return ( p - uImgBoundsMin ) / uImgBoundsSize;
}

/** A flat projection facing down one axis. */
vec2 sailorImagePlanar( vec3 p, float axis ) {
  vec3 u = sailorImageUnit( p );
  if ( axis < 0.5 ) return u.zy;   // facing X
  if ( axis < 1.5 ) return u.xz;   // facing Y
  return u.xy;                      // facing Z
}

/** A cylinder spun about one axis: angle across, height up. The seam sits on the -X
 *  meridian, where atan wraps; that thin line is unavoidable in any angular projection. */
vec2 sailorImageCylindrical( vec3 p, float axis ) {
  vec3 u = sailorImageUnit( p ) - 0.5;
  vec2 around = axis < 0.5 ? vec2( u.y, u.z ) : ( axis < 1.5 ? vec2( u.z, u.x ) : vec2( u.x, u.y ) );
  float along = axis < 0.5 ? u.x : ( axis < 1.5 ? u.y : u.z );
  return vec2( atan( around.x, around.y ) / 6.2831853 + 0.5, along + 0.5 );
}

/** A sphere: longitude across, latitude up. Always Y-up — an axis choice here would only
 *  rotate the picture, which the Rotation control already does.
 *
 *  DIVERGENCE, KEPT ON PURPOSE (review Finding 4): this puts v = 0 at the north pole and
 *  winds longitude opposite to three's own SphereGeometry — a net 180° rotation against
 *  three's convention. It was left exactly this way because it exactly matches this
 *  repo's own addSphericalUV (roundedGeometry.ts), which every ConvexGeometry/GLB/sculpt
 *  sphere-ish shape already relies on for "Use the model" wrapping. Matching three's
 *  SphereGeometry instead would make Sphere wrapping disagree with "Use the model" on
 *  those shapes — the one case this repo actually cares about — so consistency with our
 *  own convention wins over consistency with three's. Do not "fix" this without also
 *  changing addSphericalUV. */
vec2 sailorImageSpherical( vec3 p ) {
  vec3 d = normalize( sailorImageUnit( p ) - 0.5 );
  return vec2( atan( d.z, d.x ) / 6.2831853 + 0.5, acos( clamp( d.y, -1.0, 1.0 ) ) / 3.1415927 );
}

vec2 sailorImageProject( vec3 p, float mode, float axis ) {
  if ( mode < 1.5 ) return sailorImagePlanar( p, axis );
  if ( mode < 2.5 ) return sailorImageCylindrical( p, axis );
  return sailorImageSpherical( p );
}

/** The single-sample coordinate shared by the diffuse and emissive splices: mesh UVs at
 *  mode zero, the projected + UV-matrix-transformed coordinate otherwise. \`meshUv\` is
 *  whichever varying the calling chunk already has in scope (\`vMapUv\`/\`vEmissiveMapUv\`),
 *  since three computes those per-map from the same shared texture matrix. */
vec2 sailorImageUv( vec2 meshUv ) {
  return uImgProjMode < 0.5
    ? meshUv
    : ( uImgMapTx * vec3( sailorImageProject( vImgPos, uImgProjMode, uImgProjAxis ), 1.0 ) ).xy;
}

/** Triplanar blend weights from the face normal — abs + sharpened + renormalised so the
 *  three axis samples sum to 1. Guarded against a zero-length normal (Finding 5: WebGL
 *  supplies (0,0,0) when the geometry has no normal attribute, which would otherwise
 *  divide by zero inside \`normalize\`) by normalising by hand with a floored length. */
vec3 sailorTriplanarWeights( vec3 n ) {
  vec3 unit = n / max( length( n ), 1e-6 );
  vec3 w = abs( unit );
  w = pow( w, vec3( 1.0 + ( 1.0 - uImgBoxBlend ) * 16.0 ) );
  return w / max( w.x + w.y + w.z, 1e-4 );
}

/** Samples \`tex\` along all three planar axes at \`p\` and blends by \`weights\` — the one
 *  triplanar sample-and-blend shared by the diffuse (map) and emissive (emissiveMap)
 *  splices, so a box projection's glow blends identically to its picture. */
vec4 sailorTriplanarSample( sampler2D tex, vec3 p, vec3 weights ) {
  vec4 sailorX = texture2D( tex, ( uImgMapTx * vec3( sailorImagePlanar( p, 0.0 ), 1.0 ) ).xy );
  vec4 sailorY = texture2D( tex, ( uImgMapTx * vec3( sailorImagePlanar( p, 1.0 ), 1.0 ) ).xy );
  vec4 sailorZ = texture2D( tex, ( uImgMapTx * vec3( sailorImagePlanar( p, 2.0 ), 1.0 ) ).xy );
  return sailorX * weights.x + sailorY * weights.y + sailorZ * weights.z;
}
`

/**
 * REPLACES `#include <map_fragment>` outright, rather than appending to it as the
 * adjustment alone did — the projection has to choose the coordinate before the sample,
 * which the stock chunk gives no seam for. `DECODE_VIDEO_TEXTURE` is dropped deliberately:
 * the image material binds still images from the input directory, never a video texture.
 *
 * `box` is the three-sample triplanar blend, and is a SEPARATE PROGRAM (see identityKey in
 * materials.ts) so a plain projection never pays for two extra texture fetches.
 */
export function imageMapFragment(box: boolean): string {
  const single = `
#ifdef USE_MAP
  vec2 sailorUv = sailorImageUv( vMapUv );
  diffuseColor *= texture2D( map, sailorUv );
  diffuseColor.rgb = sailorImageAdjust( diffuseColor.rgb );
#endif
`
  const triplanar = `
#ifdef USE_MAP
  vec3 sailorW = sailorTriplanarWeights( vImgNrm );
  diffuseColor *= sailorTriplanarSample( map, vImgPos, sailorW );
  diffuseColor.rgb = sailorImageAdjust( diffuseColor.rgb );
#endif
`
  return box ? triplanar : single
}

/**
 * REPLACES `#include <emissivemap_fragment>` outright, mirroring `imageMapFragment` — see
 * that function's doc for why a `#include` replacement rather than an append. Fixes review
 * Finding 1: without this, `applyImageGlow`'s emissive map sampled through the MESH uv
 * (`vEmissiveMapUv`) even while the diffuse map sampled through the projected coordinate,
 * so the glow (a light-box/screen/sign look) stopped lining up with the picture the moment
 * a non-`uv` projection was chosen — exactly the invariant `applyImageGlow`'s own doc
 * comment names ("the glow must line up with the picture").
 *
 * `DECODE_VIDEO_TEXTURE_EMISSIVE` is dropped deliberately, exactly as `imageMapFragment`
 * drops `DECODE_VIDEO_TEXTURE`: this material binds still images from the input directory,
 * never a video texture.
 *
 * `box` shares `sailorTriplanarWeights`/`sailorTriplanarSample` with `imageMapFragment`
 * rather than recomputing the blend, so the emissive map is guaranteed to blend identically
 * to the diffuse map on a box projection — not just sample the same coordinate.
 *
 * Important 4 of the final review (the COLOUR half of "the glow must line up with the
 * picture" — the fix above was the GEOMETRIC half): `imageMapFragment` runs the sampled
 * pixel through `sailorImageAdjust` (brightness/contrast/saturation) and through the
 * material's own tint (`diffuseColor *= texture2D(...)`, tint already baked into
 * `diffuseColor` by the time that runs). This splice used to skip both, so Saturation 0
 * with Glow > 0 rendered a grey surface under a full-colour glow, and a coloured Tint left
 * the glow untinted. `diffuse` (the material's own colour uniform — the same one
 * `imageMapFragment`'s `diffuseColor` is seeded from) is in scope at `emissivemap_fragment`,
 * so both splices now agree on colour, not just on coordinate.
 */
export function imageEmissiveMapFragment(box: boolean): string {
  const single = `
#ifdef USE_EMISSIVEMAP
  vec4 emissiveColor = texture2D( emissiveMap, sailorImageUv( vEmissiveMapUv ) );
  totalEmissiveRadiance *= sailorImageAdjust( emissiveColor.rgb * diffuse );
#endif
`
  const triplanar = `
#ifdef USE_EMISSIVEMAP
  vec3 sailorEmissiveW = sailorTriplanarWeights( vImgNrm );
  vec4 emissiveColor = sailorTriplanarSample( emissiveMap, vImgPos, sailorEmissiveW );
  totalEmissiveRadiance *= sailorImageAdjust( emissiveColor.rgb * diffuse );
#endif
`
  return box ? triplanar : single
}
