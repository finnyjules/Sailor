/**
 * Prompt-side moderation via OpenAI's free moderation endpoint.
 *
 * HOSTED: FAIL-CLOSED (user decision 09-26, G3). A missing OPENAI_API_KEY, a
 * non-200, a network error or a timeout is tried once more after a short
 * pause, then refused as `unavailable` — so an outage, or a prompt padded until
 * the service rejects it, can never reach a paid provider unchecked. Text over
 * the service's input limit is refused as `too_long` before it is sent (and a
 * "too long" rejection from the service is read the same way). Each attempt,
 * body included, is bounded by the time limit; a 429's Retry-After is honoured
 * (capped) for the one retry. Texts the service recently passed are not sent
 * again (see `passed`).
 *
 * LOCAL (not hosted): unchanged — no key → no-op { ok: true }; any error is
 * logged and the prompt is ALLOWED (fail-open).
 *
 * Empty or whitespace-only text is never checked and never refused.
 */
import { createHash } from 'node:crypto'
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

const DEFAULT_TIMEOUT_MS = 4000
const DEFAULT_RETRY_DELAY_MS = 300
/** The longest a 429's Retry-After may hold back the one retry. */
const DEFAULT_RETRY_AFTER_CAP_MS = 2000
const DEFAULT_TIMING = { timeoutMs: DEFAULT_TIMEOUT_MS, retryDelayMs: DEFAULT_RETRY_DELAY_MS, retryAfterCapMs: DEFAULT_RETRY_AFTER_CAP_MS }
let timing = { ...DEFAULT_TIMING }
export function __setModerationTimingForTests(t: Partial<typeof timing> | null): void {
  timing = t ? { ...timing, ...t } : { ...DEFAULT_TIMING }
}

/**
 * Texts the service recently PASSED, keyed by sha256 of the text, so the same
 * text checked again (a retried run, text2img's copies of one prompt) makes no
 * second call. Only a real pass from the service is kept — never a flag, a
 * failure, or a local fail-open. Bounded in time and size.
 */
const PASS_TTL_MS = 10 * 60_000
const PASS_CACHE_MAX = 1000
const passed = new Map<string, number>()
/** Checks of the same text already in flight share one call. */
const inflight = new Map<string, Promise<ModerationResult>>()

let fetchOverride: typeof fetch | null = null
/** Also empties the pass cache, so each test's fake service is the one asked. */
export function __setModerationFetchForTests(fn: typeof fetch | null): void {
  fetchOverride = fn
  passed.clear()
  inflight.clear()
}

function textKey(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}
function recentlyPassed(key: string): boolean {
  const until = passed.get(key)
  if (until === undefined) return false
  if (until > Date.now()) return true
  passed.delete(key)
  return false
}
function rememberPass(key: string): void {
  passed.delete(key)
  passed.set(key, Date.now() + PASS_TTL_MS)
  while (passed.size > PASS_CACHE_MAX) passed.delete(passed.keys().next().value as string)
}

/** The refusal a caller throws for a not-ok result: blocked, unavailable or too long. */
export function moderationRefusal(mod: { ok: false; categories: string[]; reason?: ModerationFailure }): MeterRefusalError {
  if (mod.reason === 'unavailable') return new MeterRefusalError(MODERATION_UNAVAILABLE_MESSAGE, 503, { reason: 'moderation_unavailable' })
  if (mod.reason === 'too_long') return new MeterRefusalError(MODERATION_TOO_LONG_MESSAGE, 400, { reason: 'moderation_too_long' })
  return new MeterRefusalError(MODERATION_BLOCKED_MESSAGE, 400, { categories: mod.categories })
}

/**
 * Check each distinct non-blank text on its own, all at once, and answer with
 * the first not-ok result to come back (without waiting for the rest), else
 * ok. A check that throws rejects. No text → ok with no check, so a run with
 * nothing to read can never be refused by moderation.
 */
export function moderateTexts(texts: readonly string[], check: (text: string) => Promise<ModerationResult>): Promise<ModerationResult> {
  const unique = [...new Set(texts.filter(t => typeof t === 'string' && t.trim()))]
  if (!unique.length) return Promise.resolve({ ok: true })
  return new Promise((resolve, reject) => {
    let left = unique.length
    for (const text of unique) {
      check(text).then((r) => {
        if (!r.ok) resolve(r)
        else if (--left === 0) resolve({ ok: true })
      }, reject)
    }
  })
}

type Attempt =
  | { kind: 'result'; value: ModerationResult }
  | { kind: 'too_long' }
  | { kind: 'failed'; status?: number; error?: unknown; retryAfterMs?: number }

/**
 * A 400 is read as "too long" only when the service says so about the input:
 * its too-long error codes, or wording about the input's length. Anything
 * else (a bad parameter such as max_tokens, a bad model) is a failure.
 */
const TOO_LONG_CODES = new Set(['context_length_exceeded', 'string_above_max_length', 'input_too_long'])
const TOO_LONG_TEXT = /maximum context length|context length exceeded|input is too long|input too long|string too long|too many tokens in (the )?input/i

/** Retry-After as milliseconds: delta-seconds or an HTTP date (`retry-after-ms` preferred when sent). */
function retryAfterMs(res: any): number | undefined {
  const get = (name: string): string | null => {
    try { return res?.headers?.get?.(name) ?? null } catch { return null }
  }
  const ms = Number(get('retry-after-ms'))
  if (get('retry-after-ms') !== null && Number.isFinite(ms) && ms >= 0) return ms
  const raw = get('retry-after')
  if (raw === null || !raw.trim()) return undefined
  const secs = Number(raw)
  if (Number.isFinite(secs)) return secs >= 0 ? secs * 1000 : undefined
  const at = Date.parse(raw)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined
}

/** One request and its body, start to finish. Never throws. */
async function exchange(key: string, text: string, signal: AbortSignal): Promise<Attempt> {
  const doFetch = fetchOverride ?? fetch
  try {
    const res: any = await doFetch('https://api.openai.com/v1/moderations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: 'omni-moderation-latest', input: text }),
      signal,
    })
    if (!res?.ok) {
      if (res?.status === 413) return { kind: 'too_long' }
      if (res?.status === 400) {
        const body = await res.json?.().catch(() => null)
        const code = String(body?.error?.code ?? '')
        const msg = String(body?.error?.message ?? '')
        if (TOO_LONG_CODES.has(code) || (!/max_tokens/i.test(msg) && TOO_LONG_TEXT.test(msg))) return { kind: 'too_long' }
      }
      return { kind: 'failed', status: res?.status, retryAfterMs: res?.status === 429 ? retryAfterMs(res) : undefined }
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

/**
 * One attempt, bounded as a whole by the time limit: the headers AND the body.
 * A service that sends its headers and then stalls fails here in time.
 */
async function attempt(key: string, text: string): Promise<Attempt> {
  const ctrl = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<Attempt>((resolve) => {
    timer = setTimeout(() => {
      ctrl.abort()
      resolve({ kind: 'failed', error: new Error(`moderation: no answer within ${timing.timeoutMs} ms`) })
    }, timing.timeoutMs)
  })
  try { return await Promise.race([exchange(key, text, ctrl.signal), deadline]) }
  finally { clearTimeout(timer) }
}

export async function moderatePrompt(text: string, opts: { hosted?: boolean } = {}): Promise<ModerationResult> {
  if (!text || !text.trim()) return { ok: true }
  const key = process.env.OPENAI_API_KEY
  const hosted = opts.hosted ?? isHosted()

  if (!hosted) {
    // Local: fail-open, exactly as before G3.
    if (!key) return { ok: true }
    const h = textKey(text)
    if (recentlyPassed(h)) return { ok: true }
    const r = await attempt(key, text)
    if (r.kind === 'result') {
      if (r.value.ok) rememberPass(h)
      return r.value
    }
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

  const h = textKey(text)
  if (recentlyPassed(h)) return { ok: true }
  const running = inflight.get(h)
  if (running) return running
  const check = hostedCheck(key, text, h)
  inflight.set(h, check)
  try { return await check }
  finally { if (inflight.get(h) === check) inflight.delete(h) }
}

async function hostedCheck(key: string, text: string, h: string): Promise<ModerationResult> {
  let last: Attempt | null = null
  for (let i = 0; i < 2; i++) {
    if (i > 0) {
      const f = last as Extract<Attempt, { kind: 'failed' }>
      // A 429 waits what the service asked, up to a small cap; anything else the short pause.
      const wait = f.status === 429 && f.retryAfterMs !== undefined
        ? Math.max(timing.retryDelayMs, Math.min(f.retryAfterMs, timing.retryAfterCapMs))
        : timing.retryDelayMs
      await new Promise(r => setTimeout(r, wait))
    }
    last = await attempt(key, text)
    if (last.kind === 'result') {
      if (last.value.ok) rememberPass(h)
      return last.value
    }
    if (last.kind === 'too_long') return { ok: false, categories: [], reason: 'too_long' }
  }
  const failed = last as Extract<Attempt, { kind: 'failed' }>
  console.error('[moderation] failed twice — refusing (hosted)', { status: failed.status, error: failed.error })
  captureError(failed.error ?? new Error('moderation: non-200 twice — refusing'), { site: 'moderatePrompt', status: failed.status })
  return { ok: false, categories: [], reason: 'unavailable' }
}
