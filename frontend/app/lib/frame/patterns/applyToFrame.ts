import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { ResolvedPalette } from './palette'
import type { FrameElements } from './types'
import { planLayout, applyLayoutToFrame } from './kit/plan'
import type { LayoutEditor, LayoutPlanArgs } from './kit/plan'
import { DEFAULT_CHOICE } from './kit/vary'
import type { Choice } from './kit/vary'

// Plan-and-apply by layout id over the layout kit (`kit/plan.ts`, `layouts/catalog.ts`), in the
// long-standing `planPattern` / `applyPatternToFrame` shape. They run the kit with
// `DEFAULT_CHOICE` unless a `choice` is given. The Layout tab itself drives the kit directly
// (`useLayoutVary`); `PosterState` is the shape it remembers.

/** What a Frame remembers about the layout last applied (`sailor_posterState`). Frames saved
 *  before the kit have no `choice`; they read as the default choice. `seed` is whatever the
 *  writer stored (the Layout tab stores the kit's seed for the choice). The Layout tab also keeps
 *  its picker state here: `shapeMode`, `imageMode`, `palette`, and the variation `index`. */
export interface PosterState {
  patternId: string; seed: number; shapeMode?: FrameElements['shapeMode']; imageMode?: boolean; choice?: Choice
  palette?: string[]; index?: number
}

export interface PlanArgs {
  props: Record<string, unknown> | undefined
  frameW: number
  frameH: number
  /** A layout id from `layouts/catalog.ts` (the old pattern ids are all kept). */
  patternId: string
  /** A caller's seed. The kit has no free seed (its randomness follows from the layout and the
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
  /** Which variation of the layout to run. Default: `DEFAULT_CHOICE`. */
  choice?: Choice
}

export interface ApplyArgs extends PlanArgs {
  /** `writeGroups` is required: a pattern clears the pins of the groups it moves, and an editor
   *  without it would silently keep them. */
  editor: LayoutEditor
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

/** Apply a layout as ONE undo step: history → layers → groups → order (the kit's
 *  `applyLayoutToFrame`). `ok: false` and nothing written when `planPattern` would be null. */
export function applyPatternToFrame(args: ApplyArgs): { ok: boolean; posterState?: PosterState } {
  const out = applyLayoutToFrame({ ...kitArgs(args), editor: args.editor })
  if (!out.ok || !out.posterState) return { ok: false }
  return { ok: true, posterState: posterStateFor(args, out.posterState.choice) }
}
