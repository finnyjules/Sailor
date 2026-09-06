import * as THREE from 'three'
import { MATERIAL_DEFAULTS, type SceneMaterial } from './config'

/**
 * The `image` material's texture transform: wrap mode, tiling, fit, offset, rotation
 * and flip, all expressed as properties of the bound THREE.Texture rather than as
 * shader work. Everything here is arithmetic over the document — no DOM, no GPU — so
 * it is unit-testable in the node environment the studio's specs run in.
 *
 * OWNERSHIP: `repeat`/`offset`/`rotation` live on the Texture, not on the Material, so
 * the material this is applied to MUST own its Texture exclusively. The image material
 * used to hand out a shared, per-filename cached Texture; Task 3 of the image-options
 * plan changed that, and this module cannot be used with a shared one.
 */

export interface NaturalSize { w: number; h: number }

const WRAP: Record<string, THREE.Wrapping> = {
  clamp: THREE.ClampToEdgeWrapping,
  tile: THREE.RepeatWrapping,
  mirror: THREE.MirroredRepeatWrapping,
}

/** The wrap key (as stamped into `userData.imageWrapApplied`) and its THREE constant for a
 *  material's `imageWrap` field, defaulting exactly like `applyImageTransform` below. Exported
 *  so `ownedImageTexture` (materials.ts) can prime a freshly built texture's wrapS/wrapT +
 *  stamp BEFORE handing it to the first `applyImageTransform` call — that first call fires
 *  before the image has decoded, and without this priming it always sees a fresh `undefined`
 *  stamp and bumps `needsUpdate` on an incomplete texture (Finding 2, image-material follow-ups). */
export function imageWrapMode(mat: SceneMaterial): { key: string; wrap: THREE.Wrapping } {
  const key = mat.imageWrap ?? MATERIAL_DEFAULTS.imageWrap
  return { key, wrap: WRAP[key] ?? THREE.ClampToEdgeWrapping }
}

/** Horizontal and vertical repeats. The link switch means "one number drives both",
 *  so the second field is not merely defaulted when linked — it is ignored, and the
 *  value the user last typed into it survives being unlinked and relinked. */
export function imageTilingXY(mat: SceneMaterial): [number, number] {
  const x = mat.imageTiling ?? MATERIAL_DEFAULTS.imageTiling
  if (mat.imageTilingLinked === false) return [x, mat.imageTilingY ?? MATERIAL_DEFAULTS.imageTilingY]
  return [x, x]
}

/**
 * Reconcile the picture's own aspect ratio with the surface it is being sampled over.
 *
 * The UV square is treated as 1:1 — which is what it is for every primitive the studio
 * builds, and the only assumption available for an imported mesh whose UVs are opaque.
 * A texture coordinate is `uv * repeat + offset`, so a picture is made to occupy a
 * NARROWER band of the UV range by giving it a LARGER repeat on that axis, and the
 * offset then re-centres the band.
 *
 * Returns an identity transform for 'stretch' and for a picture whose pixel size is
 * not known yet — a texture that has not finished decoding has no `image.width`, and
 * the material re-applies this from the loader's onLoad once it does.
 */
export function imageFitTransform(
  mat: SceneMaterial, natural?: NaturalSize | null,
): { rx: number; ry: number; ox: number; oy: number } {
  const identity = { rx: 1, ry: 1, ox: 0, oy: 0 }
  const fit = mat.imageFit ?? MATERIAL_DEFAULTS.imageFit
  if (fit === 'stretch') return identity
  if (!natural || !(natural.w > 0) || !(natural.h > 0)) return identity
  const a = natural.w / natural.h
  if (a === 1) return identity
  if (fit === 'cover') {
    // Fill the square and crop the long axis: the long axis shows a centred 1/a slice.
    return a > 1
      ? { rx: 1 / a, ry: 1, ox: (1 - 1 / a) / 2, oy: 0 }
      : { rx: 1, ry: a, ox: 0, oy: (1 - a) / 2 }
  }
  // contain: the whole picture fits, and the short axis is letterboxed. Whatever the
  // wrap mode does outside 0..1 is what fills the letterbox — 'clamp' smears the edge
  // pixel, 'tile'/'mirror' repeat the picture into it.
  return a > 1
    ? { rx: 1, ry: a, ox: 0, oy: (1 - a) / 2 }
    : { rx: 1 / a, ry: 1, ox: (1 - 1 / a) / 2, oy: 0 }
}

/**
 * Write the whole transform onto a texture the caller owns.
 *
 * NB `needsUpdate`: `repeat`/`offset`/`rotation`/`center` are picked up for free —
 * `Texture.matrixAutoUpdate` is true by default, so three rebuilds the UV matrix each
 * frame. `wrapS`/`wrapT` are different: they are sampler parameters applied when the
 * texture is uploaded, so a change to them DOES need `needsUpdate` — and `needsUpdate`
 * re-uploads the pixels, which is far too expensive to do on every slider tick. Hence
 * the stamp: bump only when the wrap mode actually moved.
 */
export function applyImageTransform(
  tex: THREE.Texture, mat: SceneMaterial, natural?: NaturalSize | null,
): void {
  const { key, wrap } = imageWrapMode(mat)
  if (tex.userData.imageWrapApplied !== key) {
    tex.userData.imageWrapApplied = key
    tex.wrapS = tex.wrapT = wrap
    tex.needsUpdate = true
  }

  const [tx, ty] = imageTilingXY(mat)
  const fit = imageFitTransform(mat, natural)
  let rx = fit.rx * tx
  let ry = fit.ry * ty
  let ox = fit.ox + (mat.imageOffsetX ?? MATERIAL_DEFAULTS.imageOffsetX)
  let oy = fit.oy + (mat.imageOffsetY ?? MATERIAL_DEFAULTS.imageOffsetY)

  // A flip walks the SAME band of the picture in the opposite direction: negate the
  // repeat and advance the offset to the far end of the band, so the visible crop is
  // unchanged and only its direction reverses.
  if (mat.imageFlipX === true) { ox += rx; rx = -rx }
  if (mat.imageFlipY === true) { oy += ry; ry = -ry }

  tex.repeat.set(rx, ry)
  tex.offset.set(ox, oy)
  tex.center.set(0.5, 0.5)
  tex.rotation = (mat.imageRotation ?? MATERIAL_DEFAULTS.imageRotation) * Math.PI / 180
}
