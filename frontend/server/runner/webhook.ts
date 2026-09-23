/**
 * fal webhook signatures (https://docs.fal.ai/model-apis/model-endpoints/webhooks):
 * ED25519 over `request_id \n user_id \n timestamp \n sha256hex(body)`, keys
 * from fal's JWKS, timestamp within ±5 minutes. The call only WAKES a poll —
 * the runner still asks fal for the result itself — so a forged call could
 * at worst cause an early status check, and unsigned calls are ignored anyway.
 */
import { createHash, createPublicKey, verify } from 'node:crypto'

export const FAL_JWKS_URL = 'https://rest.fal.ai/.well-known/jwks.json'

export interface FalJwk { kty: string; crv: string; x: string }

export function falWebhookMessage(h: { requestId: string; userId: string; timestamp: string }, rawBody: Uint8Array): Buffer {
  const digest = createHash('sha256').update(rawBody).digest('hex')
  return Buffer.from([h.requestId, h.userId, h.timestamp, digest].join('\n'), 'utf8')
}

export function verifyFalWebhook(o: {
  headers: { requestId?: string; userId?: string; timestamp?: string; signature?: string }
  rawBody: Uint8Array
  keys: FalJwk[]
  nowSec: number
  toleranceSec?: number
}): boolean {
  const { requestId, userId, timestamp, signature } = o.headers
  if (!requestId || !userId || !timestamp || !signature) return false
  const ts = Number(timestamp)
  if (!Number.isInteger(ts) || Math.abs(o.nowSec - ts) > (o.toleranceSec ?? 300)) return false
  if (!/^[0-9a-f]{128}$/i.test(signature)) return false
  const sig = Buffer.from(signature, 'hex')
  const message = falWebhookMessage({ requestId, userId, timestamp }, o.rawBody)
  for (const k of o.keys) {
    try {
      const key = createPublicKey({ key: { kty: k.kty, crv: k.crv, x: k.x }, format: 'jwk' })
      if (verify(null, message, key, sig)) return true
    }
    catch { /* a malformed key is skipped */ }
  }
  return false
}

async function fetchFalKeys(): Promise<FalJwk[]> {
  const r = await fetch(FAL_JWKS_URL)
  if (!r.ok) throw new Error(`fal JWKS ${r.status}`)
  const body = await r.json() as { keys?: FalJwk[] }
  return Array.isArray(body.keys) ? body.keys : []
}

/** A failed key fetch is remembered this long, so a burst of calls does not hammer fal. */
export const JWKS_FAILURE_TTL_MS = 60_000

export function createJwksCache(
  fetchKeys: () => Promise<FalJwk[]> = fetchFalKeys,
  ttlMs = 24 * 60 * 60 * 1000,
  now: () => number = Date.now,
) {
  let cached: { keys: FalJwk[]; at: number } | null = null
  let failed: { error: unknown; at: number } | null = null
  return {
    async keys(): Promise<FalJwk[]> {
      if (cached && now() - cached.at < ttlMs) return cached.keys
      if (failed && now() - failed.at < JWKS_FAILURE_TTL_MS) throw failed.error
      try {
        cached = { keys: await fetchKeys(), at: now() }
        failed = null
        return cached.keys
      }
      catch (e) {
        failed = { error: e, at: now() }
        throw e
      }
    },
  }
}
