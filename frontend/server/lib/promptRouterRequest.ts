/**
 * /api/prompt-route (AI in Sailor spec §4): read the body, build one Haiku call,
 * and meter it per call from its real token usage — the same hold → settle /
 * release flow as /api/shader-gen (shaderGenRequest.ts). Kept out of the route
 * so it is unit-testable without h3.
 */
import {
  buildRouterUserPrompt, parseRouterReply, ROUTER_HOSTS, ROUTER_MAX_REQUEST_CHARS, ROUTER_MAX_TOKENS,
  ROUTER_SCHEMA, ROUTER_SYSTEM, type RouterHost, type RouterInput, type RouterResult,
} from '~~/shared/promptRouter/router'
import { AI_TIERS } from './aiModels'
import { badRequest, optionalString, requireString } from './agentRequest'
import { extractModelText } from './modelText'
import { holdForModelCall } from '../utils/anthropicMeter'
import { maxCreditsForCall } from '../utils/anthropicPrices'
import { MeterRefusalError } from '../utils/requestMeter'
import { captureError } from '../utils/observe'

const MAX_SELECTION = 20

export function readRouterInput(body: unknown): RouterInput {
  const b = (body ?? {}) as Record<string, unknown>
  const request = requireString(b.request, 'request', ROUTER_MAX_REQUEST_CHARS)
  const host = (b.host ?? 'canvas') as RouterHost
  if (!(ROUTER_HOSTS as readonly unknown[]).includes(host)) throw badRequest(`unknown host '${String(b.host)}'`)
  const raw = b.selection ?? []
  if (!Array.isArray(raw) || raw.length > MAX_SELECTION) throw badRequest(`selection must be an array of at most ${MAX_SELECTION} items`)
  const selection = raw.map((s: any) => ({
    kind: requireString(s?.kind, 'selection.kind', 80),
    name: requireString(s?.name, 'selection.name', 120),
  }))
  const mode = optionalString(b.mode, 'mode', 40) ?? null
  return { request, host, selection, mode }
}

export function buildRouterPayload(input: RouterInput): Record<string, any> {
  return {
    model: AI_TIERS.patch,
    max_tokens: ROUTER_MAX_TOKENS,
    system: ROUTER_SYSTEM,
    // No `effort`: Haiku 4.5 rejects it with a 400 (see aiModels.ts).
    output_config: { format: { type: 'json_schema', schema: ROUTER_SCHEMA } },
    messages: [{ role: 'user', content: buildRouterUserPrompt(input) }],
  }
}

/**
 * Meter one router call (hosted only): refuse an unpriced model before any
 * hold; hold the worst case; `call` returns the raw body (a throw releases the
 * hold); an OK body that isn't JSON is charged the full hold; otherwise settle
 * to the reply's usage, THEN read it (an empty reply is still paid for).
 */
export async function meterRouterCall(
  payload: Record<string, any>,
  call: () => Promise<string>,
): Promise<RouterResult & { credits: number | null }> {
  const model = String(payload.model)
  const promptChars = String(payload.messages?.[0]?.content ?? '').length + String(payload.system ?? '').length
  const maxCredits = maxCreditsForCall(model, promptChars, 0, ROUTER_MAX_TOKENS)
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
    console.error('[meter] /api/prompt-route: OK reply is not JSON — charging the full hold', { model, credits: maxCredits, error: e })
    captureError(e, { site: 'api/prompt-route', model, credits: maxCredits })
    await ticket?.settleUsage(null)
    throw e
  }

  const credits = ticket ? await ticket.settleUsage(json?.usage) : null
  return { ...parseRouterReply(extractModelText(json)), credits }
}
