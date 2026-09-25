/**
 * Writes ONE shader take (AI in Sailor spec §7.2). The browser engine calls this
 * three times in parallel (the shader-generation setting) plus repair calls,
 * then compiles and checks the results itself. Returns the raw JSON
 * text, token usage (so the evaluation page can report cost), the stop reason,
 * and the credits charged for the call (null in local mode).
 */
import { createError, defineEventHandler, readBody } from 'h3'
import { assertRateLimit } from '../lib/rateLimit'
import { optionalApiKey, resolveAnthropicKey } from '../lib/agentRequest'
import { buildShaderGenPayload, meterShaderGenCall } from '../lib/shaderGenRequest'

export default defineEventHandler(async (event) => {
  // A request is 3 parallel takes, each with up to 5 calls (repairs); two tiers
  // can run side by side on the eval page — 120/min leaves headroom for that.
  assertRateLimit(event, 'shader-gen', 120)
  const body = await readBody<{ apiKey?: string; tier?: string; prompt?: string; effort?: string; model?: string; images?: string[] }>(event)
  const apiKey = resolveAnthropicKey(useRuntimeConfig(event).anthropicApiKey, optionalApiKey(body?.apiKey))
  const payload = buildShaderGenPayload(body ?? {})

  // Metered by the call's real token usage: hold the worst case, settle to
  // real cost × 2 (1 credit = $0.01) — see meterShaderGenCall.
  return meterShaderGenCall(payload, async () => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw createError({ statusCode: res.status, statusMessage: `model error: ${detail.slice(0, 200)}` })
    }
    // Raw body: meterShaderGenCall parses it, so an OK-but-unparseable reply
    // (still billed by Anthropic) is charged rather than released.
    return res.text()
  })
})
