import type { FrameFit } from './types'

/** Where the artboard lands inside a box. `fit` keeps the whole Frame visible; `fill` covers the
 *  box and crops the overflow evenly (centred — no focal point in v1). `scale` maps artboard
 *  units to box pixels. Pure; used by the adapter every paint. */
export function fitRect(
  box: { w: number; h: number }, art: { w: number; h: number }, mode: FrameFit,
): { x: number; y: number; w: number; h: number; scale: number } {
  const sx = box.w / art.w
  const sy = box.h / art.h
  const scale = mode === 'fill' ? Math.max(sx, sy) : Math.min(sx, sy)
  const w = art.w * scale
  const h = art.h * scale
  return { x: (box.w - w) / 2, y: (box.h - h) / 2, w, h, scale }
}
