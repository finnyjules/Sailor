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
    expect(texts.some(t => t.includes('soft light'))).toBe(true)
    expect(texts.filter(t => t === 'soft light')).toEqual([])
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
})
