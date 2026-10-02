/**
 * Model line-up, Task H2: the outdated models are hidden, Sora is stopped,
 * the old engines are retired and the defaults change. All of it against the
 * real catalogue (app/data/image-models.ts, video-models.ts,
 * edit-model-options.ts) and the committed /object_info baseline.
 *
 * Hidden never means deleted: every hidden value stays a valid option,
 * prices, remaps and runs. Discontinued (Sora) is refused by all three
 * checks — the browser, the server meter and the runner — before any call.
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import type { ApiPrompt } from '#shared/runner/graph'
import { RUNNER_FAMILIES, NO_FAMILIES, type RunnerFamily } from '../../shared/runner/families'
import { isRunnerEligible, resolveVideoModelId } from '../../shared/runner/eligibility'
import { applyModelOverlay, galleryEntries, modelMenu } from '../../shared/runner/modelMenus'
import { blockedModelUses, classDefaultLabel } from '../../shared/runner/blockedModels'
import { IMAGE_MODELS, IMAGE_MODELS_BY_ID, IMAGE_MODEL_PREFERENCE } from '../../app/data/image-models'
import { FILM_SHOT_MODEL_PREFERENCE, VIDEO_MODELS, VIDEO_MODELS_BY_ID, VIDEO_MODEL_PREFERENCE } from '../../app/data/video-models'
import { EDIT_MODEL_MENUS } from '../../app/data/edit-model-options'
import { MOODBOARD_DEFAULT_MODEL, moodboardDefaultModel } from '../../app/lib/graph/moodboardApply'
import { blockedPromptRefusal, retiredEngineRefusal } from '../../server/utils/blockedModels'
import { blockedRunRefusal } from '../../app/lib/runner/needsEngine'
import { meterGraphSubmit } from '../../server/utils/meterGraphRun'
import { priceGraph } from '../../server/utils/priceBook'
import { makeKit } from './__runner__/kit'

// ── The lists, verbatim from the H2 brief ────────────────────────────────

const HIDDEN_IMAGES = [
  'imagen-3', 'imagen-3-fast', 'ideogram-v2', 'ideogram-v2a-turbo', 'seedream-3', 'seedream-4', 'flux-pro',
  'flux-1.1-pro', 'flux-1.1-pro-ultra', 'gpt-image-1.5', 'stable-diffusion-3.5-large',
  'stable-diffusion-3.5-large-turbo', 'stable-diffusion-3.5-medium', 'hunyuan-image-3', 'minimax-image-01',
  'photon', 'photon-flash', 'wan-2.2-image-pruna', 'recraft-v3', 'recraft-v3-svg',
  // Model line-up F8: Ideogram 4 covers every Ideogram V3 speed; Grok Imagine 2 (F7) replaces Grok Imagine.
  'ideogram-v3-quality', 'ideogram-v3-balanced', 'ideogram-v3-turbo', 'grok-imagine',
]
const HIDDEN_VIDEOS = ['hailuo-2.3', 'wan-2.5-i2v-fast', 'wan-2.7-t2v', 'luma-ray-2-720p', 'ltx-video', 'kling-v2.5-turbo-pro']
const DISCONTINUED_VIDEOS = ['sora-2', 'sora-2-pro']
/** Retired dropdown values (Restyle's two engines; open question 6: Kontext and Real-ESRGAN; F11: Blend's first Nano Banana). */
const HIDDEN_DROPDOWN: Record<string, string[]> = {
  'EditImageNode.model': ['Flux Kontext Pro'],
  'BlendSceneNode.model': ['Flux Kontext Pro', 'Nano Banana'],
  'RestyleFromImageNode.model': ['Nano Banana', 'Style Transfer · IP-Adapter'],
  'GenerateFromReferencesNode.model': [],
  'UpscaleImageNode.model': ['Real-ESRGAN'],
}
/** Runner-only models the line-up's F-tasks added (no Python builder; left out while their switch is off). */
const RUNNER_ONLY_IMAGES = ['nano-banana-2-lite', 'ideogram-4', 'recraft-v4.1', 'gpt-image-2.5', 'qwen-image-3', 'grok-imagine-2', 'muse-image', 'reve-2.1']
// R11.4 fix round 1: the Recraft SVG models are runner-only under recraft-svg (ComfyUI can't decode their SVG).
const SVG_IMAGES = ['recraft-v4-pro-svg', 'recraft-v4-svg', 'recraft-v3-svg']
// R11.4, ruling (p): no verified price yet, so hidden (and refused) until priced.
const UNPRICED_IMAGES = ['seedream-5-pro', 'reve-create']
const RUNNER_ONLY_DROPDOWN: Record<string, string[]> = {
  'EditImageNode.model': ['GPT Image 2.5', 'Seedream 5 Pro'],
  'BlendSceneNode.model': ['Nano Banana 2'],
}

// ── Helpers ──────────────────────────────────────────────────────────────

const card = (from: string) => ({ class_type: 'Image', inputs: { image: '', export: false, images: [from, 0], batch_index: -1 } })
const img = (model: string) => ({ class_type: 'GenerateImageNode', inputs: { model, prompt: 'a fox', aspect_ratio: '1:1', seed: 0, model_options: '{}' } })
const vid = (model: string, class_type = 'GenerateVideoNode') =>
  ({ class_type, inputs: { model, prompt: 'a fox', aspect_ratio: '16:9', duration: '5', seed: 0, model_options: '{}' } })
const one = (node: { class_type: string; inputs: Record<string, unknown> }): ApiPrompt => ({ 1: node, 2: card('1') })
const ALL = new Set<RunnerFamily>(RUNNER_FAMILIES)

/** The committed baseline: ComfyUI's own node definitions, Python's defaults. */
function baseline(): Record<string, any> {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '../../server/native/objectInfo.baseline.json.gz'))).toString('utf8'))
}
const modelSpec = (body: any, cls: string) => body[cls].input.required.model
const cfg = (body: any, cls: string) => modelSpec(body, cls)[1]

/** The hosted meter's dependencies, faked: records every price, hold and forward. */
function meterDeps() {
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

// ── The flags ────────────────────────────────────────────────────────────

describe('the hide lists', () => {
  it('exactly the listed image and video models are hidden, and Sora is discontinued on 24 Sep 2026', () => {
    expect(IMAGE_MODELS.filter(m => m.hidden).map(m => m.id).sort()).toEqual([...HIDDEN_IMAGES].sort())
    expect(VIDEO_MODELS.filter(m => m.hidden).map(m => m.id).sort()).toEqual([...HIDDEN_VIDEOS].sort())
    expect(VIDEO_MODELS.filter(m => m.discontinued).map(m => [m.id, m.discontinued])).toEqual(DISCONTINUED_VIDEOS.map(id => [id, '2026-09-24']))
    expect(IMAGE_MODELS.filter(m => m.discontinued)).toEqual([])
    expect(IMAGE_MODELS.filter(m => m.runnerOnly && !SVG_IMAGES.includes(m.id)).map(m => [m.id, m.family])).toEqual(RUNNER_ONLY_IMAGES.map(id => [id, id]))
    expect(IMAGE_MODELS.filter(m => SVG_IMAGES.includes(m.id)).map(m => [m.id, m.runnerOnly, m.family])).toEqual(SVG_IMAGES.map(id => [id, true, 'recraft-svg']))
  })

  it('exactly the retired dropdown values are hidden; every Python value is still an option', () => {
    const b = baseline()
    for (const [key, hidden] of Object.entries(HIDDEN_DROPDOWN)) {
      const menu = EDIT_MODEL_MENUS[key]!
      expect(menu.options.filter(o => o.hidden).map(o => o.value).sort(), key).toEqual([...hidden].sort())
      // Hidden, never removed: the list is still Python's, in its order (the runner-only values after it).
      expect(menu.options.map(o => o.value), key).toEqual([...cfg(b, key.split('.')[0]!).options, ...(RUNNER_ONLY_DROPDOWN[key] ?? [])])
    }
  })

  it('each hidden or discontinued id still prices, on every node that offers it', () => {
    for (const id of HIDDEN_IMAGES) expect(priceGraph(one(img(id))).credits, id).toBeGreaterThan(1)
    for (const id of [...HIDDEN_VIDEOS, ...DISCONTINUED_VIDEOS]) {
      expect(priceGraph(one(vid(id))).credits, id).toBeGreaterThan(1)
      expect(priceGraph(one(vid(id, 'FilmShotNode'))).credits, `FilmShotNode ${id}`).toBeGreaterThan(1)
    }
    const dropdownNode: Record<string, Record<string, unknown>> = {
      EditImageNode: { input_image: ['9', 0], prompt: 'x' },
      BlendSceneNode: { image: ['9', 0] },
      RestyleFromImageNode: { content_image: ['9', 0], style_image: ['9', 0] },
      UpscaleImageNode: { image: ['9', 0] },
    }
    for (const [key, hidden] of Object.entries(HIDDEN_DROPDOWN)) {
      const cls = key.split('.')[0]!
      for (const model of hidden) {
        expect(priceGraph({ 1: { class_type: cls, inputs: { ...dropdownNode[cls], model } }, 2: card('1') }).credits, `${cls} ${model}`).toBeGreaterThan(1)
      }
    }
  })

  it('a hidden model is still served as an option and still runs: never blocked, on either path', () => {
    // (Recraft V3 SVG is hidden and runner-only since R11.4 fix round 1: blocked on the ComfyUI path, runner-taken.)
    for (const id of HIDDEN_IMAGES) {
      if (SVG_IMAGES.includes(id)) continue
      expect(blockedModelUses(one(img(id))), id).toEqual([])
      expect(blockedModelUses(one(img(id)), { families: ALL, runnerTakes: true }), id).toEqual([])
    }
    for (const id of HIDDEN_VIDEOS) expect(blockedModelUses(one(vid(id)), { families: ALL, runnerTakes: true }), id).toEqual([])
    const served = applyModelOverlay(baseline(), NO_FAMILIES)
    for (const id of HIDDEN_IMAGES) expect(cfg(served, 'GenerateImageNode').options, id).toContain(id)
    for (const id of [...HIDDEN_VIDEOS, ...DISCONTINUED_VIDEOS]) {
      expect(cfg(served, 'GenerateVideoNode').options, id).toContain(id)
      expect(cfg(served, 'FilmShotNode').options, id).toContain(id)
    }
  })

  it('the galleries leave them out, except a node\'s own model, which shows tagged', () => {
    const images = galleryEntries(IMAGE_MODELS, { classType: 'GenerateImageNode', families: NO_FAMILIES, current: 'flux-1.1-pro' })
    for (const id of HIDDEN_IMAGES.filter(i => i !== 'flux-1.1-pro')) expect(images.map(e => e.model.id), id).not.toContain(id)
    expect(images.find(e => e.model.id === 'flux-1.1-pro')).toMatchObject({ hiddenTag: true })
    // Every family off: the runner-only models are left out too.
    for (const id of UNPRICED_IMAGES) expect(images.map(e => e.model.id), id).not.toContain(id)
    const svgNotHidden = SVG_IMAGES.filter(id => !HIDDEN_IMAGES.includes(id))
    expect(images.filter(e => !e.hiddenTag)).toHaveLength(IMAGE_MODELS.length - HIDDEN_IMAGES.length - RUNNER_ONLY_IMAGES.length - UNPRICED_IMAGES.length - svgNotHidden.length)
    for (const cls of ['GenerateVideoNode', 'FilmShotNode']) {
      const shown = galleryEntries(VIDEO_MODELS, { classType: cls, families: ALL, current: null }).map(e => e.model.id)
      for (const id of [...HIDDEN_VIDEOS, ...DISCONTINUED_VIDEOS]) expect(shown, `${cls} ${id}`).not.toContain(id)
    }
  })
})

// ── Legacy names ─────────────────────────────────────────────────────────

describe('the legacy video names still price and run through the eligibility rules', () => {
  it('"Veo 3" → veo-3.1: priced, the runner takes it with no family, nothing blocks it', () => {
    expect(resolveVideoModelId('Veo 3')).toBe('veo-3.1')
    expect(priceGraph(one(vid('Veo 3'))).credits).toBe(priceGraph(one(vid('veo-3.1'))).credits)
    expect(priceGraph(one(vid('Veo 3'))).credits).toBeGreaterThan(1)
    expect(isRunnerEligible(one(vid('Veo 3')), NO_FAMILIES)).toBe(true)
    expect(blockedModelUses(one(vid('Veo 3')))).toEqual([])
  })

  it('"Kling 2.1" → kling-v2.5-turbo-pro (now hidden): priced, taken with replicate-video on, never blocked, tagged in the gallery', () => {
    expect(resolveVideoModelId('Kling 2.1')).toBe('kling-v2.5-turbo-pro')
    expect(VIDEO_MODELS_BY_ID['kling-v2.5-turbo-pro']!.hidden).toBe(true)
    expect(priceGraph(one(vid('Kling 2.1'))).credits).toBe(priceGraph(one(vid('kling-v2.5-turbo-pro'))).credits)
    expect(priceGraph(one(vid('Kling 2.1'))).credits).toBeGreaterThan(1)
    expect(isRunnerEligible(one(vid('Kling 2.1')), new Set<RunnerFamily>(['replicate-video']))).toBe(true)
    expect(isRunnerEligible(one(vid('Kling 2.1')), NO_FAMILIES)).toBe(false)
    expect(blockedModelUses(one(vid('Kling 2.1')))).toEqual([])
    expect(blockedModelUses(one(vid('Kling 2.1')), { families: ALL, runnerTakes: true })).toEqual([])
    expect(galleryEntries(VIDEO_MODELS, { classType: 'GenerateVideoNode', families: NO_FAMILIES, current: 'Kling 2.1' })
      .find(e => e.model.id === 'kling-v2.5-turbo-pro')).toMatchObject({ hiddenTag: true })
  })
})

// ── Defaults ─────────────────────────────────────────────────────────────

describe('a new node gets the new default (the overlay on the committed baseline)', () => {
  const WANT: Record<string, string> = {
    GenerateImageNode: 'nano-banana-2',
    GenerateVideoNode: 'hailuo-h3-max',
    FilmShotNode: 'hailuo-h3-max',
    RestyleFromImageNode: 'Nano Banana 2',
    EditImageNode: 'Nano Banana 2',
    BlendSceneNode: 'Flux 2 Pro',
    GenerateFromReferencesNode: 'seedream-5-pro',
    UpscaleImageNode: 'Clarity',
  }

  it('the preference lists', () => {
    expect(IMAGE_MODEL_PREFERENCE).toEqual(['nano-banana-2', 'flux-2-pro'])
    expect(VIDEO_MODEL_PREFERENCE).toEqual(['hailuo-h3-max', 'veo-3.1'])
    expect(FILM_SHOT_MODEL_PREFERENCE).toEqual(['hailuo-h3-max', 'kling-v3'])
    expect(EDIT_MODEL_MENUS['RestyleFromImageNode.model']!.preference).toEqual(['Nano Banana 2'])
  })

  for (const [label, families] of [['every family off', NO_FAMILIES], ['every family on', ALL]] as const) {
    it(`${label}: Sailor's default wins over Python's own, which stays as it is`, () => {
      const b = baseline()
      // Python's constants are unchanged (H2 edits no Python): the overlay decides.
      expect(cfg(b, 'GenerateImageNode').default).toBe('flux-2-pro')
      expect(cfg(b, 'GenerateVideoNode').default).toBe('veo-3.1')
      expect(cfg(b, 'FilmShotNode').default).toBe('kling-v2.5-turbo-pro')
      expect(cfg(b, 'BlendSceneNode').default).toBe('Flux Kontext Pro')
      const served = applyModelOverlay(b, families)
      // Blend scene starts on Nano Banana 2 while its switch is on (F11).
      const wants = families === ALL ? { ...WANT, BlendSceneNode: 'Nano Banana 2' } : WANT
      for (const [cls, want] of Object.entries(wants)) {
        expect(cfg(served, cls).default, cls).toBe(want)
        // The default is a value the node offers, and runs.
        expect(cfg(served, cls).options, cls).toContain(want)
        // A runner-only default (Blend's Nano Banana 2) runs on the runner, with its switch on.
        const runnerOnly = !!modelMenu(cls)!.entries.find(e => e.value === want)!.runnerOnly
        expect(blockedModelUses(one({ class_type: cls, inputs: { model: want } }), runnerOnly ? { families, runnerTakes: true } : {})).toEqual([])
      }
      for (const [key, hidden] of Object.entries(HIDDEN_DROPDOWN)) {
        // A runner-only value is left out while its switch is off.
        expect(cfg(served, key.split('.')[0]!).hidden_options, key).toEqual([...hidden, ...(families === ALL ? [] : RUNNER_ONLY_DROPDOWN[key] ?? [])])
      }
    })
  }

  it('the defaults are on the menus Sailor decides, and none is hidden', () => {
    for (const [cls, want] of Object.entries(WANT)) {
      const e = modelMenu(cls)!.entries.find(x => x.value === want)!
      expect(e, cls).toBeTruthy()
      expect(e.hidden || e.discontinued || e.runnerOnly, cls).toBeFalsy()
    }
  })

  it('a moodboard switch lands on the image class default', () => {
    expect(MOODBOARD_DEFAULT_MODEL).toBe(IMAGE_MODEL_PREFERENCE[0])
    expect(IMAGE_MODELS_BY_ID[MOODBOARD_DEFAULT_MODEL]!.tags).toContain('multi-image')
  })
})

// ── Sora: refused by all three checks ────────────────────────────────────

describe('a Sora node is refused by all three checks, before any call', () => {
  const titleOf = (id: string) => (id === '1' ? 'Trailer' : 'Result')

  for (const id of DISCONTINUED_VIDEOS) {
    const label = VIDEO_MODELS_BY_ID[id]!.label

    it(`${id}: the browser refuses it before any /prompt, on Generate a video and on Film a shot`, () => {
      for (const cls of ['GenerateVideoNode', 'FilmShotNode']) {
        for (const opts of [{ runnerOn: false }, { runnerOn: true, families: ALL }]) {
          expect(blockedRunRefusal([{ prompt: one(vid(id, cls)), titleOf }], opts), cls).toEqual({
            title: `${label} was discontinued by its service on 24 Sep 2026`,
            description: 'Pick another model in “Trailer”, such as Hailuo H3 Max.',
          })
        }
      }
    })

    it(`${id}: the server meter answers 400 with no price, hold or forward`, async () => {
      for (const cls of ['GenerateVideoNode', 'FilmShotNode']) {
        const d = meterDeps()
        const r = await meterGraphSubmit('u1', { prompt: one(vid(id, cls)) }, d as any)
        expect(r.status, cls).toBe(400)
        expect((r.body as any).error.message, cls).toMatch(new RegExp(`^${label} was discontinued by its service on 24 Sep 2026\\.`))
        expect((r.body as any).node_errors[1].class_type, cls).toBe(cls)
        expect(d.priceGraph).not.toHaveBeenCalled()
        expect(d.hold).not.toHaveBeenCalled()
        expect(d.forward).not.toHaveBeenCalled()
      }
    })

    it(`${id}: the runner refuses it with replicate-video on, before any hold or call`, async () => {
      const k = makeKit({ hosted: true, deps: { families: () => new Set<RunnerFamily>(['replicate-video']) } })
      await expect(k.engine.startRun({ userId: k.userId, takes: [one(vid(id))], workflow: null, canvasId: null, projectUuid: null, projectName: null }))
        .rejects.toMatchObject({
          statusCode: 400,
          message: `${label} was discontinued by its service on 24 Sep 2026. Pick another model in “Generate a video”, such as Hailuo H3 Max.`,
        })
      expect(k.ledger.hold).not.toHaveBeenCalled()
      expect(k.graphRuns.create).not.toHaveBeenCalled()
      expect(k.replicate.submitted()).toEqual([])
      expect(k.fal.client.submit).not.toHaveBeenCalled()
    })
  }
})

// ── No hard-coded default left ───────────────────────────────────────────

describe('grep guard: no node is created with a hard-coded model outside dev/', () => {
  const FRONTEND = path.join(__dirname, '../..')
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'dev' ? [] : walk(p)
    return /\.(ts|vue|js|mjs)$/.test(e.name) ? [p] : []
  })
  /**
   * Every value a model menu stores, plus the legacy video names. The
   * Lip-sync engine menu (F22, "LipSyncNode.engine") names engines, and its
   * "auto", "fabric" and "sync" are everyday words: only its model, sync-3.
   */
  const MODEL_VALUES = new Set<string>([
    ...IMAGE_MODELS.map(m => m.id), ...VIDEO_MODELS.map(m => m.id),
    ...Object.entries(EDIT_MODEL_MENUS).filter(([k]) => k.endsWith('.model')).flatMap(([, m]) => m.options.map(o => o.value)),
    'sync-3',
    'Veo 3', 'Kling 2.1', 'Seedance 2.0',
  ])
  /**
   * The literals that stay, each a deliberate choice rather than a class
   * default. A new one fails here: point it at the class default (the
   * preference lists) or add it with its reason.
   */
  const ALLOWED: Record<string, string[]> = {
    // Cheap 512 px drafts: the sketch pad, its warm-up, Draft mode, and the Product shot app's backdrop.
    'app/lib/sketch/sketchPadPrompt.ts': ['flux-schnell'],
    'app/lib/draft/overrides.ts': ['flux-schnell'],
    'app/components/vue-canvas/VueNodeCanvas.vue': ['Nano Banana 2', 'flux-schnell'], // agent repair edits use Nano Banana; the sketch warm-up
    // The Product shot app: its backdrop draft (flux-schnell); its relight engine,
    // Flux 2 Pro by default (fix round 1 ruling); and Flux Kontext Pro, used only
    // while "Keep the product exact" is on — the keep-mask needs an in-place edit.
    'app/components/apps/ProductShotApp.vue': ['Flux 2 Pro', 'Flux Kontext Pro', 'flux-schnell'],
    // Which Upscale engine a widget belongs to (a widget → model map), not a default.
    'app/components/vue-canvas/ComfyNode.vue': ['Topaz'],
    // "Edit with Nano Banana": the action names its model.
    'app/lib/canvas/nodeActions.ts': ['Nano Banana 2'],
    // Display text of the action catalogue (the model a tool uses), not a node's widget.
    'app/data/action-catalog.ts': ['Clarity', 'Nano Banana', 'Nano Banana 2', 'Topaz'],
    // Shot Director's default model is Seedance 2.0 (a sheet with no model, or an unknown one, falls back to it);
    // the chosen model comes from the sheet. Packs are priced on a Seedance clip.
    'app/lib/shotdirector/hydrate.ts': ['seedance-2.0'],
    'app/lib/shotdirector/prepare.ts': ['seedance-2.0'],
    'app/lib/shotdirector/price.ts': ['seedance-2.0'],
    'app/lib/shotdirector/types.ts': ['seedance-2.0'],
    'server/utils/packs.ts': ['seedance-2.0'],
    // The inpaint route's own tiers, not a node's model widget.
    'server/api/inpaint/text2img.post.ts': ['flux-schnell'],
    'server/utils/inpaintFalInputs.ts': ['nano-banana-pro'],
    // Film a shot's model list and its lip-sync model, named only to refuse it before the hold (R3.11).
    'shared/runner/eligibility.ts': ['fabric-1.0'],
    // Turntable's fixed models, as Python's node hard-codes them: Luma Ray 2 for the front spin, Seedance 2.0 per arc (R3.16).
    'shared/runner/turntable.ts': ['luma-ray-2-720p', 'seedance-2.0'],
    // Upscale (2×) names the model its Python node runs; the runner calls Replicate's Real-ESRGAN for it (R7.2).
    'server/runner/generators/localModels.ts': ['Real-ESRGAN'],
  }

  it('every model literal outside dev/ is on the list, and none of them is hidden or discontinued', () => {
    const found: Record<string, Set<string>> = {}
    // Any `…model… = / :` literal (blendModel, PRESERVE_MODEL, a `ref('…')` or
    // `ref<T>('…')` default), and any `?? '…'` / `|| '…'` fallback.
    const literal = /\b\w*(?:[mM]odel|MODEL)\w*\s*[:=]\s*(?:ref(?:<[^>]*>)?\()?(['"`])([^'"`\n]+)\1|(?:\?\?|\|\|)\s*(['"`])([^'"`\n]+)\3/g
    for (const file of ['app', 'shared', 'server'].flatMap(d => walk(path.join(FRONTEND, d)))) {
      const src = fs.readFileSync(file, 'utf8')
      for (const m of src.matchAll(literal)) {
        const v = m[2] ?? m[4]!
        if (!MODEL_VALUES.has(v)) continue
        const rel = path.relative(FRONTEND, file).split(path.sep).join('/')
        ;(found[rel] ??= new Set()).add(v)
      }
    }
    const got = Object.fromEntries(Object.entries(found).map(([f, s]) => [f, [...s].sort()]).sort())
    const want = Object.fromEntries(Object.entries(ALLOWED).map(([f, v]) => [f, [...v].sort()]).sort())
    expect(got).toEqual(want)
    // Hidden or discontinued everywhere it is listed: a gallery id, or a dropdown
    // value hidden in every menu that has it (Flux Kontext Pro, IP-Adapter, Real-ESRGAN).
    const dropdown = Object.values(EDIT_MODEL_MENUS).flatMap(m => m.options)
    const flagged = new Set([
      ...[...IMAGE_MODELS, ...VIDEO_MODELS].filter(m => m.hidden || m.discontinued).map(m => m.id),
      ...dropdown.filter(o => dropdown.filter(x => x.value === o.value).every(x => x.hidden)).map(o => o.value),
    ])
    expect(flagged.has('Flux Kontext Pro')).toBe(true)
    /** A flagged literal allowed on purpose, with its reason above. */
    // Turntable's front spin is Luma Ray 2 because Python's node hard-codes it, though Ray 2 is hidden from the video menu (R3.16).
    // Upscale (2×) runs Real-ESRGAN on Replicate, though Real-ESRGAN is hidden from the edit menu (R7.2).
    const FLAGGED_ON_PURPOSE = new Set(['app/components/apps/ProductShotApp.vue Flux Kontext Pro', 'shared/runner/turntable.ts luma-ray-2-720p', 'server/runner/generators/localModels.ts Real-ESRGAN'])
    for (const [file, values] of Object.entries(ALLOWED)) {
      if (file === 'app/data/action-catalog.ts') continue // display text; 'Nano Banana' there is Sketch to image's engine
      for (const v of values) expect(flagged.has(v) && !FLAGGED_ON_PURPOSE.has(`${file} ${v}`), `${file} ${v}`).toBe(false)
    }
  })
})

// ── Fix round 1 ──────────────────────────────────────────────────────────

const src = (rel: string) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8')

describe('fix round 1', () => {
  it('I1: the Product shot app relights on Flux 2 Pro; Kontext only while "Keep the product exact" is on', () => {
    const app = src('app/components/apps/ProductShotApp.vue')
    expect(app).toMatch(/const blendModel = ref<BlendEngine>\('Flux 2 Pro'\)/)
    expect(app).toContain("const BLEND_ENGINES: readonly BlendEngine[] = ['Flux 2 Pro', 'Nano Banana']")
    expect(app).toContain('const keepExact = ref(false)')
    // The keep-mask and Kontext go together, and only while the switch is on.
    expect(app).toContain('const usePreserve = keepExact.value')
    expect(app).toContain('model: usePreserve ? PRESERVE_MODEL : blendModel.value,')
    const uses = [...app.matchAll(/PRESERVE_MODEL/g)].length
    // Declared once; sent once (above); shown once, as the engine, under v-else of `!keepExact`; two look-migration reads.
    expect(uses).toBe(5)
    expect(app).toContain('<div v-if="!keepExact" class="inline-flex')
    expect(app).toContain('<span v-else class="text-[11.5px] text-white/70">{{ PRESERVE_MODEL }}</span>')
    // A look saved on Kontext before H2 comes back with the switch on.
    expect(app).toContain('keepExact.value = p.blendModel === PRESERVE_MODEL || !!p.keepExact')
  })

  it('I2: the packs\' image unit is the image class default (packs.unit.spec.ts has the figures)', () => {
    const packs = src('server/utils/packs.ts')
    expect(packs).toContain('IMAGE_MODEL_PREFERENCE[0]')
    expect(packs).not.toContain('flux-dev')
  })

  describe('hosted: the two estimate-priced edit engines are refused before any price or hold, until F12', () => {
    const shot: ApiPrompt = { 1: { class_type: 'LoadImage', inputs: { image: 'p.png' } }, 2: { class_type: 'ProductShotNode', inputs: { image: ['1', 0], scene_prompt: 'a beach' } }, 3: { class_type: 'SaveImage', inputs: { images: ['2', 0] } } }
    const restyle = (model: string): ApiPrompt => ({
      1: { class_type: 'LoadImage', inputs: { image: 'p.png' } },
      2: { class_type: 'RestyleFromImageNode', inputs: { model, content_image: ['1', 0], style_image: ['1', 0] } },
      3: { class_type: 'SaveImage', inputs: { images: ['2', 0] } },
    })

    it('Product shot on SDXL', async () => {
      const d = meterDeps()
      const r = await meterGraphSubmit('u1', { prompt: shot }, d as any)
      expect(r.status).toBe(400)
      expect(r.body.error.message).toBe('Product shot is being upgraded — try Swap background for now.')
      expect(r.body.node_errors[2].class_type).toBe('ProductShotNode')
      expect(d.priceGraph).not.toHaveBeenCalled()
      expect(d.hold).not.toHaveBeenCalled()
      expect(d.forward).not.toHaveBeenCalled()
    })

    it('Restyle on IP-Adapter (fofr/style-transfer), naming the default by its name', async () => {
      const d = meterDeps()
      const r = await meterGraphSubmit('u1', { prompt: restyle('Style Transfer · IP-Adapter') }, d as any)
      expect(r.status).toBe(400)
      expect(r.body.error.message).toBe('Restyle’s Style Transfer engine has been retired. Pick another model in “Restyle from image”, such as Nano Banana 2.')
      expect(r.body.node_errors[2].errors[0].extra_info).toEqual({ input_name: 'model', input_value: 'Style Transfer · IP-Adapter' })
      expect(d.priceGraph).not.toHaveBeenCalled()
      expect(d.hold).not.toHaveBeenCalled()
      expect(d.forward).not.toHaveBeenCalled()
    })

    it('control: Restyle on another engine (hidden plain Nano Banana too) is priced, held and forwarded', async () => {
      for (const model of ['Nano Banana 2', 'Nano Banana']) {
        const d = meterDeps()
        const r = await meterGraphSubmit('u1', { prompt: restyle(model) }, d as any)
        expect(r.status, model).toBe(200)
        expect(d.hold, model).toHaveBeenCalledTimes(1)
      }
    })

    it('local mode is unchanged: the local proxy check lets both through', () => {
      expect(blockedPromptRefusal(shot)).toBeNull()
      expect(blockedPromptRefusal(restyle('Style Transfer · IP-Adapter'))).toBeNull()
      expect(src('server/middleware/comfyui-proxy.ts')).not.toContain('retiredEngineRefusal')
      expect(retiredEngineRefusal(shot)).not.toBeNull()
    })
  })

  it('M1: the agent copy names the engine editImage and Edit an image really call, never Kontext', () => {
    expect(src('server/api/inpaint/kontext.post.ts')).toContain("const APP = 'fal-ai/flux-2-pro/edit'")
    for (const f of ['app/lib/agent/capabilities.ts', 'app/lib/agent/surfaces/smartLayout.ts', 'app/lib/agent/surfaces/compositor.ts']) {
      expect(src(f), f).not.toMatch(/\(Flux Kontext\)|\/ Flux Kontext \//)
    }
    expect(src('app/lib/agent/surfaces/smartLayout.ts')).toContain('from an instruction (Flux 2 Pro)')
    expect(src('app/lib/agent/surfaces/compositor.ts')).toContain('from an instruction (Flux 2 Pro)')
  })

  it('M2: a node\'s own discontinued model is tagged "Discontinued", a hidden one "Hidden"', () => {
    const sora = galleryEntries(VIDEO_MODELS, { classType: 'GenerateVideoNode', families: NO_FAMILIES, current: 'sora-2' })
    expect(sora.find(e => e.model.id === 'sora-2')).toMatchObject({ hiddenTag: true, tag: 'Discontinued' })
    const kling = galleryEntries(VIDEO_MODELS, { classType: 'FilmShotNode', families: NO_FAMILIES, current: 'kling-v2.5-turbo-pro' })
    expect(kling.find(e => e.model.id === 'kling-v2.5-turbo-pro')).toMatchObject({ hiddenTag: true, tag: 'Hidden' })
    expect(kling.filter(e => e.tag)).toHaveLength(1)
    for (const f of ['ModelGalleryModal.vue', 'VideoModelGalleryModal.vue']) {
      expect(src(`app/components/vue-canvas/${f}`), f).toMatch(/\{\{ hiddenTagged\.get\(\(item as \w+\)\.id\) \}\}<\/span>/)
    }
  })

  it('M3: the Sora refusal suggests the class default by its catalogue name, never an id', () => {
    for (const cls of ['GenerateVideoNode', 'FilmShotNode', 'GenerateImageNode']) {
      for (const families of [NO_FAMILIES, ALL]) {
        const label = classDefaultLabel(cls, families)!
        expect(label, cls).toBeTruthy()
        expect([...IMAGE_MODELS, ...VIDEO_MODELS].some(m => m.label === label), cls).toBe(true)
        expect([...IMAGE_MODELS, ...VIDEO_MODELS].some(m => m.id === label), cls).toBe(false)
      }
    }
    expect(classDefaultLabel('GenerateVideoNode', NO_FAMILIES)).toBe('Hailuo H3 Max')
  })

  it('M4: the moodboard switch never lands on a model that can\'t take references', () => {
    const nb2 = IMAGE_MODELS_BY_ID['nano-banana-2']!
    const pro = IMAGE_MODELS_BY_ID['nano-banana-pro']!
    const plain = IMAGE_MODELS_BY_ID['flux-2-pro']!
    expect(plain.tags).not.toContain('multi-image')
    // The preference list first…
    expect(moodboardDefaultModel(IMAGE_MODELS, ['flux-2-pro', 'nano-banana-2'])).toBe('nano-banana-2')
    // …then the first catalogue model that takes references, not the list's head.
    expect(moodboardDefaultModel([plain, pro, nb2], ['flux-2-pro'])).toBe('nano-banana-pro')
    // A hidden reference model is skipped.
    expect(moodboardDefaultModel([plain, { ...pro, hidden: true }, nb2], ['flux-2-pro'])).toBe('nano-banana-2')
    // None at all: it throws rather than pick one.
    expect(() => moodboardDefaultModel([plain], ['flux-2-pro'])).toThrow('no image model in the catalogue takes reference pictures')
  })

  it('M5: the gallery subtitle counts what it shows, in plain words that fit both services', () => {
    for (const f of ['ModelGalleryModal.vue', 'VideoModelGalleryModal.vue']) {
      const vue = src(`app/components/vue-canvas/${f}`)
      expect(vue, f).toContain(':subtitle="`${offeredModels.length} models`"')
      expect(vue, f).not.toContain('models · Replicate')
    }
  })

  it('M6: the Blend scene icon comment names its default', () => {
    expect(src('app/data/generator-icons.ts')).toMatch(/BlendSceneNode:\s+'BFL',\s+\/\/ Flux 2 Pro \(default/)
  })
})
