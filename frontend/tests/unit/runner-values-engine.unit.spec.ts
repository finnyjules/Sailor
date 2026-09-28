// frontend/tests/unit/runner-values-engine.unit.spec.ts
/**
 * R0.4: the engine hands values on. A Primitive card's value reaches Generate
 * an image's idea socket as if typed; a Gate lets it through; the value is
 * saved with the run; the price reads the wire as sent; with `cards` off
 * nothing changes.
 */
import { describe, expect, it } from 'vitest'
import { createFakeFal, makeKit, until } from './__runner__/kit'
import type { ApiPrompt } from '#shared/runner/graph'
import { isRunnerEligible, runnerTakesNode } from '#shared/runner/eligibility'
import { withWiredValues, WIRED_VALUE_MISSING } from '~~/server/runner/values'
import { planNode } from '~~/server/runner/executors'
import type { RunnerFamily } from '#shared/runner/families'
import { REVE_21_LONG_PROMPT } from '~~/server/runner/generators/reve21'

const CARDS: ReadonlySet<RunnerFamily> = new Set(['cards'])
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }

const idea = (via: 'direct' | 'gate', value: unknown = 'a watercolour'): ApiPrompt => ({
  p: { class_type: 'PrimitiveString', inputs: { value } },
  ...(via === 'gate' ? { g: { class_type: 'ComfyGateNode', inputs: { data_in: ['p', 0], bypass: true } } } : {}),
  '1': {
    class_type: 'GenerateImageNode',
    inputs: { model: 'flux-schnell', prompt: 'a red fox', aspect_ratio: '1:1', seed: 7, model_options: '{}', prompt_in: [via === 'gate' ? 'g' : 'p', 0] },
  },
  '2': { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
})

describe('eligibility', () => {
  it('takes a Primitive and its wire into the idea socket only with cards on', () => {
    expect(isRunnerEligible(idea('direct'))).toBe(false)
    expect(isRunnerEligible(idea('direct'), CARDS)).toBe(true)
    expect(isRunnerEligible(idea('gate'), CARDS)).toBe(true)
  })
  it('leaves a Primitive wired into an input that takes no value to the engine', () => {
    const p = idea('direct')
    p['1']!.inputs.aspect_ratio = ['p', 0]
    expect(runnerTakesNode(p, '1', CARDS)).toBe(false)
  })
  it('leaves a Primitive whose value ComfyUI would refuse (a wired value) to the engine', () => {
    const p = idea('direct')
    p.p!.inputs.value = ['x', 0]
    expect(runnerTakesNode(p, 'p', CARDS)).toBe(false)
  })
  it('refuses a files wire into the idea socket, which takes only text (R0.3 review)', () => {
    const p: ApiPrompt = {
      '0': { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a hare', aspect_ratio: '1:1', seed: 1, model_options: '{}' } },
      '1': { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a red fox', aspect_ratio: '1:1', seed: 7, model_options: '{}', prompt_in: ['0', 0] } },
    }
    expect(runnerTakesNode(p, '1')).toBe(false)
    expect(runnerTakesNode(p, '1', CARDS)).toBe(false)
  })
})

describe('withWiredValues', () => {
  it('replaces value wires by their literal and leaves file wires', () => {
    const p = idea('direct')
    const r = withWiredValues(p, '1', link => link[0] === 'p' ? { kind: 'text', text: 'a watercolour' } : undefined)
    expect(r.prompt['1']!.inputs.prompt_in).toBe('a watercolour')
    expect(r.injected).toEqual([{ input: 'prompt_in', text: 'a watercolour' }])
    expect(p['1']!.inputs.prompt_in).toEqual(['p', 0]) // the original is untouched
    const s = withWiredValues(p, '2', () => ({ kind: 'files', files: [] }))
    expect(s.prompt).toBe(p)
  })
  it('leaves a Gate its wire: it hands on whatever reaches it', () => {
    const p = idea('gate')
    expect(withWiredValues(p, 'g', () => ({ kind: 'text', text: 'a watercolour' })).prompt).toBe(p)
  })
  it('refuses to plan a node whose value never arrived (never sent blank)', () => {
    expect(() => withWiredValues(idea('direct'), '1', () => undefined)).toThrow(WIRED_VALUE_MISSING)
  })
})

describe('the engine', () => {
  it('sends the idea as if typed, keeps the value, and prices the wire as sent', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => CARDS } })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [idea('direct')], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    const sent = k.fal.submitted()[0]!
    expect(sent.payload.prompt).toBe('a watercolour a red fox')
    expect(run.takes[0]!.nodes.p!.values).toEqual({ 0: { kind: 'text', text: 'a watercolour' } })
    expect(run.takes[0]!.nodes.p!.credits).toBe(0)
    // The take keeps the workflow as sent: the wire, not the value.
    expect(run.takes[0]!.prompt['1']!.inputs.prompt_in).toEqual(['p', 0])
  })
  it('lets the value through a Gate on pass-through', async () => {
    const k = makeKit({ hosted: false, deps: { families: () => CARDS } })
    const { runId } = await k.engine.startRun({ userId: null, takes: [idea('gate')], ...START })
    await k.engine.settled(runId)
    expect(k.fal.submitted()[0]!.payload.prompt).toBe('a watercolour a red fox')
    const run = (await k.store.get(runId))!
    expect(run.takes[0]!.nodes.g!.values).toEqual({ 0: { kind: 'text', text: 'a watercolour' } })
  })
  it('makes numbers and booleans from the other Primitives as ComfyUI converts them', async () => {
    const k = makeKit({ hosted: false, deps: { families: () => CARDS } })
    const p: ApiPrompt = {
      ...idea('direct'),
      i: { class_type: 'PrimitiveInt', inputs: { value: '42' } },
      f: { class_type: 'PrimitiveFloat', inputs: { value: 1.5 } },
      b: { class_type: 'PrimitiveBoolean', inputs: { value: true } },
    }
    // A Primitive nothing reads doesn't run (ComfyUI's pruning, R3.8 fix round 1): the run leaves them out,
    // and each card's own plan (the one the engine runs when something reads it) makes its value.
    const { runId } = await k.engine.startRun({ userId: null, takes: [p], ...START })
    await k.engine.settled(runId)
    expect(Object.keys((await k.store.get(runId))!.takes[0]!.nodes).sort()).toEqual(['1', '2', 'p'])
    const valueOf = async (id: string) => {
      const plan = await planNode({ prompt: p, nodeId: id, gateOpen: false, filesFrom: () => [], toUrl: async () => '' })
      if (plan.kind !== 'derive') throw new Error(`${id} is not a card`)
      return (await plan.derive({} as never)).values
    }
    expect(await valueOf('i')).toEqual({ 0: { kind: 'number', value: 42, int: true } })
    expect(await valueOf('f')).toEqual({ 0: { kind: 'number', value: 1.5, int: false } })
    expect(await valueOf('b')).toEqual({ 0: { kind: 'boolean', value: true } })
  })
  it('refuses a workflow with a Primitive when cards is off, as before', async () => {
    const k = makeKit({ hosted: false })
    await expect(k.engine.startRun({ userId: null, takes: [idea('direct')], ...START })).rejects.toThrow()
  })
})

describe('fix round 1', () => {
  it('a closed Gate keeps the value, and Continue hands it on', async () => {
    const k = makeKit({ hosted: false, deps: { families: () => CARDS } })
    const p = idea('gate')
    p.g!.inputs.bypass = false
    const { runId } = await k.engine.startRun({ userId: null, takes: [p], ...START })
    await k.engine.settled(runId)
    let run = (await k.store.get(runId))!
    expect(run.status).toBe('paused')
    expect(run.takes[0]!.nodes.g!.values).toEqual({ 0: { kind: 'text', text: 'a watercolour' } })
    expect(k.fal.submitted()).toHaveLength(0)
    await k.engine.gateAction({ userId: null, runId, gateId: 'g', action: 'continue' })
    await k.engine.settled(runId)
    run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    expect(k.fal.submitted()[0]!.payload.prompt).toBe('a watercolour a red fox')
  })

  it('a wired idea too long for its model is refused at the start, before the hold', async () => {
    const k = makeKit({ hosted: false, deps: { families: () => new Set<RunnerFamily>(['cards', 'reve-2.1']) } })
    const p = idea('direct', 'x'.repeat(4001))
    p['1']!.inputs.model = 'reve-2.1'
    await expect(k.engine.startRun({ userId: null, takes: [p], ...START })).rejects.toThrow(REVE_21_LONG_PROMPT)
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.fal.submitted()).toHaveLength(0)
  })

  // k1 "crashes" mid-request of the node reading the wired value; k2 resumes it.
  const crashed = async (tamper?: (run: Awaited<ReturnType<ReturnType<typeof makeKit>['store']['get']>>) => void) => {
    const fal = createFakeFal()
    let down = false
    const k1 = makeKit({
      fal, deps: { families: () => CARDS, sleep: () => (down ? new Promise<void>(() => {}) : new Promise<void>(r => setTimeout(r, 1))) },
    })
    fal.holdNext(1)
    const { runId } = await k1.engine.startRun({ userId: null, takes: [idea('direct')], ...START })
    await until(() => (fal.submitted()[0]?.polls ?? 0) >= 2)
    down = true
    await new Promise(r => setTimeout(r, 20))
    if (tamper) {
      const run = (await k1.store.get(runId))!
      tamper(run)
      await k1.store.save(run)
    }
    const k2 = makeKit({ dir: k1.dir, root: k1.root, fal, deps: { families: () => CARDS } })
    expect(await k2.engine.reattach()).toBe(1)
    fal.release()
    await k2.engine.settled(runId)
    return { fal, run: (await k2.store.get(runId))! }
  }

  it('a restarted server resumes a node that reads a wired value, and sends once', async () => {
    const { fal, run } = await crashed()
    expect(fal.submitted()).toHaveLength(1)
    expect(fal.submitted()[0]!.payload.prompt).toBe('a watercolour a red fox')
    expect(run.status).toBe('done')
    expect(run.takes[0]!.nodes['1']!.status).toBe('done')
  })

  it('resuming with the wired value gone cancels the sent job before the node fails', async () => {
    const { fal, run } = await crashed(r => { delete r!.takes[0]!.nodes.p!.values })
    expect(fal.client.cancel).toHaveBeenCalled()
    expect(run.takes[0]!.nodes['1']!.status).toBe('error')
    expect(run.takes[0]!.nodes['1']!.error).toBe(WIRED_VALUE_MISSING)
  })
})

