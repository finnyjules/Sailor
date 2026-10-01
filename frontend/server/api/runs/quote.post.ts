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
import { runnerEnabled } from '../../runner/config'
import { getEngine } from '../../runner/index'
import type { RunQuote } from '../../runner/engine'
import { assertRateLimit } from '../../lib/rateLimit'
import { MeterRefusalError } from '../../utils/requestMeter'
import { RUNNER_NOT_ELIGIBLE } from '#shared/runner/messages'

export type QuoteAnswer = RunQuote | { declined: true } | { refused: string }

/** A start refusal as the quote answers it; anything else (a fault, the runner off) is thrown on. */
export function quoteAnswerOf(e: unknown): QuoteAnswer {
  if (!(e instanceof MeterRefusalError)) throw e
  if ((e.data as { reason?: unknown } | undefined)?.reason === RUNNER_NOT_ELIGIBLE) return { declined: true }
  // The start's refusals (4xx, and 5xx for an unpriced model or a pause) carry plain words.
  return { refused: e.message }
}

export default defineEventHandler(async (event): Promise<QuoteAnswer> => {
  if (!runnerEnabled()) throw createError({ statusCode: 404, message: 'Not found' })
  assertRateLimit(event, 'runs-quote', 30)
  // The caller going away stops the start's media work (probes), as /api/runs does.
  const gone = new AbortController()
  const res = event.node?.res
  const onClose = () => { if (!res?.writableEnded) gone.abort() }
  res?.once?.('close', onClose)
  try {
    const body = (await readBody(event)) as Record<string, unknown> | null
    return await getEngine().quoteRun({
      userId: event.context.userId ?? null,
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
