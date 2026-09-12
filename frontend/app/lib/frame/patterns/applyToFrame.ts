import type { LocalLayer, TextLayer } from '~/composables/useCompositorLayers'
import type { ResolvedPalette } from './palette'
import type { FrameElements } from './types'
import { buildFrameContext, posterLayerViews } from './frameContext'
import { inferElements } from './hierarchy'
import { makeFrameMeasure, titleMeasureFrom } from './frameMeasure'
import { PATTERNS } from './catalog'
import { applyPlacement } from './apply'
import { insertFromOps } from './insert'
import { nextOrderFor } from './order'
import { framePresentKeys } from '~/lib/compositor/frameStack'

export interface PosterState { patternId: string; seed: number; shapeMode?: FrameElements['shapeMode'] }

export interface PlanArgs {
  props: Record<string, unknown> | undefined
  frameW: number
  frameH: number
  patternId: string
  seed: number
  palette: ResolvedPalette
  /** A library shape to use when the frame has no shape layer (the picker's family/id choice). */
  shapeMode?: FrameElements['shapeMode']
  /** Wired image slots connected on the node (for the present-keys reconcile). */
  connectedSlots: number[]
  /** Write colours from the role palette. Off by default: a layout changes no
   *  colour; the palette picker turns it on. */
  recolour?: boolean
}

export interface ApplyArgs extends PlanArgs {
  editor: { recordHistory(): void; commit(next: LocalLayer[]): void; writeOrder(order: string[]): void }
}

/** What an apply would commit: the next layers, the next draw order, and the state to remember. */
export interface PatternPlan { layers: LocalLayer[]; order: string[]; posterState: PosterState; did: string }

/** Run a pattern on a frame and return the plan. Pure: nothing is written. */
export function planPattern(args: PlanArgs): PatternPlan | null {
  const pattern = PATTERNS.find(p => p.id === args.patternId)
  if (!pattern) return null
  const layers = ((args.props?.sailor_localLayers as LocalLayer[] | undefined) ?? [])
  // measure with what the title layer really renders with — the same layer the
  // engine's hierarchy inference picks as the title (largest fontSize), not
  // just the first text layer in array order.
  const elements = inferElements(posterLayerViews(args.props))
  const titleId = elements.title?.id
  const titleLayer = layers.find(l => l.id === titleId && l.kind === 'text') as TextLayer | undefined
  const tm = titleLayer ? titleMeasureFrom(titleLayer) : { family: 'Inter', weight: 700, transform: (t: string) => t }
  const measure = makeFrameMeasure(tm.family, tm.weight, undefined, tm.transform)
  const ctx = buildFrameContext(args.props, args.frameW, args.frameH, measure, elements)
  ctx.seed = args.seed
  if (args.shapeMode !== undefined) ctx.elements.shapeMode = args.shapeMode
  const placement = pattern.place(ctx)
  // insert any library shape the pattern wanted but the frame lacks, then patch
  const ins = insertFromOps(layers, placement.ops, args.palette, `poster-${args.patternId}-${args.seed}`)
  const next = applyPlacement(ins.layers, { ...placement, ops: ins.ops }, ctx.elements, args.palette, { recolour: args.recolour ?? false })
  // draw order: reconcile the saved order against what is present, then honour z
  const saved = (args.props?.sailor_stackOrder as string[] | undefined) ?? []
  const present = framePresentKeys(args.connectedSlots, next)
  const order = nextOrderFor(saved, present, ins.ops, ctx.elements, ins.inserted)
  return { layers: next, order, did: placement.did, posterState: { patternId: args.patternId, seed: args.seed, shapeMode: args.shapeMode } }
}

/** Apply a pattern as ONE undo step: history → layers → order. */
export function applyPatternToFrame(args: ApplyArgs): { ok: boolean; posterState?: PosterState } {
  const plan = planPattern(args)
  if (!plan) return { ok: false }
  args.editor.recordHistory()
  args.editor.commit(plan.layers)
  args.editor.writeOrder(plan.order)
  return { ok: true, posterState: plan.posterState }
}
