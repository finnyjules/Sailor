/**
 * Flux Dev + LoRA and Flux Dev + LoRAs as runner plans (step 3, R3.13, family
 * `lora`), built as their Python builds them (comfy_api_nodes/nodes_replicate.py).
 * No backup: fal's `fal-ai/flux-lora` is another service's LoRA loader, priced
 * per megapixel, not the same model.
 *
 *  - FluxLoRARemoteNode (:618-665): one Replicate call. Its plan
 *    (replicate_refs.py resolve_flux_lora_plan, :233-249): a `lora_url` that
 *    is a Replicate model reference runs that trained model directly; with no
 *    link, a picked LoRA whose sidecar names a trained model runs it;
 *    otherwise black-forest-labs/flux-dev-lora, with `lora_weights` (the link
 *    as `_normalize_lora_ref` reads it, else the sidecar's weights address),
 *    looked up on HuggingFace when bare (`_autodetect_huggingface`, ruling
 *    (h): through the safe fetcher, 8 seconds). Its first answer URL is the
 *    picture, alpha dropped (rule 3), shown under `flux_lora`.
 *  - FluxMultiLoRARemoteNode (:865-977): lucataco/flux-dev-multi-lora, a
 *    pipeline of one or two calls. The prompt is `_fold_prompt_in`'s, the
 *    taste (`style_in`) ahead of everything; each slot's link (normalised,
 *    looked up on HuggingFace) or its picked LoRA's weights file
 *    (`_resolve_lora_weights_url`); repeats collapsed (`_multilora_collect`).
 *    With two or more LoRAs the order is reversed on every other call by the
 *    runner's own process-wide toggle (ruling (g); Python's is its own
 *    process's), and when the answer's logs lack "Downloading LoRA weights"
 *    the node calls once more with the order flipped. Both calls are held,
 *    the calls made are charged. Its last answer's first URL is the picture,
 *    alpha dropped, shown under `flux_multilora`.
 *
 * A LoRA picked by name is read from models/loras/ (../loraFiles.ts): only
 * its sidecar, never its weights, which the provider fetches from the
 * sidecar's address (as Python). Hosted never gets here with one (ruling (i)).
 */
import { isLink } from '#shared/runner/graph'
import { pyFloatOf, pyIntOf, pyStrip } from '#shared/runner/pyText'
import {
  FLUX_DEV_LORA_SLUG, FLUX_LORA_CLASS, fluxLoraGuidanceProblem, FLUX_LORA_STEPS, FLUX_MULTI_LORA_SLUG, LORA_LOADED_MARKER, MULTI_LORA_NEEDS_LORA, MULTI_LORA_SLOTS,
  bareOwnerModel, foldPromptIn, huggingfaceLookupRepo, isReplicateModelRef, multiloraCollect, normalizeLoraRef, replicateModelToLoraRef,
} from '#shared/runner/lora'
import type { PyJson } from '#shared/runner/pyJson'
import { paidCallUsd } from '#shared/pricing/paidRates'
import { safeFetch } from '../../templates/safeFetch'
import { answerRgbPng } from '../pictures/pythonView'
import { imageUrlOf } from '../imageUrl'
import { LORA_SIDECAR_UNREADABLE, pyJsonTruthy, readLoraSidecar, resolveTrainedModel, type LoraSidecar } from '../loraFiles'
import type { NodePlan, PipelineIO, PlanContext } from '../executors'
import type { OutputFile, RunnerValue } from '../types'
import { firstOutputUrl } from './repair'

export { resolveTrainedModel } from '../loraFiles'
export {
  bareOwnerModel, foldPromptIn, isReplicateModelRef, multiloraCollect, normalizeLoraRef, replicateModelToLoraRef,
} from '#shared/runner/lora'

/** Python raises "Replicate returned no output" after the call: plain words. */
export const LORA_NO_PICTURE = 'The service sent back no picture'

// ── The HuggingFace look-up (ruling (h)) ──

/** Whether huggingface.co has a model `repo` (its API answers 200). */
export type HuggingFaceLookup = (repo: string, o: { hosted: boolean }) => Promise<boolean>

export const HUGGINGFACE_LOOKUP_TIMEOUT_MS = 8_000
const HUGGINGFACE_LOOKUP_MAX_BYTES = 16 * 1024 * 1024

/** The look-up as Python makes it: GET https://huggingface.co/api/models/<repo>, 8 s, through the safe fetcher. */
const safeHuggingFaceLookup: HuggingFaceLookup = async (repo, o) => {
  const words = {
    refused: 'The LoRA look-up points at a private network address, which is not allowed',
    tooLarge: 'The LoRA look-up’s answer is too large',
    timeout: 'The LoRA look-up took longer than 8 seconds',
  }
  const r = await safeFetch(`https://huggingface.co/api/models/${repo}`, {
    hosted: o.hosted, loopbackView: false, timeoutMs: HUGGINGFACE_LOOKUP_TIMEOUT_MS, maxBytes: HUGGINGFACE_LOOKUP_MAX_BYTES, accept: 'application/json', words,
  })
  return r.status === 200
}

let huggingFaceLookup: HuggingFaceLookup = safeHuggingFaceLookup

/** Tests: a fake look-up (no network); null puts the real one back. */
export function __setHuggingFaceLookupForTests(fn: HuggingFaceLookup | null): void {
  huggingFaceLookup = fn ?? safeHuggingFaceLookup
}

/**
 * `_autodetect_huggingface` (nodes_replicate.py:162-192): a bare reference
 * whose `owner/model` huggingface.co knows is sent as `huggingface.co/<ref>`;
 * anything else (and any failure of the look-up) as it is, stripped.
 */
export async function autodetectHuggingface(ref: string, o: { hosted: boolean }): Promise<string> {
  const stripped = pyStrip(ref ?? '')
  const repo = huggingfaceLookupRepo(stripped)
  if (!repo) return stripped
  try {
    if (await huggingFaceLookup(repo, o)) return `huggingface.co/${stripped}`
  }
  catch { /* Python: `except Exception: pass` */ }
  return stripped
}

// ── The order toggle (ruling (g)): the runner's own, process-wide ──

const rotation = { n: 0 }

/** The toggle as it stands (1: the next multi-LoRA call with two or more LoRAs goes in the order it was toggled from). */
export function multiLoraRotation(): number {
  return rotation.n
}

/** Tests: set the toggle. */
export function __setMultiLoraRotationForTests(n: 0 | 1): void {
  rotation.n = n
}

// ── Sidecars (replicate_refs.py), from ../loraFiles.ts ──

/** A sidecar value that must be text: Python calls `.strip()` on it; anything else truthy fails there. */
function sidecarText(v: PyJson | undefined): string {
  if (typeof v === 'string') return v
  throw new Error(LORA_SIDECAR_UNREADABLE)
}

/** `_resolve_lora_url` (:160-174): `replicate_model` in slash form, else `replicate_url` as it is (null: nothing). */
export function resolveLoraUrl(meta: LoraSidecar | null): PyJson | null {
  if (meta === null) return null
  const model = meta.get('replicate_model')
  if (pyJsonTruthy(model)) return replicateModelToLoraRef(sidecarText(model))
  return meta.get('replicate_url') ?? null
}

/** `_resolve_lora_weights_url` (:177-193): `replicate_url`, stripped, or null. */
export function resolveLoraWeightsUrl(meta: LoraSidecar | null): string | null {
  if (meta === null) return null
  const url = meta.get('replicate_url')
  return typeof url === 'string' && pyStrip(url) ? pyStrip(url) : null
}

/** A sidecar reader (../loraFiles.ts readLoraSidecar; tests pass their own). */
export type SidecarReader = (name: string) => Promise<LoraSidecar | null>

/**
 * `resolve_flux_lora_plan` (:233-249) with its caller's HuggingFace look-up
 * (:646-651): the trained model to run, or the `lora_weights` for
 * flux-dev-lora (null: none). The sidecar is read only where Python reads it.
 */
export async function resolveFluxLoraPlan(
  name: unknown, url: unknown, read: SidecarReader, o: { hosted: boolean },
): Promise<{ trainedModel: string, loraWeights: null } | { trainedModel: null, loraWeights: string | null }> {
  const link = pyStrip(typeof url === 'string' ? url : '')
  if (link && isReplicateModelRef(link)) return { trainedModel: bareOwnerModel(link), loraWeights: null }
  const picked = typeof name === 'string' ? name : ''
  let meta: LoraSidecar | null | undefined
  const sidecar = async () => (meta === undefined ? (meta = await read(picked)) : meta)
  const trained = link ? null : resolveTrainedModel(await sidecar())
  if (trained) return { trainedModel: trained, loraWeights: null }
  const ref: PyJson | null = normalizeLoraRef(link) || resolveLoraUrl(await sidecar())
  if (!pyJsonTruthy(ref ?? null)) return { trainedModel: null, loraWeights: null }
  return { trainedModel: null, loraWeights: await autodetectHuggingface(sidecarText(ref ?? undefined), o) }
}

// ── A widget as ComfyUI hands it to execute ──

function text(inputs: Record<string, unknown>, name: string, def: string): string {
  const v = inputs[name]
  if (v === undefined || v === null) return def
  if (typeof v !== 'string') throw new Error('This setting must be text')
  return v
}

function int(inputs: Record<string, unknown>, name: string, def: number): number {
  const v = inputs[name]
  if (v === undefined || v === null) return def
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'boolean') return Number(v)
  if (typeof v === 'string') {
    const n = pyIntOf(v)
    if (n !== null) return n
  }
  throw new Error('This number setting must be a whole number')
}

function float(inputs: Record<string, unknown>, name: string, def: number): number {
  const v = inputs[name]
  if (v === undefined || v === null) return def
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'boolean') return Number(v)
  if (typeof v === 'string') {
    const n = pyFloatOf(v)
    if (n !== null && Number.isFinite(n)) return n
  }
  throw new Error('This number setting must be a number')
}

// ── What each node sends ──

/**
 * FluxLoRARemoteNode.execute (:618-656): the request, given the plan
 * (`resolveFluxLoraPlan`) and the picture's link (image-to-image), or null.
 */
export function fluxLoraInput(
  inputs: Record<string, unknown>,
  plan: { trainedModel: string | null, loraWeights: string | null },
  image: string | null,
): { endpoint: string, payload: Record<string, unknown> } {
  const payload: Record<string, unknown> = {
    prompt: text(inputs, 'prompt', ''),
    aspect_ratio: text(inputs, 'aspect_ratio', '1:1'),
    megapixels: text(inputs, 'megapixels', '1'),
    num_inference_steps: int(inputs, 'num_inference_steps', FLUX_LORA_STEPS.default),
    num_outputs: 1,
    output_format: 'png',
    disable_safety_checker: false,
  }
  const seed = int(inputs, 'seed', 0)
  if (seed > 0) payload.seed = seed
  if (image !== null) {
    payload.image = image
    payload.prompt_strength = float(inputs, 'prompt_strength', 0.8)
  }
  const guidance = float(inputs, 'guidance', 3.5)
  const loraScale = float(inputs, 'lora_scale', 1.0)
  if (plan.trainedModel) {
    // The trainer's baked-in model names it `guidance_scale`.
    payload.guidance_scale = guidance
    payload.lora_scale = loraScale
    return { endpoint: plan.trainedModel, payload }
  }
  payload.guidance = guidance
  if (plan.loraWeights !== null) {
    payload.lora_weights = plan.loraWeights
    payload.lora_scale = loraScale
  }
  return { endpoint: FLUX_DEV_LORA_SLUG, payload }
}

/** The prompt Flux Dev + LoRAs sends (:883-887): prompt_in folded ahead of the prompt, then the taste ahead of everything. */
export function multiLoraPrompt(inputs: Record<string, unknown>): string {
  const prompt = foldPromptIn(text(inputs, 'prompt', ''), text(inputs, 'prompt_in', ''))
  const style = pyStrip(text(inputs, 'style_in', ''))
  return style ? pyStrip(`${style} ${prompt}`) : prompt
}

/** Each slot's LoRA as Python resolves it (:895-907): its link (normalised, looked up), else its picked LoRA's weights. */
export async function multiLoraSlots(inputs: Record<string, unknown>, read: SidecarReader, o: { hosted: boolean }): Promise<{ loras: string[], scales: number[] }> {
  const resolved: (readonly [string | null, number])[] = []
  for (const s of MULTI_LORA_SLOTS) {
    const link = pyStrip(text(inputs, s.url, ''))
    const ref = link
      ? await autodetectHuggingface(normalizeLoraRef(link), o)
      : resolveLoraWeightsUrl(await read(text(inputs, s.name, '[None]')))
    resolved.push([ref, float(inputs, s.scale, s.def)] as const)
  }
  return multiloraCollect(resolved)
}

/** FluxMultiLoRARemoteNode.execute (:933-950): the request for these LoRAs, in this order. */
export function fluxMultiLoraInput(
  inputs: Record<string, unknown>, loras: readonly string[], scales: readonly number[], image: string | null,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    prompt: multiLoraPrompt(inputs),
    aspect_ratio: text(inputs, 'aspect_ratio', '1:1'),
    num_inference_steps: int(inputs, 'num_inference_steps', FLUX_LORA_STEPS.default),
    guidance_scale: float(inputs, 'guidance', 3.5),
    hf_loras: [...loras],
    lora_scales: [...scales],
    num_outputs: 1,
    output_format: 'png',
    disable_safety_checker: false,
  }
  const seed = int(inputs, 'seed', 0)
  if (seed > 0) payload.seed = seed
  if (image !== null) {
    payload.image = image
    payload.prompt_strength = float(inputs, 'prompt_strength', 0.8)
  }
  return payload
}

/**
 * `_loaded(p)` (:952-953): "Downloading LoRA weights" in `p.get("logs") or ""`
 * — a substring of a text, an item of a list, a key of a dict, as Python's
 * `in` reads each; any other kind of logs makes Python fail there.
 */
export function loraWeightsLoaded(result: unknown): boolean {
  const logs = result && typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, unknown>).logs : undefined
  if (logs === undefined || logs === null || logs === false || logs === '' || logs === 0) return false
  if (typeof logs === 'string') return logs.includes(LORA_LOADED_MARKER)
  if (Array.isArray(logs)) return logs.some(x => x === LORA_LOADED_MARKER)
  if (typeof logs === 'object') return Object.prototype.hasOwnProperty.call(logs, LORA_LOADED_MARKER)
  throw new Error('The service’s answer is in a form Sailor can’t read')
}

// ── The plans ──

/** The linked picture's provider link (image-to-image), or null when none is wired. */
async function imageOf(ctx: PlanContext, inputs: Record<string, unknown>): Promise<string | null> {
  const link = inputs.image
  if (!isLink(link)) return null
  const file = ctx.filesFrom(link)[0]
  if (!file) throw new Error('There is no picture to work on')
  return imageUrlOf(ctx, file, link)
}

/** One multi-LoRA call's price basis (the price module's figure: its card at the steps sent). */
function multiCallUsd(inputs: Record<string, unknown>): number {
  const usd = paidCallUsd({ endpoint: FLUX_MULTI_LORA_SLUG, steps: int(inputs, 'num_inference_steps', FLUX_LORA_STEPS.default) })
  if (usd == null) throw new Error('Flux Dev + LoRAs has no price yet')
  return usd
}

const sameList = (a: unknown, b: readonly unknown[]) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i])

/** The node's plan. `read`: the sidecar reader (tests pass their own). */
export async function planLora(ctx: PlanContext, read: SidecarReader = readLoraSidecar): Promise<NodePlan> {
  const node = ctx.prompt[ctx.nodeId]!
  const inputs = node.inputs ?? {}
  const o = { hosted: !!ctx.hosted }
  if (node.class_type === FLUX_LORA_CLASS) {
    const plan = await resolveFluxLoraPlan(inputs.lora_name, inputs.lora_url, read, o)
    const { endpoint, payload } = fluxLoraInput(inputs, plan, await imageOf(ctx, inputs))
    // A guidance flux-dev-lora's schema refuses (Python sends it; Replicate refuses the request): before the call.
    const tooHigh = endpoint === FLUX_DEV_LORA_SLUG ? fluxLoraGuidanceProblem(inputs) : null
    if (tooHigh) throw new Error(tooHigh.message)
    return {
      kind: 'provider', provider: 'replicate', endpoint, payload,
      media: 'image', take: 'first', rgb: true,
      urlsOf: firstOutputUrl,
      prefix: 'flux_lora',
      uiFor: files => ({ images: files, animated: [false] }),
    }
  }
  const { loras, scales } = await multiLoraSlots(inputs, read, o)
  if (!loras.length) throw new Error(MULTI_LORA_NEEDS_LORA)
  const image = await imageOf(ctx, inputs)
  const usd = multiCallUsd(inputs)
  const reversed = [[...loras].reverse(), [...scales].reverse()] as const
  return {
    kind: 'pipeline', prefix: 'flux_multilora',
    run: async (io: PipelineIO) => {
      // The order of the first call: a resumed node keeps the one written down; else the toggle (two or more LoRAs).
      let order: readonly [readonly string[], readonly number[]] = [loras, scales]
      const sent = io.recorded?.('first') ?? null
      if (sent && sameList(sent.hf_loras, reversed[0]) && sameList(sent.lora_scales, reversed[1])) order = reversed
      else if (!(sent && sameList(sent.hf_loras, loras)) && loras.length >= 2) {
        rotation.n ^= 1
        if (rotation.n) order = reversed
      }
      const first = await io.call({
        key: 'first', provider: 'replicate', endpoint: FLUX_MULTI_LORA_SLUG, payload: fluxMultiLoraInput(inputs, order[0], order[1], image), media: 'image', usd,
      })
      let last = first
      let lastKey = 'first'
      if (loras.length >= 2 && !loraWeightsLoaded(first.result)) {
        // Skipped on a warm container: once more, the order flipped (:955-968).
        const flipped = [[...order[0]].reverse(), [...order[1]].reverse()] as const
        last = await io.call({
          key: 'retry', provider: 'replicate', endpoint: FLUX_MULTI_LORA_SLUG, payload: fluxMultiLoraInput(inputs, flipped[0], flipped[1], image), media: 'image', usd,
        })
        lastKey = 'retry'
      }
      const url = firstOutputUrl(last.result)[0]
      if (!url) throw new Error(LORA_NO_PICTURE)
      // The picture as Python's tensor saves it: alpha dropped (rule 3).
      const picture: OutputFile = await io.savedOnce(lastKey, 'picture', async () => {
        const got = await io.download(url)
        return io.saveAsset(await answerRgbPng(got.bytes), { prefix: 'flux_multilora', ext: 'png' })
      })
      const values: Record<number, RunnerValue> = { 0: { kind: 'files', files: [picture] } }
      return { values, ui: { images: [picture], animated: [false] } }
    },
  }
}
