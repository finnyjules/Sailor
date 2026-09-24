/**
 * fal image-edit request bodies, ported from comfy_api_nodes/nodes_replicate.py:
 *   falNanoBananaEdit  ← _run_fal_nano_banana_edit (:1121)
 *   falKontext         ← _run_fal_kontext (:1059)
 *   falFlux2Edit       ← _run_fal_flux2_edit (:1096)
 * plus the fixed Develop prompt (:2806) and BlendSceneNode's instruction
 * (_build_blend_instruction, :2940). Python's Nano Banana path tries fal
 * nano-banana-2, then fal nano-banana-pro, then Replicate; the runner sends
 * to the first and stops there (a failure is a failure).
 */

export const NANO_BANANA_2_EDIT_APP = 'fal-ai/nano-banana-2/edit'
export const NANO_BANANA_PRO_EDIT_APP = 'fal-ai/nano-banana-pro/edit'
export const FLUX_KONTEXT_APP = 'fal-ai/flux-pro/kontext'
export const FLUX_2_EDIT_APP = 'fal-ai/flux-2-pro/edit'

const isJpeg = (fmt: string) => fmt === 'jpg' || fmt === 'jpeg'

/** `int(seed) & 0xFFFFFFFF` for a positive seed. */
const mask32 = (seed: number) => seed % 0x1_0000_0000

export function falNanoBananaEdit(o: { imageUrls: string[]; prompt: string; resolution: string; outputFormat: string; seed: number }): Record<string, unknown> {
  const inp: Record<string, unknown> = {
    prompt: o.prompt,
    image_urls: [...o.imageUrls],
    output_format: isJpeg(o.outputFormat) ? 'jpeg' : o.outputFormat,
    resolution: o.resolution,
    num_images: 1,
  }
  // Checked before the mask, as in Python: 2^32 sends seed 0.
  if (o.seed && o.seed > 0) inp.seed = mask32(o.seed)
  return inp
}

export function falKontext(o: {
  imageUrl: string; prompt: string; aspectRatio?: string; safetyTolerance?: number
  enhancePrompt?: boolean; outputFormat: string; seed: number
}): Record<string, unknown> {
  const aspectRatio = o.aspectRatio ?? 'match_input_image'
  const safety = o.safetyTolerance ?? 2
  const inp: Record<string, unknown> = {
    prompt: o.prompt,
    image_url: o.imageUrl,
    output_format: isJpeg(o.outputFormat) ? 'jpeg' : 'png',
  }
  // fal has no match_input_image: the input's ratio is kept by leaving it out.
  if (aspectRatio && aspectRatio !== 'match_input_image') inp.aspect_ratio = aspectRatio
  // Sent only when not the default, as the string enum fal expects.
  if (safety && safety !== 2) inp.safety_tolerance = String(safety)
  if (o.enhancePrompt) inp.enhance_prompt = true
  if (o.seed && o.seed > 0) inp.seed = o.seed
  return inp
}

export function falFlux2Edit(o: { imageUrls: string[]; prompt: string; outputFormat: string; seed: number }): Record<string, unknown> {
  const inp: Record<string, unknown> = {
    prompt: o.prompt,
    image_urls: [...o.imageUrls],
    output_format: isJpeg(o.outputFormat) ? 'jpeg' : 'png',
  }
  if (o.seed && o.seed > 0) inp.seed = o.seed
  return inp
}

/** DevelopImageNode's fixed instruction (_DEVELOP_PROMPT). */
export const DEVELOP_PROMPT
  = 'Turn this rough into a polished, finished, highly detailed image — '
    + 'keep the same composition and subject.'

const BLEND_SCENE_BASE = 'Blend all elements into a single cohesive, photorealistic image.'
const BLEND_CLAUSE_LIGHTING = 'Unify the lighting direction, color temperature and ambient tone across the whole scene.'
const BLEND_CLAUSE_SHADOWS = 'Add soft, realistic contact shadows where objects meet surfaces.'
const BLEND_CLAUSE_CAMERA = 'Match film grain and depth of field.'
const BLEND_CLAUSE_IDENTITY
  = 'Keep each element\'s shape, position, proportions and identity unchanged. '
    + 'Do not move, rotate, rescale or reflow any element.'

/** _build_blend_instruction: the base sentence plus one clause per toggle that is on. */
export function blendInstruction(t: { unifyLighting: boolean; contactShadows: boolean; matchCameraLook: boolean; preserveIdentity: boolean }): string {
  const parts = [BLEND_SCENE_BASE]
  if (t.unifyLighting) parts.push(BLEND_CLAUSE_LIGHTING)
  if (t.contactShadows) parts.push(BLEND_CLAUSE_SHADOWS)
  if (t.matchCameraLook) parts.push(BLEND_CLAUSE_CAMERA)
  if (t.preserveIdentity) parts.push(BLEND_CLAUSE_IDENTITY)
  return parts.join(' ')
}
