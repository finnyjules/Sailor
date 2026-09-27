// frontend/tests/unit/runner-cards-wired-text.unit.spec.ts
/**
 * R1.2: words wired into paid nodes. With `cards` on, a prompt, idea, style
 * block or taste wired from a card the runner computes reaches the request
 * exactly as if it were typed. The requests are checked against the first
 * provider call the real Python nodes make (scripts/runner_cards_fixtures.py
 * → fixtures/runner-cards.json, key `wired_text`); nothing here reaches a
 * provider (fake fal, fake Replicate).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createFakeFal, createFakeReplicate, makeKit, ofType } from './__runner__/kit'
import { planNode } from '~~/server/runner/executors'
import { withWiredValues } from '~~/server/runner/values'
import { NANO_BANANA_SHORT_PROMPT } from '~~/server/runner/requestRules'
import { priceGraph } from '~~/server/utils/priceBook'
import type { OutputFile, RunnerValue } from '~~/server/runner/types'
import type { ApiPrompt } from '#shared/runner/graph'
import { RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { RUNNER_NODE_RULES, isRunnerEligible, runnerTakesNode } from '#shared/runner/eligibility'
import { staticValueOf } from '#shared/runner/staticValues'
import { runnerTakesWorkflow } from '#shared/runner/validate'

interface WiredCase {
  name: string
  class_type: string
  inputs: Record<string, unknown>
  links: string[]
  reading_json?: string
  provider: string
  endpoint: string
  payload: Record<string, unknown>
}
const CASES = (JSON.parse(readFileSync(resolve(__dirname, 'fixtures/runner-cards.json'), 'utf8')) as { wired_text: WiredCase[] }).wired_text

const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const CARDS: ReadonlySet<RunnerFamily> = new Set(['cards'])
const EVERY: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES)
/** The families each fixture's node needs besides `cards` (flux-schnell and veo-3.1 need none). */
const familiesFor = (c: WiredCase): ReadonlySet<RunnerFamily> => {
  const extra: RunnerFamily[] = c.class_type === 'RestyleFromImageNode' ? ['restyle']
    : c.class_type === 'EditImageNode' ? ['fal-edit']
      : c.inputs.model === 'flux-dev' ? ['replicate-image'] : []
  return new Set<RunnerFamily>(['cards', ...extra])
}

/** The text inputs a card may feed, per class. */
const WORD_INPUTS: Record<string, readonly string[]> = {
  GenerateImageNode: ['prompt', 'prompt_in', 'style_block', 'style_in'],
  RestyleFromImageNode: ['prompt', 'style_in'],
  GenerateVideoNode: ['prompt'],
  EditImageNode: ['prompt'],
}

/**
 * The fixture's node with its words wired from cards: a Moodboard for a
 * restyle taste (its reading's style block), otherwise a Text card, a
 * PrimitiveString and a PrimitiveStringMultiline in turn. A Text card hands
 * on '' for blank typed text, so a blank word that is not '' comes from a
 * PrimitiveString (which keeps it as it is).
 */
function wiredCase(c: WiredCase): ApiPrompt {
  const inputs: Record<string, unknown> = { ...c.inputs }
  const p: ApiPrompt = {}
  const kinds = ['Text', 'PrimitiveString', 'PrimitiveStringMultiline'] as const
  WORD_INPUTS[c.class_type]!.forEach((name, i) => {
    if (!Object.prototype.hasOwnProperty.call(c.inputs, name)) return
    const value = String(c.inputs[name])
    const id = `card_${name}`
    if (name === 'style_in' && c.reading_json !== undefined) {
      p[id] = { class_type: 'Moodboard', inputs: { reading_json: c.reading_json, moodboard_id: 'mb_1' } }
    }
    else {
      const kind = kinds[i % kinds.length]!
      const cls = kind === 'Text' && value !== '' && !value.trim() ? 'PrimitiveString' : kind
      p[id] = cls === 'Text' ? { class_type: 'Text', inputs: { text: value } } : { class_type: cls, inputs: { value } }
    }
    inputs[name] = [id, 0]
  })
  for (const name of c.links) inputs[name] = [`src_${name}`, 0]
  p.n = { class_type: c.class_type, inputs }
  return p
}

function typedCase(c: WiredCase): ApiPrompt {
  const inputs: Record<string, unknown> = { ...c.inputs }
  for (const name of c.links) inputs[name] = [`src_${name}`, 0]
  return { n: { class_type: c.class_type, inputs } }
}

const fileOf = (name: string): OutputFile => ({ filename: `${name}.png`, subfolder: '', type: 'output' })
const handOff = async (f: OutputFile) => `https://fal.storage/${f.filename}`
/** Python's pictures (IMG:<input>) as the fake hand-off names them. */
const asHandedOff = (v: unknown): unknown =>
  typeof v === 'string' && v.startsWith('IMG:') ? `https://fal.storage/${v.slice(4)}.png`
    : Array.isArray(v) ? v.map(asHandedOff)
      : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, asHandedOff(x)])) : v

/** What a link reads: a card's value, as its record holds it after its turn (the static evaluator is its plan). */
const valueAt = (p: ApiPrompt) => (link: [string, number]): RunnerValue | undefined => staticValueOf(p, link) as RunnerValue | undefined

async function plan(p: ApiPrompt) {
  const planned = await planNode({
    prompt: withWiredValues(p, 'n', valueAt(p)).prompt,
    nodeId: 'n',
    filesFrom: ([from]) => [fileOf(from.slice(4))],
    valueFrom: valueAt(p),
    toUrl: handOff,
    gateOpen: false,
  })
  if (planned.kind !== 'provider') throw new Error(`expected a provider call, got ${planned.kind}`)
  return planned
}

/** The call Python makes: the plan itself, or its backup where the runner's first service moved (Nano Banana 2, Task S3). */
function pythonCall(planned: Awaited<ReturnType<typeof plan>>, c: WiredCase) {
  if (planned.provider === c.provider && planned.endpoint === c.endpoint) return planned
  return planned.backup ?? planned
}

describe('wired words plan Python\'s request (fixtures: wired_text)', () => {
  it('covers every combination the brief names', () => {
    for (const model of ['flux-schnell', 'flux-dev']) {
      const mine = CASES.filter(c => c.class_type === 'GenerateImageNode' && c.inputs.model === model)
      expect(mine.length, model).toBe(16)
      for (const c of mine) expect(Object.keys(c.inputs)).toEqual(expect.arrayContaining(['prompt_in', 'style_block', 'style_in']))
      expect(mine.some(c => c.inputs.prompt === ''), model).toBe(true)
    }
    expect(CASES.filter(c => c.class_type === 'GenerateImageNode').map(c => `${c.provider} ${c.endpoint}`).sort().filter((v, i, a) => a.indexOf(v) === i))
      .toEqual(['fal fal-ai/flux/schnell', 'replicate black-forest-labs/flux-dev'])
    expect(CASES.some(c => c.class_type === 'RestyleFromImageNode' && c.reading_json)).toBe(true)
    expect(CASES.some(c => c.class_type === 'GenerateVideoNode' && c.inputs.model === 'veo-3.1')).toBe(true)
  })

  for (const c of CASES) {
    it(c.name, async () => {
      const wired = wiredCase(c)
      const families = familiesFor(c)
      // The runner takes the node and its cards with these families on…
      for (const id of Object.keys(wired).filter(id => !id.startsWith('src_'))) {
        const withPictures: ApiPrompt = { ...wired, ...Object.fromEntries(c.links.map(l => [`src_${l}`, { class_type: 'Image', inputs: { image: `${l}.png` } }])) }
        expect(runnerTakesNode(withPictures, id, families), `${id} taken`).toBe(true)
      }
      // …and plans exactly Python's request, wired or typed.
      const fromWires = await plan(wired)
      const fromTyped = await plan(typedCase(c))
      const call = pythonCall(fromWires, c)
      expect([call.provider, call.endpoint]).toEqual([c.provider, c.endpoint])
      expect(call.payload).toEqual(asHandedOff(c.payload))
      expect(fromWires.provider).toBe(fromTyped.provider)
      expect(fromWires.endpoint).toBe(fromTyped.endpoint)
      expect(fromWires.payload).toEqual(fromTyped.payload)
      expect(fromWires.backup).toEqual(fromTyped.backup)
      // A wire never changes the node's price.
      expect(priceGraph(wired, { families }).nodes!.n).toBe(priceGraph(typedCase(c), { families }).nodes!.n)
    })
  }
})

// ── The engine ───────────────────────────────────────────────────────────

describe('Moodboard → Restyle\'s taste on the engine (hosted)', () => {
  const c = CASES.find(x => x.class_type === 'RestyleFromImageNode' && x.inputs.prompt === 'watercolor')!
  const FAMILIES: ReadonlySet<RunnerFamily> = new Set(['cards', 'restyle'])
  const flow = (): ApiPrompt => ({
    m: { class_type: 'Moodboard', inputs: { reading_json: c.reading_json!, moodboard_id: 'mb_1' } },
    1: { class_type: 'Image', inputs: { image: 'content.png' } },
    2: { class_type: 'RestyleFromImageNode', inputs: { ...c.inputs, content_image: ['1', 0], style_in: ['m', 0] } },
  })

  it('one call whose prompt folds the style block as Python does; charged the Restyle\'s own price, the Moodboard nothing', async () => {
    const moderate = vi.fn(async (_t: string) => ({ ok: true as const }))
    const k = makeKit({ hosted: true, moderate, fal: createFakeFal(), replicate: createFakeReplicate(), deps: { families: () => FAMILIES } })
    writeFileSync(join(k.root, 'input', 'content.png'), new Uint8Array([1]))
    const { runId, promptIds } = await k.engine.startRun({ userId: k.userId, takes: [flow()], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')

    // One call in all. Nano Banana 2 goes to Replicate first (Task S3), with
    // Python's fal call as its backup, carrying the same prompt.
    const sent = [...k.fal.submitted(), ...k.replicate.submitted()]
    expect(sent).toHaveLength(1)
    expect(sent[0]!.payload.prompt).toBe(c.payload.prompt)
    expect(String(c.payload.prompt)).toContain('Additional style direction: watercolor In the style of: Soft film grain.')

    // The taste was moderated at the start, on its own.
    const style = (staticValueOf(flow(), ['m', 0]) as { kind: 'text'; text: string }).text
    expect(style).toBe(String(c.inputs.style_in))
    expect(moderate.mock.calls.map(x => x[0])).toContain(style)

    // The charge is priceGraph's for the workflow as sent (the wire doesn't change it).
    const price = priceGraph(flow(), { families: FAMILIES })
    const typed = flow()
    typed[2]!.inputs.style_in = style
    delete typed.m
    expect(priceGraph(typed, { families: FAMILIES }).credits).toBe(price.credits)
    expect(price.nodes!['2']).toBeGreaterThan(0)
    expect(k.ledger.hold).toHaveBeenCalledWith('user_1', price.credits, `runner:${promptIds[0]}`)
    expect(k.ledger.settle).toHaveBeenCalledWith(1, price.credits, `runner:${promptIds[0]}`)
    expect(run.takes[0]!.nodes['2']!.credits).toBe(price.nodes!['2'])
    expect(run.takes[0]!.nodes.m!.credits).toBe(0)
    expect(run.takes[0]!.nodes.m!.values).toEqual({ 0: { kind: 'text', text: style } })
  })
})

describe('a blank Text wired into Nano Banana 2\'s prompt (a minimum of 3 characters)', () => {
  const image = (prompt: unknown): ApiPrompt[string] => ({
    class_type: 'GenerateImageNode',
    inputs: { model: 'nano-banana-2', prompt, aspect_ratio: '1:1', seed: 7, model_options: '{}' },
  })

  it('known at the start (the card\'s own setting): refused before anything is held or sent', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => CARDS } })
    const p: ApiPrompt = {
      t: { class_type: 'Text', inputs: { text: '' } },
      1: image(['t', 0]),
      2: { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
    }
    await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START })).rejects.toThrow(NANO_BANANA_SHORT_PROMPT)
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.fal.client.submit).not.toHaveBeenCalled()
  })

  it('known only in the run: the start lets it through, the node fails at its turn with the rule\'s words, nothing is sent, its hold is let go', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => CARDS } })
    // Text(t) reads its source through a Gate: the start can't work the value out.
    const p: ApiPrompt = {
      s: { class_type: 'PrimitiveString', inputs: { value: '' } },
      g: { class_type: 'ComfyGateNode', inputs: { data_in: ['s', 0], bypass: true } },
      t: { class_type: 'Text', inputs: { text: '', source: ['g', 0] } },
      1: image(['t', 0]),
      2: { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
    }
    expect(staticValueOf(p, ['t', 0])).toBeUndefined()
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.takes[0]!.nodes.t!.values).toEqual({ 0: { kind: 'text', text: '' } })
    expect(run.takes[0]!.nodes['1']!.status).toBe('error')
    expect(run.takes[0]!.nodes['1']!.error).toContain(NANO_BANANA_SHORT_PROMPT)
    expect(k.fal.client.submit).not.toHaveBeenCalled()
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
    expect(k.ledger.hold).toHaveBeenCalled()
    expect([...k.ledger.holds.values()].map(h => h.state)).toEqual(['released'])
  })
})

// ── What stays refused ───────────────────────────────────────────────────

describe('the refusals that stay', () => {
  const text: ApiPrompt[string] = { class_type: 'Text', inputs: { text: 'a watercolour' } }
  const img: ApiPrompt[string] = { class_type: 'Image', inputs: { image: 'a.png' } }

  /** A node of the class the runner takes with every family on: its first model, its required pictures linked. */
  function baseline(ct: string): ApiPrompt {
    const rule = RUNNER_NODE_RULES[ct]!
    const inputs: Record<string, unknown> = {}
    let need = [...(rule.mustLink ?? [])]
    if (rule.models) {
      const [model, m] = Object.entries(rule.models)[0]!
      inputs.model = model
      if (typeof m !== 'string') need = [...need, ...(m.mustLink ?? [])]
    }
    for (const name of need) inputs[name] = ['img', 0]
    return { img, n: { class_type: ct, inputs } }
  }
  const wire = (p: ApiPrompt, name: string): ApiPrompt => ({ ...p, t: text, n: { ...p.n!, inputs: { ...p.n!.inputs, [name]: ['t', 0] } } })

  it('Generate an image: model_options and style_refs (how many pictures, which files are read before the hold)', () => {
    const p: ApiPrompt = { n: { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a red fox', aspect_ratio: '1:1', seed: 7, model_options: '{}' } } }
    expect(runnerTakesNode(p, 'n', EVERY)).toBe(true)
    for (const name of ['model_options', 'style_refs']) {
      expect(runnerTakesNode(wire(p, name), 'n', EVERY), name).toBe(false)
      expect(runnerTakesWorkflow(wire(p, name), EVERY), name).toBe(false)
    }
    // The words it does take.
    for (const name of WORD_INPUTS.GenerateImageNode!) expect(runnerTakesNode(wire(p, name), 'n', CARDS), name).toBe(true)
  })

  it('Generate a video: model_options (R11)', () => {
    const p: ApiPrompt = { n: { class_type: 'GenerateVideoNode', inputs: { model: 'veo-3.1', prompt: 'a fox', aspect_ratio: '16:9', duration: '8', seed: 7, model_options: '{}' } } }
    expect(runnerTakesNode(p, 'n', EVERY)).toBe(true)
    expect(runnerTakesNode(wire(p, 'model_options'), 'n', EVERY)).toBe(false)
    expect(runnerTakesNode(wire(p, 'prompt'), 'n', CARDS)).toBe(true)
  })

  it('Relight: light and instructions (R11)', () => {
    const p = baseline('RelightNode')
    expect(runnerTakesNode(p, 'n', EVERY)).toBe(true)
    for (const name of ['light', 'instructions']) expect(runnerTakesNode(wire(p, name), 'n', EVERY), name).toBe(false)
  })

  // The media nodes need a measured file or a sound card to be taken at all;
  // their own suites wire each of these inputs into a node that is otherwise
  // taken (runner-sync-3, runner-topaz-video, runner-person-swap-video). Here
  // they are only held to refusing.
  const MEDIA = ['PersonSwapVideo', 'LipSyncNode', 'Audio', 'EnhanceVideoNode']

  it('every other input a rule keeps unwired leaves the workflow to the engine', () => {
    let checked = 0
    const untaken: string[] = []
    for (const [ct, rule] of Object.entries(RUNNER_NODE_RULES)) {
      const refused = (rule.mustNotLink ?? []).filter(name => !rule.valueInputs?.[name])
      if (!refused.length) continue
      const p = baseline(ct)
      if (!runnerTakesNode(p, 'n', EVERY)) untaken.push(ct)
      for (const name of refused) {
        expect(runnerTakesNode(wire(p, name), 'n', EVERY), `${ct}.${name}`).toBe(false)
        expect(isRunnerEligible(wire(p, name), EVERY), `${ct}.${name}`).toBe(false)
        checked++
      }
    }
    // Text mask keeps nothing unwired since R1.4 (its source is a picture input).
    expect(untaken).toEqual(MEDIA)
    expect(checked).toBeGreaterThan(30)
  })

  it('with cards off, a wired prompt leaves the workflow to the engine, as today', () => {
    const p: ApiPrompt = {
      t: text,
      n: { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: ['t', 0], aspect_ratio: '1:1', seed: 7, model_options: '{}' } },
    }
    const off = new Set(RUNNER_FAMILIES.filter(f => f !== 'cards'))
    expect(runnerTakesWorkflow(p, off)).toBe(false)
    expect(runnerTakesWorkflow(p, CARDS)).toBe(true)
  })
})
