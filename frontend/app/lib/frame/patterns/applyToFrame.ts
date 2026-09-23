import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { ResolvedPalette } from './palette'
import type { FrameElements, PatternPlacement } from './types'
import { planLayout, applyLayoutToFrame } from './kit/plan'
import type { LayoutPlanArgs } from './kit/plan'
import { DEFAULT_CHOICE } from './kit/vary'
import type { Choice } from './kit/vary'
import { ancestorsOf, type LayerGroup } from '~/lib/compositor/layerGroups'

// The Layout tab's engine is the layout kit (`kit/plan.ts`, `layouts/catalog.ts`). These are the
// long-standing entry points, kept by name and signature so every importer keeps working; they
// run the kit with `DEFAULT_CHOICE` unless a `choice` is given.

/** What a Frame remembers about the layout last applied (`sailor_posterState`). Frames saved
 *  before the kit have no `choice`; they read as the default choice. `seed` is the sheet's seed
 *  (the Layout tab's "Another" counter), stored as given. */
export interface PosterState { patternId: string; seed: number; shapeMode?: FrameElements['shapeMode']; imageMode?: boolean; choice?: Choice }

export interface PlanArgs {
  props: Record<string, unknown> | undefined
  frameW: number
  frameH: number
  /** A layout id from `layouts/catalog.ts` (the old pattern ids are all kept). */
  patternId: string
  /** The sheet's seed. The kit has no free seed (its randomness follows from the layout and the
   *  choice), so this is only remembered in `posterState`; it does not change the plan. */
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
  /** Old-engine placement from the old sheet. The kit cannot take a precomputed placement, so
   *  this is ignored: the plan always comes from the kit, the same pipeline apply runs. */
  placement?: PatternPlacement
  /** Which variation of the layout to run. Default: `DEFAULT_CHOICE`. */
  choice?: Choice
}

export interface ApplyArgs extends PlanArgs {
  /** `writeGroups` is required: a pattern clears the pins of the groups it moves, and an editor
   *  without it would silently keep them. */
  editor: { recordHistory(): void; commit(next: LocalLayer[]): void; writeOrder(order: string[]): void; writeGroups(next: LayerGroup[]): void }
}

/** What an apply would commit: the next layers, the next draw order, and the state to remember. */
export interface PatternPlan { layers: LocalLayer[]; order: string[]; posterState: PosterState; did: string }

function kitArgs(args: PlanArgs): LayoutPlanArgs {
  return {
    props: args.props, frameW: args.frameW, frameH: args.frameH,
    layoutId: args.patternId, choice: args.choice ?? DEFAULT_CHOICE,
    palette: args.palette, recolour: args.recolour, connectedSlots: args.connectedSlots,
    imageMode: args.imageMode, shapeMode: args.shapeMode,
  }
}

function posterStateFor(args: PlanArgs, choice: Choice): PosterState {
  return { patternId: args.patternId, seed: args.seed, shapeMode: args.shapeMode, imageMode: args.imageMode, choice: { ...choice } }
}

/** Run a layout on a frame and return the plan. Pure: nothing is written. Null when the id is
 *  unknown, the frame has no title, the layout does not fit the frame, or the kit's checker
 *  finds issues (apply would refuse those, so they are never offered). */
export function planPattern(args: PlanArgs): PatternPlan | null {
  const plan = planLayout(kitArgs(args))
  if (!plan || plan.issues.length) return null
  return { layers: plan.layers, order: plan.order, did: plan.did, posterState: posterStateFor(args, plan.posterState.choice) }
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

/** Apply a layout as ONE undo step: history → layers → groups → order (the kit's
 *  `applyLayoutToFrame`). `ok: false` and nothing written when `planPattern` would be null. */
export function applyPatternToFrame(args: ApplyArgs): { ok: boolean; posterState?: PosterState } {
  const out = applyLayoutToFrame({ ...kitArgs(args), editor: args.editor })
  if (!out.ok || !out.posterState) return { ok: false }
  return { ok: true, posterState: posterStateFor(args, out.posterState.choice) }
}
