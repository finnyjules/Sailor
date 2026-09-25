/**
 * Restyle from image (Phase B, Task B8, family `restyle`):
 * RestyleFromImageNode on Nano Banana 2 / Pro (fal edit), Nano Banana
 * (Replicate google/nano-banana) and IP-Adapter Style Transfer (Replicate
 * fofr/style-transfer), with a moodboard's pictures (style_refs) winning over
 * the style picture.
 *
 * The payloads are checked against the first provider call the Python node
 * makes (fixtures/runner-families.json `restyle`, written by
 * scripts/runner_builder_fixtures.py with the network blocked; its cases
 * include restyle_moodboard_test.py's). Engine tests use the fake fal and the
 * fake Replicate: nothing here reaches a provider.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { planNode } from '~~/server/runner/executors'
import { createMetering, extraPromptText, nodeCredits, stageEstimate, unpricedProviderNode } from '~~/server/runner/metering'
import { collectInputFiles } from '~~/server/runner/inputs'
import { BASE_RENDER_CREDITS } from '~~/server/utils/priceBook'
import { priceNode } from '#shared/pricing/nodePrice'
import {
  RESTYLE_DEFAULT_PROMPT, RESTYLE_MODELS, RESTYLE_NO_STYLE_SOURCE, RESTYLE_STYLE_EMPHASIS, STYLE_REFS_INSTRUCTION,
  STYLE_TRANSFER_NO_PICTURE, buildRestyleInstruction, isUnreadableFile, structureStrengthOf,
} from '~~/server/runner/generators/restyle'
import { PROVIDER_TYPES, RUNNER_NODE_RULES, isRunnerEligible, runnerTakesNode, type RunnerNodeRule } from '#shared/runner/eligibility'
import { NO_FAMILIES, RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import type { ApiPrompt } from '#shared/runner/graph'
import { RUNNER_NOT_ELIGIBLE } from '#shared/runner/messages'
import type { OutputFile } from '~~/server/runner/types'
import { createFakeFal, createFakeLedger, createFakeReplicate, makeKit, ofType } from './__runner__/kit'

interface RestyleCase {
  class_type: string
  links: string[]
  widgets: Record<string, unknown>
  call?: { provider: string; endpoint: string; payload: Record<string, unknown> }
  error?: string
}
const CASES = (JSON.parse(readFileSync(
  fileURLToPath(new URL('./fixtures/runner-families.json', import.meta.url)), 'utf8')) as { restyle: RestyleCase[] }).restyle

const RESTYLE: ReadonlySet<RunnerFamily> = new Set(['restyle'])
const OTHERS: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES.filter(f => f !== 'restyle'))
const IP = 'Style Transfer · IP-Adapter'
/** The models the restyle family takes. IP-Adapter left the runner in H2 (retired; its price is only an estimate). */
const TAKEN = RESTYLE_MODELS.filter(m => m !== IP)
const ENDPOINTS: Record<string, string> = {
  'Nano Banana 2': 'fal fal-ai/nano-banana-2/edit',
  'Nano Banana Pro': 'fal fal-ai/nano-banana-pro/edit',
  'Nano Banana': 'replicate google/nano-banana',
  [IP]: 'replicate fofr/style-transfer',
}

// ── Parity with the Python node ──────────────────────────────────────────

const fileOf = (name: string): OutputFile => ({ filename: `${name}.png`, subfolder: '', type: 'output' })
const enoent = (name: string) => Object.assign(new Error(`ENOENT: no such file, open '${name}'`), { code: 'ENOENT' })

/**
 * A case as the node the canvas sends: each linked picture comes from a node
 * `src_<input>` and is handed off as `IMG:<input>` (Python's
 * _image_tensor_to_data_url); a moodboard file is handed off as
 * `BOARD:<file>`, and a `gone_*` one can't be read, as in the fixture.
 */
function planCase(c: RestyleCase, handedOff: string[] = []) {
  const inputs: Record<string, unknown> = { ...c.widgets }
  for (const name of c.links) inputs[name] = [`src_${name}`, 0]
  return planNode({
    prompt: { n: { class_type: c.class_type, inputs } },
    nodeId: 'n',
    filesFrom: ([from]) => [fileOf(from.slice(4))],
    toUrl: async (f: OutputFile) => {
      if (f.subfolder.startsWith('moodboard_')) {
        handedOff.push(`board:${f.filename}`)
        if (f.filename.startsWith('gone_')) throw enoent(f.filename)
        return `BOARD:${f.filename}`
      }
      const name = f.filename.replace(/\.png$/, '')
      handedOff.push(name)
      return `IMG:${name}`
    },
    gateOpen: false,
  })
}

const pythonMessage = (error: string) => error.replace(/^RuntimeError: /, '')

describe('restyle payloads match the Python node', () => {
  it('the fixture covers every model × board or none × style picture or none × taste or none', () => {
    for (const model of RESTYLE_MODELS) {
      const mine = CASES.filter(c => c.widgets.model === model)
      for (const board of [undefined, '00_a.png', 'a.png', 'gone_a.png']) {
        for (const style of [true, false]) {
          for (const taste of [undefined, 'dusty pastel palette']) {
            const hit = mine.some(c => (board === undefined ? c.widgets.style_refs === undefined : String(c.widgets.style_refs).includes(board))
              && c.links.includes('style_image') === style && c.widgets.style_in === taste)
            expect(hit, `${model} board=${board} style=${style} taste=${taste}`).toBe(true)
          }
        }
      }
      // The structure dial across both thresholds, the formats and the resolutions.
      const strengths = new Set(mine.map(c => c.widgets.structure_strength))
      for (const s of [0.33, 0.34, 0.65, 0.66]) expect(strengths.has(s), `${model} ${s}`).toBe(true)
      expect(new Set(mine.map(c => c.widgets.output_format))).toEqual(new Set(['png', 'jpg', undefined]))
      expect(new Set(mine.map(c => c.widgets.resolution))).toEqual(new Set(['1K', '2K', '4K', undefined]))
    }
    const endpoints = new Set(CASES.filter(c => c.call).map(c => `${c.widgets.model} ${c.call!.provider} ${c.call!.endpoint}`))
    expect([...endpoints].sort()).toEqual(Object.entries(ENDPOINTS).map(([m, e]) => `${m} ${e}`).sort())
    // Both of Python's guards are in the fixture.
    const errors = new Set(CASES.filter(c => c.error).map(c => pythonMessage(c.error!)))
    expect(errors).toEqual(new Set([RESTYLE_NO_STYLE_SOURCE, STYLE_TRANSFER_NO_PICTURE]))
    expect(CASES.length).toBeGreaterThan(300)
  })

  it.each(CASES.map((c, i) => [`${i} ${JSON.stringify(c.widgets)} links=${c.links.join(',')}`, c] as const))(
    '%s', async (_label, c) => {
      const handedOff: string[] = []
      if (c.error) {
        await expect(planCase(c, handedOff)).rejects.toThrow(pythonMessage(c.error))
        // With no board to read, the guard fails the node before anything is handed off.
        if (c.widgets.style_refs === undefined || !String(c.widgets.style_refs).includes('gone_')) expect(handedOff).toEqual([])
        return
      }
      const plan = await planCase(c, handedOff)
      expect(plan.kind).toBe('provider')
      if (plan.kind !== 'provider') return
      expect(plan.provider).toBe(c.call!.provider)
      expect(plan.endpoint).toBe(c.call!.endpoint)
      expect(plan.payload).toEqual(c.call!.payload)
      expect(plan.media).toBe('image')
      // The content first; the style picture only when it is sent, and last.
      const sent = JSON.stringify(c.call!.payload)
      expect(handedOff[0]).toBe('content_image')
      expect(handedOff.includes('style_image')).toBe(sent.includes('IMG:style_image'))
      if (handedOff.includes('style_image')) expect(handedOff.at(-1)).toBe('style_image')
      for (const m of sent.matchAll(/BOARD:([^"]+)/g)) expect(handedOff).toContain(`board:${m[1]}`)
    })

  it('restyle_moodboard_test.py: content first, then the board; the style picture is ignored', async () => {
    const c = CASES.find(x => x.widgets.model === 'Nano Banana 2' && String(x.widgets.style_refs).includes('00_a.png')
      && x.links.includes('style_image') && x.widgets.style_in === 'dusty pastel palette')!
    const plan = await planCase(c)
    if (plan.kind !== 'provider') throw new Error('expected a provider plan')
    expect(plan.payload.image_urls).toEqual(['IMG:content_image', 'BOARD:00_a.png', 'BOARD:01_b.jpg'])
    expect(plan.payload.prompt).toContain('STYLE references')
    expect(plan.payload.prompt).toContain('dusty pastel palette')
    expect(plan.payload).not.toHaveProperty('seed')
  })

  it('restyle_moodboard_test.py: the board is capped at three; IP-Adapter takes the first board picture it can read', async () => {
    const five = CASES.find(x => x.widgets.model === 'Nano Banana 2' && String(x.widgets.style_refs).includes('e.png') && !x.links.includes('style_image'))!
    const p5 = await planCase(five)
    if (p5.kind !== 'provider') throw new Error('expected a provider plan')
    expect(p5.payload.image_urls).toHaveLength(1 + 3)

    const handedOff: string[] = []
    const partial = CASES.find(x => x.widgets.model === IP && String(x.widgets.style_refs).includes('c.webp') && !x.links.includes('style_image') && !x.widgets.style_in)!
    const pp = await planCase(partial, handedOff)
    if (pp.kind !== 'provider') throw new Error('expected a provider plan')
    expect(pp.payload.style_image).toBe('BOARD:b.png')
    expect(pp.payload.structure_image).toBe('IMG:content_image')
    // It stops at the first picture it could read: c.webp is never handed off.
    expect(handedOff).toEqual(['content_image', 'board:gone_a.png', 'board:b.png'])
  })

  it('restyle_moodboard_test.py: a board whose pictures are gone restyles on the taste alone (Nano Banana), and fails IP-Adapter', async () => {
    const nb = CASES.find(x => x.widgets.model === 'Nano Banana 2' && String(x.widgets.style_refs).includes('gone_b.png') && !x.links.includes('style_image') && x.widgets.style_in)!
    const plan = await planCase(nb)
    if (plan.kind !== 'provider') throw new Error('expected a provider plan')
    expect(plan.payload.image_urls).toEqual(['IMG:content_image'])
    expect(plan.payload.prompt).toContain('dusty pastel palette')
    const ip = CASES.find(x => x.widgets.model === IP && String(x.widgets.style_refs).includes('gone_b.png') && !x.links.includes('style_image') && x.widgets.style_in)!
    expect(pythonMessage(ip.error!)).toBe(STYLE_TRANSFER_NO_PICTURE)
    await expect(planCase(ip)).rejects.toThrow(STYLE_TRANSFER_NO_PICTURE)
  })

  it('names the output with the Python asset tag and shows it as a still', async () => {
    for (const model of RESTYLE_MODELS) {
      const plan = await planCase(CASES.find(c => c.widgets.model === model && c.call)!)
      if (plan.kind !== 'provider') throw new Error('expected a provider plan')
      expect(plan.prefix).toBe('restyle')
      const files = [fileOf('restyle_00001_')]
      expect(plan.uiFor(files)).toEqual({ images: files, animated: [false] })
    }
  })

  it('a board picture that fails to upload fails the node (only an unreadable file is skipped)', async () => {
    const inputs = {
      model: 'Nano Banana 2', content_image: ['c', 0],
      style_refs: JSON.stringify({ folder: 'moodboard_1', files: ['a.png'] }),
    }
    await expect(planNode({
      prompt: { n: { class_type: 'RestyleFromImageNode', inputs } }, nodeId: 'n', gateOpen: false,
      filesFrom: ([from]) => [fileOf(from)],
      toUrl: async (f) => { if (f.subfolder) throw new Error('fal storage upload failed: 503'); return 'x' },
    })).rejects.toThrow('fal storage upload failed: 503')
    expect(isUnreadableFile(enoent('a.png'))).toBe(true)
    expect(isUnreadableFile(new Error('fal storage upload failed: 503'))).toBe(false)
    expect(isUnreadableFile(null)).toBe(false)
  })

  it('a linked picture that brought no file fails the node with a plain message', async () => {
    const plan = (inputs: Record<string, unknown>, empty: string) => planNode({
      prompt: { n: { class_type: 'RestyleFromImageNode', inputs } }, nodeId: 'n', gateOpen: false, toUrl: async () => 'x',
      filesFrom: ([from]) => from === empty ? [] : [fileOf(from)],
    })
    await expect(plan({ model: 'Nano Banana 2', content_image: ['c', 0], style_image: ['s', 0] }, 'c')).rejects.toThrow('There is no picture to restyle')
    await expect(plan({ model: 'Nano Banana 2', content_image: ['c', 0], style_image: ['s', 0] }, 's')).rejects.toThrow('There is no style picture')
  })

  it('text and the structure dial are read the way ComfyUI hands them over; anything else fails before a hand-off', async () => {
    const handedOff: string[] = []
    const plan = (over: Record<string, unknown>) => planNode({
      prompt: { n: { class_type: 'RestyleFromImageNode', inputs: { model: 'Nano Banana 2', content_image: ['c', 0], style_image: ['s', 0], ...over } } },
      nodeId: 'n', gateOpen: false, toUrl: async (f) => { handedOff.push(f.filename); return 'x' }, filesFrom: ([from]) => [fileOf(from)],
    })
    await expect(plan({ prompt: 5 })).rejects.toThrow('The prompt must be text')
    await expect(plan({ style_in: 7 })).rejects.toThrow('The style direction must be text')
    await expect(plan({ structure_strength: 'high' })).rejects.toThrow('The structure strength must be a number')
    await expect(plan({ model: 'Style Transfer' })).rejects.toThrow('The runner cannot restyle with Style Transfer')
    expect(handedOff).toEqual([])
    expect(structureStrengthOf(undefined)).toBe(0.65)
    expect(structureStrengthOf(' 0.7 ')).toBe(0.7)
    expect(structureStrengthOf(true)).toBe(1)
    expect(() => structureStrengthOf(null)).toThrow('The structure strength must be a number')
  })
})

// ── build_restyle_instruction (replicate_refs_test.py, the restyle parts) ─

describe('build_restyle_instruction', () => {
  const BASE = RESTYLE_DEFAULT_PROMPT + RESTYLE_STYLE_EMPHASIS

  it('always emphasizes the style', () => {
    for (const s of [0.0, 0.2, 0.5, 0.8, 1.0]) expect(buildRestyleInstruction(s)).toContain(RESTYLE_STYLE_EMPHASIS)
  })
  it('high structure locks the subject', () => {
    const out = buildRestyleInstruction(0.8)
    expect(out.startsWith(RESTYLE_DEFAULT_PROMPT)).toBe(true)
    expect(out).toContain('exactly as in the first image')
  })
  it('low structure allows reinterpretation', () => {
    expect(buildRestyleInstruction(0.2)).toContain('loosely reinterpret')
  })
  it('mid structure is plain', () => {
    expect(buildRestyleInstruction(0.5)).toBe(BASE)
  })
  it('appends the extra direction', () => {
    expect(buildRestyleInstruction(0.5, 'watercolor').endsWith('Additional style direction: watercolor.')).toBe(true)
  })
  it('a blank extra direction is ignored', () => {
    expect(buildRestyleInstruction(0.5, '   ')).toBe(BASE)
  })
  it('0.66 is the inclusive high threshold', () => {
    expect(buildRestyleInstruction(0.66)).toContain('exactly as in the first image')
  })
  it('just below the high threshold is plain', () => {
    expect(buildRestyleInstruction(0.65)).toBe(BASE)
  })
  it('0.33 is the inclusive low threshold', () => {
    expect(buildRestyleInstruction(0.33)).toContain('loosely reinterpret')
  })
  it('just above the low threshold is plain', () => {
    expect(buildRestyleInstruction(0.34)).toBe(BASE)
  })
  it('combines the structure clause and the extra direction', () => {
    const out = buildRestyleInstruction(0.8, 'watercolor')
    expect(out).toContain('exactly as in the first image')
    expect(out.endsWith('Additional style direction: watercolor.')).toBe(true)
  })
  it('the moodboard sentence is Python’s', () => {
    expect(STYLE_REFS_INSTRUCTION).toBe('Use the attached reference images strictly as STYLE references — match their palette, light, grain and mood; do not copy their subjects or composition.')
  })
})

// ── Eligibility ──────────────────────────────────────────────────────────

const nodeRuleFamilies = (r: RunnerNodeRule): string[] =>
  [r.family, ...Object.values(r.models ?? {}).map(m => typeof m === 'string' ? m : m.family)].filter((f): f is RunnerFamily => !!f)

const withNode = (n: { class_type: string; inputs: Record<string, unknown> }): ApiPrompt =>
  ({ 1: { class_type: 'Image', inputs: { image: 'a.png' } }, 2: n })
const node = (inputs: Record<string, unknown>) => withNode({ class_type: 'RestyleFromImageNode', inputs })
const BOARD = JSON.stringify({ folder: 'moodboard_1754', files: ['00_a.png', '01_b.jpg'] })

describe('restyle eligibility', () => {
  it('the row', () => {
    const rows = Object.keys(RUNNER_NODE_RULES).filter(ct => nodeRuleFamilies(RUNNER_NODE_RULES[ct]!).includes('restyle'))
    expect(rows).toEqual(['RestyleFromImageNode'])
    expect(PROVIDER_TYPES.has('RestyleFromImageNode')).toBe(true)
    expect(Object.keys(RUNNER_NODE_RULES.RestyleFromImageNode!.models!).sort()).toEqual([...TAKEN].sort())
  })

  it('IP-Adapter is retired from the runner (model line-up H2): not taken with every family on', () => {
    const p = node({ model: IP, content_image: ['1', 0], style_image: ['1', 0] })
    expect(isRunnerEligible(p, new Set(RUNNER_FAMILIES))).toBe(false)
    expect(runnerTakesNode(p, '2', new Set(RUNNER_FAMILIES))).toBe(false)
  })

  const takes: [string, ApiPrompt][] = [
    ...TAKEN.map(m => [`${m} with a style picture`, node({ model: m, content_image: ['1', 0], style_image: ['1', 0] })] as [string, ApiPrompt]),
    ['with a moodboard', node({ model: 'Nano Banana 2', content_image: ['1', 0], style_refs: BOARD })],
    // No style source at all is still taken: the node fails with Python's words.
    ['with no style source', node({ model: 'Nano Banana Pro', content_image: ['1', 0] })],
  ]
  it.each(takes)('%s: taken only with restyle on', (_l, p) => {
    expect(isRunnerEligible(p, RESTYLE)).toBe(true)
    expect(isRunnerEligible(p)).toBe(false)
    expect(isRunnerEligible(p, NO_FAMILIES)).toBe(false)
    expect(isRunnerEligible(p, OTHERS)).toBe(false)
  })

  const refused: [string, ApiPrompt][] = [
    ['a wired taste (style_in from a Moodboard node)', {
      1: { class_type: 'Image', inputs: { image: 'a.png' } },
      2: { class_type: 'RestyleFromImageNode', inputs: { model: 'Nano Banana 2', content_image: ['1', 0], style_in: ['3', 0] } },
      3: { class_type: 'MoodboardNode', inputs: {} },
    }],
    ['a wired taste from a card', node({ model: 'Nano Banana 2', content_image: ['1', 0], style_image: ['1', 0], style_in: ['1', 0] })],
    ['no content picture', node({ model: 'Nano Banana 2', style_image: ['1', 0] })],
    ['a model the node does not offer', node({ model: 'Style Transfer', content_image: ['1', 0], style_image: ['1', 0] })],
    ['a wired prompt', node({ model: 'Nano Banana 2', content_image: ['1', 0], style_image: ['1', 0], prompt: ['1', 0] })],
    ['wired style_refs', node({ model: 'Nano Banana 2', content_image: ['1', 0], style_refs: ['1', 0] })],
    ['a wired structure dial', node({ model: 'Nano Banana 2', content_image: ['1', 0], style_image: ['1', 0], structure_strength: ['1', 0] })],
    ['a picture from outside the prompt', { 2: { class_type: 'RestyleFromImageNode', inputs: { model: 'Nano Banana 2', content_image: ['9', 0], style_image: ['9', 0] } } }],
  ]
  it.each(refused)('%s: not taken', (_l, p) => {
    expect(isRunnerEligible(p, RESTYLE)).toBe(false)
    expect(runnerTakesNode(p, '2', RESTYLE)).toBe(false)
  })

  it('collectInputFiles names the board pictures, so hosted checks they are the user’s', () => {
    const files = collectInputFiles(node({ model: IP, content_image: ['1', 0], style_refs: BOARD }))
    expect(files).toEqual([
      { filename: 'a.png', subfolder: '', type: 'input' },
      { filename: '00_a.png', subfolder: 'moodboard_1754', type: 'input' },
      { filename: '01_b.jpg', subfolder: 'moodboard_1754', type: 'input' },
    ])
  })
})

/** The shared price of a Restyle node with these settings (Task P4: priced by model × resolution). */
function restylePrice(model: string, resolution: string): number {
  return (priceNode('RestyleFromImageNode', { model, resolution }) as { credits: number }).credits
}

// ── Price ────────────────────────────────────────────────────────────────

describe('restyle price', () => {
  it('every model prices above 0 at the shared price for its settings, and the stage holds it plus the render credit', () => {
    for (const model of RESTYLE_MODELS) {
      const n = { class_type: 'RestyleFromImageNode', inputs: { model, resolution: '4K' } }
      expect(nodeCredits(n), model).toBe(restylePrice(model, '4K'))
      expect(nodeCredits(n), model).toBeGreaterThan(0)
      expect(unpricedProviderNode(withNode(n))).toBeNull()
      expect(stageEstimate(withNode(n), ['1', '2'], true)).toBe(restylePrice(model, '4K') + BASE_RENDER_CREDITS)
    }
    // Task P4: Nano Banana Pro at 4K costs $0.30 → 45 credits (it was 10 flat).
    expect(restylePrice('Nano Banana Pro', '4K')).toBe(45)
  })
})

// ── Engine ───────────────────────────────────────────────────────────────

const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const FOLDER = 'moodboard_1754000000000'

/** content card(1) [+ style card(4)] → Restyle(2) → Image card(3). */
function restyleFlow(o: { model: string; board?: string[]; style?: boolean; prompt?: string; seed?: number; resolution?: string }): ApiPrompt {
  const inputs: Record<string, unknown> = {
    model: o.model, content_image: ['1', 0], prompt: o.prompt ?? '', structure_strength: 0.8,
    resolution: o.resolution ?? '2K', seed: o.seed ?? 0, output_format: 'jpg',
  }
  if (o.board) inputs.style_refs = JSON.stringify({ folder: FOLDER, files: o.board })
  const p: ApiPrompt = {
    1: { class_type: 'Image', inputs: { image: 'content.png' } },
    2: { class_type: 'RestyleFromImageNode', inputs },
    3: { class_type: 'Image', inputs: { image: '', export: false, images: ['2', 0], batch_index: -1 } },
  }
  if (o.style) {
    p[4] = { class_type: 'Image', inputs: { image: 'style.png' } }
    inputs.style_image = ['4', 0]
  }
  return p
}

function kit(o: { deps?: Parameters<typeof makeKit>[0]['deps'] } = {}) {
  const k = makeKit({ hosted: true, fal: createFakeFal(), replicate: createFakeReplicate(), deps: { families: () => RESTYLE, ...o.deps } })
  writeFileSync(join(k.root, 'input', 'content.png'), new Uint8Array([1]))
  writeFileSync(join(k.root, 'input', 'style.png'), new Uint8Array([2]))
  // A moodboard folder in the input dir, as /api/moodboards/images writes it.
  mkdirSync(join(k.root, 'input', FOLDER))
  writeFileSync(join(k.root, 'input', FOLDER, '00_a.png'), new Uint8Array([3]))
  writeFileSync(join(k.root, 'input', FOLDER, '01_b.jpg'), new Uint8Array([4]))
  return k
}

const uploadedNames = (k: ReturnType<typeof kit>) => k.upload.mock.calls.map(c => c[1] as string)
const link = (name: string) => `https://fal.storage/${name}`

describe('restyle on the engine (hosted, fake providers)', () => {
  it('a moodboard in the input folder: content then the board pictures, handed off in order, one fal call', async () => {
    const ownsInput = vi.fn(async () => true)
    const k = kit({ deps: { ownership: { ownsInput, ownsOutput: async () => true } } })
    const { runId, promptIds } = await k.engine.startRun({
      userId: k.userId, takes: [restyleFlow({ model: 'Nano Banana 2', board: ['00_a.png', '01_b.jpg'], style: true, prompt: 'watercolor', seed: 9 })], ...START,
    })
    await k.engine.settled(runId)

    expect((await k.store.get(runId))!.status).toBe('done')
    // Every board picture was checked as the user's before anything ran.
    expect(ownsInput).toHaveBeenCalledWith('user_1', { filename: '00_a.png', subfolder: FOLDER, type: 'input' })
    expect(ownsInput).toHaveBeenCalledWith('user_1', { filename: '01_b.jpg', subfolder: FOLDER, type: 'input' })
    // The style picture is ignored when the board is there, so it is not handed off.
    expect(uploadedNames(k)).toEqual(['content.png', '00_a.png', '01_b.jpg'])
    const sent = k.fal.submitted()
    expect(sent.map(r => r.endpoint)).toEqual(['fal-ai/nano-banana-2/edit'])
    expect(sent[0]!.payload).toEqual({
      prompt: `${buildRestyleInstruction(0.8, 'watercolor')} ${STYLE_REFS_INSTRUCTION}`,
      image_urls: [link('content.png'), link('00_a.png'), link('01_b.jpg')],
      output_format: 'jpeg', resolution: '2K', num_images: 1,
    })
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
    const price = restylePrice('Nano Banana 2', '2K')
    expect(k.ledger.hold).toHaveBeenCalledWith('user_1', price + BASE_RENDER_CREDITS, `runner:${promptIds[0]}`)
    expect(k.ledger.settle).toHaveBeenCalledWith(1, price + BASE_RENDER_CREDITS, `runner:${promptIds[0]}`)
    const rec = (k.records.write.mock.calls[0] as unknown as [{ outputs: OutputFile[] }])[0]
    expect(rec.outputs.map(f => f.filename)).toEqual(['restyle_00001_.png'])
    const own = ofType(k.seen, 'executed').find(m => m.data.node === '2')!.data.output as { animated: boolean[] }
    expect(own.animated).toEqual([false])
  })

  it('hosted refuses a board picture that is not the user’s: nothing is handed off, sent or held', async () => {
    const k = kit({
      deps: { ownership: { ownsInput: async (_u, f) => !f.subfolder.startsWith('moodboard_') || f.filename !== '01_b.jpg', ownsOutput: async () => true } },
    })
    await expect(k.engine.startRun({ userId: k.userId, takes: [restyleFlow({ model: 'Nano Banana 2', board: ['00_a.png', '01_b.jpg'] })], ...START }))
      .rejects.toMatchObject({ statusCode: 403, data: { file: '01_b.jpg' } })
    expect(k.upload).not.toHaveBeenCalled()
    expect(k.fal.client.submit).not.toHaveBeenCalled()
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
    expect(k.ledger.hold).not.toHaveBeenCalled()
  })

  it('a board picture missing from the folder is skipped; with none left the style picture is used', async () => {
    const k = kit()
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [restyleFlow({ model: 'Nano Banana Pro', board: ['deleted.png'], style: true, resolution: '4K' })], ...START })
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.status).toBe('done')
    expect(uploadedNames(k)).toEqual(['content.png', 'style.png'])
    expect(k.fal.submitted().map(r => [r.endpoint, r.payload])).toEqual([['fal-ai/nano-banana-pro/edit', {
      prompt: buildRestyleInstruction(0.8, ''), image_urls: [link('content.png'), link('style.png')],
      output_format: 'jpeg', resolution: '4K', num_images: 1,
    }]])
  })

  it('Nano Banana goes to Replicate google/nano-banana with no resolution', async () => {
    const k = kit()
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [restyleFlow({ model: 'Nano Banana', style: true, seed: 4 })], ...START })
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.status).toBe('done')
    expect(k.fal.client.submit).not.toHaveBeenCalled()
    expect(k.replicate.submitted().map(r => [r.endpoint, r.payload])).toEqual([['google/nano-banana', {
      prompt: buildRestyleInstruction(0.8, ''), image_input: [link('content.png'), link('style.png')], output_format: 'jpg',
    }]])
  })

  it('IP-Adapter (retired, model line-up H2): with every family on the runner declines it before any hand-off, call or hold', async () => {
    const k = kit({ deps: { families: () => new Set(RUNNER_FAMILIES) } })
    await expect(k.engine.startRun({
      userId: k.userId, takes: [restyleFlow({ model: IP, board: ['00_a.png', '01_b.jpg'], style: true, prompt: '  ink wash ', seed: 12 })], ...START,
    })).rejects.toMatchObject({ statusCode: 400, data: { reason: RUNNER_NOT_ELIGIBLE } })
    expect(k.upload).not.toHaveBeenCalled()
    expect(k.replicate.submitted()).toEqual([])
    expect(k.ledger.hold).not.toHaveBeenCalled()
  })

  it('no style source fails the node with Python’s words before anything is handed off, and the hold is released', async () => {
    const k = kit()
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [restyleFlow({ model: 'Nano Banana 2' })], ...START })
    await k.engine.settled(runId)
    expect(k.upload).not.toHaveBeenCalled()
    expect(k.fal.client.submit).not.toHaveBeenCalled()
    expect(ofType(k.seen, 'execution_error').some(m => String(m.data.exception_message).includes(RESTYLE_NO_STYLE_SOURCE))).toBe(true)
    expect([...k.ledger.holds.values()].map(h => h.state)).toEqual(['released'])
  })

  it('with restyle off the server refuses the same workflow', async () => {
    const k = makeKit({ hosted: true })
    await expect(k.engine.startRun({ userId: k.userId, takes: [restyleFlow({ model: 'Nano Banana 2', style: true })], ...START }))
      .rejects.toMatchObject({ statusCode: 400 })
    expect(k.fal.client.submit).not.toHaveBeenCalled()
  })
})

// ── Moderation of a typed-in taste (fix round 1) ─────────────────────────

describe('a typed-in taste (literal style_in) is moderated', () => {
  it('extraPromptText reads style_in on RestyleFromImageNode and GenerateImageNode only; every other class is unchanged', () => {
    expect(extraPromptText({ 2: { class_type: 'RestyleFromImageNode', inputs: { model: 'Nano Banana 2', style_in: 'grainy film', prompt: 'p' } } }))
      .toBe('grainy film')
    expect(extraPromptText({ 2: { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', style_in: 'grainy film', prompt: 'p' } } }))
      .toBe('grainy film')
    expect(extraPromptText({ 2: { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', style_in: ['1', 0] } } })).toBe('')
    // A wired or blank taste adds nothing.
    expect(extraPromptText({ 2: { class_type: 'RestyleFromImageNode', inputs: { style_in: ['1', 0] } } })).toBe('')
    expect(extraPromptText({ 2: { class_type: 'RestyleFromImageNode', inputs: { style_in: '   ' } } })).toBe('')
    // Other classes: style_in is not read, the edit fields are read as before.
    for (const ct of ['GenerateVideoNode', 'EditImageNode', 'RemoveObjectNode', 'RestyleWithLoRANode', 'SwapBackgroundNode']) {
      expect(extraPromptText({ 2: { class_type: ct, inputs: { style_in: 'grainy film' } } }), ct).toBe('')
      expect(extraPromptText({ 2: { class_type: ct, inputs: { style_in: 'grainy film', target: 'the car', instructions: 'x' } } }), ct)
        .toBe('the car x')
    }
  })

  function moderatedKit(moderate: (t: string) => Promise<{ ok: true } | { ok: false; categories: string[] }>) {
    const ledger = createFakeLedger()
    const metering = createMetering({
      hosted: () => true, ledger: () => ledger,
      graphRuns: { create: async () => {}, appendOutput: async () => {}, resolve: async () => {} },
      spendGuard: async () => {}, moderate,
    })
    return kit({ deps: { metering } })
  }

  it('hosted: the literal taste reaches the moderation check with the prompt, and is sent in the instruction', async () => {
    const moderate = vi.fn(async (_t: string) => ({ ok: true as const }))
    const k = moderatedKit(moderate)
    const flow = restyleFlow({ model: 'Nano Banana 2', style: true, prompt: 'watercolor' })
    ;(flow[2]!.inputs as Record<string, unknown>).style_in = 'grainy film'
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [flow], ...START })
    await k.engine.settled(runId)
    expect(moderate).toHaveBeenCalledTimes(1)
    const text = moderate.mock.calls[0]![0]
    expect(text).toContain('watercolor')
    expect(text).toContain('grainy film')
    expect(String(k.fal.submitted()[0]!.payload.prompt)).toContain('Additional style direction: watercolor grainy film.')
  })

  it('hosted: Generate an image (fal, no family needed) moderates its typed-in taste too, and a blocked one refuses the run', async () => {
    const moderate = vi.fn(async (t: string) => (t.includes('forbidden taste') ? { ok: false as const, categories: ['x'] } : { ok: true as const }))
    const k = moderatedKit(moderate)
    const flow: ApiPrompt = {
      1: { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a red fox', aspect_ratio: '1:1', seed: 0, model_options: '{}', style_in: 'forbidden taste' } },
      2: { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
    }
    await expect(k.engine.startRun({ userId: k.userId, takes: [flow], ...START }))
      .rejects.toMatchObject({ statusCode: 400, message: 'This prompt was blocked by content moderation' })
    expect(moderate.mock.calls[0]![0]).toContain('forbidden taste')
    expect(k.fal.client.submit).not.toHaveBeenCalled()
  })

  it('hosted: a blocked taste refuses the run before anything is handed off, sent or held', async () => {
    const moderate = vi.fn(async (t: string) => (t.includes('forbidden taste') ? { ok: false as const, categories: ['x'] } : { ok: true as const }))
    const k = moderatedKit(moderate)
    const flow = restyleFlow({ model: 'Nano Banana 2', style: true })
    ;(flow[2]!.inputs as Record<string, unknown>).style_in = 'forbidden taste'
    await expect(k.engine.startRun({ userId: k.userId, takes: [flow], ...START }))
      .rejects.toMatchObject({ statusCode: 400, message: 'This prompt was blocked by content moderation' })
    expect(k.upload).not.toHaveBeenCalled()
    expect(k.fal.client.submit).not.toHaveBeenCalled()
  })
})
