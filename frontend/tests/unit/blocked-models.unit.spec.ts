/**
 * Refusing models a run can't use where it is going (model line-up, Task H1):
 * `blockedModelUses` (shared/runner/blockedModels.ts) and its three callers —
 * the browser before any /prompt, the server before pricing and any hold,
 * the runner before any hold — plus: a saved graph using each flag still prices.
 *
 * Each test flags the entries it needs itself and puts them back afterwards,
 * on top of the catalogue's own flags (Task H2). The real line-up — Sora
 * refused by all three checks, hidden models still running and pricing — is
 * tested in model-lineup-h2.unit.spec.ts.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiPrompt } from '#shared/runner/graph'
import { blockedModelUses, blockedModelRefusal, serviceDate, SWITCH_OFF_REASON } from '../../shared/runner/blockedModels'
import { __resetModelMenusForTests } from '../../shared/runner/modelMenus'
import { NO_FAMILIES, type ModelFlags, type RunnerFamily } from '../../shared/runner/families'
import { IMAGE_MODELS_BY_ID } from '../../app/data/image-models'
import { VIDEO_MODELS_BY_ID } from '../../app/data/video-models'
import { EDIT_MODEL_MENUS } from '../../app/data/edit-model-options'
import { blockedPromptBody, blockedRunRefusal, needsEngineDescription } from '../../app/lib/runner/needsEngine'
import { blockedPromptRefusal } from '../../server/utils/blockedModels'
import { meterGraphSubmit } from '../../server/utils/meterGraphRun'
import { priceGraph } from '../../server/utils/priceBook'
import { makeKit } from './__runner__/kit'

const undo: (() => void)[] = []
function flag(target: ModelFlags, flags: ModelFlags) {
  const before = { ...target }
  Object.assign(target, flags)
  undo.push(() => {
    for (const k of ['hidden', 'discontinued', 'runnerOnly', 'family'] as const) delete target[k]
    Object.assign(target, before)
  })
  __resetModelMenusForTests()
}
function editOption(key: string, value: string): ModelFlags {
  return EDIT_MODEL_MENUS[key]!.options.find(x => x.value === value)!
}
afterEach(() => {
  while (undo.length) undo.pop()!()
  __resetModelMenusForTests()
  vi.unstubAllEnvs()
})
const fams = (...f: RunnerFamily[]) => new Set<RunnerFamily>(f)

const img = (model: string) => ({ class_type: 'GenerateImageNode', inputs: { model, prompt: 'a fox', aspect_ratio: '1:1', seed: 0, model_options: '{}' } })
const vid = (model: string) => ({ class_type: 'GenerateVideoNode', inputs: { model, prompt: 'a fox', aspect_ratio: '16:9', duration: '5', seed: 0, model_options: '{}' } })
const card = (from: string) => ({ class_type: 'Image', inputs: { image: '', export: false, images: [from, 0], batch_index: -1 } })
const titles: Record<string, string> = { 1: 'Hero shot', 2: 'Result', 3: 'Old sampler' }
const titleOf = (id: string) => titles[id] ?? 'Unnamed node'

// --------------------------------------------------------------- the check

describe('blockedModelUses', () => {
  it('a runner-only model with its family off is blocked on ComfyUI and on the runner', () => {
    flag(IMAGE_MODELS_BY_ID['flux-schnell']!, { runnerOnly: true, family: 'replicate-image' })
    const p: ApiPrompt = { 1: img('flux-schnell'), 2: card('1') }
    const use = { nodeId: '1', classType: 'GenerateImageNode', value: 'flux-schnell', reason: 'runner-only' }
    expect(blockedModelUses(p)).toEqual([use])
    expect(blockedModelUses(p, { families: NO_FAMILIES, runnerTakes: true })).toEqual([use])
    // Switched on: the runner may take it; ComfyUI still can't run it.
    expect(blockedModelUses(p, { families: fams('replicate-image'), runnerTakes: true })).toEqual([])
    expect(blockedModelUses(p, { families: fams('replicate-image') })).toEqual([use])
    expect(blockedModelUses({ 1: img('flux-2-pro') })).toEqual([])
  })

  it('a plain dropdown value too, and a runner-only model on a class the runner does not take is never taken', () => {
    flag(editOption('EditImageNode.model', 'Flux 2 Pro'), { runnerOnly: true, family: 'fal-edit' })
    const edit: ApiPrompt = { 1: { class_type: 'EditImageNode', inputs: { model: 'Flux 2 Pro', input_image: ['9', 0] } } }
    expect(blockedModelUses(edit).map(u => u.reason)).toEqual(['runner-only'])
    expect(blockedModelUses(edit, { families: fams('fal-edit'), runnerTakes: true })).toEqual([])
    flag(VIDEO_MODELS_BY_ID['veo-3.1-fast']!, { runnerOnly: true, family: 'replicate-video' })
    const shot: ApiPrompt = { 1: { class_type: 'FilmShotNode', inputs: { model: 'veo-3.1-fast' } } }
    expect(blockedModelUses(shot, { families: fams('replicate-video'), runnerTakes: true }).map(u => u.reason)).toEqual(['runner-only'])
  })

  it('a discontinued model is blocked everywhere, the runner included', () => {
    flag(VIDEO_MODELS_BY_ID['sora-2']!, { discontinued: '2026-09-24' })
    const p: ApiPrompt = { 1: vid('sora-2'), 2: card('1') }
    const use = { nodeId: '1', classType: 'GenerateVideoNode', value: 'sora-2', reason: 'discontinued' }
    expect(blockedModelUses(p)).toEqual([use])
    expect(blockedModelUses(p, { families: fams('replicate-video'), runnerTakes: true })).toEqual([use])
    // Hidden alone is not blocked: it still runs.
    flag(VIDEO_MODELS_BY_ID['veo-3.1']!, { hidden: true })
    expect(blockedModelUses({ 1: vid('veo-3.1') })).toEqual([])
  })

  it('a legacy name that remaps to a discontinued id is blocked, and keeps its saved value', () => {
    flag(VIDEO_MODELS_BY_ID['veo-3.1']!, { discontinued: '2026-09-24' })
    const p: ApiPrompt = { 1: vid('Veo 3') }
    expect(blockedModelUses(p)).toEqual([{ nodeId: '1', classType: 'GenerateVideoNode', value: 'Veo 3', reason: 'discontinued' }])
    expect(blockedModelRefusal(blockedModelUses(p)[0]!, { title: 'Trailer' }).title).toBe('Veo 3.1 was discontinued by its service on 24 Sep 2026')
  })

  it('a wired model input or an unknown value is never blocked', () => {
    expect(blockedModelUses({ 1: { class_type: 'GenerateImageNode', inputs: { model: ['5', 0] } } })).toEqual([])
    expect(blockedModelUses({ 1: img('not-a-model') })).toEqual([])
    expect(serviceDate('2026-09-24')).toBe('24 Sep 2026')
  })
})

// --------------------------------------------------------------- the browser

describe('browser: refused before any /prompt', () => {
  it('discontinued: the plain message, naming the node', () => {
    flag(VIDEO_MODELS_BY_ID['sora-2']!, { discontinued: '2026-09-24' })
    const r = blockedRunRefusal([{ prompt: { 1: vid('sora-2'), 2: card('1') }, titleOf }], { runnerOn: true, families: fams('replicate-video') })
    expect(r).toEqual({
      title: 'Sora 2 was discontinued by its service on 24 Sep 2026',
      description: 'Pick another model in “Hero shot”, such as Hailuo H3 Max.',
    })
  })

  it('runner-only with its switch off', () => {
    flag(IMAGE_MODELS_BY_ID['flux-schnell']!, { runnerOnly: true, family: 'replicate-image' })
    const takes = [{ prompt: { 1: img('flux-schnell'), 2: card('1') }, titleOf }]
    const r = { title: `“Hero shot” uses ${IMAGE_MODELS_BY_ID['flux-schnell']!.label}, which only runs in Sailor`, description: SWITCH_OFF_REASON }
    expect(blockedRunRefusal(takes, { runnerOn: true, families: NO_FAMILIES })).toEqual(r)
    // The runner itself off counts as every switch off.
    expect(blockedRunRefusal(takes, { runnerOn: false, families: fams('replicate-image') })).toEqual(r)
    expect(SWITCH_OFF_REASON).toBe('Its switch is off.')
  })

  it('runner-only with an engine-only node beside it: the reason names that node', () => {
    flag(IMAGE_MODELS_BY_ID['flux-schnell']!, { runnerOnly: true, family: 'replicate-image' })
    const prompt: ApiPrompt = { 1: img('flux-schnell'), 2: card('1'), 3: { class_type: 'KSampler', inputs: { seed: 1 } } }
    const r = blockedRunRefusal([{ prompt, titleOf }], { runnerOn: true, families: fams('replicate-image') })
    expect(r).toEqual({
      title: `“Hero shot” uses ${IMAGE_MODELS_BY_ID['flux-schnell']!.label}, which only runs in Sailor`,
      description: needsEngineDescription(['Old sampler']),
    })
    expect(r!.description).toBe('Only the engine can run “Old sampler”.')
  })

  it('a run with nothing blocked goes on; every take is checked', () => {
    flag(VIDEO_MODELS_BY_ID['sora-2']!, { discontinued: '2026-09-24' })
    expect(blockedRunRefusal([{ prompt: { 1: vid('veo-3.1') }, titleOf }], { runnerOn: false })).toBeNull()
    expect(blockedRunRefusal([{ prompt: { 1: vid('veo-3.1') }, titleOf }, { prompt: { 1: vid('sora-2') }, titleOf }], { runnerOn: false })).not.toBeNull()
  })

  it('runVueWorkflow checks after the runner declined or was skipped, and returns before any /prompt', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../app/layouts/default.vue'), 'utf8')
    const start = src.indexOf('async function runVueWorkflowBody(') // LC8 (B5): runVueWorkflow wraps this body
    const body = src.slice(start, src.indexOf('\n}\n', start))
    const runner = body.indexOf('sentToRunner = true')
    const check = body.indexOf('blockedRunRefusal(')
    const refuse = body.indexOf('return false', check)
    const queues = [...body.matchAll(/direct\.queue\(/g)].map(m => m.index!)
    expect(queues).toHaveLength(2)
    expect(runner).toBeGreaterThan(0)
    expect(check).toBeGreaterThan(runner)
    expect(body.slice(check - 60, check)).toContain('sentToRunner ? null :')
    for (const q of queues) {
      expect(q).toBeGreaterThan(refuse)
    }
    expect(body.slice(check, refuse)).toContain('toast.error(blocked.title, { description: blocked.description })')
  })
})

// --------------------------------------------------------------- the server

function deps() {
  return {
    priceGraph: vi.fn(() => ({ credits: 5, version: 'test', breakdown: [] })),
    spendGuard: vi.fn(async () => {}),
    validateFileRefs: vi.fn(async () => {}),
    moderatePrompt: vi.fn(async () => ({ ok: true as const })),
    hold: vi.fn(async () => ({ ok: true as const, holdId: 7 })),
    getAvailable: vi.fn(async () => 3),
    forward: vi.fn(async () => ({ status: 200, body: { prompt_id: 'p1', number: 1, node_errors: {} } })),
    registerRun: vi.fn(async () => {}),
    startSettle: vi.fn(),
    releaseHold: vi.fn(async () => {}),
  }
}

describe('server: refused before pricing and any hold', () => {
  it('meterGraphSubmit answers ComfyUI\'s 400 shape, takes no hold and never forwards', async () => {
    flag(VIDEO_MODELS_BY_ID['sora-2']!, { discontinued: '2026-09-24' })
    const d = deps()
    const r = await meterGraphSubmit('u1', { prompt: { 4: vid('sora-2'), 5: card('4') } }, d as any)
    expect(r.status).toBe(400)
    expect(r.body).toEqual({
      error: {
        type: 'value_not_in_list',
        message: 'Sora 2 was discontinued by its service on 24 Sep 2026. Pick another model in “Generate a video”, such as Hailuo H3 Max.',
        details: 'Pick another model in “Generate a video”, such as Hailuo H3 Max.',
        extra_info: {},
      },
      node_errors: {
        4: {
          errors: [{
            type: 'value_not_in_list',
            message: 'Sora 2 was discontinued by its service on 24 Sep 2026.',
            details: 'Pick another model in “Generate a video”, such as Hailuo H3 Max.',
            extra_info: { input_name: 'model', input_value: 'sora-2' },
          }],
          dependent_outputs: [],
          class_type: 'GenerateVideoNode',
        },
      },
    })
    expect(d.priceGraph).not.toHaveBeenCalled()
    expect(d.hold).not.toHaveBeenCalled()
    expect(d.forward).not.toHaveBeenCalled()
    expect(d.registerRun).not.toHaveBeenCalled()
  })

  it('a runner-only model: the reason follows the server\'s own switch', async () => {
    flag(IMAGE_MODELS_BY_ID['flux-schnell']!, { runnerOnly: true, family: 'replicate-image' })
    const label = IMAGE_MODELS_BY_ID['flux-schnell']!.label
    const prompt = { 1: { ...img('flux-schnell'), _meta: { title: 'Hero shot' } }, 2: card('1'), 3: { class_type: 'KSampler', inputs: {} } }
    const off = blockedPromptRefusal(prompt)!
    expect(off.error.message).toBe(`“Hero shot” uses ${label}, which only runs in Sailor. Its switch is off.`)
    vi.stubEnv('NUXT_RUNNER_ENABLED', 'true')
    vi.stubEnv('NUXT_RUNNER_FAMILIES', 'replicate-image')
    const on = blockedPromptRefusal(prompt)!
    expect(on.error.message).toBe(`“Hero shot” uses ${label}, which only runs in Sailor. Only the engine can run “Unnamed node”.`)
    // Nothing blocked: the meter goes on as before.
    const d = deps()
    const ok = await meterGraphSubmit('u1', { prompt: { 1: img('flux-2-pro'), 2: card('1') } }, d as any)
    expect(ok.status).toBe(200)
    expect(d.hold).toHaveBeenCalledTimes(1)
    expect(blockedPromptBody({ 1: img('flux-2-pro') })).toBeNull()
  })
})

// --------------------------------------------------------------- the runner

describe('runner: a discontinued model is refused before any hold', () => {
  const start = (k: ReturnType<typeof makeKit>, takes: ApiPrompt[]) =>
    k.engine.startRun({ userId: k.userId, takes, workflow: null, canvasId: null, projectUuid: null, projectName: null })

  it('refused with the same words; nothing held, created or sent', async () => {
    flag(IMAGE_MODELS_BY_ID['nano-banana-2']!, { discontinued: '2026-09-24' })
    const k = makeKit({ hosted: true })
    await expect(start(k, [{ 1: img('nano-banana-2'), 2: card('1') }])).rejects.toMatchObject({
      statusCode: 400,
      message: 'Nano Banana 2 was discontinued by its service on 24 Sep 2026. Pick another model in “Generate an image”, such as Flux 2 Pro.',
    })
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.graphRuns.create).not.toHaveBeenCalled()
    expect(k.fal.client.submit).not.toHaveBeenCalled()
  })

  it('a hidden model still runs on the runner', async () => {
    flag(IMAGE_MODELS_BY_ID['nano-banana-2']!, { hidden: true })
    const k = makeKit({ hosted: true })
    const { runId } = await start(k, [{ 1: img('nano-banana-2'), 2: card('1') }])
    await k.engine.settled(runId)
    expect(k.ledger.hold).toHaveBeenCalledTimes(1)
  })
})

// --------------------------------------------------------------- prices

describe('a saved graph using each flag still prices', () => {
  it('hidden, discontinued and runner-only price exactly as before', () => {
    const graphs: ApiPrompt[] = [
      { 1: img('flux-pro'), 2: card('1') },
      { 1: vid('sora-2'), 2: card('1') },
      { 1: img('flux-schnell'), 2: card('1') },
      { 1: vid('Veo 3'), 2: card('1') },
      { 1: { class_type: 'EditImageNode', inputs: { model: 'Flux Kontext Pro', input_image: ['9', 0] } } },
    ]
    const before = graphs.map(g => priceGraph(g))
    flag(IMAGE_MODELS_BY_ID['flux-pro']!, { hidden: true })
    flag(VIDEO_MODELS_BY_ID['sora-2']!, { discontinued: '2026-09-24' })
    flag(IMAGE_MODELS_BY_ID['flux-schnell']!, { runnerOnly: true, family: 'replicate-image' })
    flag(VIDEO_MODELS_BY_ID['veo-3.1']!, { hidden: true })
    flag(editOption('EditImageNode.model', 'Flux Kontext Pro'), { hidden: true })
    graphs.forEach((g, i) => {
      const p = priceGraph(g)
      expect(p.credits, JSON.stringify(g)).toBeGreaterThan(0)
      expect(p).toEqual(before[i])
    })
  })
})
