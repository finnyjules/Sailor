/** Tiny fixed-window per-key rate limiter. In-memory on purpose: this is a
 *  single-process local app today; it exists to stop runaway client loops from
 *  burning the user's Anthropic credits, not to survive a distributed attack.
 *  The hosted-SaaS ledger (accounts project) replaces this with real quotas. */
import { isIP } from 'node:net'
import type { H3Event } from 'h3'
import { isHosted } from '../utils/deployMode'

const buckets = new Map<string, { count: number; resetAt: number }>()

export function takeToken(key: string, max: number, windowMs: number, now: number = Date.now()): boolean {
  const b = buckets.get(key)
  if (!b || now >= b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return true
  }
  if (b.count >= max) return false
  b.count += 1
  return true
}

export function _resetRateLimits(): void {
  buckets.clear()
}

/**
 * Forwarding headers are believed only when the request came through Fly's
 * proxy: hosted mode AND running on a Fly machine (Fly sets FLY_APP_NAME).
 * Anywhere else any client could write them and buy a fresh bucket per request.
 */
function behindTrustedProxy(): boolean {
  return isHosted() && !!process.env.FLY_APP_NAME
}

function header(event: H3Event, name: string): string | undefined {
  const v = event.node?.req?.headers?.[name]
  return Array.isArray(v) ? v[v.length - 1] : v
}

/**
 * The caller's address. Behind Fly the socket is the proxy's (shared by
 * everyone), so take Fly-Client-IP, which Fly's proxy sets itself; failing
 * that the LAST X-Forwarded-For entry (Fly appends it; earlier entries are the
 * client's own). Elsewhere, or when neither is a valid address, the socket.
 */
export function clientAddress(event: H3Event): string {
  const socket = event.node?.req?.socket?.remoteAddress ?? 'local'
  if (!behindTrustedProxy()) return socket
  const fly = header(event, 'fly-client-ip')?.trim()
  if (fly && isIP(fly)) return fly
  const last = header(event, 'x-forwarded-for')?.split(',').pop()?.trim()
  if (last && isIP(last)) return last
  return socket
}

/** Who a bucket belongs to: the signed-in person (hosted), else the client address. */
export function rateLimitKey(event: H3Event): string {
  const userId = event.context?.userId
  return typeof userId === 'string' && userId ? `user:${userId}` : `ip:${clientAddress(event)}`
}

/** Route guard: 30 calls/min per caller (rateLimitKey) per route by default. */
export function assertRateLimit(event: H3Event, name: string, max = 30, windowMs = 60_000): void {
  if (!takeToken(`${name}:${rateLimitKey(event)}`, max, windowMs)) {
    throw Object.assign(new Error(`Too many ${name} requests — wait a minute and retry`), { statusCode: 429 })
  }
}
