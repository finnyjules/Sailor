// frontend/tests/unit/runner-cards-text.unit.spec.ts
/**
 * R1.1: the Text, Moodboard and 3D model cards, ported against the real
 * Python nodes (scripts/runner_cards_fixtures.py → fixtures/runner-cards.json,
 * keys `moodboard` and `text`), and run by the engine behind `cards`.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeKit, ofType } from './__runner__/kit'
import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import { runnerTakesNode } from '#shared/runner/eligibility'
import { STATIC_VALUES } from '#shared/runner/staticValues'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { pruneInvalidOutputs, runnerTakesWorkflow } from '#shared/runner/validate'
import { moodboardReadingIsPlain, moodboardStyleFromJson } from '#shared/taste/moodboardStyle'

interface MoodboardCase { name: string; reading_json: string; style: string; plain?: false }
interface TextCase { name: string; text: string; source: string | null; value: string }
const FX = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/runner-cards.json'), 'utf8')) as { moodboard: MoodboardCase[]; text: TextCase[] }

const CARDS: ReadonlySet<RunnerFamily> = new Set(['cards'])
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }

describe('Moodboard (comfy_extras/nodes_moodboard.py)', () => {
  const plain = FX.moodboard.filter(c => c.plain !== false)
  const notPlain = FX.moodboard.filter(c => c.plain === false)

  it('makes Python\'s style block from every plain reading', () => {
    expect(plain.length).toBeGreaterThanOrEqual(12)
    for (const c of plain) {
      expect(moodboardStyleFromJson(c.reading_json), c.name).toBe(c.style)
      expect(moodboardReadingIsPlain(c.reading_json), c.name).toBe(true)
    }
  })

  it('leaves a reading the moodboard window never writes to the engine', () => {
    expect(notPlain.length).toBeGreaterThanOrEqual(4)
    for (const c of notPlain) {
      expect(moodboardReadingIsPlain(c.reading_json), c.name).toBe(false)
      const p: ApiPrompt = { m: { class_type: 'Moodboard', inputs: { reading_json: c.reading_json, moodboard_id: 'mb_1' } } }
      expect(runnerTakesNode(p, 'm', CARDS), c.name).toBe(false)
    }
    // A plain one is taken (with cards on only).
    const p: ApiPrompt = { m: { class_type: 'Moodboard', inputs: { reading_json: plain[0]!.reading_json, moodboard_id: 'mb_1' } } }
    expect(runnerTakesNode(p, 'm', CARDS)).toBe(true)
    expect(runnerTakesNode(p, 'm')).toBe(false)
  })
})

describe('Text (comfy_extras/nodes_text.py)', () => {
  it('evaluates to Python\'s value for every case', () => {
    expect(FX.text.length).toBeGreaterThanOrEqual(4)
    for (const c of FX.text) {
      const inputs: Record<string, unknown> = { text: c.text, ...(c.source !== null ? { source: c.source } : {}) }
      expect(STATIC_VALUES.Text!(inputs, () => undefined, 0), c.name).toEqual({ kind: 'text', text: c.value })
    }
  })
})

describe('app/lib/taste/styleBlock.ts', () => {
  it('re-exports the shared moodboardStyleBlock (taste-style-block.unit.spec.ts runs it unchanged)', async () => {
    const app = await import('~/lib/taste/styleBlock')
    const shared = await import('#shared/taste/moodboardStyle')
    expect(app.moodboardStyleBlock).toBe(shared.moodboardStyleBlock)
  })
})

const textIntoIdea = (text = 'a watercolour'): ApiPrompt => ({
  t: { class_type: 'Text', inputs: { text } },
  '1': {
    class_type: 'GenerateImageNode',
    inputs: { model: 'flux-schnell', prompt: 'a red fox', aspect_ratio: '1:1', seed: 7, model_options: '{}', prompt_in: ['t', 0] },
  },
  '2': { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
})

describe('the engine', () => {
  it('sends the Text card\'s value into the idea socket, echoes it, keeps it, charges nothing', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => CARDS } })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [textIntoIdea()], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    expect(k.fal.submitted()[0]!.payload.prompt).toBe('a watercolour a red fox')
    const executed = ofType(k.seen, 'executed')
    expect(executed.find(m => m.data.node === 't')!.data.output).toEqual({ text: ['a watercolour'] })
    expect(run.takes[0]!.nodes.t!.values).toEqual({ 0: { kind: 'text', text: 'a watercolour' } })
    expect(run.takes[0]!.nodes.t!.credits).toBe(0)
  })

  it('a blank Text card hands on its wired source', async () => {
    const k = makeKit({ hosted: false, deps: { families: () => CARDS } })
    const p = textIntoIdea('  ')
    p.s = { class_type: 'PrimitiveString', inputs: { value: 'an ink sketch' } }
    p.t!.inputs.source = ['s', 0]
    const { runId } = await k.engine.startRun({ userId: null, takes: [p], ...START })
    await k.engine.settled(runId)
    expect(k.fal.submitted()[0]!.payload.prompt).toBe('an ink sketch a red fox')
    const executed = ofType(k.seen, 'executed')
    expect(executed.find(m => m.data.node === 't')!.data.output).toEqual({ text: ['an ink sketch'] })
  })

  it('runs an unwired 3D model card, which echoes an empty address', async () => {
    const k = makeKit({ hosted: false, deps: { families: () => CARDS } })
    const p: ApiPrompt = { ...textIntoIdea(), g: { class_type: 'Model3D', inputs: {} } }
    const { runId } = await k.engine.startRun({ userId: null, takes: [p], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    const executed = ofType(k.seen, 'executed')
    expect(executed.find(m => m.data.node === 'g')!.data.output).toEqual({ text: [''] })
    expect(run.takes[0]!.nodes.g!.values).toEqual({ 0: { kind: 'text', text: '' } })
  })

  it('with cards off, refuses a workflow with a Text card and names it as needing the engine', async () => {
    const k = makeKit({ hosted: false })
    await expect(k.engine.startRun({ userId: null, takes: [textIntoIdea()], ...START })).rejects.toThrow()
    expect(nodesNeedingEngine(textIntoIdea(), { runnerOn: true, titleOf: id => id })).toContain('t')
  })

  it('with cards off, the runner knows nothing of a Text card, even a broken one (SWITCHED_CLASSES)', () => {
    const broken: ApiPrompt = { t: { class_type: 'Text', inputs: {} } } // `text` missing: ComfyUI refuses it
    expect(pruneInvalidOutputs(broken).failed).toBe(false)
    expect(runnerTakesWorkflow(broken)).toBe(false)
    expect(nodesNeedingEngine(broken, { runnerOn: true, titleOf: id => id })).toEqual(['t'])
    // With cards on it is ComfyUI's refusal, given by the runner.
    expect(pruneInvalidOutputs(broken, CARDS).failed).toBe(true)
    expect(runnerTakesWorkflow(broken, CARDS)).toBe(true)
  })
})
