/**
 * R0.5: text that reaches a paid node by wire is moderated — at the start of
 * the run when the card's settings decide it (refused before any hold), and
 * at the node's turn otherwise (the node fails, its hold is let go).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeKit } from './__runner__/kit'
import { createMetering } from '../../server/runner/metering'
import { moderatePrompt, __setModerationFetchForTests, __setModerationTimingForTests, MODERATION_UNAVAILABLE_MESSAGE, MODERATION_TOO_LONG_MESSAGE } from '../../server/utils/moderation'
import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'

// Every R0/R1 card's text is known at the start; a text made during the run
// (R3's text nodes) is not. Until such a node exists, the start's reading is
// switched off here to stand for one.
const state = { startKnows: true }
vi.mock('#shared/runner/staticValues', async (importOriginal) => {
  const real = await importOriginal<typeof import('#shared/runner/staticValues')>()
  return { ...real, staticWiredTexts: (...a: Parameters<typeof real.staticWiredTexts>) => state.startKnows ? real.staticWiredTexts(...a) : [] }
})

const CARDS: ReadonlySet<RunnerFamily> = new Set(['cards'])
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const flow = (value = 'forbidden words'): ApiPrompt => ({
  p: { class_type: 'PrimitiveString', inputs: { value } },
  '1': { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a fox', aspect_ratio: '1:1', seed: 0, model_options: '{}', prompt_in: ['p', 0] } },
  '2': { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
})
const blockWord = (word: string) => vi.fn(async (text: string) => text.includes(word) ? { ok: false as const, categories: ['test'] } : { ok: true as const })

// Primitive(p) → Gate(2) → image(1)'s idea socket (prompt_in); Image card(3).
// The image node is entirely downstream of the Gate (its prompt_in is the
// only thing that names it, through the Gate), so the initial 'run' leg is
// the Gate alone — it pauses before anything is generated — and the card's
// text is only sent to a provider once Continue opens the next leg.
const gateFlow = (value = 'forbidden words'): ApiPrompt => ({
  p: { class_type: 'PrimitiveString', inputs: { value } },
  '2': { class_type: 'ComfyGateNode', inputs: { data_in: ['p', 0], bypass: false } },
  '1': { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a fox', aspect_ratio: '1:1', seed: 0, model_options: '{}', prompt_in: ['2', 0] } },
  '3': { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
})

describe('wired text moderation', () => {
  it('refuses at the start, before any hold, when a card’s own text is blocked', async () => {
    state.startKnows = true
    const moderate = blockWord('forbidden')
    const k = makeKit({ hosted: true, moderate, deps: { families: () => CARDS } })
    await expect(k.engine.startRun({ userId: k.userId, takes: [flow()], ...START })).rejects.toThrow(/content moderation/)
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.fal.client.submit).not.toHaveBeenCalled()
  })
  it('moderates a card’s text once at the start and not again at the node’s turn', async () => {
    state.startKnows = true
    const moderate = blockWord('never')
    const k = makeKit({ hosted: true, moderate, deps: { families: () => CARDS } })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [flow('soft light')], ...START })
    await k.engine.settled(runId)
    const texts = moderate.mock.calls.map(c => c[0])
    // Each source is now its own moderation call (never joined), so the
    // wired text is checked once, on its own — and never checked again.
    expect(texts.filter(t => t === 'soft light')).toEqual(['soft light'])
  })
  it('moderates at the node’s turn a text the start could not know, and fails only that node', async () => {
    state.startKnows = false
    const moderate = blockWord('forbidden')
    const k = makeKit({ hosted: true, moderate, deps: { families: () => CARDS } })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [flow()], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.takes[0]!.nodes['1']!.status).toBe('error')
    expect(run.takes[0]!.nodes['1']!.error).toMatch(/content moderation/)
    expect(k.fal.client.submit).not.toHaveBeenCalled()
    expect([...k.ledger.holds.values()].every(h => h.state === 'released' || h.actual === 0)).toBe(true)
  })
  it('moderates nothing locally', async () => {
    state.startKnows = false
    const moderate = blockWord('forbidden')
    const k = makeKit({ hosted: false, moderate, deps: { families: () => CARDS } })
    const { runId } = await k.engine.startRun({ userId: null, takes: [flow()], ...START })
    await k.engine.settled(runId)
    expect(moderate).not.toHaveBeenCalled()
  })

  it('a moderation-service error at the node’s turn fails only that node (current behaviour: error, not a refusal)', async () => {
    state.startKnows = false
    // Only the wired text throws (a service error at the node's turn, not a
    // refusal): the start-of-run check, which still sees the node's literal
    // prompt ('a fox'), must pass so the run reaches the node's own turn.
    const moderate = vi.fn(async (text: string) => {
      if (text === 'soft light') throw new Error('moderation service unavailable')
      return { ok: true as const }
    })
    const k = makeKit({ hosted: true, moderate, deps: { families: () => CARDS } })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [flow('soft light')], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.takes[0]!.nodes['1']!.status).toBe('error')
    expect(run.takes[0]!.nodes['1']!.error).toBe('moderation service unavailable')
    expect(k.fal.client.submit).not.toHaveBeenCalled()
  })
})

describe('Gate leg moderation', () => {
  it('refuses Continue before that leg’s hold, when the leg’s wired text is known only there', async () => {
    // The start of the run doesn't yet know the card's text (stands for a
    // value only known once the graph reaches this leg); by the time Continue
    // is asked for, it does — the same check runs again for the leg
    // (engine.ts's gateAction, before openLeg / any hold).
    state.startKnows = false
    const moderate = blockWord('forbidden')
    const k = makeKit({ hosted: true, moderate, deps: { families: () => CARDS } })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [gateFlow()], ...START })
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.status).toBe('paused')
    const holdCallsAtPause = k.ledger.hold.mock.calls.length

    state.startKnows = true
    await expect(k.engine.gateAction({ userId: k.userId, runId, gateId: '2', action: 'continue' })).rejects.toThrow(/content moderation/)
    expect(k.ledger.hold.mock.calls.length).toBe(holdCallsAtPause)
    expect(k.fal.client.submit).not.toHaveBeenCalled() // the image is never sent
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('paused')
  })

  it('a leg’s wired text that stays clean lets Continue run the leg normally', async () => {
    state.startKnows = false
    const moderate = blockWord('forbidden')
    const k = makeKit({ hosted: true, moderate, deps: { families: () => CARDS } })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [gateFlow('soft light')], ...START })
    await k.engine.settled(runId)
    state.startKnows = true
    await k.engine.gateAction({ userId: k.userId, runId, gateId: '2', action: 'continue' })
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.status).toBe('done')
    expect(k.fal.client.submit).toHaveBeenCalledTimes(1)
  })
})

// G3 (user decision 09-26): in hosted, moderation fails CLOSED on the runner
// path — at the start of the run (before any hold) and at a node's turn (the
// node fails, its hold is let go). The real moderatePrompt, service faked.
describe('runner moderation fails closed (hosted)', () => {
  const saved = process.env.OPENAI_API_KEY
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'sk-test'
    __setModerationTimingForTests({ timeoutMs: 30, retryDelayMs: 1 })
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = saved
    __setModerationFetchForTests(null)
    __setModerationTimingForTests(null)
  })
  const hostedModeration = (t: string) => moderatePrompt(t, { hosted: true })
  const clean = () => ({ ok: true, status: 200, json: async () => ({ results: [{ flagged: false, categories: {} }] }) })
  const fail500 = () => ({ ok: false, status: 500, json: async () => ({}) })
  const inputOf = (init: any) => JSON.parse(init.body).input as string
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  it('no key: the start refuses with the plain message, before any hold', async () => {
    state.startKnows = true
    delete process.env.OPENAI_API_KEY
    const k = makeKit({ hosted: true, moderate: hostedModeration, deps: { families: () => CARDS } })
    await expect(k.engine.startRun({ userId: k.userId, takes: [flow('soft light')], ...START })).rejects.toThrow(new RegExp(escape(MODERATION_UNAVAILABLE_MESSAGE)))
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.fal.client.submit).not.toHaveBeenCalled()
  })

  it('a timeout, twice: the start refuses, before any hold', async () => {
    state.startKnows = true
    const f = vi.fn((_u: string, init: any) => new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))))
    __setModerationFetchForTests(f as any)
    const k = makeKit({ hosted: true, moderate: hostedModeration, deps: { families: () => CARDS } })
    await expect(k.engine.startRun({ userId: k.userId, takes: [flow('soft light')], ...START })).rejects.toThrow(new RegExp(escape(MODERATION_UNAVAILABLE_MESSAGE)))
    // The texts are checked at once (G3 follow-up), so each is tried exactly
    // twice — one retry per text, never more.
    const tries = new Map<string, number>()
    for (const c of f.mock.calls) tries.set(inputOf(c[1]), (tries.get(inputOf(c[1])) ?? 0) + 1)
    expect(tries.get('soft light')).toBe(2)
    expect([...tries.values()].every(n => n === 2)).toBe(true)
    expect(k.ledger.hold).not.toHaveBeenCalled()
  })

  it('a 500 twice: the start refuses, nothing held or charged', async () => {
    state.startKnows = true
    const f = vi.fn().mockResolvedValue(fail500())
    __setModerationFetchForTests(f as any)
    const k = makeKit({ hosted: true, moderate: hostedModeration, deps: { families: () => CARDS } })
    await expect(k.engine.startRun({ userId: k.userId, takes: [flow('soft light')], ...START })).rejects.toThrow(new RegExp(escape(MODERATION_UNAVAILABLE_MESSAGE)))
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.ledger.settle).not.toHaveBeenCalled()
    expect(k.fal.client.submit).not.toHaveBeenCalled()
  })

  it('a 500 then success: the retry passes and the run completes', async () => {
    state.startKnows = true
    let first = true
    const f = vi.fn(async () => { if (first) { first = false; return fail500() } return clean() })
    __setModerationFetchForTests(f as any)
    const k = makeKit({ hosted: true, moderate: hostedModeration, deps: { families: () => CARDS } })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [flow('soft light')], ...START })
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.status).toBe('done')
    expect(k.fal.client.submit).toHaveBeenCalledTimes(1)
  })

  it('text over the limit: the start refuses as too long, before any hold, without sending it', async () => {
    state.startKnows = true
    const f = vi.fn().mockResolvedValue(clean())
    __setModerationFetchForTests(f as any)
    const k = makeKit({ hosted: true, moderate: hostedModeration, deps: { families: () => CARDS } })
    const padded = 'soft light '.repeat(4000)
    await expect(k.engine.startRun({ userId: k.userId, takes: [flow(padded)], ...START })).rejects.toThrow(new RegExp(escape(MODERATION_TOO_LONG_MESSAGE)))
    expect(f.mock.calls.every(c => inputOf(c[1]) !== padded)).toBe(true)
    expect(k.ledger.hold).not.toHaveBeenCalled()
  })

  it('service down at the node’s turn: only that node fails, with the plain message; its hold is let go', async () => {
    state.startKnows = false
    const f = vi.fn(async (_u: string, init: any) => inputOf(init) === 'soft light' ? fail500() : clean())
    __setModerationFetchForTests(f as any)
    const k = makeKit({ hosted: true, moderate: hostedModeration, deps: { families: () => CARDS } })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [flow('soft light')], ...START })
    await k.engine.settled(runId)
    const node = (await k.store.get(runId))!.takes[0]!.nodes['1']!
    expect(node.status).toBe('error')
    expect(node.error).toBe(MODERATION_UNAVAILABLE_MESSAGE)
    expect(f.mock.calls.filter(c => inputOf(c[1]) === 'soft light')).toHaveLength(2)
    expect(k.fal.client.submit).not.toHaveBeenCalled()
    expect([...k.ledger.holds.values()].every(h => h.state === 'released' || h.actual === 0)).toBe(true)
  })

  it('too long at the node’s turn: only that node fails, with the too-long message', async () => {
    state.startKnows = false
    __setModerationFetchForTests(vi.fn().mockResolvedValue(clean()) as any)
    const k = makeKit({ hosted: true, moderate: hostedModeration, deps: { families: () => CARDS } })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [flow('soft light '.repeat(4000))], ...START })
    await k.engine.settled(runId)
    const node = (await k.store.get(runId))!.takes[0]!.nodes['1']!
    expect(node.status).toBe('error')
    expect(node.error).toBe(MODERATION_TOO_LONG_MESSAGE)
    expect(k.fal.client.submit).not.toHaveBeenCalled()
  })

  it('local: no key and a failing service change nothing — the run completes', async () => {
    state.startKnows = true
    delete process.env.OPENAI_API_KEY
    const f = vi.fn().mockResolvedValue(fail500())
    __setModerationFetchForTests(f as any)
    const k = makeKit({ hosted: false, moderate: t => moderatePrompt(t, { hosted: false }), deps: { families: () => CARDS } })
    const { runId } = await k.engine.startRun({ userId: null, takes: [flow('soft light')], ...START })
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.status).toBe('done')
    expect(f).not.toHaveBeenCalled()
  })

  it('empty text is never checked and never refused, even with no key', async () => {
    delete process.env.OPENAI_API_KEY
    const f = vi.fn(); __setModerationFetchForTests(f as any)
    const m = createMetering({ hosted: () => true, ledger: () => { throw new Error('unused') }, graphRuns: {} as any, spendGuard: async () => {}, moderate: hostedModeration })
    await expect(m.moderate([{ '1': { class_type: 'GenerateImageNode', inputs: { prompt: '' } } }], ['', '   '])).resolves.toBeUndefined()
    await expect(m.moderateText('   ')).resolves.toBeUndefined()
    expect(f).not.toHaveBeenCalled()
  })
})
