/**
 * References, camera and product shot (Phase B, Task B7, family `ref-edits`):
 * GenerateFromReferencesNode (Seedream 5 Pro/Lite on Replicate, Nano Banana 2
 * on fal), RotateCameraNode (Qwen Image Edit Plus on Replicate) and
 * ProductShotNode (the community model catacolabs/sdxl-ad-inpaint on
 * Replicate, reached through its latest version).
 *
 * The payloads are checked against the first provider call the Python node
 * makes (fixtures/runner-families.json `refEdits`, written by
 * scripts/runner_builder_fixtures.py with the network blocked). Engine tests
 * use the fake fal and the fake Replicate (for the community model, the real
 * Replicate client over a fetch that answers as Replicate would): nothing here
 * reaches a provider.
 *
 * Since Task S1b the runner deliberately differs from that Python oracle
 * where Python breaks the model's published schema: Seedream 5 Pro and Lite
 * get no seed (their schemas have none) and no ratio outside their list.
 * helpers/pythonParity.ts compares every other field; the fixture is kept
 * for those.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { planNode } from '~~/server/runner/executors'
import { nodeCredits, unpricedProviderNode } from '~~/server/runner/metering'
import { BASE_RENDER_CREDITS } from '~~/server/utils/priceBook'
import { priceNode } from '#shared/pricing/nodePrice'
import {
  REFERENCE_MODEL_IDS, cameraToPhrase, parseCamera, pitchPhrase, rollPhrase, yawPhrase,
} from '~~/server/runner/generators/refEdits'
import { RUNNER_NOT_ELIGIBLE } from '#shared/runner/messages'
import { PROVIDER_TYPES, RUNNER_NODE_RULES, isRunnerEligible, runnerTakesNode, type RunnerNodeRule } from '#shared/runner/eligibility'
import { NO_FAMILIES, RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import type { ApiPrompt } from '#shared/runner/graph'
import type { OutputFile } from '~~/server/runner/types'
import { expectPythonParity } from './helpers/pythonParity'
import { requestProblem } from '~~/server/runner/requestRules'
import { createFakeFal, createFakeReplicate, makeKit, ofType } from './__runner__/kit'

interface RefCase {
  class_type: string
  links: string[]
  widgets: Record<string, unknown>
  call?: { provider: string; endpoint: string; payload: Record<string, unknown> }
  error?: string
}
const CASES = (JSON.parse(readFileSync(
  fileURLToPath(new URL('./fixtures/runner-families.json', import.meta.url)), 'utf8')) as { refEdits: RefCase[] }).refEdits

const REF: ReadonlySet<RunnerFamily> = new Set(['ref-edits'])
// Every other family but Rotate camera's upgrade (qwen-2511-angles, Task F10),
// which takes Rotate camera on its newer model (runner-qwen-2511-angles.unit.spec.ts).
const OTHERS: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES.filter(f => f !== 'ref-edits' && f !== 'qwen-2511-angles'))
/** The classes ref-edits takes. Product shot left the runner in H2 (its SDXL engine is retired; F12 brings Bria). */
const CLASSES = ['GenerateFromReferencesNode', 'RotateCameraNode']
const SLOTS = ['image_1', 'image_2', 'image_3', 'image_4', 'image_5', 'image_6']

// ── Parity with the Python nodes ─────────────────────────────────────────

const fileOf = (name: string): OutputFile => ({ filename: `${name}.png`, subfolder: '', type: 'output' })

/** A case as the node the canvas sends: each linked picture comes from a node `src_<input>`. */
function planCase(c: RefCase, handedOff: string[] = []) {
  const inputs: Record<string, unknown> = { ...c.widgets }
  for (const name of c.links) inputs[name] = [`src_${name}`, 0]
  return planNode({
    prompt: { n: { class_type: c.class_type, inputs } },
    nodeId: 'n',
    filesFrom: ([from]) => [fileOf(from.slice(4))],
    // Python passes each picture through _image_tensor_to_data_url → `IMG:<input>`.
    toUrl: async (f: OutputFile) => {
      const name = f.filename.replace(/\.png$/, '')
      handedOff.push(name)
      return `IMG:${name}`
    },
    gateOpen: false,
  })
}

describe('ref-edits payloads match the Python nodes', () => {
  it('the fixture covers every model, reference count, aspect, size and seed kind', () => {
    const refs = CASES.filter(c => c.class_type === 'GenerateFromReferencesNode')
    for (const model of REFERENCE_MODEL_IDS) {
      for (const count of [1, 3, 6]) {
        const mine = refs.filter(c => c.widgets.model === model && c.links.length === count && c.widgets.prompt === 'put the mug on the table')
        expect(mine, `${model} × ${count}`).toHaveLength(9 * 3 * 2)
        expect(new Set(mine.map(c => c.widgets.aspect_ratio)).size, `${model} × ${count}`).toBe(9)
        expect(new Set(mine.map(c => c.widgets.size))).toEqual(new Set(['1K', '2K', '3K']))
        expect(mine.some(c => c.widgets.seed === 0) && mine.some(c => (c.widgets.seed as number) > 0)).toBe(true)
      }
    }
    // 3K on Nano Banana 2 clamps to 2K; match_input_image is sent to Seedream as it is.
    const nb3k = refs.find(c => c.widgets.model === 'nano-banana-2' && c.widgets.size === '3K')!
    expect(nb3k.call!.payload.resolution).toBe('2K')
    expect(refs.find(c => c.widgets.model === 'seedream-5-pro' && c.widgets.aspect_ratio === 'match_input_image')!
      .call!.payload.aspect_ratio).toBe('match_input_image')

    const endpoints = new Set(CASES.filter(c => c.call).map(c => `${c.class_type} ${c.call!.provider} ${c.call!.endpoint}`))
    expect([...endpoints].sort()).toEqual([
      'GenerateFromReferencesNode fal fal-ai/nano-banana-2/edit',
      'GenerateFromReferencesNode replicate bytedance/seedream-5-lite',
      'GenerateFromReferencesNode replicate bytedance/seedream-5-pro',
      'ProductShotNode replicate catacolabs/sdxl-ad-inpaint',
      'RotateCameraNode replicate qwen/qwen-image-edit-plus',
    ])
    expect(CASES.filter(c => c.error).map(c => c.class_type)).toEqual(Array(4).fill('RotateCameraNode'))
    expect(CASES.length).toBeGreaterThan(600)
  })

  it.each(CASES.map((c, i) => [`${i} ${c.class_type} ${JSON.stringify(c.widgets)} links=${c.links.join(',')}`, c] as const))(
    '%s', async (_label, c) => {
      const handedOff: string[] = []
      if (c.error) {
        // Python's float() raises on the camera value: the runner fails the node too, and sends nothing.
        await expect(planCase(c, handedOff)).rejects.toThrow('The camera setting can’t be read')
        expect(handedOff).toEqual([])
        return
      }
      // A request no provider takes (Nano Banana with a prompt under 3
      // characters) is refused in plain words before anything is sent (S1b fix round 1).
      const refusal = requestProblem(c.call!.provider, c.call!.endpoint, c.call!.payload)
      if (refusal) {
        await expect(planCase(c, handedOff)).rejects.toThrow(refusal)
        return
      }
      const plan = await planCase(c, handedOff)
      expect(plan.kind).toBe('provider')
      if (plan.kind !== 'provider') return
      expect(plan.provider).toBe(c.call!.provider)
      expect(plan.endpoint).toBe(c.call!.endpoint)
      expectPythonParity(c.call!.provider as 'fal' | 'replicate', c.call!.endpoint, plan.payload, c.call!.payload)
      expect(plan.media).toBe('image')
      // Every linked picture is handed off once, in slot order.
      expect(handedOff).toEqual(c.class_type === 'GenerateFromReferencesNode' ? SLOTS.filter(s => c.links.includes(s)) : ['image'])
    })

  it('names each output with the Python asset tag and shows it as a still', async () => {
    const want: Record<string, string> = {
      GenerateFromReferencesNode: 'generate_from_references', RotateCameraNode: 'rotate_camera', ProductShotNode: 'product_shot',
    }
    for (const [ct, prefix] of Object.entries(want)) {
      const plan = await planCase(CASES.find(c => c.class_type === ct && c.call)!)
      if (plan.kind !== 'provider') throw new Error('expected a provider plan')
      expect(plan.prefix).toBe(prefix)
      const files = [fileOf(`${prefix}_00001_`)]
      expect(plan.uiFor(files)).toEqual({ images: files, animated: [false] })
    }
  })

  it('empty reference slots are skipped and the rest keep their slot order', () => {
    const order = (model: string, links: string[]) => {
      const c = CASES.find(x => x.widgets.model === model && x.links.join() === links.join() && x.widgets.aspect_ratio === '16:9')!
      return c.call!.payload[model === 'nano-banana-2' ? 'image_urls' : 'image_input']
    }
    for (const model of REFERENCE_MODEL_IDS) {
      expect(order(model, ['image_1', 'image_3', 'image_6'])).toEqual(['IMG:image_1', 'IMG:image_3', 'IMG:image_6'])
      expect(order(model, ['image_1', 'image_2', 'image_5'])).toEqual(['IMG:image_1', 'IMG:image_2', 'IMG:image_5'])
    }
  })

  it('a linked picture that brought no file fails the node with a plain message', async () => {
    const plan = (ct: string, inputs: Record<string, unknown>, empty: string) => planNode({
      prompt: { n: { class_type: ct, inputs } }, nodeId: 'n', gateOpen: false, toUrl: async () => 'x',
      filesFrom: ([from]) => from === empty ? [] : [fileOf(from)],
    })
    await expect(plan('GenerateFromReferencesNode', { model: 'seedream-5-pro', image_1: ['a', 0], image_2: ['b', 0] }, 'b'))
      .rejects.toThrow('There is no reference picture')
    await expect(plan('RotateCameraNode', { image: ['a', 0], camera: '{}' }, 'a')).rejects.toThrow('There is no picture to turn')
    await expect(plan('ProductShotNode', { image: ['a', 0], scene_prompt: '' }, 'a')).rejects.toThrow('There is no product picture')
  })

  it('a prompt or scene that is not text fails the node, and nothing is handed off', async () => {
    const handedOff: string[] = []
    const plan = (ct: string, inputs: Record<string, unknown>) => planNode({
      prompt: { n: { class_type: ct, inputs } }, nodeId: 'n', gateOpen: false,
      toUrl: async (f) => { handedOff.push(f.filename); return 'x' }, filesFrom: ([from]) => [fileOf(from)],
    })
    await expect(plan('GenerateFromReferencesNode', { model: 'nano-banana-2', image_1: ['a', 0], prompt: 5 })).rejects.toThrow('The prompt must be text')
    await expect(plan('ProductShotNode', { image: ['a', 0], scene_prompt: null })).rejects.toThrow('The scene description must be text')
    expect(handedOff).toEqual([])
  })

  it('an unknown reference model is refused plainly', async () => {
    await expect(planNode({
      prompt: { n: { class_type: 'GenerateFromReferencesNode', inputs: { model: 'qwen-image-edit-plus', image_1: ['a', 0] } } },
      nodeId: 'n', gateOpen: false, toUrl: async () => 'x', filesFrom: () => [fileOf('a')],
    })).rejects.toThrow('The runner cannot generate from references with qwen-image-edit-plus')
  })
})

// ── Camera phrase ────────────────────────────────────────────────────────

describe('the camera phrase (_camera_to_phrase)', () => {
  it('the Python docstring examples', () => {
    expect(cameraToPhrase(0, 0, 0)).toBe('viewed from the front')
    expect(cameraToPhrase(90, 0, 0)).toBe('viewed from the right side')
    expect(cameraToPhrase(180, 30, 0)).toBe('viewed from directly behind, at a high angle')
    expect(cameraToPhrase(180, 29, 0)).toBe('viewed from directly behind, at a slight high angle')
    expect(cameraToPhrase(-45, -30, 15)).toBe('viewed from the front-left, at a low angle, with the camera tilted slightly clockwise')
  })

  it('reads the gimbal JSON tolerantly', () => {
    expect(parseCamera('not json')).toEqual({ yaw: 0, pitch: 0, roll: 0 })
    expect(parseCamera(7)).toEqual({ yaw: 0, pitch: 0, roll: 0 })
    expect(parseCamera('{"yaw":"1_0","pitch":" 50 ","roll":true}')).toEqual({ yaw: 10, pitch: 50, roll: 1 })
    const odd = parseCamera('{"yaw": NaN, "pitch": Infinity, "roll": -Infinity}')
    expect(odd.yaw).toBeNaN()
    expect([odd.pitch, odd.roll]).toEqual([Infinity, -Infinity])
    // A number word inside a string is text, not a number.
    expect(() => parseCamera('{"yaw": "NaNa"}')).toThrow('The camera setting can’t be read')
    expect(parseCamera('{"note": "NaN", "yaw": NaN}').yaw).toBeNaN()
  })

  // The gimbal (WidgetCameraGimbal.vue) shows the phrase live and says it
  // mirrors Python. Its three phrase functions, run over every bucket edge,
  // must say what the runner (Python) says. The widget is not changed here.
  it('WidgetCameraGimbal.vue shows the same phrase for every angle the gimbal can write', () => {
    const src = readFileSync(fileURLToPath(new URL('../../app/components/vue-canvas/widgets/WidgetCameraGimbal.vue', import.meta.url)), 'utf8')
    const start = src.indexOf('function yawPhrase')
    const end = src.indexOf('const phrase = computed')
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const js = src.slice(start, end).replace(/\((\w+): number\): string( \| null)?/g, '($1)')
    // eslint-disable-next-line no-new-func
    const widget = new Function(`${js}; return { yawPhrase, pitchPhrase, rollPhrase }`)() as {
      yawPhrase(d: number): string; pitchPhrase(d: number): string | null; rollPhrase(d: number): string | null
    }
    const edges = [0, 4.99, 5, 7.49, 7.5, 19.99, 20, 22.49, 22.5, 29.99, 30, 59.99, 60, 67.49, 67.5, 79.99, 80, 90,
      112.49, 112.5, 157.5, 157.51, 179.99, 180, 202.5, 270, 360, 540]
    const angles = [...edges, ...edges.map(e => -e)]
    for (const a of angles) {
      expect(widget.yawPhrase(a), `yaw ${a}`).toBe(yawPhrase(a))
      expect(widget.rollPhrase(a), `roll ${a}`).toBe(rollPhrase(a))
      // The gimbal clamps pitch to ±90 before it writes it.
      if (Math.abs(a) <= 90) expect(widget.pitchPhrase(a), `pitch ${a}`).toBe(pitchPhrase(a))
    }
  })
})

// ── Eligibility rows ─────────────────────────────────────────────────────

const nodeRuleFamilies = (r: RunnerNodeRule): string[] =>
  [r.family, ...Object.values(r.models ?? {}).map(m => typeof m === 'string' ? m : m.family)].filter((f): f is RunnerFamily => !!f)

const withNode = (n: { class_type: string; inputs: Record<string, unknown> }): ApiPrompt =>
  ({ 1: { class_type: 'Image', inputs: { image: 'a.png' } }, 2: n })
const node = (class_type: string, inputs: Record<string, unknown>) => withNode({ class_type, inputs })

describe('ref-edits eligibility', () => {
  it('the rows', () => {
    const rows = Object.keys(RUNNER_NODE_RULES).filter(ct => nodeRuleFamilies(RUNNER_NODE_RULES[ct]!).includes('ref-edits'))
    expect(rows.sort()).toEqual(CLASSES)
    for (const ct of rows) expect(PROVIDER_TYPES.has(ct)).toBe(true)
    expect(Object.keys(RUNNER_NODE_RULES.GenerateFromReferencesNode!.models!).sort()).toEqual([...REFERENCE_MODEL_IDS].sort())
    // Product shot's SDXL call is retired from the runner (model line-up H2):
    // its row has no family, only Bria Product Shot's upgrade (Task F12,
    // runner-bria-product-shot.unit.spec.ts), so no family reaches catacolabs/sdxl-ad-inpaint.
    expect(RUNNER_NODE_RULES.ProductShotNode!.family).toBeUndefined()
    expect(RUNNER_NODE_RULES.ProductShotNode!.models).toBeUndefined()
    expect(RUNNER_NODE_RULES.ProductShotNode!.upgrade!.family).toBe('bria-product-shot')
    expect(PROVIDER_TYPES.has('ProductShotNode')).toBe(true)
  })

  it('product shot: not taken with every family on but Bria Product Shot\'s; saved nodes stay with ComfyUI', () => {
    const p = node('ProductShotNode', { image: ['1', 0], scene_prompt: 'a beach' })
    const allButBria = new Set(RUNNER_FAMILIES.filter(f => f !== 'bria-product-shot'))
    expect(isRunnerEligible(p, allButBria)).toBe(false)
    expect(runnerTakesNode(p, '2', allButBria)).toBe(false)
  })

  const takes: [string, ApiPrompt][] = [
    ...REFERENCE_MODEL_IDS.map(m => [`references · ${m}`, node('GenerateFromReferencesNode', { model: m, image_1: ['1', 0], prompt: 'p' })] as [string, ApiPrompt]),
    ['references · six pictures', node('GenerateFromReferencesNode', { model: 'seedream-5-lite', ...Object.fromEntries(SLOTS.map(s => [s, ['1', 0]])) })],
    ['rotate camera', node('RotateCameraNode', { image: ['1', 0], camera: '{"yaw":90}', seed: 0 })],
  ]
  it.each(takes)('%s: taken only with ref-edits on', (_l, p) => {
    expect(isRunnerEligible(p, REF)).toBe(true)
    expect(isRunnerEligible(p)).toBe(false)
    expect(isRunnerEligible(p, NO_FAMILIES)).toBe(false)
    expect(isRunnerEligible(p, OTHERS)).toBe(false)
  })

  const refused: [string, ApiPrompt][] = [
    ['references with no image_1', node('GenerateFromReferencesNode', { model: 'seedream-5-pro', image_2: ['1', 0] })],
    ['references on a model the node does not offer', node('GenerateFromReferencesNode', { model: 'qwen-image-edit-plus', image_1: ['1', 0] })],
    ['references with a wired prompt', node('GenerateFromReferencesNode', { model: 'seedream-5-pro', image_1: ['1', 0], prompt: ['1', 0] })],
    ['references with a wired aspect', node('GenerateFromReferencesNode', { model: 'seedream-5-pro', image_1: ['1', 0], aspect_ratio: ['1', 0] })],
    ['rotate camera with no picture', node('RotateCameraNode', { camera: '{}' })],
    ['rotate camera with a wired camera', node('RotateCameraNode', { image: ['1', 0], camera: ['1', 0] })],
    ['product shot with no picture', node('ProductShotNode', { scene_prompt: 'x' })],
    ['product shot with a wired scene', node('ProductShotNode', { image: ['1', 0], scene_prompt: ['1', 0] })],
    ['a reference from outside the prompt', { 2: { class_type: 'GenerateFromReferencesNode', inputs: { model: 'seedream-5-pro', image_1: ['9', 0] } } }],
  ]
  it.each(refused)('%s: not taken', (_l, p) => {
    expect(isRunnerEligible(p, REF)).toBe(false)
    expect(runnerTakesNode(p, '2', REF)).toBe(false)
  })
})

// ── Price ────────────────────────────────────────────────────────────────

describe('ref-edits price', () => {
  it('every class and model prices above 0 at the shared price for its settings', () => {
    const nodes = [
      ...REFERENCE_MODEL_IDS.map(m => ({ class_type: 'GenerateFromReferencesNode', inputs: { model: m } })),
      { class_type: 'RotateCameraNode', inputs: {} },
    ]
    for (const n of nodes) {
      expect(nodeCredits(n), n.class_type).toBeGreaterThan(0)
      expect(nodeCredits(n), n.class_type).toBe((priceNode(n.class_type, n.inputs) as { credits: number }).credits)
      expect(unpricedProviderNode(withNode(n))).toBeNull()
    }
    // Product shot runs on ComfyUI only now, and is still priced there.
    expect((priceNode('ProductShotNode', {}) as { credits: number }).credits).toBeGreaterThan(0)
  })
})

// ── Engine ───────────────────────────────────────────────────────────────

const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }

/**
 * Six Image cards feed one reference node. The cards' ids run the other way
 * round from the slots (image_1 ← card 16 … image_6 ← card 11), so an order
 * by node id would show.
 */
function sixReferences(model: string): ApiPrompt {
  const p: ApiPrompt = {}
  const inputs: Record<string, unknown> = { model, prompt: 'the mug on the table', aspect_ratio: '4:3', size: '2K', seed: 5 }
  SLOTS.forEach((slot, i) => {
    const card = String(16 - i)
    p[card] = { class_type: 'Image', inputs: { image: `ref${i + 1}.png` } }
    inputs[slot] = [card, 0]
  })
  p['2'] = { class_type: 'GenerateFromReferencesNode', inputs }
  p['3'] = { class_type: 'Image', inputs: { image: '', export: false, images: ['2', 0], batch_index: -1 } }
  return p
}

function kit(o: { replicate?: ReturnType<typeof createFakeReplicate>; deps?: Parameters<typeof makeKit>[0]['deps'] } = {}) {
  const k = makeKit({ hosted: true, replicate: o.replicate, fal: createFakeFal(), deps: { families: () => REF, ...o.deps } })
  for (let i = 1; i <= 6; i++) writeFileSync(join(k.root, 'input', `ref${i}.png`), new Uint8Array([i]))
  return k
}

const storage = (n: number[]) => n.map(i => `https://fal.storage/ref${i}.png`)
const uploadedNames = (k: ReturnType<typeof kit>) => k.upload.mock.calls.map(c => c[1] as string)

describe('ref-edits on the engine (hosted, fake providers)', () => {
  it('six linked Image cards feed one reference node: six hand-offs, in slot order, and one Replicate call', async () => {
    const k = kit()
    const { runId, promptIds } = await k.engine.startRun({ userId: k.userId, takes: [sixReferences('seedream-5-pro')], ...START })
    await k.engine.settled(runId)

    expect((await k.store.get(runId))!.status).toBe('done')
    expect(uploadedNames(k)).toEqual(['ref1.png', 'ref2.png', 'ref3.png', 'ref4.png', 'ref5.png', 'ref6.png'])
    const sent = k.replicate.submitted()
    expect(sent.map(r => r.endpoint)).toEqual(['bytedance/seedream-5-pro'])
    // No seed: bytedance/seedream-5-pro's schema has none (Task S1b).
    expect(sent[0]!.payload).toEqual({
      prompt: 'the mug on the table', image_input: storage([1, 2, 3, 4, 5, 6]), size: '2K', aspect_ratio: '4:3',
    })
    expect(k.fal.client.submit).not.toHaveBeenCalled()
    // Seedream 5 Pro at 2K: $0.09 → 18 credits (Task P4).
    const flat = (priceNode('GenerateFromReferencesNode', { model: 'seedream-5-pro', size: '2K' }) as { credits: number }).credits
    expect(flat).toBe(18)
    expect(k.ledger.hold).toHaveBeenCalledWith('user_1', flat + BASE_RENDER_CREDITS, `runner:${promptIds[0]}`)
    expect(k.ledger.settle).toHaveBeenCalledWith(1, flat + BASE_RENDER_CREDITS, `runner:${promptIds[0]}`)
    expect(k.records.write).toHaveBeenCalledTimes(1)
    const rec = (k.records.write.mock.calls[0] as unknown as [{ outputs: OutputFile[] }])[0]
    expect(rec.outputs.map(f => f.filename)).toEqual(['generate_from_references_00001_.png'])
    const own = ofType(k.seen, 'executed').find(m => m.data.node === '2')!.data.output as { images: OutputFile[]; animated: boolean[] }
    expect(own.animated).toEqual([false])
  })

  it('Nano Banana 2 goes to fal, its Python primary, with the six pictures in slot order', async () => {
    const k = kit()
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [sixReferences('nano-banana-2')], ...START })
    await k.engine.settled(runId)

    expect((await k.store.get(runId))!.status).toBe('done')
    expect(uploadedNames(k)).toEqual(['ref1.png', 'ref2.png', 'ref3.png', 'ref4.png', 'ref5.png', 'ref6.png'])
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
    const sent = k.fal.submitted()
    expect(sent.map(r => r.endpoint)).toEqual(['fal-ai/nano-banana-2/edit'])
    expect(sent[0]!.payload).toEqual({
      prompt: 'the mug on the table', image_urls: storage([1, 2, 3, 4, 5, 6]), output_format: 'png', resolution: '2K', num_images: 1, seed: 5,
    })
  })

  it('Rotate camera sends the phrase to Qwen Image Edit Plus on Replicate', async () => {
    const k = kit()
    const prompt: ApiPrompt = {
      1: { class_type: 'Image', inputs: { image: 'ref1.png' } },
      2: { class_type: 'RotateCameraNode', inputs: { image: ['1', 0], camera: '{"yaw":-45,"pitch":-30,"roll":15}', seed: 3 } },
      3: { class_type: 'Image', inputs: { image: '', export: false, images: ['2', 0], batch_index: -1 } },
    }
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [prompt], ...START })
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.status).toBe('done')
    expect(k.replicate.submitted().map(r => [r.endpoint, r.payload])).toEqual([['qwen/qwen-image-edit-plus', {
      prompt: 'viewed from the front-left, at a low angle, with the camera tilted slightly clockwise',
      image: storage([1]), output_format: 'png', output_quality: 95, seed: 3,
    }]])
  })

  it('an unreadable camera fails the node before anything is handed off or sent, and the hold is released', async () => {
    const k = kit()
    const prompt: ApiPrompt = {
      1: { class_type: 'Image', inputs: { image: 'ref1.png' } },
      2: { class_type: 'RotateCameraNode', inputs: { image: ['1', 0], camera: '{"yaw":"left"}', seed: 0 } },
      3: { class_type: 'Image', inputs: { image: '', export: false, images: ['2', 0], batch_index: -1 } },
    }
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [prompt], ...START })
    await k.engine.settled(runId)
    expect(k.upload).not.toHaveBeenCalled()
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
    expect(ofType(k.seen, 'execution_error').some(m => String(m.data.exception_message).includes('The camera setting can’t be read'))).toBe(true)
    expect([...k.ledger.holds.values()].map(h => h.state)).toEqual(['released'])
  })

  it('with ref-edits off the server refuses the same workflow', async () => {
    const k = makeKit({ hosted: true })
    await expect(k.engine.startRun({ userId: k.userId, takes: [sixReferences('seedream-5-pro')], ...START }))
      .rejects.toMatchObject({ statusCode: 400 })
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
  })
})

// ── The community model: Replicate's latest-version route ────────────────

describe('Product shot is retired from the runner (model line-up H2)', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  // The community model's Replicate route (404, then the latest version) is
  // still covered by runner-replicate-queue.unit.spec.ts. Product shot itself
  // no longer reaches it: with every family on but Bria Product Shot's (Task
  // F12, which moves the node to Bria), the runner declines the workflow
  // before any call or hold, so the browser sends it to ComfyUI.
  it('with every family on but Bria Product Shot\'s, the runner declines it before any call or hold', async () => {
    const fetchSpy = vi.fn(async () => { throw new Error('no call expected') })
    vi.stubGlobal('fetch', fetchSpy)
    const k = kit({ deps: { families: () => new Set(RUNNER_FAMILIES.filter(f => f !== 'bria-product-shot')) } })
    const prompt: ApiPrompt = {
      1: { class_type: 'Image', inputs: { image: 'ref1.png' } },
      2: { class_type: 'ProductShotNode', inputs: { image: ['1', 0], scene_prompt: '   ', aspect: 'Portrait', product_size: '60', keep_product_exact: false, seed: 11 } },
      3: { class_type: 'Image', inputs: { image: '', export: false, images: ['2', 0], batch_index: -1 } },
    }
    await expect(k.engine.startRun({ userId: k.userId, takes: [prompt], ...START }))
      .rejects.toMatchObject({ statusCode: 400, data: { reason: RUNNER_NOT_ELIGIBLE } })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.replicate.submitted()).toEqual([])
  })
})
