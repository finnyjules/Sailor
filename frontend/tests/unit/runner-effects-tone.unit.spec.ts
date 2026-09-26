/**
 * R2.4: the tone, colour and light effects (family effects-tone,
 * server/runner/effects/core/tone.ts), against the real Python nodes
 * (scripts/runner_effects_fixtures.py --group tone →
 * fixtures/runner-effects-tone.json). An *exact* class is float32 bit for bit
 * (its hash); a *library* class's 8-bit output equals Python's except where
 * Python's float lies within its class's ε of a quantisation boundary
 * (LIBRARY_EPS), and there by one level.
 */
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { makeKit } from './__runner__/kit'
import {
  b64, bandOf, coreOp, expectExactHash, filesOfValue, interleaved, loadFixtures, paramsOf, pictureOf, pngPixels,
  runEffectCase, sha256, tensorsOf, withAssets, type FxCase, type FxFile, type FxItem,
} from './__runner__/effectsParity'
import type { ApiPrompt } from '#shared/runner/graph'
import { RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { IMAGE_OUTPUT_CLASSES, PICTURE_OUTPUTS, RUNNER_NODE_RULES, isRunnerEligible, runnerTakesNode } from '#shared/runner/eligibility'
import { runnerTakesWorkflow } from '#shared/runner/validate'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { EFFECT_CLASSES_PORTED, EFFECT_ERROR_MESSAGES, EFFECT_FAMILIES, EFFECT_FAMILY_OF, EFFECT_TEXT_WIDGETS, effectTextIsPortable } from '#shared/runner/effects'
import { EFFECT_SCHEMAS } from '#shared/runner/effectSchemas.generated'
import {
  DEFAULT_DUOTONE, duotoneTextIsPortable, hexTextIsPortable, hexToRgb, parseDuotone, parseStops, stopsTextIsPortable,
} from '#shared/runner/gradientStops'
import { EFFECTS } from '~~/server/runner/effects/table'
import { effectCores } from '~~/server/runner/effects/cores'
import type { Tensor } from '~~/server/runner/effects/core/tensor'
import { decodeRaw } from '~~/server/runner/compositor/decode'
import { workerScript } from '~~/server/runner/compositor/worker'
import { compositorCore } from '~~/server/runner/compositor/plane'
import type { OutputFile, RunnerValue } from '~~/server/runner/types'
import { createMemoryKeptBytes } from '~~/server/runner/keptBytes'

// ── The fixtures ─────────────────────────────────────────────────────────────

interface ToneItem extends FxItem { f32z?: string }
interface ToneCase extends Omit<FxCase, 'outputs'> { outputs?: { kind: 'image'; items: ToneItem[] }[] }
interface ToneFx extends Omit<FxFile, 'cases'> {
  cases: ToneCase[]
  library_eps: Record<string, number>
  stops: { raw: string; parsed: [number, number[]][] }[]
  duotone: { raw: string; pair: [string, string]; rgb: [number[], number[]] }[]
  hex: { text: string; gradient_map: number[] | null; unicorn: number[] | null }[]
  frame: { name: string; inputs: FxCase['inputs']; effect: { class_type: string; node_id: string; widgets: Record<string, unknown> }; frame: { widgets: Record<string, unknown>; w: number; h: number; image8: string } }
}
const FX = withAssets(loadFixtures<ToneFx & FxFile>('tone') as unknown as FxFile) as unknown as ToneFx

/** The 26 classes R2.4 ports (the pilots are R2.1's). */
const TONE_CLASSES = [
  'AdjustBrightnessContrast', 'AdjustColor', 'AdjustCurves', 'AdjustLevels',
  'AdjustTemperature', 'AdjustVibrance', 'AdjustColorBalance', 'AdjustBlackWhite', 'AdjustPhotoFilter', 'AdjustGradientMap', 'AdjustChannelMixer', 'AdjustPosterize',
  'AdjustVignette', 'AdjustShadowsHighlights', 'Duotone', 'SplitToning',
  'GradientMap', 'Posterize', 'Hologram', 'TwoDLight', 'LightLeak', 'LensFlare', 'Caustics', 'Blinds', 'CrossHatch', 'Dither',
]

/**
 * Each library class's ε (255-scale), at least twice the worst |Δ| measured
 * between the port's float and Python's over this group (the measurement is
 * a test below), and at most 2⁻⁸ (R2 rule 10). The fixture script holds the
 * same table (its hashed cases' bands are recorded at it). Every other class
 * is exact.
 */
const LIBRARY_EPS: Readonly<Record<string, number>> = {
  AdjustBrightnessContrast: 2 ** -12, // contrast's mean (ported exact at this Mac's thread count)
  AdjustCurves: 2 ** -12, // pow
  AdjustLevels: 2 ** -12, // pow
  SplitToning: 2 ** -12, // pow
  Posterize: 2 ** -12, // pow
  Hologram: 2 ** -12, // cos, sin
  TwoDLight: 2 ** -12, // pow
  LightLeak: 2 ** -12, // exp
  LensFlare: 2 ** -12, // exp
  Caustics: 2 ** -12, // sin, pow
}

const TONE: ReadonlySet<RunnerFamily> = new Set(['cards', 'effects-tone'])
const TONE_EDIT: ReadonlySet<RunnerFamily> = new Set(['cards', 'effects-tone', 'fal-edit'])
const TONE_FRAME: ReadonlySet<RunnerFamily> = new Set(['cards', 'effects-tone', 'frame'])
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }

const tk = effectCores.tk
const isLibrary = (cls: string) => Object.prototype.hasOwnProperty.call(LIBRARY_EPS, cls)

/** A class's widget defaults (the first case of the standard set is 'defaults'). */
function defaultsOf(cls: string): Record<string, unknown> {
  const c = FX.cases.find(x => x.class_type === cls && x.name.startsWith(`${cls}: defaults,`))
  if (!c) throw new Error(`no defaults case for ${cls}`)
  return c.widgets
}

/** Python's H × W × C float32 as the planar tensor the core holds. */
function planarOf(f32: Float32Array, item: FxItem): Tensor {
  const t = tk.tensor(item.c, item.h, item.w)
  const n = item.w * item.h
  for (let i = 0; i < n; i++) for (let k = 0; k < item.c; k++) t.data[k * n + i] = f32[i * item.c + k]!
  return t
}

/** A library item's float (small cases), and Python's 8-bit forms derived from it (checked against Python's hashes). */
function pythonOf(item: ToneItem): { f32: Float32Array; round8: Uint8Array; trunc8: Uint8Array } {
  const raw = inflateSync(b64(item.f32z!))
  const f32 = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
  const t = planarOf(f32, item)
  const round8 = tk.quantize(t, 'round')
  const trunc8 = tk.quantize(t, 'trunc')
  expect(sha256(round8), 'Python round8 from its float').toBe(item.round8_sha256)
  expect(sha256(trunc8), 'Python trunc8 from its float').toBe(item.trunc8_sha256)
  return { f32, round8, trunc8 }
}

/**
 * 8-bit bytes against a library item, in one mode: a small item within the
 * band of its float; a hashed one by its band (each value there at most one
 * level off, and with Python's bytes put back there, the hash of the rest).
 */
function expectLibrary8(ts8: Uint8Array, item: ToneItem, mode: 'round' | 'trunc', eps: number, label: string): void {
  if (item.f32z) {
    const py = pythonOf(item)
    const want = mode === 'round' ? py.round8 : py.trunc8
    expect(ts8.length, label).toBe(want.length)
    let far = -1
    for (let i = 0; i < ts8.length; i++) {
      const d = Math.abs(ts8[i]! - want[i]!)
      if (d === 0) continue
      const v = py.f32[i]! * 255
      const edge = mode === 'trunc' ? Math.round(v) : Math.floor(v) + 0.5
      if (d > 1 || !(Math.abs(v - edge) < eps)) { far = i; break }
    }
    expect(far, `${label}: first byte outside the band (got ${ts8[far]}, want ${want[far]})`).toBe(-1)
    return
  }
  const patched = ts8.slice()
  for (const [i, py] of bandOf(item.band!, mode)) {
    expect(Math.abs(ts8[i]! - py), `${label}: band value ${i}`).toBeLessThanOrEqual(1)
    patched[i] = py
  }
  expect(sha256(patched), `${label}: outside the band`).toBe(mode === 'round' ? item.round8_sha256 : item.trunc8_sha256)
}

/** Interleaved 8-bit bytes of a tensor as a PNG would hold them. */
const bytes8 = (t: Tensor, mode: 'round' | 'trunc') => tk.quantize(t, mode)

/** A case's params as the core takes them (the table's `prepare`). */
function coreParams(c: ToneCase): Record<string, unknown> {
  const p = paramsOf(c as FxCase)
  const spec = EFFECTS[c.class_type]!
  return spec.prepare ? spec.prepare(p) : p
}

type Op = (inp: Record<string, Tensor>, p: Record<string, unknown>, stop?: () => boolean, state?: unknown, index?: number, count?: number) => { outputs: Tensor[]; preview: Tensor | null }

/** The case's outputs from the core called in this thread, one per batch index, each told its place in the batch. */
async function coreRun(c: ToneCase) {
  const op = coreOp(EFFECTS[c.class_type]!.op) as unknown as Op
  const rows = await tensorsOf(c as FxCase)
  return rows.map((inp, i) => op(inp, coreParams(c), undefined, {}, i, rows.length))
}

// ── The fixture file itself ──────────────────────────────────────────────────

describe('the tone fixtures', () => {
  it('cover the 26 classes, made by multi-threaded torch, with the same ε table as the script', () => {
    expect(FX.threads).toBeGreaterThan(1)
    expect([...new Set(FX.cases.map(c => c.class_type))].sort()).toEqual([...TONE_CLASSES].sort())
    expect(FX.library_eps).toEqual(LIBRARY_EPS)
    for (const eps of Object.values(LIBRARY_EPS)) expect(eps).toBeLessThanOrEqual(2 ** -8)
  })

  it('every class is ported: in the table, in the family, with a row', () => {
    for (const cls of TONE_CLASSES) {
      expect(EFFECTS[cls], cls).toMatchObject({ family: 'effects-tone', op: `tone.${cls}`, batch: 'pure' })
      expect(EFFECT_CLASSES_PORTED, cls).toContain(cls)
      expect(EFFECT_FAMILY_OF[cls], cls).toBe('effects-tone')
      expect(RUNNER_NODE_RULES[cls]?.family, cls).toBe('effects-tone')
      expect(typeof (effectCores.tone as unknown as Record<string, unknown>)[cls], cls).toBe('function')
    }
  })

  it('a Python raise is a 4-channel picture meeting a 3-channel step (torchvision\'s channel check or a broadcast)', () => {
    const errors = FX.cases.filter(c => c.error)
    expect(errors.length).toBeGreaterThan(300)
    for (const c of errors) {
      expect(['TypeError', 'RuntimeError'], c.name).toContain(c.error!.type)
      expect(c.error!.message, c.name).toMatch(/^Input image tensor permitted channel values are \[(1, 3|3, 1)\], but found 4$|^The size of tensor a \(4\) must match the size of tensor b \(3\) at non-singleton dimension 3$/)
      const sources = Object.values(c.inputs).map(i => i.source)
      expect(sources.some(s => s === 'provider' || s === 'card'), c.name).toBe(true)
    }
  })
})

// ── Every case (rule 12) ─────────────────────────────────────────────────────

describe('each class against Python', () => {
  for (const c of FX.cases) {
    const cls = c.class_type
    const eps = LIBRARY_EPS[cls]

    it(`core: ${c.name}`, async () => {
      if (c.error) {
        await expect(coreRun(c)).rejects.toThrow('EFFECT_NEEDS_RGB')
        return
      }
      const runs = await coreRun(c)
      const items = c.outputs![0]!.items
      expect(runs).toHaveLength(items.length)
      for (const [i, item] of items.entries()) {
        const t = runs[i]!.outputs[0]!
        expect([t.w, t.h, t.c], `${c.name}, picture ${i}`).toEqual([item.w, item.h, item.c])
        if (eps === undefined) {
          expectExactHash(interleaved(t), item.f32_sha256!, `${c.name}, picture ${i}`)
          continue
        }
        for (const mode of ['round', 'trunc'] as const) expectLibrary8(bytes8(t, mode), item, mode, eps, `${c.name}, picture ${i}, ${mode}`)
      }
    })

    it(`planEffect: ${c.name}`, async () => {
      if (c.error) {
        await expect(runEffectCase(c as FxCase, { families: TONE })).rejects.toThrow(EFFECT_ERROR_MESSAGES.EFFECT_NEEDS_RGB)
        return
      }
      const items = c.outputs![0]!.items
      // Read by nothing (or a provider): kept as the hand-off's round.
      const run = await runEffectCase(c as FxCase, { families: TONE })
      const files = filesOfValue(run.made.values[0])
      expect(files).toHaveLength(items.length)
      for (const [i, item] of items.entries()) {
        const got = await pngPixels(run.bytes(files[i]!))
        expect([got.w, got.h, got.channels]).toEqual([item.w, item.h, item.c])
        if (eps === undefined) expect(sha256(got.px), `${c.name}, kept ${i}`).toBe(item.round8_sha256)
        else expectLibrary8(got.px, item, 'round', eps, `${c.name}, kept ${i}`)
      }
      // The live preview: the first picture as save_live_preview writes it (Python's is its trunc8).
      expect(c.preview!.px_sha256).toBe(items[0]!.trunc8_sha256)
      expect(run.previews).toHaveLength(1)
      expect(run.previews[0]!.filename).toBe(c.preview!.filename)
      const pv = await pngPixels(run.previews[0]!.bytes)
      expect([pv.w, pv.h, pv.channels]).toEqual([c.preview!.w, c.preview!.h, c.preview!.mode.length])
      if (eps === undefined) expect(sha256(pv.px)).toBe(c.preview!.px_sha256)
      else expectLibrary8(pv.px, items[0]!, 'trunc', eps, `${c.name}, preview`)
      expect(run.made.ui).toEqual({
        images: c.ui!.images.map(im => ({ filename: im.filename, subfolder: 'sailor_runner', type: im.type })),
        animated: c.ui!.animated,
      })
      // Read only by Save image: kept as save_images writes it (trunc).
      const p = pictureOf(c as FxCase)
      const saved = await runEffectCase(c as FxCase, { families: TONE, prompt: { ...p.prompt, save: saveImage([c.node_id, 0]) } })
      const tfiles = filesOfValue(saved.made.values[0])
      for (const [i, item] of items.entries()) {
        const got = await pngPixels(saved.bytes(tfiles[i]!))
        if (eps === undefined) expect(sha256(got.px), `${c.name}, kept trunc ${i}`).toBe(item.trunc8_sha256)
        else expectLibrary8(got.px, item, 'trunc', eps, `${c.name}, kept trunc ${i}`)
      }
    }, c.hashed ? 60_000 : 20_000)
  }

  it('each library class\'s ε is at least twice the worst difference measured, and at most 2⁻⁸', async () => {
    const measured = new Map<string, number>()
    const clamp = (v: number) => Math.min(1.01, Math.max(-0.01, v))
    for (const c of FX.cases.filter(x => !x.error && isLibrary(x.class_type) && !x.hashed)) {
      const runs = await coreRun(c)
      for (const [i, item] of c.outputs![0]!.items.entries()) {
        const py = pythonOf(item).f32
        const got = interleaved(runs[i]!.outputs[0]!)
        let w = measured.get(c.class_type) ?? 0
        for (let j = 0; j < py.length; j++) w = Math.max(w, Math.abs(clamp(got[j]!) - clamp(py[j]!)) * 255)
        measured.set(c.class_type, w)
      }
    }
    console.info(`tone library ε measured (worst |Δ|·255): ${[...measured].map(([k, v]) => `${k} ${v.toExponential(2)}`).join(', ')}`)
    for (const [cls, eps] of Object.entries(LIBRARY_EPS)) {
      expect(measured.has(cls), cls).toBe(true)
      expect(2 * measured.get(cls)!, cls).toBeLessThanOrEqual(eps)
      expect(eps, cls).toBeLessThanOrEqual(2 ** -8)
    }
  }, 120_000)
})

// ── Batches: the long sum's split (R2.2's layout rule) ───────────────────────

describe('contrast\'s mean follows the batch torch worked on', () => {
  it('one 320×200 picture is summed split between threads, two are each summed on one thread: told a batch of one, the pair would not match', async () => {
    const pair = FX.cases.find(c => c.name === 'AdjustBrightnessContrast: contrast 1.5, a batch of two rgb 320×200')!
    const op = coreOp(EFFECTS.AdjustBrightnessContrast!.op) as unknown as Op
    const rows = await tensorsOf(pair as FxCase)
    const items = pair.outputs![0]!.items
    const asPair = rows.map((inp, i) => op(inp, coreParams(pair), undefined, {}, i, 2).outputs[0]!)
    const alone = rows.map(inp => op(inp, coreParams(pair), undefined, {}, 0, 1).outputs[0]!)
    let differs = 0
    for (const [i, item] of items.entries()) {
      expectExactHash(interleaved(asPair[i]!), item.f32_sha256!, `picture ${i}`)
      if (sha256(new Uint8Array(interleaved(alone[i]!).buffer)) !== item.f32_sha256) differs++
    }
    // The second picture's mean differs by an ulp between the two splits (the first's happens to agree).
    expect(differs).toBeGreaterThan(0)
    const one = FX.cases.find(c => c.name === 'AdjustBrightnessContrast: contrast 1.5, brightness 0.8, rgb 320×200')!
    const [inp] = await tensorsOf(one as FxCase)
    expectExactHash(interleaved(op(inp!, coreParams(one), undefined, {}, 0, 1).outputs[0]!), one.outputs![0]!.items[0]!.f32_sha256!)
  })

  it('through planEffect, the batch of two is worked as a batch of two (the worker passes the batch\'s size): the float handed on is Python\'s', async () => {
    const pair = FX.cases.find(c => c.name === 'AdjustBrightnessContrast: contrast 1.5, a batch of two rgb 320×200')!
    // Read by another effect, so the float tensor is kept beside each PNG (R2.1 fix round 1).
    const p = pictureOf(pair as FxCase)
    const run = await runEffectCase(pair as FxCase, { families: TONE, prompt: { ...p.prompt, next: effect('AdjustInvert', [pair.node_id, 0], { amount: 0 }) } })
    const value = run.made.values[0] as Extract<RunnerValue, { kind: 'files' }>
    const files = filesOfValue(value)
    expect(value.tensors).toHaveLength(2)
    for (const [i, item] of pair.outputs![0]!.items.entries()) {
      expectExactHash(interleaved(tk.fromTensorFile(run.bytes(value.tensors![i]!))), item.f32_sha256!, `picture ${i}, its float`)
      expectLibrary8((await pngPixels(run.bytes(files[i]!))).px, item, 'round', LIBRARY_EPS.AdjustBrightnessContrast!, `picture ${i}`)
    }
  })

  it('Dither\'s −0 (a round below zero) is kept only in torch\'s scalar tail: the black picture holds both', async () => {
    const c = FX.cases.find(x => x.name === 'Dither: black 67×5')!
    const [t] = (await coreRun(c)).map(r => r.outputs[0]!)
    const f = interleaved(t!)
    let negZero = 0
    let posZero = 0
    for (const v of f) { if (Object.is(v, -0)) negZero++; else if (v === 0) posZero++ }
    expect(negZero).toBeGreaterThan(0)
    expect(posZero).toBeGreaterThan(0)
    expectExactHash(f, c.outputs![0]!.items[0]!.f32_sha256!)
  })
})

// ── The colour text (gradientStops.ts) ───────────────────────────────────────

describe('colour text read as Python reads it', () => {
  const close = (a: readonly number[] | null, b: readonly number[] | null) => expect(a === null ? null : [...a]).toEqual(b === null ? null : [...b])

  it('parseStops deep-equals parse_stops on every recorded input', () => {
    expect(FX.stops.length).toBeGreaterThan(15)
    for (const s of FX.stops) {
      expect(stopsTextIsPortable(s.raw), s.raw).toBe(true)
      expect(parseStops(s.raw).map(([p, c]) => [p, [...c]]), s.raw).toEqual(s.parsed)
    }
  })

  it('parseDuotone and hexToRgb give parse_duotone\'s colours on every recorded input', () => {
    for (const d of FX.duotone) {
      expect(duotoneTextIsPortable(d.raw), d.raw).toBe(true)
      const [sh, hi] = parseDuotone(d.raw)
      // The pair's text is Python's str() of each value; a list or a dict (whose repr is
      // never a colour) has a stand-in, so only its colour is compared.
      let parsed: unknown = null
      try { parsed = JSON.parse(d.raw) }
      catch { /* not JSON: the default pair */ }
      const values = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.values(parsed) : []
      if (!values.some(v => v !== null && typeof v === 'object')) expect([sh, hi], d.raw).toEqual(d.pair)
      close(hexToRgb(sh, [0.1, 0.1, 0.3]), d.rgb[0])
      close(hexToRgb(hi, [1.0, 0.8, 0.4]), d.rgb[1])
    }
    expect(parseDuotone('[1]')).toEqual([...DEFAULT_DUOTONE])
  })

  it('hexToRgb deep-equals hex_to_rgb and _hex_to_rgb on every recorded input', () => {
    for (const h of FX.hex) {
      expect(hexTextIsPortable(h.text), JSON.stringify(h.text)).toBe(true)
      close(hexToRgb(h.text, null), h.gradient_map)
      close(hexToRgb(h.text, null), h.unicorn)
    }
  })

  it('text the runner can\'t read as Python does leaves the node to the engine', () => {
    const take = (cls: string, over: Record<string, unknown>) => runnerTakesNode({ 0: card('a.png'), fx: { class_type: cls, inputs: { image: ['0', 0], ...defaultsOf(cls), ...over } } }, 'fx', TONE)
    // Taken: the defaults and plain text.
    for (const cls of Object.keys(EFFECT_TEXT_WIDGETS)) expect(take(cls, {}), cls).toBe(true)
    expect(take('AdjustGradientMap', { stops: 'not json' })).toBe(true)
    expect(take('TwoDLight', { color: ' #abc ' })).toBe(true)
    // json.loads reads NaN and Infinity, JSON.parse doesn't.
    expect(take('AdjustGradientMap', { stops: '[{"pos":NaN,"color":"#fff"}]' })).toBe(false)
    expect(take('Duotone', { duotone: '{"shadow":"#000","highlight":Infinity}' })).toBe(false)
    // A number colour: str() writes an int and a float differently, which JSON.parse loses.
    expect(take('AdjustGradientMap', { stops: '[{"pos":0,"color":123456}]' })).toBe(false)
    expect(take('Duotone', { duotone: '{"shadow":1e100}' })).toBe(false)
    // A position float() overflows on; int() / float() reading other scripts' digits.
    expect(take('AdjustGradientMap', { stops: `[{"pos":${'9'.repeat(400)},"color":"#fff"}]` })).toBe(false)
    expect(take('AdjustGradientMap', { stops: '[{"pos":"٠.٥","color":"#fff"}]' })).toBe(false)
    expect(take('GradientMap', { dark_color: '#١٢٣' })).toBe(false)
    expect(take('TwoDLight', { color: 123 })).toBe(false)
    expect(effectTextIsPortable('AdjustInvert', {})).toBe(true)
    // Only the four classes with colour text carry the check.
    for (const cls of EFFECT_CLASSES_PORTED) {
      const has = Object.prototype.hasOwnProperty.call(EFFECT_TEXT_WIDGETS, cls)
      expect(RUNNER_NODE_RULES[cls]!.inputCheck, cls).toEqual(has ? ['effect-preview-name', 'effect-output-size', 'effect-text'] : ['effect-preview-name', 'effect-output-size'])
    }
    for (const [cls, widgets] of Object.entries(EFFECT_TEXT_WIDGETS)) {
      for (const name of Object.keys(widgets)) expect(EFFECT_SCHEMAS[cls]!.widgets[name]!.type, `${cls}.${name}`).toBe('STRING')
    }
  })
})

// ── Eligibility and families (rule 12) ───────────────────────────────────────

const card = (image: string) => ({ class_type: 'Image', inputs: { image, export: false, filename_prefix: 'ComfyUI', batch_index: -1 } })
const outCard = (from: string) => ({ class_type: 'Image', inputs: { image: '', export: false, images: [from, 0], batch_index: -1 } })
const effect = (cls: string, from: [string, number], widgets: Record<string, unknown>) => ({ class_type: cls, inputs: { image: from, ...widgets } })
const SAVE = { filename_prefix: 'ComfyUI', format: 'png', quality: 90, lossless_webp: false, png_compression: 4, scale: 1, max_dimension: 0, embed_metadata: false }
const saveImage = (from: [string, number]) => ({ class_type: 'SaveImage', inputs: { images: from, ...SAVE } })
const editNode = (from: [string, number]) => ({ class_type: 'EditImageNode', inputs: { model: 'Nano Banana 2', input_image: from, prompt: 'warmer', output_format: 'png', seed: 0, resolution: '1K' } })
function frameWidgets(over: Record<string, unknown> = {}): Record<string, unknown> {
  const w: Record<string, unknown> = {}
  for (let i = 1; i <= 16; i++) {
    Object.assign(w, {
      [`layer${i}_x`]: 0, [`layer${i}_y`]: 0, [`layer${i}_rotation`]: 0, [`layer${i}_scale`]: 1,
      [`layer${i}_opacity`]: 1, [`layer${i}_blend`]: 'normal', [`layer${i}_z`]: i, [`layer${i}_protect`]: false, [`layer${i}_cloner`]: '',
    })
  }
  return { ...w, width: 0, height: 0, motion_params: '', ...over }
}
const put = (root: string, name: string, bytes: Uint8Array) => {
  const path = join(root, 'input', name)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, bytes)
}

describe('families', () => {
  it('with the family off, a workflow with the class is left to the engine and nodesNeedingEngine names it', () => {
    for (const cls of TONE_CLASSES) {
      const p: ApiPrompt = { 0: card('a.png'), fx: effect(cls, ['0', 0], defaultsOf(cls)) }
      expect(runnerTakesWorkflow(p, TONE), cls).toBe(true)
      expect(nodesNeedingEngine(p, { runnerOn: true, families: TONE, titleOf: id => id }), cls).toEqual([])
      for (const fam of [new Set<RunnerFamily>(['cards']), new Set<RunnerFamily>(['cards', 'effects-blur']), new Set<RunnerFamily>(['effects-tone'])]) {
        expect(runnerTakesWorkflow(p, fam), `${cls} ${[...fam]}`).toBe(false)
        expect(nodesNeedingEngine(p, { runnerOn: true, families: fam, titleOf: id => id }), `${cls} ${[...fam]}`).toEqual(['fx'])
      }
    }
  })

  it('node by node: each class, its source card and its reader, with cards and the family on and off', () => {
    for (const cls of TONE_CLASSES) {
      const q: ApiPrompt = { 0: card('a.png'), fx: effect(cls, ['0', 0], defaultsOf(cls)), e: editNode(['fx', 0]), o: outCard('e') }
      const take = (fam: RunnerFamily[]) => Object.fromEntries(Object.keys(q).map(id => [id, runnerTakesNode(q, id, new Set(fam))]))
      expect(take(['cards', 'effects-tone', 'fal-edit']), cls).toEqual({ 0: true, fx: true, e: true, o: true })
      expect(isRunnerEligible(q, TONE_EDIT), cls).toBe(true)
      for (const fam of [['effects-tone', 'fal-edit'], ['cards', 'fal-edit'], ['cards', 'effects-blur', 'fal-edit']] as RunnerFamily[][]) {
        expect(take(fam), `${cls} ${fam}`).toEqual({ 0: true, fx: false, e: true, o: true })
        expect(isRunnerEligible(q, new Set(fam)), `${cls} ${fam}`).toBe(false)
      }
    }
  })

  it('widgets ComfyUI would refuse leave it to the engine', () => {
    const take = (cls: string, over: Record<string, unknown>) => runnerTakesNode({ 0: card('a.png'), fx: effect(cls, ['0', 0], { ...defaultsOf(cls), ...over }) }, 'fx', TONE)
    expect(take('AdjustColor', { hue: 180 })).toBe(true)
    expect(take('AdjustColor', { hue: 180.5 })).toBe(false)
    expect(take('AdjustPhotoFilter', { color: 'sepia' })).toBe(true)
    expect(take('AdjustPhotoFilter', { color: 'teal' })).toBe(false)
    expect(take('TwoDLight', { blend: 'overlay' })).toBe(true)
    expect(take('TwoDLight', { blend: 'lighten' })).toBe(false)
    expect(take('Dither', { levels: 17 })).toBe(false)
    expect(take('Posterize', { per_channel: ['0', 0] })).toBe(false)
  })
})

// ── With every effects family off, nothing changes (rule 12) ─────────────────

/**
 * The graph with an effect of class `cls` (its defaults) spliced in after
 * every picture output: its readers read the effect instead.
 */
function spliceAfterPictures(p: ApiPrompt, cls: string): { prompt: ApiPrompt; count: number } {
  const out: ApiPrompt = JSON.parse(JSON.stringify(p))
  let count = 0
  for (const [id, n] of Object.entries(p)) {
    const slots = Object.prototype.hasOwnProperty.call(PICTURE_OUTPUTS, n.class_type) ? PICTURE_OUTPUTS[n.class_type]! : IMAGE_OUTPUT_CLASSES.has(n.class_type) ? [0] : []
    for (const slot of slots) {
      const fx = `fx_${id}_${slot}`
      for (const r of Object.values(out)) {
        for (const [name, v] of Object.entries(r.inputs ?? {})) {
          if (Array.isArray(v) && v.length === 2 && v[0] === id && v[1] === slot) r.inputs[name] = [fx, 0]
        }
      }
      out[fx] = effect(cls, [id, slot], defaultsOf(cls))
      count++
    }
  }
  return { prompt: out, count }
}

/** The prompt as the runner read it before R2.1: each effect class one it had never heard of. */
function withoutEffects(p: ApiPrompt): ApiPrompt {
  return Object.fromEntries(Object.entries(p).map(([id, n]) => [id, Object.prototype.hasOwnProperty.call(EFFECT_FAMILY_OF, n.class_type) ? { ...n, class_type: `${n.class_type}__unknown` } : n]))
}
const OFF_SETS: [string, RunnerFamily[]][] = [
  ['none', []],
  ['cards', ['cards']],
  ['cards, frame, fal-edit', ['cards', 'frame', 'fal-edit']],
  ['every family but the effects', RUNNER_FAMILIES.filter(f => !(EFFECT_FAMILIES as readonly string[]).includes(f))],
  ['every family but cards', ['fal-edit', 'frame', 'effects-tone', 'effects-blur']],
]
function sameAsBefore(p: ApiPrompt, label: string) {
  const old = withoutEffects(p)
  for (const [name, fam] of OFF_SETS) {
    const families = new Set(fam)
    const titleOf = (id: string) => id
    expect(nodesNeedingEngine(p, { runnerOn: true, families, titleOf }), `${label}, ${name}`).toEqual(nodesNeedingEngine(old, { runnerOn: true, families, titleOf }))
    expect(runnerTakesWorkflow(p, families), `${label}, ${name}`).toBe(runnerTakesWorkflow(old, families))
    expect(isRunnerEligible(p, families), `${label}, ${name}`).toBe(isRunnerEligible(old, families))
  }
}

describe('with every effects family off, the needs-the-engine lists are as before R2.1', () => {
  it('over synthetic graphs with each class in each place', () => {
    for (const cls of TONE_CLASSES) {
      const w = defaultsOf(cls)
      sameAsBefore({ 0: card('a.png'), fx: effect(cls, ['0', 0], w) }, `${cls} alone`)
      sameAsBefore({ 0: card('a.png'), fx: effect(cls, ['0', 0], w), e: editNode(['fx', 0]), o: outCard('e') }, `${cls} → edit`)
      sameAsBefore({ 0: card('a.png'), fx: effect(cls, ['0', 0], w), s: saveImage(['fx', 0]) }, `${cls} → save`)
      sameAsBefore({ 0: card('a.png'), fx: effect(cls, ['0', 0], w), f: { class_type: 'Compositor', inputs: frameWidgets({ layer1: ['fx', 0] }) } }, `${cls} → Frame`)
      sameAsBefore({ g: { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'x', aspect_ratio: '1:1', seed: 0, model_options: '{}' } }, fx: effect(cls, ['g', 0], w) }, `generate → ${cls}`)
    }
  })

  // The saved projects are this machine's own data: with the folder missing the check is skipped, visibly.
  const PROJECTS = resolve(__dirname, '../../../user/sailor/projects')
  const projectsIt = existsSync(PROJECTS) ? it : it.skip

  projectsIt('over every saved project graph, each with one of the 26 classes (in turn) spliced in after every picture', async () => {
    const { gunzipSync } = await import('node:zlib')
    const { graphToPrompt } = await import('~/lib/graph/graphToPrompt')
    const catalog = JSON.parse(gunzipSync(readFileSync(resolve(__dirname, '../../server/native/objectInfo.baseline.json.gz'))).toString('utf8'))
    let graphs = 0
    let spliced = 0
    let changedWhenOn = 0
    const used = new Set<string>()
    for (const uuid of readdirSync(PROJECTS).sort()) {
      let wf: { canvases?: { workflow: unknown }[] } | undefined
      try { wf = JSON.parse(readFileSync(join(PROJECTS, uuid, 'versions', 'current.json'), 'utf8')).workflow }
      catch { continue }
      for (const c of wf?.canvases ?? []) {
        let p: ApiPrompt
        try { p = graphToPrompt(c.workflow as never, catalog) }
        catch { continue }
        const cls = TONE_CLASSES[graphs % TONE_CLASSES.length]!
        graphs++
        const s = spliceAfterPictures(p, cls)
        if (!s.count) continue
        sameAsBefore(s.prompt, `${uuid} with ${cls}`)
        const on = new Set<RunnerFamily>(RUNNER_FAMILIES)
        if (JSON.stringify(nodesNeedingEngine(s.prompt, { runnerOn: true, families: on, titleOf: id => id })) !== JSON.stringify(nodesNeedingEngine(withoutEffects(s.prompt), { runnerOn: true, families: on, titleOf: id => id }))) changedWhenOn++
        spliced++
        used.add(cls)
      }
    }
    expect(graphs).toBeGreaterThanOrEqual(800)
    expect(spliced).toBeGreaterThanOrEqual(400)
    expect([...used].sort()).toEqual([...TONE_CLASSES].sort())
    expect(changedWhenOn).toBeGreaterThan(0)
    console.info(`tone families-off invariant: ${graphs} saved graphs, ${spliced} with a tone class spliced in, ${changedWhenOn} read differently with the effects on`)
  }, 300_000)
})

// ── The engine ───────────────────────────────────────────────────────────────

describe('the engine (cards and effects-tone on)', () => {
  const c = FX.cases.find(x => x.name === 'AdjustColorBalance: shadows_cr between (-0.26), card 23×19 see-through')!
  const fileName = c.inputs.image!.files[0]!
  const fileBytes = b64(FX.assets[fileName]!)
  const item = c.outputs![0]!.items[0]!

  it('an effect feeding Edit an image hands off its kept round-8 PNG', async () => {
    const k = makeKit({ hosted: false, deps: { families: () => TONE_EDIT } })
    put(k.root, fileName, fileBytes)
    const p: ApiPrompt = { 0: card(fileName), [c.node_id]: effect(c.class_type, ['0', 0], c.widgets), e: editNode([c.node_id, 0]), o: outCard('e') }
    expect(isRunnerEligible(p, TONE_EDIT)).toBe(true)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    const v = run.takes[0]!.nodes[c.node_id]!.values![0] as Extract<RunnerValue, { kind: 'files' }>
    const uploads = (k.upload.mock.calls as unknown as [Uint8Array, string][]).filter(([, name]) => name === v.files[0]!.filename)
    expect(uploads).toHaveLength(1)
    const sent = await pngPixels(uploads[0]![0])
    expect(sent.channels).toBe(4)
    expect(sha256(sent.px)).toBe(item.round8_sha256)
  })

  it('an effect → Save image saves the trunc picture', async () => {
    const k = makeKit({ hosted: false, deps: { families: () => TONE } })
    put(k.root, fileName, fileBytes)
    const p: ApiPrompt = { 0: card(fileName), [c.node_id]: effect(c.class_type, ['0', 0], c.widgets), s: saveImage([c.node_id, 0]) }
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.status).toBe('done')
    const saved = await pngPixels(new Uint8Array(readFileSync(join(k.root, 'output', 'ComfyUI_00001_.png'))))
    expect(saved.channels).toBe(4)
    expect(sha256(saved.px)).toBe(item.trunc8_sha256)
  })

  it('an effect → Frame: the Frame reads the effect\'s float tensor and renders Python\'s picture exactly', async () => {
    const ch = FX.frame
    const file = ch.inputs.image!.files[0]!
    const kept = createMemoryKeptBytes()
    const k = makeKit({ hosted: false, deps: { families: () => TONE_FRAME, kept } })
    put(k.root, file, b64(FX.assets[file]!))
    const fx = ch.effect
    const p: ApiPrompt = { 0: card(file), [fx.node_id]: effect(fx.class_type, ['0', 0], fx.widgets), f: { class_type: 'Compositor', inputs: frameWidgets({ ...ch.frame.widgets, layer1: [fx.node_id, 0] }) } }
    expect(isRunnerEligible(p, TONE_FRAME)).toBe(true)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    const v = run.takes[0]!.nodes[fx.node_id]!.values![0] as Extract<RunnerValue, { kind: 'files' }>
    expect(v.tensors).toHaveLength(1)
    const frameFile = run.takes[0]!.nodes.f!.outputs[0]!
    const frame = await pngPixels(new Uint8Array(readFileSync(join(k.root, frameFile.type, frameFile.subfolder, frameFile.filename))))
    expect([frame.w, frame.h, frame.channels]).toEqual([ch.frame.w, ch.frame.h, 3])
    expect(Buffer.compare(frame.px, b64(ch.frame.image8))).toBe(0)
  })
})

// ── The esbuild guard: the tone core with the kernels, built as Nitro builds server code ──

describe('esbuild guard: the tone core survives Nitro’s build, with its kernels', () => {
  const require = createRequire(import.meta.url)
  const pnpm = fileURLToPath(new URL('../../node_modules/.pnpm/', import.meta.url))
  const builds = readdirSync(pnpm).filter(d => /^esbuild@\d/.test(d)).map(d => join(pnpm, d, 'node_modules', 'esbuild'))
  const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../../server/runner/${rel}`, import.meta.url)), 'utf8')
  const dir = mkdtempSync(join(tmpdir(), 'tone-esbuild-'))
  // A class that reads the kernels (torchvision's hue and saturation), on an opaque card.
  const c = FX.cases.find(x => x.name === 'AdjustColor: hue between (-46.8), card 23×19 opaque')!

  it('finds an esbuild to build with', () => {
    expect(builds.length).toBeGreaterThan(0)
  })

  for (const esbuildDir of builds) {
    for (const minify of [false, true]) {
      it(`${esbuildDir.split('/').at(-3)} target es2019, minify ${minify}: the source-text cores run, in a Worker too`, async () => {
        const esb = require(esbuildDir) as typeof import('esbuild')
        const build = async (rel: string, name: string) => {
          let code = (await esb.transform(src(rel), { loader: 'ts', target: 'es2019', format: 'esm' })).code
          if (minify) code = (await esb.transform(code, { loader: 'js', target: 'es2019', minify: true })).code
          const file = join(dir, `${name}-${minify}.mjs`)
          writeFileSync(file, code)
          return await import(`${pathToFileURL(file).href}?${Math.random()}`) as Record<string, (...a: unknown[]) => unknown>
        }
        const px = await build('pixels/core.ts', 'pixels')
        const tkm = await build('effects/core/tensor.ts', 'tensor')
        const knm = await build('effects/core/kernels.ts', 'kernels')
        const tone = await build('effects/core/tone.ts', 'tone')
        const pxB = new Function(`return (${px.pixelsCore!.toString()})()`)()
        const tkB = new Function('px', `return (${tkm.tensorCore!.toString()})(px)`)(pxB)
        const knB = new Function('k', 'px', `return (${knm.kernelsCore!.toString()})(k, px)`)(tkB, pxB)
        const toneB = new Function('k', 'kn', `return (${tone.toneCore!.toString()})(k, kn)`)(tkB, knB) as Record<string, Op>
        const [inp] = await tensorsOf(c as FxCase)
        expectExactHash(interleaved(toneB.AdjustColor!(inp!, coreParams(c), undefined, {}, 0, 1).outputs[0]!), c.outputs![0]!.items[0]!.f32_sha256!, 'built in this thread')
        const cores = [
          { name: 'tk', fn: tkm.tensorCore as never, args: ['px'] },
          { name: 'kn', fn: knm.kernelsCore as never, args: ['tk', 'px'] },
          { name: 'tone', fn: tone.toneCore as never, args: ['tk', 'kn'] },
        ]
        const w = new Worker(workerScript(compositorCore, px.pixelsCore as never, cores), { eval: true, workerData: { stop: new SharedArrayBuffer(4) } })
        try {
          const reply = (m: Record<string, unknown>) => new Promise<any>((res) => { w.once('message', res); w.postMessage(m) })
          const { files } = pictureOf(c as FxCase)
          const raw = await decodeRaw(files[c.inputs.image!.files[0]!]!, 'card')
          expect((await reply({ id: 1, op: 'fx.begin', cls: c.class_type, fn: 'tone.AdjustColor', params: coreParams(c), count: 1 })).error).toBeUndefined()
          const r = await reply({ id: 2, op: 'fx.run', index: 0, inputs: { image: raw }, first: true, masks: [false], want: { round: [true], trunc: [false] } })
          expect(r.error).toBeUndefined()
          expect(sha256(r.value.outputs[0].round8)).toBe(c.outputs![0]!.items[0]!.round8_sha256)
          expect(sha256(r.value.preview.px)).toBe(c.preview!.px_sha256)
        }
        finally { await w.terminate() }
      }, 30_000)
    }
  }
})

// ── Stop ─────────────────────────────────────────────────────────────────────

describe('Stop', () => {
  it('every class stops within one 64-row block', () => {
    const x = tk.tensor(3, 256, 4)
    for (const cls of TONE_CLASSES) {
      const op = coreOp(EFFECTS[cls]!.op) as unknown as Op
      const spec = EFFECTS[cls]!
      const p = spec.prepare ? spec.prepare(defaultsOf(cls)) : defaultsOf(cls)
      let calls = 0
      expect(() => op({ image: x }, p, () => ++calls >= 2), cls).toThrow('Stopped')
      expect(calls, cls).toBeGreaterThanOrEqual(2)
    }
  })
})
