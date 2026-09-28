/**
 * R3.11: Film a shot's preset path (family `film-shot`) — the node writes its
 * camera phrase from the preset and the overrides (shared/runner/shotPresets.ts,
 * a port of comfy_api_nodes/shot_presets.py) and films it exactly as Generate
 * a video films that model. Measured against the real Python
 * (fixtures/runner-paid-film-shot.json, scripts/runner_paid_fixtures.py
 * --group film-shot): the phrase, and the request, on every case.
 *
 * The shot-directed path (runner-film-shot.unit.spec.ts, Task 4) is not
 * changed; its spec runs as it was.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { makeKit } from './__runner__/kit'
import { normalizeSent, runPaidCase, type PaidCase } from './__runner__/paidParity'
import { expectPythonParity } from './helpers/pythonParity'
import type { ApiPrompt } from '#shared/runner/graph'
import { FAMILY_REQUIRES, RUNNER_FAMILIES, familyOn, parseFamilies, type RunnerFamily } from '#shared/runner/families'
import {
  FILM_SHOT_IMAGE_ONLY_MODELS, FILM_SHOT_MODEL_IDS, isRunnerEligible, isShotDirected, outputKindsFor, runnerTakesNode, valueWiresAllowed,
} from '#shared/runner/eligibility'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import {
  SHOT_AUTO, SHOT_DEFAULT_PRESET_ID, SHOT_OVERRIDE_WIDGETS, SHOT_PRESETS, SHOT_PRESET_IDS, buildShotPhrase, filmShotPrompt,
  resolveShotRecipe, shotDialectForModel, type ShotDialect,
} from '#shared/runner/shotPresets'
import { priceNode } from '#shared/pricing/nodePrice'
import { pyTruthy } from '#shared/runner/pyText'
import { planNode, type NodePlan } from '~~/server/runner/executors'
import { FILM_SHOT_LIP_SYNC_WORDS, FILM_SHOT_NEEDS_FRAME_WORDS, SEEDANCE_TOO_MUCH_VIDEO, SEEDANCE_UNMEASURED_REFERENCE, presetShotProblem, requestProblems } from '~~/server/runner/requestRules'
import { nodeCredits, stageEstimate } from '~~/server/runner/metering'
import { BASE_RENDER_CREDITS } from '~~/server/utils/priceBook'
import { extractGraphPromptTexts } from '~~/server/utils/graphPromptText'
import { runnerReferenceProblems } from '~~/server/utils/graphInputSeconds'
import type { OutputFile } from '~~/server/runner/types'
import { SHOT_REF_CAPS, shotRefSizeProblem, shotRefTooLargeWords } from '~~/server/runner/shotRefs'
import { KLING_LAST_FRAME_NEEDS_FIRST } from '~~/server/runner/generators/twins'

interface PhraseCase { name: string; preset: string; overrides: Record<string, string>; dialect: ShotDialect; recipe_id: string; phrase: string }
interface CallCase {
  name: string
  class_type: 'FilmShotNode'
  widgets: Record<string, unknown>
  pictures: string[]
  phrase: { recipe_id: string; dialect: ShotDialect; phrase: string } | null
  call?: { provider: 'fal' | 'replicate'; endpoint: string; payload: Record<string, unknown> }
  error?: { type: string; message: string }
}
interface Fixture {
  phrases: PhraseCase[]
  dialects: Record<string, ShotDialect>
  model_ids: string[]
  lists: {
    preset_ids: string[]; auto: string; default_preset: string
    overrides: Record<string, string[]>
    presets: Record<string, string>[]
  }
  cases: CallCase[]
  runs: PaidCase[]
}

const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'runner-paid-film-shot.json'), 'utf8')) as Fixture
const CASES = FIXTURE.cases
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const ON: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'film-shot', 'replicate-video'])
const OVERRIDES = ['shot_size', 'camera_angle', 'camera_movement', 'lens_look', 'composition'] as const

const caseNamed = (name: string) => {
  const c = CASES.find(x => x.name === name)
  if (!c) throw new Error(`no case ${name}`)
  return c
}

/** The case's node, with a LoadImage behind `image` when Python had a picture. */
function promptOf(c: { widgets: Record<string, unknown>; pictures?: string[] }, extra: ApiPrompt = {}): ApiPrompt {
  const p: ApiPrompt = { n: { class_type: 'FilmShotNode', inputs: { ...c.widgets } }, ...extra }
  for (const name of c.pictures ?? []) {
    p[`p_${name}`] = { class_type: 'LoadImage', inputs: { image: `${name}.png`, upload: 'image' } }
    p.n!.inputs[name] = [`p_${name}`, 0]
  }
  return p
}

/** The same prompt with a Video card after the shot (Film a shot is not an output node). */
const shown = (c: { widgets: Record<string, unknown>; pictures?: string[] }): ApiPrompt =>
  promptOf(c, { v: { class_type: 'Video', inputs: { file: '', export: false, filename_prefix: 'video/ComfyUI', source: ['n', 0] } } })

type ProviderPlan = Extract<NodePlan, { kind: 'provider' }>

async function planOf(p: ApiPrompt, id = 'n'): Promise<ProviderPlan> {
  const plan = await planNode({
    prompt: p, nodeId: id, gateOpen: false,
    filesFrom: link => [{ filename: `${String(link[0]).slice(2)}.png`, subfolder: '', type: 'input' }],
    toUrl: async (f: OutputFile) => `https://fal.storage/${f.filename}`,
  })
  if (plan.kind !== 'provider') throw new Error(`not a provider plan: ${plan.kind}`)
  return plan
}

/** Python's `model_options` as FilmShotNode reads it: a JSON object, else {}, with `__shot_directed` popped. */
function pythonOptions(raw: unknown): Record<string, unknown> {
  let v: unknown = {}
  try { v = JSON.parse(typeof raw === 'string' && raw ? raw : '{}') }
  catch { v = {} }
  const o = v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {}
  delete o.__shot_directed
  return o
}

/** Whether Python's `bool(advanced.pop("__shot_directed", False))` reads this case as shot-directed. */
function pythonDirected(c: { widgets: Record<string, unknown> }): boolean {
  let raw: unknown
  try { raw = JSON.parse(String(c.widgets.model_options)) }
  catch { return false }
  return !!raw && typeof raw === 'object' && !Array.isArray(raw) && pyTruthy((raw as Record<string, unknown>).__shot_directed)
}

/** The call of the plan that goes where Python's went: its first service, else its backup (Kling 3 and PixVerse v6 go to fal first). */
function matchingCall(plan: ProviderPlan, py: NonNullable<CallCase['call']>) {
  if (plan.provider === py.provider && plan.endpoint === py.endpoint) return { provider: plan.provider, endpoint: plan.endpoint, payload: plan.payload }
  if (plan.backup && plan.backup.provider === py.provider && plan.backup.endpoint === py.endpoint) return plan.backup
  throw new Error(`the plan goes to ${plan.provider} ${plan.endpoint}${plan.backup ? ` (backup ${plan.backup.provider} ${plan.backup.endpoint})` : ''}, Python to ${py.provider} ${py.endpoint}`)
}

describe('the fixture', () => {
  it('covers every preset × three dialects × a blank and a spaced prompt, each override alone and all five, an unknown preset, the options, every model with and without a picture', () => {
    const names = new Set(CASES.map(c => c.name))
    for (const id of SHOT_PRESET_IDS) {
      for (const d of ['veo', 'hailuo', 'standard']) {
        for (const pr of ['blank', 'spaced']) expect(names.has(`${id} · ${d} · ${pr} prompt`), `${id} ${d} ${pr}`).toBe(true)
      }
    }
    for (const o of SHOT_OVERRIDE_WIDGETS) {
      for (const opt of o.options.slice(1)) {
        for (const d of ['veo', 'hailuo', 'standard']) expect(names.has(`${o.widget} ${opt} · ${d}`), `${o.widget} ${opt}`).toBe(true)
      }
    }
    for (const d of ['veo', 'hailuo', 'standard']) {
      expect(names.has(`all five overrides · ${d}`)).toBe(true)
      expect(names.has(`unknown preset · ${d}`)).toBe(true)
    }
    for (const l of ['bad JSON', 'a list', 'shot_directed false']) expect(names.has(`model_options ${l}`), l).toBe(true)
    for (const m of FIXTURE.model_ids) {
      for (const w of ['with', 'without']) expect(names.has(`model ${m} · ${w} image`), `${m} ${w}`).toBe(true)
    }
    expect(CASES.length).toBeGreaterThanOrEqual(330)
    expect(FIXTURE.phrases.length).toBeGreaterThanOrEqual(360)
  })

  it('the presets, the override lists, AUTO, the default and Film a shot\'s model list are Python\'s', () => {
    expect(SHOT_PRESET_IDS).toEqual(FIXTURE.lists.preset_ids)
    expect(SHOT_PRESETS.map(r => ({ ...r }))).toEqual(FIXTURE.lists.presets)
    expect(SHOT_AUTO).toBe(FIXTURE.lists.auto)
    expect(SHOT_DEFAULT_PRESET_ID).toBe(FIXTURE.lists.default_preset)
    expect(Object.fromEntries(SHOT_OVERRIDE_WIDGETS.map(o => [o.widget, [...o.options]]))).toEqual(FIXTURE.lists.overrides)
    expect([...FILM_SHOT_MODEL_IDS].sort()).toEqual([...FIXTURE.model_ids].sort())
    // Python's own refusals: exactly its image-only models (fabric refused first).
    const refusedWithout = CASES.filter(c => c.error && c.name.endsWith('without image')).map(c => String(c.widgets.model)).sort()
    expect(refusedWithout).toEqual([...FILM_SHOT_IMAGE_ONLY_MODELS].sort())
  })
})

describe('the phrase (shot_presets.py)', () => {
  it.each(FIXTURE.phrases.map(p => [`${p.name} · ${p.dialect}`, p] as const))('%s', (_n, p) => {
    const o = { shot_size: SHOT_AUTO, camera_angle: SHOT_AUTO, camera_movement: SHOT_AUTO, lens_look: SHOT_AUTO, composition: SHOT_AUTO, ...p.overrides }
    const recipe = resolveShotRecipe(p.preset, o.shot_size, o.camera_angle, o.camera_movement, o.lens_look, o.composition)
    expect(recipe.id).toBe(p.recipe_id)
    expect(buildShotPhrase(recipe, p.dialect)).toBe(p.phrase)
  })

  it('dialect_for_model', () => {
    for (const [model, d] of Object.entries(FIXTURE.dialects)) expect(shotDialectForModel(model), model).toBe(d)
  })
})

describe('every fixture case: the phrase and the request Python makes', () => {
  const called = CASES.filter(c => c.call && !pythonDirected(c))

  it.each(called.map(c => [c.name, c] as const))('%s', async (_n, c) => {
    const py = c.call!
    // The phrase Python built on this run, and its full_prompt.
    const w = c.widgets
    const recipe = resolveShotRecipe(w.preset, w.shot_size, w.camera_angle, w.camera_movement, w.lens_look, w.composition)
    expect(recipe.id).toBe(c.phrase!.recipe_id)
    expect(shotDialectForModel(w.model)).toBe(c.phrase!.dialect)
    expect(buildShotPhrase(recipe, shotDialectForModel(w.model))).toBe(c.phrase!.phrase)
    const full = filmShotPrompt(w)
    expect(full.startsWith(c.phrase!.phrase)).toBe(true)
    // Taken with film-shot on, under the model's own family; refused of nothing. An unknown
    // preset (Python falls back to the default) is left to the engine: ComfyUI's own validation
    // refuses a value outside the preset list before Python runs.
    const p = promptOf(c)
    expect(runnerTakesNode(p, 'n', ON), 'taken').toBe(SHOT_PRESET_IDS.includes(String(w.preset)))
    expect(presetShotProblem(p.n!.inputs)).toBeNull()
    expect(requestProblems(p, { runner: true })).toEqual([])
    // The request: where Python sends it, the same payload (helpers/pythonParity.ts: the runner
    // follows each service's schema where Python breaks it, as Generate a video does).
    const plan = await planOf(p)
    expect(plan.media).toBe('video')
    expect(plan.prefix).toBe('film_shot')
    expect(plan.uiFor([])).toBeNull()
    const [sent] = normalizeSent([matchingCall(plan, py) as { provider: 'fal' | 'replicate'; endpoint: string; payload: Record<string, unknown> }], c.pictures)
    expectPythonParity(py.provider, py.endpoint, sent!.payload, py.payload, c.name)
    // Whatever the schema lets through, the words sent are Python's full_prompt.
    if (typeof py.payload.prompt === 'string') expect(sent!.payload.prompt).toBe(py.payload.prompt)
    // Exactly Generate a video's request for that model, with that prompt (its backups too).
    const video = promptOf(c)
    video.n = { class_type: 'GenerateVideoNode', inputs: { ...video.n!.inputs, prompt: full, model_options: JSON.stringify(pythonOptions(w.model_options)) } }
    const g = await planOf(video)
    expect({ provider: plan.provider, endpoint: plan.endpoint, payload: plan.payload, backup: plan.backup })
      .toEqual({ provider: g.provider, endpoint: g.endpoint, payload: g.payload, backup: g.backup })
  })

  it('`__shot_directed` as Python\'s bool() reads it (fix round 1): a truthy value other than true sends the words alone in Python, so the runner leaves it to the engine; a falsy one is a preset shot', () => {
    const cases = CASES.filter(c => c.name.startsWith('shot_directed ') && !c.name.includes('unicode blanks'))
    expect(cases.length).toBe(14 * 4 * 2)
    for (const c of cases) {
      const directed = pythonDirected(c)
      const exactlyTrue = JSON.parse(String(c.widgets.model_options)).__shot_directed === true
      const p = promptOf(c)
      if (directed) {
        // Python: the words alone, stripped; no phrase.
        expect(c.call!.payload.prompt ?? c.call!.payload.prompt_text, c.name).toBe('a heron')
        if (!exactlyTrue) {
          expect(runnerTakesNode(p, 'n', ON), c.name).toBe(false)
          expect(runnerTakesNode(p, 'n', new Set<RunnerFamily>(RUNNER_FAMILIES)), c.name).toBe(false)
          expect(nodesNeedingEngine(shown(c), { runnerOn: true, families: ON, titleOf: id => id }), c.name).toContain('n')
        }
        else {
          // Exactly true: the shot-directed path (Task 4), on its own models only.
          expect(runnerTakesNode(p, 'n', ON), c.name).toBe(['seedance-2.0', 'veo-3.1', 'kling-v3'].includes(String(c.widgets.model)))
        }
      }
      else {
        expect(runnerTakesNode(p, 'n', ON), c.name).toBe(true)
        expect(String(c.call!.payload.prompt)).toContain(c.phrase!.phrase)
      }
    }
    // The 32-case probe of the review: 1 and "false", 8 models, with and without a picture.
    for (const model of ['seedance-2.0', 'veo-3.1', 'veo-3.1-fast', 'kling-v3', 'hailuo-h3', 'pixverse-v6', 'wan-2.7-t2v', 'kling-v2.5-turbo-pro']) {
      for (const value of [1, 'false']) {
        for (const pictures of [[], ['image']]) {
          const w = { ...caseNamed('orbit · standard · blank prompt').widgets, model, prompt: 'a heron', model_options: JSON.stringify({ __shot_directed: value }) }
          expect(runnerTakesNode(promptOf({ widgets: w, pictures }), 'n', ON), `${model} ${value}`).toBe(false)
        }
      }
    }
    // Text Python's json reads and JSON.parse doesn't, naming the marker: left to the engine.
    const nan = { ...caseNamed('orbit · standard · blank prompt').widgets, model_options: '{"__shot_directed": NaN}' }
    expect(runnerTakesNode(promptOf({ widgets: nan }), 'n', ON)).toBe(false)
  })

  it.each(CASES.filter(c => c.call && /^shot_directed true /.test(c.name) && ['seedance-2.0', 'veo-3.1', 'kling-v3'].includes(String(c.widgets.model))).map(c => [c.name, c] as const))(
    'shot-directed %s: Python\'s stripped words and request (fix round 2)', async (_n, c) => {
      const plan = await planOf(promptOf(c))
      const py = c.call!
      const [sent] = normalizeSent([matchingCall(plan, py) as { provider: 'fal' | 'replicate'; endpoint: string; payload: Record<string, unknown> }], c.pictures)
      expect(sent!.payload.prompt).toBe(py.payload.prompt)
      expectPythonParity(py.provider, py.endpoint, sent!.payload, py.payload, c.name)
    })

  it('the three Python refusals are refused before the hold, in plain words', () => {
    const refused = CASES.filter(c => c.error)
    expect(refused.map(c => c.name).sort()).toEqual(['model fabric-1.0 · with image', 'model fabric-1.0 · without image', 'model wan-2.5-i2v-fast · without image'])
    for (const c of refused) {
      const p = promptOf(c)
      expect(runnerTakesNode(p, 'n', ON), c.name).toBe(true)
      const want = c.widgets.model === 'fabric-1.0'
        ? { input: 'model', message: FILM_SHOT_LIP_SYNC_WORDS }
        : { input: 'image', message: FILM_SHOT_NEEDS_FRAME_WORDS }
      expect(c.error!.message).toMatch(c.widgets.model === 'fabric-1.0' ? /lip-sync model/ : /requires an input image/)
      expect(requestProblems(p, { runner: true }), c.name).toEqual([{ nodeId: 'n', classType: 'FilmShotNode', ...want }])
    }
    expect(FILM_SHOT_LIP_SYNC_WORDS).toBe('Film a shot can\'t use a lip-sync model. Pick a camera model.')
    expect(FILM_SHOT_NEEDS_FRAME_WORDS).toBe('This model needs a first frame. Connect a picture to Film a shot.')
  })

  it('Seedance reads a first frame given by link in the options, as Python\'s builder does', async () => {
    const c = caseNamed('model_options Seedance first frame by link')
    expect(c.call!.endpoint).toBe('bytedance/seedance-2.0/image-to-video')
    expect(c.call!.payload.image_url).toBe('https://r.test/first.png')
    const plan = await planOf(promptOf(c))
    expect(plan.endpoint).toBe(c.call!.endpoint)
    expect(plan.payload.image_url).toBe('https://r.test/first.png')
  })

  it('a `/view` reference in the options is handed off as the provider\'s link (Python\'s data URL), never sent raw', async () => {
    const w = { ...caseNamed('orbit · standard · spaced prompt').widgets, model_options: JSON.stringify({ image_url: '/view?filename=first.png&type=input' }) }
    const plan = await planOf(promptOf({ widgets: w }))
    expect(plan.endpoint).toBe('bytedance/seedance-2.0/image-to-video')
    expect(plan.payload.image_url).toBe('https://fal.storage/first.png')
    // One that names no safe file is refused before the hold.
    const bad = { ...w, model_options: JSON.stringify({ image_urls: ['/view?filename=../x&type=input'] }) }
    expect(requestProblems(promptOf({ widgets: bad }), { runner: true }).map(p => [p.classType, p.input])).toEqual([['FilmShotNode', 'model_options']])
  })
})

describe('the runner\'s own checks are Generate a video\'s (on a runner run)', () => {
  it('Seedance: a first frame beside references is refused, labelled Film a shot', () => {
    const w = { ...caseNamed('orbit · standard · blank prompt').widgets, model_options: JSON.stringify({ image_urls: ['https://x/a.png'] }) }
    const p = requestProblems(promptOf({ widgets: w, pictures: ['image'] }), { runner: true })
    expect(p).toHaveLength(1)
    expect(p[0]).toMatchObject({ nodeId: 'n', classType: 'FilmShotNode', input: 'model_options' })
  })

  it('Hailuo H3: judged on the full prompt (the phrase is never empty), not on the blank words', () => {
    const c = caseNamed('push-in · hailuo · blank prompt')
    expect(requestProblems(promptOf(c), { runner: true })).toEqual([])
    const video = promptOf(c)
    video.n = { class_type: 'GenerateVideoNode', inputs: { ...video.n!.inputs } }
    // Generate a video with the same blank words is refused: the phrase is what makes the shot's prompt.
    expect(requestProblems(video, { runner: true }).length).toBeGreaterThan(0)
  })

  it('Seedance reference sounds and videos are measured for a preset shot too (the runner\'s check)', async () => {
    const w = { ...caseNamed('orbit · standard · blank prompt').widgets, model_options: JSON.stringify({ video_urls: ['/view?filename=a.mp4&type=input'] }) }
    const owned = vi.fn(async () => {})
    const opts = { readFile: async () => { throw new Error('unreadable') }, assertOwned: owned }
    // Its reference file is checked as the caller's own, and hosted refuses one it can't measure.
    expect(await runnerReferenceProblems([promptOf({ widgets: w })], { ...opts, strict: true }))
      .toMatchObject({ nodeId: 'n', classType: 'FilmShotNode', message: SEEDANCE_UNMEASURED_REFERENCE })
    expect(owned).toHaveBeenCalledWith([{ filename: 'a.mp4', subfolder: '', type: 'input' }])
    // Local: an unmeasured one is let through; a long one would be refused (SEEDANCE_TOO_MUCH_VIDEO).
    expect(await runnerReferenceProblems([promptOf({ widgets: w })], { ...opts, strict: false })).toBeNull()
    expect(SEEDANCE_TOO_MUCH_VIDEO).toMatch(/15 s/)
  })
})

describe('the engine: sent, saved and charged (cards, film-shot and replicate-video on)', () => {
  it.each(FIXTURE.runs.map(c => [c.name, c] as const))('%s', async (_n, c) => {
    // The engine sends the plan's first call: Python's call, or for PixVerse v6 (fal first) the
    // fal request whose backup is Python's (Generate a video's routes), answered in fal's shape.
    const plan = await planOf(promptOf(c))
    const answered = plan.provider === c.calls[0]!.provider ? c : { ...c, answers: [{ video: { url: (c.answers[0] as { output: string }).output } }] }
    const run = await runPaidCase(answered, { families: ON })
    expect(run.status, run.error ?? '').toBe('done')
    expect(run.sent).toHaveLength(1)
    const [sent] = normalizeSent(run.sent, c.pictures ?? [])
    const [first] = normalizeSent([{ provider: plan.provider as 'fal' | 'replicate', endpoint: plan.endpoint, payload: plan.payload }], c.pictures ?? [])
    expect(sent).toEqual(first)
    const py = c.calls[0]!
    const [asPython] = normalizeSent([matchingCall(plan, py) as { provider: 'fal' | 'replicate'; endpoint: string; payload: Record<string, unknown> }], c.pictures ?? [])
    expectPythonParity(py.provider, py.endpoint, asPython!.payload, py.payload, c.name)
    expect(asPython!.payload.prompt).toBe(py.payload.prompt)
    // Charged the model's price (FilmShotNode is model-priced, nodePrice.ts), unchanged by R3.11.
    const price = priceNode('FilmShotNode', c.widgets)
    if ('refused' in price) throw new Error(price.refused)
    expect(run.credits).toBe(price.credits)
    expect(run.files).toHaveLength(1)
    expect(run.files[0]!.filename).toMatch(/^film_shot_\d+_\.mp4$/)
  })

  it('hosted: held at the model\'s price before the call, charged the same', async () => {
    const c = FIXTURE.runs.find(r => r.name === 'veo text')!
    const p = shown(c)
    const hold = stageEstimate(p, Object.keys(p), true, ON)
    const price = priceNode('FilmShotNode', c.widgets)
    if ('refused' in price) throw new Error(price.refused)
    // The model's price, plus the stage's base credit, as every provider stage.
    expect(hold).toBe(price.credits + BASE_RENDER_CREDITS)
    expect(nodeCredits(p.n!, undefined, ON)).toBe(price.credits)
    const k = makeKit({ hosted: true, available: 50_000, deps: { families: () => ON } })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.takes[0]!.nodes.n!.status).toBe('done')
    expect([...k.ledger.holds.values()].map(h => [h.credits, h.actual])).toEqual([[hold, hold]])
    expect(k.fal.submitted()[0]!.payload.prompt).toBe(c.calls[0]!.payload.prompt)
  })

  it.each([
    ['fabric', 'model fabric-1.0 · with image', FILM_SHOT_LIP_SYNC_WORDS],
    ['a picture-only model with no picture', 'model wan-2.5-i2v-fast · without image', FILM_SHOT_NEEDS_FRAME_WORDS],
  ] as const)('%s: refused before the hold, nothing sent', async (_n, name, words) => {
    const c = caseNamed(name)
    const k = makeKit({ hosted: true, available: 50_000, deps: { families: () => ON } })
    for (const pic of c.pictures) writeFileSync(join(k.root, 'input', `${pic}.png`), await sharp({ create: { width: 4, height: 4, channels: 3, background: '#336699' } }).png().toBuffer())
    await expect(k.engine.startRun({ userId: k.userId, takes: [shown(c)], ...START })).rejects.toThrow(words)
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.fal.client.submit).not.toHaveBeenCalled()
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
  })
})

describe('a discontinued model', () => {
  it('is refused at the start, as on Generate a video', async () => {
    const c = caseNamed('model sora-2 · without image')
    const k = makeKit({ hosted: true, available: 50_000, deps: { families: () => ON } })
    await expect(k.engine.startRun({ userId: k.userId, takes: [shown(c)], ...START })).rejects.toThrow(/discontinued/)
    expect(k.ledger.hold).not.toHaveBeenCalled()
  })
})

describe('moderation (G3): the words the user typed; the phrase is Sailor\'s own', () => {
  it('the typed prompt is read at the start; a flagged one is refused before the hold', async () => {
    const c = caseNamed('push-in · veo · spaced prompt')
    const p = shown(c)
    p.n!.inputs.prompt = 'a forbidden thing'
    expect(extractGraphPromptTexts(p)).toEqual(['a forbidden thing'])
    const moderate = vi.fn(async (t: string) => (t.includes('forbidden') ? { ok: false as const, categories: ['violence'] } : { ok: true as const }))
    const k = makeKit({ hosted: true, available: 50_000, moderate, deps: { families: () => ON } })
    await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START })).rejects.toThrow()
    expect(moderate.mock.calls.map(x => x[0])).toContain('a forbidden thing')
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.fal.client.submit).not.toHaveBeenCalled()
  })

  it('a wired prompt leaves the shot to the engine (the words must be typed to be moderated and phrased)', () => {
    const c = caseNamed('push-in · veo · spaced prompt')
    const p = shown(c)
    p.t = { class_type: 'Text', inputs: { text: 'a heron' } }
    p.n!.inputs.prompt = ['t', 0]
    expect(runnerTakesNode(p, 'n', ON)).toBe(false)
  })
})

describe('what the runner takes', () => {
  const base = caseNamed('crane-reveal · standard · spaced prompt')

  it('a preset or override outside Python\'s lists, a wired setting or a legacy model name stays with the engine', () => {
    const takes = (inputs: Record<string, unknown>, extra: ApiPrompt = {}) => runnerTakesNode(promptOf({ widgets: { ...base.widgets, ...inputs } }, extra), 'n', ON)
    expect(takes({})).toBe(true)
    expect(takes({ preset: 'slow_push_in' })).toBe(false)
    expect(takes({ camera_movement: 'the camera spins' })).toBe(false)
    expect(takes({ shot_size: SHOT_AUTO, camera_angle: 'a high angle' })).toBe(true)
    const pr: ApiPrompt = { x: { class_type: 'PrimitiveString', inputs: { value: 'push-in' } } }
    for (const k of ['preset', 'camera_movement', 'model_options', 'model', 'audio']) expect(takes({ [k]: ['x', 0] }, pr), k).toBe(false)
    expect(takes({ model: 'Veo 3' })).toBe(false)
    expect(takes({ model: 'veo-3.1-lite' })).toBe(false)
    // Override widgets absent (an older saved node): AUTO, as Python's defaults.
    const old = { ...base.widgets }
    for (const o of OVERRIDES) delete old[o]
    expect(runnerTakesNode(promptOf({ widgets: old }), 'n', ON)).toBe(true)
    expect(filmShotPrompt(old)).toBe(filmShotPrompt(base.widgets))
  })

  it('each model under its own family too: the replicate-video models need replicate-video', () => {
    const p = (model: string) => promptOf({ widgets: { ...base.widgets, model } })
    const noReplicate = new Set<RunnerFamily>(['cards', 'film-shot'])
    for (const m of ['veo-3.1', 'veo-3.1-fast', 'flux-3', 'seedance-2.0', 'hailuo-h3', 'hailuo-h3-max']) expect(runnerTakesNode(p(m), 'n', noReplicate), m).toBe(true)
    for (const m of ['sora-2', 'kling-v3', 'pixverse-v6', 'kling-v2.5-turbo-pro']) {
      expect(runnerTakesNode(p(m), 'n', noReplicate), m).toBe(false)
      expect(runnerTakesNode(p(m), 'n', ON), m).toBe(true)
    }
  })

  it('shows on a Video card; the take is eligible', () => {
    expect(isRunnerEligible(shown(base), ON)).toBe(true)
  })

  it('a shot-directed shot keeps its own path with film-shot on: Shot Director\'s words, sent as typed', async () => {
    const w = { ...base.widgets, model: 'seedance-2.0', prompt: 'Reva walks through the rain', model_options: JSON.stringify({ __shot_directed: true }) }
    expect(isShotDirected(w)).toBe(true)
    const plan = await planOf(promptOf({ widgets: w }))
    expect(plan.payload.prompt).toBe('Reva walks through the rain')
    expect(runnerTakesNode(promptOf({ widgets: w }), 'n')).toBe(true)
  })
})

describe('with film-shot off (rule 15)', () => {
  const OFF_SETS: [string, RunnerFamily[]][] = [
    ['none', []],
    ['cards only', ['cards']],
    ['cards and replicate-video', ['cards', 'replicate-video']],
    ['every family but film-shot', RUNNER_FAMILIES.filter(f => f !== 'film-shot')],
  ]
  /** The prompt as it was before R3.11: a preset shot was never taken (renamed to a class nothing takes). */
  const before = (p: ApiPrompt): ApiPrompt => Object.fromEntries(Object.entries(p).map(([id, n]) =>
    [id, n.class_type === 'FilmShotNode' && !isShotDirected(n.inputs ?? {}) ? { ...n, class_type: 'FilmShotNodeBefore' } : n]))

  function sameAsBefore(p: ApiPrompt, label: string) {
    const old = before(p)
    for (const [name, fam] of OFF_SETS) {
      const families = new Set(fam)
      const titleOf = (id: string) => id
      expect(nodesNeedingEngine(p, { runnerOn: true, families, titleOf }), `${label}, ${name}`).toEqual(nodesNeedingEngine(old, { runnerOn: true, families, titleOf }))
      expect(isRunnerEligible(p, families), `${label}, ${name}`).toBe(isRunnerEligible(old, families))
      for (const id of Object.keys(p)) {
        expect(runnerTakesNode(p, id, families), `${label} ${id}, ${name}`).toBe(runnerTakesNode(old, id, families))
        expect(valueWiresAllowed(p, id, outputKindsFor(families), families), `${label} ${id}, ${name}`).toBe(valueWiresAllowed(old, id, outputKindsFor(families), families))
      }
    }
  }

  it('a preset shot is left to the engine and named by the needs-the-engine list', () => {
    for (const c of [caseNamed('push-in · veo · blank prompt'), caseNamed('model sora-2 · with image')]) {
      const p = shown(c)
      for (const [name, fam] of OFF_SETS) {
        expect(runnerTakesNode(p, 'n', new Set(fam)), name).toBe(false)
        expect(nodesNeedingEngine(p, { runnerOn: true, families: new Set(fam), titleOf: id => id }), name).toContain('n')
      }
      expect(runnerTakesNode(p, 'n', ON)).toBe(true)
    }
  })

  it('film-shot needs cards', () => {
    expect(FAMILY_REQUIRES['film-shot']).toBe('cards')
    expect(familyOn('film-shot', new Set<RunnerFamily>(['film-shot']))).toBe(false)
    expect(parseFamilies('film-shot').has('film-shot')).toBe(false)
    expect(parseFamilies('cards,film-shot').has('film-shot')).toBe(true)
    expect(runnerTakesNode(shown(caseNamed('push-in · veo · blank prompt')), 'n', new Set<RunnerFamily>(['film-shot']))).toBe(false)
  })

  it('over synthetic chains: alone, with a picture, on a Video card, beside a shot-directed shot', () => {
    for (const c of [caseNamed('push-in · veo · blank prompt'), caseNamed('model kling-v3 · with image'), caseNamed('model wan-2.5-i2v-fast · without image')]) {
      sameAsBefore(promptOf(c), `${c.name} alone`)
      sameAsBefore(shown(c), `${c.name} → Video card`)
      const directed = { class_type: 'FilmShotNode', inputs: { ...c.widgets, model: 'seedance-2.0', model_options: '{"__shot_directed": true}' } }
      sameAsBefore({ ...shown(c), d: directed }, `${c.name} + a shot-directed shot`)
    }
  })

  const PROJECTS = resolve(__dirname, '../../../user/sailor/projects')
  const projectsIt = existsSync(PROJECTS) ? it : it.skip

  projectsIt('over every saved project graph (with a preset shot → Video card spliced in beside each)', async () => {
    const { gunzipSync } = await import('node:zlib')
    const { graphToPrompt } = await import('~/lib/graph/graphToPrompt')
    const catalog = JSON.parse(gunzipSync(readFileSync(resolve(__dirname, '../../server/native/objectInfo.baseline.json.gz'))).toString('utf8'))
    const extra = shown(caseNamed('model kling-v3 · with image'))
    const spliced = Object.fromEntries(Object.entries(extra).map(([id, n]) => [`f_${id}`, { ...n, inputs: Object.fromEntries(Object.entries(n.inputs).map(([k, v]) => [k, Array.isArray(v) && v.length === 2 ? [`f_${String(v[0])}`, v[1]] : v])) }])) as ApiPrompt
    let graphs = 0
    let shots = 0
    for (const uuid of readdirSync(PROJECTS).sort()) {
      let wf: { canvases?: { workflow: unknown }[] } | undefined
      try { wf = JSON.parse(readFileSync(join(PROJECTS, uuid, 'versions', 'current.json'), 'utf8')).workflow }
      catch { continue }
      for (const cv of wf?.canvases ?? []) {
        let p: ApiPrompt
        try { p = graphToPrompt(cv.workflow as never, catalog) }
        catch { continue }
        graphs++
        shots += Object.values(p).filter(n => n.class_type === 'FilmShotNode').length
        sameAsBefore(p, uuid)
        sameAsBefore({ ...p, ...spliced }, `${uuid} + preset shot`)
      }
    }
    expect(graphs).toBeGreaterThanOrEqual(800)
    console.info(`film-shot families-off invariant: ${graphs} saved graphs, ${shots} Film a shot nodes`)
  }, 600_000)
})

describe('fix round 1: reference sizes and Kling 3\'s last frame, before the hold', () => {
  const view = (n: string) => `/view?filename=${n}&type=input`
  const shot = (model: string, adv: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({ widgets: { ...caseNamed('orbit · standard · blank prompt').widgets, model, prompt: 'a heron', model_options: JSON.stringify(adv), ...extra } })
  const sizes = (m: Record<string, number>) => async (f: OutputFile) => m[f.filename] ?? null

  it('a `/view` reference over its service\'s stated cap is refused in plain words (raw bytes, no JPEG fallback)', async () => {
    const MB = 1_000_000
    const check = (model: string, adv: Record<string, unknown>, m: Record<string, number>, backups = false) =>
      shotRefSizeProblem(promptOf(shot(model, adv)), backups, sizes(m))
    // Seedance 2.0: 30 MB a picture, 15 MB a sound, 50 MB of video in all.
    expect(await check('seedance-2.0', { image_urls: [view('a.png')] }, { 'a.png': 30 * MB })).toBeNull()
    expect(await check('seedance-2.0', { image_urls: [view('a.png')] }, { 'a.png': 30 * MB + 1 }))
      .toEqual({ nodeId: 'n', classType: 'FilmShotNode', input: 'model_options', message: 'This picture is too large for Seedance 2.0. Use a smaller picture.' })
    expect((await check('seedance-2.0', { image_url: view('a.png') }, { 'a.png': 31 * MB }))?.message).toBe(shotRefTooLargeWords('picture', 'Seedance 2.0'))
    expect((await check('seedance-2.0', { audio_urls: [view('s.wav')] }, { 's.wav': 16 * MB }))?.message).toBe('This reference sound is too large for Seedance 2.0. Use a smaller sound.')
    expect(await check('seedance-2.0', { video_urls: [view('a.mp4'), view('b.mp4')] }, { 'a.mp4': 25 * MB, 'b.mp4': 25 * MB })).toBeNull()
    expect((await check('seedance-2.0', { video_urls: [view('a.mp4'), view('b.mp4')] }, { 'a.mp4': 25 * MB, 'b.mp4': 25 * MB + 1 }))?.message)
      .toBe('These reference videos are too large together for Seedance 2.0. Use shorter or smaller videos.')
    // Kling 3.0: 50 MiB on fal (frames and characters' pictures); 10 MB for its Replicate backup's frames while backups run, with no characters.
    const el = { frontal_image_url: view('face.png'), reference_image_urls: [view('body.png')] }
    expect(await check('kling-v3', { image_url: view('a.png'), elements: [el] }, { 'a.png': 11 * MB, 'body.png': 52_428_800 }, true)).toBeNull()
    expect((await check('kling-v3', { image_url: view('a.png'), elements: [el] }, { 'body.png': 52_428_801 }))?.message).toBe('This picture is too large for Kling 3.0. Use a smaller picture.')
    expect(await check('kling-v3', { end_image_url: view('a.png') }, { 'a.png': 11 * MB })).toBeNull()
    expect(await check('kling-v3', { end_image_url: view('a.png') }, { 'a.png': 11 * MB }, true)).not.toBeNull()
    // A web link, a size the store can't tell, a model with no stated cap: left to the service.
    expect(await check('seedance-2.0', { image_urls: ['https://x.test/a.png', view('b.png')] }, {})).toBeNull()
    expect(await check('veo-3.1', { image_urls: [view('a.png')] }, { 'a.png': 90 * MB })).toBeNull()
    // Every cap cites its saved schema.
    for (const c of Object.values(SHOT_REF_CAPS)) for (const f of Object.values(c.fields)) expect(f.source).toMatch(/schema/)
  })

  it('the engine refuses an oversized reference at the start, before the hold, nothing sent', async () => {
    const k = makeKit({ hosted: true, available: 50_000, deps: { families: () => ON } })
    writeFileSync(join(k.root, 'input', 'big.png'), Buffer.alloc(30_000_001))
    const c = shot('seedance-2.0', { image_urls: [view('big.png')] })
    await expect(k.engine.startRun({ userId: k.userId, takes: [shown(c)], ...START })).rejects.toThrow('This picture is too large for Seedance 2.0. Use a smaller picture.')
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.fal.client.submit).not.toHaveBeenCalled()
  })

  it('Kling 3: a last frame beside only an `image_url` (its builder reads the linked picture alone) is refused before the hold', async () => {
    const adv = { image_url: 'https://x.test/a.png', end_image_url: 'https://x.test/b.png' }
    const video = { n: { class_type: 'GenerateVideoNode', inputs: { ...shot('kling-v3', adv).widgets } }, v: shown(shot('kling-v3', adv)).v! }
    for (const [label, p] of [['a preset shot', shown(shot('kling-v3', adv))], ['Generate a video', video]] as const) {
      expect(requestProblems(p, { runner: true }).map(x => x.message), label).toEqual([KLING_LAST_FRAME_NEEDS_FIRST])
      const k = makeKit({ hosted: true, available: 50_000, deps: { families: () => ON } })
      await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START }), label).rejects.toThrow(KLING_LAST_FRAME_NEEDS_FIRST)
      expect(k.ledger.hold, label).not.toHaveBeenCalled()
    }
    // With the picture linked, taken; a shot-directed shot's `image_url` is its first frame.
    expect(requestProblems(promptOf({ ...shot('kling-v3', adv), pictures: ['image'] }), { runner: true })).toEqual([])
    expect(requestProblems(promptOf(shot('kling-v3', { ...adv, __shot_directed: true })), { runner: true })).toEqual([])
  })
})
