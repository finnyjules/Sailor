import type * as THREE from 'three'
import type { PileTokenSpec } from './tokens'
import type { Fill } from '../fillTile'
import { fillPrimary, fillTextColor } from '../fills'
import { shapeById } from '~/lib/shapes/catalog'
import { drawShape } from '~/lib/shapes/path2d'

const TEX_H = 128 // token texture height in px; width follows the spec aspect

export interface TokenFont { family: string; weight: number }

function canvasAvailable(): boolean {
  return typeof document !== 'undefined' && typeof document.createElement === 'function'
}

/** A token's own artwork (word / letter / shape) on a transparent canvas texture.
 *  Headless (unit tests, no DOM): a 1×1 opaque texture so buildScene still works. */
export function renderTokenTexture(three: typeof THREE, spec: PileTokenSpec, fill: Fill, font: TokenFont): THREE.Texture {
  if (!canvasAvailable()) {
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
  if (spec.kind === 'shape' && spec.shapeId) {
    const shape = shapeById(spec.shapeId)
    if (shape) {
      const color = `#${fillPrimary(three, fill).getHexString()}`
      drawShape(ctx, shape, { x: 0, y: 0, w, h: TEX_H, fill: color })
    }
  } else if (spec.text) {
    ctx.fillStyle = `#${fillTextColor(three, fill).getHexString()}`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    // Honour the chosen family + weight (the Studio preloads it before build); a
    // quoted family with a fallback stack keeps unloaded fonts from breaking.
    ctx.font = `${font.weight} ${Math.round(TEX_H * 0.8)}px "${font.family}", system-ui, sans-serif`
    ctx.fillText(spec.text, w / 2, TEX_H / 2 + TEX_H * 0.02)
  }
  const tex = new three.CanvasTexture(canvas)
  tex.needsUpdate = true
  return tex
}

/** A token as a Group positioned at the origin (the effect places it per-frame):
 *  the token artwork plane, plus an optional box (filled quad / outline) behind it.
 *  Created textures are stashed on `group.userData.tex` for disposal on rebuild. */
export function makeTokenMesh(
  three: typeof THREE, spec: PileTokenSpec, fill: Fill, boxStyle: string, paddingFrac: number, _radiusFrac: number, font: TokenFont,
): THREE.Object3D {
  const group = new three.Group()
  const texs: THREE.Texture[] = []
  const w = Math.max(0.05, spec.w), h = Math.max(0.05, spec.h)

  if (spec.kind !== 'shape' && boxStyle === 'filled') {
    const boxMat = new three.MeshBasicMaterial({ color: fillPrimary(three, fill) })
    group.add(new three.Mesh(new three.PlaneGeometry(w, h), boxMat))
  } else if (spec.kind !== 'shape' && boxStyle === 'outline') {
    const edges = new three.LineSegments(
      new three.EdgesGeometry(new three.PlaneGeometry(w, h)),
      new three.LineBasicMaterial({ color: fillPrimary(three, fill) }),
    )
    group.add(edges)
  }

  const pad = spec.kind === 'shape' ? 1 : (1 - 2 * Math.min(0.4, Math.max(0, paddingFrac)))
  const tex = renderTokenTexture(three, spec, fill, font)
  texs.push(tex)
  const tokenMat = new three.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
  const token = new three.Mesh(new three.PlaneGeometry(w * pad, h * pad), tokenMat)
  token.position.z = 0.01 // sit above the box
  group.add(token)

  group.userData.tex = texs
  return group
}
