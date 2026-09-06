import { MATERIAL_DEFAULTS, type SceneMaterial } from './config'

/**
 * The GLSL the `image` material injects through `onBeforeCompile`, and the uniform bucket
 * behind it. Strings and plain objects only — no `three` import, no DOM — so the whole
 * module is unit-testable in the node environment.
 *
 * The adjustment chunk is injected UNCONDITIONALLY, with identity defaults, rather than
 * only when an adjustment is non-neutral. That is deliberate: making injection conditional
 * would put the three sliders on a program-define boundary, so the first pixel of a
 * brightness drag would recompile the shader. Three extra arithmetic ops per fragment is a
 * far better trade than a mid-drag stall.
 */

export interface ImageUniforms {
  uImgBrightness: { value: number }
  uImgContrast: { value: number }
  uImgSaturation: { value: number }
}

export function imageUniforms(mat: SceneMaterial): ImageUniforms {
  return {
    uImgBrightness: { value: mat.imageBrightness ?? MATERIAL_DEFAULTS.imageBrightness },
    uImgContrast: { value: mat.imageContrast ?? MATERIAL_DEFAULTS.imageContrast },
    uImgSaturation: { value: mat.imageSaturation ?? MATERIAL_DEFAULTS.imageSaturation },
  }
}

/** Mutate the bucket the compiled program holds BY REFERENCE. Never replace the inner
 *  objects — the program keeps the references it was compiled with. */
export function writeImageUniforms(u: ImageUniforms, mat: SceneMaterial): void {
  u.uImgBrightness.value = mat.imageBrightness ?? MATERIAL_DEFAULTS.imageBrightness
  u.uImgContrast.value = mat.imageContrast ?? MATERIAL_DEFAULTS.imageContrast
  u.uImgSaturation.value = mat.imageSaturation ?? MATERIAL_DEFAULTS.imageSaturation
}

/** Prepended to the fragment shader, ahead of `void main()`. Rec. 709 luma for the
 *  saturation pivot — the same weights the studio's post stack uses. */
export const IMAGE_ADJUST_GLSL = `
uniform float uImgBrightness;
uniform float uImgContrast;
uniform float uImgSaturation;
vec3 sailorImageAdjust( vec3 c ) {
  c = ( c - 0.5 ) * uImgContrast + 0.5;
  c += uImgBrightness;
  float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
  c = mix( vec3( l ), c, uImgSaturation );
  return clamp( c, 0.0, 1.0 );
}
`

/**
 * Replaces `#include <map_fragment>`, keeping the include and appending the adjustment.
 *
 * NB the adjustment runs on `diffuseColor` AFTER the tint has been multiplied in (three
 * seeds `diffuseColor` from the material's `.color` before this chunk samples the map), so
 * Contrast and Saturation act on the tinted picture, not on the raw file. That is the
 * useful order — a tinted picture desaturating toward its tint rather than toward grey.
 */
export const IMAGE_ADJUST_CALL = `#include <map_fragment>
  diffuseColor.rgb = sailorImageAdjust( diffuseColor.rgb );`
