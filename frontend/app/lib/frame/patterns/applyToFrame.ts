import type { LocalLayer, TextLayer } from '~/composables/useCompositorLayers'
import type { ResolvedPalette } from './palette'
import type { FrameElements, Pattern, PatternPlacement } from './types'
import { buildFrameContext, posterLayerViews } from './frameContext'
import { inferElements } from './hierarchy'
import { makeFrameMeasure, titleMeasureFrom } from './frameMeasure'
import { PATTERNS } from './catalog'
import { applyPlacement } from './apply'
import { insertFromOps } from './insert'
import { nextOrderFor } from './order'
import { framePresentKeys } from '~/lib/compositor/frameStack'
import { ancestorsOf, type LayerGroup } from '~/lib/compositor/layerGroups'

export interface PosterState { patternId: string; seed: number; shapeMode?: FrameElements['shapeMode']; imageMode?: boolean }

export interface PlanArgs {
  props: Record<string, unknown> | undefined
  frameW: number
  frameH: number
  patternId: string
  seed: number
  palette: ResolvedPalette
  /** A library shape to use when the frame has no shape layer (the picker's family/id choice). */
  shapeMode?: FrameElements['shapeMode']
  /** Show image patterns with a stand-in when the frame has no image layer. */
  imageMode?: boolean
  /** Wired image slots connected on the node (for the present-keys reconcile). */
  connectedSlots: number[]
  /** Write colours from the role palette. Off by default: a layout changes no
   *  colour; the palette picker turns it on. */
  recolour?: boolean
  /** A pre-computed placement to use verbatim; when supplied, skips running the pattern. */
  placement?: PatternPlacement
}

export interface ApplyArgs extends PlanArgs {
  /** `writeGroups` is required: a pattern clears the pins of the groups it moves, and an editor
   *  without it would silently keep them. */
  editor: { recordHistory(): void; commit(next: LocalLayer[]): void; writeOrder(order: string[]): void; writeGroups(next: LayerGroup[]): void }
}

/** What an apply would commit: the next layers, the next draw order, and the state to remember. */
export interface PatternPlan { layers: LocalLayer[]; order: string[]; posterState: PosterState; did: string }

/** Build the measure + context and run the pattern — the fall-back when no
 *  precomputed placement is supplied. The title measured is the one the layer
 *  hierarchy inference names (largest fontSize), not the first text layer in
 *  array order, so the width oracle matches what the engine treats as the title. */
function runPattern(pattern: Pattern, args: PlanArgs, layers: LocalLayer[], elements: FrameElements): PatternPlacement {
  const titleLayer = layers.find(l => l.id === elements.title?.id && l.kind === 'text') as TextLayer | undefined
  const tm = titleLayer ? titleMeasureFrom(titleLayer) : { family: 'Inter', weight: 700, transform: (t: string) => t }
  const measure = makeFrameMeasure(tm.family, tm.weight, undefined, tm.transform)
  const ctx = buildFrameContext(args.props, args.frameW, args.frameH, measure, elements)
  ctx.seed = args.seed
  return pattern.place(ctx)
}

/** Run a pattern on a frame and return the plan. Pure: nothing is written. */
export function planPattern(args: PlanArgs): PatternPlan | null {
  const pattern = PATTERNS.find(p => p.id === args.patternId)
  if (!pattern) return null
  const layers = ((args.props?.sailor_localLayers as LocalLayer[] | undefined) ?? [])
  const elements = inferElements(posterLayerViews(args.props))
  if (args.shapeMode !== undefined) elements.shapeMode = args.shapeMode
  if (args.imageMode !== undefined) elements.imageMode = args.imageMode
  // Reuse the placement the sheet already computed; only fall back to running the
  // pattern (and building the measure/context it needs) when none was supplied.
  const placement = args.placement ?? runPattern(pattern, args, layers, elements)
  // insert any library shape the pattern wanted but the frame lacks, then patch
  const ins = insertFromOps(layers, placement.ops, args.palette, `poster-${args.patternId}-${args.seed}`)
  const next = applyPlacement(ins.layers, { ...placement, ops: ins.ops }, elements, args.palette, { recolour: args.recolour ?? false })
  // draw order: reconcile the saved order against what is present, then honour z
  const saved = (args.props?.sailor_stackOrder as string[] | undefined) ?? []
  const present = framePresentKeys(args.connectedSlots, next)
  const order = nextOrderFor(saved, present, ins.ops, elements, ins.inserted)
  return { layers: next, order, did: placement.did, posterState: { patternId: args.patternId, seed: args.seed, shapeMode: args.shapeMode, imageMode: args.imageMode } }
}

const PLACEMENT_KEYS = ['x', 'y', 'w', 'h', 'boxW', 'boxH', 'fontSize', 'rotation', 'scale'] as const
function placementChanged(p: Record<string, unknown>, cur: Record<string, unknown>): boolean {
  return PLACEMENT_KEYS.some(k => p[k] !== cur[k])
}
/** A pattern is a new arrangement: any layer it moved loses its explicit pins (spec, "Editing at a
 *  viewing size"). Unmoved and new layers come back by reference. */
export function clearPinsOfMoved(before: LocalLayer[], after: LocalLayer[]): LocalLayer[] {
  const prev = new Map(before.map(l => [l.id, l as unknown as Record<string, unknown>]))
  return after.map((l) => {
    const p = prev.get(l.id)
    if (!p || !(l as { pins?: unknown }).pins) return l
    if (!placementChanged(p, l as unknown as Record<string, unknown>)) return l
    const { pins: _drop, ...rest } = l as LocalLayer & { pins?: unknown }
    return rest as LocalLayer
  })
}
/** The group side of `clearPinsOfMoved`: every group that encloses a layer the pattern moved (its
 *  own group and each one above it, up to the outermost, where the resolver reads group pins) loses
 *  its pins. An inner group's pins would come back into force if it were ever ungrouped out.
 *  Null when nothing changes. */
export function clearGroupPinsOfMoved(before: LocalLayer[], after: LocalLayer[], groups: LayerGroup[]): LayerGroup[] | null {
  if (!groups.some(g => g.pins)) return null
  const prev = new Map(before.map(l => [l.id, l as unknown as Record<string, unknown>]))
  const hit = new Set<string>()
  for (const l of after) {
    const p = prev.get(l.id)
    if (!p || !l.groupId || !placementChanged(p, l as unknown as Record<string, unknown>)) continue
    hit.add(l.groupId)
    for (const a of ancestorsOf(l.groupId, groups)) hit.add(a)
  }
  let changed = false
  const out = groups.map((g) => {
    if (!g.pins || !hit.has(g.id)) return g
    changed = true
    const { pins: _drop, ...rest } = g
    return rest as LayerGroup
  })
  return changed ? out : null
}

/** Apply a pattern as ONE undo step: history → layers → order. */
export function applyPatternToFrame(args: ApplyArgs): { ok: boolean; posterState?: PosterState } {
  const plan = planPattern(args)
  if (!plan) return { ok: false }
  // the plan was computed from the frame's stored layers (planPattern reads props.sailor_localLayers)
  const before = (args.props?.sailor_localLayers as LocalLayer[] | undefined) ?? []
  const groups = (args.props?.sailor_localGroups as LayerGroup[] | undefined) ?? []
  const nextGroups = clearGroupPinsOfMoved(before, plan.layers, groups)
  args.editor.recordHistory()
  args.editor.commit(clearPinsOfMoved(before, plan.layers))
  if (nextGroups) args.editor.writeGroups(nextGroups)
  args.editor.writeOrder(plan.order)
  return { ok: true, posterState: plan.posterState }
}
