/**
 * Task 2 (Stage 4 metering): wiring the meter into the two provider
 * chokepoints — runReplicate (server/utils/replicate.ts) and runFal
 * (server/utils/falRun.ts). Both call preflightMeter(model) BEFORE any
 * provider HTTP call (so a 402/refusal never touches the network), and
 * settle the ticket ONLY at the exact point the existing ok:true logSpend
 * already fires — never on failure/timeout paths.
 *
 * replicate.ts references `createError`, a Nitro auto-import that doesn't
 * exist under plain vitest — stub it globally, the auth-middleware-helpers
 * pattern. `fetch` is mocked globally with canned Replicate/fal HTTP
 * responses so no real network call is ever made.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runReplicate } from '../../server/utils/replicate'
import { runFal } from '../../server/utils/falRun'
import {
  __resetMeterContextForTests,
  __setLedgerForTests,
  __setSpendGuardForTests,
  bindMeterContext,
} from '../../server/utils/requestMeter'
import { __setModerationFetchForTests } from '../../server/utils/moderation'

const g = globalThis as any
g.createError = (opts: { statusCode: number, message?: string, statusMessage?: string }) => {
  const err = new Error(opts.message ?? opts.statusMessage) as Error & { statusCode: number }
  err.statusCode = opts.statusCode
  return err
}

const CLERK_KEY = 'NUXT_CLERK_SECRET_KEY'
const savedClerkKey = process.env[CLERK_KEY]
const savedFalKey = process.env.FAL_KEY
const savedOpenAiKey = process.env.OPENAI_API_KEY

function setHosted(): void {
  process.env[CLERK_KEY] = 'sk_test_hosted'
}
function setLocal(): void {
  delete process.env[CLERK_KEY]
}

/**
 * Stage 5 Task 2: the chokepoint tickets are HOLD-based. `hold` reserves
 * against a live counter here too, so "refuses before any fetch" is driven
 * by a genuinely refused hold rather than by a stubbed comparison.
 */
type FakeLedger = {
  getAvailable: ReturnType<typeof vi.fn>
  hold: ReturnType<typeof vi.fn>
  settleHold: ReturnType<typeof vi.fn>
  releaseHold: ReturnType<typeof vi.fn>
  debit: ReturnType<typeof vi.fn>
  setAvailable(n: number): void
}
function makeFakeLedger(startingAvailable = 1000): FakeLedger {
  let available = startingAvailable
  let holdSeq = 0
  return {
    getAvailable: vi.fn(async (_userId: string) => available),
    hold: vi.fn(async (_userId: string, estimate: number, _key: string) => {
      if (estimate > available) return { ok: false as const, reason: 'insufficient' as const }
      available -= estimate
      return { ok: true as const, holdId: ++holdSeq }
    }),
    settleHold: vi.fn(async (_holdId: number, _actual: number, _reason: string) => ({ ok: true as const, balance: 0, settled: true })),
    releaseHold: vi.fn(async (_holdId: number) => {}),
    debit: vi.fn(async (_userId: string, _amount: number, _reason: string, _key: string) => ({ ok: true })),
    setAvailable(n: number) { available = n },
  }
}
let fakeLedger: FakeLedger

function jsonResponse(body: unknown, ok = true, status = 200): any {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    statusText: ok ? 'OK' : 'Error',
  }
}

const REPLICATE_MODEL = 'black-forest-labs/flux-dev' // priced in MODEL_COSTS
const FAL_APP = 'fal-ai/flux/dev' // priced in MODEL_COSTS

type ReplicateScenario = 'succeeded' | 'failed' | 'submit-error' | 'lookup-error'

function makeReplicateFetchMock(scenario: ReplicateScenario): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string) => {
    if (url === `https://api.replicate.com/v1/models/${REPLICATE_MODEL}`) {
      if (scenario === 'lookup-error') return jsonResponse({ detail: 'nope' }, false, 500)
      return jsonResponse({ latest_version: { id: 'v1' } })
    }
    if (url === 'https://api.replicate.com/v1/predictions') {
      if (scenario === 'submit-error') return jsonResponse({ detail: 'rejected' }, false, 422)
      return jsonResponse({
        id: 'pred123',
        status: scenario,
        output: scenario === 'succeeded' ? ['https://out.png'] : undefined,
        error: scenario === 'failed' ? 'boom' : undefined,
      })
    }
    throw new Error('unexpected replicate fetch url: ' + url)
  })
}

type FalScenario = 'COMPLETED' | 'FAILED' | 'submit-error' | 'result-error' | 'status-4xx'

function makeFalFetchMock(scenario: FalScenario): ReturnType<typeof vi.fn> {
  const base = `https://queue.fal.run/${FAL_APP}`
  return vi.fn(async (url: string) => {
    if (url === base) {
      if (scenario === 'submit-error') return jsonResponse({ detail: 'rejected' }, false, 422)
      return jsonResponse({
        request_id: 'req1',
        status_url: `${base}/requests/req1/status`,
        response_url: `${base}/requests/req1`,
      })
    }
    if (url === `${base}/requests/req1/status`) {
      if (scenario === 'status-4xx') return jsonResponse({ detail: 'gone' }, false, 404)
      return jsonResponse({ status: scenario === 'result-error' ? 'COMPLETED' : scenario })
    }
    if (url === `${base}/requests/req1`) {
      if (scenario === 'result-error') return jsonResponse({ detail: 'boom' }, false, 500)
      return jsonResponse({ images: [{ url: 'https://out.png' }] })
    }
    throw new Error('unexpected fal fetch url: ' + url)
  })
}

beforeEach(() => {
  __resetMeterContextForTests()
  fakeLedger = makeFakeLedger()
  __setLedgerForTests(fakeLedger as any)
  // Stage 7 Task 4 + final review C2: preflight now calls the operator
  // safety-valve guard first. These hosted tests run with no live controls db,
  // so inject a no-op — the guard's own behavior is covered in
  // system-controls.unit.spec.ts. Without this the real assertSpendAllowed
  // hits db() and fail-closes to 503 on a missing DATABASE_URL.
  __setSpendGuardForTests(async () => {})
  process.env.FAL_KEY = 'test-fal-key'
  // Byte-identity for the existing cases: no OPENAI_API_KEY → moderatePrompt is
  // a no-op that never touches fetch (a real key on the dev box must not make
  // these assertions hit the OpenAI endpoint). Cases that exercise moderation
  // set the key + inject a moderation fetch explicitly.
  delete process.env.OPENAI_API_KEY
  __setModerationFetchForTests(null)
})

afterEach(() => {
  if (savedClerkKey === undefined) delete process.env[CLERK_KEY]
  else process.env[CLERK_KEY] = savedClerkKey
  if (savedFalKey === undefined) delete process.env.FAL_KEY
  else process.env.FAL_KEY = savedFalKey
  if (savedOpenAiKey === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = savedOpenAiKey
  __setModerationFetchForTests(null)
  __setLedgerForTests(null)
  __setSpendGuardForTests(null)
  __resetMeterContextForTests()
  vi.unstubAllGlobals()
})

/** A moderation fetch stub that flags every prompt with the given categories. */
function flaggedModerationFetch(categories: Record<string, boolean> = { violence: true }): ReturnType<typeof vi.fn> {
  return vi.fn(async () => jsonResponse({ results: [{ flagged: true, categories }] }))
}

describe('runReplicate + meter', () => {
  it('local mode: no ledger interaction, output round-trips unchanged', async () => {
    setLocal()
    const fetchMock = makeReplicateFetchMock('succeeded')
    vi.stubGlobal('fetch', fetchMock)

    const output = await runReplicate(REPLICATE_MODEL, { prompt: 'x' }, 'tok')

    expect(output).toEqual(['https://out.png'])
    expect(fakeLedger.hold).not.toHaveBeenCalled()
    expect(fakeLedger.settleHold).not.toHaveBeenCalled()
    expect(fakeLedger.releaseHold).not.toHaveBeenCalled()
  })

  it('hosted, success: holds before dispatch and settles that hold exactly once', async () => {
    setHosted()
    bindMeterContext({ userId: 'u1' })
    fakeLedger.setAvailable(100)
    const fetchMock = makeReplicateFetchMock('succeeded')
    vi.stubGlobal('fetch', fetchMock)

    const output = await runReplicate(REPLICATE_MODEL, { prompt: 'x' }, 'tok')

    expect(output).toEqual(['https://out.png'])
    expect(fakeLedger.hold).toHaveBeenCalledWith('u1', 5, expect.stringMatching(/^meter:/))
    expect(fakeLedger.settleHold).toHaveBeenCalledTimes(1)
    expect(fakeLedger.settleHold).toHaveBeenCalledWith(1, 5, `provider:${REPLICATE_MODEL}`)
    expect(fakeLedger.releaseHold).not.toHaveBeenCalled()
  })

  it('hosted, provider failure: RELEASES the hold, never settles, still throws', async () => {
    setHosted()
    bindMeterContext({ userId: 'u1' })
    fakeLedger.setAvailable(100)
    const fetchMock = makeReplicateFetchMock('failed')
    vi.stubGlobal('fetch', fetchMock)

    await expect(runReplicate(REPLICATE_MODEL, { prompt: 'x' }, 'tok')).rejects.toMatchObject({ statusCode: 502 })
    expect(fakeLedger.settleHold).not.toHaveBeenCalled()
    expect(fakeLedger.releaseHold).toHaveBeenCalledWith(1)
  })

  it('hosted, submit rejected by the provider: RELEASES the hold, never settles', async () => {
    setHosted()
    bindMeterContext({ userId: 'u1' })
    fakeLedger.setAvailable(100)
    vi.stubGlobal('fetch', makeReplicateFetchMock('submit-error'))

    await expect(runReplicate(REPLICATE_MODEL, { prompt: 'x' }, 'tok')).rejects.toMatchObject({ statusCode: 502 })
    expect(fakeLedger.settleHold).not.toHaveBeenCalled()
    expect(fakeLedger.releaseHold).toHaveBeenCalledWith(1)
  })

  it('hosted, version lookup fails before submit: RELEASES the hold', async () => {
    setHosted()
    bindMeterContext({ userId: 'u1' })
    fakeLedger.setAvailable(100)
    vi.stubGlobal('fetch', makeReplicateFetchMock('lookup-error'))

    await expect(runReplicate(REPLICATE_MODEL, { prompt: 'x' }, 'tok')).rejects.toMatchObject({ statusCode: 502 })
    expect(fakeLedger.settleHold).not.toHaveBeenCalled()
    expect(fakeLedger.releaseHold).toHaveBeenCalledWith(1)
  })

  it('hosted, polling times out: RELEASES the hold', async () => {
    setHosted()
    bindMeterContext({ userId: 'u1' })
    fakeLedger.setAvailable(100)
    // A prediction that never leaves 'processing' + a zero timeout budget.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === `https://api.replicate.com/v1/models/${REPLICATE_MODEL}`) return jsonResponse({ latest_version: { id: 'v1' } })
      return jsonResponse({ id: 'pred123', status: 'processing' })
    }))

    await expect(runReplicate(REPLICATE_MODEL, { prompt: 'x' }, 'tok', { timeoutMs: -1, pollMs: 1 }))
      .rejects.toMatchObject({ statusCode: 504 })
    expect(fakeLedger.settleHold).not.toHaveBeenCalled()
    expect(fakeLedger.releaseHold).toHaveBeenCalledWith(1)
  })

  it('hosted, insufficient credits: refuses before any fetch (402), holds nothing to release', async () => {
    setHosted()
    bindMeterContext({ userId: 'u1' })
    fakeLedger.setAvailable(0)
    const fetchMock = makeReplicateFetchMock('succeeded')
    vi.stubGlobal('fetch', fetchMock)

    await expect(runReplicate(REPLICATE_MODEL, { prompt: 'x' }, 'tok')).rejects.toMatchObject({ statusCode: 402 })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(fakeLedger.settleHold).not.toHaveBeenCalled()
    expect(fakeLedger.releaseHold).not.toHaveBeenCalled()
  })

  // Stage 7 Task 3: a moderation-flagged prompt is refused (400) AFTER the hold
  // is placed but BEFORE any provider HTTP call — the hold is RELEASED (refusal
  // costs nothing) and dispatch never runs.
  it('hosted, moderation flags the prompt: RELEASES the hold, dispatch never runs (400)', async () => {
    setHosted()
    bindMeterContext({ userId: 'u1' })
    fakeLedger.setAvailable(100)
    process.env.OPENAI_API_KEY = 'sk-x'
    __setModerationFetchForTests(flaggedModerationFetch())
    const fetchMock = makeReplicateFetchMock('succeeded')
    vi.stubGlobal('fetch', fetchMock)

    await expect(runReplicate(REPLICATE_MODEL, { prompt: 'a forbidden thing' }, 'tok'))
      .rejects.toMatchObject({ statusCode: 400, data: { categories: ['violence'] } })
    expect(fetchMock).not.toHaveBeenCalled() // dispatch never touched the provider
    expect(fakeLedger.hold).toHaveBeenCalledWith('u1', 5, expect.stringMatching(/^meter:/))
    expect(fakeLedger.releaseHold).toHaveBeenCalledWith(1)
    expect(fakeLedger.settleHold).not.toHaveBeenCalled()
  })
})

describe('runFal + meter', () => {
  it('local mode: no ledger interaction, result round-trips unchanged', async () => {
    setLocal()
    const fetchMock = makeFalFetchMock('COMPLETED')
    vi.stubGlobal('fetch', fetchMock)

    const result = await runFal(FAL_APP, { prompt: 'x' }, { pollIntervalMs: 1 })

    expect(result).toEqual({ images: [{ url: 'https://out.png' }] })
    expect(fakeLedger.hold).not.toHaveBeenCalled()
    expect(fakeLedger.settleHold).not.toHaveBeenCalled()
    expect(fakeLedger.releaseHold).not.toHaveBeenCalled()
  })

  it('hosted, success: holds before dispatch and settles that hold exactly once', async () => {
    setHosted()
    bindMeterContext({ userId: 'u1' })
    fakeLedger.setAvailable(100)
    const fetchMock = makeFalFetchMock('COMPLETED')
    vi.stubGlobal('fetch', fetchMock)

    const result = await runFal(FAL_APP, { prompt: 'x' }, { pollIntervalMs: 1 })

    expect(result).toEqual({ images: [{ url: 'https://out.png' }] })
    expect(fakeLedger.hold).toHaveBeenCalledWith('u1', 5, expect.stringMatching(/^meter:/))
    expect(fakeLedger.settleHold).toHaveBeenCalledTimes(1)
    expect(fakeLedger.settleHold).toHaveBeenCalledWith(1, 5, `provider:${FAL_APP}`)
    expect(fakeLedger.releaseHold).not.toHaveBeenCalled()
  })

  it('hosted, provider failure: RELEASES the hold, never settles, still throws', async () => {
    setHosted()
    bindMeterContext({ userId: 'u1' })
    fakeLedger.setAvailable(100)
    const fetchMock = makeFalFetchMock('FAILED')
    vi.stubGlobal('fetch', fetchMock)

    await expect(runFal(FAL_APP, { prompt: 'x' }, { pollIntervalMs: 1 })).rejects.toThrow()
    expect(fakeLedger.settleHold).not.toHaveBeenCalled()
    expect(fakeLedger.releaseHold).toHaveBeenCalledWith(1)
  })

  it('hosted, submit rejected by fal: RELEASES the hold, never settles', async () => {
    setHosted()
    bindMeterContext({ userId: 'u1' })
    fakeLedger.setAvailable(100)
    vi.stubGlobal('fetch', makeFalFetchMock('submit-error'))

    await expect(runFal(FAL_APP, { prompt: 'x' }, { pollIntervalMs: 1 })).rejects.toThrow(/fal submit 422/)
    expect(fakeLedger.settleHold).not.toHaveBeenCalled()
    expect(fakeLedger.releaseHold).toHaveBeenCalledWith(1)
  })

  it('hosted, non-retryable 4xx while polling: RELEASES the hold', async () => {
    setHosted()
    bindMeterContext({ userId: 'u1' })
    fakeLedger.setAvailable(100)
    vi.stubGlobal('fetch', makeFalFetchMock('status-4xx'))

    await expect(runFal(FAL_APP, { prompt: 'x' }, { pollIntervalMs: 1 })).rejects.toThrow(/not retryable/)
    expect(fakeLedger.settleHold).not.toHaveBeenCalled()
    expect(fakeLedger.releaseHold).toHaveBeenCalledWith(1)
  })

  it('hosted, COMPLETED but the result fetch fails: RELEASES the hold (no output was delivered)', async () => {
    setHosted()
    bindMeterContext({ userId: 'u1' })
    fakeLedger.setAvailable(100)
    vi.stubGlobal('fetch', makeFalFetchMock('result-error'))

    await expect(runFal(FAL_APP, { prompt: 'x' }, { pollIntervalMs: 1 })).rejects.toThrow(/fal result 500/)
    expect(fakeLedger.settleHold).not.toHaveBeenCalled()
    expect(fakeLedger.releaseHold).toHaveBeenCalledWith(1)
  })

  it('hosted, polling deadline expires: RELEASES the hold', async () => {
    setHosted()
    bindMeterContext({ userId: 'u1' })
    fakeLedger.setAvailable(100)
    vi.stubGlobal('fetch', makeFalFetchMock('COMPLETED'))

    await expect(runFal(FAL_APP, { prompt: 'x' }, { pollIntervalMs: 1, pollDeadlineMs: -1 }))
      .rejects.toThrow(/timed out/)
    expect(fakeLedger.settleHold).not.toHaveBeenCalled()
    expect(fakeLedger.releaseHold).toHaveBeenCalledWith(1)
  })

  it('hosted, insufficient credits: refuses before any fetch (402), holds nothing to release', async () => {
    setHosted()
    bindMeterContext({ userId: 'u1' })
    fakeLedger.setAvailable(0)
    const fetchMock = makeFalFetchMock('COMPLETED')
    vi.stubGlobal('fetch', fetchMock)

    await expect(runFal(FAL_APP, { prompt: 'x' }, { pollIntervalMs: 1 })).rejects.toMatchObject({ statusCode: 402 })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(fakeLedger.settleHold).not.toHaveBeenCalled()
    expect(fakeLedger.releaseHold).not.toHaveBeenCalled()
  })

  // Stage 7 Task 3: a moderation-flagged prompt is refused (400) AFTER the hold
  // is placed but BEFORE the fal submit — the hold is RELEASED and dispatch
  // never runs.
  it('hosted, moderation flags the prompt: RELEASES the hold, submit never runs (400)', async () => {
    setHosted()
    bindMeterContext({ userId: 'u1' })
    fakeLedger.setAvailable(100)
    process.env.OPENAI_API_KEY = 'sk-x'
    __setModerationFetchForTests(flaggedModerationFetch())
    const fetchMock = makeFalFetchMock('COMPLETED')
    vi.stubGlobal('fetch', fetchMock)

    await expect(runFal(FAL_APP, { prompt: 'a forbidden thing' }, { pollIntervalMs: 1 }))
      .rejects.toMatchObject({ statusCode: 400, data: { categories: ['violence'] } })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(fakeLedger.hold).toHaveBeenCalledWith('u1', 5, expect.stringMatching(/^meter:/))
    expect(fakeLedger.releaseHold).toHaveBeenCalledWith(1)
    expect(fakeLedger.settleHold).not.toHaveBeenCalled()
  })
})

/**
 * Coverage guard (Stage 5 Task 2), the same enforcement idea as
 * bypass-route-meter.unit.spec.ts: a hold that is neither settled nor
 * released locks the user's credits until holdSweep's 2h TTL. So every
 * server file that takes a ticket must also show a release path. A file
 * that deliberately has none carries a `HOLD-EXEMPT:` marker explaining why.
 *
 * Review finding 2: the first cut of this guard was `src.includes('.release()')`
 * — which a COMMENTED-OUT release satisfies. Demonstrated empirically:
 * commenting out replicate.ts's `await ticket?.release()` left all 11 guard
 * cases green while five behavioral cases failed, i.e. the guard contributed
 * nothing the behavior tests weren't already catching. It is now structural:
 * comments are stripped first (a string-aware stripper, so `https://` in a
 * URL isn't mistaken for a line comment), and the release has to actually sit
 * on a failure path — inside a `catch`/`finally` block, or immediately before
 * a non-success `return` (krea/rewrite.post.ts's early exit is the one such
 * case in the tree).
 */

/**
 * Blank out everything that isn't executable code: comment bodies and the
 * insides of string / template literals. String state is tracked, so a `//`
 * inside `'https://api.replicate.com'` never starts a comment — a naive
 * line-comment strip would swallow the rest of that line, including a real
 * release call. Removed text is replaced with spaces (newlines kept), so
 * every surviving character keeps its original index and the brace matching
 * below stays valid.
 */
export function stripNonCode(src: string): string {
  const out: string[] = []
  let i = 0
  const blank = (s: string): string => s.replace(/[^\n]/g, ' ')
  while (i < src.length) {
    const c = src[i]
    const next = src[i + 1]
    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i)
      const stop = end === -1 ? src.length : end
      out.push(blank(src.slice(i, stop)))
      i = stop
    } else if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end === -1 ? src.length : end + 2
      out.push(blank(src.slice(i, stop)))
      i = stop
    } else if (c === '\'' || c === '"' || c === '`') {
      const quote = c
      let j = i + 1
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue }
        if (src[j] === quote) { j++; break }
        if (quote !== '`' && src[j] === '\n') break // unterminated: bail
        j++
      }
      // Keep the quotes, blank the contents: '.release()' written inside a
      // string is prose, not a release.
      out.push(c + blank(src.slice(i + 1, Math.max(i + 1, j - 1))) + (j > i + 1 ? src[j - 1] : ''))
      i = j
    } else {
      out.push(c)
      i++
    }
  }
  return out.join('')
}

/** Index ranges of every `catch (...) { … }` / `finally { … }` block body. */
function failurePathRanges(src: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  const re = /\b(catch\s*(\([^)]*\)\s*)?|finally\s*)\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    const open = m.index + m[0].length - 1
    let depth = 0
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') {
        depth--
        if (depth === 0) { ranges.push([open, i]); break }
      }
    }
  }
  return ranges
}

/**
 * A release counts as wired when it sits inside a catch/finally body, or
 * when the very next statement is a `return` (the non-throwing early exit
 * shape). Anything else — a release on the happy path, or one that only
 * exists in a comment — does not.
 */
export function releaseIsOnAFailurePath(rawSrc: string): boolean {
  const src = stripNonCode(rawSrc)
  const ranges = failurePathRanges(src)
  const re = /\.release\(\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    const at = m.index
    if (ranges.some(([open, close]) => at > open && at < close)) return true
    const after = src.slice(at + m[0].length, at + m[0].length + 200)
    if (/^[\s;]*return\b/.test(after)) return true
  }
  return false
}

describe('every preflight call site has a release path', () => {
  const serverRoot = fileURLToPath(new URL('../../server', import.meta.url))

  function walk(dir: string, acc: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p, acc)
      else if (p.endsWith('.ts')) acc.push(p)
    }
    return acc
  }

  // holdForModelCall (anthropicMeter.ts — per-call Anthropic token metering)
  // takes the same kind of ledger hold, so its callers owe the same release.
  const callers = walk(serverRoot).filter((file) => {
    if (file.endsWith('requestMeter.ts')) return false // defines the ticket
    if (file.endsWith('anthropicMeter.ts')) return false // defines holdForModelCall's ticket
    const src = stripNonCode(readFileSync(file, 'utf8'))
    return /\bpreflightMeter(For)?\s*\(/.test(src) || /\bholdForModelCall\s*\(/.test(src)
  })

  it('sanity: the scan finds the known preflight call sites', () => {
    expect(callers.length).toBeGreaterThan(5)
  })

  it('sanity: the scan finds the holdForModelCall call site (shader-gen)', () => {
    expect(callers.some(f => f.endsWith(join('lib', 'shaderGenRequest.ts')))).toBe(true)
  })

  for (const file of callers) {
    const rel = relative(serverRoot, file)
    it(`${rel} releases its hold on a failure path (or is HOLD-EXEMPT)`, () => {
      const raw = readFileSync(file, 'utf8')
      const src = stripNonCode(raw)
      if (raw.includes('HOLD-EXEMPT:')) return

      expect(
        /\.release\(\)/.test(src),
        `${rel} takes a meter ticket but never calls ticket.release() in live code — a ` +
        'failed job there leaks a ledger hold until holdSweep\'s TTL. (Commented-out ' +
        'releases do not count: comments are stripped before this check.)',
      ).toBe(true)

      expect(
        /\bcatch\b/.test(src) || /\bfinally\b/.test(src),
        `${rel} calls .release() but has no catch/finally — nothing runs it on a failure path.`,
      ).toBe(true)

      expect(
        releaseIsOnAFailurePath(raw),
        `${rel} calls .release(), but not from inside a catch/finally block and not ` +
        'immediately before a non-success return — so a thrown provider error would ' +
        'still leak the hold.',
      ).toBe(true)
    })
  }
})

describe('the release guard itself (it must reject the shapes it exists to catch)', () => {
  it('a // inside a string literal does not start a comment (the URL trap)', () => {
    const stripped = stripNonCode('const u = "https://api.replicate.com/v1"\nawait t.release()\n')
    expect(stripped).toContain('release()') // the real call survived
  })

  it('blanks line and block comment bodies, including ones that mention release()', () => {
    expect(stripNonCode('x() // await ticket.release()')).not.toContain('release()')
    expect(stripNonCode('/* await ticket.release() */ const a = 1')).not.toContain('release()')
    expect(stripNonCode('/* c */ const a = 1')).toContain('const a = 1')
  })

  it('keeps character indexes stable (brace matching depends on it)', () => {
    const src = 'try { x() } // c\ncatch (e) { await t.release() }'
    expect(stripNonCode(src).length).toBe(src.length)
  })

  it('a COMMENTED-OUT release fails the guard (the exact defect finding 2 reported)', () => {
    const src = 'const t = await preflightMeter(m)\ntry { go() } catch (e) {\n  // await t.release()\n  throw e\n}'
    expect(src.includes('.release()')).toBe(true) // the old substring guard passed this
    expect(releaseIsOnAFailurePath(src)).toBe(false)
  })

  it('a release on the HAPPY path only fails the guard', () => {
    const src = 'const t = await preflightMeter(m)\nconst out = await go()\nawait t.release()\nsomethingElse()\ntry { x() } catch (e) { throw e }'
    expect(releaseIsOnAFailurePath(src)).toBe(false)
  })

  it('a release inside catch passes', () => {
    expect(releaseIsOnAFailurePath('try { go() } catch (e) { await ticket?.release(); throw e }')).toBe(true)
  })

  it('a release inside finally passes', () => {
    expect(releaseIsOnAFailurePath('try { go() } finally { await ticket?.release() }')).toBe(true)
  })

  it('a release immediately before a non-success return passes (krea/rewrite\'s early exit)', () => {
    expect(releaseIsOnAFailurePath('if (pred.status !== \'succeeded\') {\n  await ticket?.release()\n  return { name: null }\n}')).toBe(true)
  })

  it('a release mentioned only inside a string literal does not count', () => {
    expect(releaseIsOnAFailurePath('const s = "call .release() on failure"\ntry { x() } catch (e) { throw e }')).toBe(false)
  })
})
