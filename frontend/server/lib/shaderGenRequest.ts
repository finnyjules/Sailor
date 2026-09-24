/**
 * Payload for one /api/shader-gen call: one take, strict JSON (the shared take
 * schema), the static system prompt as a cached block. Kept out of the route so
 * it is unit-testable without h3 (same pattern as agentRequest.ts).
 */
import { SHADERGEN_TAKE_SCHEMA } from '~~/shared/shadergen/contract'
import { SHADERGEN_SYSTEM } from '~~/shared/shadergen/system'
import { DEV_MODEL_OVERRIDES, effortForTier, modelForTier, type AiEffort } from './aiModels'
import { badRequest, MAX_IMAGE_CHARS, optionalTier, requireString } from './agentRequest'
import { extractModelText } from './modelText'
import { holdForModelCall } from '../utils/anthropicMeter'
import { maxCreditsForCall } from '../utils/anthropicPrices'
import { MeterRefusalError } from '../utils/requestMeter'
import { captureError } from '../utils/observe'

/** One take: ~1–3k tokens of GLSL + dials, with generous headroom so a long
 *  body isn't cut off mid-JSON. */
export const SHADERGEN_MAX_TOKENS = 10_000
/** A take prompt is the request, at most a base and a few references, and one
 *  rejected body — far below the general agent cap. */
export const SHADERGEN_MAX_PROMPT_CHARS = 80_000

function forbidden(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 403 })
}

/** Only image data URLs: `data:image/<subtype>;base64,<payload>`. */
const IMAGE_DATA_URL = /^data:(image\/[^;]+);base64,(.*)$/s

export interface BuildShaderGenOpts { allowModelOverride?: boolean }

/**
 * `effort: 'high'` (dev-only variant A/B lever) replaces the tier's own
 * effort; `model: 'opus'` (dev-only variant B lever) swaps the model, but
 * only when the caller has confirmed this is a local dev server — a client
 * must never be able to pick an arbitrary model. `images` (dev-only variant
 * C lever) turns the user turn into an image-then-text content array, same
 * split as agent-review.post.ts.
 */
export function buildShaderGenPayload(
  body: { tier?: unknown; prompt?: unknown; effort?: unknown; model?: unknown; images?: unknown },
  opts: BuildShaderGenOpts = {},
): Record<string, unknown> {
  const prompt = requireString(body?.prompt, 'prompt', SHADERGEN_MAX_PROMPT_CHARS)
  const tier = optionalTier(body?.tier) ?? 'plan'
  let effort: AiEffort | undefined = effortForTier(tier)
  if (body?.effort !== undefined && body.effort !== null) {
    if (tier === 'patch') throw badRequest("effort can't be set on the patch tier")
    if (body.effort !== 'high') throw badRequest("effort must be 'high' when set")
    effort = 'high'
  }

  let model = modelForTier(tier)
  if (body?.model !== undefined && body.model !== null) {
    if (!opts.allowModelOverride) throw forbidden('Model overrides are only available on a local dev server')
    if (body.model !== 'opus') throw badRequest(`unknown model '${String(body.model)}'`)
    model = DEV_MODEL_OVERRIDES.opus
  }

  let content: unknown = prompt
  if (body?.images !== undefined && body.images !== null) {
    if (!Array.isArray(body.images) || body.images.length > 2) throw badRequest('images must be an array of at most 2 image data URLs')
    const blocks = body.images.map((img) => {
      if (typeof img !== 'string' || img.length > MAX_IMAGE_CHARS) throw badRequest(`image too long (max ${MAX_IMAGE_CHARS} chars)`)
      const m = IMAGE_DATA_URL.exec(img)
      if (!m) throw badRequest('each image must be a data:image/...;base64,... URL')
      return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }
    })
    content = [...blocks, { type: 'text', text: prompt }]
  }

  return {
    model,
    max_tokens: SHADERGEN_MAX_TOKENS,
    system: [{ type: 'text', text: SHADERGEN_SYSTEM, cache_control: { type: 'ephemeral' } }],
    output_config: {
      format: { type: 'json_schema', schema: SHADERGEN_TAKE_SCHEMA },
      ...(effort ? { effort } : {}),
    },
    messages: [{ role: 'user', content }],
  }
}

export interface ShaderGenReply { text: string; usage: Record<string, number> | null; stop_reason: string | null }

/** What the route returns: the reply text, the raw usage (cache counts included)
 *  and why the model stopped ('max_tokens' means the reply was cut off). */
export function readShaderGenReply(json: any): ShaderGenReply {
  return { text: extractModelText(json), usage: json?.usage ?? null, stop_reason: json?.stop_reason ?? null }
}

/** The prompt's characters and image count, read back from a built payload so
 *  the hold is sized from exactly what is sent. */
function payloadSize(payload: Record<string, unknown>): { promptChars: number; imageCount: number } {
  const content = (payload.messages as Array<{ content: unknown }> | undefined)?.[0]?.content
  if (typeof content === 'string') return { promptChars: content.length, imageCount: 0 }
  const blocks = Array.isArray(content) ? content as Array<{ type?: string; text?: string }> : []
  return {
    promptChars: blocks.reduce((n, b) => n + (b.type === 'text' && typeof b.text === 'string' ? b.text.length : 0), 0),
    imageCount: blocks.filter(b => b.type === 'image').length,
  }
}

/**
 * Meters one /api/shader-gen call by its real token usage (hosted only):
 *  1. refuse a model with no token price (500) — BEFORE any hold (fail closed);
 *  2. hold the call's worst case (anthropicPrices.maxCreditsForCall);
 *  3. `call` — the Anthropic fetch, returning the raw response body; a thrown
 *     error (non-OK response or failed fetch) releases the hold and is
 *     rethrown unchanged. An OK body that isn't JSON was still billed: it is
 *     charged the full hold, logged, and the parse error rethrown;
 *  4. settle the hold to the reply's usage BEFORE returning. An empty reply
 *     (502 from readShaderGenReply) was still paid for, so it is settled too.
 * Returns the route's reply plus `credits` charged (null in local mode).
 */
export async function meterShaderGenCall(
  payload: Record<string, unknown>,
  call: () => Promise<string>,
): Promise<ShaderGenReply & { credits: number | null }> {
  const model = String(payload.model)
  const { promptChars, imageCount } = payloadSize(payload)
  const maxCredits = maxCreditsForCall(model, promptChars, imageCount, SHADERGEN_MAX_TOKENS)
  if (maxCredits === null) throw new MeterRefusalError(`unpriced model refused: ${model}`, 500)

  const ticket = await holdForModelCall(model, maxCredits)

  let body: string
  try {
    body = await call()
  } catch (e) {
    await ticket?.release()
    throw e
  }

  let json: any
  try {
    json = JSON.parse(body)
  } catch (e) {
    // Anthropic answered OK, so it billed the call — but with no readable
    // usage the only honest charge is the full hold. Never free.
    console.error('[meter] /api/shader-gen: OK reply is not JSON — charging the full hold', { model, credits: maxCredits, error: e })
    captureError(e, { site: 'api/shader-gen', model, credits: maxCredits })
    await ticket?.settleUsage(null)
    throw e
  }

  const credits = ticket ? await ticket.settleUsage(json?.usage) : null
  return { ...readShaderGenReply(json), credits }
}
