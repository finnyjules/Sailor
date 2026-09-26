import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { meterGraphSubmit, isPromptPath, holdWithRefusal, validateGraphFileRefs } from '../../server/utils/meterGraphRun'
import { MeterRefusalError } from '../../server/utils/requestMeter'
import { UnpricedGraphError } from '../../server/utils/priceBook'
import { normalizeHostedPrompt } from '../../server/utils/hostedPrompt'
import { moderatePrompt, __setModerationFetchForTests, __setModerationTimingForTests, MODERATION_UNAVAILABLE_MESSAGE, MODERATION_TOO_LONG_MESSAGE } from '../../server/utils/moderation'

/** The committed node catalog (what the hosted gate falls back to), for the real normalisation. */
const CATALOG = JSON.parse(gunzipSync(readFileSync(join(process.cwd(), 'server/native/objectInfo.baseline.json.gz'))).toString('utf8')) as Record<string, any>

function deps(overrides: Partial<any> = {}) {
  return {
    priceGraph: vi.fn(() => ({ credits: 5, version: 'test-v1', breakdown: [] })),
    spendGuard: vi.fn(async () => {}),
    validateFileRefs: vi.fn(async () => {}),
    moderatePrompt: vi.fn(async () => ({ ok: true as const })),
    hold: vi.fn(async () => ({ ok: true as const, holdId: 7 })),
    getAvailable: vi.fn(async () => 3),
    forward: vi.fn(async () => ({ status: 200, body: { prompt_id: 'p1', number: 1, node_errors: {} } })),
    registerRun: vi.fn(async () => {}),
    startSettle: vi.fn(),
    releaseHold: vi.fn(async () => {}),
    ...overrides,
  }
}
const BODY = { prompt: { '1': { class_type: 'SaveImage', inputs: {} } }, client_id: 'c1' }
/** A graph with text to check (BODY has none, so it makes no moderation call — G3). */
const TEXT_BODY = { prompt: { '1': { class_type: 'GenerateImageNode', inputs: { prompt: 'a fox' } } }, client_id: 'c1' }

describe('meterGraphSubmit', () => {
  it('refuses without a user (401), no side effects at all', async () => {
    const d = deps()
    await expect(meterGraphSubmit(null, BODY, d)).rejects.toMatchObject({ statusCode: 401 })
    expect(d.priceGraph).not.toHaveBeenCalled()
    expect(d.hold).not.toHaveBeenCalled()
    expect(d.forward).not.toHaveBeenCalled()
    expect(d.registerRun).not.toHaveBeenCalled()
    expect(d.startSettle).not.toHaveBeenCalled()
  })

  it('rejects a malformed body (no prompt graph)', async () => {
    await expect(meterGraphSubmit('u1', {}, deps())).rejects.toMatchObject({ statusCode: 400 })
  })

  // Stage 6 Task 7: file-reference ownership is checked BEFORE pricing and the
  // hold, so a graph reaching for another tenant's file is refused at zero
  // cost — no price, no hold, no forward, no ownership row, engine never
  // touched.
  it('refuses a foreign file reference (403) with NO hold, NO forward, engine untouched', async () => {
    const d = deps({ validateFileRefs: vi.fn(async () => { throw new MeterRefusalError('graph references a file you do not own', 403) }) })
    await expect(meterGraphSubmit('u1', BODY, d)).rejects.toMatchObject({ statusCode: 403 })
    expect(d.validateFileRefs).toHaveBeenCalledWith(BODY.prompt)
    expect(d.priceGraph).not.toHaveBeenCalled()
    expect(d.hold).not.toHaveBeenCalled()
    expect(d.forward).not.toHaveBeenCalled()
    expect(d.registerRun).not.toHaveBeenCalled()
    expect(d.startSettle).not.toHaveBeenCalled()
  })

  // Task 7b Critical: a per-FOLDER reader (LoadTrainingDataset) reaching another
  // tenant's subfolder must be refused before any hold, through the REAL wired
  // validateGraphFileRefs (not just a stub) — proving the folder map is on the
  // hosted submission path with validation-before-hold ordering intact.
  it('a folder-reader graph reaching another tenant\'s subfolder is refused (403) before any hold', async () => {
    const foreign = { prompt: { '1': { class_type: 'LoadTrainingDataset', inputs: { folder_name: 'u_bbbbbbbbbbbb' } } } }
    const d = deps({
      validateFileRefs: (prompt: any) => validateGraphFileRefs(prompt, {
        uploadFlagged: new Set<string>(),
        callerHash: 'aaaaaaaaaaaa',
        ownsInput: async () => true,
        ownsOutput: async () => true,
      }),
    })
    await expect(meterGraphSubmit('u1', foreign, d)).rejects.toMatchObject({ statusCode: 403 })
    expect(d.priceGraph).not.toHaveBeenCalled()
    expect(d.hold).not.toHaveBeenCalled()
    expect(d.forward).not.toHaveBeenCalled()
    expect(d.startSettle).not.toHaveBeenCalled()
  })

  // Stage 7 final review C1: the operator spend guard (kill-switch + daily
  // ceiling) MUST gate the canvas-graph chokepoint too — it takes its hold via
  // holdWithRefusal directly and never passes through preflightForUser, the
  // only OTHER place the guard is wired. A paused / over-ceiling system throws
  // 503 from the guard; that must propagate with NO hold, NO forward, engine
  // never touched, and the guard runs FIRST so a paused system refuses at the
  // cheapest possible point (before file-ref validation / catalog fetch).
  it('a paused system (spend guard throws 503) refuses with NO hold, NO forward, engine untouched', async () => {
    const d = deps({ spendGuard: vi.fn(async () => { throw new MeterRefusalError('Sailor is temporarily paused', 503) }) })
    await expect(meterGraphSubmit('u1', BODY, d)).rejects.toMatchObject({ statusCode: 503 })
    expect(d.spendGuard).toHaveBeenCalledWith('u1')
    expect(d.validateFileRefs).not.toHaveBeenCalled()
    expect(d.moderatePrompt).not.toHaveBeenCalled()
    expect(d.priceGraph).not.toHaveBeenCalled()
    expect(d.hold).not.toHaveBeenCalled()
    expect(d.forward).not.toHaveBeenCalled()
    expect(d.registerRun).not.toHaveBeenCalled()
    expect(d.startSettle).not.toHaveBeenCalled()
  })

  it('runs the spend guard BEFORE file-ref validation, moderation, pricing and the hold (order matters)', async () => {
    const d = deps()
    await meterGraphSubmit('u1', TEXT_BODY, d)
    expect(d.spendGuard.mock.invocationCallOrder[0]).toBeLessThan(d.validateFileRefs.mock.invocationCallOrder[0])
    expect(d.spendGuard.mock.invocationCallOrder[0]).toBeLessThan(d.moderatePrompt.mock.invocationCallOrder[0])
    expect(d.spendGuard.mock.invocationCallOrder[0]).toBeLessThan(d.priceGraph.mock.invocationCallOrder[0])
    expect(d.spendGuard.mock.invocationCallOrder[0]).toBeLessThan(d.hold.mock.invocationCallOrder[0])
  })

  it('never runs the spend guard for a signed-out caller (401 fires first)', async () => {
    const d = deps()
    await expect(meterGraphSubmit(null, BODY, d)).rejects.toMatchObject({ statusCode: 401 })
    expect(d.spendGuard).not.toHaveBeenCalled()
  })

  // Stage 7 Task 3: prompt-side moderation runs AFTER file-ref validation and
  // BEFORE pricing/hold, so a ToS-violating prompt is refused (400) at zero
  // cost — no price, no hold, no forward, engine never touched.
  it('refuses a moderation-flagged prompt (400) with NO hold, NO forward, engine untouched', async () => {
    const d = deps({ moderatePrompt: vi.fn(async () => ({ ok: false as const, categories: ['violence'] })) })
    await expect(meterGraphSubmit('u1', TEXT_BODY, d)).rejects.toMatchObject({ statusCode: 400, data: { categories: ['violence'] } })
    expect(d.moderatePrompt).toHaveBeenCalled()
    expect(d.priceGraph).not.toHaveBeenCalled()
    expect(d.hold).not.toHaveBeenCalled()
    expect(d.forward).not.toHaveBeenCalled()
    expect(d.registerRun).not.toHaveBeenCalled()
    expect(d.startSettle).not.toHaveBeenCalled()
  })

  // R0.5 (engine-free step 3): a card's text wired into a node is part of
  // what ComfyUI runs, so it is moderated with the typed prompts — read from
  // the prompt as forwarded (after normalisation), through a Gate too.
  it('moderates text a Primitive sends by wire, as forwarded (real normalisation), and refuses it before any hold', async () => {
    const wired = { prompt: {
      p: { class_type: 'PrimitiveString', inputs: { value: { __value__: 'wired words' } } },
      g: { class_type: 'ComfyGateNode', inputs: { data_in: ['p', 0], bypass: false } },
      '1': { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a fox', prompt_in: ['g', 0] } },
    } }
    const moderatePrompt = vi.fn(async (t: string) => t.includes('wired words') ? { ok: false as const, categories: ['test'] } : { ok: true as const })
    // The real hosted normalisation (not a stub): __value__ unwrapped per the
    // node's own catalog entry, through the Gate, exactly as ComfyUI would see it.
    const d = deps({ moderatePrompt, normalizePrompt: p => normalizeHostedPrompt(p, CATALOG) })
    await expect(meterGraphSubmit('u1', wired, d)).rejects.toMatchObject({ statusCode: 400 })
    // Each source text is its own moderation call now (never joined): the
    // typed prompt is judged on its own, and so is the wired text.
    expect(moderatePrompt).toHaveBeenCalledWith('a fox')
    expect(moderatePrompt).toHaveBeenCalledWith('wired words')
    expect(d.hold).not.toHaveBeenCalled()
    expect(d.forward).not.toHaveBeenCalled()
  })

  it('moderates exactly the typed prompt text when nothing is wired', async () => {
    const d = deps()
    await meterGraphSubmit('u1', { prompt: { '1': { class_type: 'GenerateImageNode', inputs: { prompt: 'a fox', negative: 'blur' } } } }, d)
    expect(d.moderatePrompt).toHaveBeenCalledWith('a fox blur')
  })

  it('a malformed node beside a wired card is left to ComfyUI, not a crash', async () => {
    const d = deps()
    await meterGraphSubmit('u1', { prompt: { x: null, y: { class_type: 'Z', inputs: 'no' }, p: { class_type: 'PrimitiveString', inputs: { value: 'soft' } }, '1': { class_type: 'GenerateImageNode', inputs: { prompt_in: ['p', 0] } } } }, d)
    expect(d.moderatePrompt).toHaveBeenCalledWith('soft')
  })

  // R0.5 follow-up: the typed extras the runner also checks (style_in,
  // instructions, target, find, replace, scene_prompt) were read on the
  // runner path but not on this hosted ComfyUI path. Now they are.
  it('moderates a typed extra (style_in) on a class that carries taste, with nothing else typed or wired unchanged', async () => {
    const d = deps()
    await meterGraphSubmit('u1', { prompt: { '1': { class_type: 'GenerateImageNode', inputs: { prompt: 'a fox', style_in: 'noir photography' } } } }, d)
    expect(d.moderatePrompt).toHaveBeenCalledWith('a fox')
    expect(d.moderatePrompt).toHaveBeenCalledWith('noir photography')
  })

  it('a typed extra (instructions) on an edit node is moderated and can refuse before any hold', async () => {
    const moderatePrompt = vi.fn(async (t: string) => t.includes('forbidden') ? { ok: false as const, categories: ['test'] } : { ok: true as const })
    const d = deps({ moderatePrompt })
    await expect(meterGraphSubmit('u1', { prompt: { '1': { class_type: 'RemoveObjectNode', inputs: { instructions: 'forbidden thing' } } } }, d))
      .rejects.toMatchObject({ statusCode: 400 })
    expect(moderatePrompt).toHaveBeenCalledWith('forbidden thing')
    expect(d.hold).not.toHaveBeenCalled()
  })

  it('with nothing extra typed or wired, the moderated text is unchanged', async () => {
    const d = deps()
    await meterGraphSubmit('u1', { prompt: { '1': { class_type: 'GenerateImageNode', inputs: { prompt: 'a fox' } } } }, d)
    expect(d.moderatePrompt).toHaveBeenCalledTimes(1)
    expect(d.moderatePrompt).toHaveBeenCalledWith('a fox')
  })

  // A short harmful phrase must not be diluted inside long harmless text: each
  // source is judged on its own moderation call, never joined into one string.
  it('a short harmful phrase is judged on its own, not diluted inside long harmless text', async () => {
    const longHarmless = 'a calm still life of fruit on a wooden table in soft morning light'.repeat(3)
    const moderatePrompt = vi.fn(async (t: string) => t === 'forbidden' ? { ok: false as const, categories: ['test'] } : { ok: true as const })
    const d = deps({ moderatePrompt })
    await expect(meterGraphSubmit('u1', { prompt: {
      '1': { class_type: 'GenerateImageNode', inputs: { prompt: longHarmless, instructions: 'forbidden' } },
    } }, d)).rejects.toMatchObject({ statusCode: 400 })
    expect(moderatePrompt).toHaveBeenCalledWith(longHarmless)
    expect(moderatePrompt).toHaveBeenCalledWith('forbidden')
  })

  it('moderates AFTER file-ref validation and BEFORE pricing/hold (order matters)', async () => {
    const d = deps()
    await meterGraphSubmit('u1', TEXT_BODY, d)
    expect(d.validateFileRefs.mock.invocationCallOrder[0]).toBeLessThan(d.moderatePrompt.mock.invocationCallOrder[0])
    expect(d.moderatePrompt.mock.invocationCallOrder[0]).toBeLessThan(d.priceGraph.mock.invocationCallOrder[0])
    expect(d.moderatePrompt.mock.invocationCallOrder[0]).toBeLessThan(d.hold.mock.invocationCallOrder[0])
  })

  // Local byte-identity: with moderation a no-op (fails open / no key → ok:true,
  // the deps default), a normal run is completely unaffected.
  it('a no-op moderation (ok:true) leaves the run unchanged', async () => {
    const d = deps()
    const res = await meterGraphSubmit('u1', BODY, d)
    expect(res).toEqual({ status: 200, body: { prompt_id: 'p1', number: 1, node_errors: {} } })
    expect(d.hold).toHaveBeenCalledWith('u1', 5)
  })

  it('validates file refs BEFORE pricing and holding (order matters)', async () => {
    const d = deps()
    await meterGraphSubmit('u1', BODY, d)
    expect(d.validateFileRefs.mock.invocationCallOrder[0]).toBeLessThan(d.priceGraph.mock.invocationCallOrder[0])
    expect(d.validateFileRefs.mock.invocationCallOrder[0]).toBeLessThan(d.hold.mock.invocationCallOrder[0])
  })

  it('never validates file refs for a signed-out caller (401 fires first)', async () => {
    const d = deps()
    await expect(meterGraphSubmit(null, BODY, d)).rejects.toMatchObject({ statusCode: 401 })
    expect(d.validateFileRefs).not.toHaveBeenCalled()
  })

  it('holds before forwarding and returns ComfyUI body verbatim', async () => {
    const d = deps()
    const res = await meterGraphSubmit('u1', BODY, d)
    expect(d.hold).toHaveBeenCalledWith('u1', 5)
    expect(d.hold.mock.invocationCallOrder[0]).toBeLessThan(d.forward.mock.invocationCallOrder[0])
    expect(res).toEqual({ status: 200, body: { prompt_id: 'p1', number: 1, node_errors: {} } })
    expect(d.registerRun).toHaveBeenCalledWith({ promptId: 'p1', userId: 'u1', credits: 5, holdId: 7 })
    expect(d.startSettle).toHaveBeenCalledWith({ promptId: 'p1', holdId: 7, credits: 5 })
  })

  it('insufficient hold → 402 carrying required/available, engine never touched', async () => {
    const d = deps({ hold: vi.fn(async () => ({ ok: false as const, reason: 'insufficient' as const })) })
    await expect(meterGraphSubmit('u1', BODY, d)).rejects.toMatchObject({
      statusCode: 402, data: { required: 5, available: 3 },
    })
    expect(d.forward).not.toHaveBeenCalled()
  })

  it('UnpricedGraphError → 500 refusal, engine never touched', async () => {
    const d = deps({ priceGraph: vi.fn(() => { throw new UnpricedGraphError('MysteryNode') }) })
    await expect(meterGraphSubmit('u1', BODY, d)).rejects.toBeInstanceOf(MeterRefusalError)
    expect(d.forward).not.toHaveBeenCalled()
  })

  it('ComfyUI 400 (validation) → hold released, error body passed through verbatim', async () => {
    const errBody = { error: { message: 'bad' }, node_errors: { '1': {} } }
    const d = deps({ forward: vi.fn(async () => ({ status: 400, body: errBody })) })
    const res = await meterGraphSubmit('u1', BODY, d)
    expect(res).toEqual({ status: 400, body: errBody })
    expect(d.releaseHold).toHaveBeenCalledWith(7)
    expect(d.registerRun).not.toHaveBeenCalled()
  })

  it('zero-credit graph skips the hold but still registers ownership', async () => {
    const d = deps({ priceGraph: vi.fn(() => ({ credits: 0, version: 'test-v1', breakdown: [] })) })
    await meterGraphSubmit('u1', BODY, d)
    expect(d.hold).not.toHaveBeenCalled()
    expect(d.registerRun).toHaveBeenCalledWith({ promptId: 'p1', userId: 'u1', credits: 0, holdId: null })
  })

  // Finding 2: a thrown forward() (ECONNREFUSED to a wedged pool worker) must
  // not leave the hold open until the 2h sweep — release it, then propagate
  // the original error so the caller still sees the real failure.
  it('forward throwing releases the hold before propagating the error', async () => {
    const boom = new Error('ECONNREFUSED')
    const d = deps({ forward: vi.fn(async () => { throw boom }) })
    await expect(meterGraphSubmit('u1', BODY, d)).rejects.toBe(boom)
    expect(d.releaseHold).toHaveBeenCalledWith(7)
  })

  // Minor 4: releaseHold rejecting on the forward-throw path must not mask
  // the original forward error either.
  it('forward throwing AND releaseHold rejecting still propagates the original forward error', async () => {
    const boom = new Error('ECONNREFUSED')
    const d = deps({
      forward: vi.fn(async () => { throw boom }),
      releaseHold: vi.fn(async () => { throw new Error('ledger down') }),
    })
    await expect(meterGraphSubmit('u1', BODY, d)).rejects.toBe(boom)
  })

  // Finding 3: a run that ComfyUI already queued must not ship uncharged just
  // because the ownership-row insert (Neon transient) failed — settlement
  // must not depend on registerRun succeeding.
  it('registerRun throwing still starts settlement and returns the response verbatim', async () => {
    const d = deps({ registerRun: vi.fn(async () => { throw new Error('Neon transient') }) })
    const res = await meterGraphSubmit('u1', BODY, d)
    expect(res).toEqual({ status: 200, body: { prompt_id: 'p1', number: 1, node_errors: {} } })
    expect(d.startSettle).toHaveBeenCalledWith({ promptId: 'p1', holdId: 7, credits: 5 })
  })

  // Minor 4: releaseHold rejecting on the 4xx path must not replace ComfyUI's
  // real 400 {error, node_errors} body with an opaque 500.
  it('releaseHold rejecting on the 4xx path does not clobber the ComfyUI error response', async () => {
    const errBody = { error: { message: 'bad' }, node_errors: { '1': {} } }
    const d = deps({
      forward: vi.fn(async () => ({ status: 400, body: errBody })),
      releaseHold: vi.fn(async () => { throw new Error('ledger down') }),
    })
    const res = await meterGraphSubmit('u1', BODY, d)
    expect(res).toEqual({ status: 400, body: errBody })
  })
})

describe('holdWithRefusal', () => {
  // Finding 1: ledger.hold THROWS a plain Error (not a typed refusal) for a
  // user with no wallet row yet — new signup before lazy sync lands, reachable
  // on the primary hosted action. Left unwrapped, that throw escapes as an
  // opaque 500 instead of the 402 credits-refusal every other insufficient-
  // funds path returns.
  it('a thrown hold (no wallet row) refuses as insufficient credits, not a 500', async () => {
    const ledger = { hold: vi.fn(async () => { throw new Error('no wallet for u1 — call ensureUser first') }) }
    await expect(holdWithRefusal(ledger, 'u1', 5)).rejects.toMatchObject({
      statusCode: 402,
      data: { required: 5, available: 0 },
    })
  })

  it('passes through a normal ok:true hold unchanged', async () => {
    const ledger = { hold: vi.fn(async () => ({ ok: true as const, holdId: 42 })) }
    await expect(holdWithRefusal(ledger, 'u1', 5)).resolves.toEqual({ ok: true, holdId: 42 })
  })

  it('passes through a normal ok:false hold unchanged', async () => {
    const ledger = { hold: vi.fn(async () => ({ ok: false as const, reason: 'insufficient' as const })) }
    await expect(holdWithRefusal(ledger, 'u1', 5)).resolves.toEqual({ ok: false, reason: 'insufficient' })
  })
})

describe('isPromptPath', () => {
  it('matches /prompt and /prompt?comfyWorker=2, not /prompted', () => {
    expect(isPromptPath('/prompt')).toBe(true)
    expect(isPromptPath('/prompt?comfyWorker=2')).toBe(true)
    expect(isPromptPath('/prompted')).toBe(false)
  })
})

// G3 (user decision 09-26): in hosted, moderation fails CLOSED on the ComfyUI
// path. The real moderatePrompt, with the moderation service faked.
describe('meterGraphSubmit — moderation fails closed (hosted)', () => {
  const saved = { key: process.env.OPENAI_API_KEY }
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'sk-test'
    __setModerationTimingForTests({ timeoutMs: 30, retryDelayMs: 1 })
  })
  afterEach(() => {
    if (saved.key === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = saved.key
    __setModerationFetchForTests(null)
    __setModerationTimingForTests(null)
  })
  const realModeration = () => deps({ moderatePrompt: vi.fn((t: string) => moderatePrompt(t, { hosted: true })) })
  const clean = () => ({ ok: true, status: 200, json: async () => ({ results: [{ flagged: false, categories: {} }] }) })
  const fail500 = () => ({ ok: false, status: 500, json: async () => ({}) })
  const expectNothingHeld = (d: ReturnType<typeof deps>) => {
    expect(d.priceGraph).not.toHaveBeenCalled()
    expect(d.hold).not.toHaveBeenCalled()
    expect(d.forward).not.toHaveBeenCalled()
    expect(d.registerRun).not.toHaveBeenCalled()
    expect(d.startSettle).not.toHaveBeenCalled()
  }

  it('no key: refused with the plain message, nothing held', async () => {
    delete process.env.OPENAI_API_KEY
    const fetchSpy = vi.fn(); __setModerationFetchForTests(fetchSpy as any)
    const d = realModeration()
    await expect(meterGraphSubmit('u1', TEXT_BODY, d)).rejects.toMatchObject({ statusCode: 503, message: MODERATION_UNAVAILABLE_MESSAGE })
    expect(fetchSpy).not.toHaveBeenCalled()
    expectNothingHeld(d)
  })

  it('a timeout, twice: refused, nothing held', async () => {
    const hang = vi.fn((_u: string, init: any) => new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))))
    __setModerationFetchForTests(hang as any)
    const d = realModeration()
    await expect(meterGraphSubmit('u1', TEXT_BODY, d)).rejects.toMatchObject({ statusCode: 503, message: MODERATION_UNAVAILABLE_MESSAGE })
    expect(hang).toHaveBeenCalledTimes(2)
    expectNothingHeld(d)
  })

  it('a 500 then success: the retry passes and the run goes ahead', async () => {
    const f = vi.fn().mockResolvedValueOnce(fail500()).mockResolvedValueOnce(clean())
    __setModerationFetchForTests(f as any)
    const d = realModeration()
    const res = await meterGraphSubmit('u1', TEXT_BODY, d)
    expect(res.status).toBe(200)
    expect(f).toHaveBeenCalledTimes(2)
    expect(d.hold).toHaveBeenCalledWith('u1', 5)
  })

  it('a 500 twice: refused, nothing held or charged', async () => {
    const f = vi.fn().mockResolvedValue(fail500())
    __setModerationFetchForTests(f as any)
    const d = realModeration()
    await expect(meterGraphSubmit('u1', TEXT_BODY, d)).rejects.toMatchObject({ statusCode: 503, message: MODERATION_UNAVAILABLE_MESSAGE })
    expect(f).toHaveBeenCalledTimes(2)
    expectNothingHeld(d)
  })

  it('text over the service limit: refused as too long before it is sent, nothing held', async () => {
    const f = vi.fn(); __setModerationFetchForTests(f as any)
    const d = realModeration()
    const padded = { prompt: { '1': { class_type: 'GenerateImageNode', inputs: { prompt: 'a fox '.repeat(6000) } } } }
    await expect(meterGraphSubmit('u1', padded, d)).rejects.toMatchObject({ statusCode: 400, message: MODERATION_TOO_LONG_MESSAGE })
    expect(f).not.toHaveBeenCalled()
    expectNothingHeld(d)
  })

  it('a graph with no text makes no moderation call and is never refused for it', async () => {
    delete process.env.OPENAI_API_KEY // would refuse any text
    const f = vi.fn(); __setModerationFetchForTests(f as any)
    const d = realModeration()
    const res = await meterGraphSubmit('u1', BODY, d)
    expect(res.status).toBe(200)
    expect(d.moderatePrompt).not.toHaveBeenCalled()
    expect(f).not.toHaveBeenCalled()
  })
})
