/**
 * The router (AI in Sailor spec §4): one Haiku call that says what kind of
 * result a prompt request needs. The workers (/api/agent-plan, /api/vibe*, …)
 * stay as they are behind it. Returns { kind, followUps, credits }.
 */
import { createError, defineEventHandler, readBody } from 'h3'
import { assertRateLimit } from '../lib/rateLimit'
import { optionalApiKey, resolveAnthropicKey } from '../lib/agentRequest'
import { buildRouterPayload, meterRouterCall, readRouterInput } from '../lib/promptRouterRequest'

export default defineEventHandler(async (event) => {
  assertRateLimit(event, 'prompt-route', 60)
  const body = await readBody<Record<string, unknown>>(event)
  const apiKey = resolveAnthropicKey(useRuntimeConfig(event).anthropicApiKey, optionalApiKey(body?.apiKey))
  const payload = buildRouterPayload(readRouterInput(body))
  return meterRouterCall(payload, async () => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw createError({ statusCode: res.status, statusMessage: `model error: ${detail.slice(0, 200)}` })
    }
    return res.text()
  })
})
