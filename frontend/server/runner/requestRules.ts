/**
 * Requests no provider takes, refused in plain words before they are sent
 * (Task S1b fix round 1, controller rulings a and d). Both paths use this:
 *  - the runner: planNode checks the payload it built (`checkRequest`), and
 *    the engine checks every node before anything is held (`requestProblems`);
 *  - the ComfyUI path: the /prompt gate (server/utils/blockedModels.ts, the
 *    local proxy and the hosted meter) checks the same nodes (`requestProblems`).
 *
 * The rules come from the providers' saved schemas
 * (tests/unit/fixtures/provider-schemas/; a test holds this table to them):
 *  - a prompt shorter than the schema's `minLength` (Nano Banana 3, Hailuo H3 1);
 *  - Seedance 2.0 references over the schema's counts (9 pictures, 3 videos,
 *    3 sounds). Their combined length (15 s of video, 15 s of sound) needs the
 *    files read, which only the gate can do (graphInputSeconds.ts
 *    seedanceReferenceSeconds).
 * References are never dropped to make a request fit.
 */
import { isLink, type ApiPrompt } from '#shared/runner/graph'
import { resolveVideoModelId } from '#shared/runner/eligibility'
import { composeImagePrompt } from './generators/image'
import { asText, parseJsonObject } from './generators/opts'
import { moodboardFiles } from './inputs'

export const NANO_BANANA_SHORT_PROMPT = 'Nano Banana needs a prompt of at least 3 characters.'
export const H3_SHORT_PROMPT = 'Hailuo H3 needs a prompt.'

/** `<provider> <endpoint>` → the prompt's minimum length in characters (the schema's `minLength`), and what to say. */
export const PROMPT_MIN_LENGTH: Readonly<Record<string, { min: number, message: string }>> = {
  'fal fal-ai/nano-banana-2': { min: 3, message: NANO_BANANA_SHORT_PROMPT },
  'fal fal-ai/nano-banana-2/edit': { min: 3, message: NANO_BANANA_SHORT_PROMPT },
  'fal fal-ai/nano-banana-pro': { min: 3, message: NANO_BANANA_SHORT_PROMPT },
  'fal fal-ai/nano-banana-pro/edit': { min: 3, message: NANO_BANANA_SHORT_PROMPT },
  'fal minimax/h3/text-to-video': { min: 1, message: H3_SHORT_PROMPT },
  'fal minimax/h3/image-to-video': { min: 1, message: H3_SHORT_PROMPT },
  'fal minimax/h3/reference-to-video': { min: 1, message: H3_SHORT_PROMPT },
  'fal minimax/h3-max/text-to-video': { min: 1, message: H3_SHORT_PROMPT },
  'fal minimax/h3-max/image-to-video': { min: 1, message: H3_SHORT_PROMPT },
}

/** JSON Schema counts characters as code points. */
const chars = (s: string) => [...s].length

/** Seedance 2.0 reference-to-video limits (its schema: image_urls ≤ 9, video_urls ≤ 3, audio_urls ≤ 3). */
export const SEEDANCE_REFERENCE_LIMITS = [
  { key: 'image_urls', max: 9, message: 'Seedance 2.0 takes at most 9 reference pictures.' },
  { key: 'video_urls', max: 3, message: 'Seedance 2.0 takes at most 3 reference videos.' },
  { key: 'audio_urls', max: 3, message: 'Seedance 2.0 takes at most 3 reference sounds.' },
] as const
/** Combined length of the reference videos, and of the reference sounds (its schema's descriptions). */
export const SEEDANCE_REFERENCE_MAX_SECONDS = 15
export const SEEDANCE_TOO_MUCH_VIDEO = 'Seedance 2.0 takes at most 15 s of reference video in all.'
export const SEEDANCE_TOO_MUCH_SOUND = 'Seedance 2.0 takes at most 15 s of reference sound in all.'

/**
 * What is wrong with Seedance 2.0's reference lists in these options, or null.
 * With a first frame (the linked image, or `image_url`) no reference is sent.
 */
export function seedanceReferenceProblem(adv: Record<string, unknown>, firstFrame: boolean): { key: string, message: string } | null {
  if (firstFrame || asText(adv.image_url)) return null
  for (const l of SEEDANCE_REFERENCE_LIMITS) {
    const v = adv[l.key]
    if (Array.isArray(v) && v.length > l.max) return { key: l.key, message: l.message }
  }
  return null
}

/** The payload's problem for this endpoint, or null (the runner, after building it). */
export function requestProblem(provider: string, endpoint: string, payload: Record<string, unknown>): string | null {
  const rule = PROMPT_MIN_LENGTH[`${provider} ${endpoint}`]
  if (rule && chars(typeof payload.prompt === 'string' ? payload.prompt : '') < rule.min) return rule.message
  if (`${provider} ${endpoint}` === 'fal bytedance/seedance-2.0/reference-to-video') {
    for (const l of SEEDANCE_REFERENCE_LIMITS) {
      const v = payload[l.key]
      if (Array.isArray(v) && v.length > l.max) return l.message
    }
  }
  return null
}

/** planNode's check: throws the plain message for a request no provider takes. */
export function checkRequest(provider: string, endpoint: string, payload: Record<string, unknown>): void {
  const problem = requestProblem(provider, endpoint, payload)
  if (problem) throw new Error(problem)
}

export interface RequestProblem {
  nodeId: string
  classType: string
  /** The input the problem is about. */
  input: string
  message: string
}

const NANO_BANANA_IMAGE_MODELS: ReadonlySet<string> = new Set(['nano-banana-2', 'nano-banana-pro'])
const H3_VIDEO_MODELS: ReadonlySet<string> = new Set(['hailuo-h3', 'hailuo-h3-max'])

/**
 * Every node of a prompt whose request no provider would take, read from its
 * widgets the way the node composes its request (Python and the runner alike):
 * the prompt as sent, after any style text is added. A prompt part that is
 * wired in can't be read before the run, so that node is not judged here.
 */
export function requestProblems(prompt: ApiPrompt): RequestProblem[] {
  const out: RequestProblem[] = []
  for (const [nodeId, node] of Object.entries(prompt ?? {})) {
    const inputs = node?.inputs ?? {}
    const ct = node?.class_type
    const short = (text: string, min: number, message: string) => {
      if (chars(text) < min) out.push({ nodeId, classType: ct, input: 'prompt', message })
    }
    if (ct === 'GenerateImageNode' && NANO_BANANA_IMAGE_MODELS.has(String(inputs.model))) {
      if (['prompt', 'prompt_in', 'style_block', 'style_in'].some(k => isLink(inputs[k]))) continue
      short(composeImagePrompt({
        prompt: asText(inputs.prompt),
        promptIn: asText(inputs.prompt_in),
        styleBlock: asText(inputs.style_block),
        styleIn: asText(inputs.style_in),
        hasRefs: moodboardFiles(inputs.style_refs).length > 0,
      }), 3, NANO_BANANA_SHORT_PROMPT)
    }
    else if (ct === 'EditImageNode' && inputs.model === 'Nano Banana 2') {
      if (!isLink(inputs.prompt)) short(asText(inputs.prompt), 3, NANO_BANANA_SHORT_PROMPT)
    }
    else if (ct === 'GenerateFromReferencesNode' && inputs.model === 'nano-banana-2') {
      if (!isLink(inputs.prompt) && (inputs.prompt === undefined || typeof inputs.prompt === 'string')) short(asText(inputs.prompt), 3, NANO_BANANA_SHORT_PROMPT)
    }
    else if (ct === 'GenerateVideoNode') {
      const id = resolveVideoModelId(inputs.model)
      if (H3_VIDEO_MODELS.has(id) && !isLink(inputs.prompt)) short(asText(inputs.prompt), 1, H3_SHORT_PROMPT)
      if (id === 'seedance-2.0' && !isLink(inputs.model_options)) {
        const p = seedanceReferenceProblem(parseJsonObject(inputs.model_options), isLink(inputs.image))
        if (p) out.push({ nodeId, classType: ct, input: 'model_options', message: p.message })
      }
    }
  }
  return out
}
