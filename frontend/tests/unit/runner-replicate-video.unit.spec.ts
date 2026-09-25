/**
 * Generate a video on Replicate (Phase B, Task B6): the Replicate-provider
 * video models run on the Sailor runner when `replicate-video` is on.
 *
 * The payloads are checked against Python's own builders
 * (VIDEO_MODELS_BY_ID[id].build_input → fixtures/runner-families.json
 * `replicateVideo`, written by scripts/runner_builder_fixtures.py
 * --no-network). Engine tests use the fake Replicate and the fake fal only:
 * nothing here reaches a provider.
 *
 * Since Task S1b the runner deliberately differs from that Python oracle
 * where Python breaks the model's published schema: PixVerse gets `quality`
 * and `generate_audio_switch`, Wan `duration` (and 720p, not 480p), LTX `cfg`
 * and `steps`, Sora `seconds` and an orientation, and no model gets a field
 * its schema lacks (Kling's cfg_scale, Runway's motion, stray seeds…).
 * helpers/pythonParity.ts compares every other field; the fixture is kept
 * for those.
 *
 * Since Task S3 Kling 3.0 and PixVerse v6 go to fal first
 * (server/runner/generators/twins.ts); their Replicate request, still built
 * here, is the plan's backup.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { planNode } from '~~/server/runner/executors'
import { nodeCredits, unpricedProviderNode } from '~~/server/runner/metering'
import { RUNNER_REPLICATE_VIDEO_MODELS, RUNNER_VIDEO_MODELS } from '~~/server/runner/generators/video'
import { FAL_FIRST_VIDEO } from '~~/server/runner/generators/twins'
import {
  LEGACY_VIDEO_MODEL_REMAP, PROVIDER_TYPES, RUNNER_NODE_RULES, RUNNER_REPLICATE_VIDEO_MODEL_IDS, RUNNER_VIDEO_MODEL_IDS,
  isRunnerEligible, runnerTakesNode,
} from '#shared/runner/eligibility'
import { NO_FAMILIES, RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import type { ApiPrompt } from '#shared/runner/graph'
import { videoRate } from '#shared/pricing/videoRates'
import { BASE_RENDER_CREDITS } from '~~/server/utils/priceBook'
import type { OutputFile } from '~~/server/runner/types'
import { createFakeLedger, createFakeReplicate, gatedFlow, makeKit } from './__runner__/kit'
import { expectPythonParity } from './helpers/pythonParity'

interface VideoArgs { prompt: string; ar: string; dur: number; seed: number; image: string | null; adv: Record<string, unknown> }
interface ReplicateVideoCase {
  model: string
  provider: string
  slug: string
  modes: string[]
  default_duration: number
  args: VideoArgs
  payload?: Record<string, unknown>
  error?: string
}
const CASES = (JSON.parse(readFileSync(
  fileURLToPath(new URL('./fixtures/runner-families.json', import.meta.url)), 'utf8')) as { replicateVideo: ReplicateVideoCase[] }).replicateVideo

const PY_SRC = readFileSync(fileURLToPath(new URL('../../../comfy_api_nodes/video_models.py', import.meta.url)), 'utf8')

const REPLICATE_VIDEO: ReadonlySet<RunnerFamily> = new Set(['replicate-video'])
const OTHERS: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES.filter(f => f !== 'replicate-video'))
const ALL: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES)

const FRAME: OutputFile = { filename: 'first.png', subfolder: '', type: 'input' }

// ── Parity with the Python builders ──────────────────────────────────────

/** The case as the canvas sends it: the first frame linked from a card when there is one. */
async function planCase(c: ReplicateVideoCase) {
  const inputs: Record<string, unknown> = {
    model: c.model, prompt: c.args.prompt, aspect_ratio: c.args.ar, duration: String(c.args.dur),
    seed: c.args.seed, model_options: JSON.stringify(c.args.adv),
  }
  if (c.args.image) inputs.image = ['src', 0]
  const prompt: ApiPrompt = { n: { class_type: 'GenerateVideoNode', inputs } }
  const toUrl = vi.fn(async () => c.args.image!)
  const plan = await planNode({ prompt, nodeId: 'n', filesFrom: () => [FRAME], toUrl, gateOpen: false })
  return { plan, toUrl }
}

describe('replicate-video payloads match the Python builders (where Python keeps to the schema)', () => {
  it('the fixture covers every model, each on Replicate with its Python slug, modes and default duration', () => {
    const byModel = new Map<string, number>()
    for (const c of CASES) byModel.set(c.model, (byModel.get(c.model) ?? 0) + 1)
    expect([...byModel.keys()].sort()).toEqual([...RUNNER_REPLICATE_VIDEO_MODEL_IDS].sort())
    for (const [id, n] of byModel) expect(n, id).toBeGreaterThan(40)
    for (const c of CASES) {
      const d = RUNNER_REPLICATE_VIDEO_MODELS[c.model]!
      expect(c.provider).toBe('replicate')
      expect(d.slug, c.model).toBe(c.slug)
      expect([...d.modes], c.model).toEqual(c.modes)
      expect(d.defaultDuration, c.model).toBe(c.default_duration)
    }
    // Only Wan 2.5 I2V Fast with no first frame raises, as in Python.
    const errors = CASES.filter(c => c.error)
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.every(c => c.model === 'wan-2.5-i2v-fast' && !c.args.image)).toBe(true)
  })

  it.each(CASES.map((c, i) => [`${i} ${c.model} ${JSON.stringify(c.args)}`, c] as const))('%s', async (_label, c) => {
    const d = RUNNER_REPLICATE_VIDEO_MODELS[c.model]!
    const build = () => d.build({ prompt: c.args.prompt, aspectRatio: c.args.ar, duration: c.args.dur, seed: c.args.seed, image: c.args.image, adv: c.args.adv })
    if (c.error) {
      expect(build).toThrow(c.error)
      return
    }
    const built = build()
    expectPythonParity('replicate', c.slug, built, c.payload!)
    // The same through planNode, as the canvas sends the node.
    const { plan, toUrl } = await planCase(c)
    expect(plan.kind).toBe('provider')
    if (plan.kind !== 'provider') return
    // A model that moved to fal first (Task S3) carries this request as its backup.
    const onReplicate = FAL_FIRST_VIDEO[c.model] ? plan.backup! : plan
    if (FAL_FIRST_VIDEO[c.model]) expect(plan.provider).toBe('fal')
    expect(onReplicate.provider).toBe('replicate')
    expect(onReplicate.endpoint).toBe(c.slug)
    expect(onReplicate.payload).toEqual(built)
    expect(plan.media).toBe('video')
    // A text-to-video-only model ignores a linked first frame: it is not even handed off.
    expect(toUrl).toHaveBeenCalledTimes(c.args.image && c.modes.includes('i2v') ? 1 : 0)
  })
})

describe('replicate-video plans', () => {
  const node = (model: string, inputs: Record<string, unknown> = {}): ApiPrompt[string] => ({
    class_type: 'GenerateVideoNode',
    inputs: { model, prompt: 'the fox runs', aspect_ratio: '16:9', duration: '5', seed: 0, model_options: '{}', ...inputs },
  })
  const plan = (n: ApiPrompt[string], files: OutputFile[] = [FRAME]) =>
    planNode({ prompt: { n }, nodeId: 'n', filesFrom: () => files, toUrl: async () => 'https://fal.storage/first.png', gateOpen: false })

  it('names the output generate_video and shows nothing itself (the Video card does)', async () => {
    const p = await plan(node('kling-v3'))
    if (p.kind !== 'provider') throw new Error('expected a provider plan')
    expect(p.prefix).toBe('generate_video')
    expect(p.uiFor([{ filename: 'generate_video_00001_.mp4', subfolder: '', type: 'output' }])).toBeNull()
  })

  it('puts the first frame in each model’s own field', async () => {
    const field: Record<string, string | null> = {
      'sora-2': null, 'sora-2-pro': null, 'wan-2.7-t2v': null,
      'runway-gen-4.5': 'image', 'seedance-2.0-fast': 'image', 'wan-2.5-i2v-fast': 'image', 'ltx-video': 'image', 'pixverse-v6': 'image',
      'kling-v3': 'start_image', 'kling-v2.5-turbo-pro': 'start_image',
      'hailuo-2.3': 'first_frame_image', 'luma-ray-2-720p': 'start_image_url',
    }
    expect(Object.keys(field).sort()).toEqual([...RUNNER_REPLICATE_VIDEO_MODEL_IDS].sort())
    // Kling 3.0 and PixVerse v6 go to fal first (Task S3): fal's own field there, the Replicate one in the backup.
    const onFal: Record<string, string> = { 'kling-v3': 'start_image_url', 'pixverse-v6': 'image_url' }
    for (const [id, name] of Object.entries(field)) {
      const p = await plan(node(id, { image: ['src', 0] }))
      if (p.kind !== 'provider') throw new Error('expected a provider plan')
      const carrying = (payload: Record<string, unknown>) => Object.entries(payload).filter(([, v]) => v === 'https://fal.storage/first.png').map(([k]) => k)
      if (onFal[id]) {
        expect(carrying(p.payload), id).toEqual([onFal[id]])
        expect(carrying(p.backup!.payload), id).toEqual([name])
      }
      else expect(carrying(p.payload), id).toEqual(name ? [name] : [])
    }
  })

  it('the legacy label Kling 2.1 runs kling-v2.5-turbo-pro on Replicate', async () => {
    expect(LEGACY_VIDEO_MODEL_REMAP['Kling 2.1']).toBe('kling-v2.5-turbo-pro')
    const nodeSrc = readFileSync(fileURLToPath(new URL('../../../comfy_api_nodes/nodes_replicate.py', import.meta.url)), 'utf8')
    expect(nodeSrc).toMatch(/"Kling 2\.1":\s*"kling-v2\.5-turbo-pro"/)
    const p = await plan(node('Kling 2.1'))
    if (p.kind !== 'provider') throw new Error('expected a provider plan')
    expect(p.provider).toBe('replicate')
    expect(p.endpoint).toBe('kwaivgi/kling-v2.5-turbo-pro')
  })

  it('a missing duration takes the model’s default, as int(duration) failing does in Python', async () => {
    const p = await plan(node('hailuo-2.3', { duration: 'x' }))
    if (p.kind !== 'provider') throw new Error('expected a provider plan')
    expect(p.payload.duration).toBe(6)
  })

  it('Wan 2.5 I2V Fast whose linked picture brought no file fails the node plainly', async () => {
    await expect(plan(node('wan-2.5-i2v-fast', { image: ['src', 0] }), [])).rejects.toThrow('Wan 2.5 I2V Fast requires an input image.')
  })

  it('the fal video models still plan on fal', async () => {
    for (const id of RUNNER_VIDEO_MODEL_IDS) {
      const p = await plan(node(id))
      if (p.kind !== 'provider') throw new Error('expected a provider plan')
      expect(p.provider, id).toBe('fal')
    }
  })
})

// ── The list against the Python catalog ──────────────────────────────────

interface PyVideoModel { id: string; slug: string; provider: string; modes: string[]; builder: string }

/** Every VideoModel(...) entry of video_models.py MODELS. */
function pythonModels(): PyVideoModel[] {
  const block = PY_SRC.slice(PY_SRC.indexOf('MODELS: list[VideoModel] = ['), PY_SRC.indexOf('\nVIDEO_MODELS_BY_ID:'))
  return block.split(/\n\s*VideoModel\(/).slice(1).map((ch) => {
    const id = ch.match(/\bid="([^"]+)"/)?.[1]
    const slug = ch.match(/replicate_slug="([^"]+)"/)?.[1]
    const builder = ch.match(/build_input=(\w+)/)?.[1]
    const modes = ch.match(/modes=\[([^\]]*)\]/)?.[1]?.match(/"([^"]+)"/g)?.map(m => m.slice(1, -1))
    if (!id || !slug || !builder || !modes) throw new Error(`could not read a VideoModel entry: ${ch.slice(0, 80)}`)
    return { id, slug, builder, modes, provider: ch.match(/provider="(\w+)"/)?.[1] ?? 'replicate' }
  })
}

describe('the Replicate video list', () => {
  const py = pythonModels()
  const byId = new Map(py.map(m => [m.id, m]))

  it('reads the Python catalog', () => {
    expect(py.length).toBeGreaterThanOrEqual(19)
    expect(byId.get('kling-v3')).toEqual({ id: 'kling-v3', slug: 'kwaivgi/kling-v3-video', builder: '_b_kling_v3', modes: ['t2v', 'i2v'], provider: 'replicate' })
    expect(byId.get('veo-3.1')!.provider).toBe('fal')
  })

  it('every priced Replicate video model except fabric-1.0 is on the list', () => {
    const want = py
      .filter(m => m.provider === 'replicate')
      .filter(m => videoRate(m.id) != null)
      .filter(m => m.id !== 'fabric-1.0')
      .map(m => m.id)
    expect([...RUNNER_REPLICATE_VIDEO_MODEL_IDS].sort()).toEqual(want.sort())
    expect(want).toHaveLength(12)
  })

  it('every id on the list has the Python slug, modes and builder', () => {
    expect(Object.keys(RUNNER_REPLICATE_VIDEO_MODELS).sort()).toEqual([...RUNNER_REPLICATE_VIDEO_MODEL_IDS].sort())
    for (const id of RUNNER_REPLICATE_VIDEO_MODEL_IDS) {
      const m = byId.get(id)!
      expect(RUNNER_REPLICATE_VIDEO_MODELS[id]!.slug, id).toBe(m.slug)
      expect([...RUNNER_REPLICATE_VIDEO_MODELS[id]!.modes], id).toEqual(m.modes)
      expect(PY_SRC, id).toContain(`def ${m.builder}(`)
    }
  })

  it('never overlaps the fal list', () => {
    for (const id of RUNNER_REPLICATE_VIDEO_MODEL_IDS) {
      expect((RUNNER_VIDEO_MODEL_IDS as readonly string[]).includes(id), id).toBe(false)
      expect(RUNNER_VIDEO_MODELS[id], id).toBeUndefined()
    }
  })

  it('keeps out fabric-1.0: it needs a sound clip', () => {
    expect(byId.get('fabric-1.0')!.provider).toBe('replicate')
    expect((RUNNER_REPLICATE_VIDEO_MODEL_IDS as readonly string[]).includes('fabric-1.0')).toBe(false)
    expect(isRunnerEligible(withCard(vid('fabric-1.0')), ALL)).toBe(false)
    const withSound: ApiPrompt = {
      1: { class_type: 'Image', inputs: { image: 'a.png' } },
      2: { class_type: 'Image', inputs: { image: 'b.wav' } },
      3: vid('fabric-1.0', { image: ['1', 0], audio: ['2', 0] }),
    }
    expect(isRunnerEligible(withSound, ALL)).toBe(false)
  })
})

// ── Eligibility ──────────────────────────────────────────────────────────

function vid(model: string, inputs: Record<string, unknown> = {}): ApiPrompt[string] {
  return { class_type: 'GenerateVideoNode', inputs: { model, prompt: 'the fox runs', aspect_ratio: '16:9', duration: '5', seed: 0, model_options: '{}', ...inputs } }
}
const withCard = (n: ApiPrompt[string]): ApiPrompt => ({ 1: n, 2: { class_type: 'Video', inputs: { file: '', export: false, filename_prefix: 'v', source: ['1', 0] } } })
/** An Image card feeding the video's first frame, and a Video card after it. */
const withFrame = (n: ApiPrompt[string]): ApiPrompt => ({
  0: { class_type: 'Image', inputs: { image: 'a.png' } },
  1: { ...n, inputs: { ...n.inputs, image: ['0', 0] } },
  2: { class_type: 'Video', inputs: { file: '', export: false, filename_prefix: 'v', source: ['1', 0] } },
})

describe('replicate-video eligibility', () => {
  it('the row adds only the Replicate models to GenerateVideoNode; Wan 2.5 I2V Fast needs its image linked', () => {
    // Besides the wan-3 family's two (Task F1, runner-wan3.unit.spec.ts) and
    // the h3-max-turbo family's one (Task F3, runner-h3-max-turbo.unit.spec.ts)
    // and the gemini-omni-flash family's one (Task F4, runner-gemini-omni-flash.unit.spec.ts)
    // and the veo-3.1-lite family's one (Task F5, runner-veo-31-lite.unit.spec.ts).
    const models = Object.fromEntries(Object.entries(RUNNER_NODE_RULES.GenerateVideoNode!.models!)
      .filter(([, m]) => !['wan-3', 'h3-max-turbo', 'gemini-omni-flash', 'veo-3.1-lite'].includes(typeof m === 'string' ? m : m.family)))
    expect(Object.keys(RUNNER_NODE_RULES.GenerateVideoNode!.models!).filter(id => !(id in models)).sort()).toEqual(['gemini-omni-flash', 'hailuo-h3-max-turbo', 'veo-3.1-lite', 'wan-3.0', 'wan-3.0-prime'])
    expect(Object.keys(models).sort()).toEqual([...RUNNER_REPLICATE_VIDEO_MODEL_IDS].sort())
    for (const [id, m] of Object.entries(models)) {
      if (id === 'wan-2.5-i2v-fast') expect(m).toEqual({ family: 'replicate-video', mustLink: ['image'] })
      else expect(m).toBe('replicate-video')
    }
    expect(PROVIDER_TYPES.has('GenerateVideoNode')).toBe(true)
  })

  it.each([...RUNNER_REPLICATE_VIDEO_MODEL_IDS])('%s: taken only with replicate-video on', (id) => {
    for (const p of id === 'wan-2.5-i2v-fast' ? [withFrame(vid(id))] : [withCard(vid(id)), withFrame(vid(id))]) {
      expect(isRunnerEligible(p, REPLICATE_VIDEO)).toBe(true)
      expect(isRunnerEligible(p, ALL)).toBe(true)
      expect(isRunnerEligible(p)).toBe(false)
      expect(isRunnerEligible(p, NO_FAMILIES)).toBe(false)
      expect(isRunnerEligible(p, OTHERS)).toBe(false)
    }
  })

  it('the legacy label Kling 2.1 is taken as kling-v2.5-turbo-pro', () => {
    expect(isRunnerEligible(withCard(vid('Kling 2.1')), REPLICATE_VIDEO)).toBe(true)
    expect(isRunnerEligible(withCard(vid('Kling 2.1')))).toBe(false)
  })

  it('the fal models are taken as before, with or without the family', () => {
    for (const id of RUNNER_VIDEO_MODEL_IDS) {
      expect(isRunnerEligible(withCard(vid(id))), id).toBe(true)
      expect(isRunnerEligible(withCard(vid(id)), REPLICATE_VIDEO), id).toBe(true)
    }
  })

  const refused: [string, ApiPrompt][] = [
    ['Wan 2.5 I2V Fast with no first frame', withCard(vid('wan-2.5-i2v-fast'))],
    ['sound wired in', { 0: { class_type: 'Image', inputs: { image: 'a.png' } }, 1: vid('kling-v3', { audio: ['0', 0] }) }],
    ['a wired prompt', { 0: { class_type: 'Image', inputs: { image: 'a.png' } }, 1: vid('kling-v3', { prompt: ['0', 0] }) }],
    ['wired model options', { 0: { class_type: 'Image', inputs: { image: 'a.png' } }, 1: vid('kling-v3', { model_options: ['0', 0] }) }],
    ['a first frame from outside the prompt', { 1: vid('kling-v3', { image: ['9', 0] }) }],
    ['an unknown model', withCard(vid('not-a-model'))],
  ]
  it.each(refused)('%s: not taken', (_l, p) => {
    expect(isRunnerEligible(p, REPLICATE_VIDEO)).toBe(false)
    expect(runnerTakesNode(p, '1', REPLICATE_VIDEO)).toBe(false)
  })
})

// ── Price ────────────────────────────────────────────────────────────────

describe('replicate-video price', () => {
  it('every model (and the legacy Kling 2.1) prices above 0 and the money guard lets it through', () => {
    for (const id of [...RUNNER_REPLICATE_VIDEO_MODEL_IDS, 'Kling 2.1']) {
      expect(nodeCredits(vid(id)), id).toBeGreaterThan(0)
      expect(unpricedProviderNode(withCard(vid(id))), id).toBeNull()
    }
    expect(nodeCredits(vid('Kling 2.1'))).toBe(nodeCredits(vid('kling-v2.5-turbo-pro')))
  })
})

// ── Engine: a fal picture through a Gate into a Replicate video ──────────

const start = (k: ReturnType<typeof makeKit>, takes: ApiPrompt[]) =>
  k.engine.startRun({ userId: k.userId, takes, workflow: null, canvasId: null, projectUuid: null, projectName: null })

describe('replicate-video on the engine (hosted, fake fal and Replicate)', () => {
  it('four fal pictures pause at a Gate; Continue with two ticked makes two Replicate videos and charges for two', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => REPLICATE_VIDEO } })
    // A model whose first service is Replicate (Kling 3.0 moved to fal in Task S3).
    const takes = [1, 2, 3, 4].map(s => gatedFlow({ imageSeed: s, videoModel: 'runway-gen-4.5' }))
    const { runId } = await start(k, takes)
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.status).toBe('paused')
    expect(k.fal.submitted().map(r => r.endpoint)).toEqual(Array(4).fill('fal-ai/flux/schnell'))
    expect(k.replicate.client.submit).not.toHaveBeenCalled()

    const next = await k.engine.gateAction({ userId: k.userId, runId, gateId: '2', action: 'continue', takes: [1, 3] })
    expect(next.promptIds).toEqual([`${runId}.1.t1`, `${runId}.1.t3`])
    await k.engine.settled(runId)

    expect(k.fal.submitted()).toHaveLength(4)
    const videos = k.replicate.submitted()
    expect(videos).toHaveLength(2)
    for (const v of videos) {
      expect(v.endpoint).toBe('runwayml/gen-4.5')
      // No motion: runwayml/gen-4.5's schema has none (Task S1b); seed 0 is no seed.
      expect(v.payload).toEqual({
        prompt: 'the fox runs', aspect_ratio: '16:9', duration: 5,
        image: v.payload.image,
      })
      expect(v.payload.image).toMatch(/^https:\/\/fal\.storage\/generate_image_\d{5}_\.png$/)
    }
    expect(new Set(videos.map(v => v.payload.image)).size).toBe(2)

    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    expect(run.takes.map(t => t.nodes['2']!.status)).toEqual(['dropped', 'done', 'dropped', 'done'])
    for (const t of [1, 3]) {
      const v = run.takes[t]!.nodes['3']!
      expect(v.request!.provider).toBe('replicate')
      expect(v.outputs.map(f => f.filename)[0]).toMatch(/^generate_video_\d{5}_\./)
    }
    for (const t of [0, 2]) expect(run.takes[t]!.nodes['3']!.request ?? null).toBeNull()

    // Four pictures (+ the render credit once), then two videos, not four.
    const videoCredits = nodeCredits(takes[0]![3]!)
    expect(videoCredits).toBeGreaterThan(0)
    const holds = [...k.ledger.holds.values()]
    const videoHolds = holds.filter(h => h.key.includes('.1.'))
    expect(videoHolds.map(h => [h.state, h.credits, h.actual])).toEqual([['settled', videoCredits, videoCredits], ['settled', videoCredits, videoCredits]])
    const imageHolds = holds.filter(h => !h.key.includes('.1.'))
    expect(imageHolds.every(h => h.state === 'settled')).toBe(true)
    expect(imageHolds.reduce((n, h) => n + h.actual!, 0)).toBe(4 * nodeCredits(takes[0]![1]!) + BASE_RENDER_CREDITS)
    expect(k.records.write).toHaveBeenCalledTimes(6)
  })

  it('a Replicate video gets the 30-minute limit, not the picture’s 5', async () => {
    let clock = 1_000_000
    const replicate = createFakeReplicate()
    replicate.holdNext(1)
    const orig = replicate.client.status.getMockImplementation()!
    vi.mocked(replicate.client.status).mockImplementation(async (url: string, opts?: { logs?: boolean }) => {
      clock += 4 * 60_000 // four minutes pass between checks
      return orig(url, opts)
    })
    const k = makeKit({ replicate, deps: { families: () => REPLICATE_VIDEO, now: () => clock } })
    // Any Replicate-first video model; Sora (discontinued in H2) is refused before it starts.
    const { runId } = await start(k, [withCard(vid('runway-gen-4.5'))])
    await k.engine.settled(runId)
    const rec = (await k.store.get(runId))!.takes[0]!.nodes['1']!
    expect(rec).toMatchObject({ status: 'error', error: 'The service took more than 30 minutes to make this video, so it was cancelled' })
    // Still asking well past 5 minutes: at 4 minutes a check, 8 checks is 32 minutes.
    expect(vi.mocked(replicate.client.status).mock.calls.length).toBeGreaterThanOrEqual(8)
    expect(replicate.client.cancel).toHaveBeenCalled()
  })

  it('with replicate-video off the server refuses the same workflow', async () => {
    const k = makeKit({ hosted: true, ledger: createFakeLedger() })
    await expect(start(k, [gatedFlow({ videoModel: 'kling-v3' })])).rejects.toMatchObject({ statusCode: 400 })
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
    expect(k.fal.client.submit).not.toHaveBeenCalled()
  })
})
