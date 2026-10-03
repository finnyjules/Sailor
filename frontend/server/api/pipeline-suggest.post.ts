// Resolve a natural-language intent at a node port into 1..N nodes + wiring.
// Sibling of explain.post.ts: raw fetch, user-supplied Anthropic key, no SDK.
// Haiku + structured outputs keep this fast and a fraction of a cent per ask.
import { assertRateLimit } from '../lib/rateLimit'
import { optionalApiKey, resolveAnthropicKey } from '../lib/agentRequest'
import { meterAssist } from '../utils/anthropicMeter'

const SUGGESTION_SCHEMA = {
  type: 'object',
  properties: {
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Short unique id, e.g. "a"' },
          type: { type: 'string', description: 'Node type from the catalog' },
          widgets: {
            type: 'array',
            description: 'Widget overrides; empty array if none',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                value: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
              },
              required: ['name', 'value'],
              additionalProperties: false,
            },
          },
        },
        required: ['id', 'type', 'widgets'],
        additionalProperties: false,
      },
    },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string', description: '"anchor" or "<id>.<outputPortName>"' },
          to: { type: 'string', description: '"anchor" or "<id>.<inputPortName>"' },
        },
        required: ['from', 'to'],
        additionalProperties: false,
      },
    },
    note: { type: 'string', description: 'One short sentence describing what was built' },
  },
  required: ['nodes', 'edges', 'note'],
  additionalProperties: false,
}

export default defineEventHandler(async (event) => {
  assertRateLimit(event, 'pipeline-suggest', 60)
  const body = await readBody(event)
  const { apiKey: clientKey, intent, anchor, catalog, graphContext, validationErrors, previousAttempt } = body || {}
  const apiKey = resolveAnthropicKey(useRuntimeConfig(event).anthropicApiKey, optionalApiKey(clientKey))

  if (!intent || typeof intent !== 'string' || !anchor || !Array.isArray(catalog)) {
    throw createError({ statusCode: 400, message: 'Missing intent, anchor, or catalog' })
  }

  const directionNote = anchor.direction === 'output'
    ? 'The anchor is an OUTPUT port: your nodes consume its data (downstream). Exactly one edge must use "anchor" as its "from".'
    : 'The anchor is an INPUT port: your nodes produce its data (upstream). Exactly one edge must use "anchor" as its "to".'

  const repair = Array.isArray(validationErrors) && validationErrors.length
    ? `\n\nYour previous attempt:\n${JSON.stringify(previousAttempt)}\n\nIt failed validation:\n- ${validationErrors.join('\n- ')}\n\nReturn a corrected suggestion that fixes every error.`
    : ''

  const prompt = `You are a node-graph building assistant for Sailor. The user clicked a node port on the canvas and described what they want. Choose 1..N nodes to insert and wire to that port.

ANCHOR (the port the user clicked):
${JSON.stringify(anchor)}
${directionNote}

SURROUNDING GRAPH:
${typeof graphContext === 'string' ? graphContext : ''}

AVAILABLE NODES — you may ONLY use node types from this catalog:
${JSON.stringify(catalog)}

USER INTENT: "${intent}"

Rules:
- Use the minimal number of nodes that fulfils the intent — one node when one suffices.
- "widgets" holds only the values you want to override based on the intent; otherwise []. Enum values must come from that widget's listed options.
- Edge endpoints are "anchor" or "<id>.<portName>" using the exact port names from the catalog. Every edge must connect type-compatible ports.
- "note" is one short sentence shown to the user.${repair}`

  await meterAssist(event)

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 2048,
        output_config: { format: { type: 'json_schema', schema: SUGGESTION_SCHEMA } },
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      console.error('[pipeline-suggest] Anthropic error:', res.status, errText)
      const errBody = (() => { try { return JSON.parse(errText) } catch { return {} } })()
      const message = errBody?.error?.message || `Anthropic API error: ${res.status}`
      throw createError({ statusCode: res.status, message })
    }

    const data: any = await res.json()
    const text = data?.content?.find((b: any) => b.type === 'text')?.text
    if (!text) throw createError({ statusCode: 502, message: 'Empty response from Claude' })
    try {
      return { suggestion: JSON.parse(text) }
    }
    catch {
      throw createError({ statusCode: 502, message: 'Claude returned invalid JSON' })
    }
  }
  catch (err: any) {
    if (err.statusCode) throw err
    throw createError({ statusCode: 500, message: err?.message || 'Failed to call Claude API' })
  }
})
