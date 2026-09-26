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
import { logSpend } from './spendLog'
import { preflightMeter, currentMeterContext } from './requestMeter'
import { recordProviderUsage } from './providerUsage'
import { costForModel } from './priceBook'
import { requestPrice } from '../../shared/pricing/clipSettings'
import { moderatePrompt, moderationRefusal } from './moderation'
import { extractProviderPromptText } from './graphPromptText'
import { falSubmit, falStatus, falResult } from '../runner/falQueue'

export interface FalRunOptions {
  pollDeadlineMs?: number
  pollIntervalMs?: number
}

/**
 * Metering (Stage 5 Task 2): preflightMeter takes a ledger HOLD before the
 * submit. Every non-success exit from dispatch() throws — missing key,
 * submit rejection, non-retryable 4xx while polling, a terminal non-COMPLETED
 * status, a failed result fetch, and the poll-deadline timeout — so the
 * single catch below is the complete release wiring. The hold is settled
 * only once the result body is actually in hand.
 *
 * Priced on what is sent (Task P5): an endpoint with a per-second card
 * (Frame Animate's) is held and charged for the request's own length,
 * resolution and sound (shared/pricing/clipSettings.ts requestPrice), ahead
 * of the endpoint's flat MODEL_COSTS row. Every other endpoint: its row.
 */
export async function runFal<T = unknown>(
  app: string,
  input: Record<string, unknown>,
  opts: FalRunOptions = {},
): Promise<T> {
  const price = requestPrice(app, input)
  const ticket = await preflightMeter(app, { credits: price?.credits })
  // Moderate AFTER the hold is placed (preflight) but BEFORE the submit — a
  // ToS-violating prompt releases the hold and refuses at zero spend.
  // Hosted: moderatePrompt fails CLOSED (no key / outage → refused after one
  // retry, over-long text → refused), and the hold is released either way.
  // Local: fails open as before — no key → no-op, byte-identical.
  const mod = await moderatePrompt(extractProviderPromptText(input))
  if (!mod.ok) {
    await ticket?.release()
    throw moderationRefusal(mod)
  }
  try {
    return await dispatch<T>(app, input, opts, ticket, price?.usd ?? null)
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
  requestUsd: number | null,
): Promise<T> {
  const submit = await falSubmit(app, input)
  const startedAt = Date.now()
  const rid = submit.requestId

  const deadline = Date.now() + (opts.pollDeadlineMs ?? 120_000)
  const interval = opts.pollIntervalMs ?? 1500
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, interval))
    // 4xx throws (unrecoverable: bad rid / revoked key); 5xx comes back transient.
    const status = await falStatus(submit.statusUrl)
    if (status.transient) continue
    if (status.status === 'IN_QUEUE' || status.status === 'IN_PROGRESS') continue
    if (status.status === 'COMPLETED') {
      logSpend({ provider: 'fal', model: app, ok: true, ms: Date.now() - startedAt })
      // Settle only once the output is genuinely in hand — a body that fails
      // to parse means the caller gets nothing, so it must not be charged.
      const body = await falResult<T>(submit.responseUrl)
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
          usd: requestUsd ?? costForModel(app)?.usd ?? null,
          jobId: 'settle:' + ticket.holdId,
        })
      }
      return body
    }
    logSpend({ provider: 'fal', model: app, ok: false, ms: Date.now() - startedAt })
    throw new Error(`fal request ${rid} ended in ${status.status}: ${JSON.stringify(status.raw)}`)
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
