/**
 * fal calls this when a runner request finishes. It only wakes the waiting
 * poll — the runner still asks fal for the answer itself. Unsigned or stale
 * calls are refused. Listed in PUBLIC_API_PATHS (no sign-in: fal calls it).
 */
import { createError, defineEventHandler, getHeader, readRawBody } from 'h3'
import { runnerEnabled } from '../../runner/config'
import { getEngine } from '../../runner/index'
import { createJwksCache, verifyFalWebhook } from '../../runner/webhook'

const jwks = createJwksCache()

export default defineEventHandler(async (event) => {
  if (!runnerEnabled()) throw createError({ statusCode: 404, message: 'Not found' })
  const raw = (await readRawBody(event, false)) ?? Buffer.alloc(0)
  const headers = {
    requestId: getHeader(event, 'x-fal-webhook-request-id'),
    userId: getHeader(event, 'x-fal-webhook-user-id'),
    timestamp: getHeader(event, 'x-fal-webhook-timestamp'),
    signature: getHeader(event, 'x-fal-webhook-signature'),
  }
  if (!headers.requestId || !headers.signature) throw createError({ statusCode: 401, message: 'Unsigned' })
  let keys
  try { keys = await jwks.keys() }
  catch { throw createError({ statusCode: 503, message: 'Could not check the signature' }) }
  const ok = verifyFalWebhook({ headers, rawBody: new Uint8Array(raw), keys, nowSec: Math.floor(Date.now() / 1000) })
  if (!ok) throw createError({ statusCode: 401, message: 'Bad signature' })
  getEngine().nudge(headers.requestId)
  return { ok: true }
})
