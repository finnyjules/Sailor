/**
 * R2.5: the blur and convolution effects (family effects-blur,
 * server/runner/effects/core/blur.ts), against the real Python nodes
 * (scripts/runner_effects_fixtures.py --group blur →
 * fixtures/runner-effects-blur.json). Every class is *library* (conv2d or a
 * transcendental function): its 8-bit output equals Python's except where
 * Python's float lies within its class's ε of a quantisation boundary
 * (LIBRARY_EPS), and there by one level. Sparkle's topk keeps the lower
 * index among values tied at its cut; where torch kept others, the case is
 * held to what the node makes with the runner's choice (`stable_outputs`),
 * and the two kept sets may differ only among the tied values.
 */
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inflateSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { makeKit } from './__runner__/kit'
import {
  b64, bandOf, coreOp, filesOfValue, interleaved, loadFixtures, memoryIO, paramsOf, pictureOf, pngPixels,
  runEffectCase, sha256, tensorsOf, withAssets, type FxCase, type FxFile, type FxItem,
} from './__runner__/effectsParity'
import type { ApiPrompt } from '#shared/runner/graph'
import { RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { IMAGE_OUTPUT_CLASSES, PICTURE_OUTPUTS, RUNNER_NODE_RULES, isRunnerEligible, runnerTakesNode } from '#shared/runner/eligibility'
import { runnerTakesWorkflow } from '#shared/runner/validate'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import {
  EFFECT_CLASSES_PORTED, EFFECT_ERROR_MESSAGES, EFFECT_FAMILIES, EFFECT_FAMILY_OF, EFFECT_MAX_WORK, EFFECT_PICTURES_TOO_LARGE,
  EFFECT_PICTURE_TOO_LARGE, EFFECT_PICTURE_TOO_LARGE_HOSTED, EFFECT_TEXT_WIDGETS, EFFECT_TOO_MUCH_WORK,
} from '#shared/runner/effects'
import { EFFECTS } from '~~/server/runner/effects/table'
import { effectCores } from '~~/server/runner/effects/cores'
import type { Tensor } from '~~/server/runner/effects/core/tensor'
import { decodeRaw } from '~~/server/runner/compositor/decode'
import { workerScript } from '~~/server/runner/compositor/worker'
import { compositorCore } from '~~/server/runner/compositor/plane'
import { planNode, type NodePlan } from '~~/server/runner/executors'
import type { RunnerValue } from '~~/server/runner/types'
import { createMemoryKeptBytes } from '~~/server/runner/keptBytes'

/**
 * The picture decoder, watched (fix round 1): every call is counted, and
 * while `refuse` is set a call throws DECODED, so a test proves a refusal
 * came before any pixel was decoded, or that a plan got past its caps and
 * budget to the decode.
 */
const decodeWatch = vi.hoisted(() => ({ calls: 0, refuse: false }))
vi.mock('~~/server/runner/compositor/decode', async (importOriginal) => {
  const real = await importOriginal<typeof import('~~/server/runner/compositor/decode')>()
  return {
    ...real,
    decodeRaw: (...a: Parameters<typeof real.decodeRaw>) => {
      decodeWatch.calls++
      if (decodeWatch.refuse) throw new Error('DECODED')
      return real.decodeRaw(...a)
    },
  }
})

// ── The fixtures ─────────────────────────────────────────────────────────────

interface BlurItem extends FxItem { f32z?: string }
interface BlurOutputs { kind: 'image'; items: BlurItem[] }
interface BlurCase extends Omit<FxCase, 'outputs' | 'preview'> {
  outputs?: BlurOutputs[]
  stable_outputs?: BlurOutputs[]
  preview?: NonNullable<FxCase['preview']> & { tensor?: BlurItem }
  peaks?: { torch: number[]; stable: number[]; cut: number | null; tied_at_cut: number }[]
}
interface BlurFx extends Omit<FxFile, 'cases'> {
  cases: BlurCase[]
  library_eps: Record<string, number>
  motion_kernels: { length: number; angle: number; side: number; f32: string }[]
  frame: {
    name: string; inputs: FxCase['inputs']; effect: { class_type: string; node_id: string; widgets: Record<string, unknown> }
    frame: { widgets: Record<string, unknown>; w: number; h: number; c: number; image8: string; f32z: string }
  }
  /** A small output's float32 (zlib), by the sha256 of its bytes: outputs that are the same are kept once (fix round 2). */
  floats: Record<string, string>
  /** The ε sweep's probes (fix round 2): each class's worst case, and a slice of the reviewer's. */
  probes: SweepCase[]
}
/** A case of the ε sweep (fix round 1): a seed's pictures rebuilt here (`gen`), or a review case's kept (`u8z`). */
interface SweepCase {
  name: string
  class_type: string
  widgets: Record<string, unknown>
  window: [number, number, number, number]
  gen?: { seeds: number[]; kind: 'tex' | 'smooth' | 'dots' }
  inputs: { w: number; h: number; c: number; sha256?: string; u8z?: string }[]
  error?: { type: string; message: string }
  stable?: true
  outputs?: { w: number; h: number; c: number; f32s: string }[][]
}
const FX = withAssets(loadFixtures('blur') as unknown as FxFile) as unknown as BlurFx

/** The 13 classes R2.5 ports. */
const BLUR_CLASSES = ['Sharpen', 'Denoise', 'AdjustGlow', 'HighPass', 'Emboss', 'FindEdges', 'Blur', 'Bokeh', 'TiltShift', 'FrequencySeparation', 'HeightmapRelief', 'Outline', 'Sparkle']

/**
 * Each class's ε (255-scale), pinned at about 4× the worst |Δ| measured
 * between the port's float and Python's (both clamped to [−0.01, 1.01]) over
 * the fixture's cases and the whole ε sweep (`--group blur --sweep`; its
 * result, seeds and command are tabled in server/runner/effects/core/blur.ts),
 * and never above 2⁻⁸ (R2 rule 10). The fixture keeps each class's worst
 * sweep case as a probe, so a test below measures the same worst again and
 * holds ε between 4× and 8× of it. Outline alone is capped at 2⁻⁸, 2.7× its
 * worst (1.47e-3, at threshold 0.01: its edge divided by 0.01, over torch's
 * own Sobel sums, whose order is library math). The fixture script holds the
 * same table (its hashed cases' bands are recorded at it).
 */
const LIBRARY_EPS: Readonly<Record<string, number>> = {
  Sharpen: 7.3e-4, // worst 1.82e-4 (sweep seed 14)
  Denoise: 2.5e-4, // worst 6.08e-5 (sweep seed 2)
  AdjustGlow: 2.5e-4, // worst 6.08e-5 (sweep seed 18)
  HighPass: 4.3e-4, // worst 1.06e-4 (sweep seed 13)
  Emboss: 9.2e-4, // worst 2.28e-4 (sweep seed 23)
  FindEdges: 6.1e-4, // worst 1.52e-4 (sweep seed 4)
  Blur: 3.1e-4, // worst 7.60e-5 (review BIG blur g r17.5)
  Bokeh: 1.9e-4, // worst 4.56e-5 (sweep seed 20)
  TiltShift: 1.9e-4, // worst 4.56e-5 (sweep seed 10)
  FrequencySeparation: 1.9e-4, // worst 4.56e-5 (sweep seed 3)
  HeightmapRelief: 1.8e-3, // worst 4.33e-4 (sweep seed 3)
  Outline: 2 ** -8, // worst 1.47e-3 (sweep seed 11 (threshold 0.01))
  Sparkle: 1.2e-3, // worst 2.89e-4 (sweep seed 20)
}
/** Classes whose ε is capped at 2⁻⁸, below 4× their worst. */
const EPS_CAPPED: ReadonlySet<string> = new Set(['Outline'])

const BLUR: ReadonlySet<RunnerFamily> = new Set(['cards', 'effects-blur'])
const BLUR_EDIT: ReadonlySet<RunnerFamily> = new Set(['cards', 'effects-blur', 'fal-edit'])
const BLUR_FRAME: ReadonlySet<RunnerFamily> = new Set(['cards', 'effects-blur', 'frame'])
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }

const tk = effectCores.tk
const blur = effectCores.blur

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

/** A small item's float32 (zlib), its own or the fixture's shared copy; none for a hashed item. */
const f32zOf = (item: BlurItem): string | undefined => item.f32z ?? (item.band ? undefined : FX.floats[item.f32_sha256!])

/** A small item's float, and Python's 8-bit forms derived from it (checked against Python's hashes). */
function pythonOf(item: BlurItem): { f32: Float32Array; round8: Uint8Array; trunc8: Uint8Array } {
  const raw = inflateSync(b64(f32zOf(item)!))
  const f32 = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
  const t = planarOf(f32, item)
  const round8 = tk.quantize(t, 'round')
  const trunc8 = tk.quantize(t, 'trunc')
  expect(sha256(round8), 'Python round8 from its float').toBe(item.round8_sha256)
  expect(sha256(trunc8), 'Python trunc8 from its float').toBe(item.trunc8_sha256)
  return { f32, round8, trunc8 }
}

/**
 * 8-bit bytes against an item, in one mode: a small item within the band of
 * its float; a hashed one by its band (each value there at most one level
 * off, and with Python's bytes put back there, the hash of the rest).
 */
function expectLibrary8(ts8: Uint8Array, item: BlurItem, mode: 'round' | 'trunc', eps: number, label: string): void {
  if (f32zOf(item)) {
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

/** The outputs the runner is held to: Python's, or where torch's topk kept other tied values, the node's with the runner's choice. */
const expected = (c: BlurCase) => c.stable_outputs ?? c.outputs!

/** The case's params as the core takes them (the table's `prepare`). */
function coreParams(c: BlurCase): Record<string, unknown> {
  const p = paramsOf(c as unknown as FxCase)
  const spec = EFFECTS[c.class_type]!
  return spec.prepare ? spec.prepare(p) : p
}

type Op = (inp: Record<string, Tensor>, p: Record<string, unknown>, stop?: () => boolean, state?: unknown, index?: number, count?: number) => { outputs: Tensor[]; preview: Tensor | null }

/** The case's outputs from the core called in this thread, one per batch index, each told its place in the batch. */
async function coreRun(c: BlurCase) {
  const op = coreOp(EFFECTS[c.class_type]!.op) as unknown as Op
  const rows = await tensorsOf(c as unknown as FxCase)
  return rows.map((inp, i) => op(inp, coreParams(c), undefined, {}, i, rows.length))
}

/** Python's raise, as the runner's message key (rule 6). */
function raiseKey(e: { type: string; message: string }): 'EFFECT_NEEDS_RGB' | 'EFFECT_PICTURE_TOO_SMALL' {
  if (/^The expanded size of the tensor \(4\) must match the existing size \(3\) at non-singleton dimension 3/.test(e.message)) return 'EFFECT_NEEDS_RGB'
  if (/Padding size should be less than the corresponding input dimension|Expected 3D or 4D \(batch mode\) tensor with possibly 0 batch size and other non-zero dimensions/.test(e.message)) return 'EFFECT_PICTURE_TOO_SMALL'
  throw new Error(`an unexpected Python raise: ${e.type}: ${e.message}`)
}

// ── The fixture file itself ──────────────────────────────────────────────────

describe('the blur fixtures', () => {
  it('cover the 13 classes, made by multi-threaded torch, with the same ε table as the script', () => {
    expect(FX.threads).toBeGreaterThan(1)
    expect([...new Set(FX.cases.map(c => c.class_type))].sort()).toEqual([...BLUR_CLASSES].sort())
    expect(FX.library_eps).toEqual(LIBRARY_EPS)
    for (const eps of Object.values(LIBRARY_EPS)) expect(eps).toBeLessThanOrEqual(2 ** -8)
  })

  it('every class is ported: in the table, in the family, with a row', () => {
    for (const cls of BLUR_CLASSES) {
      expect(EFFECTS[cls], cls).toMatchObject({ family: 'effects-blur', op: `blur.${cls}`, batch: 'pure' })
      expect(typeof EFFECTS[cls]!.work, cls).toBe('function')
      expect(EFFECT_CLASSES_PORTED, cls).toContain(cls)
      expect(EFFECT_FAMILY_OF[cls], cls).toBe('effects-blur')
      expect(RUNNER_NODE_RULES[cls]?.family, cls).toBe('effects-blur')
      expect(typeof (blur as unknown as Record<string, unknown>)[cls], cls).toBe('function')
    }
  })

  it('a Python raise is a picture too small for its padding (or resized down to nothing), or Outline\'s colours meeting 4 channels', () => {
    const errors = FX.cases.filter(c => c.error)
    expect(errors.length).toBeGreaterThan(100)
    const keys = new Set<string>()
    for (const c of errors) {
      const key = raiseKey(c.error!)
      keys.add(key)
      if (key === 'EFFECT_NEEDS_RGB') {
        expect(c.class_type, c.name).toBe('Outline')
        expect(Object.values(c.inputs).some(i => i.source === 'provider' || (i.source === 'card' && c.name.includes('see-through'))), c.name).toBe(true)
      }
    }
    expect([...keys].sort()).toEqual(['EFFECT_NEEDS_RGB', 'EFFECT_PICTURE_TOO_SMALL'])
    // The brief's cases: an area resize down to 0 pixels, and the largest radius on a small picture.
    expect(errors.some(c => /Expected 3D or 4D/.test(c.error!.message))).toBe(true)
    expect(errors.some(c => c.name === 'HighPass: radius 30 (too wide), rgb 37×23')).toBe(true)
  })

  it('Python\'s preview file is its preview tensor\'s trunc8', () => {
    for (const c of FX.cases.filter(x => !x.error && !x.stable_outputs)) {
      const want = c.preview!.tensor ? c.preview!.tensor.trunc8_sha256 : c.outputs![0]!.items[0]!.trunc8_sha256
      expect(c.preview!.px_sha256, c.name).toBe(want)
    }
  })
})

// ── Every case (rule 12) ─────────────────────────────────────────────────────

describe('each class against Python', () => {
  for (const c of FX.cases) {
    const cls = c.class_type
    const eps = LIBRARY_EPS[cls]!

    it(`core: ${c.name}`, async () => {
      if (c.error) {
        await expect(coreRun(c)).rejects.toThrow(raiseKey(c.error))
        return
      }
      const runs = await coreRun(c)
      const outs = expected(c)
      for (const [slot, o] of outs.entries()) {
        expect(runs).toHaveLength(o.items.length)
        for (const [i, item] of o.items.entries()) {
          const t = runs[i]!.outputs[slot]!
          expect([t.w, t.h, t.c], `${c.name}, output ${slot}, picture ${i}`).toEqual([item.w, item.h, item.c])
          for (const mode of ['round', 'trunc'] as const) expectLibrary8(tk.quantize(t, mode), item, mode, eps, `${c.name}, output ${slot}, picture ${i}, ${mode}`)
        }
      }
      // The preview tensor, where it isn't output 0's.
      const pt = c.preview!.tensor
      const shown = runs[0]!.preview
      expect(!!shown, c.name).toBe(!!pt)
      if (pt && shown && !c.stable_outputs) expectLibrary8(tk.quantize(shown, 'trunc'), pt, 'trunc', eps, `${c.name}, preview tensor`)
    }, c.hashed ? 60_000 : 20_000)

    it(`planEffect: ${c.name}`, async () => {
      if (c.error) {
        await expect(runEffectCase(c as unknown as FxCase, { families: BLUR })).rejects.toThrow(EFFECT_ERROR_MESSAGES[raiseKey(c.error)])
        return
      }
      const outs = expected(c)
      // Read by nothing (or a provider): kept as the hand-off's round.
      const run = await runEffectCase(c as unknown as FxCase, { families: BLUR })
      for (const [slot, o] of outs.entries()) {
        const files = filesOfValue(run.made.values[slot])
        expect(files).toHaveLength(o.items.length)
        for (const [i, item] of o.items.entries()) {
          const got = await pngPixels(run.bytes(files[i]!))
          expect([got.w, got.h, got.channels]).toEqual([item.w, item.h, item.c])
          expectLibrary8(got.px, item, 'round', eps, `${c.name}, output ${slot}, kept ${i}`)
        }
      }
      // The live preview: as save_live_preview writes it.
      expect(run.previews).toHaveLength(1)
      expect(run.previews[0]!.filename).toBe(c.preview!.filename)
      const pv = await pngPixels(run.previews[0]!.bytes)
      expect([pv.w, pv.h, pv.channels]).toEqual([c.preview!.w, c.preview!.h, c.preview!.mode.length])
      const shownItem = c.stable_outputs ? outs[0]!.items[0]! : c.preview!.tensor ?? outs[0]!.items[0]!
      if (!c.stable_outputs || !c.preview!.tensor) expectLibrary8(pv.px, shownItem, 'trunc', eps, `${c.name}, preview`)
      expect(run.made.ui).toEqual({
        images: c.ui!.images.map(im => ({ filename: im.filename, subfolder: 'sailor_runner', type: im.type })),
        animated: c.ui!.animated,
      })
      // Read only by Save image: kept as save_images writes it (trunc).
      const p = pictureOf(c as unknown as FxCase)
      const saves: ApiPrompt = Object.fromEntries(outs.map((_o, slot) => [`save${slot}`, saveImage([c.node_id, slot])]))
      const saved = await runEffectCase(c as unknown as FxCase, { families: BLUR, prompt: { ...p.prompt, ...saves } })
      for (const [slot, o] of outs.entries()) {
        const tfiles = filesOfValue(saved.made.values[slot])
        for (const [i, item] of o.items.entries()) {
          const got = await pngPixels(saved.bytes(tfiles[i]!))
          expectLibrary8(got.px, item, 'trunc', eps, `${c.name}, output ${slot}, kept trunc ${i}`)
        }
      }
    }, c.hashed ? 60_000 : 20_000)
  }
})

// ── The ε sweep (fix round 1) ────────────────────────────────────────────────

/** scripts/runner_effects_fixtures.py `sweep_pixels`: an 8-bit H × W × C field from integers alone. */
function sweepPixels(w: number, h: number, c: number, seed: number, kind: string): Uint8Array {
  let s = (seed >>> 0) || 0x9E3779B9
  const next = () => {
    s ^= s << 13; s >>>= 0
    s ^= s >>> 17
    s ^= s << 5; s >>>= 0
    return s
  }
  const tri = (t: number) => { t %= 512; return t < 256 ? t : 511 - t }
  const a = 1 + (seed % 7) * 3
  const b = 5 + (seed % 11) * 2
  const edge = Math.floor((w * (3 + (seed % 5))) / 10)
  const out = new Uint8Array(w * h * c)
  let o = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let k = 0; k < c; k++) {
        let v: number
        if (kind === 'dots') v = 12 + (next() & 15)
        else if (kind === 'smooth') v = tri(x * a + y * b + k * 40)
        else {
          v = tri(x * a * 3 + y * b + k * 71) ^ (next() & 31)
          if (x > edge) v = Math.min(255, v + 60)
        }
        out[o++] = v
      }
    }
  }
  if (kind === 'dots') {
    for (let j = 0; j < Math.min(40, w * h); j++) {
      const p = next() % (w * h)
      for (let k = 0; k < c; k++) out[p * c + k] = Math.min(255, 128 + 3 * j)
    }
  }
  return out
}

/** A sweep case's pictures as the node got them: u8 / 255 in float32, planar. */
function sweepInputs(c: SweepCase): Tensor[] {
  return c.inputs.map((inp, i) => {
    const u8 = c.gen ? sweepPixels(inp.w, inp.h, inp.c, c.gen.seeds[i]!, c.gen.kind) : new Uint8Array(inflateSync(b64(inp.u8z!)))
    if (inp.sha256) expect(sha256(u8), `${c.name}: picture ${i} rebuilt as the script made it`).toBe(inp.sha256)
    const t = tk.tensor(inp.c, inp.h, inp.w)
    const n = inp.w * inp.h
    for (let j = 0; j < n; j++) for (let k = 0; k < inp.c; k++) t.data[k * n + j] = Math.fround(u8[j * inp.c + k]! / 255)
    return t
  })
}

/** A window's float32, unshuffled (every value's byte 0, then byte 1…), as a planar tensor. */
function unshuffled(o: { c: number; f32s: string }, ww: number, wh: number): Tensor {
  const raw = inflateSync(b64(o.f32s))
  const count = raw.length / 4
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < count; i++) for (let j = 0; j < 4; j++) bytes[i * 4 + j] = raw[j * count + i]!
  return planarOf(new Float32Array(bytes.buffer), { w: ww, h: wh, c: o.c })
}

/** The same window of a runner tensor. */
function windowOf(t: Tensor, [x0, y0, ww, wh]: SweepCase['window']): Tensor {
  const out = tk.tensor(t.c, wh, ww)
  for (let c = 0; c < t.c; c++) for (let y = 0; y < wh; y++) for (let x = 0; x < ww; x++) out.data[(c * wh + y) * ww + x] = t.data[(c * t.h + y0 + y) * t.w + x0 + x]!
  return out
}

/**
 * The ε sweep's cases. By default the fixture's probes (each class's worst
 * case in the whole sweep, and a slice of the reviewer's cases). The whole
 * sweep (24 seeds per class and every reviewer case) is run by
 * `scripts/runner_effects_fixtures.py --group blur --sweep`, which hands its
 * file over in BLUR_SWEEP_FILE (outside the repo) and prints what the ε test
 * below measures.
 */
const WHOLE_SWEEP = process.env.BLUR_SWEEP_FILE
const SWEEP: SweepCase[] = WHOLE_SWEEP ? (JSON.parse(readFileSync(WHOLE_SWEEP, 'utf8')) as { cases: SweepCase[] }).cases : FX.probes

describe('the ε sweep: fresh pictures, sizes and settings, and the R2.5 reviewer\'s probe cases', () => {
  it(WHOLE_SWEEP ? 'the whole sweep: at least 20 seeds working per class, and the reviewer\'s cases' : 'the probes: each class\'s worst seed (Blur\'s a reviewer case), and a slice of the reviewer\'s', () => {
    for (const cls of BLUR_CLASSES) {
      const seeds = SWEEP.filter(c => c.class_type === cls && c.gen && !c.error)
      if (WHOLE_SWEEP) expect(seeds.length, cls).toBeGreaterThanOrEqual(20)
      else expect(seeds.length, cls).toBe(cls === 'Blur' ? 0 : 1)
    }
    expect(SWEEP.filter(c => c.name.includes(': review ')).length).toBeGreaterThanOrEqual(WHOLE_SWEEP ? 130 : 60)
    if (!WHOLE_SWEEP) expect(SWEEP.some(c => c.name === 'Blur: review BIG blur g r17.5')).toBe(true)
  })

  for (const c of SWEEP) {
    const eps = LIBRARY_EPS[c.class_type]!
    it(`${c.name}`, () => {
      const op = coreOp(EFFECTS[c.class_type]!.op) as unknown as Op
      const pics = sweepInputs(c)
      const p = coreParams(c as unknown as BlurCase)
      if (c.error) {
        expect(() => pics.map((x, i) => op({ image: x }, p, undefined, {}, i, pics.length))).toThrow(raiseKey(c.error))
        return
      }
      const runs = pics.map((x, i) => op({ image: x }, p, undefined, {}, i, pics.length))
      for (const [slot, items] of c.outputs!.entries()) {
        for (const [i, o] of items.entries()) {
          const t = runs[i]!.outputs[slot]!
          expect([t.w, t.h, t.c], `${c.name}, output ${slot}, picture ${i}`).toEqual([o.w, o.h, o.c])
          const py = unshuffled(o, c.window[2], c.window[3])
          const got = windowOf(t, c.window)
          for (const mode of ['round', 'trunc'] as const) {
            const want = tk.quantize(py, mode)
            const have = tk.quantize(got, mode)
            const pf = interleaved(py)
            let far = -1
            for (let j = 0; j < want.length; j++) {
              const d = Math.abs(have[j]! - want[j]!)
              if (d === 0) continue
              const v = pf[j]! * 255
              const edge = mode === 'trunc' ? Math.round(v) : Math.floor(v) + 0.5
              if (d > 1 || !(Math.abs(v - edge) < eps)) { far = j; break }
            }
            expect(far, `${c.name}, output ${slot}, picture ${i}, ${mode}: first byte outside the band`).toBe(-1)
          }
        }
      }
    }, 30_000)
  }
})

/** |Δ|·255 between two floats, each clamped to [−0.01, 1.01] (a value clamped away by every reader can't matter). */
const delta = (a: number, b: number) => Math.abs(Math.min(1.01, Math.max(-0.01, a)) - Math.min(1.01, Math.max(-0.01, b))) * 255

describe('each class\'s ε', () => {
  it('is about 4× the worst difference measured over the fixture\'s cases and the sweep (at least 4×, at most 8×; Outline capped at 2⁻⁸), and at most 2⁻⁸', async () => {
    const worst = new Map<string, number>(BLUR_CLASSES.map(c => [c, 0]))
    const where = new Map<string, string>()
    let at = ''
    const bump = (cls: string, d: number) => { if (d > worst.get(cls)!) { worst.set(cls, d); where.set(cls, at) } }
    for (const c of FX.cases.filter(x => !x.error && !x.hashed)) {
      const runs = await coreRun(c)
      at = c.name
      for (const [slot, o] of expected(c).entries()) {
        for (const [i, item] of o.items.entries()) {
          const py = pythonOf(item).f32
          const got = interleaved(runs[i]!.outputs[slot]!)
          for (let j = 0; j < py.length; j++) bump(c.class_type, delta(got[j]!, py[j]!))
        }
      }
    }
    for (const c of SWEEP.filter(x => !x.error)) {
      const op = coreOp(EFFECTS[c.class_type]!.op) as unknown as Op
      const pics = sweepInputs(c)
      const p = coreParams(c as unknown as BlurCase)
      at = c.name
      pics.forEach((x, i) => {
        const r = op({ image: x }, p, undefined, {}, i, pics.length)
        c.outputs!.forEach((items, slot) => {
          const py = unshuffled(items[i]!, c.window[2], c.window[3])
          const got = windowOf(r.outputs[slot]!, c.window)
          for (let j = 0; j < py.data.length; j++) bump(c.class_type, delta(got.data[j]!, py.data[j]!))
        })
      })
    }
    console.info(`blur ε (255-scale) against the worst |Δ| measured:\n${BLUR_CLASSES.map(c => `  ${c}: ε ${LIBRARY_EPS[c]!.toExponential(2)}, worst ${worst.get(c)!.toExponential(2)} (${(LIBRARY_EPS[c]! / worst.get(c)!).toFixed(1)}×) at "${where.get(c)}"`).join('\n')}`)
    for (const cls of BLUR_CLASSES) {
      const w = worst.get(cls)!
      const eps = LIBRARY_EPS[cls]!
      expect(w, cls).toBeGreaterThan(0)
      if (EPS_CAPPED.has(cls)) {
        expect(eps, cls).toBe(2 ** -8)
        expect(eps, cls).toBeGreaterThanOrEqual(2.5 * w)
      }
      else {
        expect(eps, cls).toBeGreaterThanOrEqual(4 * w)
        expect(eps, cls).toBeLessThanOrEqual(8 * w)
      }
      expect(eps, cls).toBeLessThanOrEqual(2 ** -8)
    }
  }, 600_000)
})

// ── Parts of the classes on their own ────────────────────────────────────────

describe('Blur\'s motion line', () => {
  it('_motion_kernel: every length 0–20 at eight angles, float32 bit for bit', () => {
    expect(FX.motion_kernels.length).toBe(21 * 8)
    for (const m of FX.motion_kernels) {
      const { kernel, ks } = blur.motionKernel(m.length, m.angle)
      expect(ks, `${m.length} at ${m.angle}`).toBe(m.side)
      const want = b64(m.f32)
      expect(sha256(new Uint8Array(kernel.buffer, kernel.byteOffset, kernel.byteLength)), `${m.length} at ${m.angle}`).toBe(sha256(want))
    }
  })

  it('stays within the conv2d classes R2.2 proves (normalised, at most 15 on a side)', () => {
    for (let length = 0; length <= 80; length++) {
      const scale = Math.max(1, Math.trunc(length / 8))
      const line = scale > 1 ? Math.max(2, Math.round(length / scale)) : length
      for (const angle of [0, 33, 90, 271, 359.5]) {
        const { kernel, ks } = blur.motionKernel(line, angle)
        expect(ks).toBeLessThanOrEqual(15)
        expect(effectCores.kn.convKernelClass(kernel, ks, ks), `${length} at ${angle}`).toBe('normalised')
      }
    }
  })
})

describe('Sparkle\'s peaks', () => {
  const cases = FX.cases.filter(c => c.peaks)

  it('the runner keeps the lower index among values tied at the cut; torch\'s own choice differs from it only there', async () => {
    let tiedDiffer = 0
    for (const c of cases) {
      const rows = await tensorsOf(c as unknown as FxCase)
      for (const [i, inp] of rows.entries()) {
        const want = c.peaks![i]!
        const kept = [...blur.sparklePeaks(inp.image!, coreParams(c), undefined)].sort((a, b) => a - b)
        expect(kept, `${c.name}, picture ${i}`).toEqual(want.stable)
        if (want.torch.join() === want.stable.join()) continue
        tiedDiffer++
        // Same count; every index in one set and not the other sits at the cut's value.
        expect(want.torch.length).toBe(want.stable.length)
        const luma = tk.luma709(inp.image!)
        const onlyOne = [...want.torch.filter(x => !want.stable.includes(x)), ...want.stable.filter(x => !want.torch.includes(x))]
        for (const j of onlyOne) expect(luma[j], `${c.name}, index ${j}`).toBe(Math.fround(want.cut!))
        expect(c.stable_outputs, c.name).toBeDefined()
      }
    }
    // The white block's 100 tied peaks: torch's small-input topk keeps its own choice.
    expect(tiedDiffer).toBeGreaterThanOrEqual(2)
  })

  it('more peaks than max_n, with tied lumas, are among the cases', () => {
    expect(cases.some(c => c.peaks!.some(p => p.tied_at_cut > p.torch.length && p.torch.length > 0))).toBe(true)
    expect(cases.some(c => c.name.includes('graded dots') && c.peaks![0]!.torch.length < 18)).toBe(true)
  })
})

// ── FrequencySeparation: two outputs ─────────────────────────────────────────

describe('FrequencySeparation\'s two outputs', () => {
  const c = FX.cases.find(x => x.name === 'FrequencySeparation: defaults, card 23×19 see-through')!

  it('each show gives its preview: low, high, or the two side by side', () => {
    for (const show of ['low', 'high', 'combined']) {
      const x = FX.cases.find(y => y.class_type === 'FrequencySeparation' && !y.error && (y.widgets.show === show) && y.name.includes('rgb 37×23'))!
      expect(x, show).toBeDefined()
      expect(x.preview!.w).toBe(show === 'combined' ? 2 * 37 : 37)
      expect(!!x.preview!.tensor).toBe(show !== 'low')
    }
  })

  it('feed two different readers: low handed to Edit an image (round), high saved by Save image (trunc)', async () => {
    const p = pictureOf(c as unknown as FxCase)
    const run = await runEffectCase(c as unknown as FxCase, { families: BLUR, prompt: { ...p.prompt, e: editNode([c.node_id, 0]), s: saveImage([c.node_id, 1]) } })
    const low = filesOfValue(run.made.values[0])
    const high = filesOfValue(run.made.values[1])
    const eps = LIBRARY_EPS.FrequencySeparation!
    expectLibrary8((await pngPixels(run.bytes(low[0]!))).px, c.outputs![0]!.items[0]!, 'round', eps, 'low, round')
    expectLibrary8((await pngPixels(run.bytes(high[0]!))).px, c.outputs![1]!.items[0]!, 'trunc', eps, 'high, trunc')
    // And the other way about.
    const back = await runEffectCase(c as unknown as FxCase, { families: BLUR, prompt: { ...p.prompt, s: saveImage([c.node_id, 0]), e: editNode([c.node_id, 1]) } })
    expectLibrary8((await pngPixels(back.bytes(filesOfValue(back.made.values[0])[0]!))).px, c.outputs![0]!.items[0]!, 'trunc', eps, 'low, trunc')
    expectLibrary8((await pngPixels(back.bytes(filesOfValue(back.made.values[1])[0]!))).px, c.outputs![1]!.items[0]!, 'round', eps, 'high, round')
  })

  it('through the engine: high → Save image saves its trunc picture, low → Edit an image is handed its round one', async () => {
    const file = c.inputs.image!.files[0]!
    const k = makeKit({ hosted: false, deps: { families: () => BLUR_EDIT } })
    put(k.root, file, b64(FX.assets[file]!))
    const q: ApiPrompt = { 0: card(file), [c.node_id]: effect(c.class_type, ['0', 0], c.widgets), e: editNode([c.node_id, 0]), o: outCard('e'), s: saveImage([c.node_id, 1]) }
    expect(isRunnerEligible(q, BLUR_EDIT)).toBe(true)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [q], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    const v = run.takes[0]!.nodes[c.node_id]!.values![0] as Extract<RunnerValue, { kind: 'files' }>
    const uploads = (k.upload.mock.calls as unknown as [Uint8Array, string][]).filter(([, name]) => name === v.files[0]!.filename)
    expect(uploads).toHaveLength(1)
    expectLibrary8((await pngPixels(uploads[0]![0])).px, c.outputs![0]!.items[0]!, 'round', LIBRARY_EPS.FrequencySeparation!, 'low handed off')
    const saved = await pngPixels(new Uint8Array(readFileSync(join(k.root, 'output', 'ComfyUI_00001_.png'))))
    expectLibrary8(saved.px, c.outputs![1]!.items[0]!, 'trunc', LIBRARY_EPS.FrequencySeparation!, 'high saved')
  })
})

// ── Work (rule 7) and speed ──────────────────────────────────────────────────

/** A picture file as a Frame (source 'rgb') would keep it (listed `count` times in the batch), run through planEffect on the real worker. */
async function runBig(cls: string, widgets: Record<string, unknown>, png: Uint8Array, o: { count?: number; hosted?: boolean } = {}) {
  const c = { name: cls, class_type: cls, node_id: 'fx', widgets, inputs: { image: { source: 'rgb' as const, files: Array.from({ length: o.count ?? 1 }, () => 'big.png') } } }
  const pic = pictureOf(c as FxCase)
  const mem = memoryIO({ 'big.png': png }, 'fx', { hosted: o.hosted })
  const plan: NodePlan = await planNode({ prompt: pic.prompt, nodeId: 'fx', families: BLUR, gateOpen: false, hosted: o.hosted, filesFrom: pic.filesOf, toUrl: async () => '' })
  return { mem, derive: () => (plan as Extract<NodePlan, { kind: 'derive' }>).derive(mem.io) }
}

/** A one-colour PNG of side × side (cheap to make; its header is all a refusal reads). */
const solids = new Map<number, Promise<Uint8Array>>()
function solidPng(side: number): Promise<Uint8Array> {
  if (!solids.has(side)) {
    solids.set(side, sharp({ create: { width: side, height: side, channels: 3, background: { r: 90, g: 120, b: 200 } }, limitInputPixels: false })
      .png({ compressionLevel: 1 }).toBuffer().then(b => new Uint8Array(b)))
  }
  return solids.get(side)!
}

/**
 * What planEffect's caps and budget (plan.ts: I/O work included) make of
 * this node on a side × side picture, with the decoder refusing to run:
 * 'accepted' when the plan got past them to the decode, else the refusal's
 * words, which then came before any pixel was decoded.
 */
async function gate(cls: string, widgets: Record<string, unknown>, side: number, o: { count?: number; hosted?: boolean } = {}): Promise<string> {
  const { mem, derive } = await runBig(cls, widgets, await solidPng(side), o)
  const before = decodeWatch.calls
  decodeWatch.refuse = true
  try {
    await derive()
    throw new Error('the decoder was not reached')
  }
  catch (e) {
    const decoded = decodeWatch.calls - before
    if (decoded > 0) return 'accepted'
    expect(mem.kept()).toBe(0)
    expect(mem.previews).toHaveLength(0)
    return (e as Error).message
  }
  finally { decodeWatch.refuse = false }
}

describe('work and speed', () => {
  it('HighPass at radius 30 on 8192² is over the budget and fails before any pixel is decoded (the decoder is watched)', async () => {
    const side = 8192
    expect(EFFECTS.HighPass!.work!({ radius: 30 }, { w: side, h: side })).toBeGreaterThan(EFFECT_MAX_WORK)
    expect(await gate('HighPass', { radius: 30 }, side)).toBe(EFFECT_TOO_MUCH_WORK)
    // The watch has teeth: a light setting on the same picture gets to the decoder.
    expect(await gate('HighPass', { radius: 0.5 }, side)).toBe('accepted')
  }, 60_000)

  it('the budget, through plan.ts\'s own total (I/O included): every class\'s defaults are accepted at 4096², Bokeh\'s refused at 8192²', async () => {
    const heaviest: Record<string, Record<string, unknown>> = {
      Sharpen: { amount: 4, radius: 10 }, Denoise: { strength: 5 }, AdjustGlow: { threshold: 0, intensity: 2, radius: 7.5 }, HighPass: { radius: 30 },
      Emboss: { depth: 4 }, FindEdges: { intensity: 4, invert: true }, Blur: { type: 'motion', length: 15, angle: 33, radius: 0, strength: 0 },
      Bokeh: { radius: 9.5, highlight_boost: 4 }, TiltShift: { position: 0.5, width: 0.2, blur: 7.5 }, FrequencySeparation: { radius: 30, show: 'combined' },
      HeightmapRelief: {}, Outline: { thickness: 4 }, Sparkle: { size: 80, max_density: 0.05 },
    }
    const verdict = (m: string) => (m === 'accepted' ? 'ok' : m === EFFECT_TOO_MUCH_WORK ? 'over' : m === EFFECT_PICTURE_TOO_LARGE ? 'too large' : m)
    const report: string[] = []
    for (const cls of BLUR_CLASSES) {
      const d4 = await gate(cls, defaultsOf(cls), 4096)
      expect(d4, `${cls} defaults at 4096²`).toBe('accepted')
      const h4 = await gate(cls, { ...defaultsOf(cls), ...heaviest[cls] }, 4096)
      expect(['accepted', EFFECT_TOO_MUCH_WORK], `${cls} heaviest at 4096²`).toContain(h4)
      const d8 = await gate(cls, defaultsOf(cls), 8192)
      // (FrequencySeparation's defaults show low and high side by side: 16384 × 8192, over the one-picture cap.)
      expect(cls === 'FrequencySeparation' ? [EFFECT_PICTURE_TOO_LARGE] : ['accepted', EFFECT_TOO_MUCH_WORK], `${cls} defaults at 8192²`).toContain(d8)
      report.push(`${cls} ${verdict(h4)}/${verdict(d8)}`)
    }
    expect(await gate('Bokeh', defaultsOf('Bokeh'), 8192)).toBe(EFFECT_TOO_MUCH_WORK)
    console.info(`blur budget through plan.ts (heaviest at 4096² / defaults at 8192²): ${report.join(', ')}`)
  }, 120_000)

  it('FrequencySeparation: its second output and its side-by-side preview count toward the caps, refused before decoding', async () => {
    const fs = (show: string) => ({ radius: 0.5, show })
    // Hosted (4096² a picture): the combined preview is 8192 × 4096, a picture over the cap; low and high are within it.
    expect(await gate('FrequencySeparation', fs('combined'), 4096, { hosted: true })).toBe(EFFECT_PICTURE_TOO_LARGE_HOSTED)
    expect(await gate('FrequencySeparation', fs('low'), 4096, { hosted: true })).toBe('accepted')
    expect(await gate('FrequencySeparation', fs('high'), 4096, { hosted: true })).toBe('accepted')
    // Locally (8192²): the combined preview, 16384 × 8192, is over the one-picture cap.
    expect(await gate('FrequencySeparation', fs('combined'), 8192)).toBe(EFFECT_PICTURE_TOO_LARGE)
    // A batch of three 8192² pictures: 3 × 67 M pixels in each of two outputs is 403 M, over the 268 M cap
    // (one output counted alone would be 201 M, within it); another effect on the same batch is not refused for size.
    expect(await gate('FrequencySeparation', fs('low'), 8192, { count: 3 })).toBe(EFFECT_PICTURES_TOO_LARGE)
    expect(await gate('Emboss', { depth: 1 }, 8192, { count: 3 })).not.toBe(EFFECT_PICTURES_TOO_LARGE)
    expect(EFFECTS.FrequencySeparation!.previewSize!({ show: 'combined' }, { w: 37, h: 23 })).toEqual({ w: 74, h: 23 })
    expect(EFFECTS.FrequencySeparation!.previewSize!({ show: 'high' }, { w: 37, h: 23 })).toBeNull()
  }, 120_000)

  it('time check: Sharpen at radius 10 on a 4096² rgb picture, on the worker', async () => {
    const side = 4096
    const png = new Uint8Array(await sharp({ create: { width: side, height: side, channels: 3, background: { r: 128, g: 128, b: 128 }, noise: { type: 'gaussian', mean: 128, sigma: 40 } }, limitInputPixels: false }).png({ compressionLevel: 1 }).toBuffer())
    const widgets = { amount: 0.5, radius: 10 }
    expect(EFFECTS.Sharpen!.work!(widgets, { w: side, h: side })).toBeLessThan(EFFECT_MAX_WORK)
    const { derive } = await runBig('Sharpen', widgets, png)
    const t0 = performance.now()
    const made = await derive()
    const s = (performance.now() - t0) / 1000
    expect(filesOfValue(made.values[0])).toHaveLength(1)
    console.info(`time check: Sharpen r10 on 4096² rgb on the worker (decode, blur, encode, keep): ${s.toFixed(1)} s; work ${(EFFECTS.Sharpen!.work!(widgets, { w: side, h: side }) / 1e9).toFixed(1)} × 10⁹`)
    expect(s).toBeLessThan(60)
  }, 180_000)
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
function put(root: string, name: string, bytes: Uint8Array) {
  const path = join(root, 'input', name)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, bytes)
}

describe('families', () => {
  it('with the family off, a workflow with the class is left to the engine and nodesNeedingEngine names it', () => {
    for (const cls of BLUR_CLASSES) {
      const p: ApiPrompt = { 0: card('a.png'), fx: effect(cls, ['0', 0], defaultsOf(cls)) }
      expect(runnerTakesWorkflow(p, BLUR), cls).toBe(true)
      expect(nodesNeedingEngine(p, { runnerOn: true, families: BLUR, titleOf: id => id }), cls).toEqual([])
      for (const fam of [new Set<RunnerFamily>(['cards']), new Set<RunnerFamily>(['cards', 'effects-tone']), new Set<RunnerFamily>(['effects-blur'])]) {
        expect(runnerTakesWorkflow(p, fam), `${cls} ${[...fam]}`).toBe(false)
        expect(nodesNeedingEngine(p, { runnerOn: true, families: fam, titleOf: id => id }), `${cls} ${[...fam]}`).toEqual(['fx'])
      }
    }
  })

  it('node by node: each class, its source card and its reader, with cards and the family on and off', () => {
    for (const cls of BLUR_CLASSES) {
      const q: ApiPrompt = { 0: card('a.png'), fx: effect(cls, ['0', 0], defaultsOf(cls)), e: editNode(['fx', 0]), o: outCard('e') }
      const take = (fam: RunnerFamily[]) => Object.fromEntries(Object.keys(q).map(id => [id, runnerTakesNode(q, id, new Set(fam))]))
      expect(take(['cards', 'effects-blur', 'fal-edit']), cls).toEqual({ 0: true, fx: true, e: true, o: true })
      expect(isRunnerEligible(q, BLUR_EDIT), cls).toBe(true)
      for (const fam of [['effects-blur', 'fal-edit'], ['cards', 'fal-edit'], ['cards', 'effects-tone', 'fal-edit']] as RunnerFamily[][]) {
        expect(take(fam), `${cls} ${fam}`).toEqual({ 0: true, fx: false, e: true, o: true })
        expect(isRunnerEligible(q, new Set(fam)), `${cls} ${fam}`).toBe(false)
      }
    }
  })

  it('FrequencySeparation\'s second output is a picture a reader can take', () => {
    expect(PICTURE_OUTPUTS.FrequencySeparation).toEqual([0, 1])
    const q: ApiPrompt = { 0: card('a.png'), fx: effect('FrequencySeparation', ['0', 0], defaultsOf('FrequencySeparation')), e: editNode(['fx', 1]), o: outCard('e') }
    expect(isRunnerEligible(q, BLUR_EDIT)).toBe(true)
  })

  it('widgets ComfyUI would refuse, and colour text read differently, leave it to the engine', () => {
    const take = (cls: string, over: Record<string, unknown>) => runnerTakesNode({ 0: card('a.png'), fx: effect(cls, ['0', 0], { ...defaultsOf(cls), ...over }) }, 'fx', BLUR)
    expect(take('Blur', { type: 'zoom' })).toBe(true)
    expect(take('Blur', { type: 'radial' })).toBe(false)
    expect(take('HighPass', { radius: 30 })).toBe(true)
    expect(take('HighPass', { radius: 31 })).toBe(false)
    expect(take('Sparkle', { points: 9 })).toBe(false)
    expect(take('Outline', { fill_mode: 'source' })).toBe(true)
    expect(take('Outline', { fill_mode: 'none' })).toBe(false)
    // Outline's colours (unicorn's _hex_to_rgb, R2.4's reader).
    expect(EFFECT_TEXT_WIDGETS.Outline).toEqual({ line_color: 'hex', fill_color: 'hex' })
    expect(RUNNER_NODE_RULES.Outline!.inputCheck).toEqual(['effect-preview-name', 'effect-output-size', 'effect-text'])
    expect(take('Outline', { line_color: ' #abc ' })).toBe(true)
    expect(take('Outline', { line_color: '#١٢٣' })).toBe(false)
    expect(take('Outline', { fill_color: 123 })).toBe(false)
  })
})

// ── With every effects family off, nothing changes (rule 12) ─────────────────

/** The graph with an effect of class `cls` (its defaults) spliced in after every picture output: its readers read the effect instead. */
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
    for (const cls of BLUR_CLASSES) {
      const w = defaultsOf(cls)
      sameAsBefore({ 0: card('a.png'), fx: effect(cls, ['0', 0], w) }, `${cls} alone`)
      sameAsBefore({ 0: card('a.png'), fx: effect(cls, ['0', 0], w), e: editNode(['fx', 0]), o: outCard('e') }, `${cls} → edit`)
      sameAsBefore({ 0: card('a.png'), fx: effect(cls, ['0', 0], w), s: saveImage(['fx', 0]) }, `${cls} → save`)
      sameAsBefore({ 0: card('a.png'), fx: effect(cls, ['0', 0], w), f: { class_type: 'Compositor', inputs: frameWidgets({ layer1: ['fx', 0] }) } }, `${cls} → Frame`)
      sameAsBefore({ g: { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'x', aspect_ratio: '1:1', seed: 0, model_options: '{}' } }, fx: effect(cls, ['g', 0], w) }, `generate → ${cls}`)
    }
    const fs = defaultsOf('FrequencySeparation')
    sameAsBefore({ 0: card('a.png'), fx: effect('FrequencySeparation', ['0', 0], fs), e: editNode(['fx', 1]), o: outCard('e'), s: saveImage(['fx', 0]) }, 'FrequencySeparation, both outputs read')
  })

  // The saved projects are this machine's own data: with the folder missing the check is skipped, visibly.
  const PROJECTS = resolve(__dirname, '../../../user/sailor/projects')
  const projectsIt = existsSync(PROJECTS) ? it : it.skip

  projectsIt('over every saved project graph, each with one of the 13 classes (in turn) spliced in after every picture', async () => {
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
        const cls = BLUR_CLASSES[graphs % BLUR_CLASSES.length]!
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
    expect([...used].sort()).toEqual([...BLUR_CLASSES].sort())
    expect(changedWhenOn).toBeGreaterThan(0)
    console.info(`blur families-off invariant: ${graphs} saved graphs, ${spliced} with a blur class spliced in, ${changedWhenOn} read differently with the effects on`)
  }, 300_000)
})

// ── The engine ───────────────────────────────────────────────────────────────

describe('the engine (cards and effects-blur on)', () => {
  const c = FX.cases.find(x => x.name === 'Sharpen: amount between (1.48), card 23×19 see-through')!
  const fileName = c.inputs.image!.files[0]!
  const fileBytes = b64(FX.assets[fileName]!)
  const item = c.outputs![0]!.items[0]!

  it('an effect feeding Edit an image hands off its kept round-8 PNG', async () => {
    const k = makeKit({ hosted: false, deps: { families: () => BLUR_EDIT } })
    put(k.root, fileName, fileBytes)
    const p: ApiPrompt = { 0: card(fileName), [c.node_id]: effect(c.class_type, ['0', 0], c.widgets), e: editNode([c.node_id, 0]), o: outCard('e') }
    expect(isRunnerEligible(p, BLUR_EDIT)).toBe(true)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    const v = run.takes[0]!.nodes[c.node_id]!.values![0] as Extract<RunnerValue, { kind: 'files' }>
    const uploads = (k.upload.mock.calls as unknown as [Uint8Array, string][]).filter(([, name]) => name === v.files[0]!.filename)
    expect(uploads).toHaveLength(1)
    const sent = await pngPixels(uploads[0]![0])
    expect(sent.channels).toBe(4)
    expectLibrary8(sent.px, item, 'round', LIBRARY_EPS.Sharpen!, 'handed off')
  })

  it('an effect → Save image saves the trunc picture', async () => {
    const k = makeKit({ hosted: false, deps: { families: () => BLUR } })
    put(k.root, fileName, fileBytes)
    const p: ApiPrompt = { 0: card(fileName), [c.node_id]: effect(c.class_type, ['0', 0], c.widgets), s: saveImage([c.node_id, 0]) }
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.status).toBe('done')
    const saved = await pngPixels(new Uint8Array(readFileSync(join(k.root, 'output', 'ComfyUI_00001_.png'))))
    expect(saved.channels).toBe(4)
    expectLibrary8(saved.px, item, 'trunc', LIBRARY_EPS.Sharpen!, 'saved')
  })

  it('an effect → Frame: the Frame reads the effect\'s float tensor and renders Python\'s picture (within the band)', async () => {
    const ch = FX.frame
    const file = ch.inputs.image!.files[0]!
    const kept = createMemoryKeptBytes()
    const k = makeKit({ hosted: false, deps: { families: () => BLUR_FRAME, kept } })
    put(k.root, file, b64(FX.assets[file]!))
    const fx = ch.effect
    const p: ApiPrompt = { 0: card(file), [fx.node_id]: effect(fx.class_type, ['0', 0], fx.widgets), f: { class_type: 'Compositor', inputs: frameWidgets({ ...ch.frame.widgets, layer1: [fx.node_id, 0] }) } }
    expect(isRunnerEligible(p, BLUR_FRAME)).toBe(true)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    const v = run.takes[0]!.nodes[fx.node_id]!.values![0] as Extract<RunnerValue, { kind: 'files' }>
    expect(v.tensors).toHaveLength(1)
    const frameFile = run.takes[0]!.nodes.f!.outputs[0]!
    const frame = await pngPixels(new Uint8Array(readFileSync(join(k.root, frameFile.type, frameFile.subfolder, frameFile.filename))))
    expect([frame.w, frame.h, frame.channels]).toEqual([ch.frame.w, ch.frame.h, ch.frame.c])
    const want: BlurItem = { w: ch.frame.w, h: ch.frame.h, c: ch.frame.c, f32z: ch.frame.f32z }
    const py = inflateSync(b64(ch.frame.f32z))
    const t = planarOf(new Float32Array(py.buffer, py.byteOffset, py.byteLength / 4), want)
    want.trunc8_sha256 = sha256(tk.quantize(t, 'trunc'))
    want.round8_sha256 = sha256(tk.quantize(t, 'round'))
    expect(want.trunc8_sha256).toBe(sha256(b64(ch.frame.image8)))
    expectLibrary8(frame.px, want, 'trunc', LIBRARY_EPS.Sharpen!, 'Frame')
  })
})

// ── The esbuild guard: the blur core with the kernels, built as Nitro builds server code ──

describe('esbuild guard: the blur core survives Nitro’s build, with its kernels', () => {
  const require = createRequire(import.meta.url)
  const pnpm = fileURLToPath(new URL('../../node_modules/.pnpm/', import.meta.url))
  const builds = readdirSync(pnpm).filter(d => /^esbuild@\d/.test(d)).map(d => join(pnpm, d, 'node_modules', 'esbuild'))
  const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../../server/runner/${rel}`, import.meta.url)), 'utf8')
  const dir = mkdtempSync(join(tmpdir(), 'blur-esbuild-'))
  const c = FX.cases.find(x => x.name === 'Sparkle: max_density 0.0017, tied dots 64×48')!

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
        const blm = await build('effects/core/blur.ts', 'blur')
        const pxB = new Function(`return (${px.pixelsCore!.toString()})()`)()
        const tkB = new Function('px', `return (${tkm.tensorCore!.toString()})(px)`)(pxB)
        const knB = new Function('k', 'px', `return (${knm.kernelsCore!.toString()})(k, px)`)(tkB, pxB)
        const blurB = new Function('k', 'kn', `return (${blm.blurCore!.toString()})(k, kn)`)(tkB, knB) as Record<string, Op>
        const [inp] = await tensorsOf(c as unknown as FxCase)
        const item = c.outputs![0]!.items[0]!
        expectLibrary8(tk.quantize(blurB.Sparkle!(inp!, coreParams(c), undefined, {}, 0, 1).outputs[0]!, 'round'), item, 'round', LIBRARY_EPS.Sparkle!, 'built in this thread')
        const cores = [
          { name: 'tk', fn: tkm.tensorCore as never, args: ['px'] },
          { name: 'kn', fn: knm.kernelsCore as never, args: ['tk', 'px'] },
          { name: 'blur', fn: blm.blurCore as never, args: ['tk', 'kn'] },
        ]
        const w = new Worker(workerScript(compositorCore, px.pixelsCore as never, cores), { eval: true, workerData: { stop: new SharedArrayBuffer(4) } })
        try {
          const reply = (m: Record<string, unknown>) => new Promise<any>((res) => { w.once('message', res); w.postMessage(m) })
          const { files } = pictureOf(c as unknown as FxCase)
          const raw = await decodeRaw(files[c.inputs.image!.files[0]!]!, 'rgb')
          expect((await reply({ id: 1, op: 'fx.begin', cls: c.class_type, fn: 'blur.Sparkle', params: coreParams(c), count: 1 })).error).toBeUndefined()
          const r = await reply({ id: 2, op: 'fx.run', index: 0, inputs: { image: raw }, first: true, masks: [false], want: { round: [true], trunc: [false] } })
          expect(r.error).toBeUndefined()
          expectLibrary8(r.value.outputs[0].round8, item, 'round', LIBRARY_EPS.Sparkle!, 'in a Worker')
          expectLibrary8(r.value.preview.px, item, 'trunc', LIBRARY_EPS.Sparkle!, 'preview in a Worker')
        }
        finally { await w.terminate() }
      }, 30_000)
    }
  }
})

// ── Stop ─────────────────────────────────────────────────────────────────────

describe('Stop', () => {
  /** Each class's path, the downsampled and line and zoom paths too (fix round 1). */
  const PATHS: [string, Record<string, unknown>][] = [
    ...BLUR_CLASSES.map(cls => [cls, {}] as [string, Record<string, unknown>]),
    ['Blur', { type: 'gaussian', radius: 2 }],
    ['Blur', { type: 'gaussian', radius: 12 }],
    ['Blur', { type: 'motion', length: 9, angle: 33 }],
    ['Blur', { type: 'motion', length: 20, angle: 271 }],
    ['Blur', { type: 'zoom', strength: 0.6 }],
    ['AdjustGlow', { radius: 9 }],
    ['Bokeh', { radius: 12, highlight_boost: 2.5 }],
    ['Bokeh', { radius: 4, highlight_boost: 1.7 }],
    ['TiltShift', { blur: 9 }],
    ['FrequencySeparation', { show: 'combined' }],
    ['Outline', { thickness: 3 }],
  ]
  const x = tk.tensor(3, 256, 40)
  for (let i = 0; i < x.data.length; i++) x.data[i] = (i % 97) / 97

  for (const [cls, over] of PATHS) {
    it(`${cls} ${JSON.stringify(over)}: every Stop check along the run stops it`, () => {
      const op = coreOp(EFFECTS[cls]!.op) as unknown as Op
      const spec = EFFECTS[cls]!
      const w = { ...defaultsOf(cls), ...over }
      const p = spec.prepare ? spec.prepare(w) : w
      let total = 0
      op({ image: x }, p, () => { total++; return false })
      expect(total, 'checks in a whole run').toBeGreaterThanOrEqual(4)
      for (const at of [1, 2, Math.ceil(total / 2), total - 1, total]) {
        let calls = 0
        expect(() => op({ image: x }, p, () => ++calls >= at), `stopped at check ${at} of ${total}`).toThrow('Stopped')
        expect(calls).toBe(at)
      }
    })
  }
})
