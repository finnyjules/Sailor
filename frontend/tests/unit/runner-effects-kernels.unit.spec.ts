/**
 * R2.2: the kernels the picture effects share (server/runner/effects/core/kernels.ts),
 * each against torch 2.10 / torchvision 0.25 on its own:
 * scripts/runner_effects_fixtures.py --group kernels → fixtures/runner-effects-kernels.json.
 *
 * EXACT kernels equal torch's float32 bit for bit (the stored bytes, or their
 * sha256 when large). LIBRARY kernels (R2 rule 10, ruling (b)) give 8-bit
 * output (trunc and round) equal to Python's except where Python's float lies
 * within ε of that mode's boundary; ε is per kernel, the smallest of the
 * fixture's candidates (2⁻¹², 2⁻¹⁰, 2⁻⁸) that passes, pinned below. With
 * KERNELS_REPORT=<file> the spec writes each library kernel's largest |Δ|
 * (and each gaussian blur's, per (ksize, σ)) and the blur's speed to <file>.
 */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { inflateSync } from 'node:zlib'
import { afterAll, describe, expect, it } from 'vitest'
import { b64, loadFixtures, sha256, type FxFile } from './__runner__/effectsParity'
import { effectCores } from '~~/server/runner/effects/cores'
import { kernelsCore } from '~~/server/runner/effects/core/kernels'
import { tensorCore, type Tensor } from '~~/server/runner/effects/core/tensor'
import { pixelsCore } from '~~/server/runner/pixels/core'
import { compositorCore } from '~~/server/runner/compositor/plane'
import { workerScript } from '~~/server/runner/compositor/worker'
import { EFFECT_ERROR_MESSAGES, EFFECT_MAX_WORK } from '#shared/runner/effects'

const kn = effectCores.kn
const tk = effectCores.tk

// ── The fixture ──────────────────────────────────────────────────────────────

interface InputSpec { shape: [number, number, number]; seed: number; lo: number; hi: number; memory: 'contiguous' | 'channels-last'; levels?: number; neg_zero_every?: number; nan_every?: number }
type Band = Record<'trunc' | 'round', { count: number; in: string; py8: string }>
interface KOut { shape: number[]; f32_sha256: string; f32?: string; f32z?: string; bands?: Record<string, Band> }
interface KCase {
  name: string
  fn: string
  class: 'exact' | 'library'
  inputs: InputSpec[]
  args: Record<string, any>
  outputs?: KOut[]
  error?: { type: string; message: string }
}
interface TopkCase { name: string; input: InputSpec; k: number; largest: boolean; values: string; indices: number[]; cut: number }
interface KFile extends FxFile { cases: any[]; topk: TopkCase[]; eps_candidates: Record<string, number> }

const FX = loadFixtures<KFile>('kernels')
const CASES = FX.cases as KCase[]

/** scripts/runner_effects_fixtures.py `hashed_values`: n float32 values from a hash of the index. */
function hashedValues(n: number, seed: number, lo = 0, hi = 1, levels = 0): Float32Array {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const k = ((Math.imul(i, 2654435761) + seed * 40503) >>> 0) >>> 8
    let u = k / 16777216
    if (levels) u = Math.floor(u * levels) / (levels - 1)
    out[i] = lo + (hi - lo) * u
  }
  return out
}

/** A case's input tensor (planar); every `neg_zero_every`-th value −0 and every `nan_every`-th NaN, as the fixture sets them. */
function tensorOf(s: InputSpec): Tensor {
  const data = hashedValues(s.shape[0] * s.shape[1] * s.shape[2], s.seed, s.lo, s.hi, s.levels ?? 0)
  if (s.neg_zero_every) for (let i = 0; i < data.length; i += s.neg_zero_every) data[i] = -0
  if (s.nan_every) for (let i = 0; i < data.length; i += s.nan_every) data[i] = Number.NaN
  return { c: s.shape[0], h: s.shape[1], w: s.shape[2], data }
}

/** The fixture's grid edits: every 7th value on an edge (±1 alternately), every 11th from the 4th at 0. */
function gridPlane(s: InputSpec): Float32Array {
  const v = tensorOf(s).data
  for (let j = 0, i = 0; i < v.length; i += 7, j++) v[i] = j % 2 === 0 ? 1 : -1
  for (let i = 3; i < v.length; i += 11) v[i] = 0
  return v
}

/** What a case's kernel makes, as planar float32 planes (one per output; a batch case: one per picture). */
function run(c: KCase): Float32Array[] {
  const a = c.args
  if (a.batch) {
    return c.inputs.map((spec, index) => {
      const t = tensorOf(spec)
      const layout = { cl: spec.memory === 'channels-last', batch: a.batch as number, index }
      switch (c.fn) {
        case 'meanAll': return Float32Array.of(kn.meanAll(t.data, layout))
        case 'adjustContrast': return kn.adjustContrast(t, a.f, layout).data
        case 'adjustBrightness': return kn.adjustBrightness(t, a.f, layout).data
        case 'resizeArea': return kn.resizeArea(t, a.oh, a.ow, layout).data
        default: throw new Error(`no batch kernel ${c.fn}`)
      }
    })
  }
  const ins = c.inputs.map(tensorOf)
  const cl = c.inputs[0]?.memory === 'channels-last'
  const t = ins[0]!
  const d = (x: Tensor) => [x.data]
  switch (c.fn) {
    case 'linspace': return [kn.linspace(a.a, a.b, a.n)]
    case 'arange': return [kn.arange(a.n)]
    case 'remainder': return d(kn.remainder(t, ins[1] ?? a.b))
    case 'powScalar': return d(kn.powScalar(t, a.e))
    case 'unary': return d(kn.unary(t, a.op, ins[1]))
    case 'areaOutSize': return [Float32Array.of(kn.areaOutSize(a.in, a.scale))]
    case 'resizeArea': return d(kn.resizeArea(t, a.oh, a.ow, { cl }))
    case 'resizeNearest': return d(kn.resizeNearest(t, a.oh, a.ow))
    case 'resizeBilinear': return d(kn.resizeBilinear(t, a.oh, a.ow, cl))
    case 'resizeBicubic': return d(kn.resizeBicubic(t, a.oh, a.ow))
    case 'gridSample': {
      const g = c.inputs[1]!
      return d(kn.gridSample(t, gridPlane(g), gridPlane(c.inputs[2]!), { padding: a.padding, alignCorners: a.alignCorners, oh: g.shape[1], ow: g.shape[2] }))
    }
    case 'affineGrid': { const r = kn.affineGrid(a.theta, a.h, a.w); return [r.gx, r.gy] }
    case 'avgPool2d': return d(kn.avgPool2d(t, a.k, a.pad))
    case 'avgPool2dStrided': return d(kn.avgPool2dStrided(t, a.k))
    case 'maxPool2d': return d(kn.maxPool2d(t, a.k, a.pad))
    case 'padReflect': return d(kn.padReflect(t, a.l, a.r, a.top, a.bottom))
    case 'conv2dDepthwise': return d(kn.conv2dDepthwise(t, a.kernel, a.kh, a.kw))
    case 'conv2dSame': return d(kn.conv2dSame(t, a.kernel, a.kh, a.kw, a.pad))
    case 'gaussianKernel1d': return [kn.gaussianKernel1d(a.ksize, a.sigma)]
    case 'gaussianBlur': return d(kn.gaussianBlur(t, a.ksize, a.sigma))
    case 'rgbToGrayscale': return d(kn.rgbToGrayscale(t))
    case 'blend': return d(kn.blend(t, ins[1]!, a.ratio, { cl }))
    case 'adjustBrightness': return d(kn.adjustBrightness(t, a.f, { cl }))
    case 'adjustSaturation': return d(kn.adjustSaturation(t, a.f, { cl }))
    case 'adjustContrast': return d(kn.adjustContrast(t, a.f, { cl }))
    case 'adjustHue': return d(kn.adjustHue(t, a.f))
    case 'meanAll': return [Float32Array.of(kn.meanAll(t.data))]
    default: throw new Error(`no kernel ${c.fn}`)
  }
}

const bytesOf = (a: Float32Array) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
const pyFloats = (o: KOut): Float32Array | null => {
  const raw = o.f32 ? b64(o.f32) : o.f32z ? new Uint8Array(inflateSync(b64(o.f32z))) : null
  return raw ? new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)) : null
}

/** The runner's message key for what Python raised (R2 rule 6). */
function errorKey(e: { type: string; message: string }): string {
  if (/permitted channel values/.test(e.message)) return 'EFFECT_NEEDS_RGB'
  if (/Padding size should be less|Output size is too small/.test(e.message)) return 'EFFECT_PICTURE_TOO_SMALL'
  if (/pad should be at most half/.test(e.message)) return kn.KERNEL_MESSAGES.poolPad
  throw new Error(`unmapped Python error: ${e.message}`)
}

// ── 8-bit bands (R2 rule 10) ─────────────────────────────────────────────────

const trunc8 = (v: number) => { const x = Math.fround(255 * v); return x > 0 ? (x > 255 ? 255 : Math.trunc(x)) : 0 }
const round8 = (v: number) => effectCores.px.roundHalfEven(Math.fround((v > 0 ? (v > 1 ? 1 : v) : 0) * 255))

/** The first value whose 8-bit form (this mode) differs from Python's other than by one level within ε of the boundary; −1 when none. */
function firstOutsideBand(ts: Float32Array, py: Float32Array, eps: number, mode: 'trunc' | 'round'): number {
  const q = mode === 'trunc' ? trunc8 : round8
  for (let i = 0; i < py.length; i++) {
    const a = q(ts[i]!)
    const b = q(py[i]!)
    if (a === b) continue
    const v = py[i]! * 255
    const edge = mode === 'trunc' ? Math.round(v) : Math.floor(v) + 0.5
    if (Math.abs(a - b) > 1 || !(Math.abs(v - edge) < eps)) return i
  }
  return -1
}

/** The largest |ts − py|·255 over values 8-bit output can tell apart (both clamped to [−0.01, 1.01]). */
function diff255(ts: Float32Array, py: Float32Array): number {
  const c = (v: number) => (v < -0.01 ? -0.01 : v > 1.01 ? 1.01 : v)
  let m = 0
  for (let i = 0; i < py.length; i++) m = Math.max(m, Math.abs(c(ts[i]!) - c(py[i]!)) * 255)
  return m
}

/** Units in the last place between two float32s (same sign; 0 when equal, ∞ across a sign or with NaN). */
function ulps(a: number, b: number): number {
  if (Object.is(a, b) || a === b) return 0
  if (!Number.isFinite(a) || !Number.isFinite(b) || (a < 0) !== (b < 0)) return Infinity
  const i = new Int32Array(new Float32Array([a, b]).buffer)
  return Math.abs(i[0]! - i[1]!)
}

/**
 * Each library kernel's ε (255-scale): the smallest fixture candidate at or
 * above its largest measured difference from torch over the values 8-bit
 * output can tell apart (both clamped to [−0.01, 1.01]). That is proven for
 * the fixture's cases only: the kernels, sizes and ranges below. A family
 * with other weights or wider blurs must measure again (these tests fail
 * loudly if a new fixture case exceeds ε). The test shows the next smaller
 * candidate is under the measured difference. gaussianBlur's error is mostly
 * torch's own float sums over k² taps (181: 1.4 × 10⁻³); its proven range is
 * ksize ≤ 181, wider is refused ((301, 50) measured 5.8 × 10⁻³ in review, so
 * it is not an acceptance case). conv2d's covers random normalised and
 * unnormalised kernels (−2…2) up to 21 × 21. Transcendental and
 * kernel-weight results also carry their largest difference in float32 ulps.
 */
const EPS = {
  powScalar: 2 ** -12,
  unary: 2 ** -12,
  affineGrid: 2 ** -12,
  conv2dDepthwise: 2 ** -8,
  conv2dSame: 2 ** -8,
  gaussianKernel1d: 2 ** -12,
  gaussianBlur: 2 ** -8,
} as const
const MAX_ULPS: Partial<Record<keyof typeof EPS, number>> = {
  powScalar: 2,
  unary: 1,
  gaussianKernel1d: 2,
}
const CANDIDATES = [2 ** -12, 2 ** -10, 2 ** -8]

const measured: Record<string, { dmax: number; ulpMax: number }> = {}
afterAll(() => {
  if (process.env.KERNELS_REPORT) writeFileSync(process.env.KERNELS_REPORT, `${JSON.stringify(measured, null, 1)}\n`)
})

// ── The tests ────────────────────────────────────────────────────────────────

describe('the kernels fixture', () => {
  it('was written by torch at its default thread count, on this machine kind', () => {
    expect(FX.torch).toMatch(/^2\.10\./)
    expect(FX.threads).toBeGreaterThan(1)
    expect(FX.threads).toBe(kn.TORCH_THREADS)
    expect(FX.eps_candidates).toEqual({ '2^-12': 2 ** -12, '2^-10': 2 ** -10, '2^-8': 2 ** -8 })
  })

  it('covers every kernel the brief names', () => {
    const fns = new Set(CASES.map(c => c.fn))
    for (const fn of ['linspace', 'arange', 'remainder', 'powScalar', 'unary', 'areaOutSize', 'resizeArea', 'resizeNearest', 'resizeBilinear',
      'resizeBicubic', 'gridSample', 'affineGrid', 'avgPool2d', 'avgPool2dStrided', 'maxPool2d', 'padReflect', 'conv2dDepthwise', 'conv2dSame',
      'gaussianKernel1d', 'gaussianBlur', 'rgbToGrayscale', 'blend', 'adjustBrightness', 'adjustSaturation', 'adjustContrast', 'adjustHue', 'meanAll']) {
      expect(fns.has(fn), fn).toBe(true)
    }
    expect(CASES.length).toBe(548)
    expect(FX.topk.length).toBe(8)
  })
})

describe('exact kernels: torch’s float32, bit for bit', () => {
  for (const c of CASES.filter(x => x.class === 'exact')) {
    it(`${c.fn}: ${c.name}`, () => {
      if (c.error) {
        const key = errorKey(c.error)
        expect(() => run(c)).toThrow(key)
        expect(EFFECT_ERROR_MESSAGES[key] ?? Object.values(kn.KERNEL_MESSAGES).find(m => m === key)).toBeTruthy()
        return
      }
      const got = run(c)
      expect(got.length).toBe(c.outputs!.length)
      c.outputs!.forEach((o, n) => {
        expect(got[n]!.length, 'values').toBe(o.shape.reduce((a, b) => a * b, 1))
        const py = pyFloats(o)
        if (py) {
          const gi = new Uint32Array(got[n]!.buffer, got[n]!.byteOffset, got[n]!.length)
          const pi = new Uint32Array(py.buffer)
          let bad = -1
          for (let i = 0; i < pi.length; i++) if (gi[i] !== pi[i]) { bad = i; break }
          expect(bad, `first float that differs: got ${got[n]![bad]}, want ${py[bad]}`).toBe(-1)
        }
        expect(sha256(bytesOf(got[n]!)), 'sha256 of the float32').toBe(o.f32_sha256)
      })
    })
  }
})

describe('library kernels: 8-bit equal but within ε of a boundary', () => {
  for (const c of CASES.filter(x => x.class === 'library')) {
    const eps = EPS[c.fn as keyof typeof EPS]
    it(`${c.fn} (ε ${eps}): ${c.name}`, () => {
      expect(eps, 'a pinned ε').toBeDefined()
      if (c.error) {
        expect(() => run(c)).toThrow(errorKey(c.error))
        return
      }
      const got = run(c)
      c.outputs!.forEach((o, n) => {
        const py = pyFloats(o)!
        const ts = got[n]!
        expect(ts.length).toBe(py.length)
        const m = (measured[c.fn] ??= { dmax: 0, ulpMax: 0 })
        const dmax = diff255(ts, py)
        let ulpMax = 0
        for (let i = 0; i < py.length; i++) ulpMax = Math.max(ulpMax, ulps(ts[i]!, py[i]!))
        m.dmax = Math.max(m.dmax, dmax)
        m.ulpMax = Math.max(m.ulpMax, ulpMax)
        if (c.fn === 'gaussianBlur') measured[`gaussianBlur (${c.args.ksize}, ${c.args.sigma}) ${c.name}`] = { dmax, ulpMax }
        expect(dmax, 'largest difference (255-scale)').toBeLessThan(eps!)
        for (const mode of ['trunc', 'round'] as const) {
          const bad = firstOutsideBand(ts, py, eps!, mode)
          expect(bad, `${mode}: value ${bad} (got ${ts[bad]}, want ${py[bad]})`).toBe(-1)
        }
        const cap = MAX_ULPS[c.fn as keyof typeof EPS]
        if (cap !== undefined) expect(ulpMax, 'ulps').toBeLessThanOrEqual(cap)
        // The fixture's own band lists (per ε candidate) agree with its floats.
        for (const [name, band] of Object.entries(o.bands ?? {})) {
          const e = FX.eps_candidates[name]!
          const count = (mode: 'trunc' | 'round') => {
            let n = 0
            for (let i = 0; i < py.length; i++) {
              const v = py[i]! * 255
              const edge = mode === 'trunc' ? Math.round(v) : Math.floor(v) + 0.5
              if (Math.abs(v - edge) < e) n++
            }
            return n
          }
          expect(band.trunc.count, `${name} trunc`).toBe(count('trunc'))
          expect(band.round.count, `${name} round`).toBe(count('round'))
        }
      })
    })
  }

  it('each ε is the smallest candidate at or above the kernel’s largest difference', () => {
    for (const fn of Object.keys(EPS) as (keyof typeof EPS)[]) {
      const cases = CASES.filter(c => c.fn === fn && c.class === 'library' && !c.error)
      expect(cases.length, fn).toBeGreaterThan(0)
      const dmax = Math.max(...cases.flatMap(c => run(c).map((ts, n) => diff255(ts, pyFloats(c.outputs![n]!)!))))
      expect(dmax, fn).toBeLessThan(EPS[fn])
      const smaller = CANDIDATES.filter(e => e < EPS[fn]).at(-1)
      if (smaller !== undefined) expect(dmax, `${fn} against ${smaller}`).toBeGreaterThanOrEqual(smaller)
      expect(EPS[fn]).toBeLessThanOrEqual(2 ** -8)
    }
  }, 120_000)
})

describe('topk', () => {
  for (const c of FX.topk) {
    it(c.name, () => {
      const values = tensorOf(c.input).data
      const got = kn.topk(values, c.k, c.largest)
      const want = new Float32Array(b64(c.values).slice().buffer)
      expect(got.length).toBe(c.k)
      // The values in order, bit for bit.
      expect([...got].map(i => values[i]!)).toEqual([...want])
      // Every index torch keeps above the cut is kept; at the cut any of the tied ones will do.
      const above = (i: number) => (c.largest ? Number.isNaN(values[i]!) || values[i]! > c.cut : values[i]! < c.cut)
      expect(new Set([...got].filter(above))).toEqual(new Set(c.indices.filter(above)))
      for (const i of got) if (!above(i)) expect(values[i]).toBe(Math.fround(c.cut))
      expect(new Set(got).size).toBe(c.k)
    })
  }
})

describe('the kernels’ own rules', () => {
  it('fmaf rounds once, as the hardware fused multiply-add does', () => {
    // 1 + 2⁻²⁴ is half-way between two floats; a tiny product decides.
    expect(kn.fmaf(2 ** -30, 2 ** -30, 1 + 2 ** -24)).toBe(Math.fround(1 + 2 ** -23))
    expect(kn.fmaf(-(2 ** -30), 2 ** -30, 1 + 2 ** -24)).toBe(1)
    expect(kn.fmaf(3, 5, 7)).toBe(22)
  })

  it('reflect padding of the picture’s side or more is refused with plain words, as torch refuses it', () => {
    const t = tensorOf({ shape: [1, 5, 7], seed: 1, lo: 0, hi: 1, memory: 'contiguous' })
    expect(() => kn.padReflect(t, 7, 0, 0, 0)).toThrow('EFFECT_PICTURE_TOO_SMALL')
    expect(() => kn.gaussianBlur(t, 11, 2)).toThrow('EFFECT_PICTURE_TOO_SMALL')
    expect(kn.padReflect(t, 6, 6, 4, 4).w).toBe(19)
  })

  it('refuses what torch refuses: a pool padded over half its window, an even or empty blur, a blur wider than its proven range', () => {
    const t = tensorOf({ shape: [1, 400, 400], seed: 1, lo: 0, hi: 1, memory: 'contiguous' })
    expect(() => kn.avgPool2d(t, 3, 2)).toThrow(kn.KERNEL_MESSAGES.poolPad)
    expect(() => kn.maxPool2d(t, 2, 2)).toThrow(kn.KERNEL_MESSAGES.poolPad)
    expect(kn.maxPool2d(t, 2, 1).w).toBe(401)
    expect(() => kn.gaussianBlur(t, 4, 1)).toThrow(kn.KERNEL_MESSAGES.blurSize)
    expect(() => kn.gaussianBlur(t, 0, 1)).toThrow(kn.KERNEL_MESSAGES.blurSize)
    expect(() => kn.gaussianBlur(t, 5, 0)).toThrow(kn.KERNEL_MESSAGES.blurSize)
    expect(kn.GAUSSIAN_MAX_KSIZE).toBe(181)
    expect(() => kn.gaussianBlur(t, 183, 30)).toThrow(kn.KERNEL_MESSAGES.blurTooWide)
    expect(() => kn.gaussianBlur(t, 301, 50)).toThrow(kn.KERNEL_MESSAGES.blurTooWide)
  })

  it('an area resize to 0 rows is an empty picture, as torch returns', () => {
    const t = tensorOf({ shape: [3, 5, 7], seed: 1, lo: 0, hi: 1, memory: 'contiguous' })
    expect(kn.resizeArea(t, 0, 3).data.length).toBe(0)
  })

  it('clamp: −0 comes out +0 (torch’s vector loop), NaN stays NaN', () => {
    expect(Object.is(kn.clamp01(-0), 0)).toBe(true)
    expect(kn.clamp01(Number.NaN)).toBeNaN()
    expect(kn.clamp01(-3)).toBe(0)
    expect(kn.clamp01(3)).toBe(1)
    // A 63-value tensor runs 56 values in pairs of vectors, the last 7 one by one.
    expect(kn.inScalarTail(55, 63, 6)).toBe(false)
    expect(kn.inScalarTail(56, 63, 6)).toBe(true)
    // 70,000 values: 3 OpenMP chunks of 23,334 (tails of 6) and a last of 23,332 (tail of 4).
    expect([23327, 23328, 23333, 23334, 69995, 69996].map(m => kn.inScalarTail(m, 70000, 6))).toEqual([false, true, true, false, false, true])
  })

  it('a batch of two or more sums each picture on one thread (torch splits over the batch)', () => {
    const v = hashedValues(1_000_003, 9)
    expect(kn.meanAll(v, { batch: 2 })).toBe(kn.meanAll(v, { threads: 1 }))
    expect(kn.meanAll(v, { batch: 2 })).not.toBe(kn.meanAll(v))
  })

  it('a long sum is split between threads as torch splits it (the chunks change the float)', () => {
    const v = hashedValues(1_000_003, 9)
    expect(kn.sumAll(v, 6)).not.toBe(kn.sumAll(v, 1))
  })
})

// ── Speed: the heaviest blur the effects will ask for ───────────────────────

describe('speed', () => {
  it('gaussianBlur(ksize 181) on 1024² × 4 finishes within the work budget', () => {
    const t: Tensor = { c: 4, h: 1024, w: 1024, data: hashedValues(4 * 1024 * 1024, 3) }
    const work = 2 * 181 * 4 * 1024 * 1024
    expect(work).toBeLessThan(EFFECT_MAX_WORK)
    const t0 = performance.now()
    const out = kn.gaussianBlur(t, 181, 30)
    const s = (performance.now() - t0) / 1000
    expect(out.data.length).toBe(t.data.length)
    measured['speed: gaussianBlur 181 on 1024² × 4 (dmax = seconds, ulpMax = 10⁹ taps/s)'] = { dmax: s, ulpMax: work / s / 1e9 }
    // EFFECT_MAX_WORK is sized so its heaviest case takes under 60 s.
    expect(s).toBeLessThan(60)
  }, 120_000)
})

// ── topk at 8192² ────────────────────────────────────────────────────────────

describe('topk at 8192²', () => {
  const n = 8192 * 8192
  const values = hashedValues(n, 11)

  it('selects the 100 largest of 67 million values in seconds, not a full sort', () => {
    const t0 = performance.now()
    const got = kn.topk(values, 100, true)
    const s = (performance.now() - t0) / 1000
    measured['speed: topk k 100 of 8192² (dmax = seconds)'] = { dmax: s, ulpMax: 0 }
    expect(got.length).toBe(100)
    // Every kept value is at least the 100th, and they come in order.
    const cut = values[got[99]!]!
    let above = 0
    for (let i = 0; i < n; i++) if (values[i]! > cut) above++
    expect(above).toBeLessThan(100)
    for (let j = 1; j < 100; j++) expect(values[got[j - 1]!]! >= values[got[j]!]!).toBe(true)
    expect(s).toBeLessThan(20)
  }, 120_000)

  it('stops when asked', () => {
    let calls = 0
    expect(() => kn.topk(values, 100, true, () => ++calls > 3)).toThrow('Stopped')
    expect(calls).toBe(4)
  })
})

// ── The esbuild guard: the kernels built as Nitro builds server code ─────────

describe('esbuild guard: the kernels core survives Nitro’s build', () => {
  const require = createRequire(import.meta.url)
  const pnpm = fileURLToPath(new URL('../../node_modules/.pnpm/', import.meta.url))
  const builds = readdirSync(pnpm).filter(d => /^esbuild@\d/.test(d)).map(d => join(pnpm, d, 'node_modules', 'esbuild'))
  const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../../server/runner/${rel}`, import.meta.url)), 'utf8')
  const dir = mkdtempSync(join(tmpdir(), 'kernels-esbuild-'))
  const probe: Tensor = tensorOf({ shape: [3, 23, 37], seed: 5, lo: 0, hi: 1, memory: 'contiguous' })
  const reference = (() => {
    const blur = kn.gaussianBlur(probe, 7, 1)
    const hue = kn.adjustHue(probe, 0.13)
    const cubic = kn.resizeBicubic(probe, 17, 29)
    return { blur: sha256(bytesOf(blur.data)), hue: sha256(bytesOf(hue.data)), cubic: sha256(bytesOf(cubic.data)) }
  })()

  it('finds an esbuild to build with', () => {
    expect(builds.length).toBeGreaterThan(0)
  })

  for (const esbuildDir of builds) {
    for (const minify of [false, true]) {
      it(`${esbuildDir.split('/').at(-3)} target es2019, minify ${minify}: the source-text kernels run, in a Worker too`, async () => {
        const esb = require(esbuildDir) as typeof import('esbuild')
        const build = async (rel: string, name: string) => {
          let code = (await esb.transform(src(rel), { loader: 'ts', target: 'es2019', format: 'esm' })).code
          if (minify) code = (await esb.transform(code, { loader: 'js', target: 'es2019', minify: true })).code
          const file = join(dir, `${name}-${minify}.mjs`)
          writeFileSync(file, code)
          return await import(`${pathToFileURL(file).href}?${Math.random()}`) as Record<string, (...a: unknown[]) => unknown>
        }
        const pxM = await build('pixels/core.ts', 'pixels')
        const tkM = await build('effects/core/tensor.ts', 'tensor')
        const knM = await build('effects/core/kernels.ts', 'kernels')
        // Rebuilt from their own source text, with nothing in scope.
        const pxB = new Function(`return (${pxM.pixelsCore!.toString()})()`)()
        const tkB = new Function('px', `return (${tkM.tensorCore!.toString()})(px)`)(pxB)
        const knB = new Function('k', 'px', `return (${knM.kernelsCore!.toString()})(k, px)`)(tkB, pxB) as ReturnType<typeof kernelsCore>
        expect(sha256(bytesOf(knB.gaussianBlur(probe, 7, 1).data))).toBe(reference.blur)
        expect(sha256(bytesOf(knB.adjustHue(probe, 0.13).data))).toBe(reference.hue)
        expect(sha256(bytesOf(knB.resizeBicubic(probe, 17, 29).data))).toBe(reference.cubic)
        // And in the worker's own script, called through a probe op that uses them.
        const probeCore = (kk: ReturnType<typeof kernelsCore>) => ({
          blur: (inp: Record<string, Tensor>, p: Record<string, number>) => ({ outputs: [kk.gaussianBlur(inp.image!, p.ksize!, p.sigma!)], preview: null }),
        })
        const cores = [
          { name: 'tk', fn: tkM.tensorCore as never, args: ['px'] },
          { name: 'kn', fn: knM.kernelsCore as never, args: ['tk', 'px'] },
          { name: 'probe', fn: probeCore as never, args: ['kn'] },
        ]
        const w = new Worker(workerScript(compositorCore, pxM.pixelsCore as never, cores), { eval: true, workerData: { stop: new SharedArrayBuffer(4) } })
        try {
          const reply = (m: Record<string, unknown>) => new Promise<any>((res) => { w.once('message', res); w.postMessage(m) })
          const px8 = new Uint8Array(37 * 23 * 4)
          for (let i = 0; i < px8.length; i++) px8[i] = (i * 37) & 255
          const raw = { source: 'rgb', w: 37, h: 23, data: px8 }
          const want = tk.quantize(kn.gaussianBlur(tk.fromPicture(raw), 7, 1), 'round')
          expect((await reply({ id: 1, op: 'fx.begin', cls: 'probe', fn: 'probe.blur', params: { ksize: 7, sigma: 1 }, count: 1 })).error).toBeUndefined()
          const r = await reply({ id: 2, op: 'fx.run', index: 0, inputs: { image: raw }, first: true, masks: [false], want: { round: [true], trunc: [false] } })
          expect(r.error).toBeUndefined()
          expect(Buffer.compare(r.value.outputs[0].round8, want)).toBe(0)
        }
        finally { await w.terminate() }
      }, 30_000)
    }
  }

  it('the in-thread kernels are built as the worker builds them', () => {
    const k2 = kernelsCore(tensorCore(pixelsCore()), pixelsCore())
    expect(Object.keys(k2)).toEqual(Object.keys(kn))
  })
})
