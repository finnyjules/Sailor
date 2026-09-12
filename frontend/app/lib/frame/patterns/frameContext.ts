import type { PatternContext, PosterLayerView, Measure, FrameElements } from './types'
import { inferElements } from './hierarchy'
import { readGrid } from '~/lib/frame/gridConfig'
import { resolveGrid } from '~/lib/frame/grid'
import type { LocalLayer } from '~/composables/useCompositorLayers'

const SHAPE_KINDS = new Set(['rect', 'ellipse', 'polygon', 'star', 'path'])

/** Read a frame's layers into the engine's read-only view. Non-poster kinds
 *  (brush/line/deal/scatter) are dropped; a wired layer is treated as an image element. */
export function posterLayerViews(props: Record<string, unknown> | undefined): PosterLayerView[] {
  const layers = (props?.sailor_localLayers as LocalLayer[] | undefined) ?? []
  const out: PosterLayerView[] = []
  for (const l of layers) {
    if (l.kind === 'text') out.push({ id: l.id, kind: 'text', text: (l as any).text, fontSize: (l as any).fontSize })
    else if (l.kind === 'image') out.push({ id: l.id, kind: 'image' })
    else if (l.kind === 'wired') out.push({ id: l.id, kind: 'image' })   // a wired photo is an image element the engine can arrange
    else if (SHAPE_KINDS.has(l.kind)) out.push({ id: l.id, kind: 'shape', shapeId: (l as any).shapeId ?? 'circle' })
  }
  return out
}

/** Assemble a PatternContext from a frame node's properties. `measure` is injected
 *  (the app passes a canvas-backed one; tests pass a stub). */
export function buildFrameContext(
  props: Record<string, unknown> | undefined,
  frameW: number,
  frameH: number,
  measure: Measure,
  elements?: FrameElements,
): PatternContext {
  const g = readGrid(props)
  const grid = g.mode !== 'off' ? resolveGrid(g, frameW, frameH) : null
  const els = elements ?? inferElements(posterLayerViews(props))
  const seed = (props?.sailor_posterState as { seed?: number } | undefined)?.seed ?? 1
  const margin = Math.min(Math.max(g.margin, 0), 0.45)
  return { frame: { w: frameW, h: frameH }, grid, margin, elements: els, seed, measure }
}
