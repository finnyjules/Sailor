/**
 * R2.7: geometry and coordinate warps (family effects-warp,
 * server/runner/effects/core/warp.ts), against the real Python nodes
 * (scripts/runner_effects_fixtures.py --group warp →
 * fixtures/runner-effects-warp.json). Crop, Resize, Rotate (affine_grid's
 * measured fma order), Flip, Lens correction, Chromatic aberration, Mirror
 * and God rays are *exact* (float32 bit for bit, by sha256); Pinch, Twirl,
 * Wave, Kaleidoscope, Polar coordinates, Fisheye and CRT are *library* (8-bit
 * equal but where Python's float lies within the class's ε of a boundary,
 * there one level). Also: the resizes'
 * scale_factor path (R2.7 ruling (a), kernels.ts `scales`), −0 through each
 * node's last clamp, and the output size Resize and Crop make, checked before
 * any pixel is decoded (at the start of the take from a loader's header, else
 * at the node's turn).
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
  runEffectCase, sha256, synth, tensorsOf, withAssets, type FxCase, type FxFile, type FxItem,
} from './__runner__/effectsParity'
import type { ApiPrompt } from '#shared/runner/graph'
import { RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { IMAGE_OUTPUT_CLASSES, PICTURE_OUTPUTS, RUNNER_NODE_RULES, isRunnerEligible, runnerTakesNode } from '#shared/runner/eligibility'
import { runnerTakesWorkflow } from '#shared/runner/validate'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import {
  EFFECT_CLASSES_PORTED, EFFECT_ERROR_MESSAGES, EFFECT_FAMILIES, EFFECT_FAMILY_OF, EFFECT_MAX_WORK, EFFECT_PICTURES_TOO_LARGE,
  EFFECT_CLASS_MAX_PIXELS, EFFECT_PICTURE_TOO_LARGE, EFFECT_PICTURE_TOO_LARGE_FOR_CLASS, EFFECT_PICTURE_TOO_LARGE_HOSTED, EFFECT_RESIZING_CLASSES,
  EFFECT_TOO_MUCH_WORK, effectOutSize, effectPictureCap,
} from '#shared/runner/effects'
import { EFFECTS } from '~~/server/runner/effects/table'
import { effectCores } from '~~/server/runner/effects/cores'
import { effectOutRefusal } from '~~/server/runner/effects/plan'
import type { Tensor } from '~~/server/runner/effects/core/tensor'
import { decodeRaw } from '~~/server/runner/compositor/decode'
import { workerScript } from '~~/server/runner/compositor/worker'
import { compositorCore } from '~~/server/runner/compositor/plane'
import { planNode, type NodePlan } from '~~/server/runner/executors'
import type { RunnerValue } from '~~/server/runner/types'
import { createMemoryKeptBytes } from '~~/server/runner/keptBytes'
import { cardPictureFiles } from '~~/server/runner/cards/bakeReplay'

/**
 * The picture decoder, watched (as the blur and cells specs): a refusal that
 * came before any pixel was decoded, or a plan that got past its caps and budget.
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

/** A warp-class item: a hashed one keeps Python's round8 bytes (zlib), where its trunc8 is one lower (packed bits, zlib), and its float over three windows [x0, y0, w, h, f32s]. */
interface WarpItem extends FxItem { round8z?: string; trunc8_off?: string; windows?: [number, number, number, number, string][] }
interface WarpCase extends Omit<FxCase, 'outputs'> { outputs?: { kind: 'image'; items: WarpItem[] }[] }
interface KernelSpec { shape: [number, number, number]; seed: number; lo: number; hi: number; memory: 'contiguous' | 'channels-last' }
interface KernelCase {
  name: string; fn: string; class: 'exact'; inputs: KernelSpec[]; args: { scale: number; batch?: number }
  error?: { type: string; message: string }
  outputs?: { shape: number[]; f32_sha256: string; f32?: string }[]
}
interface NegZeroCase {
  name: string; class_type: string; widgets: Record<string, unknown>
  input: { shape: [number, number, number, number]; seed: number; neg_zero_every: number }
  items: { w: number; h: number; c: number; f32_sha256: string; neg_zeros: number }[]
}
interface WarpFx extends Omit<FxFile, 'cases'> {
  cases: WarpCase[]
  /** A small library output's float32 (byte-shuffled, zlib), by its sha256. */
  floats: Record<string, string>
  library_eps: Record<string, number>
  band_classes: string[]
  kernels: KernelCase[]
  negzero: NegZeroCase[]
  frame: { name: string; inputs: FxCase['inputs']; effect: { class_type: string; node_id: string; widgets: Record<string, unknown> }; frame: { widgets: Record<string, unknown>; w: number; h: number; image8: string } }
}
const FX = withAssets(loadFixtures('warp') as unknown as FxFile) as unknown as WarpFx

const WARP_CLASSES = [
  'CropImage', 'ResizeImage', 'RotateImage', 'FlipImage', 'Pinch', 'Twirl', 'Wave', 'LensCorrection',
  'Kaleidoscope', 'PolarCoords', 'Fisheye', 'ChromaticAberration', 'CRT', 'Mirror', 'GodRays',
]

/**
 * CRT, the one library class: its ε (255-scale). Its one transcendental,
 * sin(arange·3.14159), matched Python's float on every case measured
 * (fixture, and the sweep up to 8192²), so the band holds any ε ≤ 2⁻⁸. The
 * fixture script holds the same table.
 */
const LIBRARY_EPS: Readonly<Record<string, number>> = {
  CRT: 2 ** -12,
}
const isLibrary = (cls: string) => Object.prototype.hasOwnProperty.call(LIBRARY_EPS, cls)

/**
 * The "warp" parity class (controller ruling, R2.7 round 2): Pinch, Twirl,
 * Wave, Kaleidoscope, Polar coordinates and Fisheye build their grids with
 * torch's float sin, cos, tan, atan2 or pow — SLEEF u10 on this Mac, not
 * correctly rounded, and another SLEEF on hosted x86 — whose ulp differences
 * move a sample by about ulp · side / 2 pixels: the error grows with the
 * picture. On every case: each 8-bit value equals Python's or is within ±1
 * (±2 anywhere fails); the share of ±1 values is at most `share`; the float
 * |Δ|·255 at most `delta`. Both pinned at about 2× the worst measured over
 * the fixture and `runner_effects_fixtures.py --group warp --sweep`: 40 small
 * pictures a class, then 2048², 4096² and 8192² (the largest picture the
 * runner takes; R2.7 report, round 2). Kaleidoscope reached an 8-bit ±2 at
 * 8192² (|Δ|·255 1.13), so the runner takes it up to 4096² only
 * (EFFECT_CLASS_MAX_PIXELS), where its worst was 0.52.
 *
 *   class         worst |Δ|·255 (at)     worst ±1 share (at)
 *   Pinch         0.174 (4096²)          0.0109% (small)
 *   Twirl         0.206 (8192²)          0.0547% (8192²)
 *   Wave          0.095 (8192²)          0.0103% (8192²)
 *   Kaleidoscope  0.521 (4096²)          0.083%  (fixture)
 *   PolarCoords   0.190 (8192²)          0.0387% (8192²)
 *   Fisheye       0.319 (8192²)          0.0779% (4096²)
 */
const WARP_PARITY: Readonly<Record<string, { delta: number; share: number }>> = {
  Pinch: { delta: 0.35, share: 2.2e-4 },
  Twirl: { delta: 0.42, share: 1.1e-3 },
  Wave: { delta: 0.19, share: 2.1e-4 },
  Kaleidoscope: { delta: 1.05, share: 1.7e-3 },
  PolarCoords: { delta: 0.35, share: 7.8e-4 },
  Fisheye: { delta: 0.64, share: 1.6e-3 },
}
const isWarpClass = (cls: string) => Object.prototype.hasOwnProperty.call(WARP_PARITY, cls)

/** 8-bit bytes against Python's: the largest difference and the share of values that differ. */
function diff8(ts8: Uint8Array, py8: Uint8Array): { max: number; share: number } {
  let max = 0
  let n = 0
  for (let i = 0; i < ts8.length; i++) {
    const d = Math.abs(ts8[i]! - py8[i]!)
    if (d) { n++; if (d > max) max = d }
  }
  return { max, share: ts8.length ? n / ts8.length : 0 }
}

/** The float |Δ|·255 between two H × W × C float32 arrays (each clamped to the picture's range first). */
function deltaF(got: ArrayLike<number>, py: ArrayLike<number>): number {
  const clamp = (v: number) => Math.min(1, Math.max(0, v))
  let d = 0
  for (let j = 0; j < py.length; j++) d = Math.max(d, Math.abs(clamp(got[j]!) - clamp(py[j]!)) * 255)
  return d
}

/** Whether 8-bit bytes (and, where known, the float) keep the warp rule for this class; the reason when not. */
function warpVerdict(cls: string, ts8: Uint8Array, py8: Uint8Array, delta: number | null): string | null {
  const b = WARP_PARITY[cls]!
  const d = diff8(ts8, py8)
  if (ts8.length !== py8.length) return `${ts8.length} values, Python ${py8.length}`
  if (d.max > 1) return `an 8-bit value ${d.max} levels off`
  if (d.share > b.share) return `${(d.share * 100).toFixed(3)}% of values one level off (bound ${(b.share * 100).toFixed(3)}%)`
  if (delta !== null && delta > b.delta) return `float |Δ|·255 ${delta.toExponential(2)} (bound ${b.delta.toExponential(2)})`
  return null
}

const WARP: ReadonlySet<RunnerFamily> = new Set(['cards', 'effects-warp'])
const WARP_EDIT: ReadonlySet<RunnerFamily> = new Set(['cards', 'effects-warp', 'fal-edit'])
const WARP_FRAME: ReadonlySet<RunnerFamily> = new Set(['cards', 'effects-warp', 'frame'])
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }

const tk = effectCores.tk
const kn = effectCores.kn

/** A class's widget defaults (the first case of the standard set is 'defaults'). */
function defaultsOf(cls: string): Record<string, unknown> {
  const c = FX.cases.find(x => x.class_type === cls && x.name.startsWith(`${cls}: defaults,`))
  if (!c) throw new Error(`no defaults case for ${cls}`)
  return c.widgets
}

type Op = (inp: Record<string, Tensor>, p: Record<string, unknown>, stop?: () => boolean, state?: unknown, index?: number, count?: number) => { outputs: Tensor[]; preview: Tensor | null }

/** The case's outputs from the core called in this thread, one per batch index, each told its place in the batch. */
async function coreRun(c: WarpCase) {
  const op = coreOp(EFFECTS[c.class_type]!.op) as unknown as Op
  const rows = await tensorsOf(c as FxCase)
  const p = paramsOf(c as FxCase)
  return rows.map((inp, i) => op(inp, p, undefined, {}, i, rows.length))
}

/** A byte-shuffled float32 (the fixture's `f32s`: every value's byte 0, then byte 1…) back as floats. */
function unshuffle(z: string): Float32Array {
  const raw = inflateSync(b64(z))
  const n = raw.length / 4
  const out = new Uint8Array(raw.length)
  for (let k = 0; k < 4; k++) for (let i = 0; i < n; i++) out[i * 4 + k] = raw[k * n + i]!
  return new Float32Array(out.buffer)
}

/** Python's H × W × C float32 as the planar tensor the core holds. */
function planarOf(f32: Float32Array, item: { w: number; h: number; c: number }): Tensor {
  const t = tk.tensor(item.c, item.h, item.w)
  const n = item.w * item.h
  for (let i = 0; i < n; i++) for (let k = 0; k < item.c; k++) t.data[k * n + i] = f32[i * item.c + k]!
  return t
}

/** A library item's float (small cases), and Python's 8-bit forms derived from it (checked against Python's hashes). */
function pythonOf(item: FxItem): { f32: Float32Array; round8: Uint8Array; trunc8: Uint8Array } {
  const f32 = unshuffle(FX.floats[item.f32_sha256!]!)
  expect(sha256(new Uint8Array(f32.buffer)), 'Python float from its shuffle').toBe(item.f32_sha256)
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
function expectLibrary8(ts8: Uint8Array, item: FxItem, mode: 'round' | 'trunc', eps: number, label: string): void {
  if (!item.band) {
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
  for (const [i, py] of bandOf(item.band, mode)) {
    expect(Math.abs(ts8[i]! - py), `${label}: band value ${i}`).toBeLessThanOrEqual(1)
    patched[i] = py
  }
  expect(sha256(patched), `${label}: outside the band`).toBe(mode === 'round' ? item.round8_sha256 : item.trunc8_sha256)
}

/** Python's 8-bit bytes of a warp-class item in one mode: from its float (small) or its kept bytes (hashed), checked against its hash. */
function python8(item: WarpItem, mode: 'round' | 'trunc'): Uint8Array {
  if (item.f32_sha256 && FX.floats[item.f32_sha256]) {
    const py = pythonOf(item)
    return mode === 'round' ? py.round8 : py.trunc8
  }
  const b = new Uint8Array(inflateSync(b64(item.round8z!)))
  if (mode === 'trunc') {
    const off = inflateSync(b64(item.trunc8_off!))
    for (let i = 0; i < b.length; i++) if ((off[i >> 3]! >> (7 - (i & 7))) & 1) b[i] = b[i]! - 1
  }
  expect(sha256(b), `Python ${mode}8 kept`).toBe(mode === 'round' ? item.round8_sha256 : item.trunc8_sha256)
  return b
}

/** The float |Δ|·255 of a core output against a warp-class item: its whole float (small) or its three windows (hashed). */
function warpDelta(t: Tensor, item: WarpItem): number {
  const got = interleaved(t)
  if (FX.floats[item.f32_sha256!]) return deltaF(got, pythonOf(item).f32)
  let d = 0
  for (const [x0, y0, ww, wh, z] of item.windows!) {
    const py = unshuffle(z)
    const part = new Float32Array(ww * wh * item.c)
    for (let y = 0; y < wh; y++) part.set(got.subarray(((y0 + y) * item.w + x0) * item.c, ((y0 + y) * item.w + x0 + ww) * item.c), y * ww * item.c)
    d = Math.max(d, deltaF(part, py))
  }
  return d
}

/** Whether a warp-class item is Python's input handed on (its no-op setting): kept by its hashes alone, and matched exactly. */
const unchangedItem = (item: WarpItem) => !item.round8z && !FX.floats[item.f32_sha256!]

/** 8-bit bytes against a warp-class item under the warp rule (an unchanged one: exactly). */
function expectWarp8(ts8: Uint8Array, item: WarpItem, cls: string, mode: 'round' | 'trunc', label: string, delta: number | null = null): void {
  if (unchangedItem(item)) {
    expect(sha256(ts8), `${label}: unchanged`).toBe(mode === 'round' ? item.round8_sha256 : item.trunc8_sha256)
    return
  }
  expect(warpVerdict(cls, ts8, python8(item, mode), delta), label).toBeNull()
}

/** Python's raise, as the runner's key (rule 6). */
function keyOfError(e: { type: string; message: string }): string {
  if (/^The size of tensor a \(4\) must match the size of tensor b \(3\) at non-singleton dimension 1$/.test(e.message)) return 'EFFECT_NEEDS_RGB'
  if (/^Input and output sizes should be greater than 0/.test(e.message) || /^tile cannot extend outside image$/.test(e.message)) return 'EFFECT_PICTURE_TOO_SMALL'
  throw new Error(`an unmapped Python raise: ${e.type}: ${e.message}`)
}

// ── The fixture file itself ──────────────────────────────────────────────────

describe('the warp fixtures', () => {
  it('cover the 15 classes, made by multi-threaded torch, with the same ε table as the script, under 8 MB', () => {
    expect(FX.threads).toBeGreaterThan(1)
    expect([...new Set(FX.cases.map(c => c.class_type))].sort()).toEqual([...WARP_CLASSES].sort())
    expect(FX.library_eps).toEqual(LIBRARY_EPS)
    for (const eps of Object.values(LIBRARY_EPS)) expect(eps).toBeLessThanOrEqual(2 ** -8)
    expect([...FX.band_classes].sort()).toEqual(Object.keys(WARP_PARITY).sort())
    for (const b of Object.values(WARP_PARITY)) expect(b.delta).toBeLessThanOrEqual(1.05)
    expect(FX.cases.length).toBeGreaterThan(900)
    expect(readFileSync(resolve(__dirname, 'fixtures/runner-effects-warp.json')).length).toBeLessThanOrEqual(8 * 1024 * 1024)
  })

  it('every class is ported: in the table, in the family, with a row', () => {
    for (const cls of WARP_CLASSES) {
      expect(EFFECTS[cls], cls).toMatchObject({ family: 'effects-warp', op: `warp.${cls}`, batch: 'pure' })
      expect(EFFECT_CLASSES_PORTED, cls).toContain(cls)
      expect(EFFECT_FAMILY_OF[cls], cls).toBe('effects-warp')
      expect(RUNNER_NODE_RULES[cls]?.family, cls).toBe('effects-warp')
      expect(RUNNER_NODE_RULES[cls]!.inputCheck, cls).toEqual(['effect-preview-name', 'effect-output-size'])
      expect(typeof (effectCores.warp as unknown as Record<string, unknown>)[cls], cls).toBe('function')
    }
  })

  it('a Python raise is CRT\'s stripes meeting a 4-channel picture, or Resize down to nothing', () => {
    const errors = FX.cases.filter(c => c.error)
    const keys = new Map<string, string>()
    for (const c of errors) keys.set(c.name, keyOfError(c.error!))
    expect([...new Set(errors.map(c => c.class_type))].sort()).toEqual(['CRT', 'ResizeImage'])
    for (const c of errors) expect(keys.get(c.name), c.name).toBe(c.class_type === 'CRT' ? 'EFFECT_NEEDS_RGB' : 'EFFECT_PICTURE_TOO_SMALL')
    // CRT raises only with the stripes on and no chroma step (which leaves three channels).
    for (const c of errors.filter(x => x.class_type === 'CRT')) {
      expect(c.widgets.rgb_mask as number, c.name).toBeGreaterThan(0)
      expect(c.widgets.chroma, c.name).toBe(0)
    }
    expect(FX.cases.some(c => c.class_type === 'CRT' && !c.error && (c.widgets.chroma as number) > 0 && (c.widgets.rgb_mask as number) > 0 && c.inputs.image!.source === 'provider')).toBe(true)
  })

  it('Python\'s preview file is its output\'s trunc8', () => {
    for (const c of FX.cases.filter(x => !x.error)) expect(c.preview!.px_sha256, c.name).toBe(c.outputs![0]!.items[0]!.trunc8_sha256)
  })
})

// ── The resizes' scale_factor path (ruling (a)) ──────────────────────────────

/** scripts/runner_effects_fixtures.py `hashed_values`: n float32 from a multiplicative hash of the index. */
function hashedValues(n: number, seed: number, lo = 0, hi = 1): Float32Array {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const k = Math.floor(((i * 2654435761 + seed * 40503) % 4294967296) / 256)
    out[i] = Math.fround(lo + (hi - lo) * (k / 16777216))
  }
  return out
}

describe('the resizes with a scale factor (kernels.ts `scales`), against F.interpolate(scale_factor=s)', () => {
  const run = (kc: KernelCase, spec: KernelSpec, index: number, count: number): Tensor => {
    const [c, h, w] = spec.shape
    const t: Tensor = { c, h, w, data: hashedValues(c * h * w, spec.seed, spec.lo, spec.hi) }
    const s = kc.args.scale
    const oh = kn.areaOutSize(h, s)
    const ow = kn.areaOutSize(w, s)
    const cl = spec.memory === 'channels-last' || count > 1
    switch (kc.fn) {
      case 'resize-bilinear': return kn.resizeBilinear(t, oh, ow, cl, [s, s])
      case 'resize-bicubic': return kn.resizeBicubic(t, oh, ow, undefined, [s, s])
      case 'resize-nearest': return kn.resizeNearest(t, oh, ow, [s, s])
      default: return kn.resizeArea(t, oh, ow, { cl, batch: count, index })
    }
  }

  it('covers each mode at the brief\'s scales, at scales whose side·scale isn\'t whole, and in a batch of two', () => {
    for (const mode of ['bilinear', 'bicubic', 'nearest', 'area']) {
      const cases = FX.kernels.filter(k => k.fn === `resize-${mode}`)
      for (const s of [0.1, 0.33, 0.5, 1.5, 4, 0.37, 1.05, 2.3]) expect(cases.some(k => k.args.scale === s && !k.error), `${mode} ${s}`).toBe(true)
      expect(cases.some(k => k.args.batch === 2), mode).toBe(true)
      // Where in·s is not whole, the scale_factor path differs from the size path for every mode but area.
      expect(cases.filter(k => !k.error).length, mode).toBeGreaterThan(150)
    }
  })

  for (const kc of FX.kernels) {
    it(kc.name, () => {
      if (kc.error) {
        // torch refuses an output side of 0; the node refuses it first (EFFECT_PICTURE_TOO_SMALL).
        expect(kc.error.message).toMatch(/^Input and output sizes should be greater than 0/)
        const [, h, w] = kc.inputs[0]!.shape
        expect(kn.areaOutSize(h, kc.args.scale) * kn.areaOutSize(w, kc.args.scale)).toBe(0)
        return
      }
      const count = kc.inputs.length
      kc.inputs.forEach((spec, i) => {
        const got = run(kc, spec, i, count)
        const want = kc.outputs![i]!
        expect([got.c, got.h, got.w], `picture ${i}`).toEqual(want.shape)
        const bytes = new Uint8Array(got.data.buffer, got.data.byteOffset, got.data.byteLength)
        if (sha256(bytes) === want.f32_sha256) return
        if (want.f32) {
          const py = new Float32Array(b64(want.f32).buffer)
          let at = -1
          for (let j = 0; j < py.length; j++) if (!Object.is(py[j], got.data[j])) { at = j; break }
          expect.fail(`picture ${i}: value ${at} is ${got.data[at]}, torch's ${py[at]}`)
        }
        expect(sha256(bytes), `picture ${i}`).toBe(want.f32_sha256)
      })
    })
  }

  it('without `scales` the kernels take the size path, as every existing caller does (the scale-factor step is only used when asked)', () => {
    const t: Tensor = { c: 3, h: 23, w: 37, data: hashedValues(3 * 23 * 37, 99) }
    const bySize = kn.resizeBilinear(t, 12, 7, true)
    const byScale = kn.resizeBilinear(t, 12, 7, true, [0.33, 0.33])
    expect(Buffer.compare(Buffer.from(bySize.data.buffer), Buffer.from(kn.resizeBilinear(t, 12, 7, true, undefined).data.buffer))).toBe(0)
    expect(Buffer.compare(Buffer.from(bySize.data.buffer), Buffer.from(byScale.data.buffer))).not.toBe(0)
    // A scale of 0 or less is torch's "no scale": the size path.
    expect(Buffer.compare(Buffer.from(kn.resizeNearest(t, 12, 7).data.buffer), Buffer.from(kn.resizeNearest(t, 12, 7, [0, 0]).data.buffer))).toBe(0)
  })
})

// ── Every case (rule 12) ─────────────────────────────────────────────────────

/** An exact output: its float32's sha256. */
function expectExactItem(t: Tensor, item: FxItem, label: string): void {
  const got = interleaved(t)
  expect(sha256(new Uint8Array(got.buffer, got.byteOffset, got.byteLength)), label).toBe(item.f32_sha256)
}

describe('each class against Python', () => {
  for (const c of FX.cases) {
    const eps = LIBRARY_EPS[c.class_type]

    it(`core: ${c.name}`, async () => {
      if (c.error) {
        await expect(coreRun(c)).rejects.toThrow(keyOfError(c.error))
        return
      }
      const runs = await coreRun(c)
      const items = c.outputs![0]!.items
      expect(runs).toHaveLength(items.length)
      for (const [i, item] of items.entries()) {
        const t = runs[i]!.outputs[0]!
        expect([t.w, t.h, t.c], `${c.name}, picture ${i}`).toEqual([item.w, item.h, item.c])
        if (isWarpClass(c.class_type) && unchangedItem(item)) expectExactItem(t, item, `${c.name}, picture ${i}, unchanged`)
        else if (isWarpClass(c.class_type)) {
          const delta = warpDelta(t, item)
          for (const mode of ['round', 'trunc'] as const) expectWarp8(tk.quantize(t, mode), item, c.class_type, mode, `${c.name}, picture ${i}, ${mode}`, delta)
        }
        else if (eps === undefined) expectExactItem(t, item, `${c.name}, picture ${i}`)
        else for (const mode of ['round', 'trunc'] as const) expectLibrary8(tk.quantize(t, mode), item, mode, eps, `${c.name}, picture ${i}, ${mode}`)
      }
    })

    it(`planEffect: ${c.name}`, async () => {
      if (c.error) {
        await expect(runEffectCase(c as FxCase, { families: WARP })).rejects.toThrow(EFFECT_ERROR_MESSAGES[keyOfError(c.error)]!)
        return
      }
      const items = c.outputs![0]!.items
      // Read by nothing (or a provider): kept as the hand-off's round, at its own size.
      const run = await runEffectCase(c as FxCase, { families: WARP })
      const files = filesOfValue(run.made.values[0])
      expect(files).toHaveLength(items.length)
      for (const [i, item] of items.entries()) {
        const got = await pngPixels(run.bytes(files[i]!))
        expect([got.w, got.h, got.channels]).toEqual([item.w, item.h, item.c])
        if (isWarpClass(c.class_type)) expectWarp8(got.px, item, c.class_type, 'round', `${c.name}, kept ${i}`)
        else if (eps === undefined) expect(sha256(got.px), `${c.name}, kept ${i}`).toBe(item.round8_sha256)
        else expectLibrary8(got.px, item, 'round', eps, `${c.name}, kept ${i}`)
      }
      // The live preview: the first picture as save_live_preview writes it.
      expect(run.previews).toHaveLength(1)
      expect(run.previews[0]!.filename).toBe(c.preview!.filename)
      const pv = await pngPixels(run.previews[0]!.bytes)
      expect([pv.w, pv.h, pv.channels]).toEqual([c.preview!.w, c.preview!.h, c.preview!.mode.length])
      if (isWarpClass(c.class_type)) expectWarp8(pv.px, items[0]!, c.class_type, 'trunc', `${c.name}, preview`)
      else if (eps === undefined) expect(sha256(pv.px)).toBe(c.preview!.px_sha256)
      else expectLibrary8(pv.px, items[0]!, 'trunc', eps, `${c.name}, preview`)
      expect(run.made.ui).toEqual({
        images: c.ui!.images.map(im => ({ filename: im.filename, subfolder: 'sailor_runner', type: im.type })),
        animated: c.ui!.animated,
      })
      // Read only by Save image: kept as save_images writes it (trunc).
      const p = pictureOf(c as FxCase)
      const saved = await runEffectCase(c as FxCase, { families: WARP, prompt: { ...p.prompt, save: saveImage([c.node_id, 0]) } })
      const tfiles = filesOfValue(saved.made.values[0])
      for (const [i, item] of items.entries()) {
        const got = await pngPixels(saved.bytes(tfiles[i]!))
        if (isWarpClass(c.class_type)) expectWarp8(got.px, item, c.class_type, 'trunc', `${c.name}, kept trunc ${i}`)
        else if (eps === undefined) expect(sha256(got.px), `${c.name}, kept trunc ${i}`).toBe(item.trunc8_sha256)
        else expectLibrary8(got.px, item, 'trunc', eps, `${c.name}, kept trunc ${i}`)
      }
    }, c.hashed ? 60_000 : 20_000)
  }

  it('over this fixture: each warp-class class within its bounds (and never ±2)', async () => {
    const worst = new Map<string, { delta: number; share: number; max: number }>()
    for (const c of FX.cases.filter(x => !x.error && (isLibrary(x.class_type) || isWarpClass(x.class_type)))) {
      const runs = await coreRun(c)
      for (const [i, item] of c.outputs![0]!.items.entries()) {
        const t = runs[i]!.outputs[0]!
        const w = worst.get(c.class_type) ?? { delta: 0, share: 0, max: 0 }
        if (isLibrary(c.class_type)) {
          if (item.band) continue
          w.delta = Math.max(w.delta, deltaF(interleaved(t), pythonOf(item).f32))
        }
        else if (!unchangedItem(item)) {
          w.delta = Math.max(w.delta, warpDelta(t, item))
          for (const mode of ['round', 'trunc'] as const) {
            const d = diff8(tk.quantize(t, mode), python8(item, mode))
            w.share = Math.max(w.share, d.share)
            w.max = Math.max(w.max, d.max)
          }
        }
        worst.set(c.class_type, w)
      }
    }
    console.info(`warp fixture worst (|Δ|·255, ±1 share, 8-bit): ${[...worst].map(([k, v]) => `${k} ${v.delta.toExponential(2)} ${(v.share * 100).toFixed(3)}% ${v.max}`).join(', ')}`)
    // (CRT keeps its band, not its float: its measure is the sweep's.)
    for (const [cls, b] of Object.entries(WARP_PARITY)) {
      const w = worst.get(cls)!
      expect(w.max, cls).toBeLessThanOrEqual(1)
      expect(w.delta, cls).toBeLessThanOrEqual(b.delta)
      expect(w.share, cls).toBeLessThanOrEqual(b.share)
    }
  }, 300_000)

  it('a deliberate break: the warp core with a crude sine and cosine fails the warp rule (the band can\'t hide a logic bug)', async () => {
    const src = readFileSync(resolve(__dirname, '../../server/runner/effects/core/warp.ts'), 'utf8')
    expect(src).toContain('const sin32 = (x: number) => f(Math.sin(x))')
    // The real core, built from its source as the worker builds it, keeps the rule; with sin and cos
    // cut to their Taylor series' first two terms past 0.3 rad (off by 2e-5 at 0.3, 1e-3 at 0.6), it doesn't.
    const pnpm = fileURLToPath(new URL('../../node_modules/.pnpm/', import.meta.url))
    const dir = readdirSync(pnpm).find(d => /^esbuild@\d/.test(d))!
    const esb = createRequire(import.meta.url)(join(pnpm, dir, 'node_modules', 'esbuild')) as typeof import('esbuild')
    const build = async (text: string) => {
      const code = (await esb.transform(text, { loader: 'ts', target: 'es2019', format: 'cjs' })).code
      const mod: { exports: Record<string, unknown> } = { exports: {} }
      new Function('module', 'exports', code)(mod, mod.exports)
      return (mod.exports.warpCore as (k: unknown, kn: unknown) => Record<string, Op>)(tk, kn)
    }
    const crude = src
      .replace('const sin32 = (x: number) => f(Math.sin(x))', 'const sin32 = (x: number) => f(Math.abs(x) < 0.3 ? Math.sin(x) : x - (x * x * x) / 6)')
      .replace('const cos32 = (x: number) => f(Math.cos(x))', 'const cos32 = (x: number) => f(Math.abs(x) < 0.3 ? Math.cos(x) : 1 - (x * x) / 2)')
    expect(crude).not.toBe(src)
    const real = await build(src)
    const broken = await build(crude)
    let caught = 0
    for (const name of ['Twirl: heavy, rgb 320×200', 'Kaleidoscope: heavy, rgb 320×200', 'PolarCoords: heavy, rgb 320×200', 'Wave: heavy, rgb 320×200']) {
      const c = FX.cases.find(x => x.name === name)!
      const [inp] = await tensorsOf(c as FxCase)
      const item = c.outputs![0]!.items[0]!
      const ok = real[c.class_type]!(inp!, paramsOf(c as FxCase), undefined, {}, 0, 1).outputs[0]!
      expect(warpVerdict(c.class_type, tk.quantize(ok, 'round'), python8(item, 'round'), warpDelta(ok, item)), `${name}, real`).toBeNull()
      const bad = broken[c.class_type]!(inp!, paramsOf(c as FxCase), undefined, {}, 0, 1).outputs[0]!
      const why = warpVerdict(c.class_type, tk.quantize(bad, 'round'), python8(item, 'round'), warpDelta(bad, item))
      if (why) caught++
    }
    expect(caught).toBe(4)
  }, 120_000)
})

// ── The broad sweep (`--group warp --sweep` only) ───────────────────────────

/** scripts/runner_effects_fixtures.py `big_pixels`: an 8-bit H × W × C picture from integer arithmetic, as RGBA for the pixels core. */
function bigPixels(w: number, h: number, c: number, seed: number): Uint8Array {
  const out = new Uint8Array(w * h * 4).fill(255)
  const edge = Math.floor((w * 4) / 10)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let k = 0; k < c; k++) {
        const i = (y * w + x) * c + k
        const hsh = ((Math.imul(i, 2654435761 | 0) + seed * 40503) >>> 0) >>> 27
        let v = ((x * 37 + y * 11 + k * 71 + seed) & 255) ^ hsh
        if (x > edge) v = Math.min(v + 60, 255)
        out[(y * w + x) * 4 + k] = v
      }
    }
  }
  return out
}

/** One sweep case's measures: the float |Δ|·255, and per 8-bit mode the largest difference and the share of values off. */
function sweepMeasure(got: Float32Array, py: Float32Array): { delta: number; max: number; share: number } {
  const clamp = (v: number) => Math.min(1, Math.max(0, v))
  const f = Math.fround
  const r8 = (x: number) => { const v = f((x > 0 ? (x > 1 ? 1 : x) : 0) * 255); const r = Math.round(v); return r - v === 0.5 && r % 2 !== 0 ? r - 1 : r }
  const t8 = (x: number) => { const v = f(255 * x); return v > 0 ? (v > 255 ? 255 : Math.trunc(v)) : 0 }
  let delta = 0
  let max = 0
  let offR = 0
  let offT = 0
  for (let j = 0; j < py.length; j++) {
    const a = got[j]!
    const b = py[j]!
    delta = Math.max(delta, Math.abs(clamp(a) - clamp(b)) * 255)
    const dr = Math.abs(r8(a) - r8(b))
    const dt = Math.abs(t8(a) - t8(b))
    if (dr) offR++
    if (dt) offT++
    max = Math.max(max, dr, dt)
  }
  return { delta, max, share: Math.max(offR, offT) / py.length }
}

interface SweepRow { class_type: string; widgets: Record<string, unknown>; w: number; h: number; c: number; seed: number; ow?: number; oh?: number; oc?: number; f32s?: string; file?: string; error?: string }

/** A sweep row's core output (H × W × C) from its picture. */
function sweepRun(sc: SweepRow, rgba: Uint8Array): Float32Array {
  const x = tk.fromPicture({ source: sc.c === 4 ? 'provider' : 'rgb', w: sc.w, h: sc.h, data: rgba })
  const op = coreOp(EFFECTS[sc.class_type]!.op) as unknown as Op
  const p = paramsOf({ class_type: sc.class_type, widgets: sc.widgets } as FxCase)
  return interleaved(op({ image: x }, p, undefined, {}, 0, 1).outputs[0]!)
}

/** Each class's worst over the rows measured (a class's bound check after). */
function reportAndCheck(title: string, worst: Map<string, { delta: number; max: number; share: number; where: string }>): void {
  for (const [cls, v] of worst) console.info(`${title} ${cls}: worst |Δ|·255 ${v.delta.toExponential(2)}, ±1 share ${(v.share * 100).toFixed(4)}%, largest 8-bit ${v.max} (at ${v.where})`)
  for (const [cls, v] of worst) {
    if (cls === 'RotateImage') expect(v.delta, cls).toBe(0)
    else if (isLibrary(cls)) expect(4 * v.delta, cls).toBeLessThanOrEqual(LIBRARY_EPS[cls]!)
    else {
      expect(v.max, cls).toBeLessThanOrEqual(1)
      expect(v.delta, cls).toBeLessThanOrEqual(WARP_PARITY[cls]!.delta)
      expect(v.share, cls).toBeLessThanOrEqual(WARP_PARITY[cls]!.share)
    }
  }
}

function keepWorst(worst: Map<string, { delta: number; max: number; share: number; where: string }>, cls: string, m: { delta: number; max: number; share: number }, where: string): void {
  const w = worst.get(cls) ?? { delta: 0, max: 0, share: 0, where }
  if (m.delta > w.delta) w.where = where
  w.delta = Math.max(w.delta, m.delta)
  w.max = Math.max(w.max, m.max)
  w.share = Math.max(w.share, m.share)
  worst.set(cls, w)
}

const SWEEP = process.env.WARP_SWEEP_FILE
describe.runIf(!!SWEEP)('the warp ε sweep', () => {
  it('the warp ε sweep: each class\'s worst over fresh small pictures and settings', () => {
    const doc = JSON.parse(readFileSync(SWEEP!, 'utf8')) as { cases: SweepRow[] }
    const worst = new Map<string, { delta: number; max: number; share: number; where: string }>()
    for (const sc of doc.cases) {
      const px = synth(sc.w, sc.h, sc.c, sc.seed)
      const rgba = new Uint8Array(sc.w * sc.h * 4).fill(255)
      for (let i = 0; i < sc.w * sc.h; i++) for (let k = 0; k < sc.c; k++) rgba[i * 4 + k] = px[i * sc.c + k]!
      if (sc.error) {
        expect(() => sweepRun(sc, rgba), `${sc.class_type} ${JSON.stringify(sc.widgets)}`).toThrow()
        continue
      }
      const got = sweepRun(sc, rgba)
      const py = unshuffle(sc.f32s!)
      expect(got.length).toBe(py.length)
      keepWorst(worst, sc.class_type, sweepMeasure(got, py), `${sc.w}×${sc.h}×${sc.c} seed ${sc.seed} ${JSON.stringify(sc.widgets)}`)
    }
    console.info(`warp ε sweep: ${doc.cases.length} cases`)
    reportAndCheck('warp ε small', worst)
  }, 1_800_000)
})

const LARGE = process.env.WARP_SWEEP_LARGE_FILE
describe.runIf(!!LARGE)('the warp large sweep', () => {
  it('the warp large sweep: one class up to 8192² (every widget at its max, then drawn)', () => {
    const doc = JSON.parse(readFileSync(LARGE!, 'utf8')) as { cases: SweepRow[] }
    const worst = new Map<string, { delta: number; max: number; share: number; where: string }>()
    for (const sc of doc.cases) {
      const got = sweepRun(sc, bigPixels(sc.w, sc.h, sc.c, sc.seed))
      const raw = readFileSync(sc.file!)
      const py = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
      expect(got.length).toBe(py.length)
      const m = sweepMeasure(got, py)
      console.info(`warp large ${sc.class_type} ${sc.w}² seed ${sc.seed} ${JSON.stringify(sc.widgets)}: |Δ|·255 ${m.delta.toExponential(2)}, ±1 share ${(m.share * 100).toFixed(4)}%, largest 8-bit ${m.max}`)
      keepWorst(worst, sc.class_type, m, `${sc.w}² seed ${sc.seed}`)
    }
    reportAndCheck('warp large', worst)
  }, 1_800_000)
})

// ── −0 through the last clamp ────────────────────────────────────────────────

describe('−0 through each node\'s last clamp (as a Dither upstream leaves it): kept only where torch\'s loop keeps it', () => {
  for (const nz of FX.negzero) {
    it(nz.name, () => {
      const [B, H, W, C] = nz.input.shape
      const v = hashedValues(B * H * W * C, nz.input.seed)
      for (let i = 0; i < v.length; i += nz.input.neg_zero_every) v[i] = -0
      const op = coreOp(EFFECTS[nz.class_type]!.op) as unknown as Op
      const p = paramsOf({ class_type: nz.class_type, widgets: nz.widgets } as FxCase)
      for (let b = 0; b < B; b++) {
        const t = tk.tensor(C, H, W)
        const n = H * W
        for (let i = 0; i < n; i++) for (let k = 0; k < C; k++) t.data[k * n + i] = v[(b * n + i) * C + k]!
        const out = op({ image: t }, p, undefined, {}, b, B).outputs[0]!
        const item = nz.items[b]!
        const got = interleaved(out)
        let negs = 0
        for (const x of got) if (Object.is(x, -0)) negs++
        expect(negs, `picture ${b}: −0s`).toBe(item.neg_zeros)
        expect(sha256(new Uint8Array(got.buffer)), `picture ${b}`).toBe(item.f32_sha256)
      }
    })
  }

  it('the probes reach the tails: Crop keeps some −0 in each of its layouts, a grid warp none', () => {
    const negs = (name: string) => FX.negzero.filter(x => x.name.startsWith(name)).flatMap(x => x.items.map(i => i.neg_zeros))
    expect(negs('CropImage {\'left\': 0.1').some(n => n > 0)).toBe(true)
    expect(negs('CropImage {\'left\': 0.3').some(n => n > 0)).toBe(true)
    expect(negs('LensCorrection').every(n => n === 0)).toBe(true)
  })
})

// ── Output size: Resize and Crop (rule 7) ────────────────────────────────────

describe('the output size of Resize and Crop, known before any pixel is decoded', () => {
  it('effectOutSize is each case\'s output size (Resize: floor(side·scale); Crop: its truncated box); the others keep the size', () => {
    let n = 0
    for (const c of FX.cases.filter(x => !x.error && x.inputs.image!.source !== 'blank')) {
      const item = c.outputs![0]!.items[0]!
      const [pic] = pictureSizeOf(c)
      const out = effectOutSize(c.class_type, paramsOf(c as FxCase), pic!) ?? pic!
      expect([out.w, out.h], c.name).toEqual([item.w, item.h])
      expect(EFFECTS[c.class_type]!.outSize?.(paramsOf(c as FxCase), pic!) ?? pic, c.name).toEqual(out)
      n++
    }
    expect(n).toBeGreaterThan(800)
    expect([...EFFECT_RESIZING_CLASSES].sort()).toEqual(['CropImage', 'ResizeImage'])
  })

  it('a Resize the start of the take can size from an Image card\'s or LoadImage\'s header is refused there, before the hold, over the cap', async () => {
    const png = await solidPng(4096)
    const loadImage = (n: string) => ({ class_type: 'LoadImage', inputs: { image: n, upload: 'image' } })
    for (const [hosted, scale, message] of [[false, 2.05, EFFECT_PICTURE_TOO_LARGE], [true, 1.05, EFFECT_PICTURE_TOO_LARGE_HOSTED]] as const) {
      for (const make of [card, loadImage]) {
        const k = makeKit({ hosted, deps: { families: () => WARP } })
        put(k.root, 'big.png', png)
        const p: ApiPrompt = { 0: make('big.png'), fx: effect('ResizeImage', ['0', 0], { scale, mode: 'nearest' }) }
        expect(isRunnerEligible(p, WARP)).toBe(true)
        expect(cardPictureFiles(p, WARP).find(f => f.resized)?.resized).toMatchObject({ nodeId: 'fx', classType: 'ResizeImage' })
        await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START }), `hosted ${hosted} ${make('x').class_type}`)
          .rejects.toMatchObject({ statusCode: 400, message })
        expect(k.ledger.hold).not.toHaveBeenCalled()
      }
    }
  }, 60_000)

  it('effectOutRefusal: the boundary, the hosted cap, Crop never over, EXIF-turned sides, and a class that keeps the size', () => {
    const at = (cls: string, inputs: Record<string, unknown>, width: number, height: number, hosted = false, orientation?: number, loader = 'Image') =>
      effectOutRefusal({ classType: cls, inputs }, loader, { width, height, orientation }, hosted)
    expect(at('ResizeImage', { scale: 2, mode: 'bilinear' }, 4096, 4096)).toBeNull()
    expect(at('ResizeImage', { scale: 2.05, mode: 'bilinear' }, 4096, 4096)).toBe(EFFECT_PICTURE_TOO_LARGE)
    expect(at('ResizeImage', { scale: 4, mode: 'area' }, 2048, 2048)).toBeNull()
    expect(at('ResizeImage', { scale: 4, mode: 'area' }, 2049, 2048)).toBe(EFFECT_PICTURE_TOO_LARGE)
    expect(at('ResizeImage', { scale: 1, mode: 'area' }, 2049, 2048, true)).toBeNull()
    // 2731 · 1.5 = 4096.5: floor 4096, exactly the hosted cap; 2732 · 1.5 = 4098 is over it.
    expect(at('ResizeImage', { scale: 1.5, mode: 'area' }, 2731, 2731, true)).toBeNull()
    expect(at('ResizeImage', { scale: 1.5, mode: 'area' }, 2732, 2731, true)).toBe(EFFECT_PICTURE_TOO_LARGE_HOSTED)
    expect(at('ResizeImage', { scale: '2.05', mode: 'area' }, 4096, 4096)).toBe(EFFECT_PICTURE_TOO_LARGE)
    expect(at('CropImage', { left: 0, right: 0, top: 0, bottom: 0 }, 8192, 8192)).toBeNull()
    expect(at('FlipImage', { horizontal: true, vertical: false }, 9000, 9000)).toBeNull()
    // EXIF 5–8: the loader turns the picture, so the sides swap (Crop's box is not symmetric).
    expect(effectOutSize('CropImage', { left: 0.49, right: 0, top: 0, bottom: 0 }, { w: 100, h: 50 })).toEqual({ w: 51, h: 50 })
    expect(effectOutSize('CropImage', { left: 0.49, right: 0, top: 0, bottom: 0 }, { w: 50, h: 100 })).toEqual({ w: 26, h: 100 })
    expect(at('ResizeImage', { scale: 4, mode: 'area' }, 2048, 2049, false, 6, 'LoadImage')).toBe(EFFECT_PICTURE_TOO_LARGE)
  })

  it('Kaleidoscope is taken up to 4096² (its own cap): refused above it at the start from a loader\'s header, and at its turn, before any pixel is decoded', async () => {
    expect(EFFECT_CLASS_MAX_PIXELS).toEqual({ Kaleidoscope: 4096 * 4096 })
    const at = (w: number, h: number, hosted = false) => effectOutRefusal({ classType: 'Kaleidoscope', inputs: defaultsOf('Kaleidoscope') }, 'Image', { width: w, height: h }, hosted)
    expect(at(4096, 4096)).toBeNull()
    expect(at(4097, 4096)).toBe(EFFECT_PICTURE_TOO_LARGE_FOR_CLASS)
    expect(at(4097, 4096, true)).toBe(EFFECT_PICTURE_TOO_LARGE_HOSTED)
    expect(effectPictureCap('Twirl', false).max).toBe(8192 * 8192)
    expect(await gate('Kaleidoscope', defaultsOf('Kaleidoscope'), 4096)).toBe('accepted')
    expect(await gate('Kaleidoscope', defaultsOf('Kaleidoscope'), 4100)).toBe(EFFECT_PICTURE_TOO_LARGE_FOR_CLASS)
    expect(EFFECT_PICTURE_TOO_LARGE_FOR_CLASS).toMatch(/^This effect works on pictures up to 4096 × 4096 pixels\. Use a smaller picture\.$/)
    const k = makeKit({ hosted: false, deps: { families: () => WARP } })
    put(k.root, 'big.png', await solidPng(4100))
    const p: ApiPrompt = { 0: card('big.png'), fx: effect('Kaleidoscope', ['0', 0], defaultsOf('Kaleidoscope')) }
    await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START })).rejects.toMatchObject({ statusCode: 400, message: EFFECT_PICTURE_TOO_LARGE_FOR_CLASS })
    expect(k.ledger.hold).not.toHaveBeenCalled()
  }, 120_000)

  it('a Resize fed a picture made in the run is refused at its turn, before any pixel is decoded; Crop\'s output never passes its input', async () => {
    expect(await gate('ResizeImage', { scale: 4, mode: 'bilinear' }, 4096)).toBe(EFFECT_PICTURE_TOO_LARGE)
    expect(await gate('ResizeImage', { scale: 1.5, mode: 'bilinear' }, 4096, { hosted: true })).toBe(EFFECT_PICTURE_TOO_LARGE_HOSTED)
    // Sixteen 4096² made 1.05× larger: one fits, sixteen pass the node's total.
    expect(await gate('ResizeImage', { scale: 1.05, mode: 'nearest' }, 4096, { count: 16 })).toBe(EFFECT_PICTURES_TOO_LARGE)
    expect(await gate('ResizeImage', { scale: 2, mode: 'nearest' }, 4096)).toBe('accepted')
    expect(await gate('CropImage', { left: 0.2, right: 0.2, top: 0, bottom: 0 }, 8192)).toBe('accepted')
  }, 120_000)
})

/** A case's input picture sizes (each file's, from its PNG header). */
function pictureSizeOf(c: WarpCase): { w: number; h: number }[] {
  return c.inputs.image!.files.map((f) => {
    const b = b64(FX.assets[f]!)
    const v = new DataView(b.buffer, b.byteOffset)
    return { w: v.getUint32(16), h: v.getUint32(20) }
  })
}

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
    for (const cls of WARP_CLASSES) {
      const p: ApiPrompt = { 0: card('a.png'), fx: effect(cls, ['0', 0], defaultsOf(cls)) }
      expect(runnerTakesWorkflow(p, WARP), cls).toBe(true)
      expect(nodesNeedingEngine(p, { runnerOn: true, families: WARP, titleOf: id => id }), cls).toEqual([])
      for (const fam of [new Set<RunnerFamily>(['cards']), new Set<RunnerFamily>(['cards', 'effects-blur', 'effects-tone', 'effects-cells']), new Set<RunnerFamily>(['effects-warp'])]) {
        expect(runnerTakesWorkflow(p, fam), `${cls} ${[...fam]}`).toBe(false)
        expect(nodesNeedingEngine(p, { runnerOn: true, families: fam, titleOf: id => id }), `${cls} ${[...fam]}`).toEqual(['fx'])
      }
    }
  })

  it('node by node: each class, its source card and its reader, with cards and the family on and off', () => {
    for (const cls of WARP_CLASSES) {
      const q: ApiPrompt = { 0: card('a.png'), fx: effect(cls, ['0', 0], defaultsOf(cls)), e: editNode(['fx', 0]), o: outCard('e') }
      const take = (fam: RunnerFamily[]) => Object.fromEntries(Object.keys(q).map(id => [id, runnerTakesNode(q, id, new Set(fam))]))
      expect(take(['cards', 'effects-warp', 'fal-edit']), cls).toEqual({ 0: true, fx: true, e: true, o: true })
      expect(isRunnerEligible(q, WARP_EDIT), cls).toBe(true)
      for (const fam of [['effects-warp', 'fal-edit'], ['cards', 'fal-edit'], ['cards', 'effects-tone', 'fal-edit']] as RunnerFamily[][]) {
        expect(take(fam), `${cls} ${fam}`).toEqual({ 0: true, fx: false, e: true, o: true })
        expect(isRunnerEligible(q, new Set(fam)), `${cls} ${fam}`).toBe(false)
      }
    }
  })

  it('widgets ComfyUI would refuse leave it to the engine', () => {
    const take = (cls: string, over: Record<string, unknown>) => runnerTakesNode({ 0: card('a.png'), fx: effect(cls, ['0', 0], { ...defaultsOf(cls), ...over }) }, 'fx', WARP)
    expect(take('ResizeImage', { scale: 4 })).toBe(true)
    expect(take('ResizeImage', { scale: 4.01 })).toBe(false)
    expect(take('ResizeImage', { scale: 0.09 })).toBe(false)
    expect(take('ResizeImage', { mode: 'lanczos' })).toBe(false)
    expect(take('CropImage', { left: 0.5 })).toBe(false)
    expect(take('RotateImage', { angle: 181 })).toBe(false)
    expect(take('Kaleidoscope', { segments: 21 })).toBe(false)
    expect(take('Mirror', { mode: 'diagonal' })).toBe(false)
    expect(take('GodRays', { samples: 81 })).toBe(false)
    expect(take('Wave', { axis: 'diagonal' })).toBe(false)
  })
})

// ── With every effects family off, nothing changes (rule 12) ─────────────────

/** The graph with an effect of class `cls` (its defaults) spliced in after every picture output. */
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
  ['every family but cards', RUNNER_FAMILIES.filter(f => f !== 'cards')],
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
    for (const cls of WARP_CLASSES) {
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

  projectsIt('over every saved project graph, each with one of the 15 classes (in turn) spliced in after every picture', async () => {
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
        const cls = WARP_CLASSES[graphs % WARP_CLASSES.length]!
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
    expect([...used].sort()).toEqual([...WARP_CLASSES].sort())
    expect(changedWhenOn).toBeGreaterThan(0)
    console.info(`warp families-off invariant: ${graphs} saved graphs, ${spliced} with a warp class spliced in, ${changedWhenOn} read differently with the effects on`)
  }, 300_000)
})

// ── The engine ───────────────────────────────────────────────────────────────

describe('the engine (cards and effects-warp on)', () => {
  const c = FX.cases.find(x => x.name === 'Mirror: quadrant_tr, seam 0.5, card 23×19 see-through')!
  const fileName = c.inputs.image!.files[0]!
  const fileBytes = b64(FX.assets[fileName]!)
  const item = c.outputs![0]!.items[0]!

  it('an effect feeding Edit an image hands off its kept round-8 PNG', async () => {
    const k = makeKit({ hosted: false, deps: { families: () => WARP_EDIT } })
    put(k.root, fileName, fileBytes)
    const p: ApiPrompt = { 0: card(fileName), [c.node_id]: effect(c.class_type, ['0', 0], c.widgets), e: editNode([c.node_id, 0]), o: outCard('e') }
    expect(isRunnerEligible(p, WARP_EDIT)).toBe(true)
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
    const k = makeKit({ hosted: false, deps: { families: () => WARP } })
    put(k.root, fileName, fileBytes)
    const p: ApiPrompt = { 0: card(fileName), [c.node_id]: effect(c.class_type, ['0', 0], c.widgets), s: saveImage([c.node_id, 0]) }
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.status).toBe('done')
    const saved = await pngPixels(new Uint8Array(readFileSync(join(k.root, 'output', 'ComfyUI_00001_.png'))))
    expect(saved.channels).toBe(4)
    expect(sha256(saved.px)).toBe(item.trunc8_sha256)
  })

  it('Resize → Frame: the kept picture has the new size, and the Frame sizes its canvas from it and renders Python\'s picture exactly', async () => {
    const ch = FX.frame
    const file = ch.inputs.image!.files[0]!
    const kept = createMemoryKeptBytes()
    const k = makeKit({ hosted: false, deps: { families: () => WARP_FRAME, kept } })
    put(k.root, file, b64(FX.assets[file]!))
    const fx = ch.effect
    const p: ApiPrompt = { 0: card(file), [fx.node_id]: effect(fx.class_type, ['0', 0], fx.widgets), f: { class_type: 'Compositor', inputs: frameWidgets({ ...ch.frame.widgets, layer1: [fx.node_id, 0] }) } }
    expect(isRunnerEligible(p, WARP_FRAME)).toBe(true)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    const v = run.takes[0]!.nodes[fx.node_id]!.values![0] as Extract<RunnerValue, { kind: 'files' }>
    expect(v.tensors).toHaveLength(1)
    // 23 × 19 at 1.5: 34 × 28.
    const resized = await pngPixels(await kept.read(v.files[0]!))
    expect([resized.w, resized.h]).toEqual([34, 28])
    const frameFile = run.takes[0]!.nodes.f!.outputs[0]!
    const frame = await pngPixels(new Uint8Array(readFileSync(join(k.root, frameFile.type, frameFile.subfolder, frameFile.filename))))
    expect([frame.w, frame.h, frame.channels]).toEqual([ch.frame.w, ch.frame.h, 3])
    expect([ch.frame.w, ch.frame.h]).toEqual([34, 28])
    expect(Buffer.compare(frame.px, b64(ch.frame.image8))).toBe(0)
  })
})

// ── Work (rule 7) ────────────────────────────────────────────────────────────

/** A picture file as a Frame (source 'rgb') would keep it (listed `count` times in the batch), run through planEffect on the real worker. */
async function runBig(cls: string, widgets: Record<string, unknown>, png: Uint8Array, o: { count?: number; hosted?: boolean } = {}) {
  const c = { name: cls, class_type: cls, node_id: 'fx', widgets, inputs: { image: { source: 'rgb' as const, files: Array.from({ length: o.count ?? 1 }, () => 'big.png') } } }
  const pic = pictureOf(c as FxCase)
  const mem = memoryIO({ 'big.png': png }, 'fx', { hosted: o.hosted })
  const plan: NodePlan = await planNode({ prompt: pic.prompt, nodeId: 'fx', families: WARP, gateOpen: false, hosted: o.hosted, filesFrom: pic.filesOf, toUrl: async () => '' })
  return { mem, derive: () => (plan as Extract<NodePlan, { kind: 'derive' }>).derive(mem.io) }
}

const solids = new Map<number, Promise<Uint8Array>>()
function solidPng(side: number): Promise<Uint8Array> {
  if (!solids.has(side)) {
    solids.set(side, sharp({ create: { width: side, height: side, channels: 3, background: { r: 90, g: 120, b: 200 } }, limitInputPixels: false })
      .png({ compressionLevel: 1 }).toBuffer().then(b => new Uint8Array(b)))
  }
  return solids.get(side)!
}

/** What planEffect's caps and budget make of this node on a side × side picture, the decoder refusing to run ('accepted': it got to the decode). */
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

describe('work', () => {
  it('every class\'s defaults are accepted at 4096² and its heaviest setting is accepted or refused before decoding', async () => {
    const heaviest: Record<string, Record<string, unknown>> = {
      ResizeImage: { scale: 2, mode: 'bicubic' }, GodRays: { samples: 80, intensity: 1 }, CRT: { chroma: 0.02, curvature: 0.2, scanlines: 1, rgb_mask: 1 },
      RotateImage: { angle: 45 }, Twirl: { angle: 360 },
    }
    const report: string[] = []
    for (const cls of WARP_CLASSES) {
      expect(await gate(cls, defaultsOf(cls), 4096), `${cls} defaults at 4096²`).toBe('accepted')
      const h4 = await gate(cls, { ...defaultsOf(cls), ...heaviest[cls] }, 4096)
      expect(['accepted', EFFECT_TOO_MUCH_WORK], `${cls} heaviest at 4096²`).toContain(h4)
      const d8 = await gate(cls, defaultsOf(cls), 8192)
      expect(cls === 'Kaleidoscope' ? [EFFECT_PICTURE_TOO_LARGE_FOR_CLASS] : ['accepted', EFFECT_TOO_MUCH_WORK], `${cls} defaults at 8192²`).toContain(d8)
      report.push(`${cls} ${h4 === 'accepted' ? 'ok' : 'over'}/${d8 === 'accepted' ? 'ok' : 'over'}`)
    }
    console.info(`warp budget through plan.ts (heaviest at 4096² / defaults at 8192²): ${report.join(', ')}`)
  }, 300_000)

  it('GodRays at 80 samples on 8192² is over the budget and fails before any pixel is decoded', async () => {
    const w = { ...defaultsOf('GodRays'), samples: 80 }
    expect(EFFECTS.GodRays!.work!(w, { w: 8192, h: 8192 })).toBeGreaterThan(EFFECT_MAX_WORK)
    expect(await gate('GodRays', w, 8192)).toBe(EFFECT_TOO_MUCH_WORK)
  }, 60_000)

  it('time check: the heaviest grid warps at their budget\'s edge on a 2048² rgb picture, on the worker', async () => {
    const side = 2048
    const png = new Uint8Array(await sharp({ create: { width: side, height: side, channels: 3, background: { r: 128, g: 128, b: 128 }, noise: { type: 'gaussian', mean: 128, sigma: 40 } }, limitInputPixels: false }).png({ compressionLevel: 1 }).toBuffer())
    const lines: string[] = []
    for (const [cls, widgets] of [['GodRays', { ...defaultsOf('GodRays'), samples: 80, intensity: 1 }], ['CRT', { chroma: 0.02, curvature: 0.2, scanlines: 1, rgb_mask: 1 }], ['Kaleidoscope', defaultsOf('Kaleidoscope')]] as const) {
      const work = EFFECTS[cls]!.work!(widgets, { w: side, h: side })
      const { derive } = await runBig(cls, widgets, png)
      const t0 = performance.now()
      const made = await derive()
      const s = (performance.now() - t0) / 1000
      expect(filesOfValue(made.values[0])).toHaveLength(1)
      lines.push(`${cls} ${s.toFixed(1)} s (work ${(work / 1e9).toFixed(2)} × 10⁹, the budget's rate ${(work / 0.37e9).toFixed(1)} s)`)
      expect(s).toBeLessThan(60)
    }
    console.info(`time check on 2048² rgb on the worker: ${lines.join('; ')}`)
  }, 300_000)
})

// ── The esbuild guard: the warp core with the kernels, built as Nitro builds server code ──

describe('esbuild guard: the warp core survives Nitro’s build, with its kernels', () => {
  const require = createRequire(import.meta.url)
  const pnpm = fileURLToPath(new URL('../../node_modules/.pnpm/', import.meta.url))
  const builds = readdirSync(pnpm).filter(d => /^esbuild@\d/.test(d)).map(d => join(pnpm, d, 'node_modules', 'esbuild'))
  const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../../server/runner/${rel}`, import.meta.url)), 'utf8')
  const dir = mkdtempSync(join(tmpdir(), 'warp-esbuild-'))
  // GodRays (exact: grid_sample many times, the decay) on a see-through card.
  const c = FX.cases.find(x => x.name === 'GodRays: centre 1.0, 0.0, samples 4, card 23×19 see-through')!

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
        const wm = await build('effects/core/warp.ts', 'warp')
        const pxB = new Function(`return (${px.pixelsCore!.toString()})()`)()
        const tkB = new Function('px', `return (${tkm.tensorCore!.toString()})(px)`)(pxB)
        const knB = new Function('k', 'px', `return (${knm.kernelsCore!.toString()})(k, px)`)(tkB, pxB)
        const warpB = new Function('k', 'kn', `return (${wm.warpCore!.toString()})(k, kn)`)(tkB, knB) as Record<string, Op>
        const [inp] = await tensorsOf(c as FxCase)
        const item = c.outputs![0]!.items[0]!
        expectExactItem(warpB.GodRays!(inp!, paramsOf(c as FxCase), undefined, {}, 0, 1).outputs[0]!, item, 'built in this thread')
        const cores = [
          { name: 'tk', fn: tkm.tensorCore as never, args: ['px'] },
          { name: 'kn', fn: knm.kernelsCore as never, args: ['tk', 'px'] },
          { name: 'warp', fn: wm.warpCore as never, args: ['tk', 'kn'] },
        ]
        const w = new Worker(workerScript(compositorCore, px.pixelsCore as never, cores), { eval: true, workerData: { stop: new SharedArrayBuffer(4) } })
        try {
          const reply = (m: Record<string, unknown>) => new Promise<any>((res) => { w.once('message', res); w.postMessage(m) })
          const { files } = pictureOf(c as FxCase)
          const raw = await decodeRaw(files[c.inputs.image!.files[0]!]!, 'card')
          expect((await reply({ id: 1, op: 'fx.begin', cls: c.class_type, fn: 'warp.GodRays', params: paramsOf(c as FxCase), count: 1 })).error).toBeUndefined()
          const r = await reply({ id: 2, op: 'fx.run', index: 0, inputs: { image: raw }, first: true, masks: [false], want: { round: [true], trunc: [false] } })
          expect(r.error).toBeUndefined()
          expect(sha256(r.value.outputs[0].round8)).toBe(item.round8_sha256)
          expect(sha256(r.value.preview.px)).toBe(c.preview!.px_sha256)
        }
        finally { await w.terminate() }
      }, 30_000)
    }
  }
})

// ── Stop ─────────────────────────────────────────────────────────────────────

describe('Stop', () => {
  const PATHS: [string, Record<string, unknown>][] = [
    ['CropImage', { left: 0.1 }], ['ResizeImage', { scale: 1 }], ['ResizeImage', { scale: 1.5, mode: 'bilinear' }], ['ResizeImage', { scale: 1.5, mode: 'bicubic' }],
    ['ResizeImage', { scale: 0.5, mode: 'nearest' }], ['ResizeImage', { scale: 0.5, mode: 'area' }],
    ['RotateImage', { angle: 30 }], ['RotateImage', { angle: 0 }], ['FlipImage', { horizontal: true }],
    ['Pinch', { amount: 0.3 }], ['Twirl', { angle: 90 }], ['Wave', { amplitude: 0.1 }], ['LensCorrection', { distortion: 0.2 }],
    ['Kaleidoscope', {}], ['PolarCoords', {}], ['PolarCoords', { direction: 'polar_to_rect' }], ['Fisheye', {}],
    ['ChromaticAberration', {}], ['CRT', {}], ['CRT', { curvature: 0, chroma: 0 }], ['Mirror', {}], ['Mirror', { mode: 'quadrant_tr' }], ['GodRays', { samples: 6 }],
  ]
  const x = tk.tensor(3, 256, 40)
  for (let i = 0; i < x.data.length; i++) x.data[i] = (i % 97) / 97

  for (const [cls, over] of PATHS) {
    it(`${cls} ${JSON.stringify(over)}: every Stop check along the run stops it`, () => {
      const op = coreOp(EFFECTS[cls]!.op) as unknown as Op
      const p = { ...defaultsOf(cls), ...over }
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
