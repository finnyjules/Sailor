/**
 * 3D models as runner plans (step 3, R3.9, family `gen-3d`): Generate a 3D
 * model and its hidden twin Hunyuan3D 2 (Replicate `tencent/hunyuan3d-2`;
 * the twin takes the visible node's builder, ruling (q)), and Multi-View →
 * 3D (one call on its engine: `firtoz/trellis`, `hyper3d/rodin` or
 * `tencent/hunyuan3d-2mv`). Each answers a 3D file: Python hands on the
 * provider's link (`_first_output_url`, or Trellis's `output.model_file`);
 * the runner downloads it through the safe fetch, the 3D cap and the GLB
 * check, saves Sailor's own copy in the user's output folder and hands on
 * its address as a `glb` value (spec ruling 1, ruling (k)), which the 3D
 * model card, 3D Studio's `glb_url` and a Text card read. Python returns no
 * ui. No backup: fal's Hunyuan3D, Rodin and Trellis have no saved schema.
 *
 *  - A picture is sent as Python sends the first frame of its batch
 *    (`_image_tensor_to_data_url`): the handed-off file of the linked slot
 *    (R3.H's loader view).
 *  - The settings are read as ComfyUI hands them to `execute` after its own
 *    validation (`int()`, `float()`, `str()`, `bool()` of each widget; a
 *    missing optional one is `execute`'s default), then sent as the Python
 *    builds its dict (each builder names its lines).
 *  - Priced per call, by the engine (paidRates.ts).
 */
import { isLink } from '#shared/runner/graph'
import { pyFloatOf, pyIntOf, pyStrip, pyTruthy } from '#shared/runner/pyText'
import {
  HUNYUAN3D_MV_SLUG, HUNYUAN3D_SLUG, MULTI_VIEW_DEFAULT_ENGINE, MULTI_VIEW_PICTURES, RODIN_SLUG, TRELLIS_SLUG, multiViewSlug, type Gen3dClass,
} from '#shared/runner/gen3d'
import type { NodePlan, PlanContext } from '../executors'
import { imageUrlOf } from '../imageUrl'
import { firstOutputUrl } from './repair'

// ── A widget as ComfyUI hands it to execute (missing: the node's default) ──

/** float(val) for a FLOAT widget. */
function float(inputs: Record<string, unknown>, name: string, def: number): number {
  const v = inputs[name]
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return Number(v)
  if (typeof v === 'string') {
    const n = pyFloatOf(v)
    if (n !== null) return n
  }
  if (v === undefined) return def
  throw new Error('This number setting must be a number')
}

/** int(val) for an INT widget. */
function int(inputs: Record<string, unknown>, name: string, def: number): number {
  const v = inputs[name]
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'boolean') return Number(v)
  if (typeof v === 'string') {
    const n = pyIntOf(v)
    if (n !== null) return n
  }
  if (v === undefined) return def
  throw new Error('This number setting must be a whole number')
}

/** bool(val) for a BOOLEAN widget. */
function bool(inputs: Record<string, unknown>, name: string, def: boolean): boolean {
  const v = inputs[name]
  return v === undefined ? def : pyTruthy(v)
}

/** A COMBO or STRING widget's text (ComfyUI has checked a COMBO is one of its options). */
function text(inputs: Record<string, unknown>, name: string, def: string): string {
  const v = inputs[name]
  if (v === undefined || v === null) return def
  if (typeof v !== 'string') throw new Error('This setting must be text')
  return v
}

// ── What each node sends (its Python, as ported) ──

/**
 * Hunyuan3DRemoteNode.execute (:1876-1894), which Generate a 3D model calls
 * (:5099-5105): the picture, the five settings as given, and the seed only
 * above 0.
 */
export function hunyuan3dInput(inputs: Record<string, unknown>, image: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    image,
    steps: int(inputs, 'steps', 50),
    guidance_scale: float(inputs, 'guidance_scale', 5.5),
    octree_resolution: int(inputs, 'octree_resolution', 256),
    remove_background: bool(inputs, 'remove_background', true),
    texture: bool(inputs, 'texture', true),
  }
  const seed = int(inputs, 'seed', 0)
  if (seed > 0) payload.seed = seed
  return payload
}

/** The views sent, front first: each input's provider link, or null where it isn't wired. */
export interface Views { front: string; back: string | null; left: string | null; right: string | null }

/**
 * Hunyuan3DMultiViewNode.execute (:1953-2021): the engine's slug and its
 * dict. Hunyuan3D-2mv (:1966-1980) names each view; Rodin (:1982-2003) and
 * TRELLIS (:2005-2021) send them as `images`, front first. Rodin's prompt is
 * `(prompt or "").strip() or "a full-body character"`, its polygon count
 * only above 0, its seed modulo 65,536 only above 0; TRELLIS's seed only
 * above 0, with `randomize_seed` off.
 */
export function multiViewInput(engine: string, inputs: Record<string, unknown>, views: Views): { endpoint: string, payload: Record<string, unknown> } {
  const endpoint = multiViewSlug(engine)
  const seed = int(inputs, 'seed', 0)
  const images = [views.front, views.back, views.left, views.right].filter((v): v is string => !!v)
  if (endpoint === HUNYUAN3D_MV_SLUG) {
    const payload: Record<string, unknown> = {
      front_image: views.front,
      steps: int(inputs, 'steps', 50),
      guidance_scale: float(inputs, 'guidance_scale', 5.5),
      octree_resolution: int(inputs, 'octree_resolution', 256),
      remove_background: bool(inputs, 'remove_background', true),
      file_type: 'glb',
    }
    if (views.back) payload.back_image = views.back
    if (views.left) payload.left_image = views.left
    if (views.right) payload.right_image = views.right
    if (seed > 0) payload.seed = seed
    return { endpoint, payload }
  }
  if (endpoint === RODIN_SLUG) {
    const payload: Record<string, unknown> = {
      images,
      prompt: pyStrip(text(inputs, 'prompt', 'a full-body character')) || 'a full-body character',
      material: 'PBR',
      mesh_mode: 'Quad',
      quality: text(inputs, 'rodin_quality', 'medium'),
      geometry_file_format: 'glb',
      tapose: bool(inputs, 'rodin_tapose', false),
    }
    const poly = int(inputs, 'rodin_poly_count', 0)
    if (poly > 0) payload.quality_override = poly
    // Python's `int(seed) % 65536` of a positive seed.
    if (seed > 0) payload.seed = seed % 65536
    return { endpoint, payload }
  }
  const payload: Record<string, unknown> = {
    images,
    generate_model: true,
    generate_color: false,
    texture_size: 1024,
    mesh_simplify: 0.95,
  }
  if (seed > 0) {
    payload.seed = seed
    payload.randomize_seed = false
  }
  return { endpoint: TRELLIS_SLUG, payload }
}

// ── The answer ──

/**
 * TRELLIS's GLB (:2019-2021): `output.model_file` when the output is a dict
 * and it is set, else `_first_output_url` (a dict without it has no URL: the
 * node fails plainly, as Python's `_first_output_url` raises). A set
 * `model_file` that isn't text is no file.
 */
export function trellisGlbUrl(result: unknown): string[] {
  const out = result && typeof result === 'object' ? (result as Record<string, unknown>).output : undefined
  if (out && typeof out === 'object' && !Array.isArray(out)) {
    const file = (out as Record<string, unknown>).model_file
    if (pyTruthy(file ?? null)) return typeof file === 'string' ? [file] : []
  }
  return firstOutputUrl(result)
}

/**
 * Hunyuan3D 2's GLB. DELIBERATE DEVIATION FROM PYTHON (R3.9 fix round 1,
 * controller ruling): the model's published output is `{ mesh: url }`, a dict
 * Python's `_first_output_url` refuses (the ComfyUI path's call is paid for,
 * then fails; that path now refuses the node before the hold). The runner
 * reads `output.mesh` when it is text, else `_first_output_url` as Python
 * (a list's first item, or a plain string). A `mesh` that isn't text is no file.
 */
export function hunyuan3dGlbUrl(result: unknown): string[] {
  const out = result && typeof result === 'object' ? (result as Record<string, unknown>).output : undefined
  if (out && typeof out === 'object' && !Array.isArray(out) && Object.prototype.hasOwnProperty.call(out, 'mesh')) {
    const mesh = (out as Record<string, unknown>).mesh
    return typeof mesh === 'string' && mesh ? [mesh] : []
  }
  return firstOutputUrl(result)
}

// ── The plan ──

/** The node's plan: one Replicate call whose answer names its 3D file, saved as the user's own. */
export async function planGen3d(ctx: PlanContext): Promise<NodePlan> {
  const node = ctx.prompt[ctx.nodeId]!
  const classType = node.class_type as Gen3dClass
  const inputs = node.inputs ?? {}
  const linkUrl = async (name: string): Promise<string | null> => {
    const link = inputs[name]
    if (!isLink(link)) return null
    const file = ctx.filesFrom(link)[0]
    if (!file) throw new Error('There is no picture to make the 3D model from')
    return imageUrlOf(ctx, file, link)
  }
  const glb = { kind: 'provider' as const, provider: 'replicate' as const, media: 'glb' as const, take: 'first' as const, prefix: 'model3d', uiFor: () => null }
  if (classType !== 'Hunyuan3DMultiViewNode') {
    const image = await linkUrl('image')
    if (!image) throw new Error('There is no picture to make the 3D model from')
    return { ...glb, endpoint: HUNYUAN3D_SLUG, payload: hunyuan3dInput(inputs, image), urlsOf: hunyuan3dGlbUrl }
  }
  const [front, back, left, right] = await Promise.all(MULTI_VIEW_PICTURES.map(linkUrl))
  if (!front) throw new Error('Multi-View needs a front view')
  const call = multiViewInput(text(inputs, 'engine', MULTI_VIEW_DEFAULT_ENGINE), inputs, { front, back: back ?? null, left: left ?? null, right: right ?? null })
  return {
    ...glb, endpoint: call.endpoint, payload: call.payload,
    urlsOf: call.endpoint === TRELLIS_SLUG ? trellisGlbUrl : firstOutputUrl,
  }
}
