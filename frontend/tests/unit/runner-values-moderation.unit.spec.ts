/**
 * R0.5: text that reaches a paid node by wire is moderated — at the start of
 * the run when the card's settings decide it (refused before any hold), and
 * at the node's turn otherwise (the node fails, its hold is let go).
 */
import { describe, expect, it, vi } from 'vitest'
import { makeKit } from './__runner__/kit'
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
