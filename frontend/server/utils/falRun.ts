/**
 * Minimal fal.ai queue runner for Nitro routes — the inference counterpart to
 * falStorage.ts (which only uploads). Mirrors the proven Python client in
 * comfy_api_nodes/fal_refs.py: POST to queue.fal.run/{app}, poll status (fal
 * returns 202 while IN_QUEUE/IN_PROGRESS, 200 when COMPLETED), then GET the
 * result. Prefer the status/response URLs fal returns in the submit body so
 * sub-endpoint apps (e.g. fal-ai/flux-pro/v1/fill) poll the correct base.
 *
 * The fal key is server-only: FAL_KEY (or NUXT_FAL_TOKEN), resolved by
 * getFalToken() from falStorage.ts.
 */
import { getFalToken } from './falStorage'
import { logSpend } from './spendLog'
import { preflightMeter, currentMeterContext, MeterRefusalError } from './requestMeter'
import { recordProviderUsage } from './providerUsage'
import { costForModel } from './priceBook'
import { moderatePrompt } from './moderation'
import { extractProviderPromptText } from './graphPromptText'

const FAL_QUEUE_BASE = 'https://queue.fal.run'

export interface FalRunOptions {
  pollDeadlineMs?: number
  pollIntervalMs?: number
}

interface FalSubmit {
  request_id: string
  status_url?: string
  response_url?: string
}

/**
 * Metering (Stage 5 Task 2): preflightMeter takes a ledger HOLD before the
 * submit. Every non-success exit from dispatch() throws — missing key,
 * submit rejection, non-retryable 4xx while polling, a terminal non-COMPLETED
 * status, a failed result fetch, and the poll-deadline timeout — so the
 * single catch below is the complete release wiring. The hold is settled
 * only once the result body is actually in hand.
 */
export async function runFal<T = unknown>(
  app: string,
  input: Record<string, unknown>,
  opts: FalRunOptions = {},
): Promise<T> {
  const ticket = await preflightMeter(app)
  // Moderate AFTER the hold is placed (preflight) but BEFORE the submit — a
  // ToS-violating prompt releases the hold and refuses at zero spend.
  // moderatePrompt fails OPEN (no key / OpenAI outage → ok:true), so this can
  // never take generation down; local mode has no key → no-op, byte-identical.
  const mod = await moderatePrompt(extractProviderPromptText(input))
  if (!mod.ok) {
    await ticket?.release()
    throw new MeterRefusalError('This prompt was blocked by content moderation', 400, { categories: mod.categories })
  }
  try {
    return await dispatch<T>(app, input, opts, ticket)
  } catch (e) {
    await ticket?.release()
    throw e
  }
}

async function dispatch<T>(
  app: string,
  input: Record<string, unknown>,
  opts: FalRunOptions,
  ticket: Awaited<ReturnType<typeof preflightMeter>>,
): Promise<T> {
  const token = getFalToken()
  if (!token) throw new Error('FAL_KEY is not set (add it to frontend/.env)')
  const headers = { Authorization: `Key ${token}`, 'Content-Type': 'application/json' }
  const appBase = `${FAL_QUEUE_BASE}/${app}`

  const submitRes = await fetch(appBase, {
    method: 'POST', headers, body: JSON.stringify(input),
  })
  if (!submitRes.ok) {
    const t = await submitRes.text().catch(() => '')
    throw new Error(`fal submit ${submitRes.status}: ${t || submitRes.statusText}`)
  }
  const submit = await submitRes.json() as FalSubmit
  const startedAt = Date.now()
  const rid = submit.request_id
  const statusUrl = submit.status_url || `${appBase}/requests/${rid}/status`
  const resultUrl = submit.response_url || `${appBase}/requests/${rid}`

  const deadline = Date.now() + (opts.pollDeadlineMs ?? 120_000)
  const interval = opts.pollIntervalMs ?? 1500
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, interval))
    const sRes = await fetch(statusUrl, { headers })
    if (sRes.status !== 200 && sRes.status !== 202) {
      // 4xx = unrecoverable (bad rid / revoked key); 5xx = transient, retry.
      if (sRes.status >= 400 && sRes.status < 500) {
        const t = await sRes.text().catch(() => '')
        throw new Error(`fal status ${sRes.status} (not retryable): ${t}`)
      }
      continue
    }
    const status = await sRes.json() as { status?: string }
    if (status.status === 'IN_QUEUE' || status.status === 'IN_PROGRESS') continue
    if (status.status === 'COMPLETED') {
      logSpend({ provider: 'fal', model: app, ok: true, ms: Date.now() - startedAt })
      const rRes = await fetch(resultUrl, { headers })
      if (!rRes.ok) {
        const t = await rRes.text().catch(() => '')
        throw new Error(`fal result ${rRes.status}: ${t}`)
      }
      // Settle only once the output is genuinely in hand — a body that fails
      // to parse means the caller gets nothing, so it must not be charged.
      const body = await rRes.json() as T
      if (ticket) {
        await ticket.settle('fal:' + rid)
        // job_id here is `settle:${holdId}` — see replicate.ts's dispatch()
        // for why (ledger.settle() hardcodes the debit idempotency_key as
        // `settle:${holdId}`, ignoring the jobId string passed to
        // ticket.settle()); Task 5's reconciliation join needs this exact key.
        void recordProviderUsage({
          userId: currentMeterContext()?.userId ?? null,
          provider: 'fal',
          model: app,
          usd: costForModel(app)?.usd ?? null,
          jobId: 'settle:' + ticket.holdId,
        })
      }
      return body
    }
    logSpend({ provider: 'fal', model: app, ok: false, ms: Date.now() - startedAt })
    throw new Error(`fal request ${rid} ended in ${status.status}: ${JSON.stringify(status)}`)
  }
  throw new Error(`fal request timed out (id=${rid})`)
}

/** First image URL from an fal image result ({ images: [{ url }] }). */
export function firstFalImageUrl(result: unknown): string | null {
  const images = (result as { images?: Array<{ url?: string }> })?.images
  return Array.isArray(images) && images[0]?.url ? images[0].url : null
}

/** First video URL from a fal video result ({ video: { url } }). */
export function firstFalVideoUrl(result: unknown): string | null {
  const url = (result as { video?: { url?: string } })?.video?.url
  return typeof url === 'string' && url ? url : null
}
