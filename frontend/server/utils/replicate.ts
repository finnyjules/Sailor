/**
 * Minimal Replicate prediction runner shared by the vector AI routes. Mirrors
 * the create-then-poll flow already used by /api/cloud-train/*, but waits inline
 * (SVG generation/vectorize finish in seconds) and returns the raw `output`.
 */
import { logSpend } from './spendLog'
import { preflightMeter, currentMeterContext } from './requestMeter'
import { recordProviderUsage } from './providerUsage'
import { costForModel } from './priceBook'
import { moderatePrompt, moderationRefusal } from './moderation'
import { extractProviderPromptText } from './graphPromptText'

interface Prediction {
  id: string
  status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled'
  output?: unknown
  error?: string
}

/** Resolve a model's latest version hash. */
async function latestVersion(model: string, token: string): Promise<string> {
  const res = await fetch(`https://api.replicate.com/v1/models/${model}`, {
    headers: { Authorization: `Token ${token}` },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw createError({ statusCode: 502, message: `Replicate model lookup failed for ${model}: ${text || res.statusText}` })
  }
  const info = await res.json() as { latest_version?: { id?: string } }
  const v = info.latest_version?.id
  if (!v) throw createError({ statusCode: 502, message: `Model ${model} has no latest version` })
  return v
}

/**
 * Create a prediction and poll until it terminates. Returns `output`.
 * Throws a 5xx createError on failure/timeout.
 *
 * Metering (Stage 5 Task 2): preflightMeter takes a ledger HOLD before any
 * provider HTTP call. Every path out of dispatch() that isn't "output in
 * hand" throws, so a single catch here is the complete release wiring —
 * model lookup failure, submit rejection, provider-reported failure/cancel,
 * and poll timeout all give the reservation back. Without this, a failed job
 * would keep the user's credits reserved until holdSweep's TTL.
 */
export async function runReplicate(
  model: string,
  input: Record<string, unknown>,
  token: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<unknown> {
  const ticket = await preflightMeter(model)
  // Moderate AFTER the hold is placed (preflight) but BEFORE any provider HTTP
  // call — a ToS-violating prompt releases the hold and refuses at zero spend.
  // Hosted: moderatePrompt fails CLOSED (no key / outage → refused after one
  // retry, over-long text → refused), and the hold is released either way.
  // Local: fails open as before — no key → no-op, byte-identical.
  const mod = await moderatePrompt(extractProviderPromptText(input))
  if (!mod.ok) {
    await ticket?.release()
    throw moderationRefusal(mod)
  }
  try {
    return await dispatch(model, input, token, opts, ticket)
  } catch (e) {
    await ticket?.release()
    throw e
  }
}

async function dispatch(
  model: string,
  input: Record<string, unknown>,
  token: string,
  opts: { timeoutMs?: number; pollMs?: number },
  ticket: Awaited<ReturnType<typeof preflightMeter>>,
): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? 90_000
  const pollMs = opts.pollMs ?? 1200
  const version = await latestVersion(model, token)
  const startedAt = Date.now()

  const createRes = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: { Authorization: `Token ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ version, input }),
  })
  if (!createRes.ok) {
    const text = await createRes.text().catch(() => '')
    throw createError({ statusCode: 502, message: `Replicate prediction create failed: ${text || createRes.statusText}` })
  }
  let pred = await createRes.json() as Prediction

  const deadline = Date.now() + timeoutMs
  while (pred.status !== 'succeeded' && pred.status !== 'failed' && pred.status !== 'canceled') {
    if (Date.now() > deadline) throw createError({ statusCode: 504, message: 'Replicate prediction timed out' })
    await new Promise(r => setTimeout(r, pollMs))
    const pollRes = await fetch(`https://api.replicate.com/v1/predictions/${pred.id}`, {
      headers: { Authorization: `Token ${token}` },
    })
    if (!pollRes.ok) continue
    pred = await pollRes.json() as Prediction
  }
  logSpend({ provider: 'replicate', model, ok: pred.status === 'succeeded', ms: Date.now() - startedAt })
  if (pred.status !== 'succeeded') {
    throw createError({ statusCode: 502, message: `Replicate prediction ${pred.status}: ${pred.error || 'unknown error'}` })
  }
  if (ticket) {
    await ticket.settle('rep:' + pred.id)
    // job_id here is `settle:${holdId}` — NOT `rep:${pred.id}`. The
    // ledger's settle() (ledger.ts) hardcodes the debit's idempotency_key as
    // `settle:${holdId}`; the jobId string passed to ticket.settle() is used
    // only for logging (settleHoldOrLog), never persisted. Recording that
    // string here would make Task 5's reconciliation join
    // (provider_usage.job_id vs ledger_entries.idempotency_key) never match.
    void recordProviderUsage({
      userId: currentMeterContext()?.userId ?? null,
      provider: 'replicate',
      model,
      usd: costForModel(model)?.usd ?? null,
      jobId: 'settle:' + ticket.holdId,
    })
  }
  return pred.output
}

/** Fetch a Replicate output image URL and inline it as a base64 data URL. Lets
 *  the browser consume results without hitting CORS on the Replicate CDN. */
export async function fetchAsDataUrl(url: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) throw createError({ statusCode: 502, message: `Failed to fetch Replicate output (${res.status})` })
  const contentType = res.headers.get('content-type') || 'image/png'
  const buf = Buffer.from(await res.arrayBuffer())
  return `data:${contentType};base64,${buf.toString('base64')}`
}

/** Normalize a Replicate output (string | string[] | {url}) to a single URL. */
export function firstOutputUrl(output: unknown): string | null {
  if (typeof output === 'string') return output
  if (Array.isArray(output) && typeof output[0] === 'string') return output[0]
  if (output && typeof output === 'object' && typeof (output as any).url === 'string') return (output as any).url
  return null
}

/** Read the Replicate token (Settings → AI, falling back to NUXT_REPLICATE_TOKEN), or throw a clear 500. */
export function requireReplicateToken(): string {
  const token = getReplicateToken()
  if (!token) throw createError({ statusCode: 500, message: 'Replicate token not configured. Paste it in Settings → AI (or set NUXT_REPLICATE_TOKEN).' })
  return token
}
