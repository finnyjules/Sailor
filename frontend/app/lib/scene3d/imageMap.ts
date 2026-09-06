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

const hasDOM = typeof document !== 'undefined'

/** The blend width as a fraction of the picture, clamped below half — at half the two
 *  fades meet in the middle and the picture is replaced by its own average. */
export function seamlessWidth(mat: SceneMaterial): number {
  const w = mat.imageSeamless ?? MATERIAL_DEFAULTS.imageSeamless
  if (!(w > 0)) return 0
  return Math.min(w, 0.45)
}

/** One border strip a seamless blend composites: `sx/sy/sw/sh` is the source rectangle to
 *  read (from the OPPOSITE edge — the pixels this border will actually sit next to once
 *  the picture tiles), `dx/dy` is where it lands (always inside the canvas — see the
 *  overlap contract below), and `mirror` is the axis it is flipped on before compositing
 *  so the two copies agree at the seam instead of merely being adjacent. */
export interface SeamlessStrip {
  sx: number; sy: number; sw: number; sh: number
  dx: number; dy: number
  mirror: 'x' | 'y'
}

/**
 * The four border strips a seamless blend needs, as pure geometry — no DOM, so this is
 * unit-testable in node even though `seamlessCanvas` below is not.
 *
 * Each border is paired with the strip it will ACTUALLY touch once the picture tiles:
 * canvas `x=0` sits next to `x=w-1`, so the LEFT border blends against a MIRRORED copy of
 * the RIGHT edge (and the right border against the left; same reasoning on Y). Mirroring
 * — rather than a plain offset copy — is what makes the two sides agree at the join: each
 * strip's OWN border pixel (the one that will genuinely neighbour this border) lands at
 * the outer edge, and the blend fades from there toward the middle.
 *
 * CONTRACT (asserted by the caller's test): every destination rectangle overlaps the
 * canvas, i.e. `dx < w && dx + sw > 0` (and the Y equivalent). This is the exact property
 * the previous, broken implementation violated — it shifted each strip by a full
 * width/height, landing it entirely off-canvas with zero overlap and painting nothing.
 */
export function seamlessStrips(w: number, h: number, width: number): SeamlessStrip[] {
  if (!(w > 0) || !(h > 0) || !(width > 0)) return []
  const bx = Math.max(1, Math.min(w, Math.round(w * width)))
  const by = Math.max(1, Math.min(h, Math.round(h * width)))
  return [
    // Left border, blended against the mirrored right edge.
    { sx: w - bx, sy: 0, sw: bx, sh: h, dx: 0, dy: 0, mirror: 'x' },
    // Right border, blended against the mirrored left edge.
    { sx: 0, sy: 0, sw: bx, sh: h, dx: w - bx, dy: 0, mirror: 'x' },
    // Top border, blended against the mirrored bottom edge.
    { sx: 0, sy: h - by, sw: w, sh: by, dx: 0, dy: 0, mirror: 'y' },
    // Bottom border, blended against the mirrored top edge.
    { sx: 0, sy: 0, sw: w, sh: by, dx: 0, dy: h - by, mirror: 'y' },
  ]
}

/**
 * Cross-fade a picture's opposite edges into each other so the file tiles without a seam.
 *
 * For each border strip from `seamlessStrips`, draw a MIRRORED copy of the opposite edge
 * (so `x=0` is paired with what will actually sit at `x=w-1` once tiled) under a gradient
 * alpha that runs from 0.5 at the outer edge to 0 toward the middle. At the join both
 * sides converge on the same average, which is what makes the edges match.
 *
 * Returns null with no DOM (the node unit environment) rather than throwing, matching the
 * degradation the matcap and shader-field paths in materials.ts already use.
 */
export function seamlessCanvas(
  src: CanvasImageSource, w: number, h: number, width: number,
): HTMLCanvasElement | null {
  if (!hasDOM || !src) return null
  const strips = seamlessStrips(w, h, width)
  if (strips.length === 0) return null
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(src, 0, 0, w, h)

  for (const s of strips) {
    const mask = document.createElement('canvas')
    mask.width = s.sw
    mask.height = s.sh
    const mc = mask.getContext('2d')
    if (!mc) continue

    // Mirror the opposite-edge strip so ITS border pixel — the one that will actually
    // neighbour this border once tiled — lands at the outer edge of the mask.
    if (s.mirror === 'x') {
      mc.translate(s.sw, 0)
      mc.scale(-1, 1)
    } else {
      mc.translate(0, s.sh)
      mc.scale(1, -1)
    }
    mc.drawImage(src, s.sx, s.sy, s.sw, s.sh, 0, 0, s.sw, s.sh)
    mc.setTransform(1, 0, 0, 1, 0, 0)

    // Fade from 0.5 at the outer edge (`dx`/`dy` === 0 means this strip sits at the near
    // edge, so the outer edge is local 0; otherwise it sits at the far edge, local sw/sh)
    // down to 0 toward the middle.
    mc.globalCompositeOperation = 'destination-in'
    const grad = s.mirror === 'x'
      ? (s.dx === 0
          ? mc.createLinearGradient(0, 0, s.sw, 0)
          : mc.createLinearGradient(s.sw, 0, 0, 0))
      : (s.dy === 0
          ? mc.createLinearGradient(0, 0, 0, s.sh)
          : mc.createLinearGradient(0, s.sh, 0, 0))
    grad.addColorStop(0, 'rgba(0,0,0,0.5)')
    grad.addColorStop(1, 'rgba(0,0,0,0)')
    mc.fillStyle = grad
    mc.fillRect(0, 0, s.sw, s.sh)

    ctx.drawImage(mask, s.dx, s.dy)
  }
  return c
}
