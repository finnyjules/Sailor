/**
 * Task 6 (Stage 4 metering): flat-rate metering on the Anthropic "assist"
 * family — short single-message Claude calls that (like Task 4's bypass
 * routes) don't route through preflightMeter's model-priced chokepoint, so
 * they need their own gate. Two halves:
 *
 * 1. A coverage scan mirroring bypass-route-meter.unit.spec.ts's discovery
 *    approach (walk server/, filter by fetch-host string, assert every hit
 *    references the gate) so the two guards can't drift apart. Written
 *    FIRST per the task's TDD requirement — on the unmodified tree this
 *    failed for every api.anthropic.com file, because none referenced
 *    meterAssist yet. That failure was this test's RED.
 * 2. Unit tests for meterAssist itself: local no-op, hosted debit with exact
 *    args, 402 on insufficient balance, 500 on a missing (invariant-broken)
 *    context — same shape as request-meter.unit.spec.ts's preflightMeter
 *    coverage.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ANTHROPIC_ASSIST_CREDITS, holdForModelCall, meterAssist } from '../../server/utils/anthropicMeter'
import { creditsForUsd, usdForUsage } from '../../server/utils/anthropicPrices'
import { MeterRefusalError, __resetMeterContextForTests, __setLedgerForTests, bindMeterContext } from '../../server/utils/requestMeter'
import { __setSystemControlsDbForTests } from '../../server/utils/systemControls'

// A permissive controls db: not paused, no disabled users, no ceiling — so the
// operator spend guard (Stage 7 final review C1) is a pass-through and the
// existing hosted assertions exercise only the ledger path. Hosted meterAssist
// now calls assertSpendAllowed before the debit; without this seam it would hit
// the real db() and 503 on a missing DATABASE_URL.
const allowAllControlsDb = { query: async () => ({ rows: [] as any[] }) }

const serverRoot = fileURLToPath(new URL('../../server', import.meta.url))

// The exact fetch target that means "this file talks to Anthropic directly"
// — same string every wired route in this file's coverage list uses.
const ANTHROPIC_FETCH_PATTERN = 'api.anthropic.com'

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (p.endsWith('.ts')) acc.push(p)
  }
  return acc
}

describe('anthropic-meter coverage guard', () => {
  const allFiles = walk(join(serverRoot, 'api'))

  it('scan is alive (sanity: server/api has plenty of .ts files)', () => {
    expect(allFiles.length).toBeGreaterThan(10)
  })

  const anthropicFiles = allFiles.filter((file) => {
    const src = readFileSync(file, 'utf8')
    return src.includes(ANTHROPIC_FETCH_PATTERN)
  })

  it('found the full known set of Anthropic assist routes (sanity: matcher is not vacuous)', () => {
    expect(anthropicFiles.length).toBeGreaterThanOrEqual(6)
  })

  // Two ways to be metered: the flat-rate meterAssist, or a per-call token
  // meter (holdForModelCall — /api/shader-gen reaches it through
  // meterShaderGenCall in server/lib/shaderGenRequest.ts, checked below;
  // /api/prompt-route reaches it the same way through meterRouterCall in
  // server/lib/promptRouterRequest.ts).
  const TOKEN_METERED = ['holdForModelCall', 'meterShaderGenCall', 'meterRouterCall']

  for (const file of anthropicFiles) {
    const rel = relative(serverRoot, file)
    it(`${rel} references meterAssist or a token meter`, () => {
      const src = readFileSync(file, 'utf8')
      expect(
        src.includes('meterAssist') || TOKEN_METERED.some(name => src.includes(name)),
        `${rel} fetches ${ANTHROPIC_FETCH_PATTERN} but never calls meterAssist or a token meter — unmetered Anthropic spend risk.`,
      ).toBe(true)
    })
  }

  it('api/shader-gen.post.ts is metered by tokens (meterShaderGenCall), no longer by the flat meterAssist', () => {
    const src = readFileSync(join(serverRoot, 'api/shader-gen.post.ts'), 'utf8')
    expect(src).toMatch(/\bmeterShaderGenCall\s*\(/)
    expect(src.includes('meterAssist')).toBe(false)
  })

  it('meterShaderGenCall itself takes a holdForModelCall hold', () => {
    const src = readFileSync(join(serverRoot, 'lib/shaderGenRequest.ts'), 'utf8')
    expect(src).toMatch(/\bholdForModelCall\s*\(/)
  })

  it('meterRouterCall itself takes a holdForModelCall hold', () => {
    const src = readFileSync(join(serverRoot, 'lib/promptRouterRequest.ts'), 'utf8')
    expect(src).toMatch(/\bholdForModelCall\s*\(/)
  })
})

const KEY = 'NUXT_CLERK_SECRET_KEY'
const savedKey = process.env[KEY]

function setHosted(): void {
  process.env[KEY] = 'sk_test_hosted'
}
function setLocal(): void {
  delete process.env[KEY]
}

type FakeLedger = {
  getAvailable: ReturnType<typeof vi.fn>
  debit: ReturnType<typeof vi.fn>
}

function makeFakeLedger(opts: { available?: number } = {}): FakeLedger {
  const available = opts.available ?? 1000
  return {
    getAvailable: vi.fn(async (_userId: string) => available),
    debit: vi.fn(async (_userId: string, _amount: number, _reason: string, _key: string) => ({ ok: true })),
  }
}

let fakeLedger: FakeLedger
const fakeEvent = {} as any

beforeEach(() => {
  __resetMeterContextForTests()
  fakeLedger = makeFakeLedger()
  __setLedgerForTests(fakeLedger as any)
  __setSystemControlsDbForTests(allowAllControlsDb)
})

afterEach(() => {
  if (savedKey === undefined) delete process.env[KEY]
  else process.env[KEY] = savedKey
  __setLedgerForTests(null)
  __setSystemControlsDbForTests(null)
  __resetMeterContextForTests()
})

describe('meterAssist', () => {
  it('local mode: no-op — never touches the ledger', async () => {
    setLocal()
    await expect(meterAssist(fakeEvent)).resolves.toBeUndefined()
    expect(fakeLedger.getAvailable).not.toHaveBeenCalled()
    expect(fakeLedger.debit).not.toHaveBeenCalled()
  })

  it('hosted, no bound context: throws a 500 refusal (invariant break on an authed route, fail closed)', async () => {
    setHosted()
    await expect(meterAssist(fakeEvent)).rejects.toMatchObject({
      statusCode: 500,
      message: expect.stringContaining('unmetered spend refused'),
    })
    expect(fakeLedger.getAvailable).not.toHaveBeenCalled()
  })

  it('the no-context rejection is a MeterRefusalError instance', async () => {
    setHosted()
    await expect(meterAssist(fakeEvent)).rejects.toBeInstanceOf(MeterRefusalError)
  })

  // Stage 7 final review C1 (secondary bypass): the flat-rate assist path
  // debited without ever consulting the operator spend guard, so the
  // kill-switch never stopped it. A paused system must refuse (503) BEFORE the
  // debit — no ledger charge at all.
  it('hosted, system paused: refuses 503 BEFORE debiting (spend guard)', async () => {
    setHosted()
    bindMeterContext({ userId: 'u1' })
    __setSystemControlsDbForTests({ query: async () => ({ rows: [{ global_paused: true }] }) })

    await expect(meterAssist(fakeEvent)).rejects.toMatchObject({ statusCode: 503 })
    expect(fakeLedger.debit).not.toHaveBeenCalled()
  })

  it('hosted, insufficient balance: throws 402 with {required, available} and never debits', async () => {
    setHosted()
    bindMeterContext({ userId: 'u1' })
    fakeLedger.getAvailable.mockResolvedValue(ANTHROPIC_ASSIST_CREDITS - 1)

    await expect(meterAssist(fakeEvent)).rejects.toMatchObject({
      statusCode: 402,
      data: { required: ANTHROPIC_ASSIST_CREDITS, available: ANTHROPIC_ASSIST_CREDITS - 1 },
    })
    expect(fakeLedger.debit).not.toHaveBeenCalled()
  })

  it('hosted, sufficient balance: debits the current context user immediately with exact args', async () => {
    setHosted()
    bindMeterContext({ userId: 'u1' })
    fakeLedger.getAvailable.mockResolvedValue(100)

    await expect(meterAssist(fakeEvent)).resolves.toBeUndefined()

    expect(fakeLedger.getAvailable).toHaveBeenCalledWith('u1')
    expect(fakeLedger.debit).toHaveBeenCalledTimes(1)
    const [userId, amount, reason, idempotencyKey] = fakeLedger.debit.mock.calls[0]
    expect(userId).toBe('u1')
    expect(amount).toBe(ANTHROPIC_ASSIST_CREDITS)
    expect(reason).toBe('anthropic_assist')
    expect(idempotencyKey).toMatch(/^assist:[0-9a-f-]{36}$/)
  })

  it('two calls in the same context mint two distinct idempotency keys', async () => {
    setHosted()
    bindMeterContext({ userId: 'u1' })
    fakeLedger.getAvailable.mockResolvedValue(100)

    await meterAssist(fakeEvent)
    await meterAssist(fakeEvent)

    const keys = fakeLedger.debit.mock.calls.map(call => call[3])
    expect(keys[0]).not.toBe(keys[1])
  })
})

describe('ANTHROPIC_ASSIST_CREDITS', () => {
  it('is the flat rate of 2', () => {
    expect(ANTHROPIC_ASSIST_CREDITS).toBe(2)
  })
})

/**
 * holdForModelCall: per-call token metering (hold the worst case, settle to
 * the real usage). Same failure semantics as requestMeter's preflightForUser /
 * settleHoldOrLog: fail closed before the call, never throw after it.
 */
describe('holdForModelCall', () => {
  const MODEL = 'claude-opus-5-5'

  type HoldLedger = {
    getAvailable: ReturnType<typeof vi.fn>
    hold: ReturnType<typeof vi.fn>
    settleHold: ReturnType<typeof vi.fn>
    releaseHold: ReturnType<typeof vi.fn>
    debit: ReturnType<typeof vi.fn>
  }
  let ledger: HoldLedger
  let errorSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    ledger = {
      getAvailable: vi.fn(async () => 1000),
      hold: vi.fn(async () => ({ ok: true, holdId: 7 })),
      settleHold: vi.fn(async () => ({ ok: true, balance: 900, settled: true })),
      releaseHold: vi.fn(async () => {}),
      debit: vi.fn(async () => ({ ok: true })),
    }
    __setLedgerForTests(ledger as any)
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it('local mode: null, and the ledger is never touched', async () => {
    setLocal()
    await expect(holdForModelCall(MODEL, 54)).resolves.toBeNull()
    for (const fn of Object.values(ledger)) expect(fn).not.toHaveBeenCalled()
  })

  it('hosted, no bound context: 500 "unmetered spend refused", no hold', async () => {
    setHosted()
    await expect(holdForModelCall(MODEL, 54)).rejects.toMatchObject({ statusCode: 500, message: 'unmetered spend refused' })
    await expect(holdForModelCall(MODEL, 54)).rejects.toBeInstanceOf(MeterRefusalError)
    expect(ledger.hold).not.toHaveBeenCalled()
  })

  it('hosted: holds maxCredits for the context user with an anthropic: idempotency key', async () => {
    setHosted()
    bindMeterContext({ userId: 'u1' })
    const ticket = await holdForModelCall(MODEL, 54)
    expect(ledger.hold).toHaveBeenCalledTimes(1)
    const [userId, amount, key] = ledger.hold.mock.calls[0]
    expect(userId).toBe('u1')
    expect(amount).toBe(54)
    expect(key).toMatch(/^anthropic:[0-9a-f-]{36}$/)
    expect(ticket).toMatchObject({ holdId: 7, credits: 54 })
    expect(ledger.settleHold).not.toHaveBeenCalled()
    expect(ledger.debit).not.toHaveBeenCalled()
  })

  it('two holds mint two distinct idempotency keys', async () => {
    setHosted()
    bindMeterContext({ userId: 'u1' })
    await holdForModelCall(MODEL, 54)
    await holdForModelCall(MODEL, 54)
    expect(ledger.hold.mock.calls[0][2]).not.toBe(ledger.hold.mock.calls[1][2])
  })

  it('hosted, insufficient: 402 with {required, available}', async () => {
    setHosted()
    bindMeterContext({ userId: 'u1' })
    ledger.hold.mockResolvedValue({ ok: false, reason: 'insufficient' })
    ledger.getAvailable.mockResolvedValue(12)
    await expect(holdForModelCall(MODEL, 54)).rejects.toMatchObject({
      statusCode: 402, message: 'insufficient credits', data: { required: 54, available: 12 },
    })
  })

  it('hosted, hold throws (no wallet): 402 with available 0, logged', async () => {
    setHosted()
    bindMeterContext({ userId: 'u1' })
    ledger.hold.mockRejectedValue(new Error('no wallet for u1 — call ensureUser first'))
    await expect(holdForModelCall(MODEL, 54)).rejects.toMatchObject({
      statusCode: 402, message: 'insufficient credits', data: { required: 54, available: 0 },
    })
    expect(ledger.getAvailable).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalled()
  })

  it('hosted, spend guard refuses (system paused): 503 and no hold', async () => {
    setHosted()
    bindMeterContext({ userId: 'u1' })
    __setSystemControlsDbForTests({ query: async () => ({ rows: [{ global_paused: true }] }) })
    await expect(holdForModelCall(MODEL, 54)).rejects.toMatchObject({ statusCode: 503 })
    expect(ledger.hold).not.toHaveBeenCalled()
  })

  it('settleUsage charges the computed credits, settles with anthropic:<model>, and returns them', async () => {
    setHosted()
    bindMeterContext({ userId: 'u1' })
    const ticket = (await holdForModelCall(MODEL, 54))!
    const usage = { input_tokens: 3000, output_tokens: 4000, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 }
    const expected = creditsForUsd(usdForUsage(MODEL, usage)!)
    expect(expected).toBe(19) // (3000*4 + 4000*20 + 9000*0.2) / 1e6 = $0.0938 → ×2 → 18.76 → 19
    await expect(ticket.settleUsage(usage)).resolves.toBe(expected)
    expect(ledger.settleHold).toHaveBeenCalledWith(7, expected, `anthropic:${MODEL}`)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('settleUsage: a cost above the hold charges the hold (the ceiling) and logs both numbers', async () => {
    setHosted()
    bindMeterContext({ userId: 'u1' })
    const ticket = (await holdForModelCall(MODEL, 10))!
    const usage = { input_tokens: 1000, output_tokens: 20_000 }
    const real = creditsForUsd(usdForUsage(MODEL, usage)!)
    expect(real).toBeGreaterThan(10)
    await expect(ticket.settleUsage(usage)).resolves.toBe(10)
    expect(ledger.settleHold).toHaveBeenCalledWith(7, 10, `anthropic:${MODEL}`)
    const logged = JSON.stringify([...warnSpy.mock.calls, ...errorSpy.mock.calls])
    expect(logged).toContain(String(real))
    expect(logged).toContain('10')
  })

  it('settleUsage: a missing usage object charges the full hold and logs (never free)', async () => {
    setHosted()
    bindMeterContext({ userId: 'u1' })
    const ticket = (await holdForModelCall(MODEL, 54))!
    await expect(ticket.settleUsage({})).resolves.toBe(54)
    expect(ledger.settleHold).toHaveBeenCalledWith(7, 54, `anthropic:${MODEL}`)
    expect(errorSpy).toHaveBeenCalled()

    ledger.settleHold.mockClear()
    await expect(ticket.settleUsage(null as any)).resolves.toBe(54)
    expect(ledger.settleHold).toHaveBeenCalledWith(7, 54, `anthropic:${MODEL}`)
  })

  it('settleUsage: an unpriced model at settle time charges the full hold and logs', async () => {
    setHosted()
    bindMeterContext({ userId: 'u1' })
    const ticket = (await holdForModelCall('claude-mystery-9', 40))!
    await expect(ticket.settleUsage({ input_tokens: 10, output_tokens: 10 })).resolves.toBe(40)
    expect(ledger.settleHold).toHaveBeenCalledWith(7, 40, 'anthropic:claude-mystery-9')
    expect(errorSpy).toHaveBeenCalled()
  })

  it('settleUsage on a released hold logs loudly and does not throw', async () => {
    setHosted()
    bindMeterContext({ userId: 'u1' })
    ledger.settleHold.mockResolvedValue({ ok: true, balance: 1000, settled: false })
    const ticket = (await holdForModelCall(MODEL, 54))!
    await expect(ticket.settleUsage({ input_tokens: 100, output_tokens: 100 })).resolves.toBe(1)
    expect(JSON.stringify(errorSpy.mock.calls)).toContain('RELEASED HOLD')
  })

  it('settleUsage: a ledger error is logged, never thrown (the result still ships)', async () => {
    setHosted()
    bindMeterContext({ userId: 'u1' })
    ledger.settleHold.mockRejectedValue(new Error('db down'))
    const ticket = (await holdForModelCall(MODEL, 54))!
    await expect(ticket.settleUsage({ input_tokens: 100, output_tokens: 100 })).resolves.toBe(1)
    expect(errorSpy).toHaveBeenCalled()
  })

  it('release gives the hold back', async () => {
    setHosted()
    bindMeterContext({ userId: 'u1' })
    const ticket = (await holdForModelCall(MODEL, 54))!
    await ticket.release()
    expect(ledger.releaseHold).toHaveBeenCalledWith(7)
    expect(ledger.settleHold).not.toHaveBeenCalled()
  })

  it('release swallows (and logs) a ledger error — never masks the caller\'s error', async () => {
    setHosted()
    bindMeterContext({ userId: 'u1' })
    ledger.releaseHold.mockRejectedValue(new Error('db down'))
    const ticket = (await holdForModelCall(MODEL, 54))!
    await expect(ticket.release()).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalled()
  })
})
