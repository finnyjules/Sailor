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
   *  Read from the geometry at BUILD time — `updateMaterial` gets no geometry, so a
   *  reshaped mesh picks these up on its next rebuild. The gradient material has read its
   *  bounds the same way, with the same limitation, since it shipped. */
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

/** Prepended to the fragment shader, ahead of `void main()`. Rec. 709 luma for the
 *  saturation pivot — the same weights the studio's post stack uses. */
export const IMAGE_ADJUST_GLSL = `
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
 *  rotate the picture, which the Rotation control already does. */
vec2 sailorImageSpherical( vec3 p ) {
  vec3 d = normalize( sailorImageUnit( p ) - 0.5 );
  return vec2( atan( d.z, d.x ) / 6.2831853 + 0.5, acos( clamp( d.y, -1.0, 1.0 ) ) / 3.1415927 );
}

vec2 sailorImageProject( vec3 p, float mode, float axis ) {
  if ( mode < 1.5 ) return sailorImagePlanar( p, axis );
  if ( mode < 2.5 ) return sailorImageCylindrical( p, axis );
  return sailorImageSpherical( p );
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
  vec2 sailorUv = uImgProjMode < 0.5
    ? vMapUv
    : ( uImgMapTx * vec3( sailorImageProject( vImgPos, uImgProjMode, uImgProjAxis ), 1.0 ) ).xy;
  diffuseColor *= texture2D( map, sailorUv );
  diffuseColor.rgb = sailorImageAdjust( diffuseColor.rgb );
#endif
`
  const triplanar = `
#ifdef USE_MAP
  vec3 sailorN = abs( normalize( vImgNrm ) );
  sailorN = pow( sailorN, vec3( 1.0 + ( 1.0 - uImgBoxBlend ) * 16.0 ) );
  sailorN /= max( sailorN.x + sailorN.y + sailorN.z, 1e-4 );
  vec4 sailorX = texture2D( map, ( uImgMapTx * vec3( sailorImagePlanar( vImgPos, 0.0 ), 1.0 ) ).xy );
  vec4 sailorY = texture2D( map, ( uImgMapTx * vec3( sailorImagePlanar( vImgPos, 1.0 ), 1.0 ) ).xy );
  vec4 sailorZ = texture2D( map, ( uImgMapTx * vec3( sailorImagePlanar( vImgPos, 2.0 ), 1.0 ) ).xy );
  diffuseColor *= sailorX * sailorN.x + sailorY * sailorN.y + sailorZ * sailorN.z;
  diffuseColor.rgb = sailorImageAdjust( diffuseColor.rgb );
#endif
`
  return box ? triplanar : single
}
