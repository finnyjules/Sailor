/**
 * A request's fingerprint is built from the FULL body that would be sent to
 * fal (never a hand-picked list of settings), with input-file links replaced
 * by what the files contain. Two requests with the same fingerprint would get
 * the same answer — if, and only if, the seed is fixed.
 */
import { createHash } from 'node:crypto'

export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (v && typeof v === 'object') {
    const keys = Object.keys(v as object).filter(k => (v as any)[k] !== undefined).sort()
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson((v as any)[k])}`).join(',')}}`
  }
  return JSON.stringify(v ?? null)
}

function replaceLinks(v: unknown, hashOf: (url: string) => string | undefined): unknown {
  if (typeof v === 'string') {
    const h = hashOf(v)
    return h ? `sha256:${h}` : v
  }
  if (Array.isArray(v)) return v.map(x => replaceLinks(x, hashOf))
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, replaceLinks(x, hashOf)]))
  }
  return v
}

export function requestFingerprint(
  endpoint: string,
  payload: Record<string, unknown>,
  hashOf: (url: string) => string | undefined,
): string {
  const body = canonicalJson({ endpoint, payload: replaceLinks(payload, hashOf) })
  return createHash('sha256').update(body).digest('hex')
}

/** Seed 0 means "surprise me": the builders leave `seed` out, and asking again should give something new. */
export function isReusable(payload: Record<string, unknown>): boolean {
  const s = payload.seed
  return typeof s === 'number' && Number.isInteger(s) && s > 0
}
