/**
 * R7.9: Lens · Depth of field in the server (family `lens-blur`, free;
 * server/runner/cards/lensBlur.ts, server/runner/effects/core/lens.ts),
 * against the real Python node (scripts/runner_effects_fixtures.py --group
 * lens → fixtures/runner-effects-lens.json), its depth wired in so the blur
 * is checked given the same depth. The port is *library* (the bokeh kernels
 * are summed by row spans in float64, torch's conv2d in its own order): each
 * case's float is within LENS_EPS (255-scale) of Python's, and its 8-bit forms
 * equal Python's except within that ε of a quantisation boundary, by one
 * level. Where Python fails on its focus text, the runner's fix is held to
 * what Python makes with the centre (`fixed`).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { inflateSync } from 'node:zlib'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import {
  b64, filesOfValue, loadFixtures, memoryIO, pictureOf, pngPixels, sha256, withAssets, type FxCase, type FxFile, type FxItem,
} from './__runner__/effectsParity'
import { effectCores } from '~~/server/runner/effects/cores'
import type { Tensor } from '~~/server/runner/effects/core/tensor'
import { decodeRaw, type PictureSource } from '~~/server/runner/compositor/decode'
import { __setLensDepthModelForTests, lensFocusOf, lensParamsOf, lensWork } from '~~/server/runner/cards/lensBlur'
import { planNode, type NodePlan } from '~~/server/runner/executors'
import { runnerFamilies } from '~~/server/runner/config'
import { DEPTH_MODEL, DEPTH_MODEL_FILES, DEPTH_MODEL_MAX_SIDE, depthModelReady } from '~~/server/utils/depthModel'
import { GRAPH_NODE_CREDITS, priceGraph } from '~~/server/utils/priceBook'
import { EFFECT_ERROR_MESSAGES, EFFECT_MAX_WORK, EFFECT_TOO_MUCH_WORK } from '#shared/runner/effects'
import type { ApiPrompt } from '#shared/runner/graph'
import { ALL_RUNNER_FAMILIES, LOCAL_MODEL_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import {
  LOCAL_RENDER_TYPES, PROVIDER_TYPES, RUNNER_NODE_RULES, SWITCHED_CLASSES, isRunnerEligible, outputKindsFor, runnerTakesNode, valueWiresAllowed,
} from '#shared/runner/eligibility'
import { RUNNER_OUTPUT_CLASSES, runnerTakesWorkflow } from '#shared/runner/validate'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { previewPlan } from '#shared/runner/livePreview'
import { LENS_BLUR_CLASS } from '#shared/runner/lensBlur'
import { runPreview, type PreviewDeps } from '~~/server/runner/preview'
import { makeKit } from './__runner__/kit'

interface LensItem extends FxItem { f32z?: string }
interface LensOutputs { kind: 'image'; items: LensItem[] }
interface LensCase extends Omit<FxCase, 'outputs'> {
  outputs?: LensOutputs[]
  fixed?: LensOutputs[]
  /** The depth not wired: the model's raw answer (a stand-in) the node resized and normalised itself. */
  depth_raw?: { w: number; h: number; f32: string }
}
interface LensFx extends Omit<FxFile, 'cases'> { cases: LensCase[]; library_eps: number }

const FX = withAssets(loadFixtures('lens') as unknown as FxFile) as unknown as LensFx

/**
 * The port's ε (255-scale): about 4× the worst |Δ| measured over the fixture
 * (3.19e-4; the test below measures it again), within R2 rule 10's 2⁻⁸. The
 * fixture script holds the same number (LENS_EPS).
 */
const LENS_EPS = 1.3e-3

const tk = effectCores.tk
const lens = effectCores.lens

/** A case's input `name` as the tensor Python held (its first picture), decoded as the runner decodes it. */
async function tensorIn(c: LensCase, name: string): Promise<Tensor | undefined> {
  const inp = c.inputs[name]
  if (!inp) return undefined
  if (inp.source === 'blank') return tk.fromPicture(await decodeRaw(null, 'blank'))
  const { files } = pictureOf(c as FxCase)
  return tk.fromPicture(await decodeRaw(files[inp.files[0]!]!, inp.source as PictureSource))
}

/** Python's H × W × C float32 of an item. */
function pythonF32(item: LensItem): Float32Array {
  const raw = inflateSync(b64(item.f32z!))
  return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
}

/** A planar tensor as Python's H × W × C. */
function interleave(t: Tensor): Float32Array {
  const n = t.w * t.h
  const out = new Float32Array(n * t.c)
  for (let k = 0; k < t.c; k++) for (let i = 0; i < n; i++) out[i * t.c + k] = t.data[k * n + i]!
  return out
}

/** Python's 8-bit forms of an interleaved float (round8: clamp then round half even; trunc8: clip then trunc). */
function py8(f32: Float32Array, mode: 'round' | 'trunc'): Uint8Array {
  const out = new Uint8Array(f32.length)
  for (let i = 0; i < f32.length; i++) {
    const v = f32[i]!
    if (mode === 'trunc') out[i] = Math.min(255, Math.max(0, Math.trunc(Math.fround(255 * v))))
    else {
      const x = Math.fround(Math.min(1, Math.max(0, v)) * 255)
      const r = Math.round(x)
      out[i] = r - x === 0.5 && r % 2 !== 0 ? r - 1 : r
    }
  }
  return out
}

/** Runs the core on a case: its picture, its wired depth, its settings as the plan reads them. */
async function runCore(c: LensCase, widgets: Record<string, unknown> = c.widgets): Promise<Tensor> {
  const inputs: Record<string, Tensor> = {}
  const image = await tensorIn(c, 'image')
  const depth = await tensorIn(c, 'depth')
  if (image) inputs.image = image
  if (depth) inputs.depth = depth
  if (c.depth_raw) {
    const raw = b64(c.depth_raw.f32)
    inputs.depthRaw = { c: 1, h: c.depth_raw.h, w: c.depth_raw.w, data: new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)) }
  }
  return lens.LensBlur(inputs, lensParamsOf(widgets)).outputs[0]!
}

/** The worst |Δ| (255-scale) between the port's float and Python's, and every 8-bit difference outside the band. */
function compare(t: Tensor, item: LensItem, eps: number): { worst: number; outside: number } {
  expect([t.w, t.h, t.c]).toEqual([item.w, item.h, item.c])
  const ts = interleave(t)
  const py = pythonF32(item)
  expect(sha256(py8(py, 'round')), 'Python round8 from its float').toBe(item.round8_sha256)
  expect(sha256(py8(py, 'trunc')), 'Python trunc8 from its float').toBe(item.trunc8_sha256)
  let worst = 0
  let outside = 0
  for (const mode of ['round', 'trunc'] as const) {
    const a = py8(ts, mode)
    const b = py8(py, mode)
    for (let i = 0; i < a.length; i++) {
      const d = Math.abs(a[i]! - b[i]!)
      if (d === 0) continue
      const v = py[i]! * 255
      const edge = mode === 'trunc' ? Math.round(v) : Math.floor(v) + 0.5
      if (d > 1 || !(Math.abs(v - edge) < eps)) outside++
    }
  }
  for (let i = 0; i < ts.length; i++) worst = Math.max(worst, Math.abs(ts[i]! - py[i]!) * 255)
  return { worst, outside }
}

describe('Lens · Depth of field: the blur, given the same depth (fixture)', () => {
  it('was written by the real node', () => {
    expect(FX.cases.length).toBeGreaterThan(50)
    expect(FX.library_eps).toBe(LENS_EPS)
  })

  for (const c of FX.cases) {
    it(c.name, async () => {
      if (c.error && !c.fixed) {
        // Python raises: a blur wider than the picture (torch's reflect pad), and so does the port.
        expect(c.error.type).toBe('RuntimeError')
        await expect(runCore(c)).rejects.toThrow(/./)
        let message = ''
        try { await runCore(c) }
        catch (e) { message = (e as Error).message }
        expect(EFFECT_ERROR_MESSAGES[message]).toBe(EFFECT_ERROR_MESSAGES.EFFECT_PICTURE_TOO_SMALL)
        return
      }
      const want = (c.fixed ?? c.outputs)!
      expect(want).toHaveLength(1)
      const t = await runCore(c)
      const { worst, outside } = compare(t, want[0]!.items[0]!, LENS_EPS)
      expect(outside, `bytes outside the band (worst |Δ| ${worst.toExponential(2)})`).toBe(0)
      expect(worst).toBeLessThan(LENS_EPS)
    })
  }

  it('the worst |Δ| over the fixture, and ε about 4× it at least', async () => {
    let worst = 0
    for (const c of FX.cases) {
      const want = c.fixed ?? c.outputs
      if (!want) continue
      worst = Math.max(worst, compare(await runCore(c), want[0]!.items[0]!, LENS_EPS).worst)
    }
    console.log(`lens worst |Δ| ${worst.toExponential(3)} (ε ${LENS_EPS.toExponential(3)}, ${(LENS_EPS / worst).toFixed(1)}×)`)
    expect(worst * 4).toBeLessThanOrEqual(LENS_EPS)
    expect(worst * 8).toBeGreaterThan(LENS_EPS)
  })
})

// ── Through the runner's plan (planNode → planLensBlur → the worker) ─────────

const ON: ReadonlySet<RunnerFamily> = new Set(['cards', 'lens-blur'])
const caseNamed = (name: string) => {
  const c = FX.cases.find(x => x.name === `LensBlur: ${name}`)
  if (!c) throw new Error(`no case ${name}`)
  return c
}

/** A case with other settings (its pictures still known to pictureOf). */
function withWidgets(c: LensCase, over: Record<string, unknown>): LensCase {
  const copy: LensCase = { ...c, widgets: { ...c.widgets, ...over } }
  withAssets({ ...FX, cases: [copy] } as unknown as FxFile)
  return copy
}

/** A case's node through planNode, its pictures in a memory store; `prompt` overrides the case's own. */
async function runPlan(c: LensCase, o: { hosted?: boolean; signal?: AbortSignal; prompt?: ApiPrompt; files?: Record<string, Uint8Array> } = {}) {
  const pic = pictureOf(c as FxCase)
  const prompt = o.prompt ?? pic.prompt
  const mem = memoryIO({ ...pic.files, ...o.files }, c.node_id, { hosted: o.hosted, signal: o.signal })
  const plan: NodePlan = await planNode({ prompt, nodeId: c.node_id, families: ON, gateOpen: false, hosted: o.hosted, filesFrom: pic.filesOf, toUrl: async () => '' })
  expect(plan.kind).toBe('derive')
  const made = await (plan as Extract<NodePlan, { kind: 'derive' }>).derive(mem.io)
  return { made, mem }
}

/** A stand-in for Depth Anything that answers a case's recorded raw depth, counting its calls and the sizes it was handed. */
function standInModel(raw: { w: number; h: number; f32: string }) {
  const seen: { w: number; h: number; bytes: number }[] = []
  const model = vi.fn(async (rgb: Uint8Array, w: number, h: number) => {
    seen.push({ w, h, bytes: rgb.length })
    const b = b64(raw.f32)
    return { w: raw.w, h: raw.h, data: new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) }
  })
  return { model, seen }
}

afterEach(() => __setLensDepthModelForTests(null))

describe('Lens · Depth of field through the runner', () => {
  for (const name of ['defaults', 'everything at once, hexagonal', '4-channel picture', 'card picture, wider', 'a batch: the first picture only']) {
    it(`${name}: the kept picture and the live preview are Python's (8-bit, within the band)`, async () => {
      const c = caseNamed(name)
      const { made, mem } = await runPlan(c)
      const item = c.outputs![0]!.items[0]!
      const py = pythonF32(item)
      // Read by nothing but the run: kept as the hand-off's round8.
      const kept = await pngPixels(mem.bytes(filesOfValue(made.values[0])[0]!))
      expect([kept.w, kept.h, kept.channels]).toEqual([item.w, item.h, item.c])
      const band = (a: Uint8Array, b: Uint8Array, mode: 'round' | 'trunc') => {
        for (let i = 0; i < a.length; i++) {
          const d = Math.abs(a[i]! - b[i]!)
          if (!d) continue
          const v = py[i]! * 255
          const edge = mode === 'trunc' ? Math.round(v) : Math.floor(v) + 0.5
          expect(d <= 1 && Math.abs(v - edge) < LENS_EPS, `${mode} byte ${i}: ${a[i]} vs ${b[i]}`).toBe(true)
        }
      }
      band(kept.px, py8(py, 'round'), 'round')
      // The live preview: save_live_preview's name and its trunc8.
      expect(made.ui).toEqual({ images: [{ filename: `live_preview_${c.node_id}.png`, subfolder: 'sailor_runner', type: 'temp' }], animated: [false] })
      expect(c.ui!.images[0]!.filename).toBe(`live_preview_${c.node_id}.png`)
      expect(mem.previews).toHaveLength(1)
      const shown = await pngPixels(mem.previews[0]!.bytes)
      band(shown.px, py8(py, 'trunc'), 'trunc')
    })
  }

  it('Python\'s raise (a blur wider than the picture) fails the node in plain words, before anything is kept', async () => {
    const c = caseNamed('too small for its blur')
    const { io, kept } = memoryIO(pictureOf(c as FxCase).files, c.node_id)
    const plan = await planNode({ prompt: pictureOf(c as FxCase).prompt, nodeId: c.node_id, families: ON, gateOpen: false, filesFrom: pictureOf(c as FxCase).filesOf, toUrl: async () => '' })
    await expect((plan as Extract<NodePlan, { kind: 'derive' }>).derive(io)).rejects.toThrow(EFFECT_ERROR_MESSAGES.EFFECT_PICTURE_TOO_SMALL)
    expect(kept()).toBe(0)
  })

  it('a wired depth never runs the model', async () => {
    const spy = vi.fn(async () => { throw new Error('the model ran') })
    __setLensDepthModelForTests(spy)
    await runPlan(caseNamed('defaults'))
    expect(spy).not.toHaveBeenCalled()
  })

  it('an unwired depth runs the model once per picture (cached by its sha256), and the result is Python\'s given the same answer', async () => {
    const c = caseNamed('the model\'s depth, resized and normalised')
    expect(c.inputs.depth).toBeUndefined()
    const { model, seen } = standInModel(c.depth_raw!)
    __setLensDepthModelForTests(model)
    const first = await runPlan(c)
    const item = c.outputs![0]!.items[0]!
    const py = pythonF32(item)
    const kept = await pngPixels(first.mem.bytes(filesOfValue(first.made.values[0])[0]!))
    for (let i = 0; i < kept.px.length; i++) {
      const d = Math.abs(kept.px[i]! - py8(py, 'round')[i]!)
      if (d) expect(d).toBe(1)
    }
    expect(sha256(kept.px)).toBe(item.round8_sha256)
    expect(model).toHaveBeenCalledTimes(1)
    // The model is handed the picture's RGB (no alpha), at most 518 on a side.
    expect(seen[0]).toEqual({ w: 48, h: 40, bytes: 48 * 40 * 3 })
    // The same picture again (a slider drag): the depth is cached, the blur redone.
    await runPlan(withWidgets(c, { aperture: 0.3 }))
    expect(model).toHaveBeenCalledTimes(1)
    // Another picture: the model runs for it.
    const other = caseNamed('the model\'s depth, wider picture, hexagonal')
    await runPlan(other)
    expect(model).toHaveBeenCalledTimes(2)
  })

  it('the model sees a large picture shrunk to fit 518 × 518', async () => {
    const c = caseNamed('the model\'s depth, resized and normalised')
    const { model, seen } = standInModel(c.depth_raw!)
    __setLensDepthModelForTests(model)
    const big = await sharp({ create: { width: 1600, height: 400, channels: 3, background: { r: 90, g: 120, b: 40 } } }).png().toBuffer()
    const file = c.inputs.image!.files[0]!
    await runPlan(withWidgets(c, { aperture: 0.2 }), { files: { [file]: new Uint8Array(big) } })
    expect(seen).toEqual([{ w: DEPTH_MODEL_MAX_SIDE, h: 130, bytes: DEPTH_MODEL_MAX_SIDE * 130 * 3 }])
  })

  it('Python\'s 1×1 blank with no depth wired: no model (one pixel\'s normalised depth is 0)', async () => {
    const spy = vi.fn(async () => { throw new Error('the model ran') })
    __setLensDepthModelForTests(spy)
    const c = caseNamed('the 1×1 blank, in focus')
    const prompt = pictureOf(c as FxCase).prompt
    const { depth: _d, ...inputs } = prompt[c.node_id]!.inputs
    delete prompt.src_depth
    const { made } = await runPlan(c, { prompt: { ...prompt, [c.node_id]: { class_type: LENS_BLUR_CLASS, inputs } } })
    expect(filesOfValue(made.values[0])).toHaveLength(1)
    expect(spy).not.toHaveBeenCalled()
  })

  it('too much work is refused before any pixel is decoded or the model runs (hosted: 4096², aperture 1)', async () => {
    expect(lensWork(1, { w: 4096, h: 4096 }, true)).toBeGreaterThan(EFFECT_MAX_WORK)
    expect(lensWork(0.4, { w: 4096, h: 4096 }, true)).toBeLessThan(EFFECT_MAX_WORK)
    const spy = vi.fn(async () => { throw new Error('the model ran') })
    __setLensDepthModelForTests(spy)
    const c = caseNamed('the model\'s depth, resized and normalised')
    const big = await sharp({ create: { width: 4096, height: 4096, channels: 3, background: { r: 9, g: 9, b: 9 } } }).png().toBuffer()
    const file = c.inputs.image!.files[0]!
    await expect(runPlan(withWidgets(c, { aperture: 1 }), { hosted: true, files: { [file]: new Uint8Array(big) } })).rejects.toThrow(EFFECT_TOO_MUCH_WORK)
    expect(spy).not.toHaveBeenCalled()
  })

  it('Stop: nothing is kept, the model is not asked', async () => {
    const spy = vi.fn(async () => { throw new Error('the model ran') })
    __setLensDepthModelForTests(spy)
    const c = caseNamed('the model\'s depth, resized and normalised')
    const ctrl = new AbortController()
    ctrl.abort()
    const pic = pictureOf(c as FxCase)
    const mem = memoryIO(pic.files, c.node_id, { signal: ctrl.signal })
    const plan = await planNode({ prompt: pic.prompt, nodeId: c.node_id, families: ON, gateOpen: false, filesFrom: pic.filesOf, toUrl: async () => '' })
    await expect((plan as Extract<NodePlan, { kind: 'derive' }>).derive(mem.io)).rejects.toThrow('Stopped')
    expect(mem.kept()).toBe(0)
    expect(mem.previews).toHaveLength(0)
    expect(spy).not.toHaveBeenCalled()
  })

  it('a Stop while the model answers: the answer is cached, nothing is kept', async () => {
    const c = caseNamed('the model\'s depth, resized and normalised')
    const ctrl = new AbortController()
    const { model } = standInModel(c.depth_raw!)
    __setLensDepthModelForTests(async (rgb, w, h) => { const r = await model(rgb, w, h); ctrl.abort(); return r })
    const pic = pictureOf(c as FxCase)
    const mem = memoryIO(pic.files, c.node_id, { signal: ctrl.signal })
    const plan = await planNode({ prompt: pic.prompt, nodeId: c.node_id, families: ON, gateOpen: false, filesFrom: pic.filesOf, toUrl: async () => '' })
    await expect((plan as Extract<NodePlan, { kind: 'derive' }>).derive(mem.io)).rejects.toThrow('Stopped')
    expect(mem.kept()).toBe(0)
    expect(mem.previews).toHaveLength(0)
  })
})

// ── The focus text ───────────────────────────────────────────────────────────

describe('the focus text, as Python reads it (and its fix)', () => {
  it('reads as json.loads + float(), the centre where it can\'t', () => {
    expect(lensFocusOf('{"x":0.2,"y":0.8}')).toEqual({ fx: 0.2, fy: 0.8 })
    expect(lensFocusOf('')).toEqual({ fx: 0.5, fy: 0.5 })
    expect(lensFocusOf('not json')).toEqual({ fx: 0.5, fy: 0.5 })
    expect(lensFocusOf('{"x":"0.3","y":" 0.6 "}')).toEqual({ fx: 0.3, fy: 0.6 })
    expect(lensFocusOf('{"x":true,"y":null}')).toEqual({ fx: 0.5, fy: 0.5 })
    expect(lensFocusOf('{"y":0.1}')).toEqual({ fx: 0.5, fy: 0.1 })
    expect(lensFocusOf('{"x":1,"y":1,"x":0.1}')).toEqual({ fx: 0.1, fy: 1 })
    expect(lensFocusOf('{"x":"1_0","y":0.25}')).toEqual({ fx: 10, fy: 0.25 })
    // Python fails on these (AttributeError, ValueError, OverflowError): the centre, the fix.
    for (const t of ['[0.2,0.8]', '"0.3"', 'null', '7', '{"x":NaN,"y":0.5}', '{"x":Infinity,"y":0.5}', `{"x":1${'0'.repeat(400)},"y":0.5}`]) {
      expect(lensFocusOf(t), t).toEqual({ fx: 0.5, fy: 0.5 })
    }
  })

  it('the lens preset changes nothing (Python hands every setting over explicitly)', () => {
    const c = caseNamed('defaults')
    for (const preset of ['85mm Portrait', 'Vintage Swirly', 'Anamorphic', 'Clean']) {
      expect(lensParamsOf({ ...c.widgets, lens_preset: preset })).toEqual(lensParamsOf(c.widgets))
    }
  })
})

// ── Eligibility (family `lens-blur`, free) ───────────────────────────────────

const LOAD = { class_type: 'LoadImage', inputs: { image: 'image.png', upload: 'image' } }
const SAVE_DEFAULTS = { filename_prefix: 'ComfyUI', format: 'png', quality: 90, lossless_webp: false, png_compression: 4, scale: 1, max_dimension: 0, embed_metadata: true }
const lensNode = (over: Record<string, unknown> = {}, image: unknown = ['l', 0]): ApiPrompt[string] =>
  ({ class_type: LENS_BLUR_CLASS, inputs: { image, ...caseNamed('defaults').widgets, ...over } })

describe('the rule row: a local render of `lens-blur`, free', () => {
  it('its row, switched class, output node and picture; nothing priced', () => {
    expect(LOCAL_MODEL_FAMILIES).toContain('lens-blur')
    expect(RUNNER_NODE_RULES[LENS_BLUR_CLASS]!.family).toBe('lens-blur')
    expect(RUNNER_NODE_RULES[LENS_BLUR_CLASS]!.local).toBe('render')
    expect(SWITCHED_CLASSES[LENS_BLUR_CLASS]).toBe('lens-blur')
    expect(RUNNER_OUTPUT_CLASSES.has(LENS_BLUR_CLASS)).toBe(true)
    expect(PROVIDER_TYPES.has(LENS_BLUR_CLASS)).toBe(false)
    expect(LOCAL_RENDER_TYPES.has(LENS_BLUR_CLASS)).toBe(true)
    expect(GRAPH_NODE_CREDITS[LENS_BLUR_CLASS]).toBeUndefined()
    const p: ApiPrompt = { l: LOAD, n: lensNode(), s: { class_type: 'SaveImage', inputs: { images: ['n', 0], ...SAVE_DEFAULTS } } }
    // Charges nothing of its own: only the run's render credit, as on the ComfyUI path.
    const price = priceGraph(p, { families: ON })
    expect(price.nodes).toEqual({})
    expect(price.credits).toBe(priceGraph(p, { families: new Set() }).credits)
  })

  it('with `lens-blur` on the runner takes it (picture and depth from pictures); off, the engine', () => {
    const p: ApiPrompt = { l: LOAD, n: lensNode(), s: { class_type: 'SaveImage', inputs: { images: ['n', 0], ...SAVE_DEFAULTS } } }
    expect(runnerTakesNode(p, 'n', ON)).toBe(true)
    expect(runnerTakesWorkflow(p, ON)).toBe(true)
    expect(nodesNeedingEngine(p, { runnerOn: true, families: ON, titleOf: id => id })).toEqual([])
    expect(runnerTakesNode(p, 'n', new Set(['cards']))).toBe(false)
    expect(nodesNeedingEngine(p, { runnerOn: true, families: new Set(['cards']), titleOf: id => id })).toEqual(['n', 's'])
    // A depth wired from a picture.
    const d: ApiPrompt = { l: LOAD, m: { ...LOAD, inputs: { image: 'depth.png', upload: 'image' } }, n: lensNode({ depth: ['m', 0] }) }
    expect(runnerTakesNode(d, 'n', ON)).toBe(true)
    // A depth (or picture) wired from what isn't a picture to the runner goes to the engine.
    const t: ApiPrompt = { l: LOAD, x: { class_type: 'PrimitiveString', inputs: { value: 'x' } }, n: lensNode({ depth: ['x', 0] }) }
    expect(runnerTakesNode(t, 'n', ON)).toBe(false)
    // Its picture feeds an effect as a picture while it is on.
    const fx: ApiPrompt = { l: LOAD, n: lensNode(), b: { class_type: 'AdjustInvert', inputs: { image: ['n', 0], amount: 1 } } }
    expect(runnerTakesNode(fx, 'b', new Set(['cards', 'lens-blur', 'effects-tone']))).toBe(true)
    expect(runnerTakesNode(fx, 'b', new Set(['cards', 'effects-tone']))).toBe(false)
  })

  it('settings ComfyUI refuses, or wired, go to the engine; no picture wired goes to the engine', () => {
    for (const over of [{ aperture: 1.5 }, { focus_offset: -2 }, { lens_preset: 'Fisheye' }, { bokeh_shape: 'star' }, { vignette: ['x', 0] }, { focus_point: ['x', 0] }]) {
      const p: ApiPrompt = { l: LOAD, x: { class_type: 'PrimitiveFloat', inputs: { value: 1 } }, n: lensNode(over) }
      expect(runnerTakesNode(p, 'n', ON), JSON.stringify(over)).toBe(false)
    }
    expect(runnerTakesNode({ n: lensNode({}, undefined) }, 'n', ON)).toBe(false)
  })

  it('the live preview works it out with `lens-blur` on, pinning its picture\'s maker', () => {
    const p: ApiPrompt = { g: { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a fox', aspect_ratio: '1:1', seed: 0, model_options: '{}' } }, n: lensNode({}, ['g', 0]) }
    expect(previewPlan(p, 'n', new Set(['cards', 'lens-blur', 'live-previews']))).toEqual({ order: ['n'], pins: ['g'] })
    expect(previewPlan(p, 'n', new Set(['cards', 'live-previews']))).toBeNull()
  })
})

describe('the live preview (R2.11\'s route)', () => {
  it('a drag previews Lens · Depth of field: free, its depth estimated once, only the blur redone', async () => {
    const families: ReadonlySet<RunnerFamily> = new Set(['cards', 'lens-blur', 'live-previews'])
    const kit = makeKit({ deps: { families: () => families } })
    const deps: PreviewDeps = {
      runnerOn: () => true, families: () => families, hosted: () => false, results: kit.deps.results,
      ownership: { ownsInput: async () => true, ownsOutput: async () => true },
    }
    const c = caseNamed('the model\'s depth, resized and normalised')
    const file = c.inputs.image!.files[0]!
    mkdirSync(join(kit.root, 'input'), { recursive: true })
    writeFileSync(join(kit.root, 'input', file), pictureOf(c as FxCase).files[file]!)
    const { model } = standInModel(c.depth_raw!)
    __setLensDepthModelForTests(model)
    const prompt = (aperture: number): ApiPrompt => ({
      1: { class_type: 'Image', inputs: { image: file, export: false, filename_prefix: 'ComfyUI', batch_index: -1 } },
      7: { class_type: LENS_BLUR_CLASS, inputs: { image: ['1', 0], ...c.widgets, aperture } },
    })
    const pinned = { 1: [{ filename: file, subfolder: '', type: 'input' as const }] }
    for (const aperture of [0.8, 0.5, 0.2]) {
      const res = await runPreview({ userId: null, body: { canvasId: 'c1', nodeId: '7', prompt: prompt(aperture), pinned } }, deps)
      expect(res.ui).toEqual({ images: [{ filename: 'live_preview_7.png', subfolder: 'sailor_runner', type: 'temp' }], animated: [false] })
    }
    expect(model).toHaveBeenCalledTimes(1)
    expect(kit.ledger.hold).not.toHaveBeenCalled()
    // With `lens-blur` off, the browser runs it as before (a full run).
    const off: PreviewDeps = { ...deps, families: () => new Set(['cards', 'live-previews']) }
    await expect(runPreview({ userId: null, body: { canvasId: 'c1', nodeId: '7', prompt: prompt(0.4), pinned } }, off)).rejects.toMatchObject({ statusCode: 409 })
  })
})

describe('the depth model\'s files (hosted: shipped, never fetched)', () => {
  const dirs: string[] = []
  const env = { ...process.env }
  afterAll(() => {
    process.env = env
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })

  it('`lens-blur` answers as off while the files are missing, on once they are there at their sizes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'depth-model-'))
    dirs.push(dir)
    process.env.NUXT_DEPTH_MODEL_DIR = dir
    process.env.NUXT_RUNNER_ENABLED = 'true'
    process.env.NUXT_RUNNER_FAMILIES = 'cards,lens-blur'
    expect(depthModelReady()).toBe(false)
    expect([...runnerFamilies()]).toEqual(['cards'])
    for (const f of DEPTH_MODEL_FILES) {
      const p = join(dir, DEPTH_MODEL, f.path)
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, '')
      // A file of the wrong size is not the model.
      if (f.bytes > 1000) expect(depthModelReady()).toBe(false)
      truncateSync(p, f.bytes)
    }
    expect(depthModelReady()).toBe(true)
    expect([...runnerFamilies()].sort()).toEqual(['cards', 'lens-blur'])
  })
})

// ── With `lens-blur` off, nothing changes (R3 rule 15) ───────────────────────

describe('with `lens-blur` off, nothing changes', () => {
  const OFF_SETS: [string, RunnerFamily[]][] = [
    ['none', []],
    ['cards only', ['cards']],
    ['every family but R7\'s', ALL_RUNNER_FAMILIES.filter(x => !LOCAL_MODEL_FAMILIES.includes(x))],
  ]
  const before = (p: ApiPrompt): ApiPrompt => Object.fromEntries(Object.entries(p).map(([id, n]) => [id, n.class_type === LENS_BLUR_CLASS ? { ...n, class_type: 'LensBlurBefore' } : n]))
  function sameAsBefore(p: ApiPrompt, label: string) {
    const old = before(p)
    for (const [name, fam] of OFF_SETS) {
      const families = new Set(fam)
      const titleOf = (id: string) => id
      expect(nodesNeedingEngine(p, { runnerOn: true, families, titleOf }), `${label}, ${name}`).toEqual(nodesNeedingEngine(old, { runnerOn: true, families, titleOf }))
      expect(isRunnerEligible(p, families), `${label}, ${name}`).toBe(isRunnerEligible(old, families))
      for (const id of Object.keys(p)) {
        expect(runnerTakesNode(p, id, families), `${label} ${id}, ${name}`).toBe(runnerTakesNode(old, id, families))
        if (p[id]!.class_type !== LENS_BLUR_CLASS) expect(valueWiresAllowed(p, id, outputKindsFor(families)), `${label} ${id}, ${name}`).toBe(valueWiresAllowed(old, id, outputKindsFor(families)))
      }
      expect(outputKindsFor(families)[LENS_BLUR_CLASS]).toBeUndefined()
      expect(previewPlan(p, Object.keys(p).find(id => p[id]!.class_type === LENS_BLUR_CLASS) ?? '', families)).toBeNull()
    }
  }

  it('over one synthetic graph per chain (Save image, an effect, a Frame, an Image card, a depth)', () => {
    sameAsBefore({ l: LOAD, n: lensNode(), s: { class_type: 'SaveImage', inputs: { images: ['n', 0], ...SAVE_DEFAULTS } } }, '→ Save image')
    sameAsBefore({ l: LOAD, n: lensNode(), b: { class_type: 'AdjustInvert', inputs: { image: ['n', 0], amount: 1 } } }, '→ an effect')
    sameAsBefore({ l: LOAD, n: lensNode(), f: { class_type: 'Compositor', inputs: { layer1: ['n', 0], width: 0, height: 0 } } }, '→ Frame')
    sameAsBefore({
      a: { class_type: 'Image', inputs: { image: 'x.png', export: false, batch_index: -1 } }, n: lensNode({}, ['a', 0]),
      b: { class_type: 'Image', inputs: { image: '', export: false, images: ['n', 0], batch_index: -1 } },
    }, 'Image card chain')
    sameAsBefore({ l: LOAD, m: { ...LOAD, inputs: { image: 'd.png', upload: 'image' } }, n: lensNode({ depth: ['m', 0] }) }, 'a depth wired')
  })

  const PROJECTS = resolve(__dirname, '../../../user/sailor/projects')
  const projectsIt = existsSync(PROJECTS) ? it : it.skip

  projectsIt('over every saved project graph', async () => {
    const { gunzipSync } = await import('node:zlib')
    const { graphToPrompt } = await import('~/lib/graph/graphToPrompt')
    const catalog = JSON.parse(gunzipSync(readFileSync(resolve(__dirname, '../../server/native/objectInfo.baseline.json.gz'))).toString('utf8'))
    let graphs = 0
    let withIt = 0
    for (const uuid of readdirSync(PROJECTS).sort()) {
      let wf: { canvases?: { workflow: unknown }[] } | undefined
      try { wf = JSON.parse(readFileSync(join(PROJECTS, uuid, 'versions', 'current.json'), 'utf8')).workflow }
      catch { continue }
      for (const cv of wf?.canvases ?? []) {
        let p: ApiPrompt
        try { p = graphToPrompt(cv.workflow as never, catalog) }
        catch { continue }
        graphs++
        if (Object.values(p).some(n => n.class_type === LENS_BLUR_CLASS)) withIt++
        sameAsBefore(p, uuid)
      }
    }
    expect(graphs).toBeGreaterThanOrEqual(800)
    console.info(`lens-blur families-off invariant: ${graphs} saved graphs, ${withIt} with Lens · Depth of field`)
  }, 600_000)
})
