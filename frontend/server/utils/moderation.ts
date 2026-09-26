/**
 * Prompt-side moderation via OpenAI's free moderation endpoint.
 *
 * HOSTED: FAIL-CLOSED (user decision 09-26, G3). A missing OPENAI_API_KEY, a
 * non-200, a network error or a timeout is tried once more after a short
 * pause, then refused as `unavailable` — so an outage, or a prompt padded until
 * the service rejects it, can never reach a paid provider unchecked. Text over
 * the service's input limit is refused as `too_long` before it is sent (and a
 * "too long" rejection from the service is read the same way).
 *
 * LOCAL (not hosted): unchanged — no key → no-op { ok: true }; any error is
 * logged and the prompt is ALLOWED (fail-open).
 *
 * Empty or whitespace-only text is never checked and never refused.
 */
import { captureError } from './observe'
import { isHosted } from './deployMode'
import { MeterRefusalError } from './requestMeter'

export type ModerationFailure = 'unavailable' | 'too_long'
export type ModerationResult =
  | { ok: true }
  | { ok: false; categories: string[]; reason?: ModerationFailure }

export const MODERATION_BLOCKED_MESSAGE = 'This prompt was blocked by content moderation'
export const MODERATION_UNAVAILABLE_MESSAGE = 'Sailor couldn\'t check this prompt just now. Try again in a moment.'
export const MODERATION_TOO_LONG_MESSAGE = 'This prompt is too long to check. Shorten it and try again.'

/**
 * OpenAI documents 32,768 tokens for its moderation model. Checked in UTF-8
 * bytes: a token is never less than one byte, so a text within this many
 * bytes can never be over the token limit, whatever its script.
 */
export const MODERATION_MAX_INPUT_BYTES = 32_768

let fetchOverride: typeof fetch | null = null
export function __setModerationFetchForTests(fn: typeof fetch | null): void { fetchOverride = fn }

const DEFAULT_TIMEOUT_MS = 4000
const DEFAULT_RETRY_DELAY_MS = 300
let timing = { timeoutMs: DEFAULT_TIMEOUT_MS, retryDelayMs: DEFAULT_RETRY_DELAY_MS }
export function __setModerationTimingForTests(t: Partial<typeof timing> | null): void {
  timing = t ? { ...timing, ...t } : { timeoutMs: DEFAULT_TIMEOUT_MS, retryDelayMs: DEFAULT_RETRY_DELAY_MS }
}

/** The refusal a caller throws for a not-ok result: blocked, unavailable or too long. */
export function moderationRefusal(mod: { ok: false; categories: string[]; reason?: ModerationFailure }): MeterRefusalError {
  if (mod.reason === 'unavailable') return new MeterRefusalError(MODERATION_UNAVAILABLE_MESSAGE, 503, { reason: 'moderation_unavailable' })
  if (mod.reason === 'too_long') return new MeterRefusalError(MODERATION_TOO_LONG_MESSAGE, 400, { reason: 'moderation_too_long' })
  return new MeterRefusalError(MODERATION_BLOCKED_MESSAGE, 400, { categories: mod.categories })
}

type Attempt =
  | { kind: 'result'; value: ModerationResult }
  | { kind: 'too_long' }
  | { kind: 'failed'; status?: number; error?: unknown }

const TOO_LONG_TEXT = /too long|too large|maximum (context|input)|context length|too many tokens|token limit|max(imum)?[_ ]tokens/i

async function attempt(key: string, text: string): Promise<Attempt> {
  const doFetch = fetchOverride ?? fetch
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timing.timeoutMs)
    let res: any
    try {
      res = await doFetch('https://api.openai.com/v1/moderations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: 'omni-moderation-latest', input: text }),
        signal: ctrl.signal,
      })
    } finally { clearTimeout(t) }
    if (!res?.ok) {
      if (res?.status === 400 || res?.status === 413) {
        const body = await res.json?.().catch(() => null)
        const msg = String(body?.error?.message ?? body?.error?.code ?? '')
        if (res.status === 413 || TOO_LONG_TEXT.test(msg)) return { kind: 'too_long' }
      }
      return { kind: 'failed', status: res?.status }
    }
    const data = await res.json()
    const result = data?.results?.[0]
    if (!result) return { kind: 'failed', status: res.status }
    if (result.flagged) {
      const categories = Object.entries(result.categories ?? {}).filter(([, v]) => v === true).map(([k]) => k)
      return { kind: 'result', value: { ok: false, categories } }
    }
    return { kind: 'result', value: { ok: true } }
  } catch (e) {
    return { kind: 'failed', error: e }
  }
}

export async function moderatePrompt(text: string, opts: { hosted?: boolean } = {}): Promise<ModerationResult> {
  if (!text || !text.trim()) return { ok: true }
  const key = process.env.OPENAI_API_KEY
  const hosted = opts.hosted ?? isHosted()

  if (!hosted) {
    // Local: fail-open, exactly as before G3.
    if (!key) return { ok: true }
    const r = await attempt(key, text)
    if (r.kind === 'result') return r.value
    console.error('[moderation] failed — failing open (local)', { status: (r as any).status, error: (r as any).error })
    captureError((r as any).error ?? new Error('moderation: failed — failing open'), { site: 'moderatePrompt', status: (r as any).status })
    return { ok: true }
  }

  // Hosted: fail-closed.
  if (!key) {
    console.error('[moderation] no OPENAI_API_KEY in hosted mode — refusing')
    captureError(new Error('moderation: no key in hosted mode — refusing'), { site: 'moderatePrompt' })
    return { ok: false, categories: [], reason: 'unavailable' }
  }
  if (Buffer.byteLength(text, 'utf8') > MODERATION_MAX_INPUT_BYTES) return { ok: false, categories: [], reason: 'too_long' }

  let last: Attempt | null = null
  for (let i = 0; i < 2; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, timing.retryDelayMs))
    last = await attempt(key, text)
    if (last.kind === 'result') return last.value
    if (last.kind === 'too_long') return { ok: false, categories: [], reason: 'too_long' }
  }
  const failed = last as Extract<Attempt, { kind: 'failed' }>
  console.error('[moderation] failed twice — refusing (hosted)', { status: failed.status, error: failed.error })
  captureError(failed.error ?? new Error('moderation: non-200 twice — refusing'), { site: 'moderatePrompt', status: failed.status })
  return { ok: false, categories: [], reason: 'unavailable' }
}
