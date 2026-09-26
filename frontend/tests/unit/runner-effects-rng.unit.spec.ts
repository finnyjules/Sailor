/**
 * R2.3: torch's CPU random numbers (server/runner/effects/core/rng.ts) against
 * torch 2.10 on its own: scripts/runner_effects_fixtures.py --group rng →
 * fixtures/runner-effects-rng.json.
 *
 * Every case replays its calls on one generator seeded as the case was. The
 * raw mt19937 draws, rand and randperm must give torch's bytes (their sha256,
 * and the first 64 values). randn is bit-exact on at least 99.9% of draws and
 * differs only where this Mac's libm (logf, __sincosf_stret) is not correctly
 * rounded — one ulp of sin / cos, at most two ulps of the draw — which the
 * fixture's libm record proves draw by draw. With RNG_REPORT=<file> the spec
 * writes the randn draws that differ.
 */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { describe, expect, it } from 'vitest'
import { b64, loadFixtures, sha256, type FxFile } from './__runner__/effectsParity'
import { rngCore, type TorchGenerator } from '~~/server/runner/effects/core/rng'
import { effectCores } from '~~/server/runner/effects/cores'
import type { Tensor } from '~~/server/runner/effects/core/tensor'
import { compositorCore } from '~~/server/runner/compositor/plane'
import { workerScript } from '~~/server/runner/compositor/worker'

// ── The fixture ──────────────────────────────────────────────────────────────

type Call = { op: 'raw' | 'randperm'; n: number } | { op: 'rand' | 'randn'; shape: number[] }
interface Out { dtype: 'u64' | 'i64' | 'f32'; n: number; sha256: string; head: (string | number)[]; f32?: string; libm?: { log: [number, number][]; sincos: [number, number, number][] } }
interface RngCase { name: string; seed: string; global: boolean; calls: Call[]; outputs: Out[] }
interface RngFile extends Omit<FxFile, 'cases'> { cases: RngCase[]; seeds: number[]; head: number }

const FX = loadFixtures<FxFile & RngFile>('rng') as unknown as RngFile
const CASES = FX.cases
const rng = rngCore()

const bytesOf = (a: ArrayBufferView) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
const numel = (shape: number[]) => shape.reduce((a, b) => a * b, 1)

/** One call replayed on `g`, in the fixture's recorded form. */
function replay(g: TorchGenerator, call: Call): { bytes: Uint8Array; head: (string | number)[]; f32?: Float32Array } {
  switch (call.op) {
    case 'raw': {
      const v = new BigUint64Array(call.n)
      for (let i = 0; i < call.n; i++) v[i] = g.random64()
      return { bytes: bytesOf(v), head: [...v.subarray(0, FX.head)].map(String) }
    }
    case 'randperm': {
      const p = g.randperm(call.n)
      const v = BigInt64Array.from(p, x => BigInt(x))
      return { bytes: bytesOf(v), head: [...p.subarray(0, FX.head)] }
    }
    case 'rand': {
      const v = g.rand(numel(call.shape))
      return { bytes: bytesOf(v), head: [...v.subarray(0, FX.head)] }
    }
    case 'randn': {
      const v = g.randn(numel(call.shape))
      return { bytes: bytesOf(v), head: [...v.subarray(0, FX.head)], f32: v }
    }
  }
}

function seeded(c: RngCase): TorchGenerator {
  const g = rng.generator()
  g.seed(BigInt(c.seed))
  return g
}

/** The float32 bit pattern as a signed integer ordered like the floats (ulp distance = difference). */
const ordered = (() => {
  const f = new Float32Array(1)
  const u = new Int32Array(f.buffer)
  return (x: number) => { f[0] = x; const b = u[0]!; return b < 0 ? -2147483648 - b : b }
})()

describe('the rng fixture', () => {
  it('was written by torch 2.10 at its default thread count', () => {
    expect(FX.torch).toMatch(/^2\.10\./)
    expect(FX.threads).toBeGreaterThan(1)
    expect(FX.seeds).toEqual([0, 1, 42, 123456789, 2 ** 31 - 1])
  })

  it('covers every case the brief names', () => {
    expect(CASES.length).toBe(133)
    const names = CASES.map(c => c.name)
    for (const s of FX.seeds) {
      expect(names).toContain(`raw 10000 draws, seed ${s}`)
      for (const n of [1, 7, 15, 16, 17, 100, 10000]) expect(names).toContain(`rand(${n}), seed ${s}`)
      for (const n of [1, 2, 15, 16, 17, 31, 33, 10000]) expect(names).toContain(`randn(${n}), seed ${s}`)
      for (const n of [2, 10, 9216]) expect(names).toContain(`randperm(${n}), seed ${s}`)
      expect(names).toContain(`rand(1) × 50, seed ${s}`)
      expect(names.filter(n => n.startsWith('Voronoi') && n.endsWith(`seed ${s}`))).toHaveLength(3)
      expect(names).toContain(`rand → randn(15) → randn(16) → rand → randn(1) → randn(2), seed ${s}`)
    }
    expect(names.filter(n => n.startsWith('FilmGrain'))).toHaveLength(7)
    expect(names).toContain('randn(256), seed 1719 (a logf miss)')
    expect(names).toContain('rand(16), seed 2^64 − 1')
    expect(names).toContain('rand(16), seed −2^63')
  })
})

describe('mt19937, rand and randperm: torch’s bytes exactly', () => {
  for (const c of CASES) {
    if (c.calls.some(k => k.op === 'randn')) continue
    it(c.name, () => {
      const g = seeded(c)
      c.calls.forEach((call, i) => {
        const want = c.outputs[i]!
        const got = replay(g, call)
        expect(got.head, `call ${i}`).toEqual(want.head)
        expect(sha256(got.bytes), `call ${i}`).toBe(want.sha256)
      })
    })
  }

  it('random() is one mt19937 draw: 10 000 draws per seed are the raw cases’ words, high word first', () => {
    for (const c of CASES.filter(k => k.name.startsWith('raw '))) {
      const g = seeded(c)
      const v = new BigUint64Array(5000)
      for (let i = 0; i < 5000; i++) {
        const hi = g.random()
        const lo = g.random()
        expect(hi >>> 0).toBe(hi)
        v[i] = (BigInt(hi) << 32n) | BigInt(lo)
      }
      expect(sha256(bytesOf(v)), c.name).toBe(c.outputs[0]!.sha256)
    }
  })

  it('seed keeps only the low 32 bits; a second seed starts over', () => {
    const a = rng.generator()
    a.seed(2n ** 40n + 42n)
    const b = rng.generator()
    b.seed(7)
    b.rand(100)
    b.seed(42)
    expect([...a.rand(700)]).toEqual([...b.rand(700)])
  })

  it('refuses a randperm at randperm_cpu’s small-n bound, uint32 max / 20 = 214 748 364, before allocating', () => {
    expect(Math.floor(0xFFFFFFFF / 20)).toBe(214748364)
    const g = rng.generator()
    expect(() => g.randperm(214748364)).toThrow('randperm is only ported for n below 2³² / 20')
    expect(() => g.randperm(2 ** 40)).toThrow('randperm is only ported for n below 2³² / 20')
    expect(() => g.randperm(2.5)).toThrow('randperm needs a whole number of at least 0')
    // The refusal drew nothing: the generator is where a fresh one is.
    const fresh = rng.generator()
    expect([...g.rand(5)]).toEqual([...fresh.rand(5)])
  })

  it('seed takes what torch.Generator.manual_seed takes, [−2⁶³, 2⁶⁴ − 1], and refuses the rest plainly', () => {
    const g = rng.generator()
    // The edges are fixture cases (torch's own streams); here, one past each edge.
    expect(() => g.seed(2n ** 64n)).toThrow('A random seed must lie between −2⁶³ and 2⁶⁴ − 1, as torch accepts')
    expect(() => g.seed(-(2n ** 63n) - 1n)).toThrow('A random seed must lie between −2⁶³ and 2⁶⁴ − 1, as torch accepts')
    expect(() => g.seed(2n ** 64n - 1n)).not.toThrow()
    expect(() => g.seed(-(2n ** 63n))).not.toThrow()
    // A JS number past 2⁵³ has lost its low bits already (2⁶⁴ − 1 as a double is 2⁶⁴).
    expect(() => g.seed(Number.MAX_SAFE_INTEGER + 1)).toThrow('A random seed must be a whole number no larger than 2⁵³; pass a bigint for larger seeds')
    expect(() => g.seed(2 ** 64 - 1)).toThrow('A random seed must be a whole number no larger than 2⁵³; pass a bigint for larger seeds')
    expect(() => g.seed(1.5)).toThrow('A random seed must be a whole number no larger than 2⁵³; pass a bigint for larger seeds')
    expect(() => g.seed(Number.NaN)).toThrow('A random seed must be a whole number no larger than 2⁵³; pass a bigint for larger seeds')
    expect(() => g.seed(Number.MAX_SAFE_INTEGER)).not.toThrow()
    expect(() => g.seed(-Number.MAX_SAFE_INTEGER)).not.toThrow()
    // A negative number seeds as its two's complement, as torch's −1 is 2⁶⁴ − 1.
    const a = rng.generator(); a.seed(-1)
    const b = rng.generator(); b.seed(2n ** 64n - 1n)
    expect([...a.rand(50)]).toEqual([...b.rand(50)])
  })
})

// ── randn: bit-exact but where this Mac's libm isn't correctly rounded ───────
//
// torch's normal_fill_16 calls libm's logf and, fused by the compiler,
// __sincosf_stret. The port computes the correctly rounded float of each (V8's
// double function rounded). The fixture records every argument where libm's
// float differs from that (scripts/runner_effects_fixtures.py
// normal_fill_libm, which replays normal_fill with libm and checks torch's
// bytes). Here: libm is one ulp off on each of those; normal_fill replayed
// with libm's values gives torch's bytes; and the port differs from torch only
// on the draws those arguments feed — by one ulp of sin / cos, which the
// product with the radius can make two ulps of the draw.

const f32bits = (() => {
  const f = new Float32Array(1)
  const u = new Uint32Array(f.buffer)
  return { of: (x: number) => { f[0] = x; return u[0]! }, from: (b: number) => { u[0] = b; return f[0]! } }
})()

/** normal_fill (n ≥ 16) replayed from uniforms `u` with libm's values where recorded, else correctly rounded. */
function normalFillWith(u: Float32Array, n: number, libm: NonNullable<Out['libm']>): { d: Float32Array; hit: Set<number> } {
  const f = Math.fround
  const logs = new Map(libm.log.map(([a, r]) => [a, r]))
  const trig = new Map(libm.sincos.map(([a, c, s]) => [a, [c, s] as const]))
  const d = u.slice(0, n)
  const hit = new Set<number>()
  const fill16 = (o: number) => {
    for (let j = 0; j < 8; j++) {
      const u1 = f(1 - d[o + j]!)
      const lb = logs.get(f32bits.of(u1))
      const lg = lb === undefined ? f(Math.log(u1)) : f32bits.from(lb)
      const radius = f(Math.sqrt(f(-2 * lg)))
      const theta = f(2 * Math.PI * d[o + j + 8]!)
      const tb = trig.get(f32bits.of(theta))
      const c = tb ? f32bits.from(tb[0]) : f(Math.cos(theta))
      const s = tb ? f32bits.from(tb[1]) : f(Math.sin(theta))
      if (lb !== undefined || tb) { hit.add(o + j); hit.add(o + j + 8) }
      else { hit.delete(o + j); hit.delete(o + j + 8) }
      d[o + j] = f(radius * c) + 0
      d[o + j + 8] = f(radius * s) + 0
    }
  }
  for (let i = 0; i < n - 15; i += 16) fill16(i)
  if (n % 16 !== 0) {
    d.set(u.subarray(n, n + 16), n - 16)
    fill16(n - 16)
  }
  return { d, hit }
}

interface Tally { draws: number; off: number; offBy2: number; libmLog: number; libmSincos: number; report: string[] }

/** One randn case replayed and checked draw by draw; its tally (self-contained, so any test can sum them). */
function checkRandnCase(c: RngCase): Tally {
  const t: Tally = { draws: 0, off: 0, offBy2: 0, libmLog: 0, libmSincos: 0, report: [] }
  const g = seeded(c)
  c.calls.forEach((call, i) => {
    const want = c.outputs[i]!
    const got = replay(g, call)
    if (call.op !== 'randn') {
      expect(sha256(got.bytes), `call ${i}`).toBe(want.sha256)
      return
    }
    const py = new Float32Array(b64(want.f32!).slice().buffer)
    const n = py.length
    expect(got.f32!.length).toBe(n)
    let hit = new Set<number>()
    if (n >= 16) {
      // The uniforms normal_fill drew: the same generator, the calls before, then rand.
      const g2 = seeded(c)
      for (const k of c.calls.slice(0, i)) replay(g2, k)
      const u = g2.rand(n + (n % 16 ? 16 : 0))
      const libm = want.libm!
      t.libmLog += libm.log.length
      t.libmSincos += libm.sincos.length
      for (const [a, r] of libm.log) expect(Math.abs(ordered(f32bits.from(r)) - ordered(Math.fround(Math.log(f32bits.from(a))))), `libm logf(${f32bits.from(a)})`).toBe(1)
      for (const [a, cb, sb] of libm.sincos) {
        const th = f32bits.from(a)
        const dc = Math.abs(ordered(f32bits.from(cb)) - ordered(Math.fround(Math.cos(th))))
        const ds = Math.abs(ordered(f32bits.from(sb)) - ordered(Math.fround(Math.sin(th))))
        expect(Math.max(dc, ds), `libm sincosf(${th})`).toBe(1)
      }
      const r = normalFillWith(u, n, libm)
      expect(sha256(bytesOf(r.d)), `call ${i}: normal_fill with libm's values is torch`).toBe(want.sha256)
      hit = r.hit
    }
    for (let j = 0; j < n; j++) {
      t.draws++
      const d = Math.abs(ordered(got.f32![j]!) - ordered(py[j]!))
      if (d === 0) continue
      t.off++
      if (d === 2) t.offBy2++
      t.report.push(`${c.name} call ${i} [${j}]: torch ${py[j]} port ${got.f32![j]} (${d} ulp)`)
      expect(hit.has(j), `${c.name} call ${i} [${j}] differs where libm is correctly rounded`).toBe(true)
      expect(d, `${c.name} call ${i} [${j}]`).toBeLessThanOrEqual(2)
    }
  })
  return t
}

const RANDN_CASES = CASES.filter(c => c.calls.some(k => k.op === 'randn'))

describe('randn: torch’s float32 bit for bit, but where libm is one ulp off', () => {
  for (const c of RANDN_CASES) it(c.name, () => { checkRandnCase(c) })

  it('is bit-exact on at least 99.9% of the draws, over every randn case', () => {
    // Summed here, from every case, so the totals don't depend on which tests ran (-t, .only).
    const sum: Tally = { draws: 0, off: 0, offBy2: 0, libmLog: 0, libmSincos: 0, report: [] }
    for (const c of RANDN_CASES) {
      const t = checkRandnCase(c)
      sum.draws += t.draws; sum.off += t.off; sum.offBy2 += t.offBy2
      sum.libmLog += t.libmLog; sum.libmSincos += t.libmSincos
      sum.report.push(...t.report)
    }
    if (process.env.RNG_REPORT) {
      writeFileSync(process.env.RNG_REPORT, `${sum.off} of ${sum.draws} randn draws differ (${sum.offBy2} by two ulps); libm off on ${sum.libmLog} logf and ${sum.libmSincos} sincosf arguments\n${sum.report.join('\n')}\n`)
    }
    expect(sum.draws).toBeGreaterThan(100_000)
    expect(sum.off / sum.draws).toBeLessThan(0.001)
    // Both halves of the libm proof run on real data: at least one logf miss and one sincosf miss.
    expect(sum.libmLog).toBeGreaterThan(0)
    expect(sum.libmSincos).toBeGreaterThan(0)
    // Measured on this Mac (torch 2.10, arm64): pinned so a change shows.
    expect({ off: sum.off, offBy2: sum.offBy2, libmLog: sum.libmLog, libmSincos: sum.libmSincos }).toEqual(RANDN_MEASURED)
  })
})

/** randn draws that differ from torch (and by two ulps), and the libm arguments recorded per call, on this fixture (see RNG_REPORT). */
const RANDN_MEASURED = { off: 29, offBy2: 1, libmLog: 1, libmSincos: 35 }

// ── The esbuild guard: the core built as Nitro builds server code ────────────

describe('esbuild guard: the rng core survives Nitro’s build', () => {
  const require = createRequire(import.meta.url)
  const pnpm = fileURLToPath(new URL('../../node_modules/.pnpm/', import.meta.url))
  const builds = readdirSync(pnpm).filter(d => /^esbuild@\d/.test(d)).map(d => join(pnpm, d, 'node_modules', 'esbuild'))
  const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../../server/runner/${rel}`, import.meta.url)), 'utf8')
  const dir = mkdtempSync(join(tmpdir(), 'rng-esbuild-'))
  const reference = (() => {
    const g = rng.generator()
    g.seed(42)
    const u = g.rand(20)
    const n = g.randn(33)
    const s = g.randn(3)
    const p = g.randperm(50)
    return sha256(new Uint8Array([...bytesOf(u), ...bytesOf(n), ...bytesOf(s), ...bytesOf(p)]))
  })()
  const probeOf = (r: ReturnType<typeof rngCore>) => {
    const g = r.generator()
    g.seed(42)
    const u = g.rand(20)
    const n = g.randn(33)
    const s = g.randn(3)
    const p = g.randperm(50)
    return new Uint8Array([...new Uint8Array(u.buffer), ...new Uint8Array(n.buffer), ...new Uint8Array(s.buffer), ...new Uint8Array(p.buffer)])
  }

  it('finds an esbuild to build with', () => {
    expect(builds.length).toBeGreaterThan(0)
  })

  for (const esbuildDir of builds) {
    for (const minify of [false, true]) {
      it(`${esbuildDir.split('/').at(-3)} target es2019, minify ${minify}: the source-text core draws the same, in a Worker too`, async () => {
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
        const rngM = await build('effects/core/rng.ts', 'rng')
        // Rebuilt from its own source text, with nothing in scope.
        const built = new Function(`return (${rngM.rngCore!.toString()})()`)() as ReturnType<typeof rngCore>
        expect(sha256(probeOf(built))).toBe(reference)
        // And in the worker's own script: a probe op that fills the picture's shape with rand.
        const probeCore = (r: ReturnType<typeof rngCore>) => ({
          fill: (inp: Record<string, Tensor>, p: Record<string, number>) => {
            const t = inp.image!
            const g = r.generator()
            g.seed(p.seed!)
            return { outputs: [{ c: t.c, h: t.h, w: t.w, data: g.rand(t.c * t.h * t.w) }], preview: null }
          },
        })
        const cores = [
          { name: 'tk', fn: tkM.tensorCore as never, args: ['px'] },
          { name: 'rng', fn: rngM.rngCore as never, args: [] },
          { name: 'probe', fn: probeCore as never, args: ['rng'] },
        ]
        const w = new Worker(workerScript(compositorCore, pxM.pixelsCore as never, cores), { eval: true, workerData: { stop: new SharedArrayBuffer(4) } })
        try {
          const reply = (m: Record<string, unknown>) => new Promise<any>((res) => { w.once('message', res); w.postMessage(m) })
          const px8 = new Uint8Array(7 * 5 * 4)
          const raw = { source: 'rgb', w: 7, h: 5, data: px8 }
          const g = rng.generator()
          g.seed(9)
          const want = effectCores.tk.quantize({ c: 3, h: 5, w: 7, data: g.rand(3 * 5 * 7) }, 'round')
          expect((await reply({ id: 1, op: 'fx.begin', cls: 'probe', fn: 'probe.fill', params: { seed: 9 }, count: 1 })).error).toBeUndefined()
          const r = await reply({ id: 2, op: 'fx.run', index: 0, inputs: { image: raw }, first: true, masks: [false], want: { round: [true], trunc: [false] } })
          expect(r.error).toBeUndefined()
          expect(Buffer.compare(r.value.outputs[0].round8, want)).toBe(0)
        }
        finally { await w.terminate() }
      }, 30_000)
    }
  }

  it('the worker composes it: rng is one of the effect cores', () => {
    expect(Object.keys(effectCores.rng)).toEqual(Object.keys(rngCore()))
  })
})
