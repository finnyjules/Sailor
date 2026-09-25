/**
 * Generate an image on Replicate (Phase B, Task B4): the Replicate-primary
 * image models run on the Sailor runner when `replicate-image` is on.
 *
 * The payloads are checked against the first provider call the Python
 * GenerateImageNode makes (fixtures/runner-families.json `replicateImage`,
 * written by scripts/runner_builder_fixtures.py with the network patched out).
 * Since Task S1b the runner deliberately differs from that Python oracle
 * where Python breaks the model's published schema (a seed Imagen, GPT Image,
 * Recraft, Seedream 4.5, MiniMax and Grok don't take; an option outside its
 * list; Flux 2 Dev's size): helpers/pythonParity.ts compares every other
 * field, and the fixture is kept for those.
 * Engine tests use the fake Replicate and the fake fal only: nothing here
 * reaches a provider.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { planNode } from '~~/server/runner/executors'
import { nodeCredits, unpricedProviderNode } from '~~/server/runner/metering'
import { RUNNER_IMAGE_MODELS, RUNNER_REPLICATE_IMAGE_MODELS } from '~~/server/runner/generators/image'
import { optFloat, parseJsonObject } from '~~/server/runner/generators/opts'
import {
  PROVIDER_TYPES, RUNNER_IMAGE_MODEL_IDS, RUNNER_NODE_RULES, RUNNER_REPLICATE_IMAGE_MODEL_IDS,
  isRunnerEligible, runnerTakesNode,
} from '#shared/runner/eligibility'
import { NO_FAMILIES, RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import type { ApiPrompt } from '#shared/runner/graph'
import { IMAGE_MODELS_BY_ID } from '~~/app/data/image-models'
import { BASE_RENDER_CREDITS } from '~~/server/utils/priceBook'
import type { OutputFile } from '~~/server/runner/types'
import { createFakeLedger, makeKit } from './__runner__/kit'
import { expectPythonParity } from './helpers/pythonParity'

interface ReplicateImageCase {
  class_type: string
  links: string[]
  widgets: Record<string, unknown>
  call: { provider: string; endpoint: string; payload: Record<string, unknown> }
}
const CASES = (JSON.parse(readFileSync(
  fileURLToPath(new URL('./fixtures/runner-families.json', import.meta.url)), 'utf8')) as { replicateImage: ReplicateImageCase[] }).replicateImage

const REPLICATE_IMAGE: ReadonlySet<RunnerFamily> = new Set(['replicate-image'])
const OTHERS: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES.filter(f => f !== 'replicate-image'))
const ALL: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES)

// ── Parity with the Python node ──────────────────────────────────────────

async function planCase(c: ReplicateImageCase, toUrl: (f: OutputFile) => Promise<string> = async () => { throw new Error('no picture should be handed off') }) {
  const prompt: ApiPrompt = { n: { class_type: c.class_type, inputs: { ...c.widgets } } }
  return planNode({ prompt, nodeId: 'n', filesFrom: () => [], toUrl, gateOpen: false })
}

describe('replicate-image payloads match the Python node', () => {
  it('the fixture covers every model, each with the four common cases and more', () => {
    const byModel = new Map<string, number>()
    for (const c of CASES) byModel.set(String(c.widgets.model), (byModel.get(String(c.widgets.model)) ?? 0) + 1)
    expect([...byModel.keys()].sort()).toEqual([...RUNNER_REPLICATE_IMAGE_MODEL_IDS].sort())
    for (const [id, n] of byModel) expect(n, id).toBeGreaterThan(4)
    expect(CASES.every(c => c.class_type === 'GenerateImageNode' && c.links.length === 0)).toBe(true)
    // Python's first call is Replicate for every one, flux-2-* included (D5).
    expect(CASES.every(c => c.call.provider === 'replicate')).toBe(true)
  })

  it.each(CASES.map((c, i) => [`${i} ${JSON.stringify(c.widgets)}`, c] as const))('%s', async (_label, c) => {
    // No picture is handed off: moodboard pictures are ignored, as in Python.
    const plan = await planCase(c)
    expect(plan.kind).toBe('provider')
    if (plan.kind !== 'provider') return
    expect(plan.provider).toBe('replicate')
    expect(plan.endpoint).toBe(c.call.endpoint)
    expectPythonParity('replicate', c.call.endpoint, plan.payload, c.call.payload)
    expect(plan.media).toBe('image')
  })

  it('each builder, called on its own, gives the Python payload and ignores pictures', () => {
    const plain = CASES.filter(c => !('style_refs' in c.widgets) && !('style_block' in c.widgets))
    expect(plain.length).toBeGreaterThan(1000)
    for (const c of plain) {
      const desc = RUNNER_REPLICATE_IMAGE_MODELS[String(c.widgets.model)]!
      const got = desc.build({
        prompt: String(c.widgets.prompt),
        aspectRatio: String(c.widgets.aspect_ratio),
        seed: Number(c.widgets.seed),
        adv: parseJsonObject(c.widgets.model_options),
        refs: ['https://fal.storage/board.png'],
      })
      expectPythonParity('replicate', c.call.endpoint, got, c.call.payload, JSON.stringify(c.widgets))
    }
  })

  it('names the output generate_image and shows it as a still', async () => {
    const plan = await planCase(CASES[0]!)
    if (plan.kind !== 'provider') throw new Error('expected a provider plan')
    expect(plan.prefix).toBe('generate_image')
    const files: OutputFile[] = [{ filename: 'generate_image_00001_.png', subfolder: '', type: 'output' }]
    expect(plan.uiFor(files)).toEqual({ images: files, animated: [false] })
  })

  it('moodboard pictures never reach a Replicate model (none is multi-image), and add no style instruction', async () => {
    const withBoard = CASES.filter(c => 'style_refs' in c.widgets)
    expect(withBoard.length).toBe(RUNNER_REPLICATE_IMAGE_MODEL_IDS.length * 2)
    for (const c of withBoard) {
      expect(IMAGE_MODELS_BY_ID[String(c.widgets.model)]!.tags ?? []).not.toContain('multi-image')
      let handedOff = 0
      const plan = await planCase(c, async () => { handedOff++; return 'https://fal.storage/x.png' })
      if (plan.kind !== 'provider') throw new Error('expected a provider plan')
      expect(handedOff).toBe(0)
      expect(JSON.stringify(plan.payload)).not.toContain('STYLE references')
      expect(plan.payload).not.toHaveProperty('image_input')
      expect(plan.payload).not.toHaveProperty('image_urls')
    }
  })
})

// ── optFloat (_opt_float) ────────────────────────────────────────────────

describe('optFloat', () => {
  it('falls back only when the key is missing, as adv.get does', () => {
    expect(optFloat({}, 'g', 3.5)).toBe(3.5)
    expect(optFloat({ g: null }, 'g', 3.5)).toBe(3.5)
  })
  it('reads bools, numbers and the strings float() reads', () => {
    expect(optFloat({ g: true }, 'g', 3)).toBe(1)
    expect(optFloat({ g: false }, 'g', 3)).toBe(0)
    expect(optFloat({ g: 99 }, 'g', 3)).toBe(99)
    expect(optFloat({ g: ' 4.2 ' }, 'g', 3)).toBe(4.2)
    expect(optFloat({ g: '1e1' }, 'g', 3)).toBe(10)
    expect(optFloat({ g: '1_0.5' }, 'g', 3)).toBe(10.5)
    expect(optFloat({ g: '.5' }, 'g', 3)).toBe(0.5)
    expect(optFloat({ g: '5.' }, 'g', 3)).toBe(5)
    expect(optFloat({ g: '-inf' }, 'g', 3)).toBe(-Infinity)
    expect(optFloat({ g: 'NaN' }, 'g', 3)).toBeNaN()
  })
  it('anything float() raises on is the default', () => {
    for (const v of ['abc', '', '1__0', '_1', '1_', '.', '0x10', [2], { a: 1 }]) expect(optFloat({ g: v }, 'g', 3), JSON.stringify(v)).toBe(3)
  })
})

// ── The model list, guarded against the Python catalog ───────────────────

interface PyModel { id: string; slug: string; builder: string; primary: string; tags: string[] }
const PY_SRC = readFileSync(fileURLToPath(new URL('../../../comfy_api_nodes/image_models.py', import.meta.url)), 'utf8')

/** Every ImageModel(...) entry of image_models.py MODELS. */
function pythonModels(): PyModel[] {
  const block = PY_SRC.slice(PY_SRC.indexOf('MODELS: list[ImageModel] = ['), PY_SRC.indexOf('\nIMAGE_MODELS_BY_ID:'))
  const chunks = block.split(/\n\s*ImageModel\(/).slice(1)
  return chunks.map((ch) => {
    const head = ch.match(/^"([^"]+)",\s*"[^"]*",\s*"[^"]*",\s*"([^"]+)",\s*sorted\([^)]*\),\s*(\w+)/)
    if (!head) throw new Error(`could not read an ImageModel entry: ${ch.slice(0, 80)}`)
    const tags = ch.match(/tags=\(([^)]*)\)/)?.[1]?.match(/"([^"]+)"/g)?.map(t => t.slice(1, -1)) ?? []
    return { id: head[1]!, slug: head[2]!, builder: head[3]!, primary: ch.match(/primary="(\w+)"/)?.[1] ?? 'replicate', tags }
  })
}

describe('the Replicate image list', () => {
  const py = pythonModels()
  const byId = new Map(py.map(m => [m.id, m]))

  it('reads the Python catalog', () => {
    expect(py.length).toBeGreaterThanOrEqual(43)
    expect(byId.get('flux-2-pro')).toEqual({ id: 'flux-2-pro', slug: 'black-forest-labs/flux-2-pro', builder: '_b_flux_2_pro', primary: 'replicate', tags: ['flagship'] })
    expect(byId.get('flux-schnell')!.primary).toBe('fal')
  })

  it('every id on the list has a number price, a Python build_input, and the Python slug', () => {
    expect(Object.keys(RUNNER_REPLICATE_IMAGE_MODELS).sort()).toEqual([...RUNNER_REPLICATE_IMAGE_MODEL_IDS].sort())
    for (const id of RUNNER_REPLICATE_IMAGE_MODEL_IDS) {
      expect(typeof IMAGE_MODELS_BY_ID[id]?.pricePerImage, id).toBe('number')
      expect(IMAGE_MODELS_BY_ID[id]!.pricePerImage!, id).toBeGreaterThan(0)
      const m = byId.get(id)
      expect(m, id).toBeDefined()
      expect(PY_SRC, id).toContain(`def ${m!.builder}(`)
      expect(m!.primary, id).toBe('replicate')
      expect(RUNNER_REPLICATE_IMAGE_MODELS[id]!.slug, id).toBe(m!.slug)
    }
  })

  it('every Python Replicate-primary, priced, non-SVG model is on the list', () => {
    const want = py
      .filter(m => m.primary === 'replicate')
      .filter(m => typeof IMAGE_MODELS_BY_ID[m.id]?.pricePerImage === 'number')
      .filter(m => !m.tags.includes('svg') && !m.id.endsWith('-svg'))
      .map(m => m.id)
    expect([...RUNNER_REPLICATE_IMAGE_MODEL_IDS].sort()).toEqual(want.sort())
    expect(want).toHaveLength(36)
  })

  it('never overlaps the fal list', () => {
    for (const id of RUNNER_REPLICATE_IMAGE_MODEL_IDS) {
      expect((RUNNER_IMAGE_MODEL_IDS as readonly string[]).includes(id), id).toBe(false)
      expect(RUNNER_IMAGE_MODELS[id], id).toBeUndefined()
    }
  })

  it('keeps out the SVG models (D4): Python cannot decode an SVG either', () => {
    for (const id of ['recraft-v4-pro-svg', 'recraft-v4-svg', 'recraft-v3-svg']) {
      expect(byId.get(id)!.tags).toContain('svg')
      expect((RUNNER_REPLICATE_IMAGE_MODEL_IDS as readonly string[]).includes(id), id).toBe(false)
      expect(isRunnerEligible(one(img(id)), ALL), id).toBe(false)
    }
  })

  it('keeps out the unpriced models: hosted would refuse them', () => {
    for (const id of ['reve-create', 'seedream-5-pro']) {
      expect(IMAGE_MODELS_BY_ID[id]!.pricePerImage, id).toBeNull()
      expect((RUNNER_REPLICATE_IMAGE_MODEL_IDS as readonly string[]).includes(id), id).toBe(false)
      expect(isRunnerEligible(one(img(id)), ALL), id).toBe(false)
    }
  })

  it('keeps out Krea 2: priced (Task P3), but fal-first and waiting for its own family', () => {
    for (const id of ['krea-2-large', 'krea-2-medium']) {
      expect(IMAGE_MODELS_BY_ID[id]!.pricePerImage, id).toBeGreaterThan(0)
      expect(byId.get(id)!.primary, id).toBe('fal')
      expect((RUNNER_REPLICATE_IMAGE_MODEL_IDS as readonly string[]).includes(id), id).toBe(false)
      expect(isRunnerEligible(one(img(id)), ALL), id).toBe(false)
    }
  })

  it('sends flux-2-* to Replicate, their Python primary, not their fal twin (D5)', async () => {
    for (const id of ['flux-2-max', 'flux-2-pro', 'flux-2-flex', 'flux-2-dev']) {
      expect(PY_SRC).toMatch(new RegExp(`ImageModel\\("${id}"[^\\n]*\\n\\s*fal_slug="fal-ai/${id}"`))
      const plan = await planNode({ prompt: one(img(id)), nodeId: '1', filesFrom: () => [], toUrl: async () => 'x', gateOpen: false })
      if (plan.kind !== 'provider') throw new Error('expected a provider plan')
      expect(plan.provider).toBe('replicate')
      expect(plan.endpoint).toBe(`black-forest-labs/${id}`)
    }
  })
})

// ── Eligibility ──────────────────────────────────────────────────────────

function img(model: string, inputs: Record<string, unknown> = {}) {
  return { class_type: 'GenerateImageNode', inputs: { model, prompt: 'a red fox', aspect_ratio: '1:1', seed: 0, model_options: '{}', ...inputs } }
}
const one = (n: ApiPrompt[string]): ApiPrompt => ({ 1: n })
const withCard = (n: ApiPrompt[string]): ApiPrompt => ({ 1: n, 2: { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } } })

describe('replicate-image eligibility', () => {
  it('the row adds only the Replicate models to GenerateImageNode (and GPT Image 2.5, Qwen Image 3, Grok Imagine 2 and Ideogram 4 under their own families, Tasks F2, F6, F7 and F8)', () => {
    const { 'gpt-image-2.5': gpt25, 'qwen-image-3': qwen3, 'grok-imagine-2': grok2, 'ideogram-4': ideogram4, ...models } = RUNNER_NODE_RULES.GenerateImageNode!.models!
    expect(gpt25).toBe('gpt-image-2.5')
    expect(qwen3).toBe('qwen-image-3')
    expect(grok2).toBe('grok-imagine-2')
    expect(ideogram4).toBe('ideogram-4')
    expect(Object.keys(models).sort()).toEqual([...RUNNER_REPLICATE_IMAGE_MODEL_IDS].sort())
    expect(new Set(Object.values(models))).toEqual(new Set(['replicate-image']))
    expect(PROVIDER_TYPES.has('GenerateImageNode')).toBe(true)
  })

  it.each([...RUNNER_REPLICATE_IMAGE_MODEL_IDS])('%s: taken only with replicate-image on', (id) => {
    const p = withCard(img(id))
    expect(isRunnerEligible(p, REPLICATE_IMAGE)).toBe(true)
    expect(isRunnerEligible(p, ALL)).toBe(true)
    expect(isRunnerEligible(p)).toBe(false)
    expect(isRunnerEligible(p, NO_FAMILIES)).toBe(false)
    expect(isRunnerEligible(p, OTHERS)).toBe(false)
  })

  it('the fal models are taken as before, with or without the family', () => {
    for (const id of RUNNER_IMAGE_MODEL_IDS) {
      expect(isRunnerEligible(one(img(id))), id).toBe(true)
      expect(isRunnerEligible(one(img(id)), REPLICATE_IMAGE), id).toBe(true)
    }
  })

  it('moodboard pictures do not stop a Replicate model being taken', () => {
    const board = JSON.stringify({ folder: 'moodboard_1727', files: ['a.png'] })
    expect(isRunnerEligible(one(img('imagen-4', { style_refs: board })), REPLICATE_IMAGE)).toBe(true)
  })

  const refused: [string, ApiPrompt][] = [
    ['flux-dev asking for 2 pictures', one(img('flux-dev', { model_options: JSON.stringify({ num_outputs: 2 }) }))],
    ['flux-dev asking for "4" pictures', one(img('flux-dev', { model_options: JSON.stringify({ num_outputs: '4' }) }))],
    ['a wired prompt', { 1: img('imagen-4', { prompt: ['2', 0] }), 2: { class_type: 'Image', inputs: { image: 'a.png' } } }],
    ['wired model options', { 1: img('imagen-4', { model_options: ['2', 0] }), 2: { class_type: 'Image', inputs: { image: 'a.png' } } }],
    ['a wired style block', { 1: img('imagen-4', { style_block: ['2', 0] }), 2: { class_type: 'Image', inputs: { image: 'a.png' } } }],
    ['wired moodboard refs', { 1: img('imagen-4', { style_refs: ['2', 0] }), 2: { class_type: 'Image', inputs: { image: 'a.png' } } }],
    ['a wired Idea', { 1: img('imagen-4', { prompt_in: ['2', 0] }), 2: { class_type: 'Image', inputs: { image: 'a.png' } } }],
    ['a wired taste', { 1: img('imagen-4', { style_in: ['2', 0] }), 2: { class_type: 'Image', inputs: { image: 'a.png' } } }],
    ['an unknown model', one(img('not-a-model'))],
  ]
  it.each(refused)('%s: not taken', (_l, p) => {
    expect(isRunnerEligible(p, REPLICATE_IMAGE)).toBe(false)
    expect(runnerTakesNode(p, '1', REPLICATE_IMAGE)).toBe(false)
  })

  it('flux-dev asking for one picture is taken', () => {
    expect(isRunnerEligible(one(img('flux-dev', { model_options: JSON.stringify({ num_outputs: 1 }) })), REPLICATE_IMAGE)).toBe(true)
  })
})

// ── Price ────────────────────────────────────────────────────────────────

describe('replicate-image price', () => {
  it('every model prices above 0 and the money guard lets it through', () => {
    for (const id of RUNNER_REPLICATE_IMAGE_MODEL_IDS) {
      expect(nodeCredits(img(id)), id).toBeGreaterThan(0)
      expect(unpricedProviderNode(one(img(id))), id).toBeNull()
    }
  })
})

// ── Engine: a Replicate picture through a Gate into a fal video ──────────

const start = (k: ReturnType<typeof makeKit>, takes: ApiPrompt[]) =>
  k.engine.startRun({ userId: k.userId, takes, workflow: null, canvasId: null, projectUuid: null, projectName: null })
const holds = (ledger: ReturnType<typeof createFakeLedger>) => [...ledger.holds.values()].map(h => [h.state, h.actual])

describe('replicate-image on the engine (hosted, fake Replicate and fal)', () => {
  const flow: ApiPrompt = {
    1: img('flux-2-pro', { prompt: 'a red fox', aspect_ratio: '16:9', model_options: JSON.stringify({ resolution: '2 MP' }) }),
    2: { class_type: 'ComfyGateNode', inputs: { data_in: ['1', 0], bypass: false } },
    3: { class_type: 'GenerateVideoNode', inputs: { model: 'hailuo-h3', prompt: 'the fox runs', image: ['2', 0], aspect_ratio: '16:9', duration: '5', seed: 0, model_options: '{}' } },
    4: { class_type: 'Video', inputs: { file: '', export: false, filename_prefix: 'video/ComfyUI', source: ['3', 0] } },
    5: { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
  }

  it('a Replicate image feeds a Gate, which feeds a fal video', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => REPLICATE_IMAGE } })
    const { runId } = await start(k, [flow])
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.status).toBe('paused')
    expect(k.fal.client.submit).not.toHaveBeenCalled()
    const sent = k.replicate.submitted()
    expect(sent).toHaveLength(1)
    expect(sent[0]!.endpoint).toBe('black-forest-labs/flux-2-pro')
    expect(sent[0]!.payload).toEqual({
      prompt: 'a red fox', aspect_ratio: '16:9', resolution: '2 MP', safety_tolerance: 2, output_format: 'webp', output_quality: 90,
    })

    await k.engine.gateAction({ userId: k.userId, runId, gateId: '2', action: 'continue' })
    await k.engine.settled(runId)
    expect(k.replicate.submitted()).toHaveLength(1)
    const video = k.fal.submitted()
    expect(video).toHaveLength(1)
    expect(video[0]!.endpoint).toBe('minimax/h3/image-to-video')
    expect(video[0]!.payload.image_url).toBe('https://fal.storage/generate_image_00001_.png')

    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    const image = run.takes[0]!.nodes['1']!
    expect(image.request!.provider).toBe('replicate')
    expect(image.outputs.map(f => f.filename)).toEqual(['generate_image_00001_.png'])
    expect(run.takes[0]!.nodes['3']!.request!.provider).toBe('fal')
    // The picture once on Replicate (+ the render credit), the video once on fal.
    const imageCredits = nodeCredits(flow[1]!)
    const videoCredits = nodeCredits(flow[3]!)
    expect(imageCredits).toBeGreaterThan(0)
    expect(holds(k.ledger)).toEqual([['settled', imageCredits + BASE_RENDER_CREDITS], ['settled', videoCredits]])
    expect(k.records.write).toHaveBeenCalledTimes(2)
  })

  it('with replicate-image off the server refuses the same workflow', async () => {
    const k = makeKit({ hosted: true })
    await expect(start(k, [flow])).rejects.toMatchObject({ statusCode: 400 })
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
    expect(k.fal.client.submit).not.toHaveBeenCalled()
  })
})
