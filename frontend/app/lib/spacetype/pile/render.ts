import type * as THREE from 'three'
import type { PileTokenSpec } from './tokens'
import type { Fill } from '../fillTile'
import { fillPrimary, fillTextColor, fillTexture, fillTiling } from '../fills'
import { shapeById } from '~/lib/shapes/catalog'
import { drawShape } from '~/lib/shapes/path2d'

const TEX_H = 128 // token texture height in px; width follows the spec aspect

export interface TokenFont { family: string; weight: number }

function canvasAvailable(): boolean {
  return typeof document !== 'undefined' && typeof document.createElement === 'function'
}

/**
 * The fill's STYLE as a texture (gradient / ombre / grid / noise / checkerboard / stripes /
 * shapes / paper / qr — and shader fills degraded to a static tile). Solid fills return null
 * (paint with fillPrimary instead). Cloned so per-token wrap/tiling/colorSpace never mutate the
 * shared fill cache; stash the clone for disposal. Null when headless or on any failure.
 */
function fillMap(three: typeof THREE, fill: Fill): THREE.Texture | null {
  if (!canvasAvailable()) return null
  try {
    const base = fillTexture(three, fill) // null for solid
    if (!base) return null
    const tex = base.clone()
    tex.colorSpace = three.SRGBColorSpace // used as a colour `map` → decode sRGB→linear
    const tiling = fillTiling(fill)
    if (tiling !== 1) { tex.wrapS = tex.wrapT = three.RepeatWrapping; tex.repeat.set(tiling, tiling) }
    tex.needsUpdate = true
    return tex
  } catch { return null }
}

/** The word/letter glyph in the fill's textColor on a transparent canvas. Headless → 1×1. */
export function renderTokenTexture(three: typeof THREE, spec: PileTokenSpec, fill: Fill, font: TokenFont): THREE.Texture {
  if (!canvasAvailable() || !spec.text) {
    const tex = new three.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, three.RGBAFormat)
    tex.needsUpdate = true
    return tex
  }
  const aspect = Math.max(0.05, spec.w / Math.max(0.05, spec.h))
  const w = Math.max(2, Math.round(TEX_H * aspect))
  const canvas = document.createElement('canvas')
  canvas.width = w; canvas.height = TEX_H
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, w, TEX_H)
  ctx.fillStyle = `#${fillTextColor(three, fill).getHexString()}`
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  // Honour the chosen family + weight (the Studio preloads it before build); a quoted family
  // with a fallback stack keeps unloaded fonts from breaking.
  ctx.font = `${font.weight} ${Math.round(TEX_H * 0.8)}px "${font.family}", system-ui, sans-serif`
  ctx.fillText(spec.text, w / 2, TEX_H / 2 + TEX_H * 0.02)
  const tex = new three.CanvasTexture(canvas)
  tex.colorSpace = three.SRGBColorSpace
  tex.needsUpdate = true
  return tex
}

/** A white shape silhouette on transparent — used as an alphaMap so the fill texture shows
 *  through in the shape. Headless → 1×1 white (a plain square). */
function renderShapeAlpha(three: typeof THREE, spec: PileTokenSpec): THREE.Texture {
  const shape = spec.shapeId ? shapeById(spec.shapeId) : undefined
  if (!canvasAvailable() || !shape) {
    const tex = new three.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, three.RGBAFormat)
    tex.needsUpdate = true
    return tex
  }
  const aspect = Math.max(0.05, spec.w / Math.max(0.05, spec.h))
  const w = Math.max(2, Math.round(TEX_H * aspect))
  const canvas = document.createElement('canvas')
  canvas.width = w; canvas.height = TEX_H
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, w, TEX_H)
  drawShape(ctx, shape, { x: 0, y: 0, w, h: TEX_H, fill: '#ffffff' })
  const tex = new three.CanvasTexture(canvas)
  tex.needsUpdate = true
  return tex
}

/** A token as a Group positioned at the origin (the effect places it per-frame): for text a box
 *  (filled with the fill's style / outlined) behind the glyph; for a shape, the fill painted in
 *  the shape's silhouette. Created textures are stashed on `group.userData.tex` for disposal. */
export function makeTokenMesh(
  three: typeof THREE, spec: PileTokenSpec, fill: Fill, boxStyle: string, paddingFrac: number, _radiusFrac: number, font: TokenFont,
): THREE.Object3D {
  const group = new three.Group()
  const texs: THREE.Texture[] = []
  const w = Math.max(0.05, spec.w), h = Math.max(0.05, spec.h)

  if (spec.kind === 'shape') {
    // One quad: the fill's style (or solid colour) clipped to the shape silhouette.
    const alpha = renderShapeAlpha(three, spec); texs.push(alpha)
    const map = fillMap(three, fill); if (map) texs.push(map)
    const mat = new three.MeshBasicMaterial({ alphaMap: alpha, transparent: true, alphaTest: 0.5, depthWrite: false })
    if (map) mat.map = map; else mat.color = fillPrimary(three, fill)
    group.add(new three.Mesh(new three.PlaneGeometry(w, h), mat))
    group.userData.tex = texs
    return group
  }

  // Text: the box behind (filled with the fill's style, or an outline in the fill colour).
  if (boxStyle === 'filled') {
    const map = fillMap(three, fill)
    const boxMat = map ? new three.MeshBasicMaterial({ map }) : new three.MeshBasicMaterial({ color: fillPrimary(three, fill) })
    if (map) texs.push(map)
    group.add(new three.Mesh(new three.PlaneGeometry(w, h), boxMat))
  } else if (boxStyle === 'outline') {
    const edges = new three.LineSegments(
      new three.EdgesGeometry(new three.PlaneGeometry(w, h)),
      new three.LineBasicMaterial({ color: fillPrimary(three, fill) }),
    )
    group.add(edges)
  }

  const pad = 1 - 2 * Math.min(0.4, Math.max(0, paddingFrac))
  const glyph = renderTokenTexture(three, spec, fill, font); texs.push(glyph)
  const glyphMat = new three.MeshBasicMaterial({ map: glyph, transparent: true, depthWrite: false })
  const token = new three.Mesh(new three.PlaneGeometry(w * pad, h * pad), glyphMat)
  token.position.z = 0.01 // sit above the box
  group.add(token)

  group.userData.tex = texs
  return group
}
