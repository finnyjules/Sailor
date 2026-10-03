/**
 * Sailor's own model menus (model line-up, Task H1): the overlay laid over
 * every `/object_info` body Sailor serves (shared/runner/modelMenus.ts
 * `applyModelOverlay`), and the gallery filter.
 *
 * These tests check the mechanism, not the line-up: before each one the
 * catalogue's own flags (set by Task H2) are cleared and the preference lists
 * put back to Python's defaults, then each test flags entries itself. All of
 * it is put back afterwards. The real line-up is tested in
 * model-lineup-h2.unit.spec.ts.
 *
 * `fetch` is stubbed in every source test, so nothing here reaches a real engine.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const engineHealthState = vi.hoisted(() => ({ value: 'up' as 'up' | 'down' }))
vi.mock('../../server/native/engineHealth', async orig => ({
  ...(await orig() as object),
  engineHealth: async () => engineHealthState.value,
}))

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { createApp, eventHandler, toWebHandler } from 'h3'
import { __setInputUploadsDbForTests, __setInputUploadsEngineRootForTests } from '../../server/utils/inputUploads'
import { nativeEngineRoute } from '../../server/native/router'
import {
  __objectInfoSaveSettledForTests,
  __setObjectInfoBaselineFileForTests,
  __setObjectInfoCacheFileForTests,
} from '../../server/native/objectInfo'
import { handleHostedObjectInfo } from '../../server/utils/engineGate'
import {
  __resetModelMenusForTests, applyModelOverlay, comboMenu, galleryEntries, menuDefault, modelMenu,
} from '../../shared/runner/modelMenus'
import { NO_FAMILIES, type ModelFlags, type RunnerFamily } from '../../shared/runner/families'
import { IMAGE_MODELS, IMAGE_MODELS_BY_ID, IMAGE_MODEL_PREFERENCE } from '../../app/data/image-models'
import { FILM_SHOT_MODEL_PREFERENCE, VIDEO_MODELS, VIDEO_MODELS_BY_ID, VIDEO_MODEL_PREFERENCE } from '../../app/data/video-models'
import { EDIT_MODEL_MENUS } from '../../app/data/edit-model-options'

/**
 * The runner-only dropdown values (GPT Image 2.5 and Seedream 5 Pro in Edit an image, Tasks F2 and F9;
 * Nano Banana 2 in Blend scene, Task F11):
 * no Python list has them, so the overlay adds them after Python's values.
 * Read at import, before the tests clear the flags.
 */
const RUNNER_ONLY_VALUES: Readonly<Record<string, string[]>> = Object.fromEntries(
  Object.entries(EDIT_MODEL_MENUS).map(([key, menu]) => [key.split('.')[0]!, menu.options.filter(o => o.runnerOnly).map(o => o.value)]),
)
const runnerOnlyValues = (cls: string) => RUNNER_ONLY_VALUES[cls] ?? []

// ------------------------------------------------------------- flag helpers

const undo: (() => void)[] = []

function flag(target: ModelFlags, flags: ModelFlags) {
  const before = { ...target }
  Object.assign(target, flags)
  undo.push(() => {
    for (const k of ['hidden', 'discontinued', 'unpriced', 'runnerOnly', 'family'] as const) delete target[k]
    Object.assign(target, before)
  })
  __resetModelMenusForTests()
}

function prefer(list: readonly string[], values: string[]) {
  const arr = list as string[]
  const before = [...arr]
  arr.splice(0, arr.length, ...values)
  undo.push(() => arr.splice(0, arr.length, ...before))
  __resetModelMenusForTests()
}

function editOption(key: string, value: string): ModelFlags {
  const o = EDIT_MODEL_MENUS[key]!.options.find(x => x.value === value)
  if (!o) throw new Error(`no ${key} option ${value}`)
  return o
}

/** Clears one entry's flags (put back afterwards). */
function unflag(target: ModelFlags) {
  const keys = (['hidden', 'discontinued', 'unpriced', 'runnerOnly', 'family'] as const).filter(k => k in target)
  if (!keys.length) return
  const before = { ...target }
  for (const k of keys) delete target[k]
  undo.push(() => Object.assign(target, before))
}

/** The catalogue as H1 left it: no flags, Python's defaults first. */
function flagFreeCatalogue() {
  for (const m of [...IMAGE_MODELS, ...VIDEO_MODELS]) unflag(m)
  for (const menu of Object.values(EDIT_MODEL_MENUS)) for (const o of menu.options) unflag(o)
  prefer(IMAGE_MODEL_PREFERENCE, ['flux-2-pro'])
  prefer(VIDEO_MODEL_PREFERENCE, ['veo-3.1'])
  prefer(FILM_SHOT_MODEL_PREFERENCE, ['kling-v2.5-turbo-pro'])
  prefer(EDIT_MODEL_MENUS['BlendSceneNode.model']!.preference, ['Flux Kontext Pro'])
  __resetModelMenusForTests()
}

beforeEach(() => flagFreeCatalogue())

afterEach(() => {
  while (undo.length) undo.pop()!()
  __resetModelMenusForTests()
})

const fams = (...f: RunnerFamily[]) => new Set<RunnerFamily>(f)

// ----------------------------------------------------------- the fixture

/** The committed baseline's own node definitions for the classes the overlay covers: an engine body. */
function engineFixture(extra: readonly string[] = []): Record<string, any> {
  const baseline = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '../../server/native/objectInfo.baseline.json.gz'))).toString('utf8'))
  const out: Record<string, any> = {}
  for (const k of ['GenerateImageNode', 'GenerateVideoNode', 'FilmShotNode', 'EditImageNode', 'BlendSceneNode', 'RestyleFromImageNode', 'GenerateFromReferencesNode', 'UpscaleImageNode', 'KSampler', ...extra]) {
    if (baseline[k]) out[k] = baseline[k]
  }
  // One covered class in ComfyUI's legacy shape too: [[...options], {config}].
  out.UpscaleImageNode.input.required.model = [['Clarity', 'Crystal', 'Real-ESRGAN', 'Recraft Crisp', 'Topaz'], { default: 'Clarity' }]
  return out
}

const spec = (body: any, cls: string, input = 'model') => body[cls].input.required[input]
const cfg = (body: any, cls: string, input = 'model') => {
  const s = spec(body, cls, input)
  return Array.isArray(s[0]) ? s[1] : s[1]
}
const opts = (body: any, cls: string, input = 'model') => {
  const s = spec(body, cls, input)
  return Array.isArray(s[0]) ? s[0] : s[1].options
}

/** The flags every overlay test below uses. */
function flagScenario() {
  flag(editOption('EditImageNode.model', 'Flux Kontext Pro'), { hidden: true })
  flag(editOption('EditImageNode.model', 'Flux 2 Pro'), { runnerOnly: true, family: 'fal-edit' })
  prefer(EDIT_MODEL_MENUS['EditImageNode.model']!.preference, ['Flux 2 Pro', 'Nano Banana 2'])
  flag(editOption('UpscaleImageNode.model', 'Real-ESRGAN'), { hidden: true })
  flag(IMAGE_MODELS_BY_ID['flux-schnell']!, { runnerOnly: true, family: 'replicate-image' })
  prefer(IMAGE_MODEL_PREFERENCE, ['flux-schnell', 'flux-2-pro'])
  flag(VIDEO_MODELS_BY_ID['veo-3.1-fast']!, { runnerOnly: true, family: 'replicate-video' })
  prefer(VIDEO_MODEL_PREFERENCE, ['veo-3.1-fast', 'veo-3.1'])
  prefer(FILM_SHOT_MODEL_PREFERENCE, ['veo-3.1-fast', 'kling-v2.5-turbo-pro'])
  flag(VIDEO_MODELS_BY_ID['sora-2']!, { discontinued: '2026-09-24' })
}

/** What the overlay must give for the fixture, families off / on. */
function expectOverlaid(body: any, on: boolean) {
  const fixture = engineFixture()
  // Options kept, every one: hidden and runner-only values stay valid.
  expect(opts(body, 'EditImageNode')).toEqual(['Nano Banana 2', 'Flux Kontext Pro', 'Flux 2 Pro', 'GPT Image 2.5', 'Seedream 5 Pro'])
  expect(cfg(body, 'EditImageNode').hidden_options).toEqual(on ? ['Flux Kontext Pro'] : ['Flux Kontext Pro', 'Flux 2 Pro'])
  expect(cfg(body, 'EditImageNode').default).toBe(on ? 'Flux 2 Pro' : 'Nano Banana 2')
  // Legacy shape, same rules.
  expect(spec(body, 'UpscaleImageNode')).toEqual([
    ['Clarity', 'Crystal', 'Real-ESRGAN', 'Recraft Crisp', 'Topaz'],
    { default: 'Clarity', hidden_options: ['Real-ESRGAN'] },
  ])
  // An untouched dropdown still gets an (empty) hidden list and its default.
  expect(cfg(body, 'BlendSceneNode')).toMatchObject({ default: 'Flux Kontext Pro', hidden_options: [] })
  expect(opts(body, 'BlendSceneNode')).toEqual([...opts(fixture, 'BlendSceneNode'), ...runnerOnlyValues('BlendSceneNode')])
  // Galleries: the default only; the engine's list and everything else are as they were.
  expect(cfg(body, 'GenerateImageNode').default).toBe(on ? 'flux-schnell' : 'flux-2-pro')
  expect(cfg(body, 'GenerateVideoNode').default).toBe(on ? 'veo-3.1-fast' : 'veo-3.1')
  // Film a shot: the runner doesn't take it, so a runner-only model is never its default.
  expect(cfg(body, 'FilmShotNode').default).toBe('kling-v2.5-turbo-pro')
  for (const cls of ['GenerateImageNode', 'GenerateVideoNode', 'FilmShotNode']) {
    expect(opts(body, cls), cls).toEqual(opts(fixture, cls))
    expect(cfg(body, cls).hidden_options, cls).toBeUndefined()
    expect(cfg(body, cls).sailor_widget, cls).toBe(cfg(fixture, cls).sailor_widget)
  }
  expect(body.KSampler).toEqual(fixture.KSampler)
}

// ------------------------------------------------------------ pure overlay

describe('applyModelOverlay', () => {
  it('keeps every option, lists the hidden ones, and picks the default by the preference list', () => {
    flagScenario()
    expectOverlaid(applyModelOverlay(engineFixture(), NO_FAMILIES), false)
  })

  it('the default moves when a family switches on, and back when it switches off', () => {
    flagScenario()
    expectOverlaid(applyModelOverlay(engineFixture(), fams('fal-edit', 'replicate-image', 'replicate-video')), true)
    expectOverlaid(applyModelOverlay(engineFixture(), NO_FAMILIES), false)
  })

  it('never changes the body it is given (copy on write), and leaves a body without covered classes as it is', () => {
    flagScenario()
    const body = engineFixture()
    const before = JSON.stringify(body)
    applyModelOverlay(body, fams('fal-edit'))
    expect(JSON.stringify(body)).toBe(before)
    const other = { KSampler: body.KSampler }
    expect(applyModelOverlay(other, NO_FAMILIES)).toBe(other)
  })

  it('with no flags (today\'s catalogue) the overlay changes no option or default', () => {
    const fixture = engineFixture()
    const out = applyModelOverlay(fixture, NO_FAMILIES)
    for (const cls of Object.keys(fixture).filter(k => k !== 'KSampler')) {
      // Only the runner-only values Python doesn't list are added, after its own.
      expect(opts(out, cls), cls).toEqual([...opts(fixture, cls), ...runnerOnlyValues(cls)])
      expect(cfg(out, cls).default, cls).toBe(cfg(fixture, cls).default)
      if (modelMenu(cls)?.kind === 'dropdown') expect(cfg(out, cls).hidden_options, cls).toEqual([])
    }
  })

  it('the dropdown lists match the Python lists exactly (plus the runner-only values, last), and a value only the engine lists is kept', () => {
    // + Lip-sync a character's engine (Task F22): its sync-3 is runner-only.
    // + Think step by step (LC1): Python's own default is DeepSeek R1, which the menu hides while its provider fails.
    const fixture = engineFixture(['LipSyncNode', 'ReasonStepByStepNode'])
    expect(RUNNER_ONLY_VALUES.EditImageNode).toEqual(['GPT Image 2.5', 'Seedream 5 Pro'])
    expect(RUNNER_ONLY_VALUES.BlendSceneNode).toEqual(['Nano Banana 2'])
    expect(RUNNER_ONLY_VALUES.LipSyncNode).toEqual(['sync-3'])
    for (const [key, menu] of Object.entries(EDIT_MODEL_MENUS)) {
      const [cls, input] = key.split('.') as [string, string]
      expect(menu.options.map(o => o.value), key).toEqual([...opts(fixture, cls, input), ...runnerOnlyValues(cls)])
      // Think step by step defaults to GPT-5, not Python's DeepSeek R1 (hidden, never removed).
      expect(menu.preference[0], key).toBe(key === 'ReasonStepByStepNode.model' ? 'GPT-5' : cfg(fixture, cls, input).default)
    }
    fixture.EditImageNode.input.required.model[1].options.push('Engine Only')
    expect(opts(applyModelOverlay(fixture, NO_FAMILIES), 'EditImageNode')).toEqual(['Nano Banana 2', 'Flux Kontext Pro', 'Flux 2 Pro', 'GPT Image 2.5', 'Seedream 5 Pro', 'Engine Only'])
  })

  it('the default falls back to the first runnable value when no preference can run', () => {
    flag(editOption('BlendSceneNode.model', 'Flux Kontext Pro'), { hidden: true })
    expect(menuDefault(modelMenu('BlendSceneNode')!, NO_FAMILIES, 'Flux Kontext Pro')).toBe('Flux 2 Pro')
  })
})

// ------------------------------------------------------------ the sources

let root: string
let tmp: string
const engineFetch = vi.fn()
const app = createApp()
app.use(eventHandler(async (e) => {
  const r = await nativeEngineRoute(e)
  if (r !== undefined) return r
}))
const handler = toWebHandler(app)
async function get(p: string) {
  const res = await handler(new Request(`http://x${p}`))
  return { status: res.status, body: JSON.parse(await res.text()) }
}

describe('every /object_info source is overlaid', () => {
  beforeEach(() => {
    engineHealthState.value = 'up'
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'model-menus-root-')))
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'model-menus-store-')))
    for (const d of ['input', 'output', 'user', 'models']) fs.mkdirSync(path.join(root, d))
    __setInputUploadsEngineRootForTests(root)
    __setObjectInfoCacheFileForTests(path.join(tmp, 'data', 'object_info.json'))
    __setObjectInfoBaselineFileForTests(path.join(tmp, 'missing.gz'))
    vi.stubGlobal('fetch', engineFetch)
    engineFetch.mockReset()
    engineFetch.mockRejectedValue(new TypeError('fetch failed'))
    vi.stubEnv('NUXT_RUNNER_ENABLED', 'true')
    vi.stubEnv('NUXT_RUNNER_FAMILIES', '')
    flagScenario()
  })
  afterEach(async () => {
    await __objectInfoSaveSettledForTests()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    __setInputUploadsDbForTests(null)
    __setInputUploadsEngineRootForTests(undefined)
    __setObjectInfoBaselineFileForTests(undefined)
    __setObjectInfoCacheFileForTests(undefined)
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const engineAnswers = (body: unknown) => engineFetch.mockImplementation(async () => new Response(JSON.stringify(body), { status: 200 }))
  const families = (on: boolean) => vi.stubEnv('NUXT_RUNNER_FAMILIES', on ? 'fal-edit,replicate-image,replicate-video' : '')

  it('engine: parsed, overlaid and re-serialised; the saved copy is the engine\'s own', async () => {
    engineAnswers(engineFixture())
    expectOverlaid((await get('/object_info')).body, false)
    families(true)
    expectOverlaid((await get('/object_info')).body, true)
    await __objectInfoSaveSettledForTests()
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'object_info.json'), 'utf8'))
    expect(saved.EditImageNode.input.required.model[1].hidden_options).toBeUndefined()
    expect(saved.GenerateImageNode.input.required.model[1].default).toBe('flux-2-pro')
  })

  it('engine: one node\'s body too', async () => {
    engineAnswers({ EditImageNode: engineFixture().EditImageNode })
    const one = (await get('/object_info/EditImageNode')).body
    expect(one.EditImageNode.input.required.model[1]).toMatchObject({ default: 'Nano Banana 2', hidden_options: ['Flux Kontext Pro', 'Flux 2 Pro'] })
  })

  it('engine answers unparseable text: the stored catalog, overlaid (hidden models never shown)', async () => {
    const file = path.join(tmp, 'baseline.json.gz')
    fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(engineFixture())))
    __setObjectInfoBaselineFileForTests(file)
    engineFetch.mockImplementation(async () => new Response('{"KSampler": NaN}', { status: 200 }))
    expectOverlaid((await get('/object_info')).body, false)
  })

  it('saved copy (engine down)', async () => {
    fs.mkdirSync(path.join(tmp, 'data'))
    fs.writeFileSync(path.join(tmp, 'data', 'object_info.json'), JSON.stringify(engineFixture()))
    expectOverlaid((await get('/object_info')).body, false)
    families(true)
    expectOverlaid((await get('/object_info')).body, true)
  })

  it('committed baseline (engine down, nothing saved)', async () => {
    const file = path.join(tmp, 'baseline.json.gz')
    fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(engineFixture())))
    __setObjectInfoBaselineFileForTests(file)
    expectOverlaid((await get('/object_info')).body, false)
    families(true)
    expectOverlaid((await get('/object_info')).body, true)
  })

  it('hosted: the stored catalog, overlaid after the tenant scrub, which still applies — never the engine (R10.9)', async () => {
    __setInputUploadsDbForTests({ async query() { return { rows: [] } } })
    const stored = engineFixture()
    stored.LoadImage = { input: { required: { image: [['someone-else.png'], { image_upload: true }] } } }
    fs.mkdirSync(path.join(tmp, 'data'))
    fs.writeFileSync(path.join(tmp, 'data', 'object_info.json'), JSON.stringify(stored))
    engineAnswers(engineFixture())
    const out = await handleHostedObjectInfo({ path: '/object_info', context: { userId: 'u1' } } as any) as any
    expect(engineFetch).not.toHaveBeenCalled()
    expectOverlaid(out, false)
    expect(out.LoadImage.input.required.image[0]).toEqual([])
    families(true)
    expectOverlaid(await handleHostedObjectInfo({ path: '/object_info', context: { userId: 'u1' } } as any), true)
  })
})

// ------------------------------------------------------------ the menus

describe('galleries and dropdowns', () => {
  it('a gallery leaves out hidden, discontinued and switched-off models, but shows the node\'s own, tagged', () => {
    flag(IMAGE_MODELS_BY_ID['flux-pro']!, { hidden: true })
    flag(IMAGE_MODELS_BY_ID['flux-schnell']!, { runnerOnly: true, family: 'replicate-image' })
    const ids = (current: string | null, f = NO_FAMILIES) => galleryEntries(IMAGE_MODELS, { classType: 'GenerateImageNode', families: f, current })
    const plain = ids('flux-2-pro').map(e => e.model.id)
    expect(plain).not.toContain('flux-pro')
    expect(plain).not.toContain('flux-schnell')
    expect(plain.length).toBe(IMAGE_MODELS.length - 2)
    expect(ids('flux-pro').find(e => e.model.id === 'flux-pro')).toMatchObject({ hiddenTag: true })
    expect(ids(null, fams('replicate-image')).find(e => e.model.id === 'flux-schnell')).toMatchObject({ hiddenTag: false })
  })

  it('a runner-only model is offered on Generate a video (family on), never on Film a shot', () => {
    flag(VIDEO_MODELS_BY_ID['veo-3.1-fast']!, { runnerOnly: true, family: 'replicate-video' })
    flag(VIDEO_MODELS_BY_ID['sora-2']!, { discontinued: '2026-09-24' })
    const on = fams('replicate-video')
    const video = galleryEntries(VIDEO_MODELS, { classType: 'GenerateVideoNode', families: on, current: null }).map(e => e.model.id)
    const shot = galleryEntries(VIDEO_MODELS, { classType: 'FilmShotNode', families: on, current: null }).map(e => e.model.id)
    expect(video).toContain('veo-3.1-fast')
    expect(shot).not.toContain('veo-3.1-fast')
    expect(video).not.toContain('sora-2')
    // A saved legacy label shows the model it remaps to, tagged when that is hidden.
    flag(VIDEO_MODELS_BY_ID['veo-3.1']!, { hidden: true })
    expect(galleryEntries(VIDEO_MODELS, { classType: 'GenerateVideoNode', families: on, current: 'Veo 3' }).find(e => e.model.id === 'veo-3.1'))
      .toMatchObject({ hiddenTag: true })
  })

  it('the combo leaves out hidden options unless it is the node\'s own value, which says "(hidden)"', () => {
    const all = ['Nano Banana 2', 'Flux Kontext Pro', 'Flux 2 Pro']
    expect(comboMenu(all, ['Flux Kontext Pro'], 'Nano Banana 2')).toEqual({ options: ['Nano Banana 2', 'Flux 2 Pro'] })
    expect(comboMenu(all, ['Flux Kontext Pro'], 'Flux Kontext Pro')).toEqual({
      options: all,
      labels: ['Nano Banana 2', 'Flux Kontext Pro (hidden)', 'Flux 2 Pro'],
    })
    const refs = modelMenu('GenerateFromReferencesNode')!
    const label = (v: string) => refs.entries.find(e => e.value === v)?.label
    expect(comboMenu(['seedream-5-pro', 'seedream-5-lite', 'nano-banana-2'], ['seedream-5-lite'], 'seedream-5-lite', label).labels)
      .toEqual(['Seedream 5 Pro', 'Seedream 5 Lite (hidden)', 'Nano Banana 2'])
    expect(comboMenu(all, undefined, 'x')).toEqual({ options: all })
  })
})
