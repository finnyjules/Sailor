/**
 * 3D models (step 3, R3.9, family `gen-3d`): what the runner
 * (server/runner/generators/gen3d.ts), the rule rows (./eligibility.ts), the
 * request rules (server/runner/requestRules.ts) and the price module
 * (shared/pricing/paidSettings.ts) all read about three classes of
 * comfy_api_nodes/nodes_replicate.py:
 *
 *  - Generate3DNode ("Generate a 3D model", :5075) and its hidden twin
 *    Hunyuan3DRemoteNode ("Hunyuan3D 2", :1843): Replicate
 *    `tencent/hunyuan3d-2`, one call;
 *  - Hunyuan3DMultiViewNode ("Multi-View → 3D", :1901): one call on the
 *    engine its `engine` names: `firtoz/trellis`, `hyper3d/rodin` or
 *    `tencent/hunyuan3d-2mv`.
 *
 * Each answers one 3D file (a GLB), which the runner saves as the user's own
 * asset and hands on by its Sailor address (spec ruling 1, ruling (k)).
 * Pure; relative imports only.
 */
import { isLink } from './graph'

export const HUNYUAN3D_SLUG = 'tencent/hunyuan3d-2'
export const HUNYUAN3D_MV_SLUG = 'tencent/hunyuan3d-2mv'
export const RODIN_SLUG = 'hyper3d/rodin'
export const TRELLIS_SLUG = 'firtoz/trellis'

/** The three classes, in the order the task lists them. */
export const GEN_3D_CLASSES = ['Generate3DNode', 'Hunyuan3DRemoteNode', 'Hunyuan3DMultiViewNode'] as const
export type Gen3dClass = typeof GEN_3D_CLASSES[number]
/** The two classes that send one picture to Hunyuan3D 2 (the visible node and its twin, ruling (q)). */
export const HUNYUAN3D_CLASSES: readonly Gen3dClass[] = ['Generate3DNode', 'Hunyuan3DRemoteNode']
export const MULTI_VIEW_CLASS = 'Hunyuan3DMultiViewNode'

export function isGen3dClass(classType: unknown): classType is Gen3dClass {
  return typeof classType === 'string' && (GEN_3D_CLASSES as readonly string[]).includes(classType)
}

/** Generate a 3D model's one-option model picker (its Python ignores the value). */
export const GENERATE_3D_MODELS = ['Hunyuan3D 2'] as const

/** Multi-View's engines (the node's options, in order) and the slug each calls. */
export const MULTI_VIEW_ENGINES = ['TRELLIS (textured)', 'Rodin (textured · quad mesh)', 'Hunyuan3D-2mv (geometry only)'] as const
export type MultiViewEngine = typeof MULTI_VIEW_ENGINES[number]
export const MULTI_VIEW_DEFAULT_ENGINE: MultiViewEngine = 'TRELLIS (textured)'

/**
 * The slug an engine setting calls, as Python branches on it: a name
 * starting "Hunyuan" is Hunyuan3D-2mv, one starting "Rodin" is Rodin, and
 * anything else TRELLIS (Python's default branch).
 */
export function multiViewSlug(engine: string): string {
  if (engine.startsWith('Hunyuan')) return HUNYUAN3D_MV_SLUG
  if (engine.startsWith('Rodin')) return RODIN_SLUG
  return TRELLIS_SLUG
}

/** Every slug Multi-View can call. */
export const MULTI_VIEW_SLUGS: readonly string[] = [TRELLIS_SLUG, RODIN_SLUG, HUNYUAN3D_MV_SLUG]

/** The slugs an engine setting can mean: the one it names, or, wired, every one (a price never guesses low). */
export function multiViewSlugsOf(engine: unknown): string[] {
  if (isLink(engine)) return [...MULTI_VIEW_SLUGS]
  return [multiViewSlug(typeof engine === 'string' ? engine : MULTI_VIEW_DEFAULT_ENGINE)]
}

/** Rodin's detail tiers (`rodin_quality`'s options, in order). */
export const RODIN_QUALITIES = ['medium', 'high', 'low', 'extra-low'] as const
/** Rodin's custom polygon count bounds (0 = automatic). */
export const RODIN_POLY_MAX = 300_000
/** The multi-view picture inputs, front first (the order Python lists them in `images`). */
export const MULTI_VIEW_PICTURES = ['front_image', 'back_image', 'left_image', 'right_image'] as const

/** The widget bounds the three nodes declare (IO.Int / IO.Float min and max). */
export const GEN_3D_STEPS = { min: 20, max: 100 } as const
export const GEN_3D_GUIDANCE = { min: 1, max: 20 } as const
export const GEN_3D_OCTREE = { min: 128, max: 512 } as const
export const GEN_3D_SEED_MAX = 0xFFFFFFFF

// ── Hunyuan3D 2's published input (replicate.com/tencent/hunyuan3d-2, read 2026-09-27) ──

/**
 * The most steps `tencent/hunyuan3d-2` takes (its schema: `steps` 20–50),
 * where the node offers 20–100. Python sends the node's value, which the
 * service refuses; the runner refuses it before the hold (rule 9).
 */
export const HUNYUAN3D_MAX_STEPS = 50
/** The mesh resolutions `tencent/hunyuan3d-2` takes (its schema's enum), where the node offers 128–512. */
export const HUNYUAN3D_OCTREES = [256, 384, 512] as const

export const HUNYUAN3D_TOO_MANY_STEPS = `Making a 3D model from one picture takes at most ${HUNYUAN3D_MAX_STEPS} steps. Lower the steps.`
export const HUNYUAN3D_OCTREE_REFUSED = 'Making a 3D model from one picture takes a mesh resolution of 256, 384 or 512.'

/** int() of a typed INT widget, or null when it isn't a plain number (the rule row leaves that to the engine). */
function intOf(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v)) return Number.parseInt(v, 10)
  return null
}

/**
 * What the runner refuses in a 3D node before the hold, from the prompt as
 * sent, or null: Generate a 3D model (and its twin) with a setting
 * `tencent/hunyuan3d-2` refuses (more than 50 steps; a mesh resolution other
 * than 256, 384 or 512). Python sends them and the service refuses the call.
 * A wired setting is left alone (the rule row sends a wired widget to the engine).
 */
export function gen3dRequestProblem(classType: string, inputs: Record<string, unknown>): { input: string, message: string } | null {
  if (!(HUNYUAN3D_CLASSES as readonly string[]).includes(classType)) return null
  const steps = inputs.steps === undefined ? 50 : intOf(inputs.steps)
  if (steps !== null && steps > HUNYUAN3D_MAX_STEPS) return { input: 'steps', message: HUNYUAN3D_TOO_MANY_STEPS }
  const octree = inputs.octree_resolution === undefined ? 256 : intOf(inputs.octree_resolution)
  if (octree !== null && !(HUNYUAN3D_OCTREES as readonly number[]).includes(octree)) return { input: 'octree_resolution', message: HUNYUAN3D_OCTREE_REFUSED }
  return null
}
