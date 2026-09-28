/**
 * Restyle an Image · Style LoRA as a runner pipeline (step 3, R3.14, family
 * `lora`), built as its Python builds it (comfy_api_nodes/nodes_replicate.py
 * RestyleWithLoRANode, :3180-3432, with the helpers of replicate_refs.py).
 * Every call in Python's order, each written down (so a restarted server
 * replays the finished ones) and charged if it finished (ruling (f)):
 *
 *  1. `describe` — lucataco/moondream2 captions the picture with the
 *     describe prompt (the old default "Describe this image in detail." read
 *     as today's subject-only prompt, :3321-3322); the answer's text as
 *     Python joins it, an empty one read as "a high quality image". One call
 *     (ruling (e)); in hosted the caption is moderated before it is sent on.
 *  2. `stylize` — the LoRA's Flux call: Flux Dev + LoRA's plan
 *     (./lora.ts resolveFluxLoraPlan: the user's trained model, else
 *     black-forest-labs/flux-dev-lora with the LoRA's weights, looked up on
 *     HuggingFace when bare, once per node run), image-to-image on the
 *     picture, prompted with the LoRA's trigger, its aesthetic's keywords and
 *     the caption (build_flux_style_prompt). Its picture is kept and handed
 *     on as Sailor's own copy (the hand-off rule: never a provider link that
 *     may expire; Python hands on the provider's link, the same picture).
 *  3. `classify-ref` — Moondream's verdict on that picture: photo or
 *     illustration (`_classify_image_style`; any failure reads as a photo).
 *  4. `nb-1` … `nb-3` — Nano Banana 2 on fal (`fal-ai/nano-banana-2/edit`),
 *     the picture and the LoRA's picture with the restyle instruction (the
 *     anti-photo line from the second pass), at the node's resolution and
 *     format, seed `(seed + pass) & 0xFFFFFFFF` sent when above 0. No backup:
 *     Replicate's Nano Banana 2 takes no seed, and this node's seeds are its
 *     promise of repeatable results; Python's fal Nano Banana Pro and
 *     Replicate fallbacks are not sent (the price still covers them).
 *  5. `classify-1` … — for an illustration target only, the verdict on each
 *     pass (handed on as Sailor's own copy too): the first pass still an
 *     illustration is the result; none, the LoRA's picture is.
 *
 * A photo target takes the first pass. The result is saved as Python's
 * tensor saves it (alpha dropped, rule 3), shown under `restyle_lora`.
 * Everything that can fail before a call (the sidecar, the LoRA plan, a
 * guidance flux-dev-lora refuses) fails when the node is planned, before its
 * first call, where Python would have paid for the caption first.
 */
import { isLink } from '#shared/runner/graph'
import { pyStr, type PyJson } from '#shared/runner/pyJson'
import { pyStrip } from '#shared/runner/pyText'
import { llmText, pyFalsy } from '#shared/runner/llm'
import { MOONDREAM_SLUG } from '#shared/runner/describe'
import { FLUX_DEV_LORA_SLUG, FLUX_LORA_STEPS, RESTYLE_GUIDANCE, fluxLoraGuidanceProblem } from '#shared/runner/lora'
import { RESTYLE_LORA_NB_RETRIES } from '#shared/pricing/editSettings'
import { paidCallUsd, type PaidCall } from '#shared/pricing/paidRates'
import { restyleLoraCalls } from '#shared/pricing/paidSettings'
import { answerExt } from '../answerDownload'
import { imageUrlOf } from '../imageUrl'
import { LORA_SIDECAR_UNREADABLE, readLoraSidecar, type LoraSidecar } from '../loraFiles'
import { answerRgbPng } from '../pictures/pythonView'
import type { NodePlan, PipelineIO, PlanContext } from '../executors'
import type { OutputFile, RunnerValue } from '../types'
import { answerOutput } from './llm'
import { LORA_NO_PICTURE, float, int, resolveFluxLoraPlan, text, type HuggingFaceLookups, type SidecarReader } from './lora'
import { firstOutputUrl } from './repair'
import { buildRestyleInstruction } from './restyle'
import { NANO_BANANA_2_FAL_EDIT } from './twins'

// ── nodes_replicate.py and replicate_refs.py, ported ──

/** `_RESTYLE_DESCRIBE_PROMPT` (:337-341): the subject-only caption prompt, the describe prompt's default. */
export const RESTYLE_DESCRIBE_PROMPT = (
  'In one short sentence, describe only the main subject, their clothing, pose '
  + 'and setting. Do not mention photography, the camera, lighting, colours, image '
  + 'quality, the sky or the weather.'
)
/** The old default, read as today's (:3321-3322). */
export const RESTYLE_OLD_DESCRIBE_PROMPT = 'Describe this image in detail.'
/** What an empty caption becomes (:3344-3345). */
export const RESTYLE_CAPTION_STAND_IN = 'a high quality image'
/** `_classify_image_style`'s question (:357-365). */
export const RESTYLE_CLASSIFY_PROMPT = (
  'Classify the medium. If it is a real-life photo answer '
  + '\'photograph\'. If it is any kind of drawn, painted, cartoon, '
  + 'comic, anime, cel-shaded or CGI/3D artwork answer '
  + '\'illustration\'. One word.'
)
/** RESTYLE_ANTIPHOTO_RETRY (replicate_refs.py:315): added to the instruction from the second pass. */
export const RESTYLE_ANTIPHOTO_RETRY = (
  ' IMPORTANT: a previous attempt failed by returning a realistic photograph.'
  + ' The output MUST be a non-photographic illustration in the second image\'s'
  + ' medium — illustrated, drawn, painted or 3D-rendered — and must NOT look'
  + ' like a photo.'
)
/** Nano Banana passes at most (1 + `_RESTYLE_MAX_NB_RETRIES`). */
export const RESTYLE_NB_PASSES = 1 + RESTYLE_LORA_NB_RETRIES
/** Nano Banana's answer with no picture (Python falls back to fal Nano Banana Pro there; the runner sends no other service). */
export const RESTYLE_NB_NO_PICTURE = 'Nano Banana 2 sent back no picture'

/**
 * `restyle_style_strength_to_knobs` (replicate_refs.py:294-312): the one
 * style dial as [Nano Banana's structure strength, Flux's prompt strength];
 * a Flux strength above 0 replaces the derived one.
 */
export function restyleStyleStrengthToKnobs(styleStrength: number, fluxOverride = 0): [number, number] {
  const s = Math.max(0, Math.min(1, styleStrength))
  const structure = Math.max(0, Math.min(1, 1 - s))
  const prompt = fluxOverride && fluxOverride > 0 ? Math.max(0, Math.min(1, fluxOverride)) : 0.5 + 0.4 * s
  return [structure, prompt]
}

/** `sidecar_aesthetic` (:460-473): the sidecar's `aesthetic`, else its `taste_profile`, stripped (text only). */
export function sidecarAesthetic(sidecar: LoraSidecar | null): string {
  if (!sidecar) return ''
  for (const key of ['aesthetic', 'taste_profile']) {
    const v = sidecar.get(key)
    if (typeof v === 'string' && pyStrip(v)) return pyStrip(v)
  }
  return ''
}

/** `aesthetic_to_keywords` (:476-487): the keyword tail after the last blank line, when it has a comma; else the whole text. */
export function aestheticToKeywords(aesthetic: string): string {
  const t = pyStrip(aesthetic ?? '')
  if (!t) return ''
  const segments = t.split('\n\n').map(pyStrip).filter(x => x)
  const tail = segments.length ? segments[segments.length - 1]! : t
  return tail.includes(',') ? tail : t
}

/** `build_flux_style_prompt` (:490-514): trigger, keywords, caption joined by ", ", then "in the style of <trigger>". */
export function buildFluxStylePrompt(trigger: string, aesthetic: string, caption: string): string {
  const trig = pyStrip(trigger ?? '')
  const prompt = [trig, aestheticToKeywords(aesthetic), pyStrip(caption ?? '')].filter(p => p).join(', ')
  return trig ? `${prompt}, in the style of ${trig}` : prompt
}

const ILLUSTRATION_HINTS = [
  'illustr', 'drawn', 'drawing', 'cartoon', 'anime', 'paint', 'render', '3d',
  'cgi', 'cel', 'comic', 'sketch', 'graphic', 'artwork', 'styliz', 'stylis',
]
const PHOTO_HINTS = ['photo', 'photograph', 'realistic', 'real life', 'real-life']

/** `classify_style_answer` (:331-348): illustration hints win, then photo hints; blank or neither is `def`. */
export function classifyStyleAnswer(answer: string, def: 'photo' | 'illustration' = 'photo'): 'photo' | 'illustration' {
  const t = pyStrip(answer ?? '').toLowerCase()
  if (!t) return def
  if (ILLUSTRATION_HINTS.some(h => t.includes(h))) return 'illustration'
  if (PHOTO_HINTS.some(h => t.includes(h))) return 'photo'
  return def
}

/**
 * The verdict's answer as `_classify_image_style` reads it (:370): a list
 * joined from `str()` of each item, anything else `str(out or "")`. A list
 * or dict inside is read by its repr, as Python prints it for a plain
 * string ('…'); only the hints in the words matter, so escapes aren't
 * reproduced.
 */
export function verdictText(out: PyJson): string {
  const repr = (v: PyJson): string => {
    if (typeof v === 'string') return `'${v}'`
    if (Array.isArray(v)) return `[${v.map(repr).join(', ')}]`
    if (v && typeof v === 'object' && 'obj' in v) return `{${v.obj.map(([k, x]) => `'${k}': ${repr(x)}`).join(', ')}}`
    return pyStr(v)
  }
  const str = (v: PyJson): string => (typeof v === 'string' ? v : Array.isArray(v) || (v && typeof v === 'object' && 'obj' in v) ? repr(v) : pyStr(v))
  if (Array.isArray(out)) return out.map(str).join('')
  return pyFalsy(out) ? '' : str(out)
}

/** `first_fal_image_url` (fal_refs.py:71-78): the first picture's `url`, or null. */
export function firstFalImageUrl(result: unknown): string | null {
  const images = result && typeof result === 'object' ? (result as Record<string, unknown>).images : undefined
  const first = Array.isArray(images) ? images[0] : undefined
  const url = first && typeof first === 'object' && !Array.isArray(first) ? (first as Record<string, unknown>).url : undefined
  return typeof url === 'string' && url ? url : null
}

/** The sidecar's `trigger` as Python reads it (`(trigger or "").strip()`): text, or nothing when falsy; anything else can't be read. */
function sidecarTrigger(sidecar: LoraSidecar | null): string {
  const v = sidecar?.get('trigger')
  if (typeof v === 'string') return v
  if (v === undefined || pyFalsy(v)) return ''
  throw new Error(LORA_SIDECAR_UNREADABLE)
}

// ── What each call sends ──

/** Nano Banana's output format on fal (`jpeg` for the node's `jpg`). */
const falFormat = (format: string) => (format === 'jpg' || format === 'jpeg' ? 'jpeg' : format)

/** One Nano Banana pass on fal (`_run_fal_nano_banana_edit`, :1120-1145): the seed only when above 0. */
export function nanoBananaPassInput(instruction: string, images: readonly string[], o: { resolution: string, format: string, seed: number }): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    prompt: instruction,
    image_urls: [...images],
    output_format: falFormat(o.format),
    resolution: o.resolution,
    num_images: 1,
  }
  if (o.seed > 0) payload.seed = o.seed
  return payload
}

/** `(int(seed) + attempt) & 0xFFFFFFFF`. */
export const passSeed = (seed: number, pass: number) => (((seed + pass) % 0x1_0000_0000) + 0x1_0000_0000) % 0x1_0000_0000

// ── The plan ──

/** A call's price basis from the one calculation (the node's priced calls). */
function usdOf(call: PaidCall): number {
  const usd = paidCallUsd(call)
  if (usd == null) throw new Error('Restyle an image has no price yet')
  return usd
}

/**
 * The node's plan. `reader`: the sidecar reader (tests pass their own).
 * The LoRA plan, the sidecar and the settings are read here, before any call.
 */
export async function planRestyleLora(ctx: PlanContext, reader?: SidecarReader): Promise<NodePlan> {
  const inputs = ctx.prompt[ctx.nodeId]!.inputs ?? {}
  const o = { hosted: !!ctx.hosted }
  const link = inputs.content_image
  const file = isLink(link) ? ctx.filesFrom(link)[0] : undefined
  if (!file) throw new Error('There is no picture to restyle')
  // Hosted never reads a sidecar (ruling (i)): the reader refuses there itself.
  const read: SidecarReader = reader ?? (name => readLoraSidecar(name, o))
  const name = text(inputs, 'lora_name', '[None]')
  // `_read_lora_sidecar(lora_name) or {}`, read once (the Flux plan reads the same file when no link is pasted).
  const sidecar = await read(name)
  const trigger = sidecarTrigger(sidecar)
  const aesthetic = sidecarAesthetic(sidecar)
  const lookups: HuggingFaceLookups = new Map()
  const plan = await resolveFluxLoraPlan(name, text(inputs, 'lora_url', ''), async () => sidecar, o, lookups)

  const [structure, promptStrength] = restyleStyleStrengthToKnobs(float(inputs, 'style_strength', 0.5), float(inputs, 'flux_prompt_strength', 0))
  const seed = int(inputs, 'seed', 0)
  const resolution = text(inputs, 'resolution', '1K')
  const format = text(inputs, 'output_format', 'png')
  const steps = int(inputs, 'flux_steps', FLUX_LORA_STEPS.default)
  const guidance = float(inputs, 'flux_guidance', 3.5)
  const loraScale = float(inputs, 'lora_scale', 1)
  let describePrompt = text(inputs, 'describe_prompt', RESTYLE_DESCRIBE_PROMPT)
  if (pyStrip(describePrompt) === RESTYLE_OLD_DESCRIBE_PROMPT) describePrompt = RESTYLE_DESCRIBE_PROMPT
  const instruction = buildRestyleInstruction(structure, text(inputs, 'extra_style_direction', ''))
  const fluxEndpoint = plan.trainedModel ?? FLUX_DEV_LORA_SLUG
  // A guidance flux-dev-lora's schema refuses (Python sends it after paying for the caption): before any call.
  if (fluxEndpoint === FLUX_DEV_LORA_SLUG) {
    const tooHigh = fluxLoraGuidanceProblem(inputs, RESTYLE_GUIDANCE)
    if (tooHigh) throw new Error(tooHigh.message)
  }

  // Each call's price basis, from the node's priced calls (the hold's calculation).
  const calls = restyleLoraCalls(ctx.priceInputs ?? inputs)
  const moondreamUsd = usdOf(calls.moondream.call)
  const fluxUsd = usdOf(calls.stylize.call)
  const passUsd = usdOf(calls.nanoBanana.call)
  const content = await imageUrlOf(ctx, file, link)

  return {
    kind: 'pipeline', prefix: 'restyle_lora',
    run: async (io: PipelineIO) => {
      const moondream = async (key: string, image: string, prompt: string) =>
        io.call({ key, provider: 'replicate', endpoint: MOONDREAM_SLUG, payload: { image, prompt }, media: 'value', usd: moondreamUsd })
      // A verdict: the call failing at the service reads as a photo (`except Exception: ans = ""`), uncharged (it
      // failed). A stopped node, or a call whose record is still standing (a resumed request that changed), fails.
      const verdict = async (key: string, image: string) => {
        let answer = ''
        try {
          const r = await moondream(key, image, RESTYLE_CLASSIFY_PROMPT)
          answer = verdictText(answerOutput(r.result, r.raw))
        }
        catch (e) {
          if (io.signal.aborted || io.recorded?.(key)) throw e
        }
        return classifyStyleAnswer(answer)
      }
      /** A picture answer kept for the run (a resumed node reads it back), with its own hand-off link. */
      const kept = async (callKey: string, url: string, name: string) => {
        const fresh: { bytes?: Uint8Array } = {}
        const file = await io.savedOnce(callKey, 'kept', async () => {
          fresh.bytes = (await io.download(url)).bytes
          return io.keep(fresh.bytes, 'bin')
        })
        const bytes = fresh.bytes ?? await io.read(file)
        return { bytes, link: await io.handOff(bytes, `${name}.${answerExt('image', bytes, null, url)}`) }
      }
      /** The result, saved as Python's tensor saves it (alpha dropped), once. */
      const result = async (callKey: string, bytes: () => Promise<Uint8Array>): Promise<OutputFile> =>
        io.savedOnce(callKey, 'picture', async () => io.saveAsset(await answerRgbPng(await bytes()), { prefix: 'restyle_lora', ext: 'png' }))

      // 1. The caption.
      const described = await moondream('describe', content, describePrompt)
      const caption = llmText(answerOutput(described.result, described.raw)) || RESTYLE_CAPTION_STAND_IN

      // 2. The LoRA's picture. Its prompt carries the model's caption: moderated in hosted before it is sent
      // (a resumed node's request was checked before the restart).
      const fluxPrompt = buildFluxStylePrompt(trigger, aesthetic, caption)
      const payload: Record<string, unknown> = {
        prompt: fluxPrompt,
        image: content,
        prompt_strength: promptStrength,
        num_inference_steps: steps,
        num_outputs: 1,
        output_format: 'png',
        disable_safety_checker: false,
        seed,
      }
      if (plan.trainedModel) {
        payload.guidance_scale = guidance
        payload.lora_scale = loraScale
      }
      else {
        payload.guidance = guidance
        if (plan.loraWeights) {
          payload.lora_weights = plan.loraWeights
          payload.lora_scale = loraScale
        }
      }
      if (!io.recorded?.('stylize')) await io.moderateText?.(fluxPrompt)
      const stylized = await io.call({ key: 'stylize', provider: 'replicate', endpoint: fluxEndpoint, payload, media: 'image', usd: fluxUsd })
      const styleUrl = firstOutputUrl(stylized.result)[0]
      if (!styleUrl) throw new Error(LORA_NO_PICTURE)
      const style = await kept('stylize', styleUrl, 'restyle_style')

      // 3. Photo or illustration.
      const target = await verdict('classify-ref', style.link)

      // 4–5. The passes: a photo target takes the first; an illustration target the first still illustrated.
      let picture: OutputFile | null = null
      for (let pass = 0; pass < RESTYLE_NB_PASSES && !picture; pass++) {
        const key = `nb-${pass + 1}`
        const nb = await io.call({
          key, provider: 'fal', endpoint: NANO_BANANA_2_FAL_EDIT, media: 'image', usd: passUsd,
          payload: nanoBananaPassInput(pass > 0 ? instruction + RESTYLE_ANTIPHOTO_RETRY : instruction, [content, style.link], { resolution, format, seed: passSeed(seed, pass) }),
        })
        const url = firstFalImageUrl(nb.result)
        if (!url) throw new Error(RESTYLE_NB_NO_PICTURE)
        if (target !== 'illustration') {
          picture = await result(key, async () => (await io.download(url)).bytes)
          break
        }
        const made = await kept(key, url, `restyle_pass_${pass + 1}`)
        if (await verdict(`classify-${pass + 1}`, made.link) === 'illustration') picture = await result(key, async () => made.bytes)
      }
      // Every pass looked like a photo: the LoRA's picture is the result.
      picture ??= await result('stylize', async () => style.bytes)
      const values: Record<number, RunnerValue> = { 0: { kind: 'files', files: [picture] } }
      return { values, ui: { images: [picture], animated: [false] } }
    },
  }
}
