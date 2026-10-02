/**
 * Upscale, enhance, restore and remove background as runner plans (step 3,
 * R3.5, family `image-repair`): UpscaleImageNode, EnhanceDetailNode,
 * RestorePhotoNode and RemoveBackgroundNode, and the hidden twins of the last
 * two (ruling (q): the visible node's builder). Each is one Replicate call
 * (`_run_prediction` on the slug) whose first answer URL is the node's
 * picture (Python reads `_first_output_url`: `take: 'first'`), saved as
 * downloaded (rule 3; Remove background's cut-out keeps its alpha). No
 * backup: no same-model twin on fal with the same settings is carded
 * (fal's Topaz is another app with its own settings; fal's ESRGAN bills by
 * compute time).
 *
 *  - A picture is sent as Python sends the first frame of its batch
 *    (`_image_tensor_to_data_url`): the handed-off file of the linked slot.
 *  - The settings are read as ComfyUI hands them to `execute` after its own
 *    validation (execution.py: `int()`, `float()`, `str()`, `bool()` of each
 *    widget; a missing one is the node's default), then sent as the node's
 *    Python builds its dict (each builder names its lines).
 *  - Upscale and Enhance detail are priced by the picture's size (the
 *    line-up's editCalls, measured before the hold); the four others per
 *    call. Upscale and Enhance show nothing themselves (Python returns no
 *    ui); Remove background and Restore show their picture
 *    (`save_generation_output`, prefixes `remove_bg` and `restore_photo`).
 */
import { isLink } from '#shared/runner/graph'
import { pyStr } from '#shared/runner/pyJson'
import { pyFloatOf, pyIntOf, pyTruthy } from '#shared/runner/pyText'
import { ENHANCE_ENGINE_SLUGS, UPSCALE_ENGINE_SLUGS } from '#shared/pricing/editSettings'
import { BACKGROUND_REMOVER_SLUG, RESTORE_IMAGE_SLUG, restoreTwinSafety, type RepairClass } from '#shared/runner/repair'
import type { NodePlan, PlanContext } from '../executors'
import { imageUrlOf } from '../imageUrl'

// ── A widget as ComfyUI hands it to execute (missing: the node's default) ──

/** str(val) for a STRING widget. */
function str(inputs: Record<string, unknown>, name: string, def: string): string {
  const v = inputs[name]
  if (v === undefined || v === null) return def
  if (typeof v === 'string') return v
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : pyStr({ float: v })
  throw new Error('This text setting must be text')
}

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

/** A COMBO widget's option (ComfyUI has checked it is one). */
function combo(inputs: Record<string, unknown>, name: string, def: string): string {
  const v = inputs[name]
  if (v === undefined) return def
  if (typeof v !== 'string') throw new Error('This setting must be one of its options')
  return v
}

// ── What each node sends (its Python, as ported) ──

/** A Replicate call: the slug and the input dict. */
export interface RepairCall { endpoint: string; payload: Record<string, unknown> }

/**
 * Upscale (nodes_replicate.py:4203-4258): the engine's slug (`_UPSCALE_SLUGS`)
 * and its dict. Clarity sends `seed` only above 0; Topaz sends its face
 * strength and creativity only with face enhance on.
 */
export function upscaleInput(inputs: Record<string, unknown>, image: string): RepairCall {
  const model = combo(inputs, 'model', 'Clarity')
  const scale = float(inputs, 'scale_factor', 2.0)
  let payload: Record<string, unknown>
  switch (model) {
    case 'Clarity': {
      payload = {
        image,
        prompt: str(inputs, 'prompt', 'masterpiece, best quality, highres'),
        scale_factor: scale,
        creativity: float(inputs, 'creativity', 0.35),
        resemblance: float(inputs, 'resemblance', 0.6),
        negative_prompt: str(inputs, 'negative_prompt', '(worst quality, low quality, normal quality:2)'),
        num_inference_steps: int(inputs, 'num_inference_steps', 18),
        output_format: 'png',
      }
      const seed = int(inputs, 'seed', 0)
      if (seed > 0) payload.seed = seed
      break
    }
    case 'Crystal':
      payload = {
        image,
        scale_factor: scale,
        creativity: float(inputs, 'crystal_creativity', 0.0),
        output_format: combo(inputs, 'crystal_output_format', 'png'),
      }
      break
    case 'Real-ESRGAN':
      payload = { image, scale: scale, face_enhance: bool(inputs, 'face_enhance', false) }
      break
    case 'Recraft Crisp':
      // Zero-knob crisp upscaler: only the picture.
      payload = { image }
      break
    case 'Topaz': {
      const face = bool(inputs, 'face_enhance', false)
      payload = {
        image,
        enhance_model: combo(inputs, 'topaz_enhance_model', 'Standard V2'),
        upscale_factor: combo(inputs, 'topaz_upscale_factor', '2x'),
        subject_detection: combo(inputs, 'topaz_subject_detection', 'None'),
        output_format: combo(inputs, 'topaz_output_format', 'png'),
        face_enhancement: face,
      }
      if (face) {
        payload.face_enhancement_creativity = float(inputs, 'topaz_face_creativity', 0.0)
        payload.face_enhancement_strength = float(inputs, 'topaz_face_strength', 0.8)
      }
      break
    }
    default:
      throw new Error(`The runner cannot upscale with ${model}`)
  }
  return { endpoint: UPSCALE_ENGINE_SLUGS[model]!, payload }
}

/**
 * Enhance detail: a port of `build_enhance_input` (replicate_refs.py:387-457),
 * every engine in place. Creative is Clarity at scale 1 with creativity
 * 0.1 + strength × 0.5; Faithful is Topaz with `upscale_factor` "None";
 * Diffusion Refine is the Magic Image Refiner at "original" with creativity
 * 0.15 + strength × 0.45. A seed goes only above 0.
 */
export function enhanceInput(inputs: Record<string, unknown>, image: string): RepairCall {
  const model = combo(inputs, 'model', 'Creative')
  const prompt = str(inputs, 'prompt', 'masterpiece, best quality, highres')
  const strength = float(inputs, 'detail_strength', 0.4)
  const seed = int(inputs, 'seed', 0)
  let payload: Record<string, unknown>
  switch (model) {
    case 'Creative':
      payload = {
        image,
        prompt,
        scale_factor: 1.0,
        creativity: 0.1 + strength * 0.5,
        resemblance: float(inputs, 'resemblance', 0.6),
        negative_prompt: str(inputs, 'negative_prompt', '(worst quality, low quality, normal quality:2)'),
        num_inference_steps: int(inputs, 'num_inference_steps', 18),
        output_format: 'png',
      }
      if (seed > 0) payload.seed = seed
      break
    case 'Faithful':
      payload = {
        image,
        enhance_model: combo(inputs, 'topaz_enhance_model', 'Standard V2'),
        upscale_factor: 'None',
        subject_detection: combo(inputs, 'topaz_subject_detection', 'None'),
        output_format: combo(inputs, 'topaz_output_format', 'png'),
      }
      break
    case 'Diffusion Refine':
      payload = {
        image,
        resolution: 'original',
        prompt,
        creativity: 0.15 + strength * 0.45,
        resemblance: 0.75,
        steps: int(inputs, 'refine_steps', 20),
      }
      if (seed > 0) payload.seed = seed
      break
    default:
      throw new Error(`The runner cannot enhance with ${model}`)
  }
  return { endpoint: ENHANCE_ENGINE_SLUGS[model]!, payload }
}

/**
 * The most `safety_tolerance` flux-kontext-apps/restore-image takes: above it
 * the call is refused with a 422 (owed live checks 2026-10-01, B4), though the
 * node's widget offers 1–6. A level above it is sent as 2 — stricter, so safe.
 * Python sends the level as it is (nodes_replicate.py :4407, the twin :2088).
 */
export const RESTORE_MAX_SAFETY = 2

/**
 * Restore an old photo (:4406-4414): the picture, the safety level as its INT
 * widget has it (at most RESTORE_MAX_SAFETY), the format. The hidden twin
 * (:2082-2090) takes its level as text: `int(s)` when every character is a
 * digit, else 2 (restoreTwinSafety), at most RESTORE_MAX_SAFETY likewise.
 */
export function restorePhotoInput(classType: 'RestorePhotoNode' | 'RestorePhotoRemoteNode', inputs: Record<string, unknown>, image: string): Record<string, unknown> {
  const safety = classType === 'RestorePhotoRemoteNode'
    ? restoreTwinSafety(str(inputs, 'safety_tolerance', '2'))
    : int(inputs, 'safety_tolerance', 2)
  if (typeof safety !== 'number') throw new Error(safety.refused)
  return { input_image: image, safety_tolerance: Math.min(safety, RESTORE_MAX_SAFETY), output_format: combo(inputs, 'output_format', 'png') }
}

/** Remove background (:4373-4375) and its twin (:2051-2053): the picture alone. */
export function removeBackgroundInput(image: string): Record<string, unknown> {
  return { image }
}

// ── The plan ──

/**
 * `_first_output_url` (replicate_refs.py:252-258): a list's first item, or
 * the output itself when it is text. Anything else (an empty list, a first
 * item that isn't text) is no picture: the node fails plainly, as Python's
 * download fails.
 */
export function firstOutputUrl(result: unknown): string[] {
  const out = result && typeof result === 'object' ? (result as Record<string, unknown>).output : undefined
  const first = Array.isArray(out) ? out[0] : out
  return typeof first === 'string' && first ? [first] : []
}

/** What each class saves its picture under and shows (Python's save_generation_output prefix, or none). */
const SHOWS: Readonly<Record<RepairClass, string | null>> = {
  UpscaleImageNode: null,
  EnhanceDetailNode: null,
  RestorePhotoNode: 'restore_photo',
  RestorePhotoRemoteNode: 'restore_photo',
  RemoveBackgroundNode: 'remove_bg',
  RemoveBackgroundRemoteNode: 'remove_bg',
}
/** The prefix a picture that isn't shown is saved under. */
const SAVED_AS: Readonly<Record<'UpscaleImageNode' | 'EnhanceDetailNode', string>> = {
  UpscaleImageNode: 'upscale',
  EnhanceDetailNode: 'enhance_detail',
}

/** The node's plan: one Replicate call whose first answer URL is its picture. */
export async function planRepair(ctx: PlanContext): Promise<NodePlan> {
  const node = ctx.prompt[ctx.nodeId]!
  const classType = node.class_type as RepairClass
  const inputs = node.inputs ?? {}
  const link = inputs.image
  const file = isLink(link) ? ctx.filesFrom(link)[0] : undefined
  if (!file) throw new Error('There is no picture to work on')
  // R11.6 fix round 3 (the controller's ruling): Upscale on Real-ESRGAN over the service's limit
  // (1 572 864 px: LC4, under the 2 096 704 it states) goes in tiles (./repairTiles.ts); at or under it, one call as before.
  if (classType === 'UpscaleImageNode' && combo(inputs, 'model', 'Clarity') === 'Real-ESRGAN') {
    const { realEsrganTiledPlan } = await import('./repairTiles')
    const tiled = await realEsrganTiledPlan(ctx, inputs, file, float(inputs, 'scale_factor', 2.0), bool(inputs, 'face_enhance', false))
    if (tiled) return tiled
  }
  const image = await imageUrlOf(ctx, file, link)
  let call: RepairCall
  switch (classType) {
    case 'UpscaleImageNode': call = upscaleInput(inputs, image); break
    case 'EnhanceDetailNode': call = enhanceInput(inputs, image); break
    case 'RestorePhotoNode':
    case 'RestorePhotoRemoteNode':
      call = { endpoint: RESTORE_IMAGE_SLUG, payload: restorePhotoInput(classType, inputs, image) }
      break
    case 'RemoveBackgroundNode':
    case 'RemoveBackgroundRemoteNode':
      call = { endpoint: BACKGROUND_REMOVER_SLUG, payload: removeBackgroundInput(image) }
      break
  }
  const shows = SHOWS[classType]
  return {
    kind: 'provider', provider: 'replicate', endpoint: call.endpoint, payload: call.payload,
    media: 'image', take: 'first',
    urlsOf: firstOutputUrl,
    prefix: shows ?? SAVED_AS[classType as keyof typeof SAVED_AS],
    // Python's ui: save_generation_output(tensor, prefix) for Remove background and Restore; none for the others.
    uiFor: files => (shows ? { images: files, animated: [false] } : null),
  }
}
