/**
 * The calls a paid node's settings can make (step 3, R3), for its price: the
 * hold, the badge and the charge all read `paidCalls` through priceNode
 * (nodePrice.ts), on both paths. Each R3 task adds its classes' planners
 * here (R3.3: the seven LLM text nodes); every other class keeps its flat
 * row in GRAPH_NODE_CREDITS (server/utils/priceBook.ts) until its own task
 * removes that row.
 *
 * A planner gives the calls at their most expensive where an input is linked
 * (known only at run time), the most a text model can be sent and can answer
 * (ruling (c), `tokenCeiling`: one token per UTF-8 byte of text sent, each
 * moderated text at most the moderation limit in hosted, plus Sailor's own
 * fixed prompt text, plus the node's longest answer), and every call a pipeline may make. Given
 * `opts.answerUsage` (what the answer reported) it gives the calls as used,
 * for the charge; priceNode never lets that exceed the hold.
 *
 * Rule (c) is implemented once, in `tokenCeiling`: every text model's
 * planner builds its ceiling from it.
 *
 * `paidNoCall` says, from the inputs as sent, when Python returns before
 * calling anyone (rule 8): the stage hold skips such a node
 * (server/runner/metering.ts stageEstimate), as it skips a nano action that
 * hands its picture on, and priceGraph charges it nothing on both paths
 * (R3.15). It covers a class priced elsewhere too (Pose Mannequin, by the
 * nano actions' call in editSettings.ts).
 *
 * Pure; relative imports only (Nitro, the app and vitest all load it).
 */
import type { NodeInputs, PriceOptions } from './nodePrice'
import type { PaidCall } from './paidRates'
import { isLink } from '../runner/graph'
import { paidCallUsd } from './paidRates'
import {
  BRAINSTORM_ANGLES, CHAT_LLM_MODELS, IMPROVE_PROMPT_TARGETS, REASON_MODELS, REWRITE_MODELS, REWRITE_TONES, SUMMARIZE_MODELS, TRANSLATE_LANGUAGES,
  BRAINSTORM_MAX_TOKENS, LLM_MODEL_SLUGS, LLM_NO_CALL_INPUT, LLM_TEXT_INPUTS, REASON_MAX_TOKENS, REWRITE_MAX_TOKENS,
  SUMMARIZE_LENGTHS, SUMMARIZE_MAX_TOKENS, TRANSLATE_MAX_TOKENS, brainstormCount, brainstormSystem, improvePromptSystem, isBlank,
  reasonSystem, rewriteSystem, summarizeSystem, translateSystem, type LlmTextClass,
} from '../runner/llm'
import { pyStrip, pyTruthy } from '../runner/pyText'
import {
  DESCRIBE_CLASSES, DESCRIBE_ENDPOINTS, DESCRIBE_VIDEO_MAX_ANSWER_TOKENS, DESCRIBE_VIDEO_MAX_SECONDS, DESCRIBE_VIDEO_TOKENS_PER_SECOND,
  type DescribeClass,
} from '../runner/describe'
import { REPAIR_PER_CALL_CLASSES, REPAIR_PER_CALL_ENDPOINTS, type RepairPerCallClass } from '../runner/repair'
import {
  LAYERIZE_SLUG, OUTPAINT_SLUGS, PHOTO_FILL_SLUGS, SEEDREAM_1K_AREA, SEEDREAM_LAYERIZE_APP, SEEDREAM_MAX_IMAGES, SPLIT_CLASS, SPLIT_CUTOUT_SLUG,
  type OutpaintModel, type PhotoFill,
} from '../runner/layers'
import {
  AUDIO_GEN_CLASSES, AUDIO_GEN_ENDPOINTS, MUSIC_DEFAULT_SECONDS, MUSIC_MAX_SECONDS, MUSIC_MIN_SECONDS, SPEECH_MAX_CHARS,
  isSpeechClass, speechChars, type AudioGenClass,
} from '../runner/audioGen'
import { GEN_3D_CLASSES, GEN_3D_STEPS, HUNYUAN3D_MV_SLUG, HUNYUAN3D_SLUG, MULTI_VIEW_CLASS, multiViewSlugsOf } from '../runner/gen3d'
import { FACE_SLUG, SKETCH_SLUG, textEffectSlug } from '../runner/imageExtras'
import { FLUX_DEV_LORA_SLUG, FLUX_LORA_STEPS, FLUX_MULTI_LORA_SLUG, RESTYLE_LORA_CLASS, multiLoraCount } from '../runner/lora'
import { editSteps } from './editSettings'
import { POSE_MANNEQUIN_CLASS, poseNoCall, type PoseKnown } from '../runner/nanoExtras'
import {
  TURNTABLE_ASPECT_RATIO, TURNTABLE_CLASS, TURNTABLE_DEFAULT_DIRECTION, TURNTABLE_FRONT_MODEL, TURNTABLE_SECONDS, TURNTABLE_VIEWS_MODEL,
  planSegments, turntableViews,
} from '../runner/turntable'
import { effectiveVideoSettings } from './videoSettings'
import type { EditCall } from './editRates'

/**
 * The most bytes of one moderated text in hosted (server/utils/moderation.ts
 * MODERATION_MAX_INPUT_BYTES: a longer text is refused before the hold). A
 * test keeps the two equal; shared code can't import the server's.
 */
export const TOKEN_TEXT_CAP_BYTES = 32_768

const UTF8 = new TextEncoder()

/** A text's size in UTF-8 bytes (what the moderation limit and a token ceiling count). */
export function utf8Bytes(text: string): number {
  return UTF8.encode(text).length
}

/** What a text node sends, for its token ceiling. */
export interface TokenTexts {
  /** The user's texts as typed, each moderated on its own. */
  texts: readonly string[]
  /** How many of the user's texts are linked (known only at run time): each counted at the cap. */
  linkedTexts?: number
  /** Sailor's own fixed text sent with them (system prompts, templates): counted whole, never capped. */
  fixed?: readonly string[]
  /** The node's longest answer, in tokens (its max-tokens setting). */
  maxAnswerTokens: number
}

/**
 * Ruling (c)'s ceiling for a text model's call, in tokens, counted
 * generously as one token per UTF-8 byte:
 *  - input: the user's texts (hosted: each at most TOKEN_TEXT_CAP_BYTES, as
 *    moderation refuses a longer one; local: whole), a linked text at the cap
 *    (local runs are free, so this bound only shows on the badge), or the
 *    caller's measured `opts.inputBytes` in their place (hosted: at most the
 *    cap per text); plus Sailor's fixed text, never capped;
 *  - output: the node's longest answer.
 */
export function tokenCeiling(t: TokenTexts, opts: Pick<PriceOptions, 'inputBytes' | 'hosted'> = {}): { inputTokens: number, outputTokens: number } {
  const linked = Math.max(0, t.linkedTexts ?? 0)
  const cap = (bytes: number) => (opts.hosted ? Math.min(bytes, TOKEN_TEXT_CAP_BYTES) : bytes)
  const measured = opts.inputBytes
  const user = typeof measured === 'number' && Number.isFinite(measured) && measured >= 0
    ? (opts.hosted ? Math.min(measured, TOKEN_TEXT_CAP_BYTES * Math.max(1, t.texts.length + linked)) : measured)
    : t.texts.reduce((sum, text) => sum + cap(utf8Bytes(text)), 0) + linked * TOKEN_TEXT_CAP_BYTES
  const fixed = (t.fixed ?? []).reduce((sum, text) => sum + utf8Bytes(text), 0)
  return { inputTokens: user + fixed, outputTokens: t.maxAnswerTokens }
}

/** The calls a node makes: each call `times` times in one run, or the reason it can't be priced. */
export type PaidCalls = { steps: { call: PaidCall, times: number }[] } | { refused: string }

type PaidPlanner = (inputs: NodeInputs, opts: PriceOptions) => PaidCalls

// ── R3.3: the LLM text nodes (#shared/runner/llm) ──

/** What one LLM text node's call is priced from: its endpoint, Sailor's own text, its longest answer. */
interface LlmCallShape { endpoints: string[]; fixed: string[]; maxAnswerTokens: number }

const text = (v: unknown): string => (typeof v === 'string' ? v : '')
const intIn = (v: unknown, def: number, lo: number, hi: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v) ? Number.parseInt(v, 10) : def
  return Math.min(hi, Math.max(lo, n))
}
const slugOf = (model: unknown): string | null => {
  const row = typeof model === 'string' && Object.prototype.hasOwnProperty.call(LLM_MODEL_SLUGS, model) ? LLM_MODEL_SLUGS[model] : undefined
  return row ? row[0] : null
}
/**
 * The endpoints a `model` setting can mean: the one it names, or, wired (known
 * only at run time) or missing, every model the node offers (the planner
 * prices the dearest). Empty for a model Sailor doesn't know.
 */
const endpointsOf = (model: unknown, offered: readonly string[]): string[] => {
  if (isLink(model) || model === undefined) return offered.map(m => slugOf(m)!)
  const one = slugOf(model)
  return one ? [one] : []
}
/**
 * Sailor's system text for a combo setting: as picked, or, wired or not one
 * of the node's options, the longest the options make, in UTF-8 bytes (a
 * price never guesses low).
 */
const systemFor = (v: unknown, options: readonly string[], make: (option: string) => string): string => {
  if (typeof v === 'string' && options.includes(v)) return make(v)
  return options.map(make).reduce((a, b) => (utf8Bytes(b) > utf8Bytes(a) ? b : a))
}

/**
 * Each class's call as its settings make it (the same request the runner
 * builds, #shared/runner/llm): the endpoints `model` can mean, Sailor's
 * system text (counted whole), the answer limit sent. A setting known only at
 * run time (wired) is priced at its dearest.
 */
const LLM_CALL_SHAPES: Readonly<Record<LlmTextClass, (i: NodeInputs) => LlmCallShape>> = {
  // Chat's system prompt is the user's text (LLM_TEXT_INPUTS), not Sailor's.
  ChatLLMNode: i => ({ endpoints: endpointsOf(i.model, CHAT_LLM_MODELS), fixed: [], maxAnswerTokens: isLink(i.max_tokens) ? 8192 : intIn(i.max_tokens, 8192, 1, 8192) }),
  ImprovePromptNode: i => ({ endpoints: ['openai/gpt-5-nano'], fixed: [systemFor(i.target, IMPROVE_PROMPT_TARGETS, improvePromptSystem)], maxAnswerTokens: 200 }),
  SummarizeTextNode: i => ({
    endpoints: endpointsOf(i.model, SUMMARIZE_MODELS), fixed: [systemFor(i.length, Object.keys(SUMMARIZE_LENGTHS), summarizeSystem)], maxAnswerTokens: SUMMARIZE_MAX_TOKENS,
  }),
  // The target language: a typed custom one is the user's text (counted there); else the picked one.
  TranslateTextNode: (i) => {
    const custom = isLink(i.custom_language) ? '' : pyStrip(text(i.custom_language))
    const fixed = custom ? translateSystem('') : systemFor(i.target_language, TRANSLATE_LANGUAGES, translateSystem)
    return { endpoints: ['google/gemini-3-flash'], fixed: [fixed], maxAnswerTokens: TRANSLATE_MAX_TOKENS }
  },
  RewriteToneNode: i => ({
    endpoints: endpointsOf(i.model, REWRITE_MODELS),
    // A tone typed outside the list is sent as Python words it (rewriteSystem's fallback).
    fixed: [typeof i.tone === 'string' && i.tone ? rewriteSystem(i.tone) : systemFor(i.tone, REWRITE_TONES, rewriteSystem)],
    maxAnswerTokens: REWRITE_MAX_TOKENS,
  }),
  BrainstormIdeasNode: (i) => {
    const count = isLink(i.count) ? 12 : intIn(brainstormCount(i), 12, 2, 12)
    return { endpoints: ['openai/gpt-5-mini'], fixed: [systemFor(i.angle, Object.keys(BRAINSTORM_ANGLES), a => brainstormSystem(count, a))], maxAnswerTokens: BRAINSTORM_MAX_TOKENS }
  },
  ReasonStepByStepNode: (i) => {
    const fixed = isLink(i.include_reasoning)
      ? systemFor(undefined, ['shown', 'hidden'], o => reasonSystem(o === 'shown'))
      : reasonSystem(pyTruthy(i.include_reasoning))
    return { endpoints: endpointsOf(i.model, REASON_MODELS), fixed: [fixed], maxAnswerTokens: REASON_MAX_TOKENS }
  },
}

/** What a node whose model Sailor doesn't know is refused with (plain words, shown on the node). */
export const LLM_MODEL_UNPRICED = 'This model has no price yet. Pick another model.'

/**
 * An LLM text node's one call: its ceiling (ruling (c), tokenCeiling: the
 * user's texts as typed, a wired one at the cap, Sailor's system text whole,
 * the answer limit sent) on the dearest endpoint its `model` can mean, or,
 * with `answerUsage`, the tokens the answer reported on that same endpoint's
 * card (the charge; priceNode caps it at the ceiling).
 */
function llmPlanner(classType: LlmTextClass): PaidPlanner {
  return (inputs, opts) => {
    const shape = LLM_CALL_SHAPES[classType](inputs)
    if (!shape.endpoints.length) return { refused: LLM_MODEL_UNPRICED }
    const names = LLM_TEXT_INPUTS[classType]
    const linkedTexts = names.filter(n => isLink(inputs[n])).length
    const texts = names.filter(n => !isLink(inputs[n])).map(n => text(inputs[n]))
    const { answerUsage, ...rest } = opts
    const t = tokenCeiling({ texts, linkedTexts, fixed: shape.fixed, maxAnswerTokens: shape.maxAnswerTokens }, rest)
    // The dearest endpoint at this ceiling (one, unless `model` is wired). An unpriced one prices at null: refused later.
    const usd = (endpoint: string) => paidCallUsd({ endpoint, ...t }) ?? Number.POSITIVE_INFINITY
    const endpoint = shape.endpoints.reduce((a, b) => (usd(b) > usd(a) ? b : a))
    if (answerUsage) return { steps: [{ call: { endpoint, inputTokens: answerUsage.inputTokens, outputTokens: answerUsage.outputTokens }, times: 1 }] }
    return { steps: [{ call: { endpoint, ...t }, times: 1 }] }
  }
}

// ── R3.4: describe, read and find (#shared/runner/describe) ──

/**
 * Seconds of video Describe a video is priced on: as measured (the runner
 * reads an uploaded file before the hold, ruling (s)), else the longest
 * video Gemini takes (an address typed in, or the ComfyUI path).
 */
function describeVideoSeconds(opts: PriceOptions): number {
  const s = opts.inputSeconds?.video
  return typeof s === 'number' && Number.isFinite(s) && s > 0 ? s : DESCRIBE_VIDEO_MAX_SECONDS
}

/**
 * A describe node's one call. Describe a video by the token (ruling (c)):
 * the prompt as tokenCeiling counts it plus the video's tokens (its length ×
 * DESCRIBE_VIDEO_TOKENS_PER_SECOND, rounded up), and Gemini's longest answer;
 * with `answerUsage`, what the prediction reported. The others per call.
 */
function describePlanner(classType: DescribeClass): PaidPlanner {
  const endpoint = DESCRIBE_ENDPOINTS[classType]
  if (classType !== 'DescribeVideoNode') return () => ({ steps: [{ call: { endpoint }, times: 1 }] })
  return (inputs, opts) => {
    const { answerUsage, ...rest } = opts
    if (answerUsage) return { steps: [{ call: { endpoint, inputTokens: answerUsage.inputTokens, outputTokens: answerUsage.outputTokens }, times: 1 }] }
    const linked = isLink(inputs.prompt)
    const t = tokenCeiling({ texts: linked ? [] : [text(inputs.prompt)], linkedTexts: linked ? 1 : 0, maxAnswerTokens: DESCRIBE_VIDEO_MAX_ANSWER_TOKENS }, rest)
    const video = Math.ceil(describeVideoSeconds(rest) * DESCRIBE_VIDEO_TOKENS_PER_SECOND)
    return { steps: [{ call: { endpoint, inputTokens: t.inputTokens + video, outputTokens: t.outputTokens }, times: 1 }] }
  }
}

// ── R3.5: restore and remove background (#shared/runner/repair) ──

/**
 * Restore an old photo and Remove background (and their twins): one call
 * each, whatever their settings (the price per call, paidRates.ts). Upscale
 * and Enhance detail are not here: they keep their price by the picture's
 * size (editSettings.ts editCalls).
 */
function repairPlanner(classType: RepairPerCallClass): PaidPlanner {
  const endpoint = REPAIR_PER_CALL_ENDPOINTS[classType]
  return () => ({ steps: [{ call: { endpoint }, times: 1 }] })
}

// ── R3.6: layers from one call, and outpaint (#shared/runner/layers) ──

/**
 * Layerize an image's call on fal, billed by the picture it makes: the hold
 * is the most it can make (SEEDREAM_MAX_IMAGES) at the rate its size can
 * reach (`auto_1K` stays under the page's area line; every other size, a
 * wired one or one the node doesn't offer, is held at the dearer rate). The
 * charge is the call as answered (`seedreamCallAnswered`): the runner prices
 * what came back from this same card, never above this.
 */
export function seedreamCallCeiling(inputs: NodeInputs): PaidCall {
  const size = inputs.image_size
  return { endpoint: SEEDREAM_LAYERIZE_APP, outputImages: SEEDREAM_MAX_IMAGES, outputPixels: size === 'auto_1K' ? SEEDREAM_1K_AREA : null }
}

/** Layerize an image's call as answered: the pictures that came back and their area (null: not known, the dearer rate). */
export function seedreamCallAnswered(images: number, pixels: number | null): PaidCall {
  return { endpoint: SEEDREAM_LAYERIZE_APP, outputImages: images, outputPixels: pixels }
}

/** Outpaint's engine as set, or, wired or not one it offers, each (the dearest is priced). */
function outpaintEndpoints(model: unknown): string[] {
  const own = typeof model === 'string' && Object.prototype.hasOwnProperty.call(OUTPAINT_SLUGS, model)
  return own ? [OUTPAINT_SLUGS[model as OutpaintModel]] : Object.values(OUTPAINT_SLUGS)
}

const LAYERS_PLANNERS: Readonly<Record<string, PaidPlanner>> = {
  // Separate text from image: one call, whatever its settings.
  LayerizeGraphicNode: () => ({ steps: [{ call: { endpoint: LAYERIZE_SLUG }, times: 1 }] }),
  SeedreamLayerizeNode: inputs => ({ steps: [{ call: seedreamCallCeiling(inputs), times: 1 }] }),
  // Expand / outpaint: one call on its engine's card (a wired engine at the dearest).
  OutpaintImageNode: (inputs) => {
    const endpoints = outpaintEndpoints(inputs.model)
    const usd = (e: string) => paidCallUsd({ endpoint: e }) ?? Number.POSITIVE_INFINITY
    return { steps: [{ call: { endpoint: endpoints.reduce((a, b) => (usd(b) > usd(a) ? b : a)) }, times: 1 }] }
  },
}

// ── R3.7: Separate background and foreground (#shared/runner/layers) ──

/** The fill engine as set, or, wired or not one it offers (or missing), each (the dearest is priced). */
function splitFillEndpoints(fill: unknown): string[] {
  const own = typeof fill === 'string' && Object.prototype.hasOwnProperty.call(PHOTO_FILL_SLUGS, fill)
  return own ? [PHOTO_FILL_SLUGS[fill as PhotoFill]] : Object.values(PHOTO_FILL_SLUGS)
}

/**
 * Separate background and foreground: the cut-out (Remove background's card)
 * and the fill on its engine's card, once each: every call it makes. Python's
 * third call, the remover's matte for a cut-out without alpha, can't happen
 * (a downloaded picture is always read as RGBA: the cut-out always has an
 * alpha; the R3.7 fixture proves it), so it is never held. The runner charges
 * the calls that finished (ruling (f)).
 */
function splitPlanner(inputs: NodeInputs): PaidCalls {
  const usd = (e: string) => paidCallUsd({ endpoint: e }) ?? Number.POSITIVE_INFINITY
  const fill = splitFillEndpoints(inputs.background_fill).reduce((a, b) => (usd(b) > usd(a) ? b : a))
  return { steps: [{ call: { endpoint: SPLIT_CUTOUT_SLUG }, times: 1 }, { call: { endpoint: fill }, times: 1 }] }
}

// ── R3.8: music and speech (#shared/runner/audioGen) ──

/**
 * Generate music (and its twin): one MusicGen call billed by the seconds it
 * asks for (`duration`, 1–30 as ComfyUI validates it); a wired one at the
 * longest (30 s), an unreadable one at the node's default (8 s: ComfyUI's
 * validation and the runner's INT widget both refuse it before a run). Generate speech (and its twin): one MiniMax call
 * by the characters of its text (Python's `len`); a wired text at the most
 * the model reads (SPEECH_MAX_CHARS: a longer one is refused before it is
 * sent), or, with `opts.inputChars`, the characters it sent (the charge;
 * priceNode caps it at the hold).
 */
function audioGenPlanner(classType: AudioGenClass): PaidPlanner {
  const endpoint = AUDIO_GEN_ENDPOINTS[classType]
  if (!isSpeechClass(classType)) {
    return (inputs) => {
      const d = inputs.duration
      const seconds = isLink(d) ? MUSIC_MAX_SECONDS : intIn(d, MUSIC_DEFAULT_SECONDS, MUSIC_MIN_SECONDS, MUSIC_MAX_SECONDS)
      return { steps: [{ call: { endpoint, outputSeconds: seconds }, times: 1 }] }
    }
  }
  return (inputs, opts) => {
    const sent = opts.inputChars
    const chars = typeof sent === 'number' && Number.isFinite(sent) && sent >= 0
      ? sent
      : isLink(inputs.text) ? SPEECH_MAX_CHARS : speechChars(text(inputs.text))
    return { steps: [{ call: { endpoint, chars }, times: 1 }] }
  }
}

// ── R3.9: 3D models (#shared/runner/gen3d) ──

/**
 * Generate a 3D model (and its twin): one Hunyuan3D 2 call, whatever its
 * settings. Multi-View → 3D: one call on its engine's card (a wired engine
 * at the dearest; a missing one at Python's default, TRELLIS); Hunyuan3D-2mv
 * by the steps it sends (R3.9 fix round 2: a wired count at the node's most,
 * 100; missing, its default, 50).
 */
function gen3dPlanner(classType: string): PaidPlanner {
  if (classType !== MULTI_VIEW_CLASS) return () => ({ steps: [{ call: { endpoint: HUNYUAN3D_SLUG }, times: 1 }] })
  return (inputs) => {
    const steps = isLink(inputs.steps) ? GEN_3D_STEPS.max : intIn(inputs.steps, 50, GEN_3D_STEPS.min, GEN_3D_STEPS.max)
    const callOf = (endpoint: string): PaidCall => (endpoint === HUNYUAN3D_MV_SLUG ? { endpoint, steps } : { endpoint })
    const usd = (c: PaidCall) => paidCallUsd(c) ?? Number.POSITIVE_INFINITY
    const call = multiViewSlugsOf(inputs.engine).map(callOf).reduce((a, b) => (usd(b) > usd(a) ? b : a))
    return { steps: [{ call, times: 1 }] }
  }
}

// ── R3.12: text effect, sketch to image and face references (#shared/runner/imageExtras) ──

/**
 * One call each, whatever the settings: Text effect on the model its path
 * calls (a picture wired in: Flux Kontext Pro restyles it; none: Ideogram V3
 * Turbo generates the word), Sketch to image on Nano Banana (its edit card),
 * Generate face references on Ideogram Character. A generate-mode Text effect
 * with no text makes no call (Python raises first): the runner refuses it
 * before the hold, so it is priced as a call, never held for nothing.
 */
const IMAGE_EXTRAS_PLANNERS: Readonly<Record<string, PaidPlanner>> = {
  TextEffectNode: inputs => ({ steps: [{ call: { endpoint: textEffectSlug(inputs) }, times: 1 }] }),
  SketchToImageNode: () => ({ steps: [{ call: { endpoint: SKETCH_SLUG }, times: 1 }] }),
  ConsistentFaceNode: () => ({ steps: [{ call: { endpoint: FACE_SLUG }, times: 1 }] }),
}

// ── R3.13: Flux Dev + LoRA and Flux Dev + LoRAs (#shared/runner/lora) ──

/**
 * Flux Dev + LoRA: one call, on flux-dev-lora's edit card whatever the LoRA
 * (editRates.ts: $0.04, which covers the user's trained model run directly,
 * billed by GPU time; the price can't read the sidecar that decides which).
 * Flux Dev + LoRAs: flux-dev-multi-lora at the steps sent (a wired number at
 * the most, 50), twice when two or more distinct LoRAs may be stacked (the
 * reload retry, ruling (g)), else once.
 */
const LORA_PLANNERS: Readonly<Record<string, PaidPlanner>> = {
  FluxLoRARemoteNode: () => ({ steps: [{ call: { endpoint: FLUX_DEV_LORA_SLUG }, times: 1 }] }),
  FluxMultiLoRARemoteNode: (inputs) => {
    const steps = isLink(inputs.num_inference_steps)
      ? FLUX_LORA_STEPS.max
      : intIn(inputs.num_inference_steps, FLUX_LORA_STEPS.default, FLUX_LORA_STEPS.min, FLUX_LORA_STEPS.max)
    return { steps: [{ call: { endpoint: FLUX_MULTI_LORA_SLUG, steps }, times: multiLoraCount(inputs) >= 2 ? 2 : 1 }] }
  },
}

// ── R3.14: Restyle an Image · Style LoRA (#shared/runner/lora) ──

/** An edit card's call as a paid call (the same endpoint, tier, pixels and fallbacks: paidCallUsd prices it by its edit card). */
function paidCallOf(c: EditCall): PaidCall {
  return {
    endpoint: c.endpoint, tier: c.tier, inputPixels: c.inputPixels, outputPixels: c.outputPixels,
    ...(c.fallbacks ? { fallbacks: c.fallbacks.map(paidCallOf) } : {}),
  }
}

/**
 * Restyle an Image · Style LoRA's three kinds of call, as editSteps
 * (editSettings.ts) lists them: Moondream (the caption and every verdict),
 * the LoRA's Flux call (flux-dev-lora's edit card, $0.04, which covers the
 * user's trained model the sidecar may name), and a Nano Banana 2 pass on
 * fal at the node's resolution (a linked one at the dearest), with the
 * ComfyUI path's fallbacks (fal Nano Banana Pro, then Replicate) covered at
 * cost. The runner prices each call it sends from these (one calculation).
 */
export function restyleLoraCalls(inputs: NodeInputs): { moondream: { call: PaidCall, times: number }, stylize: { call: PaidCall, times: number }, nanoBanana: { call: PaidCall, times: number } } {
  const [moondream, stylize, nanoBanana] = editSteps(RESTYLE_LORA_CLASS, inputs)!.map(s => ({ call: paidCallOf(s.call), times: s.times }))
  return { moondream: moondream!, stylize: stylize!, nanoBanana: nanoBanana! }
}

/**
 * Every call a run may make, each priced on its own and summed (R3.1's rule;
 * before R3.14 the ComfyUI path marked up the summed dollars, editStepsUsd):
 * Moondream five times (the caption, the verdict on the LoRA's picture, one
 * verdict per pass), the Flux call once, 1 + RESTYLE_LORA_NB_RETRIES passes.
 * The runner charges the calls that finished (ruling (f)).
 */
function restyleLoraPlanner(inputs: NodeInputs): PaidCalls {
  const c = restyleLoraCalls(inputs)
  return { steps: [c.moondream, c.stylize, c.nanoBanana] }
}

// ── R3.16: Turntable (#shared/runner/turntable) ──

/**
 * A Turntable video call: the model's rate card (videoRates.ts, the line-up's
 * Luma Ray 2 and Seedance 2.0 cards) at the settings its request carries
 * (videoSettings.ts, as for Generate a video): 5 s, the ratio 1:1, and the
 * options Python adds (Luma's `loop`; Seedance's last frame, which leaves its
 * sound at fal's default).
 */
function turntableCall(model: string, adv: Record<string, unknown>): PaidCall {
  const s = effectiveVideoSettings(model, TURNTABLE_SECONDS, TURNTABLE_ASPECT_RATIO, adv, true)!
  return { endpoint: model, tier: s.resolution, outputSeconds: s.seconds, audio: s.audio }
}

/**
 * Turntable (ruling (b), on both paths): front only, one Luma Ray 2 720p
 * spin (5 s × $0.18); with right, back or left views wired, one Seedance 2.0
 * 720p arc per segment planSegments plans (2 to 4), each priced on its own.
 * A wired view counts (the dearest plan); a wired or unknown direction plans
 * as many arcs as either direction does.
 */
function turntablePlanner(inputs: NodeInputs): PaidCalls {
  const views = turntableViews(inputs)
  if (!views.length) return { steps: [{ call: turntableCall(TURNTABLE_FRONT_MODEL, { loop: true }), times: 1 }] }
  const direction = typeof inputs.direction === 'string' ? inputs.direction : TURNTABLE_DEFAULT_DIRECTION
  const arcs = planSegments(views, direction).length
  return { steps: [{ call: turntableCall(TURNTABLE_VIEWS_MODEL, { end_image_url: 'end' }), times: arcs }] }
}

/** Python returns "" before calling anyone when the text is blank (typed; a wired one is priced as a call). */
function llmNoCall(classType: LlmTextClass): ((inputs: NodeInputs) => boolean) | null {
  const name = LLM_NO_CALL_INPUT[classType]
  return name ? (inputs: NodeInputs) => !isLink(inputs[name]) && isBlank(inputs[name]) : null
}

const LLM_CLASSES = Object.keys(LLM_CALL_SHAPES) as LlmTextClass[]

/** Each paid class's planner. Filled by each R3 task. */
const PAID_PLANNERS: Readonly<Record<string, PaidPlanner>> = {
  ...Object.fromEntries(LLM_CLASSES.map(c => [c, llmPlanner(c)])),
  ...Object.fromEntries(DESCRIBE_CLASSES.map(c => [c, describePlanner(c)])),
  ...Object.fromEntries(REPAIR_PER_CALL_CLASSES.map(c => [c, repairPlanner(c)])),
  ...LAYERS_PLANNERS,
  [SPLIT_CLASS]: splitPlanner,
  ...Object.fromEntries(AUDIO_GEN_CLASSES.map(c => [c, audioGenPlanner(c)])),
  ...Object.fromEntries(GEN_3D_CLASSES.map(c => [c, gen3dPlanner(c)])),
  ...IMAGE_EXTRAS_PLANNERS,
  ...LORA_PLANNERS,
  [RESTYLE_LORA_CLASS]: restyleLoraPlanner,
  [TURNTABLE_CLASS]: turntablePlanner,
}

/** Each paid class's no-call rule (rule 8), where Python has one. Filled by each R3 task. */
const PAID_NO_CALL: Readonly<Record<string, (inputs: NodeInputs, known: PoseKnown) => boolean>> = {
  ...Object.fromEntries(LLM_CLASSES.flatMap(c => { const r = llmNoCall(c); return r ? [[c, r]] : [] })),
  // R3.15: Pose Mannequin with a saved pose, or nothing to pose with (priced by its call, editSettings.ts, otherwise).
  [POSE_MANNEQUIN_CLASS]: poseNoCall,
}

/** The classes priced by their calls (paidCalls). */
export const PAID_NODE_CLASSES: readonly string[] = Object.keys(PAID_PLANNERS)

const own = <T>(o: Readonly<Record<string, T>>, k: string): T | undefined =>
  (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined)

/**
 * The calls the node's settings can make, at their most expensive where an
 * input is linked. `opts.answerUsage`: what the answer reported (token
 * nodes), for the charge.
 */
export function paidCalls(classType: string, inputs: NodeInputs, opts: PriceOptions): PaidCalls {
  const plan = own(PAID_PLANNERS, classType)
  return plan ? plan(inputs, opts) : { refused: `${classType} is not priced by its calls` }
}

/**
 * True when Python returns before calling anyone, decided from the inputs as
 * sent (rule 8). `known`: what the caller read of the node's files (Pose
 * Mannequin's saved pose, R3.15 fix round 1); none, a file is priced as if it
 * may not load.
 */
export function paidNoCall(classType: string, inputs: NodeInputs, known: PoseKnown = {}): boolean {
  const rule = own(PAID_NO_CALL, classType)
  return !!rule && rule(inputs, known)
}
