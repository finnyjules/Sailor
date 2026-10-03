/**
 * R2.9: generators, seeded looks and Add noise (family effects-noise,
 * server/runner/effects/core/noise.ts), against the real Python nodes
 * (scripts/runner_effects_fixtures.py --group noise →
 * fixtures/runner-effects-noise.json).
 *
 * EXACT (float32 bit for bit, by sha256): Glitch, Perlin noise, Voronoi,
 * Gradient, Palette quantize, Reaction-diffusion (its laplacian through
 * kernels.ts conv2dWinograd3x3, torch's Winograd depthwise path on this Mac,
 * proven on its own in `winograd`) and Stipple. LIBRARY (8-bit equal but
 * where Python's float lies within the class's ε of a boundary, there one
 * level): Film grain and Add noise (randn's sin / cos / log), Fractal (sin).
 * Flow field is the "warp" parity class (R2.7 amendment): torch's SLEEF cos /
 * sin move grid_sample's taps. Add noise is exact under the fixtures' seeds
 * (the runner handed the seed Python's global generator was given) and, with
 * the runner's own seed (addNoiseSeedBase / addNoiseSeedOf), within the
 * spec's visual bounds. Every class's largest array is capped (effectPeakValues).
 */
import { createHash } from 'node:crypto'
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
import { RUNNER_OUTPUT_CLASSES, runnerTakesWorkflow } from '#shared/runner/validate'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import {
  EFFECT_CLASSES_PORTED, EFFECT_ERROR_MESSAGES, EFFECT_FAMILIES, EFFECT_FAMILY_OF, EFFECT_GENERATOR_CLASSES, EFFECT_IO_WORK_PER_VALUE,
  EFFECT_HOSTED_MAX_VALUES, EFFECT_MAX_VALUES, EFFECT_MAX_WORK, EFFECT_TOO_MUCH_MEMORY, EFFECT_TOO_MUCH_WORK, effectOutputSizeFits, effectPeakFits,
  effectPeakValues, effectSchemaOf, generatorWork,
} from '#shared/runner/effects'
import { EFFECTS } from '~~/server/runner/effects/table'
import { effectCores } from '~~/server/runner/effects/cores'
import { addNoiseSeedBase, addNoiseSeedOf } from '~~/server/runner/effects/plan'
import type { Tensor } from '~~/server/runner/effects/core/tensor'
import { decodeRaw } from '~~/server/runner/compositor/decode'
import { workerScript } from '~~/server/runner/compositor/worker'
import { compositorCore } from '~~/server/runner/compositor/plane'
import { planNode, type NodePlan } from '~~/server/runner/executors'
import type { RunnerValue } from '~~/server/runner/types'
import { createMemoryKeptBytes } from '~~/server/runner/keptBytes'

/** The picture decoder, watched (as the other effect specs): a refusal that came before any pixel was decoded. */
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

/** A library item keeps its small float (`f32s`, byte-shuffled, zlib); a warp-class hashed one round8z / trunc8_off / windows (as the warp group). */
interface NoiseItem extends FxItem { f32s?: string; round8z?: string; trunc8_off?: string; windows?: [number, number, number, number, string][] }
interface NoiseCase extends Omit<FxCase, 'outputs'> { outputs?: { kind: 'image'; items: NoiseItem[] }[]; global_seed?: number }
interface WinogradCase {
  name: string; shape: [number, number, number, number]; seed: number; lo: number; hi: number; zeros: boolean; pad: number
  kernels: number[][]; out_shape: number[]; f32_sha256: string; f32?: string
}
interface NoiseFx extends Omit<FxFile, 'cases'> {
  cases: NoiseCase[]
  library_eps: Record<string, number>
  warp_classes: string[]
  winograd: WinogradCase[]
  stats: { type: string; monochromatic: boolean; amount: number; global_seed: number; means: number[]; std: number }[]
  frame: { name: string; inputs: FxCase['inputs']; effect: { class_type: string; node_id: string; widgets: Record<string, unknown> }; frame: { widgets: Record<string, unknown>; w: number; h: number; image8: string } }
}
const FX = withAssets(loadFixtures('noise') as unknown as FxFile) as unknown as NoiseFx

const NOISE_CLASSES = ['FilmGrain', 'Glitch', 'PerlinNoise', 'Voronoi', 'GradientGenerator', 'PaletteQuantize', 'ReactionDiffusion', 'Fractal', 'Stipple', 'FlowField', 'AddNoise']
const PICTURE_CLASSES = NOISE_CLASSES.filter(c => !EFFECT_GENERATOR_CLASSES.includes(c))

/**
 * The library classes' ε (255-scale), the fixture script's table: at least
 * 4× the worst |Δ|·255 measured over this fixture and `--sweep` (200 fresh
 * cases; R2.9 report), never above 2⁻⁸.
 *   FilmGrain        3.0e-5  randn's libm vs V8 (an ulp or two of a draw) × the grain's scale
 *   AddNoise         1.5e-5  the same, through amount · 0.5
 *   Fractal          1.5e-5  sin of ≤ max_iter distinct angles (Math.sin vs SLEEF)
 *   PaletteQuantize  0       bit-exact on every case measured; library for its
 *                            means (torch's reduction of a large cluster may split)
 */
const LIBRARY_EPS: Readonly<Record<string, number>> = {
  FilmGrain: 2 ** -13,
  Fractal: 2 ** -13,
  PaletteQuantize: 2 ** -13,
  AddNoise: 2 ** -13,
}
const isLibrary = (cls: string) => Object.prototype.hasOwnProperty.call(LIBRARY_EPS, cls)

/**
 * The "warp" parity class (R2.7 amendment) for Flow field: its angle's cos
 * and sin are torch's SLEEF u10 (not correctly rounded; another SLEEF on
 * x86), and grid_sample turns an ulp of the grid into ulp · side / 2 pixels,
 * so the error grows with the picture. Every 8-bit value equal to Python's
 * or ±1 (±2 fails), the ±1 share and the float |Δ|·255 within these bounds,
 * about 2× the worst measured over the fixture and `--sweep` up to 8192²
 * (the largest picture an effect takes; R2.9 report): |Δ|·255 7.8e-3 on
 * small pictures, 0.050 at 2048², 0.090 at 4096², 0.172 at 8192²; ±1 share
 * at most 0.0243% (8192²); never ±2, so no size cap.
 */
const WARP_PARITY: Readonly<Record<string, { delta: number; share: number }>> = {
  FlowField: { delta: 0.35, share: 5e-4 },
}
const isWarpClass = (cls: string) => Object.prototype.hasOwnProperty.call(WARP_PARITY, cls)

const NOISE: ReadonlySet<RunnerFamily> = new Set(['cards', 'effects-noise'])
const NOISE_EDIT: ReadonlySet<RunnerFamily> = new Set(['cards', 'effects-noise', 'fal-edit'])
const NOISE_FRAME: ReadonlySet<RunnerFamily> = new Set(['cards', 'effects-noise', 'frame'])
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }

const tk = effectCores.tk
const kn = effectCores.kn

type Op = (inp: Record<string, Tensor>, p: Record<string, unknown>, stop?: () => boolean, state?: unknown, index?: number, count?: number) => { outputs: Tensor[]; preview: Tensor | null }

/** A class's widget defaults (its 'defaults' case: the picture classes' first, the generators' at their own size). */
function defaultsOf(cls: string): Record<string, unknown> {
  const c = FX.cases.find(x => x.class_type === cls && (x.name.startsWith(`${cls}: defaults,`) && !x.name.includes('64²')))
  if (!c) throw new Error(`no defaults case for ${cls}`)
  return c.widgets
}

/** The params the op gets: the case's widgets, prepared as the plan prepares them, with Add noise's seed (the one Python's global generator was given). */
function opParamsOf(c: NoiseCase, seed?: bigint | number): Record<string, unknown> {
  const spec = EFFECTS[c.class_type]!
  const p: Record<string, unknown> = { ...paramsOf(c as FxCase) }
  if (spec.seeded) p.seed = seed ?? c.global_seed
  return spec.prepare ? spec.prepare(p) : p
}

/** Runs an op over a batch as the plan does: a generator once; a two-pass effect sampling every picture first. */
function runBatch(op: Op, rows: Record<string, Tensor>[], p: Record<string, unknown>, gather: boolean, stop?: () => boolean): Tensor[] {
  const state = {}
  if (gather) rows.forEach((r, i) => op(r, p, stop, state, i, rows.length))
  return rows.map((r, i) => op(r, p, stop, state, i, rows.length).outputs[0]!)
}

/** The case's outputs from the core called in this thread (Add noise under `seed`, else Python's). */
async function coreRun(c: NoiseCase, seed?: bigint | number, build: Record<string, Op> | null = null): Promise<Tensor[]> {
  const spec = EFFECTS[c.class_type]!
  const op = build ? build[c.class_type]! : coreOp(spec.op) as unknown as Op
  const rows = Object.keys(c.inputs).length ? await tensorsOf(c as FxCase) : [{}]
  return runBatch(op, rows, opParamsOf(c, seed), !!spec.gather)
}

/** A case changed from a fixture case, tied to the fixture's assets (pictureOf reads them). */
function variant(c: NoiseCase, over: Partial<NoiseCase>): NoiseCase {
  const v = { ...c, ...over }
  withAssets({ ...(FX as unknown as FxFile), cases: [v as FxCase] })
  return v
}

/** A byte-shuffled float32 (`f32s`) back as floats. */
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

/** A small item's float, and Python's 8-bit forms derived from it (checked against Python's hashes). */
function pythonOf(item: NoiseItem): { f32: Float32Array; round8: Uint8Array; trunc8: Uint8Array } {
  const f32 = unshuffle(item.f32s!)
  expect(sha256(new Uint8Array(f32.buffer)), 'Python float from its shuffle').toBe(item.f32_sha256)
  const t = planarOf(f32, item)
  const round8 = tk.quantize(t, 'round')
  const trunc8 = tk.quantize(t, 'trunc')
  expect(sha256(round8), 'Python round8 from its float').toBe(item.round8_sha256)
  expect(sha256(trunc8), 'Python trunc8 from its float').toBe(item.trunc8_sha256)
  return { f32, round8, trunc8 }
}

/** 8-bit bytes against a library item in one mode: a small item within the band of its float; a hashed one by its band. */
function expectLibrary8(ts8: Uint8Array, item: NoiseItem, mode: 'round' | 'trunc', eps: number, label: string): void {
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

/** The float |Δ|·255 of a library output against Python's (small items). */
function deltaF(got: ArrayLike<number>, py: ArrayLike<number>): number {
  const clamp = (v: number) => Math.min(1, Math.max(0, v))
  let d = 0
  for (let j = 0; j < py.length; j++) d = Math.max(d, Math.abs(clamp(got[j]!) - clamp(py[j]!)) * 255)
  return d
}

function diff8(ts8: Uint8Array, py8: Uint8Array): { max: number; share: number } {
  let max = 0
  let n = 0
  for (let i = 0; i < ts8.length; i++) {
    const d = Math.abs(ts8[i]! - py8[i]!)
    if (d) { n++; if (d > max) max = d }
  }
  return { max, share: ts8.length ? n / ts8.length : 0 }
}

function warpVerdict(cls: string, ts8: Uint8Array, py8: Uint8Array, delta: number | null): string | null {
  const b = WARP_PARITY[cls]!
  if (ts8.length !== py8.length) return `${ts8.length} values, Python ${py8.length}`
  const d = diff8(ts8, py8)
  if (d.max > 1) return `an 8-bit value ${d.max} levels off`
  if (d.share > b.share) return `${(d.share * 100).toFixed(3)}% of values one level off (bound ${(b.share * 100).toFixed(3)}%)`
  if (delta !== null && delta > b.delta) return `float |Δ|·255 ${delta.toExponential(2)} (bound ${b.delta.toExponential(2)})`
  return null
}

/** Python's 8-bit bytes of a warp-class item: from its float (small) or its kept bytes (hashed). */
function python8(item: NoiseItem, mode: 'round' | 'trunc'): Uint8Array {
  if (item.f32s) {
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

/** The float |Δ|·255 of a warp-class output: its whole float (small) or its three windows (hashed). */
function warpDelta(t: Tensor, item: NoiseItem): number {
  const got = interleaved(t)
  if (item.f32s) return deltaF(got, pythonOf(item).f32)
  let d = 0
  for (const [x0, y0, ww, wh, z] of item.windows!) {
    const py = unshuffle(z)
    const part = new Float32Array(ww * wh * item.c)
    for (let y = 0; y < wh; y++) part.set(got.subarray(((y0 + y) * item.w + x0) * item.c, ((y0 + y) * item.w + x0 + ww) * item.c), y * ww * item.c)
    d = Math.max(d, deltaF(part, py))
  }
  return d
}

/** A warp-class item that is its input clamped (strength 0): kept by its hashes alone, matched exactly. */
const unchangedItem = (item: NoiseItem) => !item.f32s && !item.round8z

function expectWarp8(ts8: Uint8Array, item: NoiseItem, cls: string, mode: 'round' | 'trunc', label: string, delta: number | null = null): void {
  if (unchangedItem(item)) {
    expect(sha256(ts8), `${label}: unchanged`).toBe(mode === 'round' ? item.round8_sha256 : item.trunc8_sha256)
    return
  }
  expect(warpVerdict(cls, ts8, python8(item, mode), delta), label).toBeNull()
}

/** An exact output: its float32's sha256. */
function expectExactItem(t: Tensor, item: FxItem, label: string): void {
  const got = interleaved(t)
  expect(sha256(new Uint8Array(got.buffer, got.byteOffset, got.byteLength)), label).toBe(item.f32_sha256)
}

/** One item checked in the class's parity class (8-bit, in `mode`; a core's float too where it has one). */
function expectItem8(cls: string, ts8: Uint8Array, item: NoiseItem, mode: 'round' | 'trunc', label: string): void {
  if (isWarpClass(cls)) expectWarp8(ts8, item, cls, mode, label)
  else if (isLibrary(cls)) expectLibrary8(ts8, item, mode, LIBRARY_EPS[cls]!, label)
  else expect(sha256(ts8), label).toBe(mode === 'round' ? item.round8_sha256 : item.trunc8_sha256)
}

/** Python's raise, as the runner's key (rule 6). */
function keyOfError(e: { type: string; message: string }): string {
  if (/^The size of tensor a \(4\) must match the size of tensor b \(3\) at non-singleton dimension 3$/.test(e.message)) return 'EFFECT_NEEDS_RGB'
  if (/^The size of tensor a \(\d+\) must match the size of tensor b \(\d+\) at non-singleton dimension 2$/.test(e.message)) return 'EFFECT_GRAIN_TOO_FINE'
  if (/^Expected 3D or 4D \(batch mode\) tensor with optional 0 dim batch size for input/.test(e.message)) return 'EFFECT_PICTURE_TOO_SMALL'
  throw new Error(`an unmapped Python raise: ${e.type}: ${e.message}`)
}

// ── The fixture file itself ──────────────────────────────────────────────────

describe('the noise fixtures', () => {
  it('cover the 11 classes, made by multi-threaded torch, with the same ε table as the script, under 8 MB', () => {
    expect(FX.threads).toBeGreaterThan(1)
    expect([...new Set(FX.cases.map(c => c.class_type))].sort()).toEqual([...NOISE_CLASSES].sort())
    expect(FX.library_eps).toEqual(LIBRARY_EPS)
    for (const eps of Object.values(LIBRARY_EPS)) expect(eps).toBeLessThanOrEqual(2 ** -8)
    expect(FX.warp_classes).toEqual(Object.keys(WARP_PARITY))
    expect(FX.cases.length).toBeGreaterThan(450)
    expect(FX.winograd.length).toBeGreaterThanOrEqual(40)
    expect(readFileSync(resolve(__dirname, 'fixtures/runner-effects-noise.json')).length).toBeLessThanOrEqual(8 * 1024 * 1024)
  })

  it('every class is ported: in the table, in the family, with a row and its output node', () => {
    for (const cls of NOISE_CLASSES) {
      expect(EFFECTS[cls], cls).toMatchObject({ family: 'effects-noise', op: `noise.${cls}` })
      expect(EFFECT_CLASSES_PORTED, cls).toContain(cls)
      expect(EFFECT_FAMILY_OF[cls], cls).toBe('effects-noise')
      expect(RUNNER_NODE_RULES[cls]?.family, cls).toBe('effects-noise')
      expect(RUNNER_NODE_RULES[cls]!.local, cls).toBe('render')
      expect(RUNNER_NODE_RULES[cls]!.inputCheck, cls).toEqual(cls === 'Stipple' ? ['effect-preview-name', 'effect-output-size', 'effect-text'] : ['effect-preview-name', 'effect-output-size'])
      expect(RUNNER_OUTPUT_CLASSES.has(cls), cls).toBe(true)
      expect(typeof (effectCores.noise as unknown as Record<string, unknown>)[cls], cls).toBe('function')
    }
    // The batch kinds (rule 5).
    expect(Object.fromEntries(NOISE_CLASSES.map(c => [c, EFFECTS[c]!.batch]))).toEqual({
      FilmGrain: 'coupled', Glitch: 'coupled', PerlinNoise: 'generator', Voronoi: 'generator', GradientGenerator: 'generator', PaletteQuantize: 'coupled',
      ReactionDiffusion: 'generator', Fractal: 'generator', Stipple: 'coupled', FlowField: 'pure', AddNoise: 'coupled',
    })
    expect(EFFECTS.PaletteQuantize!.gather).toBe(true)
    expect(EFFECTS.AddNoise!.seeded).toBe(true)
    // The core's helpers are not ops.
    expect(Object.keys(effectCores.noise).sort()).toEqual([...NOISE_CLASSES].sort())
  })

  it('a Python raise is Film grain finer than 1, Stipple on 4 channels, or Stipple with no whole cell', () => {
    const errors = FX.cases.filter(c => c.error)
    expect([...new Set(errors.map(c => c.class_type))].sort()).toEqual(['FilmGrain', 'Stipple'])
    for (const c of errors) {
      const key = keyOfError(c.error!)
      if (c.class_type === 'FilmGrain') {
        expect(key, c.name).toBe('EFFECT_GRAIN_TOO_FINE')
        expect(c.widgets.size as number, c.name).toBeLessThan(1)
      }
      else expect(key, c.name).toBe(c.inputs.image!.source === 'blank' ? 'EFFECT_PICTURE_TOO_SMALL' : 'EFFECT_NEEDS_RGB')
    }
    expect(EFFECT_ERROR_MESSAGES.EFFECT_GRAIN_TOO_FINE).toBe('This grain size is too fine for this picture. Use a grain size of 1 or more.')
  })

  it('Python\'s preview file is its output\'s trunc8', () => {
    for (const c of FX.cases.filter(x => !x.error)) expect(c.preview!.px_sha256, c.name).toBe(c.outputs![0]!.items[0]!.trunc8_sha256)
  })
})

// ── The Winograd depthwise conv (kernels.ts conv2dWinograd3x3) ───────────────

/** scripts/runner_effects_fixtures.py `hashed_values`. */
function hashedValues(n: number, seed: number, lo = 0, hi = 1): Float32Array {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const k = Math.floor(((i * 2654435761 + seed * 40503) % 4294967296) / 256)
    out[i] = Math.fround(lo + (hi - lo) * (k / 16777216))
  }
  return out
}

describe('kernels.ts conv2dWinograd3x3 against F.conv2d (torch\'s Winograd3x3Depthwise path on this Mac), bit for bit', () => {
  it('covers the laplacian and random kernels, odd sizes, padding 0 and 1, three channels grouped, a batch of two, signed zeros', () => {
    const w = FX.winograd
    expect(w.some(c => c.name.startsWith('laplacian'))).toBe(true)
    expect(w.some(c => c.name.startsWith('random'))).toBe(true)
    expect(w.some(c => c.pad === 0) && w.some(c => c.pad === 1)).toBe(true)
    expect(w.some(c => c.shape[1] === 3) && w.some(c => c.shape[0] === 2)).toBe(true)
    expect(w.some(c => c.shape[2] % 2 === 1 && c.shape[3] % 2 === 1)).toBe(true)
    expect(w.some(c => c.zeros)).toBe(true)
  })

  for (const wc of FX.winograd) {
    it(wc.name, () => {
      const [B, C, H, W] = wc.shape
      const v = hashedValues(B * C * H * W, wc.seed, wc.lo, wc.hi)
      if (wc.zeros) {
        for (let i = 0; i < v.length; i += 5) v[i] = -0
        v.fill(0, 0, Math.min(v.length, 2 * W))
      }
      const out = new Float32Array(wc.out_shape.reduce((a, b) => a * b, 1))
      const per = C * H * W
      for (let b = 0; b < B; b++) {
        const t: Tensor = { c: C, h: H, w: W, data: v.slice(b * per, (b + 1) * per) }
        const r = kn.conv2dWinograd3x3(t, wc.kernels.flat(), wc.pad)
        expect([B, r.c, r.h, r.w]).toEqual(wc.out_shape)
        out.set(r.data, b * r.data.length)
      }
      const bytes = new Uint8Array(out.buffer)
      if (sha256(bytes) !== wc.f32_sha256 && wc.f32) {
        const py = new Float32Array(b64(wc.f32).buffer.slice(0))
        const at = py.findIndex((x, j) => !Object.is(x, out[j]))
        expect.fail(`value ${at} is ${out[at]}, torch's ${py[at]}`)
      }
      expect(sha256(bytes)).toBe(wc.f32_sha256)
    })
  }

  it('refuses a kernel list of the wrong size, a negative pad and an output of nothing', () => {
    const t: Tensor = { c: 2, h: 5, w: 5, data: new Float32Array(50) }
    expect(() => kn.conv2dWinograd3x3(t, new Float32Array(9), 0)).toThrow(/wrong size/)
    expect(() => kn.conv2dWinograd3x3({ c: 1, h: 5, w: 5, data: new Float32Array(25) }, new Float32Array(9), -1)).toThrow(/padding/)
    expect(() => kn.conv2dWinograd3x3({ c: 1, h: 2, w: 5, data: new Float32Array(10) }, new Float32Array(9), 0)).toThrow('EFFECT_PICTURE_TOO_SMALL')
  })

  it('is not conv2dDepthwise: the double-summed laplacian differs from torch\'s on these inputs (why Reaction-diffusion takes it)', () => {
    const wc = FX.winograd.find(c => c.name.startsWith('laplacian 1×1×21×18 pad 1 [0.0'))!
    const [, C, H, W] = wc.shape
    const t: Tensor = { c: C, h: H, w: W, data: hashedValues(C * H * W, wc.seed, wc.lo, wc.hi) }
    const r = kn.conv2dDepthwise(kn.padReflect(t, 0, 0, 0, 0), wc.kernels[0]!, 3, 3)
    const z = kn.conv2dWinograd3x3({ ...t, data: t.data }, wc.kernels[0]!, 0)
    expect(sha256(new Uint8Array(z.data.buffer))).not.toBe(sha256(new Uint8Array(r.data.buffer)))
  })
})

// ── Every case (rule 12) ─────────────────────────────────────────────────────

/** A generator case has no inputs: its prompt holds the node alone. */
const saveImage = (from: [string, number]) => ({ class_type: 'SaveImage', inputs: { images: from, filename_prefix: 'ComfyUI', format: 'png', quality: 90, lossless_webp: false, png_compression: 4, scale: 1, max_dimension: 0, embed_metadata: false } })

/** Each batch index's sha256 of the floats the op receives, as the worker hashes them for Add noise's seed. */
async function floatHashesOf(c: NoiseCase): Promise<string[]> {
  return (await tensorsOf(c as FxCase)).map((row) => {
    const h = createHash('sha256')
    for (const [name, t] of Object.entries(row)) {
      h.update(`${name}:${t.c}x${t.h}x${t.w};`)
      h.update(new Uint8Array(t.data.buffer, t.data.byteOffset, t.data.byteLength))
    }
    return h.digest('hex')
  })
}

/** Add noise's own seed for a case run as node `nodeId` (plan.ts's half and the worker's). */
async function ownSeedOf(c: NoiseCase, nodeId = c.node_id): Promise<bigint> {
  return addNoiseSeedOf(addNoiseSeedBase(effectSchemaOf(c.class_type)!, paramsOf(c as FxCase), nodeId), await floatHashesOf(c))
}

describe('each class against Python', () => {
  for (const c of FX.cases) {
    const cls = c.class_type
    const eps = LIBRARY_EPS[cls]

    it(`core: ${c.name}`, async () => {
      if (c.error) {
        await expect(coreRun(c)).rejects.toThrow(keyOfError(c.error))
        return
      }
      const runs = await coreRun(c)
      const items = c.outputs![0]!.items
      expect(runs).toHaveLength(items.length)
      for (const [i, item] of items.entries()) {
        const t = runs[i]!
        expect([t.w, t.h, t.c], `${c.name}, picture ${i}`).toEqual([item.w, item.h, item.c])
        if (isWarpClass(cls) && unchangedItem(item)) expectExactItem(t, item, `${c.name}, picture ${i}, unchanged`)
        else if (isWarpClass(cls)) {
          const delta = warpDelta(t, item)
          for (const mode of ['round', 'trunc'] as const) expectWarp8(tk.quantize(t, mode), item, cls, mode, `${c.name}, picture ${i}, ${mode}`, delta)
        }
        else if (eps === undefined) expectExactItem(t, item, `${c.name}, picture ${i}`)
        // Add noise's uniform draw is exact: its float matches too.
        else if (cls === 'AddNoise' && c.widgets.type === 'uniform') expectExactItem(t, item, `${c.name}, picture ${i}, uniform`)
        else for (const mode of ['round', 'trunc'] as const) expectLibrary8(tk.quantize(t, mode), item, mode, eps, `${c.name}, picture ${i}, ${mode}`)
      }
    }, c.hashed ? 120_000 : 30_000)

    it(`planEffect: ${c.name}`, async () => {
      if (c.error) {
        await expect(runEffectCase(c as FxCase, { families: NOISE })).rejects.toThrow(EFFECT_ERROR_MESSAGES[keyOfError(c.error)]!)
        return
      }
      const items = c.outputs![0]!.items
      const run = await runEffectCase(c as FxCase, { families: NOISE })
      const files = filesOfValue(run.made.values[0])
      expect(files).toHaveLength(items.length)
      // Add noise draws from its own seed here: the kept pictures are the core's under that seed (Python's parity is the core's, above).
      const own = EFFECTS[cls]!.seeded ? await coreRun(c, await ownSeedOf(c)) : null
      for (const [i, item] of items.entries()) {
        const got = await pngPixels(run.bytes(files[i]!))
        expect([got.w, got.h, got.channels]).toEqual([item.w, item.h, item.c])
        if (own) expect(sha256(got.px), `${c.name}, kept ${i} (own seed)`).toBe(sha256(tk.quantize(own[i]!, 'round')))
        else expectItem8(cls, got.px, item, 'round', `${c.name}, kept ${i}`)
      }
      // The live preview: the first picture as save_live_preview writes it.
      expect(run.previews).toHaveLength(1)
      expect(run.previews[0]!.filename).toBe(c.preview!.filename)
      const pv = await pngPixels(run.previews[0]!.bytes)
      expect([pv.w, pv.h, pv.channels]).toEqual([c.preview!.w, c.preview!.h, c.preview!.mode.length])
      if (own) expect(sha256(pv.px)).toBe(sha256(tk.quantize(own[0]!, 'trunc')))
      else expectItem8(cls, pv.px, items[0]!, 'trunc', `${c.name}, preview`)
      expect(run.made.ui).toEqual({
        images: c.ui!.images.map(im => ({ filename: im.filename, subfolder: 'sailor_runner', type: im.type })),
        animated: c.ui!.animated,
      })
      if (c.hashed) return
      // Read only by Save image: kept as save_images writes it (trunc).
      const p = pictureOf(c as FxCase)
      const saved = await runEffectCase(c as FxCase, { families: NOISE, prompt: { ...p.prompt, save: saveImage([c.node_id, 0]) } })
      const tfiles = filesOfValue(saved.made.values[0])
      for (const [i, item] of items.entries()) {
        const got = await pngPixels(saved.bytes(tfiles[i]!))
        if (own) expect(sha256(got.px)).toBe(sha256(tk.quantize(own[i]!, 'trunc')))
        else expectItem8(cls, got.px, item, 'trunc', `${c.name}, kept trunc ${i}`)
      }
    }, c.hashed ? 180_000 : 30_000)
  }

  it('over this fixture: each library class\'s worst within a quarter of its ε, Flow field within its warp bounds (never ±2)', async () => {
    const worst = new Map<string, { delta: number; share: number; max: number }>()
    for (const c of FX.cases.filter(x => !x.error && (isLibrary(x.class_type) || isWarpClass(x.class_type)))) {
      const runs = await coreRun(c)
      for (const [i, item] of c.outputs![0]!.items.entries()) {
        const t = runs[i]!
        const w = worst.get(c.class_type) ?? { delta: 0, share: 0, max: 0 }
        if (isLibrary(c.class_type)) {
          if (!item.f32s) continue
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
    console.info(`noise fixture worst (|Δ|·255, ±1 share, 8-bit): ${[...worst].map(([k, v]) => `${k} ${v.delta.toExponential(2)} ${(v.share * 100).toFixed(3)}% ${v.max}`).join(', ')}`)
    for (const [cls, w] of worst) {
      if (isLibrary(cls)) expect(4 * w.delta, cls).toBeLessThanOrEqual(LIBRARY_EPS[cls]!)
      else {
        expect(w.max, cls).toBeLessThanOrEqual(1)
        expect(w.delta, cls).toBeLessThanOrEqual(WARP_PARITY[cls]!.delta)
        expect(w.share, cls).toBeLessThanOrEqual(WARP_PARITY[cls]!.share)
      }
    }
  }, 300_000)

  it('deliberate breaks: a crude sine and cosine fail Flow field\'s warp rule and Fractal\'s band (neither can hide a logic bug)', async () => {
    const src = readFileSync(resolve(__dirname, '../../server/runner/effects/core/noise.ts'), 'utf8')
    expect(src).toContain('const sin32 = (x: number) => f(Math.sin(x))')
    expect(src).toContain('const cos32 = (x: number) => f(Math.cos(x))')
    const crude = src
      .replace('const sin32 = (x: number) => f(Math.sin(x))', 'const sin32 = (x: number) => f(Math.abs(x) < 0.3 ? Math.sin(x) : x - (x * x * x) / 6)')
      .replace('const cos32 = (x: number) => f(Math.cos(x))', 'const cos32 = (x: number) => f(Math.abs(x) < 0.3 ? Math.cos(x) : 1 - (x * x) / 2)')
    const real = await buildNoise(src)
    const broken = await buildNoise(crude)
    const flow = FX.cases.find(x => x.name === 'FlowField: rgb 320×200')!
    const item = flow.outputs![0]!.items[0]!
    const [ok] = await coreRun(flow, undefined, real)
    expect(warpVerdict('FlowField', tk.quantize(ok!, 'round'), python8(item, 'round'), warpDelta(ok!, item))).toBeNull()
    const [bad] = await coreRun(flow, undefined, broken)
    expect(warpVerdict('FlowField', tk.quantize(bad!, 'round'), python8(item, 'round'), warpDelta(bad!, item))).not.toBeNull()
    const frac = FX.cases.find(x => x.name === 'Fractal: julia, 200 × 120, zoom 3')!
    const fitem = frac.outputs![0]!.items[0]!
    const [fok] = await coreRun(frac, undefined, real)
    expectLibrary8(tk.quantize(fok!, 'round'), fitem, 'round', LIBRARY_EPS.Fractal!, 'Fractal, real')
    const [fbad] = await coreRun(frac, undefined, broken)
    expect(() => expectLibrary8(tk.quantize(fbad!, 'round'), fitem, 'round', LIBRARY_EPS.Fractal!, 'Fractal, broken')).toThrow()
  }, 120_000)
})

/** The noise core built from its (possibly edited) source, as the worker builds it. */
async function buildNoise(text: string): Promise<Record<string, Op>> {
  const pnpm = fileURLToPath(new URL('../../node_modules/.pnpm/', import.meta.url))
  const dir = readdirSync(pnpm).find(d => /^esbuild@\d/.test(d))!
  const esb = createRequire(import.meta.url)(join(pnpm, dir, 'node_modules', 'esbuild')) as typeof import('esbuild')
  const code = (await esb.transform(text, { loader: 'ts', target: 'es2019', format: 'cjs' })).code
  const mod: { exports: Record<string, unknown> } = { exports: {} }
  new Function('module', 'exports', code)(mod, mod.exports)
  return (mod.exports.noiseCore as (k: unknown, kn: unknown, rng: unknown) => Record<string, Op>)(tk, kn, effectCores.rng)
}

// ── Random numbers: chunks, batches, Add noise's seed and look ───────────────

describe('random numbers', () => {
  it('drawn in chunks (48 values between Stop checks, in place of 2²⁰) they are the same floats: randn blocks, its tail, rand', async () => {
    const src = readFileSync(resolve(__dirname, '../../server/runner/effects/core/noise.ts'), 'utf8')
    expect(src).toContain('const DRAW_CHUNK = 1 << 20')
    const small = await buildNoise(src.replace('const DRAW_CHUNK = 1 << 20', 'const DRAW_CHUNK = 48'))
    const names = [
      'AddNoise: seed 7, gaussian, a batch of two and a repeat', 'AddNoise: seed 8, uniform, a batch of two and a repeat',
      'AddNoise: seed 7, gaussian, mono True, provider 29×31', 'FilmGrain: rgb 320×200', 'PerlinNoise: defaults, 64²',
      'FlowField: a batch of two', 'Stipple: batch of two, invert True',
    ]
    for (const name of names) {
      const c = FX.cases.find(x => x.name === name)!
      expect(c, name).toBeTruthy()
      const a = await coreRun(c)
      const b = await coreRun(c, undefined, small)
      a.forEach((t, i) => expect(sha256(new Uint8Array(b[i]!.data.buffer)), `${name} ${i}`).toBe(sha256(new Uint8Array(t.data.buffer))))
    }
    // The totals these cases draw: not multiples of 16 (normal_fill's tail) and more than one chunk.
    expect((37 * 23 * 3 * 3) % 16).not.toBe(0)
  }, 120_000)

  it('the batch-coupled draws: a batch of two gives Python\'s two results, each file after the first alone gives a different one', async () => {
    for (const name of ['Stipple: batch of two, invert False', 'Stipple: batch of two, invert True', 'PaletteQuantize: batch of two 37×23, colours 32, iterations 20',
      'PaletteQuantize: batch of two 120×100', 'AddNoise: seed 7, gaussian, a batch of two and a repeat', 'AddNoise: seed 8, uniform, a batch of two and a repeat']) {
      const c = FX.cases.find(x => x.name === name)!
      expect(c, name).toBeTruthy()
      const runs = await coreRun(c)
      const items = c.outputs![0]!.items
      items.forEach((item, i) => expectItem8(c.class_type, tk.quantize(runs[i]!, 'round'), item, 'round', `${name}: picture ${i} in the batch`))
      for (const [i, f] of c.inputs.image!.files.entries()) {
        if (i === 0) continue
        const [one] = await coreRun(variant(c, { inputs: { image: { source: c.inputs.image!.source, files: [f] } } }))
        expect(sha256(tk.quantize(one!, 'round')), `${name}: file ${i} alone`).not.toBe(items[i]!.round8_sha256)
      }
    }
    // Add noise's repeat is a new draw, not the first picture again.
    const rep = FX.cases.find(x => x.name === 'AddNoise: seed 7, gaussian, a batch of two and a repeat')!
    expect(rep.outputs![0]!.items[2]!.round8_sha256).not.toBe(rep.outputs![0]!.items[0]!.round8_sha256)
  }, 120_000)

  it('Add noise\'s seed: the same settings, floats and node give the same noise; a changed widget, picture or node gives different noise', async () => {
    const schema = effectSchemaOf('AddNoise')!
    const w = { amount: 0.3, type: 'gaussian', monochromatic: false }
    const base = addNoiseSeedBase(schema, w, 'fx1')
    const a = addNoiseSeedOf(base, ['aa', 'bb'])
    expect(typeof a).toBe('bigint')
    expect(a).toBe(addNoiseSeedOf(addNoiseSeedBase(schema, { ...w }, 'fx1'), ['aa', 'bb']))
    expect(a >= BigInt(0) && a < (BigInt(1) << BigInt(64))).toBe(true)
    for (const other of [
      addNoiseSeedOf(addNoiseSeedBase(schema, { ...w, amount: 0.31 }, 'fx1'), ['aa', 'bb']), addNoiseSeedOf(addNoiseSeedBase(schema, { ...w, type: 'uniform' }, 'fx1'), ['aa', 'bb']),
      addNoiseSeedOf(addNoiseSeedBase(schema, { ...w, monochromatic: true }, 'fx1'), ['aa', 'bb']), addNoiseSeedOf(addNoiseSeedBase(schema, w, 'fx2'), ['aa', 'bb']),
      addNoiseSeedOf(base, ['aa', 'bc']), addNoiseSeedOf(base, ['bb', 'aa']), addNoiseSeedOf(base, ['aa']),
    ]) expect(other).not.toBe(a)
    // Through planEffect (the worker hashing the floats the op receives): two runs of one node keep the same pixels;
    // another amount, another picture, or another node (two identical Add noise nodes) change them.
    const c = FX.cases.find(x => x.name === 'AddNoise: seed 7, gaussian, mono False, rgb 37×23')!
    const kept = async (cc: NoiseCase) => {
      const r = await runEffectCase(cc as FxCase, { families: NOISE })
      return sha256((await pngPixels(r.bytes(filesOfValue(r.made.values[0])[0]!))).px)
    }
    const first = await kept(c)
    expect(await kept(c)).toBe(first)
    expect(first).toBe(sha256(tk.quantize((await coreRun(c, await ownSeedOf(c)))[0]!, 'round')))
    expect(await kept(variant(c, { widgets: { ...c.widgets, amount: 0.31 } }))).not.toBe(first)
    expect(await kept(variant(c, { inputs: { image: { source: 'rgb', files: [FX.cases.find(x => x.name === 'Glitch: slices 2 on 40×9')!.inputs.image!.files[0]!] } } }))).not.toBe(first)
    const twin = variant(c, { node_id: `${c.node_id}_twin` })
    const second = await kept(twin)
    expect(second, 'two identical Add noise nodes on one picture').not.toBe(first)
    expect(second).toBe(sha256(tk.quantize((await coreRun(twin, await ownSeedOf(twin)))[0]!, 'round')))
    // A batch of more than one: every picture hashed in a first pass, then drawn (the kept pictures are the core's under that seed).
    const batch = FX.cases.find(x => x.name === 'AddNoise: seed 7, gaussian, a batch of two and a repeat')!
    const r = await runEffectCase(batch as FxCase, { families: NOISE })
    const own = await coreRun(batch, await ownSeedOf(batch))
    const files = filesOfValue(r.made.values[0])
    for (const [i, f] of files.entries()) expect(sha256((await pngPixels(r.bytes(f))).px), `batch picture ${i}`).toBe(sha256(tk.quantize(own[i]!, 'round')))
  }, 60_000)

  it('Add noise\'s seed is the floats, not the file: a picture handed on as a kept float tensor seeds the noise as its floats do', async () => {
    const c = FX.cases.find(x => x.name === 'AddNoise: seed 7, gaussian, mono False, rgb 37×23')!
    const [row] = await tensorsOf(c as FxCase)
    const h = createHash('sha256')
    h.update(`image:${row!.image!.c}x${row!.image!.h}x${row!.image!.w};`)
    h.update(new Uint8Array(row!.image!.data.buffer, row!.image!.data.byteOffset, row!.image!.data.byteLength))
    expect(await floatHashesOf(c)).toEqual([h.digest('hex')])
    // The same floats from a tensor file (tensorFileOf, read back as the worker reads it) hash the same.
    const back = tk.fromTensorFile(tk.tensorFileOf(row!.image!))
    const h2 = createHash('sha256')
    h2.update(`image:${back.c}x${back.h}x${back.w};`)
    h2.update(new Uint8Array(back.data.buffer, back.data.byteOffset, back.data.byteLength))
    expect(h2.digest('hex')).toBe((await floatHashesOf(c))[0])
  })

  it('Add noise\'s look under the runner\'s own seed: per-channel means within 2/255 and the noise\'s spread within 5% of Python\'s', () => {
    const s = 256
    const data = new Uint8Array(s * s * 4).fill(255)
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) for (let k = 0; k < 3; k++) data[(y * s + x) * 4 + k] = 96 + Math.floor((64 * (x + y)) / 510)
    const img = tk.fromPicture({ source: 'rgb', w: s, h: s, data })
    const op = coreOp(EFFECTS.AddNoise!.op) as unknown as Op
    expect(FX.stats).toHaveLength(4)
    for (const st of FX.stats) {
      for (const seed of [BigInt('9876543210123456789'), BigInt(12345)]) {
        const out = op({ image: img }, { amount: st.amount, type: st.type, monochromatic: st.monochromatic, seed }, undefined, {}, 0, 1).outputs[0]!
        const n = s * s
        let sq = 0
        let sum = 0
        for (let k = 0; k < 3; k++) {
          let m = 0
          for (let i = 0; i < n; i++) {
            m += out.data[k * n + i]!
            const d = out.data[k * n + i]! - img.data[k * n + i]!
            sum += d
            sq += d * d
          }
          expect(Math.abs(m / n - st.means[k]!), `${st.type} mono ${st.monochromatic} channel ${k}`).toBeLessThanOrEqual(2 / 255)
        }
        const mean = sum / (3 * n)
        const std = Math.sqrt(sq / (3 * n) - mean * mean)
        expect(Math.abs(std - st.std) / st.std, `${st.type} mono ${st.monochromatic} spread`).toBeLessThanOrEqual(0.05)
      }
    }
  })
})

// ── Families and eligibility (rule 12) ───────────────────────────────────────

const card = (image: string) => ({ class_type: 'Image', inputs: { image, export: false, filename_prefix: 'ComfyUI', batch_index: -1 } })
const outCard = (from: string) => ({ class_type: 'Image', inputs: { image: '', export: false, images: [from, 0], batch_index: -1 } })
/** The class's node: fed `from` (a picture class), or on its own (a generator). */
const effect = (cls: string, from: [string, number] | null, widgets: Record<string, unknown>) => ({ class_type: cls, inputs: from && !EFFECT_GENERATOR_CLASSES.includes(cls) ? { image: from, ...widgets } : { ...widgets } })
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
/** A small graph with the class: a generator alone, a picture class fed an Image card. */
const withClass = (cls: string, widgets = defaultsOf(cls)): ApiPrompt =>
  (EFFECT_GENERATOR_CLASSES.includes(cls) ? { fx: effect(cls, null, widgets) } : { 0: card('a.png'), fx: effect(cls, ['0', 0], widgets) })

describe('families', () => {
  it('with the family off, a workflow with the class is left to the engine and nodesNeedingEngine names it', () => {
    for (const cls of NOISE_CLASSES) {
      const p = withClass(cls)
      expect(runnerTakesWorkflow(p, NOISE), cls).toBe(true)
      expect(nodesNeedingEngine(p, { runnerOn: true, families: NOISE, titleOf: id => id }), cls).toEqual([])
      for (const fam of [new Set<RunnerFamily>(['cards']), new Set<RunnerFamily>(['cards', 'effects-blur', 'effects-tone', 'effects-cells', 'effects-warp', 'effects-mask']), new Set<RunnerFamily>(['effects-noise'])]) {
        expect(runnerTakesWorkflow(p, fam), `${cls} ${[...fam]}`).toBe(false)
        expect(nodesNeedingEngine(p, { runnerOn: true, families: fam, titleOf: id => id }), `${cls} ${[...fam]}`).toEqual(['fx'])
      }
    }
  })

  it('node by node: each class, its source card and its reader, with cards and the family on and off', () => {
    for (const cls of NOISE_CLASSES) {
      const q: ApiPrompt = { ...withClass(cls), e: editNode(['fx', 0]), o: outCard('e') }
      const take = (fam: RunnerFamily[]) => Object.fromEntries(Object.keys(q).map(id => [id, runnerTakesNode(q, id, new Set(fam))]))
      const on = take(['cards', 'effects-noise', 'fal-edit'])
      expect(Object.values(on).every(Boolean), cls).toBe(true)
      expect(isRunnerEligible(q, NOISE_EDIT), cls).toBe(true)
      for (const fam of [['effects-noise', 'fal-edit'], ['cards', 'fal-edit'], ['cards', 'effects-tone', 'fal-edit']] as RunnerFamily[][]) {
        expect(take(fam).fx, `${cls} ${fam}`).toBe(false)
        expect(isRunnerEligible(q, new Set(fam)), `${cls} ${fam}`).toBe(false)
      }
    }
  })

  it('widgets ComfyUI would refuse, and colour text Python reads otherwise, leave it to the engine', () => {
    const take = (cls: string, over: Record<string, unknown>) => runnerTakesNode(withClass(cls, { ...defaultsOf(cls), ...over }), 'fx', NOISE)
    expect(take('PerlinNoise', { octaves: 8 })).toBe(true)
    expect(take('PerlinNoise', { octaves: 9 })).toBe(false)
    expect(take('Voronoi', { width: 2049 })).toBe(false)
    expect(take('Fractal', { type: 'burning ship' })).toBe(false)
    expect(take('ReactionDiffusion', { iterations: 3001 })).toBe(false)
    expect(take('FilmGrain', { size: 0.4 })).toBe(false)
    expect(take('Glitch', { slices: 61 })).toBe(false)
    expect(take('AddNoise', { type: 'salt' })).toBe(false)
    expect(take('Stipple', { dot_color: '#f00' })).toBe(true)
    expect(take('Stipple', { dot_color: '#١٢٣٤٥٦' })).toBe(false)
    expect(take('Stipple', { bg_color: 42 })).toBe(false)
  })
})

// ── With every effects family off, nothing changes (rule 12) ─────────────────

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

/** A generator added beside the graph, read by a Save image. */
function withGenerator(p: ApiPrompt, cls: string): ApiPrompt {
  return { ...JSON.parse(JSON.stringify(p)), gen_x: effect(cls, null, defaultsOf(cls)), gen_save: saveImage(['gen_x', 0]) }
}

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
    for (const cls of NOISE_CLASSES) {
      const base = withClass(cls)
      sameAsBefore(base, `${cls} alone`)
      sameAsBefore({ ...base, e: editNode(['fx', 0]), o: outCard('e') }, `${cls} → edit`)
      sameAsBefore({ ...base, s: saveImage(['fx', 0]) }, `${cls} → save`)
      sameAsBefore({ ...base, f: { class_type: 'Compositor', inputs: frameWidgets({ layer1: ['fx', 0] }) } }, `${cls} → Frame`)
      if (!EFFECT_GENERATOR_CLASSES.includes(cls)) sameAsBefore({ g: { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'x', aspect_ratio: '1:1', seed: 0, model_options: '{}' } }, fx: effect(cls, ['g', 0], defaultsOf(cls)) }, `generate → ${cls}`)
    }
  })

  const PROJECTS = resolve(__dirname, '../../../user/sailor/projects')
  const projectsIt = existsSync(PROJECTS) ? it : it.skip

  projectsIt('over every saved project graph, each with one of the 11 classes (in turn) spliced in after every picture, or beside it', async () => {
    const { gunzipSync } = await import('node:zlib')
    const { graphToPrompt } = await import('~/lib/graph/graphToPrompt')
    const catalog = JSON.parse(gunzipSync(readFileSync(resolve(__dirname, '../../server/assets/nodeCatalog.json.gz'))).toString('utf8'))
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
        const cls = NOISE_CLASSES[graphs % NOISE_CLASSES.length]!
        graphs++
        let q: ApiPrompt
        if (EFFECT_GENERATOR_CLASSES.includes(cls)) q = withGenerator(p, cls)
        else {
          const s = spliceAfterPictures(p, cls)
          if (!s.count) continue
          q = s.prompt
        }
        sameAsBefore(q, `${uuid} with ${cls}`)
        const on = new Set<RunnerFamily>(RUNNER_FAMILIES)
        if (JSON.stringify(nodesNeedingEngine(q, { runnerOn: true, families: on, titleOf: id => id })) !== JSON.stringify(nodesNeedingEngine(withoutEffects(q), { runnerOn: true, families: on, titleOf: id => id }))) changedWhenOn++
        spliced++
        used.add(cls)
      }
    }
    expect(graphs).toBeGreaterThanOrEqual(800)
    expect(spliced).toBeGreaterThanOrEqual(400)
    expect([...used].sort()).toEqual([...NOISE_CLASSES].sort())
    expect(changedWhenOn).toBeGreaterThan(0)
    console.info(`noise families-off invariant: ${graphs} saved graphs, ${spliced} with a noise class spliced in, ${changedWhenOn} read differently with the effects on`)
  }, 300_000)
})

// ── The engine ───────────────────────────────────────────────────────────────

describe('the engine (cards and effects-noise on)', () => {
  const c = FX.cases.find(x => x.name === 'Glitch: defaults, card 23×19 see-through')!
  const fileName = c.inputs.image!.files[0]!
  const fileBytes = b64(FX.assets[fileName]!)
  const item = c.outputs![0]!.items[0]!

  it('an effect feeding Edit an image hands off its kept round-8 PNG', async () => {
    const k = makeKit({ hosted: false, deps: { families: () => NOISE_EDIT } })
    put(k.root, fileName, fileBytes)
    const p: ApiPrompt = { 0: card(fileName), [c.node_id]: effect(c.class_type, ['0', 0], c.widgets), e: editNode([c.node_id, 0]), o: outCard('e') }
    expect(isRunnerEligible(p, NOISE_EDIT)).toBe(true)
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

  it('an effect → Save image saves the trunc picture; a generator → Save image too', async () => {
    const k = makeKit({ hosted: false, deps: { families: () => NOISE } })
    put(k.root, fileName, fileBytes)
    const p: ApiPrompt = { 0: card(fileName), [c.node_id]: effect(c.class_type, ['0', 0], c.widgets), s: saveImage([c.node_id, 0]) }
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.status).toBe('done')
    const saved = await pngPixels(new Uint8Array(readFileSync(join(k.root, 'output', 'ComfyUI_00001_.png'))))
    expect(saved.channels).toBe(4)
    expect(sha256(saved.px)).toBe(item.trunc8_sha256)
    const g = FX.cases.find(x => x.name === 'ReactionDiffusion: 64², 50 iterations, feed 0.04, kill 0.06')!
    const q: ApiPrompt = { [g.node_id]: effect(g.class_type, null, g.widgets), s: saveImage([g.node_id, 0]) }
    expect(isRunnerEligible(q, NOISE)).toBe(true)
    const r2 = await k.engine.startRun({ userId: k.userId, takes: [q], ...START })
    await k.engine.settled(r2.runId)
    expect((await k.store.get(r2.runId))!.status).toBe('done')
    const gs = await pngPixels(new Uint8Array(readFileSync(join(k.root, 'output', 'ComfyUI_00002_.png'))))
    expect(sha256(gs.px)).toBe(g.outputs![0]!.items[0]!.trunc8_sha256)
  }, 60_000)

  it('Glitch → Frame: the Frame reads the float tensor and renders Python\'s picture exactly', async () => {
    const ch = FX.frame
    const file = ch.inputs.image!.files[0]!
    const kept = createMemoryKeptBytes()
    const k = makeKit({ hosted: false, deps: { families: () => NOISE_FRAME, kept } })
    put(k.root, file, b64(FX.assets[file]!))
    const fx = ch.effect
    const p: ApiPrompt = { 0: card(file), [fx.node_id]: effect(fx.class_type, ['0', 0], fx.widgets), f: { class_type: 'Compositor', inputs: frameWidgets({ ...ch.frame.widgets, layer1: [fx.node_id, 0] }) } }
    expect(isRunnerEligible(p, NOISE_FRAME)).toBe(true)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    const v = run.takes[0]!.nodes[fx.node_id]!.values![0] as Extract<RunnerValue, { kind: 'files' }>
    expect(v.tensors).toHaveLength(1)
    const frameFile = run.takes[0]!.nodes.f!.outputs[0]!
    const frame = await pngPixels(new Uint8Array(readFileSync(join(k.root, frameFile.type, frameFile.subfolder, frameFile.filename))))
    expect([frame.w, frame.h]).toEqual([ch.frame.w, ch.frame.h])
    expect(Buffer.compare(frame.px, b64(ch.frame.image8))).toBe(0)
  })
})

// ── Work and sizes (rule 7) ──────────────────────────────────────────────────

async function runBig(cls: string, widgets: Record<string, unknown>, png: Uint8Array | null, o: { count?: number; hosted?: boolean } = {}) {
  const gen = EFFECT_GENERATOR_CLASSES.includes(cls)
  const c = { name: cls, class_type: cls, node_id: 'fx', widgets, inputs: gen ? {} : { image: { source: 'rgb' as const, files: Array.from({ length: o.count ?? 1 }, () => 'big.png') } } }
  const pic = pictureOf(c as FxCase)
  const mem = memoryIO(png ? { 'big.png': png } : {}, 'fx', { hosted: o.hosted })
  const plan: NodePlan = await planNode({ prompt: pic.prompt, nodeId: 'fx', families: NOISE, gateOpen: false, hosted: o.hosted, filesFrom: pic.filesOf, toUrl: async () => '' })
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

/** What planEffect's caps and budget make of a picture class on a side × side picture, the decoder refusing to run ('accepted': it got to the decode). */
async function gate(cls: string, widgets: Record<string, unknown>, side: number, o: { count?: number; hosted?: boolean } = {}): Promise<string> {
  const { mem, derive } = await runBig(cls, widgets, await solidPng(side), o)
  const before = decodeWatch.calls
  decodeWatch.refuse = true
  try {
    await derive()
    throw new Error('the decoder was not reached')
  }
  catch (e) {
    if (decodeWatch.calls - before > 0) return 'accepted'
    expect(mem.kept()).toBe(0)
    expect(mem.previews).toHaveLength(0)
    return (e as Error).message
  }
  finally { decodeWatch.refuse = false }
}

/** A generator's whole count as planEffect makes it: its own work and its output's I/O. */
const generatorTotal = (cls: string, w: Record<string, unknown>) => {
  const size = { w: w.width as number, h: w.height as number }
  return EFFECTS[cls]!.work!(w, null) + EFFECT_IO_WORK_PER_VALUE * 4 * size.w * size.h
}

describe('work and sizes', () => {
  it('every picture class\'s defaults are accepted at 4096², and at 8192² accepted or refused before decoding', async () => {
    const report: string[] = []
    for (const cls of PICTURE_CLASSES) {
      expect(await gate(cls, defaultsOf(cls), 4096), `${cls} defaults at 4096²`).toBe('accepted')
      const d8 = await gate(cls, defaultsOf(cls), 8192)
      expect(['accepted', EFFECT_TOO_MUCH_WORK], `${cls} defaults at 8192²`).toContain(d8)
      report.push(`${cls} ${d8 === 'accepted' ? 'ok' : 'over'}`)
    }
    // Palette quantize reads each file twice (its gather pass): its bytes are kept until the second read.
    expect(await gate('PaletteQuantize', { colors: 32, iterations: 20, seed: 1 }, 2048, { count: 2 })).toBe('accepted')
    console.info(`noise budget through plan.ts (defaults at 8192²): ${report.join(', ')}`)
  }, 300_000)

  it('the generators: their size and work known from their widgets; defaults accepted; over the budget left to the engine, as planEffect would refuse it', async () => {
    expect([...EFFECT_GENERATOR_CLASSES].sort()).toEqual(['Fractal', 'GradientGenerator', 'PerlinNoise', 'ReactionDiffusion', 'Voronoi'])
    const settings: [string, Record<string, unknown>][] = []
    for (const cls of EFFECT_GENERATOR_CLASSES) {
      const d = defaultsOf(cls)
      settings.push([cls, d], [cls, { ...d, width: 2048, height: 2048 }])
    }
    settings.push(
      ['ReactionDiffusion', { ...defaultsOf('ReactionDiffusion'), width: 1024, height: 1024, iterations: 3000 }],
      ['ReactionDiffusion', { ...defaultsOf('ReactionDiffusion'), width: 1024, height: 1024, iterations: 600 }],
      ['ReactionDiffusion', { ...defaultsOf('ReactionDiffusion'), width: 512, height: 512, iterations: 3000 }],
      ['Fractal', { ...defaultsOf('Fractal'), width: 2048, height: 2048, max_iter: 512 }],
      ['Voronoi', { ...defaultsOf('Voronoi'), width: 2048, height: 2048, points: 400 }],
      ['PerlinNoise', { ...defaultsOf('PerlinNoise'), width: 2048, height: 2048, octaves: 8, scale: 4 }],
      ['PerlinNoise', { ...defaultsOf('PerlinNoise'), width: 512, height: 512, octaves: 8, scale: 4 }],
    )
    const lines: string[] = []
    for (const [cls, w] of settings) {
      const total = generatorTotal(cls, w)
      const fits = total <= EFFECT_MAX_WORK && effectPeakFits(cls, w, null, false)
      expect(generatorWork(cls, w), cls).toBe(EFFECTS[cls]!.work!(w, null))
      expect(effectOutputSizeFits(cls, w, false), `${cls} ${JSON.stringify(w)}`).toBe(fits)
      expect(runnerTakesNode({ fx: effect(cls, null, w) }, 'fx', NOISE), `${cls} ${JSON.stringify(w)}`).toBe(fits)
      lines.push(`${cls} ${w.width}×${w.height} ${fits ? 'ok' : 'engine'} (${(total / 1e9).toFixed(1)}e9)`)
    }
    for (const cls of EFFECT_GENERATOR_CLASSES) expect(effectOutputSizeFits(cls, defaultsOf(cls), true), `${cls} hosted`).toBe(true)
    // The widget check agrees with planEffect's own refusal (before any work).
    const heavy = { ...defaultsOf('ReactionDiffusion'), width: 1024, height: 1024, iterations: 3000 }
    const { derive, mem } = await runBig('ReactionDiffusion', heavy, null)
    await expect(derive()).rejects.toThrow(EFFECT_TOO_MUCH_WORK)
    expect(mem.previews).toHaveLength(0)
    // Wired (unknown) widgets are checked at the node's turn.
    expect(effectOutputSizeFits('ReactionDiffusion', { ...heavy, iterations: ['n', 0] }, false)).toBe(true)
    expect(effectOutputSizeFits('ReactionDiffusion', { ...heavy, iterations: '3000' }, false)).toBe(false)
    console.info(`noise generators: ${lines.join('; ')}`)
  }, 120_000)

  it('memory: every class\'s largest array within 8192² × 4 values locally (4096² × 4 hosted), else left to the engine (Perlin\'s octave grid below scale 1)', async () => {
    expect(EFFECT_MAX_VALUES).toBe(268435456)
    expect(EFFECT_HOSTED_MAX_VALUES).toBe(67108864)
    const perlin = (side: number, octaves: number) => ({ ...defaultsOf('PerlinNoise'), width: side, height: side, octaves, scale: 4 })
    // The largest octave's grid: max(2, int(side / (4 / 2^(octaves − 1))) + 1)² values.
    const grid = (side: number, octaves: number) => (side * 2 ** (octaves - 1) / 4 + 1) ** 2
    const rows: [number, number, boolean, boolean][] = [
      // side, octaves, taken locally, taken hosted
      [1024, 8, false, false], // 32,769² = 1.07 × 10⁹ values (4 GiB)
      [2048, 7, false, false], // 32,769² again
      [2048, 6, false, false], // 16,385² = 268,468,225: just over 8192² × 4
      [512, 8, false, false], // 16,385² again
      [512, 7, true, false], // 8,193² = 67,125,249: just over the hosted cap
      [256, 7, true, true], // 4,097² = 16.8 M
    ]
    for (const [side, octaves, local, hosted] of rows) {
      const w = perlin(side, octaves)
      expect(effectPeakValues('PerlinNoise', w, null), `${side}² ${octaves} octaves`).toBe(Math.max(grid(side, octaves), 3 * side * side))
      expect(effectOutputSizeFits('PerlinNoise', w, false), `${side}² ${octaves} octaves, local`).toBe(local)
      expect(effectOutputSizeFits('PerlinNoise', w, true), `${side}² ${octaves} octaves, hosted`).toBe(hosted)
      expect(runnerTakesNode({ fx: effect('PerlinNoise', null, w) }, 'fx', NOISE), `${side}² ${octaves} octaves`).toBe(local)
    }
    // At its turn (eligibility skipped), planEffect refuses it before drawing anything.
    const { derive, mem } = await runBig('PerlinNoise', perlin(1024, 8), null)
    await expect(derive()).rejects.toThrow(EFFECT_TOO_MUCH_MEMORY)
    expect(mem.previews).toHaveLength(0)
    expect(EFFECT_TOO_MUCH_MEMORY).toBe('This effect would need too much memory at this setting. Use a smaller picture or a lighter setting.')
    // Every generator's other arrays are its 3-channel output (≤ 2048² × 3); every picture class's its picture or Film grain's field.
    for (const cls of EFFECT_GENERATOR_CLASSES.filter(x => x !== 'PerlinNoise')) {
      const w = { ...defaultsOf(cls), width: 2048, height: 2048 }
      expect(effectPeakValues(cls, w, null), cls).toBe(3 * 2048 * 2048)
    }
    for (const cls of PICTURE_CLASSES) expect(effectPeakValues(cls, defaultsOf(cls), { w: 8192, h: 8192 }), cls).toBe(EFFECT_MAX_VALUES)
    expect(effectPeakValues('FilmGrain', { amount: 0.5, size: 0.5 }, { w: 1, h: 8192 })).toBe(4 * 2 * 8192)
    // The earlier families have no count here: their largest array is their picture (the R2.9 report lists padded copies).
    expect(effectPeakValues('Blur', { type: 'gaussian', radius: 30 }, { w: 8192, h: 8192 })).toBeNull()
  }, 60_000)

  it('Film grain checks its field against the picture before drawing it, and counts the field in its work', () => {
    const op = coreOp(EFFECTS.FilmGrain!.op) as unknown as Op
    const x = tk.tensor(3, 2048, 2048)
    let checks = 0
    const t0 = performance.now()
    expect(() => op({ image: x }, { amount: 0.5, size: 0.5, seed: 1 }, () => { checks++; return false }, {}, 0, 1)).toThrow('EFFECT_GRAIN_TOO_FINE')
    expect(checks, 'no draw (each chunk checks Stop first)').toBe(0)
    expect(performance.now() - t0).toBeLessThan(500)
    const s = { w: 4096, h: 4096 }
    const fine = EFFECTS.FilmGrain!.work!({ amount: 0.5, size: 0.5, seed: 1 }, s)
    const coarse = EFFECTS.FilmGrain!.work!({ amount: 0.5, size: 4, seed: 1 }, s)
    const one = EFFECTS.FilmGrain!.work!({ amount: 0.5, size: 1, seed: 1 }, s)
    // The field: 8192² values at size 0.5, 4096² at size 1, 1024² at size 4.
    expect(fine - one).toBe((8192 * 8192 - 4096 * 4096) * 12)
    expect(one).toBeGreaterThan(coarse - 4096 * 4096 * 6)
  })

  it('Film grain below size 1: the output grows on a side of 1 (torch\'s broadcast), and the plan sizes it before running', () => {
    const w = { amount: 0.5, size: 0.5, seed: 1 }
    expect(EFFECTS.FilmGrain!.outSize!(w, { w: 1, h: 1 })).toEqual({ w: 2, h: 2 })
    expect(EFFECTS.FilmGrain!.outSize!(w, { w: 37, h: 1 })).toEqual({ w: 37, h: 2 })
    expect(EFFECTS.FilmGrain!.outSize!({ ...w, size: 2 }, { w: 1, h: 1 })).toEqual({ w: 1, h: 1 })
    const c = FX.cases.find(x => x.name === 'FilmGrain: size 0.99, the 1×1 blank')!
    expect([c.outputs![0]!.items[0]!.w, c.outputs![0]!.items[0]!.h]).toEqual([2, 2])
  })

  it('time check: the heaviest generators at their budget\'s edge, on the worker', async () => {
    const lines: string[] = []
    const edgeIts = Math.floor((EFFECT_MAX_WORK - EFFECT_IO_WORK_PER_VALUE * 4 * 512 * 512) / (EFFECTS.ReactionDiffusion!.work!({ width: 512, height: 512, iterations: 1 }, null)))
    for (const [cls, widgets] of [
      ['ReactionDiffusion', { ...defaultsOf('ReactionDiffusion'), width: 512, height: 512, iterations: Math.min(3000, edgeIts) }],
      ['Voronoi', { ...defaultsOf('Voronoi'), width: 2048, height: 2048, points: 400 }],
      ['Fractal', { ...defaultsOf('Fractal'), width: 2048, height: 2048, max_iter: 512, center_x: -0.1, center_y: 0, zoom: 10 }],
    ] as const) {
      const work = generatorTotal(cls, widgets)
      expect(work, cls).toBeLessThanOrEqual(EFFECT_MAX_WORK)
      const { derive } = await runBig(cls, widgets, null)
      const t0 = performance.now()
      const made = await derive()
      const s = (performance.now() - t0) / 1000
      expect(filesOfValue(made.values[0])).toHaveLength(1)
      lines.push(`${cls} ${s.toFixed(1)} s (work ${(work / 1e9).toFixed(2)} × 10⁹, the budget's rate ${(work / 0.37e9).toFixed(1)} s)`)
      expect(s).toBeLessThan(60)
    }
    console.info(`noise time check on the worker: ${lines.join('; ')}`)
  }, 300_000)
})

// ── The broad sweep (`--group noise --sweep` only) ──────────────────────────

/** scripts/runner_effects_fixtures.py `big_pixels` as RGBA for the pixels core. */
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
    delta = Math.max(delta, Math.abs(clamp(got[j]!) - clamp(py[j]!)) * 255)
    const dr = Math.abs(r8(got[j]!) - r8(py[j]!))
    const dt = Math.abs(t8(got[j]!) - t8(py[j]!))
    if (dr) offR++
    if (dt) offT++
    max = Math.max(max, dr, dt)
  }
  return { delta, max, share: Math.max(offR, offT) / py.length }
}

interface SweepRow { class_type: string; widgets: Record<string, unknown>; w: number; h: number; c: number; seed: number; global_seed?: number; f32s?: string; file?: string; error?: string }

function sweepRun(sc: SweepRow, rgba: Uint8Array | null): Float32Array {
  const op = coreOp(EFFECTS[sc.class_type]!.op) as unknown as Op
  const spec = EFFECTS[sc.class_type]!
  const p: Record<string, unknown> = { ...paramsOf({ class_type: sc.class_type, widgets: sc.widgets } as FxCase) }
  if (spec.seeded) p.seed = sc.global_seed
  const pp = spec.prepare ? spec.prepare(p) : p
  const rows = rgba ? [{ image: tk.fromPicture({ source: sc.c === 4 ? 'provider' : 'rgb', w: sc.w, h: sc.h, data: rgba }) }] : [{}]
  return interleaved(runBatch(op, rows, pp, !!spec.gather)[0]!)
}

function keepWorst(worst: Map<string, { delta: number; max: number; share: number; where: string }>, cls: string, m: { delta: number; max: number; share: number }, where: string): void {
  const w = worst.get(cls) ?? { delta: 0, max: 0, share: 0, where }
  if (m.delta > w.delta) w.where = where
  w.delta = Math.max(w.delta, m.delta)
  w.max = Math.max(w.max, m.max)
  w.share = Math.max(w.share, m.share)
  worst.set(cls, w)
}

function reportAndCheck(title: string, worst: Map<string, { delta: number; max: number; share: number; where: string }>): void {
  for (const [cls, v] of worst) console.info(`${title} ${cls}: worst |Δ|·255 ${v.delta.toExponential(2)}, ±1 share ${(v.share * 100).toFixed(4)}%, largest 8-bit ${v.max} (at ${v.where})`)
  for (const [cls, v] of worst) {
    if (isLibrary(cls)) expect(4 * v.delta, cls).toBeLessThanOrEqual(LIBRARY_EPS[cls]!)
    else {
      expect(v.max, cls).toBeLessThanOrEqual(1)
      expect(v.delta, cls).toBeLessThanOrEqual(WARP_PARITY[cls]!.delta)
      expect(v.share, cls).toBeLessThanOrEqual(WARP_PARITY[cls]!.share)
    }
  }
}

const SWEEP = process.env.NOISE_SWEEP_FILE
describe.runIf(!!SWEEP)('the noise ε sweep', () => {
  it('the noise ε sweep: each class\'s worst over fresh pictures and settings', () => {
    const doc = JSON.parse(readFileSync(SWEEP!, 'utf8')) as { cases: SweepRow[] }
    const worst = new Map<string, { delta: number; max: number; share: number; where: string }>()
    for (const sc of doc.cases) {
      let rgba: Uint8Array | null = null
      if (sc.class_type !== 'Fractal') {
        const px = synth(sc.w, sc.h, sc.c, sc.seed)
        rgba = new Uint8Array(sc.w * sc.h * 4).fill(255)
        for (let i = 0; i < sc.w * sc.h; i++) for (let k = 0; k < sc.c; k++) rgba[i * 4 + k] = px[i * sc.c + k]!
      }
      if (sc.error) {
        expect(() => sweepRun(sc, rgba), `${sc.class_type} ${JSON.stringify(sc.widgets)}`).toThrow()
        continue
      }
      const got = sweepRun(sc, rgba)
      const py = unshuffle(sc.f32s!)
      expect(got.length).toBe(py.length)
      const m = sweepMeasure(got, py)
      if (!isLibrary(sc.class_type) && !isWarpClass(sc.class_type)) expect(m.delta, sc.class_type).toBe(0)
      keepWorst(worst, sc.class_type, m, `${sc.w}×${sc.h}×${sc.c} seed ${sc.seed} ${JSON.stringify(sc.widgets)}`)
    }
    console.info(`noise ε sweep: ${doc.cases.length} cases`)
    reportAndCheck('noise ε small', worst)
  }, 1_800_000)
})

const LARGE = process.env.NOISE_SWEEP_LARGE_FILE
describe.runIf(!!LARGE)('the noise large sweep', () => {
  it('the noise large sweep: Flow field up to 8192² (every widget at its max, then drawn)', () => {
    const doc = JSON.parse(readFileSync(LARGE!, 'utf8')) as { cases: SweepRow[] }
    const worst = new Map<string, { delta: number; max: number; share: number; where: string }>()
    for (const sc of doc.cases) {
      const got = sweepRun(sc, bigPixels(sc.w, sc.h, sc.c, sc.seed))
      const raw = readFileSync(sc.file!)
      const py = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
      expect(got.length).toBe(py.length)
      const m = sweepMeasure(got, py)
      console.info(`noise large ${sc.class_type} ${sc.w}² seed ${sc.seed} ${JSON.stringify(sc.widgets)}: |Δ|·255 ${m.delta.toExponential(2)}, ±1 share ${(m.share * 100).toFixed(4)}%, largest 8-bit ${m.max}`)
      keepWorst(worst, sc.class_type, m, `${sc.w}² seed ${sc.seed}`)
    }
    reportAndCheck('noise large', worst)
  }, 1_800_000)
})

// ── The esbuild guard: the noise core survives Nitro's build ─────────────────

describe('esbuild guard: the noise core survives Nitro’s build, with its kernels and random numbers', () => {
  const require = createRequire(import.meta.url)
  const pnpm = fileURLToPath(new URL('../../node_modules/.pnpm/', import.meta.url))
  const builds = readdirSync(pnpm).filter(d => /^esbuild@\d/.test(d)).map(d => join(pnpm, d, 'node_modules', 'esbuild'))
  const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../../server/runner/${rel}`, import.meta.url)), 'utf8')
  const dir = mkdtempSync(join(tmpdir(), 'noise-esbuild-'))
  // Reaction-diffusion (exact: the Winograd laplacian, torch's rand) and Stipple on a picture (rand, pools).
  const rd = FX.cases.find(x => x.name === 'ReactionDiffusion: 64², 50 iterations, feed 0.04, kill 0.06')!
  const st = FX.cases.find(x => x.name === 'Stipple: defaults, rgb 37×23')!

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
        const rngm = await build('effects/core/rng.ts', 'rng')
        const nm = await build('effects/core/noise.ts', 'noise')
        const pxB = new Function(`return (${px.pixelsCore!.toString()})()`)()
        const tkB = new Function('px', `return (${tkm.tensorCore!.toString()})(px)`)(pxB)
        const knB = new Function('k', 'px', `return (${knm.kernelsCore!.toString()})(k, px)`)(tkB, pxB)
        const rngB = new Function(`return (${rngm.rngCore!.toString()})()`)()
        const noiseB = new Function('k', 'kn', 'rng', `return (${nm.noiseCore!.toString()})(k, kn, rng)`)(tkB, knB, rngB) as Record<string, Op>
        expectExactItem(noiseB.ReactionDiffusion!({}, paramsOf(rd as FxCase), undefined, {}, 0, 1).outputs[0]!, rd.outputs![0]!.items[0]!, 'built in this thread')
        const cores = [
          { name: 'tk', fn: tkm.tensorCore as never, args: ['px'] },
          { name: 'kn', fn: knm.kernelsCore as never, args: ['tk', 'px'] },
          { name: 'rng', fn: rngm.rngCore as never, args: [] },
          { name: 'noise', fn: nm.noiseCore as never, args: ['tk', 'kn', 'rng'] },
        ]
        const w = new Worker(workerScript(compositorCore, px.pixelsCore as never, cores), { eval: true, workerData: { stop: new SharedArrayBuffer(4) } })
        try {
          const reply = (m: Record<string, unknown>) => new Promise<any>((res) => { w.once('message', res); w.postMessage(m) })
          const { files } = pictureOf(st as FxCase)
          const raw = await decodeRaw(files[st.inputs.image!.files[0]!]!, 'rgb')
          const params = EFFECTS.Stipple!.prepare!(paramsOf(st as FxCase))
          expect((await reply({ id: 1, op: 'fx.begin', cls: 'Stipple', fn: 'noise.Stipple', params, count: 1 })).error).toBeUndefined()
          const r = await reply({ id: 2, op: 'fx.run', index: 0, inputs: { image: raw }, first: true, masks: [false], want: { round: [true], trunc: [false] } })
          expect(r.error).toBeUndefined()
          expect(sha256(r.value.outputs[0].round8)).toBe(st.outputs![0]!.items[0]!.round8_sha256)
          expect(sha256(r.value.preview.px)).toBe(st.preview!.px_sha256)
          // Add noise's bigint seed crosses into the worker as it is.
          expect((await reply({ id: 3, op: 'fx.begin', cls: 'AddNoise', fn: 'noise.AddNoise', params: { amount: 0.3, type: 'gaussian', monochromatic: false, seed: BigInt('18446744073709551615') }, count: 1 })).error).toBeUndefined()
          const a = await reply({ id: 4, op: 'fx.run', index: 0, inputs: { image: raw }, first: false, masks: [false], want: { round: [true], trunc: [false] } })
          expect(a.error).toBeUndefined()
        }
        finally { await w.terminate() }
      }, 60_000)
    }
  }
})

// ── Stop ─────────────────────────────────────────────────────────────────────

describe('Stop', () => {
  const PATHS: [string, Record<string, unknown>][] = [
    ['FilmGrain', { amount: 0.5, size: 1 }], ['FilmGrain', { amount: 0.5, size: 2 }], ['FilmGrain', { amount: 0 }],
    ['Glitch', {}], ['Glitch', { intensity: 0 }],
    ['PerlinNoise', { width: 64, height: 200, octaves: 3 }], ['Voronoi', { width: 64, height: 200 }], ['GradientGenerator', { width: 64, height: 200 }],
    ['GradientGenerator', { width: 64, height: 200, type: 'radial' }], ['ReactionDiffusion', { width: 64, height: 200, iterations: 50 }],
    ['Fractal', { width: 64, height: 200, max_iter: 16 }], ['PaletteQuantize', { iterations: 2 }], ['Stipple', {}], ['FlowField', {}],
    ['AddNoise', { seed: 3 }], ['AddNoise', { seed: 3, type: 'uniform' }], ['AddNoise', { seed: 3, amount: 0 }],
  ]
  const x = tk.tensor(3, 256, 40)
  for (let i = 0; i < x.data.length; i++) x.data[i] = (i % 97) / 97

  for (const [cls, over] of PATHS) {
    it(`${cls} ${JSON.stringify(over)}: every Stop check along the run stops it`, () => {
      const spec = EFFECTS[cls]!
      const op = coreOp(spec.op) as unknown as Op
      const base = { ...defaultsOf(cls), ...over }
      const p = spec.prepare ? spec.prepare(base) : base
      const rows = EFFECT_GENERATOR_CLASSES.includes(cls) ? [{}] : [{ image: x }]
      let total = 0
      runBatch(op, rows, p, !!spec.gather, () => { total++; return false })
      expect(total, 'checks in a whole run').toBeGreaterThanOrEqual(4)
      for (const at of [1, 2, Math.ceil(total / 2), total - 1, total]) {
        let calls = 0
        expect(() => runBatch(op, rows, p, !!spec.gather, () => ++calls >= at), `stopped at check ${at} of ${total}`).toThrow('Stopped')
        expect(calls).toBe(at)
      }
    })
  }

  it('Reaction-diffusion checks Stop at every iteration (a Stop waits one iteration at most)', () => {
    const op = coreOp(EFFECTS.ReactionDiffusion!.op) as unknown as Op
    let checks = 0
    op({}, { ...defaultsOf('ReactionDiffusion'), width: 64, height: 64, iterations: 120 }, () => { checks++; return false })
    expect(checks).toBeGreaterThanOrEqual(120)
  })
})

// ── Palette quantize's distance sum is kernels.ts sumContiguous ──────────────

describe('Palette quantize\'s written-out distance sum', () => {
  it('equals kernels.ts sumContiguous over 3 and 4 squared differences (the order torch sums a last dim of that size in)', () => {
    let seed = 7
    const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296 }
    const f = Math.fround
    for (let n = 0; n < 20000; n++) {
      for (const C of [3, 4]) {
        const buf = new Float32Array(C)
        let sum = 0
        for (let c = 0; c < C; c++) {
          const d = f(f(rnd() * (n % 3 === 0 ? 1e-3 : 1)) - f(rnd()))
          buf[c] = f(d * d)
          sum = f(sum + buf[c]!)
        }
        expect(sum).toBe(kn.sumContiguous(buf, 0, C))
      }
    }
  })
})

// ── The existing kernels are untouched ───────────────────────────────────────

describe('the kernels other effects use are untouched', () => {
  it('conv2dDepthwise is still the double-summed correlation (the R2.5 Sobel / Emboss users stay within their ε)', () => {
    const src = readFileSync(resolve(__dirname, '../../server/runner/effects/core/kernels.ts'), 'utf8')
    expect(src).toContain('const conv2dDepthwise = (t: Tensor, kernel: ArrayLike<number>, kh: number, kw: number, stop?: () => boolean) => correlate(t, kernel, kh, kw, 0, stop)')
    const blur = readFileSync(resolve(__dirname, '../../server/runner/effects/core/blur.ts'), 'utf8')
    expect(blur).not.toContain('conv2dWinograd3x3')
  })
})
