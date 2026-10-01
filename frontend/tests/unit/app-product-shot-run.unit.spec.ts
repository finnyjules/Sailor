/**
 * Step 3, R8.1: Product shot on the runner (lib/runner/productShotApp.ts,
 * used by components/apps/ProductShotApp.vue).
 *
 * - The four workflows (background, cut-out, relight, relight with the
 *   product kept exact) are runner-eligible with their families on, in both
 *   places, and left as before with them off.
 * - Fake runner events: each step's picture comes from its Save image by node
 *   id; the price shows before the run; Stop; a refusal; a decline (hosted:
 *   switched off; this computer: the engine as before, ruling (d)); a "no" at
 *   the cost gate.
 * - Through the kit (fake fal, Replicate and ledger; ComfyUI off), hosted:
 *   the three steps run one after another; each result lands (the backdrop,
 *   the cut-out with its alpha, the shot); each quote equals its hold.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { describe, expect, it, vi } from 'vitest'
import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import { isRunnerEligible } from '#shared/runner/eligibility'
import { RUNNER_NOT_ELIGIBLE } from '#shared/runner/messages'
import { useAppRun, type AppQuote, type AppRunDeps } from '~/composables/useAppRun'
import {
  PRODUCT_SHOT_SAVE, PRODUCT_SHOT_WORDS, buildBackgroundPrompt, buildBlendPrompt, buildCutoutPrompt, runOnEngine, useProductShotStep,
  type ProductShotStep, type StepResult,
} from '~/lib/runner/productShotApp'
import { mapWsEvent } from '~/lib/graph/wsEventMap'
import { createFakeReplicate, makeKit } from './__runner__/kit'

const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const ALL_ON: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'bg-remove', 'fal-edit', 'nano-actions'])

const BG = buildBackgroundPrompt({ prompt: 'clean white marble countertop', aspect: '1:1', seed: 3 })
const CUT = buildCutoutPrompt('product.png')
const RELIGHT = (model: 'Flux 2 Pro' | 'Nano Banana') => buildBlendPrompt({ composite: 'composite.png', mask: null, model, prompt: 'relight', feather: 4, seed: 9 })
const KEEP = buildBlendPrompt({ composite: 'composite.png', mask: 'mask.png', model: 'Nano Banana', prompt: 'relight', feather: 4, seed: 9 })

function fakeWindow() {
  const handlers = new Set<(e: MessageEvent) => void>()
  return {
    addEventListener: (_: string, h: any) => handlers.add(h),
    removeEventListener: (_: string, h: any) => handlers.delete(h),
    post: (data: Record<string, unknown>) => handlers.forEach(h => h({ data: { type: 'sailor-bridge', ...data } } as MessageEvent)),
    size: () => handlers.size,
  }
}

const file = (filename: string) => ({ filename, subfolder: 'user_1', type: 'output' })

function fakeDeps(o: Partial<AppRunDeps> = {}) {
  return {
    confirm: vi.fn(async () => true),
    postQuote: vi.fn(async (): Promise<AppQuote> => ({ usd: 0.045, credits: 9, upTo: false })),
    start: vi.fn(async () => ({ runId: 'run_1', legId: 'run_1.0', promptIds: ['run_1.0'] })),
    stop: vi.fn(async () => {}),
    ensureEvents: vi.fn(async () => {}),
    ...o,
  }
}

function setup(step: ProductShotStep, o: { hosted?: boolean, deps?: Partial<AppRunDeps>, engine?: (p: ApiPrompt, id: string) => Promise<StepResult> } = {}) {
  const deps = fakeDeps(o.deps)
  const hosted = o.hosted ?? false
  const w = fakeWindow()
  const engine = vi.fn(o.engine ?? (async (): Promise<StepResult> => ({ promptId: 'p1', image: file('engine.png') })))
  const app = useAppRun({ hosted, debounceMs: 0, deps })
  const s = useProductShotStep(step, { hosted, app, engine, wait: { target: w } })
  return { deps, w, engine, s }
}

describe('the prompts', () => {
  it('are the app\'s workflows, each saving its picture at a fixed node', () => {
    expect(BG[PRODUCT_SHOT_SAVE.background]!.class_type).toBe('SaveImage')
    expect(BG['1']).toEqual({ class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'clean white marble countertop', aspect_ratio: '1:1', seed: 3, model_options: '{}' } })
    // Ruling (a): Background remove, see-through, no soft edge, then Save image.
    expect(CUT['2']).toEqual({ class_type: 'BackgroundRemove', inputs: { frames: ['1', 0], output: 'transparent', edge_softness: 0 } })
    expect(CUT[PRODUCT_SHOT_SAVE.cutout]!.inputs.images).toEqual(['2', 0])
    expect(RELIGHT('Nano Banana')['4']!.inputs.model).toBe('Nano Banana')
    expect(RELIGHT('Flux 2 Pro')['4']!.inputs.keep_subject).toBeUndefined()
    // Keeping the product exact: Kontext, the mask's red channel into keep_subject.
    expect(KEEP['4']!.inputs).toMatchObject({ model: 'Flux Kontext Pro', keep_subject: ['3', 0], keep_feather: 4 })
    expect(KEEP['3']).toEqual({ class_type: 'ImageToMask', inputs: { image: ['2', 0], channel: 'red' } })
    expect(KEEP[PRODUCT_SHOT_SAVE.shot]!.inputs.images).toEqual(['4', 0])
  })

  it('are runner-eligible with their families on in both places, and left as before with them off', () => {
    const cases: [ApiPrompt, RunnerFamily[]][] = [
      [BG, ['cards']],
      [CUT, ['cards', 'bg-remove']],
      [RELIGHT('Flux 2 Pro'), ['cards', 'fal-edit']],
      [RELIGHT('Nano Banana'), ['cards', 'nano-actions']],
      [KEEP, ['cards', 'fal-edit']],
    ]
    for (const [p, fams] of cases) {
      for (const hosted of [true, false]) {
        expect(isRunnerEligible(p, new Set(fams), { hosted })).toBe(true)
        expect(isRunnerEligible(p, ALL_ON, { hosted })).toBe(true)
        expect(isRunnerEligible(p, new Set<RunnerFamily>(), { hosted })).toBe(false)
        // Each family it needs, off: left as before.
        for (const f of fams) expect(isRunnerEligible(p, new Set(fams.filter(x => x !== f)), { hosted }), `${f} off`).toBe(false)
      }
    }
  })
})

describe('a step, fed fake runner events', () => {
  it('the price shows before the run; the picture comes from the step\'s Save image, by node id', async () => {
    const { deps, w, s } = setup('shot')
    await s.quote(KEEP)
    expect(deps.postQuote).toHaveBeenCalledWith({ takes: [KEEP] }, expect.any(AbortSignal))
    expect(s.priceText.value).toBe('$0.04')
    expect(s.canRun.value).toBe(true)
    const done = s.run(KEEP)
    await vi.waitFor(() => expect(deps.start).toHaveBeenCalled())
    expect(deps.start).toHaveBeenCalledWith(expect.objectContaining({ takes: [KEEP], canvasId: null }))
    expect(deps.confirm).toHaveBeenCalledWith(expect.objectContaining({ usd: 0.045 }))
    expect(s.canStop.value).toBe(true)
    // Blend's own file comes first: the step takes Save image's.
    w.post({ event: 'executed', prompt_id: 'run_1.0', node_id: '4', output: { images: [file('blend_scene_00001_.png')] } })
    w.post({ event: 'executed', prompt_id: 'run_1.0', node_id: PRODUCT_SHOT_SAVE.shot, output: { images: [file('product_shot_00001_.png')] } })
    expect(await done).toEqual({ promptId: 'run_1.0', image: file('product_shot_00001_.png') })
    expect(s.running.value).toBe(false)
    expect(w.size()).toBe(0)
  })

  it('in hosted the price is in credits', async () => {
    const { s } = setup('background', { hosted: true })
    await s.quote(BG)
    expect(s.priceText.value).toBe('9 cr')
  })

  it('the cut-out has no price before a product is dropped, and still prices its exact prompt before it runs', async () => {
    const { deps, w, s } = setup('cutout')
    expect(s.priceText.value).toBeNull()
    expect(s.canRun.value).toBe(true)
    const done = s.run(CUT)
    await vi.waitFor(() => expect(deps.start).toHaveBeenCalled())
    expect(deps.postQuote).toHaveBeenCalledWith({ takes: [CUT] }, undefined)
    expect(deps.confirm).toHaveBeenCalled()
    expect(s.priceText.value).toBe('$0.04')
    w.post({ event: 'executed', prompt_id: 'run_1.0', node_id: PRODUCT_SHOT_SAVE.cutout, output: { images: [file('product_cutout_00001_.png')] } })
    expect((await done)!.image.filename).toBe('product_cutout_00001_.png')
  })

  it('Stop ends this run: no picture, nothing left listening', async () => {
    const { deps, w, s } = setup('background')
    await s.quote(BG)
    const done = s.run(BG)
    await vi.waitFor(() => expect(deps.start).toHaveBeenCalled())
    await vi.waitFor(() => expect(s.canStop.value).toBe(true))
    await new Promise(r => setTimeout(r, 0))
    await s.stop()
    expect(deps.stop).toHaveBeenCalledWith(['run_1'])
    w.post({ event: 'execution_complete', prompt_id: 'run_1.0', stopped: true })
    expect(await done).toBeNull()
    expect(s.running.value).toBe(false)
    expect(w.size()).toBe(0)
  })

  it('a refusal shows its words in place of the price, and the button stays off', async () => {
    const words = 'This picture is larger than 4096 × 4096, too large to keep its subject exact'
    const { s, deps } = setup('shot', { hosted: true, deps: { postQuote: vi.fn(async (): Promise<AppQuote> => ({ refused: words })) } })
    await s.quote(KEEP)
    expect(s.blocked.value).toBe(words)
    expect(s.priceText.value).toBeNull()
    expect(s.canRun.value).toBe(false)
    expect(deps.start).not.toHaveBeenCalled()
  })

  it('a run error comes in the step\'s own words', async () => {
    const { deps, w, s } = setup('shot')
    await s.quote(RELIGHT('Flux 2 Pro'))
    const done = s.run(RELIGHT('Flux 2 Pro'))
    await vi.waitFor(() => expect(deps.start).toHaveBeenCalled())
    w.post({ event: 'execution_error', prompt_id: 'run_1.0', node_id: '4', exception_message: 'boom' })
    await expect(done).rejects.toThrow()
    expect(s.running.value).toBe(false)
  })

  it('a "no" at the cost gate starts nothing', async () => {
    const { deps, s } = setup('shot', { deps: { confirm: vi.fn(async () => false) } })
    await s.quote(RELIGHT('Nano Banana'))
    expect(await s.run(RELIGHT('Nano Banana'))).toBeNull()
    expect(deps.start).not.toHaveBeenCalled()
  })

  it('hosted, a decline says the app is switched off; nothing is sent', async () => {
    const { s, deps, engine } = setup('cutout', { hosted: true, deps: { postQuote: vi.fn(async (): Promise<AppQuote> => ({ declined: true })) } })
    await s.quote(CUT)
    expect(s.blocked.value).toBe('This app is switched off right now.')
    expect(s.canRun.value).toBe(false)
    await expect(s.run(CUT)).rejects.toThrow('This app is switched off right now.')
    expect(deps.start).not.toHaveBeenCalled()
    expect(engine).not.toHaveBeenCalled()
  })

  it('this computer, a decline (at the quote or at the start) sends the step to the engine, with no price and no Stop', async () => {
    const a = setup('background', { deps: { postQuote: vi.fn(async (): Promise<AppQuote> => ({ declined: true })) } })
    await a.s.quote(BG)
    expect(a.s.blocked.value).toBeNull()
    expect(a.s.priceText.value).toBeNull()
    expect(await a.s.run(BG)).toEqual({ promptId: 'p1', image: file('engine.png') })
    expect(a.engine).toHaveBeenCalledWith(BG, PRODUCT_SHOT_SAVE.background)
    expect(a.deps.start).not.toHaveBeenCalled()

    const declined = Object.assign(new Error('x'), { data: { data: { reason: RUNNER_NOT_ELIGIBLE } } })
    const b = setup('shot', { deps: { start: vi.fn(async () => { throw declined }) } })
    await b.s.quote(KEEP)
    expect(await b.s.run(KEEP)).toEqual({ promptId: 'p1', image: file('engine.png') })
    expect(b.engine).toHaveBeenCalledWith(KEEP, PRODUCT_SHOT_SAVE.shot)
  })
})

describe('the engine stop-gap (this computer only)', () => {
  it('takes the picture by node id; its errors never name the engine', async () => {
    const history = { p1: { status: { status_str: 'success', completed: true }, outputs: { 4: { images: [file('blend.png')] }, 5: { images: [file('shot.png')] } } } }
    const f = vi.fn(async (url: string) => ({ ok: true, json: async () => (url === '/prompt' ? { prompt_id: 'p1' } : history) })) as unknown as typeof fetch
    expect(await runOnEngine(KEEP, PRODUCT_SHOT_SAVE.shot, PRODUCT_SHOT_WORDS.shot, { fetch: f, sleep: async () => {} })).toEqual({ promptId: 'p1', image: file('shot.png') })
    const down = vi.fn(async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    await expect(runOnEngine(KEEP, '5', PRODUCT_SHOT_WORDS.shot, { fetch: down })).rejects.toThrow(PRODUCT_SHOT_WORDS.noStart)
    const bad = vi.fn(async (url: string) => ({ ok: true, json: async () => (url === '/prompt' ? { prompt_id: 'p1' } : { p1: { status: { status_str: 'error' } } }) })) as unknown as typeof fetch
    await expect(runOnEngine(KEEP, '5', PRODUCT_SHOT_WORDS.shot, { fetch: bad, sleep: async () => {} })).rejects.toThrow(PRODUCT_SHOT_WORDS.shot.failed)
    const words = [PRODUCT_SHOT_WORDS.noStart, ...(['background', 'cutout', 'shot'] as const).flatMap(k => Object.values(PRODUCT_SHOT_WORDS[k]))]
    for (const w of words) expect(w).not.toMatch(/comfy|8188|isnet|replicate|token|model/i)
  })
})

// ── Through the kit: ComfyUI off ─────────────────────────────────────────────

const CUTOUT = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/runner-paid-local-cutout.json'), 'utf8')) as { cases: { name: string; pictures: string[]; answers: string[] }[] }
const cut = CUTOUT.cases.find(c => c.name === 'cutout · soft alpha · transparent · edge 0')!
const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))
const CUT_URL = 'https://replicate.delivery/cut.png'

async function rgbPng(w: number, h: number, r: number, g: number, b: number): Promise<Uint8Array> {
  return new Uint8Array(await sharp({ create: { width: w, height: h, channels: 3, background: { r, g, b } } }).png().toBuffer())
}

async function kitApp() {
  const replicate = createFakeReplicate({ answer: () => CUT_URL })
  const picture = await rgbPng(48, 40, 30, 120, 200)
  const k = makeKit({
    hosted: true,
    replicate,
    deps: {
      families: () => ALL_ON,
      download: async (url: string) => (url === CUT_URL ? { bytes: b64(cut.answers[0]!), contentType: 'image/png' } : { bytes: picture, contentType: 'image/png' }),
    },
  })
  const files: Record<string, Uint8Array> = {
    'product.png': b64(cut.pictures[0]!),
    'composite.png': await rgbPng(48, 40, 200, 180, 160),
    'mask.png': await rgbPng(48, 40, 178, 178, 178),
  }
  mkdirSync(join(k.root, 'input', 'user_1'), { recursive: true })
  for (const [n, b] of Object.entries(files)) {
    writeFileSync(join(k.root, 'input', n), b)
    writeFileSync(join(k.root, 'input', 'user_1', n), b)
  }
  const w = fakeWindow()
  k.deps.events.subscribe(k.userId!, (m) => {
    const e = mapWsEvent(m as { type: string, data: any }, 'browser')
    if (e) w.post(e as unknown as Record<string, unknown>)
  })
  const started: string[] = []
  const deps: Partial<AppRunDeps> = {
    confirm: vi.fn(async () => true),
    postQuote: async body => k.engine.quoteRun({ userId: k.userId, takes: body.takes, ...START }),
    start: async (body) => {
      const leg = await k.engine.startRun({ userId: k.userId, ...body })
      started.push(leg.runId)
      return leg
    },
    stop: async ids => { await k.engine.stop(k.userId, ids) },
    ensureEvents: async () => {},
  }
  const step = (s: ProductShotStep) => useProductShotStep(s, {
    hosted: true, app: useAppRun({ hosted: true, debounceMs: 0, deps }), wait: { target: w },
    engine: async () => { throw new Error('the engine must not be used') },
  })
  return { k, replicate, step, started }
}

describe('through the kit (ComfyUI off, hosted): the app\'s three steps', () => {
  it('background, cut-out and the kept-exact shot each land; each quote equals its hold; charged no more than held', async () => {
    const { k, replicate, step, started } = await kitApp()
    const quoted: number[] = []
    const results: StepResult[] = []
    const steps: [ProductShotStep, ApiPrompt][] = [['background', BG], ['cutout', CUT], ['shot', buildBlendPrompt({ composite: 'composite.png', mask: 'mask.png', model: 'Flux 2 Pro', prompt: 'relight', feather: 2, seed: 9 })]]
    for (const [name, prompt] of steps) {
      const s = step(name)
      await s.quote(prompt)
      expect(s.priceText.value, name).toMatch(/^\d+ cr$/)
      quoted.push(Number(/(\d+) cr/.exec(s.priceText.value!)![1]))
      const r = await s.run(prompt)
      expect(r, name).not.toBeNull()
      results.push(r!)
    }
    expect(started).toHaveLength(3)
    expect(replicate.submitted()).toHaveLength(1)
    expect(k.fal.submitted()).toHaveLength(2)
    expect(k.fal.submitted()[1]!.endpoint).toMatch(/kontext/)
    // Each result is its Save image's file.
    expect(results[0]!.image.filename).toMatch(/^product_bg_\d{5}_\.png$/)
    expect(results[1]!.image.filename).toMatch(/^product_cutout_\d{5}_\.png$/)
    expect(results[2]!.image.filename).toMatch(/^product_shot_\d{5}_\.png$/)
    // The cut-out keeps its alpha.
    const c = results[1]!.image
    const meta = await sharp(join(k.root, c.type, c.subfolder, c.filename)).metadata()
    expect(meta.channels).toBe(4)
    for (const runId of started) {
      await k.engine.settled(runId)
      const take = (await k.store.get(runId))!.takes[0]!
      for (const [id, rec] of Object.entries(take.nodes)) expect(rec.status, `${id}: ${rec.error ?? ''}`).toBe('done')
    }
    const holds = [...k.ledger.holds.values()]
    expect(holds.map(h => h.credits)).toEqual(quoted)
    expect(holds.every(h => h.actual !== null && h.actual <= h.credits)).toBe(true)
  }, 120_000)
})
