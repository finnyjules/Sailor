import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  moderatePrompt, moderationRefusal, __setModerationFetchForTests, __setModerationTimingForTests,
  MODERATION_MAX_INPUT_BYTES, MODERATION_UNAVAILABLE_MESSAGE, MODERATION_TOO_LONG_MESSAGE, MODERATION_BLOCKED_MESSAGE,
} from '../../server/utils/moderation'

const saved = { clerk: process.env.NUXT_CLERK_SECRET_KEY, openai: process.env.OPENAI_API_KEY }
beforeEach(() => {
  __setModerationFetchForTests(null)
  __setModerationTimingForTests({ timeoutMs: 30, retryDelayMs: 1 })
  delete process.env.OPENAI_API_KEY
  delete process.env.NUXT_CLERK_SECRET_KEY
})
afterEach(() => {
  __setModerationFetchForTests(null)
  __setModerationTimingForTests(null)
  for (const [k, v] of [['NUXT_CLERK_SECRET_KEY', saved.clerk], ['OPENAI_API_KEY', saved.openai]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

const clean = () => ({ ok: true, status: 200, json: async () => ({ results: [{ flagged: false, categories: {} }] }) })
const fail500 = () => ({ ok: false, status: 500, json: async () => ({}) })
const hang = () => vi.fn((_u: string, init: any) => new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))))

describe('moderatePrompt — local (unchanged, fails open)', () => {
  it('no key → ok (no-op, no fetch)', async () => {
    const spy = vi.fn(); __setModerationFetchForTests(spy)
    expect(await moderatePrompt('anything')).toEqual({ ok: true })
    expect(spy).not.toHaveBeenCalled()
  })
  it('empty text → ok, no fetch', async () => {
    process.env.OPENAI_API_KEY = 'sk-x'; const spy = vi.fn(); __setModerationFetchForTests(spy)
    expect(await moderatePrompt('   ')).toEqual({ ok: true })
    expect(spy).not.toHaveBeenCalled()
  })
  it('flagged → not ok with categories', async () => {
    process.env.OPENAI_API_KEY = 'sk-x'
    __setModerationFetchForTests(vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [{ flagged: true, categories: { violence: true, hate: false } }] }) }))
    expect(await moderatePrompt('bad')).toEqual({ ok: false, categories: ['violence'] })
  })
  it('OpenAI error → FAIL-OPEN (ok:true), one attempt', async () => {
    process.env.OPENAI_API_KEY = 'sk-x'
    const f = vi.fn().mockRejectedValue(new Error('down')); __setModerationFetchForTests(f)
    expect(await moderatePrompt('x')).toEqual({ ok: true })
    expect(f).toHaveBeenCalledTimes(1)
  })
  it('non-200 → FAIL-OPEN', async () => {
    process.env.OPENAI_API_KEY = 'sk-x'
    __setModerationFetchForTests(vi.fn().mockResolvedValue(fail500()))
    expect(await moderatePrompt('x')).toEqual({ ok: true })
  })
  it('over-long text → still sent and fails open (local is unaffected by G3)', async () => {
    process.env.OPENAI_API_KEY = 'sk-x'
    const f = vi.fn().mockResolvedValue(clean()); __setModerationFetchForTests(f)
    expect(await moderatePrompt('a'.repeat(MODERATION_MAX_INPUT_BYTES + 1))).toEqual({ ok: true })
    expect(f).toHaveBeenCalledTimes(1)
  })
})

describe('moderatePrompt — hosted (fails closed, G3)', () => {
  beforeEach(() => { process.env.NUXT_CLERK_SECRET_KEY = 'sk_test_clerk'; process.env.OPENAI_API_KEY = 'sk-x' })

  it('hosted is read from the deploy mode when not passed', async () => {
    delete process.env.OPENAI_API_KEY
    expect(await moderatePrompt('x')).toEqual({ ok: false, categories: [], reason: 'unavailable' })
  })
  it('no key → unavailable, without a network call', async () => {
    delete process.env.OPENAI_API_KEY
    const f = vi.fn(); __setModerationFetchForTests(f)
    expect(await moderatePrompt('x', { hosted: true })).toEqual({ ok: false, categories: [], reason: 'unavailable' })
    expect(f).not.toHaveBeenCalled()
  })
  it('empty or whitespace text → ok, never refused, even with no key', async () => {
    delete process.env.OPENAI_API_KEY
    const f = vi.fn(); __setModerationFetchForTests(f)
    expect(await moderatePrompt('', { hosted: true })).toEqual({ ok: true })
    expect(await moderatePrompt('  \n ', { hosted: true })).toEqual({ ok: true })
    expect(f).not.toHaveBeenCalled()
  })
  it('a timeout twice → unavailable after exactly one retry', async () => {
    const f = hang(); __setModerationFetchForTests(f as any)
    expect(await moderatePrompt('x', { hosted: true })).toEqual({ ok: false, categories: [], reason: 'unavailable' })
    expect(f).toHaveBeenCalledTimes(2)
  })
  it('a network error twice → unavailable', async () => {
    const f = vi.fn().mockRejectedValue(new Error('down')); __setModerationFetchForTests(f)
    expect(await moderatePrompt('x', { hosted: true })).toEqual({ ok: false, categories: [], reason: 'unavailable' })
    expect(f).toHaveBeenCalledTimes(2)
  })
  it('a 500 then success → the retry passes', async () => {
    const f = vi.fn().mockResolvedValueOnce(fail500()).mockResolvedValueOnce(clean()); __setModerationFetchForTests(f)
    expect(await moderatePrompt('x', { hosted: true })).toEqual({ ok: true })
    expect(f).toHaveBeenCalledTimes(2)
  })
  it('a 500 then a flag → blocked (the retry\'s verdict stands)', async () => {
    const f = vi.fn().mockResolvedValueOnce(fail500()).mockResolvedValueOnce({ ok: true, json: async () => ({ results: [{ flagged: true, categories: { hate: true } }] }) })
    __setModerationFetchForTests(f)
    expect(await moderatePrompt('x', { hosted: true })).toEqual({ ok: false, categories: ['hate'] })
  })
  it('a 500 twice → unavailable', async () => {
    const f = vi.fn().mockResolvedValue(fail500()); __setModerationFetchForTests(f)
    expect(await moderatePrompt('x', { hosted: true })).toEqual({ ok: false, categories: [], reason: 'unavailable' })
    expect(f).toHaveBeenCalledTimes(2)
  })
  it('a 200 with no result in it → unavailable (not a pass)', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }); __setModerationFetchForTests(f)
    expect(await moderatePrompt('x', { hosted: true })).toEqual({ ok: false, categories: [], reason: 'unavailable' })
  })
  it('text over the limit → too_long, checked before sending', async () => {
    const f = vi.fn(); __setModerationFetchForTests(f)
    expect(await moderatePrompt('a'.repeat(MODERATION_MAX_INPUT_BYTES + 1), { hosted: true })).toEqual({ ok: false, categories: [], reason: 'too_long' })
    expect(f).not.toHaveBeenCalled()
  })
  it('the limit is counted in bytes, so multi-byte text is caught too', async () => {
    const f = vi.fn(); __setModerationFetchForTests(f)
    const text = '字'.repeat(Math.ceil(MODERATION_MAX_INPUT_BYTES / 3) + 1) // under the limit in characters, over it in bytes
    expect(text.length).toBeLessThan(MODERATION_MAX_INPUT_BYTES)
    expect(await moderatePrompt(text, { hosted: true })).toMatchObject({ ok: false, reason: 'too_long' })
    expect(f).not.toHaveBeenCalled()
  })
  it('text exactly at the limit is sent', async () => {
    const f = vi.fn().mockResolvedValue(clean()); __setModerationFetchForTests(f)
    expect(await moderatePrompt('a'.repeat(MODERATION_MAX_INPUT_BYTES), { hosted: true })).toEqual({ ok: true })
  })
  it('the service rejecting the input as too long → too_long, not retried', async () => {
    const f = vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: { message: 'This model\'s maximum context length is 32768 tokens.' } }) })
    __setModerationFetchForTests(f)
    expect(await moderatePrompt('x', { hosted: true })).toEqual({ ok: false, categories: [], reason: 'too_long' })
    expect(f).toHaveBeenCalledTimes(1)
  })
  it('any other 400 → unavailable after a retry', async () => {
    const f = vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: { message: 'Invalid model' } }) })
    __setModerationFetchForTests(f)
    expect(await moderatePrompt('x', { hosted: true })).toEqual({ ok: false, categories: [], reason: 'unavailable' })
    expect(f).toHaveBeenCalledTimes(2)
  })
})

describe('moderationRefusal', () => {
  it('each reason gets its own plain message', () => {
    expect(moderationRefusal({ ok: false, categories: [], reason: 'unavailable' })).toMatchObject({ statusCode: 503, message: MODERATION_UNAVAILABLE_MESSAGE })
    expect(moderationRefusal({ ok: false, categories: [], reason: 'too_long' })).toMatchObject({ statusCode: 400, message: MODERATION_TOO_LONG_MESSAGE })
    expect(moderationRefusal({ ok: false, categories: ['violence'] })).toMatchObject({ statusCode: 400, message: MODERATION_BLOCKED_MESSAGE, data: { categories: ['violence'] } })
  })
  it('the messages are exactly the agreed wording', () => {
    expect(MODERATION_UNAVAILABLE_MESSAGE).toBe('Sailor couldn\'t check this prompt just now. Try again in a moment.')
    expect(MODERATION_TOO_LONG_MESSAGE).toBe('This prompt is too long to check. Shorten it and try again.')
  })
})
