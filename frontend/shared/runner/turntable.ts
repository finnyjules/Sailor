/**
 * Turntable (step 3, R3.16, family `turntable`): what the runner
 * (server/runner/generators/turntable.ts), the rule row (./eligibility.ts)
 * and the price module (shared/pricing/paidSettings.ts) all read about
 * comfy_extras/nodes_turntable.py's TurntableNode (:23-99):
 *
 *  - front only (path A, :70-78): one Luma Ray 2 720p call on Replicate
 *    through the video table, `{prompt, aspect_ratio: "1:1", duration: 5,
 *    loop: true, start_image_url}`;
 *  - right, back or left views wired (path B, :80-97): one Seedance 2.0 call
 *    (fal, first frame → last frame) per arc `planSegments` plans, stitched
 *    with PyAV. The runner takes this path since R3.17 (a pipeline of the
 *    arcs, stitched with Sailor's own video tools), while `media-video` is on
 *    too; its price (ruling (b)) is the calls it makes, on both paths.
 *
 * Pure; relative imports only.
 */

export const TURNTABLE_CLASS = 'TurntableNode'

/** The node's `direction` options (define_schema), default "left". */
export const TURNTABLE_DIRECTIONS = ['left', 'right'] as const
export const TURNTABLE_DEFAULT_DIRECTION = 'left'

/** The optional extra views, each input with the view it names (execute :62-68). */
export const TURNTABLE_VIEW_INPUTS = { right_reference: 'right', back_reference: 'back', left_reference: 'left' } as const
export type TurntableViewInput = keyof typeof TURNTABLE_VIEW_INPUTS
export type TurntableView = 'front' | typeof TURNTABLE_VIEW_INPUTS[TurntableViewInput]

/** Path A's model, and path B's (`_VIDEO_MODELS_BY_ID` ids, the video rate cards' keys). */
export const TURNTABLE_FRONT_MODEL = 'luma-ray-2-720p'
export const TURNTABLE_VIEWS_MODEL = 'seedance-2.0'
/** Both paths' `build_input(…, "1:1", 5, 0, …)`: the ratio, the seconds and the seed sent. */
export const TURNTABLE_ASPECT_RATIO = '1:1'
export const TURNTABLE_SECONDS = 5

/**
 * The extra views a node's inputs as sent carry: Python's `x is not None`
 * for each (a wired view counts: the dearest plan, whatever it brings at run
 * time), in the order the inputs are listed.
 */
export function turntableViews(inputs: Record<string, unknown>): Exclude<TurntableView, 'front'>[] {
  return (Object.keys(TURNTABLE_VIEW_INPUTS) as TurntableViewInput[])
    .filter(name => inputs[name] !== undefined && inputs[name] !== null)
    .map(name => TURNTABLE_VIEW_INPUTS[name])
}

const ORDER: readonly TurntableView[] = ['front', 'right', 'back', 'left']
const ANGLE: Readonly<Record<TurntableView, number>> = { front: 0, right: 90, back: 180, left: 270 }

/** Python's `a % 360` (the sign of the divisor). */
const mod360 = (a: number) => ((a % 360) + 360) % 360

/**
 * `_turntable_plan.plan_segments(extra_views, direction)` (:10-28): the
 * ordered `[start_view, end_view, degrees]` arcs that walk the views around
 * the circle and close back on the front. `extraViews` is a subset of
 * right/back/left (anything else is ignored, as Python's `v in extra` over
 * `_ORDER`); any direction but "left" walks the other way, as Python's `else`.
 */
export function planSegments(extraViews: Iterable<string>, direction: string): [TurntableView, TurntableView, number][] {
  const extra = new Set(extraViews)
  const views = ORDER.filter(v => v === 'front' || extra.has(v))
  if (views.length === 1) return [['front', 'front', 360]]
  const seq = direction === 'left' ? [...views] : [views[0]!, ...views.slice(1).reverse()]
  const n = seq.length
  const segs: [TurntableView, TurntableView, number][] = []
  for (let i = 0; i < n; i++) {
    const a = seq[i]!
    const b = seq[(i + 1) % n]!
    const deg = direction === 'left' ? mod360(ANGLE[b] - ANGLE[a]) : mod360(ANGLE[a] - ANGLE[b])
    segs.push([a, b, deg])
  }
  return segs
}
