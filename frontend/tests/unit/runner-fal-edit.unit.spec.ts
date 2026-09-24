/**
 * The fal edit family (Phase B, Task B2): EditImageNode (Nano Banana 2, Flux
 * Kontext Pro, Flux 2 Pro), DevelopImageNode, RelightNode and BlendSceneNode
 * (the two Flux modes) run on the Sailor runner when `fal-edit` is on.
 *
 * The payloads are checked against the first provider call the Python node
 * makes (fixtures/runner-families.json `falEdit`, written by
 * scripts/runner_builder_fixtures.py with the network patched out). Engine
 * tests use the fake fal only: nothing here reaches a provider.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { planNode } from '~~/server/runner/executors'
import { extraPromptText, nodeCredits, unpricedProviderNode } from '~~/server/runner/metering'
import { BASE_RENDER_CREDITS } from '~~/server/utils/priceBook'
import { priceNode } from '#shared/pricing/nodePrice'
import { PRESETS, PRESET_PHRASES, lightToPhrase, parseLight, relightInstruction } from '~~/server/runner/generators/relight'
import { DEVELOP_PROMPT } from '~~/server/runner/generators/edit'
import { PROVIDER_TYPES, RUNNER_NODE_RULES, isRunnerEligible, runnerTakesNode, type RunnerNodeRule } from '#shared/runner/eligibility'
import { NO_FAMILIES, RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import type { ApiPrompt } from '#shared/runner/graph'
import type { OutputFile } from '~~/server/runner/types'
import { makeKit, ofType } from './__runner__/kit'

interface FalEditCase {
  class_type: string
  links: string[]
  widgets: Record<string, unknown>
  call: { provider: string; endpoint: string; payload: Record<string, unknown> }
}
const CASES = (JSON.parse(readFileSync(
  fileURLToPath(new URL('./fixtures/runner-families.json', import.meta.url)), 'utf8')) as { falEdit: FalEditCase[] }).falEdit

const FAL_EDIT: ReadonlySet<RunnerFamily> = new Set(['fal-edit'])
const OTHERS: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES.filter(f => f !== 'fal-edit'))

// ── Parity with the Python nodes ─────────────────────────────────────────

/** A case as the node the canvas sends: each linked picture comes from a node `src_<input>`. */
function planCase(c: FalEditCase) {
  const inputs: Record<string, unknown> = { ...c.widgets }
  for (const name of c.links) inputs[name] = [`src_${name}`, 0]
  const prompt: ApiPrompt = { n: { class_type: c.class_type, inputs } }
  return planNode({
    prompt,
    nodeId: 'n',
    filesFrom: ([from]) => [{ filename: `${from.slice(4)}.png`, subfolder: '', type: 'output' }],
    // Python passes each picture through _image_tensor_to_data_url → `IMG:<input>`.
    toUrl: async (f: OutputFile) => `IMG:${f.filename.replace(/\.png$/, '')}`,
    gateOpen: false,
  })
}

describe('fal-edit payloads match the Python nodes', () => {
  it('the fixture has every node class and model', () => {
    const seen = new Set(CASES.map(c => `${c.class_type}:${String(c.widgets.model ?? '')}`))
    expect([...seen].sort()).toEqual([
      'BlendSceneNode:Flux 2 Pro', 'BlendSceneNode:Flux Kontext Pro',
      'DevelopImageNode:', 'EditImageNode:Flux 2 Pro', 'EditImageNode:Flux Kontext Pro', 'EditImageNode:Nano Banana 2',
      'RelightNode:',
    ])
    expect(CASES.length).toBeGreaterThan(150)
    expect(CASES.every(c => c.call.provider === 'fal')).toBe(true)
  })

  it.each(CASES.map((c, i) => [`${i} ${c.class_type} ${JSON.stringify(c.widgets)} links=${c.links.join(',')}`, c] as const))(
    '%s', async (_label, c) => {
      const plan = await planCase(c)
      expect(plan.kind).toBe('provider')
      if (plan.kind !== 'provider') return
      expect(plan.provider).toBe(c.call.provider)
      expect(plan.endpoint).toBe(c.call.endpoint)
      expect(plan.payload).toEqual(c.call.payload)
      expect(plan.media).toBe('image')
    })

  it('has a case per class with only the required inputs, so missing ones take execute()\'s defaults (B2 review M3)', () => {
    const has = (ct: string, missing: string[]) => CASES.some(c => c.class_type === ct && missing.every(m => !(m in c.widgets)))
    expect(has('RelightNode', ['keep_background', 'instructions'])).toBe(true)
    expect(has('BlendSceneNode', ['prompt'])).toBe(true)
    expect(CASES.some(c => c.class_type === 'EditImageNode' && c.widgets.prompt === '' && c.widgets.model === 'Nano Banana 2')).toBe(true)
    expect(CASES.some(c => c.class_type === 'DevelopImageNode' && Object.keys(c.widgets).sort().join() === 'resolution,seed')).toBe(true)
  })

  it('names each output with the Python asset tag and shows it as a still', async () => {
    const byClass = (ct: string) => CASES.find(c => c.class_type === ct)!
    const want: Record<string, string> = {
      EditImageNode: 'edit_image', DevelopImageNode: 'edit_image', RelightNode: 'relight', BlendSceneNode: 'blend_scene',
    }
    for (const [ct, prefix] of Object.entries(want)) {
      const plan = await planCase(byClass(ct))
      if (plan.kind !== 'provider') throw new Error('expected a provider plan')
      expect(plan.prefix).toBe(prefix)
      const files: OutputFile[] = [{ filename: `${prefix}_00001_.png`, subfolder: '', type: 'output' }]
      expect(plan.uiFor(files)).toEqual({ images: files, animated: [false] })
    }
  })

  it('a missing picture fails the node with a plain message', async () => {
    const edit: ApiPrompt = { n: { class_type: 'EditImageNode', inputs: { model: 'Nano Banana 2', input_image: ['s', 0], prompt: 'p' } } }
    await expect(planNode({ prompt: edit, nodeId: 'n', filesFrom: () => [], toUrl: async () => 'x', gateOpen: false }))
      .rejects.toThrow('There is no picture to edit')
    const relight: ApiPrompt = { n: { class_type: 'RelightNode', inputs: { image: ['s', 0], reference: ['r', 0] } } }
    await expect(planNode({
      prompt: relight, nodeId: 'n', gateOpen: false, toUrl: async () => 'x',
      filesFrom: ([from]) => from === 's' ? [{ filename: 'a.png', subfolder: '', type: 'output' }] : [],
    })).rejects.toThrow('There is no reference picture')
  })

  it('light values Python cannot read as numbers fail the node', async () => {
    expect(() => parseLight('{"azimuth":"left"}')).toThrow('The light setting can’t be read')
    expect(() => parseLight('{"intensity":[1]}')).toThrow('The light setting can’t be read')
    expect(() => parseLight('{"azimuth":"1__0"}')).toThrow('The light setting can’t be read')
    expect(() => parseLight('{"azimuth":"0x10"}')).toThrow('The light setting can’t be read')
  })

  it('light text is read the way float() reads it (the shared pyFloatOf)', () => {
    // Underscores between digits, Python's blanks, inf and nan all read.
    expect(parseLight('{"azimuth":"1_0","elevation":"\\u00a030\\u00a0","intensity":" .5 "}')).toEqual({ azimuth: 10, elevation: 30, intensity: 0.5 })
    expect(parseLight('{"azimuth":"-inf"}').azimuth).toBe(-Infinity)
    expect(Number.isNaN(parseLight('{"elevation":"nan"}').elevation)).toBe(true)
    // U+FEFF is not blank to float() (JS trim() would strip it).
    expect(() => parseLight('{"azimuth":"\\ufeff10"}')).toThrow('The light setting can’t be read')
  })

  it('a NaN light clamps as Python’s max(lo, min(hi, v)) does: to the top', () => {
    // min(90.0, nan) is 90.0 in Python, so NaN elevation is overhead; NaN intensity is 1.0.
    expect(lightToPhrase(0, Number.NaN, 0.6)).toBe('a strong, defined key light from the front, positioned directly overhead')
    expect(lightToPhrase(0, 0, Number.NaN)).toBe('a dramatic, high-contrast key light from the front')
    // (nan + 180) % 360 - 180 is nan: every comparison is False → back-left, as in Python.
    expect(lightToPhrase(Number.NaN, 0, 0.6)).toContain('from the back-left')
  })
})

// ── Relight prompt (port of tests-unit/comfy_extras_test/relight_prompts_test.py) ──

describe('relight prompts', () => {
  it('direction buckets', () => {
    expect(lightToPhrase(0, 0, 0.6)).toContain('from the front')
    expect(lightToPhrase(-30, 0, 0.6)).toContain('from the front-left')
    expect(lightToPhrase(-90, 0, 0.6)).toContain('from the left')
    expect(lightToPhrase(135, 0, 0.6)).toContain('from the back-right')
    expect(lightToPhrase(180, 0, 0.6)).toContain('from behind')
  })
  it('elevation buckets', () => {
    expect(lightToPhrase(0, 0, 0.6)).not.toContain('positioned')
    expect(lightToPhrase(0, 30, 0.6)).toContain('positioned above')
    expect(lightToPhrase(0, 60, 0.6)).toContain('high above')
    expect(lightToPhrase(0, 85, 0.6)).toContain('overhead')
    expect(lightToPhrase(0, -30, 0.6)).toContain('slightly below')
    expect(lightToPhrase(0, -60, 0.6)).toContain('below')
    expect(lightToPhrase(0, -85, 0.6)).toContain('far below')
  })
  it('intensity buckets', () => {
    expect(lightToPhrase(0, 0, 0.1)).toContain('soft')
    expect(lightToPhrase(0, 0, 0.4)).toContain('moderate')
    expect(lightToPhrase(0, 0, 0.6)).toContain('strong')
    expect(lightToPhrase(0, 0, 0.9)).toContain('dramatic')
  })
  it('the preset phrase is included only when not Custom', () => {
    const custom = relightInstruction('Custom', 0, 0, 0.6, true, false, '')
    expect(custom).not.toContain('Lighting style:')
    const golden = relightInstruction('Golden hour', 0, 0, 0.6, true, false, '')
    expect(golden).toContain('Lighting style:')
    expect(golden).toContain(PRESET_PHRASES['Golden hour'])
    expect(PRESETS[0]).toBe('Custom')
    expect(PRESETS).toHaveLength(10)
  })
  it('the keep-background clause toggles', () => {
    expect(relightInstruction('Custom', 0, 0, 0.6, true, false, '')).toContain('ONLY the lighting')
    expect(relightInstruction('Custom', 0, 0, 0.6, false, false, '')).toContain('environment and background')
  })
  it('the reference clause only when there is a reference', () => {
    expect(relightInstruction('Custom', 0, 0, 0.6, true, false, '')).not.toContain('lighting reference')
    expect(relightInstruction('Custom', 0, 0, 0.6, true, true, '')).toContain('lighting reference')
  })
  it('instructions are appended only when present', () => {
    expect(relightInstruction('Custom', 0, 0, 0.6, true, false, '   ')).not.toContain('Additional direction:')
    expect(relightInstruction('Custom', 0, 0, 0.6, true, false, 'warmer please')).toContain('Additional direction: warmer please.')
  })
  it('always ends with the output clause', () => {
    expect(relightInstruction('Golden hour', -30, 20, 0.6, true, true, 'x').trimEnd().endsWith('Output only the edited image.')).toBe(true)
  })
})

// ── Eligibility rows ─────────────────────────────────────────────────────

const nodeRuleFamilies = (r: RunnerNodeRule): string[] =>
  [r.family, ...Object.values(r.models ?? {}).map(m => typeof m === 'string' ? m : m.family)].filter((f): f is RunnerFamily => !!f)

const card = { class_type: 'Image', inputs: { image: 'a.png' } }
const withNode = (n: { class_type: string; inputs: Record<string, unknown> }): ApiPrompt => ({ 1: card, 2: n })
const edit = (model: string, inputs: Record<string, unknown> = {}) => withNode({ class_type: 'EditImageNode', inputs: { model, input_image: ['1', 0], prompt: 'p', ...inputs } })
const develop = (inputs: Record<string, unknown> = { input_image: ['1', 0] }) => withNode({ class_type: 'DevelopImageNode', inputs: { resolution: '1K', seed: 0, ...inputs } })
const relight = (inputs: Record<string, unknown> = { image: ['1', 0] }) => withNode({ class_type: 'RelightNode', inputs: { preset: 'Custom', light: '{}', ...inputs } })
const blend = (model: string, inputs: Record<string, unknown> = {}) => withNode({ class_type: 'BlendSceneNode', inputs: { model, image: ['1', 0], ...inputs } })

describe('fal-edit eligibility', () => {
  it('the rows', () => {
    const falEdit = Object.keys(RUNNER_NODE_RULES).filter(ct => nodeRuleFamilies(RUNNER_NODE_RULES[ct]!).includes('fal-edit'))
    expect(falEdit.sort()).toEqual(['BlendSceneNode', 'DevelopImageNode', 'EditImageNode', 'RelightNode'])
    for (const ct of falEdit) expect(PROVIDER_TYPES.has(ct)).toBe(true)
  })

  const takes: [string, ApiPrompt][] = [
    ['Edit · Nano Banana 2', edit('Nano Banana 2')],
    ['Edit · Flux Kontext Pro', edit('Flux Kontext Pro')],
    ['Edit · Flux 2 Pro', edit('Flux 2 Pro')],
    ['Develop', develop()],
    ['Relight', relight()],
    ['Relight with a reference', withNode({ class_type: 'RelightNode', inputs: { image: ['1', 0], reference: ['1', 0], light: '{}' } })],
    ['Blend · Flux Kontext Pro', blend('Flux Kontext Pro')],
    ['Blend · Flux 2 Pro', blend('Flux 2 Pro')],
  ]
  it.each(takes)('%s: taken only with fal-edit on', (_l, p) => {
    expect(isRunnerEligible(p, FAL_EDIT)).toBe(true)
    expect(isRunnerEligible(p)).toBe(false)
    expect(isRunnerEligible(p, NO_FAMILIES)).toBe(false)
    expect(isRunnerEligible(p, OTHERS)).toBe(false)
  })

  const refused: [string, ApiPrompt][] = [
    ['Edit with an unknown model', edit('Seedream')],
    ['Edit with no picture linked', edit('Nano Banana 2', { input_image: undefined })],
    ['Develop with no picture linked', develop({})],
    ['Relight with no picture linked (Python makes a blank)', relight({})],
    ['Relight with only a reference', relight({ reference: ['1', 0] })],
    ['Blend · Nano Banana (Task B5)', blend('Nano Banana')],
    ['Blend with keep_subject linked', blend('Flux Kontext Pro', { keep_subject: ['1', 0] })],
    ['Blend with no picture linked', blend('Flux 2 Pro', { image: undefined })],
    ['Edit reading from a node outside the prompt', { 2: { class_type: 'EditImageNode', inputs: { model: 'Nano Banana 2', input_image: ['9', 0], prompt: 'p' } } }],
    // Text the runner reads as plain text must not be wired (B2 review M4).
    ['Edit with a wired prompt', edit('Nano Banana 2', { prompt: ['1', 0] })],
    ['Blend with a wired prompt', blend('Flux 2 Pro', { prompt: ['1', 0] })],
    ['Relight with a wired light', relight({ image: ['1', 0], light: ['1', 0] })],
    ['Relight with wired instructions', relight({ image: ['1', 0], instructions: ['1', 0] })],
  ]
  it.each(refused)('%s: not taken', (_l, p) => {
    expect(isRunnerEligible(p, FAL_EDIT)).toBe(false)
    expect(runnerTakesNode(p, '2', FAL_EDIT)).toBe(false)
  })
})

// ── Price ────────────────────────────────────────────────────────────────

describe('fal-edit price', () => {
  it('every class and model prices above 0, at the shared price for its settings (Task P4)', () => {
    const nodes: [string, Record<string, unknown>][] = [
      ['EditImageNode', { model: 'Nano Banana 2' }], ['EditImageNode', { model: 'Flux Kontext Pro' }], ['EditImageNode', { model: 'Flux 2 Pro' }],
      ['DevelopImageNode', {}], ['RelightNode', {}],
      ['BlendSceneNode', { model: 'Flux Kontext Pro' }], ['BlendSceneNode', { model: 'Flux 2 Pro' }],
    ]
    for (const [ct, inputs] of nodes) {
      const credits = nodeCredits({ class_type: ct, inputs })
      expect(credits).toBeGreaterThan(0)
      expect(credits).toBe((priceNode(ct, inputs) as { credits: number }).credits)
    }
    for (const [, p] of [['e', edit('Flux 2 Pro')], ['d', develop()], ['r', relight()], ['b', blend('Flux Kontext Pro')]] as const) {
      expect(unpricedProviderNode(p)).toBeNull()
    }
  })
})

// ── Engine, with the fake fal ────────────────────────────────────────────

/** Image card (a loaded picture) → the node → Image card. */
function flow(node: { class_type: string; inputs: Record<string, unknown> }): ApiPrompt {
  return {
    1: { class_type: 'Image', inputs: { image: 'a.png' } },
    2: node,
    3: { class_type: 'Image', inputs: { image: '', export: false, images: ['2', 0], batch_index: -1 } },
  }
}

const ENGINE_CASES: [string, ApiPrompt, string, string][] = [
  ['EditImageNode', flow({ class_type: 'EditImageNode', inputs: { model: 'Nano Banana 2', input_image: ['1', 0], prompt: 'make it blue', aspect_ratio: 'match_input_image', resolution: '1K', seed: 0, safety_tolerance: 2, prompt_upsampling: false, output_format: 'png' } }), 'fal-ai/nano-banana-2/edit', 'edit_image'],
  ['DevelopImageNode', flow({ class_type: 'DevelopImageNode', inputs: { input_image: ['1', 0], resolution: '2K', seed: 0 } }), 'fal-ai/nano-banana-2/edit', 'edit_image'],
  ['RelightNode', flow({ class_type: 'RelightNode', inputs: { image: ['1', 0], preset: 'Golden hour', light: '{"azimuth":-30,"elevation":20,"intensity":0.6}', keep_background: true, instructions: 'warmer' } }), 'fal-ai/nano-banana-2/edit', 'relight'],
  ['BlendSceneNode', flow({ class_type: 'BlendSceneNode', inputs: { model: 'Flux Kontext Pro', image: ['1', 0], unify_lighting: true, contact_shadows: true, match_camera_look: true, preserve_identity: true, keep_feather: 2, prompt: '', seed: 0, output_format: 'png' } }), 'fal-ai/flux-pro/kontext', 'blend_scene'],
]

describe('fal-edit on the engine (hosted, fake fal)', () => {
  it.each(ENGINE_CASES)('%s: Image card → node → Image card', async (ct, prompt, endpoint, prefix) => {
    const k = makeKit({ hosted: true, deps: { families: () => FAL_EDIT } })
    writeFileSync(join(k.root, 'input', 'a.png'), new Uint8Array([1, 2, 3]))
    const { runId, promptIds } = await k.engine.startRun({ userId: k.userId, takes: [prompt], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await k.engine.settled(runId)

    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    // The picture is handed off once, and the request carries that link.
    expect(k.upload).toHaveBeenCalledTimes(1)
    expect(k.upload).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), 'a.png', 'image/png')
    const sent = k.fal.submitted()
    expect(sent.map(r => r.endpoint)).toEqual([endpoint])
    expect(JSON.stringify(sent[0]!.payload)).toContain('https://fal.storage/a.png')
    // The charge is the node's price for its settings (+ the render credit the output card brings).
    const flat = (priceNode(ct, prompt[2]!.inputs) as { credits: number }).credits
    expect(k.ledger.hold).toHaveBeenCalledWith('user_1', flat + BASE_RENDER_CREDITS, `runner:${promptIds[0]}`)
    expect(k.ledger.settle).toHaveBeenCalledWith(1, flat + BASE_RENDER_CREDITS, `runner:${promptIds[0]}`)
    // One generation record, holding the node's output.
    expect(k.records.write).toHaveBeenCalledTimes(1)
    const rec = (k.records.write.mock.calls[0] as unknown as [{ outputs: OutputFile[] }])[0]
    expect(rec.outputs.map(f => f.filename)).toEqual([`${prefix}_00001_.png`])
    // The node shows its still; the card after it shows the same file.
    const executed = ofType(k.seen, 'executed')
    const own = executed.find(m => m.data.node === '2')!.data.output as { images: OutputFile[]; animated: boolean[] }
    expect(own.animated).toEqual([false])
    expect(own.images.map(f => f.filename)).toEqual([`${prefix}_00001_.png`])
    const after = executed.find(m => m.data.node === '3')!.data.output as { images: OutputFile[] }
    expect(after.images).toEqual(own.images)
  })

  // B2 review M2: the record names what was asked for, not nothing.
  it.each([
    ['Develop records its built instruction', 1, DEVELOP_PROMPT],
    ['Relight records its built instruction', 2, 'warmer'],
    ['Blend with no custom prompt records the toggle-built instruction', 3, 'Blend'],
    ['Edit records its prompt widget', 0, 'make it blue'],
  ] as const)('%s', async (_l, i, want) => {
    const k = makeKit({ hosted: true, deps: { families: () => FAL_EDIT } })
    writeFileSync(join(k.root, 'input', 'a.png'), new Uint8Array([1, 2, 3]))
    const { runId, promptIds } = await k.engine.startRun({ userId: k.userId, takes: [ENGINE_CASES[i]![1]], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await k.engine.settled(runId)
    const rec = await k.engine.record(k.userId, promptIds[0]!)
    const sent = k.fal.submitted()[0]!.payload.prompt as string
    expect(rec!.prompt).toContain(want)
    if (i !== 0) expect(rec!.prompt).toBe(sent)
  })

  it('a record falls back to the node\'s own text fields when nothing was sent', () => {
    expect(extraPromptText({ n: { class_type: 'RemoveObjectNode', inputs: { image: ['1', 0], target: 'the cup', instructions: ' ' } } })).toBe('the cup')
  })

  it('with fal-edit off the server refuses the same workflow', async () => {
    const k = makeKit({ hosted: true })
    await expect(k.engine.startRun({ userId: k.userId, takes: [ENGINE_CASES[0]![1]], workflow: null, canvasId: null, projectUuid: null, projectName: null }))
      .rejects.toMatchObject({ statusCode: 400 })
    expect(k.fal.client.submit).not.toHaveBeenCalled()
  })
})
