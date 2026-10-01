/**
 * The price of a run before it starts (step 3, R8.0). Body: { takes } as
 * POST /api/runs takes them. Runs the start's own checks and measurements and
 * the hold's calculation (engine.ts quoteRun: the same code a run starts
 * with), and answers { usd, credits, upTo }. Free: nothing is held, no run is
 * stored, no bytes are kept, no provider is called.
 *
 * A workflow the runner wouldn't take answers { declined: true } (the app
 * sends it the old way, or says it is switched off); a refusal the run would
 * make answers { refused: '<its words>' } (the button stays off). Hosted
 * checks are the start's: names judged before any disk read, files the
 * caller's own, signed in.
 */
import { createError, defineEventHandler, readBody } from 'h3'
import type { H3Event } from 'h3'
import { runnerEnabled } from '../../runner/config'
import { getEngine } from '../../runner/index'
import type { RunQuote } from '../../runner/engine'
import { rateLimitKey, takeToken } from '../../lib/rateLimit'
import { MeterRefusalError } from '../../utils/requestMeter'
import { RUNNER_NOT_ELIGIBLE } from '#shared/runner/messages'

export type QuoteAnswer = RunQuote | { declined: true } | { refused: string, reason?: string }

/** A start refusal as the quote answers it; anything else (a fault, the runner off) is thrown on. */
export function quoteAnswerOf(e: unknown): QuoteAnswer {
  const x = e as { statusCode?: unknown; message?: unknown; data?: unknown } | null
  const reason = (x?.data as { reason?: unknown } | undefined)?.reason
  if (e instanceof MeterRefusalError) {
    if (reason === RUNNER_NOT_ELIGIBLE) return { declined: true }
    // The start's refusals (4xx, and 5xx for an unpriced model or a pause) carry plain words, and
    // their stable reason code where the start gives one (an app keys on it, never on the words).
    return typeof reason === 'string' && reason ? { refused: e.message, reason } : { refused: e.message }
  }
  // Any other refusal raised in the start with a status (an h3 error: a request too large, a body it can't
  // read) answers with its own words, so the app shows them; a fault without one is thrown on.
  const status = typeof x?.statusCode === 'number' ? x.statusCode : 0
  if (status >= 400 && status < 500 && status !== 404 && status !== 429 && typeof x?.message === 'string' && x.message) {
    return reason === RUNNER_NOT_ELIGIBLE ? { declined: true } : { refused: x.message }
  }
  throw e
}

/** Quotes a minute: per person where signed in, else per address (the route's own bucket). */
export const QUOTES_PER_MINUTE = 30

/**
 * The quote's rate limit: assertRateLimit's per-caller key (the user id where
 * signed in, else the client address), with the quote's own words. The
 * user id is passed so the handler's resolved caller is the one keyed.
 */
export function assertQuoteRate(event: H3Event, userId: string | null): void {
  const key = userId ? `user:${userId}` : rateLimitKey(event)
  if (!takeToken(`runs-quote:${key}`, QUOTES_PER_MINUTE, 60_000)) {
    throw Object.assign(new Error('Too many price checks at once. Wait a moment.'), { statusCode: 429 })
  }
}

export default defineEventHandler(async (event): Promise<QuoteAnswer> => {
  if (!runnerEnabled()) throw createError({ statusCode: 404, message: 'Not found' })
  const userId: string | null = event.context.userId ?? null
  assertQuoteRate(event, userId)
  // The caller going away (a quote a newer one replaced is aborted by the browser) stops the start's
  // media work (probes): the signal reaches prepareStart, as /api/runs passes it (R7.7).
  const gone = new AbortController()
  const res = event.node?.res
  const onClose = () => { if (!res?.writableEnded) gone.abort() }
  res?.once?.('close', onClose)
  try {
    const body = (await readBody(event)) as Record<string, unknown> | null
    return await getEngine().quoteRun({
      userId,
      takes: body?.takes,
      workflow: null,
      canvasId: null,
      projectUuid: null,
      projectName: null,
      signal: gone.signal,
    })
  }
  catch (e) {
    return quoteAnswerOf(e)
  }
  finally {
    res?.off?.('close', onClose)
  }
})
