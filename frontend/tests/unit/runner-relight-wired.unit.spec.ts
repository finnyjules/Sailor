/**
 * R11.1: Relight takes a wired light (the gimbal's JSON, as text) and wired
 * instructions. A wire hands the node the same string a typed widget would;
 * the light is read as tolerantly as a typed one (parseLight: unreadable
 * text, or JSON that is not an object, is the default light).
 *
 * The requests are checked against the first provider call the REAL
 * RelightNode.execute makes (scripts/runner_relight_wired_fixtures.py →
 * fixtures/runner-relight-wired.json). Nothing here reaches a provider (fake
 * fal, fake Replicate).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createFakeFal, createFakeReplicate, makeKit, rgbPng1x1 } from './__runner__/kit'
import { planNode } from '~~/server/runner/executors'
import { withWiredValues } from '~~/server/runner/values'
import { priceGraph } from '~~/server/utils/priceBook'
import type { OutputFile, RunnerValue } from '~~/server/runner/types'
import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import { RUNNER_NODE_RULES, isRunnerEligible, runnerTakesNode } from '#shared/runner/eligibility'
import { staticValueOf } from '#shared/runner/staticValues'
import { runnerTakesWorkflow } from '#shared/runner/validate'

interface RelightCase {
  name: string
  inputs: Record<string, unknown>
  wired: string[]
  provider: string
  endpoint: string
  payload: Record<string, unknown>
}
const CASES = (JSON.parse(readFileSync(resolve(__dirname, 'fixtures/runner-relight-wired.json'), 'utf8')) as { cases: RelightCase[] }).cases

// Every card's text is known at the start; a text made during the run is not.
// As in runner-values-moderation (R0.5), the start's reading is switched off
// to stand for one.
const state = { startKnows: true }
vi.mock('#shared/runner/staticValues', async (importOriginal) => {
  const real = await importOriginal<typeof import('#shared/runner/staticValues')>()
  return { ...real, staticWiredTexts: (...a: Parameters<typeof real.staticWiredTexts>) => state.startKnows ? real.staticWiredTexts(...a) : [] }
})

const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const ON: ReadonlySet<RunnerFamily> = new Set(['cards', 'fal-edit'])
const EDIT_ONLY: ReadonlySet<RunnerFamily> = new Set(['fal-edit'])

/**
 * The case's node with its wired inputs fed by cards. A Text card hands on ''
 * for blank typed text, so text with spaces round it comes from a
 * PrimitiveString (which keeps it as it is).
 */
function wiredCase(c: RelightCase): ApiPrompt {
  const inputs: Record<string, unknown> = { ...c.inputs, image: ['src', 0] }
  const p: ApiPrompt = { src: { class_type: 'Image', inputs: { image: 'image.png' } } }
  for (const name of c.wired) {
    const value = String(c.inputs[name])
    const id = `card_${name}`
    p[id] = value === value.trim() && value !== '' ? { class_type: 'Text', inputs: { text: value } } : { class_type: 'PrimitiveString', inputs: { value } }
    inputs[name] = [id, 0]
  }
  p.n = { class_type: 'RelightNode', inputs }
  return p
}

function typedCase(c: RelightCase): ApiPrompt {
  return { src: { class_type: 'Image', inputs: { image: 'image.png' } }, n: { class_type: 'RelightNode', inputs: { ...c.inputs, image: ['src', 0] } } }
}

const valueAt = (p: ApiPrompt) => (link: [string, number]): RunnerValue | undefined => staticValueOf(p, link) as RunnerValue | undefined

async function plan(p: ApiPrompt) {
  const planned = await planNode({
    prompt: withWiredValues(p, 'n', valueAt(p)).prompt,
    nodeId: 'n',
    filesFrom: () => [{ filename: 'image.png', subfolder: '', type: 'input' } as OutputFile],
    valueFrom: valueAt(p),
    // Python passes the picture through _image_tensor_to_data_url → `IMG:<input>`.
    toUrl: async () => 'IMG:image',
    gateOpen: false,
  })
  if (planned.kind !== 'provider') throw new Error(`expected a provider call, got ${planned.kind}`)
  return planned
}

describe('the eligibility row', () => {
  it('takes a wired light and wired instructions as text; nothing else changes', () => {
    expect(RUNNER_NODE_RULES.RelightNode).toEqual({
      family: 'fal-edit', mustLink: ['image'], valueInputs: { light: ['text'], instructions: ['text'] },
    })
  })

  it('a light wired from a picture (files) leaves the workflow to the engine', () => {
    const p: ApiPrompt = {
      src: { class_type: 'Image', inputs: { image: 'image.png' } },
      n: { class_type: 'RelightNode', inputs: { image: ['src', 0], preset: 'Custom', light: ['src', 0] } },
    }
    expect(runnerTakesNode(p, 'n', ON)).toBe(false)
  })

  it('with cards off, a wired light or instructions leaves the workflow to the engine, as before', () => {
    for (const c of CASES) {
      const p = wiredCase(c)
      expect(runnerTakesWorkflow(p, EDIT_ONLY), c.name).toBe(false)
      expect(isRunnerEligible(p, EDIT_ONLY), c.name).toBe(false)
    }
  })
})

describe('wired light and instructions plan Python\'s request (fixtures)', () => {
  it('covers a gimbal JSON, a broken JSON and wired text', () => {
    const names = CASES.map(c => c.name)
    expect(names).toEqual(expect.arrayContaining(['a gimbal JSON', 'a broken JSON', 'wired instructions', 'both wired']))
    expect(CASES.every(c => c.provider === 'fal' && c.endpoint === 'fal-ai/nano-banana-2/edit')).toBe(true)
  })

  for (const c of CASES) {
    it(c.name, async () => {
      const wired = wiredCase(c)
      expect(runnerTakesNode(wired, 'n', ON)).toBe(true)
      expect(runnerTakesWorkflow(wired, ON)).toBe(true)
      const fromWires = await plan(wired)
      const fromTyped = await plan(typedCase(c))
      // Replicate's Nano Banana 2 first (Task S3), Python's fal call its backup.
      expect([fromWires.provider, fromWires.endpoint]).toEqual(['replicate', 'google/nano-banana-2'])
      expect(fromWires.payload).toEqual({ prompt: c.payload.prompt, image_input: c.payload.image_urls, resolution: '1K', output_format: 'png' })
      const python = fromWires.backup!
      expect([python.provider, python.endpoint]).toEqual([c.provider, c.endpoint])
      expect(python.payload).toEqual(c.payload)
      // Wired or typed, the same request.
      expect(fromWires.payload).toEqual(fromTyped.payload)
      expect(fromWires.backup).toEqual(fromTyped.backup)
      // A wire never changes the price.
      expect(priceGraph(wired, { families: ON }).nodes!.n).toBe(priceGraph(typedCase(c), { families: ON }).nodes!.n)
    })
  }

  it('an unreadable light is the default light (no azimuth, no elevation, intensity 0.6)', () => {
    const broken = CASES.find(c => c.name === 'a broken JSON')!
    expect(String(broken.payload.prompt)).toContain('a strong, defined key light from the front.')
    for (const name of ['plain words, not JSON', 'JSON that is not an object', 'blank text']) {
      expect(CASES.find(c => c.name === name)!.payload.prompt).toBe(broken.payload.prompt)
    }
  })
})

// ── The engine ───────────────────────────────────────────────────────────

describe('on the engine (hosted)', () => {
  const block = (word: string) => vi.fn(async (t: string) => (t.includes(word) ? { ok: false as const, categories: ['violence'] } : { ok: true as const }))
  const kitFor = (moderate: ReturnType<typeof block>) => {
    const k = makeKit({ hosted: true, available: 50_000, moderate, fal: createFakeFal(), replicate: createFakeReplicate(), deps: { families: () => ON } })
    writeFileSync(join(k.root, 'input', 'image.png'), rgbPng1x1(1, 7, 7))
    return k
  }
  const both = CASES.find(c => c.name === 'both wired')!

  it('a wired light and instructions: one call with Python\'s prompt; held and charged as typed; the wired texts moderated', async () => {
    const moderate = block('forbidden')
    const k = kitFor(moderate)
    const p = wiredCase(both)
    const { runId, promptIds } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    const sent = [...k.fal.submitted(), ...k.replicate.submitted()]
    expect(sent).toHaveLength(1)
    expect(sent[0]!.payload.prompt).toBe(both.payload.prompt)
    expect(moderate.mock.calls.map(x => x[0])).toContain('keep the shadows soft')
    // The hold is unchanged by the wires: the typed node's price.
    const price = priceGraph(typedCase(both), { families: ON })
    expect(priceGraph(p, { families: ON }).credits).toBe(price.credits)
    expect(price.nodes!.n).toBeGreaterThan(0)
    expect(k.ledger.hold).toHaveBeenCalledWith('user_1', price.credits, `runner:${promptIds[0]}`)
    expect(run.takes[0]!.nodes.n!.credits).toBe(price.nodes!.n)
  })

  it('flagged wired instructions known at the start are refused before the hold, nothing sent', async () => {
    const k = kitFor(block('forbidden'))
    const p = wiredCase({ ...both, inputs: { ...both.inputs, instructions: 'a forbidden thing' } })
    await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START })).rejects.toThrow()
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
    expect(k.fal.client.submit).not.toHaveBeenCalled()
  })

  it('flagged wired instructions known only in the run: moderated at the node\'s turn, the node fails, nothing sent, its hold let go', async () => {
    const moderate = block('forbidden')
    const k = kitFor(moderate)
    // A PrimitiveString's value is read only through its wire (a Text card's own `text` is checked at the start as typed).
    const p: ApiPrompt = { ...typedCase(both), s: { class_type: 'PrimitiveString', inputs: { value: 'a forbidden thing' } } }
    p.n = { ...p.n!, inputs: { ...p.n!.inputs, instructions: ['s', 0] } }
    expect(runnerTakesNode(p, 'n', ON)).toBe(true)
    state.startKnows = false
    let runId: string
    try {
      runId = (await k.engine.startRun({ userId: k.userId, takes: [p], ...START })).runId
      await k.engine.settled(runId)
    }
    finally { state.startKnows = true }
    const run = (await k.store.get(runId))!
    expect(run.takes[0]!.nodes.n!.status).toBe('error')
    expect(moderate.mock.calls.map(x => x[0])).toContain('a forbidden thing')
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
    expect(k.fal.client.submit).not.toHaveBeenCalled()
    expect(k.ledger.hold).toHaveBeenCalled()
    expect([...k.ledger.holds.values()].map(h => h.state)).toEqual(['released'])
  })
})
