/** True iff `body` is a Nuxt/h3 error body (a metering refusal — moderation,
 * insufficient credits, file ownership, paused) rather than a ComfyUI-shaped
 * validation body (the runner's refusals keep that shape).
 *
 * Nitro serializes thrown h3 errors with a top-level **boolean** `error: true`
 * (e.g. `{ error: true, statusCode: 401, message: "Sign in required", ... }`
 * from the auth middleware, or the same shape with `message: "Sailor is
 * temporarily paused"` from a run's refusal). ComfyUI's validation body
 * (the shape the runner's node refusals keep) instead carries `error` as an OBJECT
 * (`{ error: { message, ... }, node_errors: {...} }`). A prior version of
 * this check used `!body.error`, which is false for BOTH shapes (a truthy
 * object and a truthy boolean `true` are both truthy) — so a real hosted
 * refusal was misclassified as a ComfyUI validation failure and fell through
 * to a generic ofetch toast instead of the clean refusal toast. Distinguish
 * by the TYPE of `error`, not its truthiness. */
export function isH3RefusalBody(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false
  const b = body as Record<string, unknown>
  const comfyShaped = (typeof b.error === 'object' && b.error !== null) || b.node_errors !== undefined
  if (comfyShaped) return false
  return typeof b.message === 'string' && b.message.length > 0
}

/** Toast copy for a bridge `queue_error` that is a Nuxt-proxy metering
 * refusal (moderation / credits / ownership / paused) rather than a
 * ComfyUI validation error. Returns null for the latter — those are
 * handled by the existing per-node red-ring path. */
export interface QueueRefusalNotice {
  title: string
  description: string | undefined
  policyLink: boolean
}

export function describeQueueRefusal(data: { refusal?: boolean; statusCode?: number | null; message?: string }): QueueRefusalNotice | null {
  if (!data?.refusal || typeof data.message !== 'string' || !data.message) return null
  // statusCode 400 alone isn't enough — the chokepoint also 400s non-moderation
  // failures (e.g. 'Missing prompt graph'), which must NOT get the policy link.
  const moderation = data.statusCode === 400 && /moderation/i.test(data.message)
  return {
    title: data.message,
    description: moderation ? 'See our content policy for what’s allowed.' : undefined,
    policyLink: moderation,
  }
}
