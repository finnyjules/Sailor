/**
 * Writes ONE shader take (AI in Sailor spec §7.2). The browser engine calls this
 * four times in parallel (one per take angle) plus repair calls, then compiles,
 * checks and reviews the results itself. Returns the raw JSON text and token
 * usage so the evaluation page can report cost.
 */
import { createError, defineEventHandler, readBody } from 'h3'
import { assertRateLimit } from '../lib/rateLimit'
import { optionalApiKey, resolveAnthropicKey } from '../lib/agentRequest'
import { extractModelText } from '../lib/modelText'
import { buildShaderGenPayload } from '../lib/shaderGenRequest'
import { meterAssist } from '../utils/anthropicMeter'

export default defineEventHandler(async (event) => {
  // A request is 4 parallel takes, each with up to 5 calls (repairs); two tiers
  // can run side by side on the eval page — 120/min leaves headroom for that.
  assertRateLimit(event, 'shader-gen', 120)
  const body = await readBody<{ apiKey?: string; tier?: string; prompt?: string }>(event)
  const apiKey = resolveAnthropicKey(useRuntimeConfig(event).anthropicApiKey, optionalApiKey(body?.apiKey))
  const payload = buildShaderGenPayload(body ?? {})

  await meterAssist(event)

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
  const json = await res.json()
  return { text: extractModelText(json), usage: json?.usage ?? null }
})
