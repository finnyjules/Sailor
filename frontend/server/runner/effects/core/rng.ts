/**
 * Torch's CPU random numbers (step 3, R2.3): the port the seeded looks (R2.9)
 * and Add noise use, proven on raw draws against torch 2.10
 * (scripts/runner_effects_fixtures.py --group rng;
 * tests/unit/runner-effects-rng.unit.spec.ts).
 *
 * SELF-CONTAINED: the compositor worker composes it from its source text
 * (compositor/worker.ts workerScript), so nothing from outside this body is
 * referenced, and there are no BigInt literals (Nitro builds for es2019).
 *
 * Which torch path each function follows (torch 2.10, CPU, float32, this
 * Mac's build: no AVX2 or VSX, so the plain `normal_fill`):
 *   seed      — CPUGeneratorImpl::set_current_seed: both cached normals
 *               cleared, then mt19937(seed): MT19937RNGEngine.h
 *               init_with_uint32 (the seed's low 32 bits; state[j] =
 *               1812433253 · (state[j−1] ^ state[j−1] >> 30) + j), left = 1.
 *   random    — CPUGeneratorImpl::random = mt19937_engine::operator(): a new
 *               state (next_state, the standard twist) every 624 draws, then
 *               the tempering.
 *   random64  — CPUGeneratorImpl::random64: two draws,
 *               make64BitsFrom32Bits(first, second) = first << 32 | second.
 *   rand      — uniform_kernel (native/cpu/DistributionTemplates.h):
 *               cpu_serial_kernel, one uniform_real_distribution<float> per
 *               element = (random() & (2²⁴ − 1)) · 2⁻²⁴ (TransformationHelper.h
 *               uniform_real, exact in float).
 *   randn     — normal_kernel (native/cpu/DistributionTemplates.h), mean 0,
 *               std 1:
 *               n ≥ 16 (contiguous float): normal_fill — every element a float
 *                 uniform first; then Box–Muller in float over each block of
 *                 16 (normal_fill_16: u1 = 1 − d[j], u2 = d[j + 8], radius =
 *                 sqrtf(−2 · logf(u1)), θ = float(2π·u2 in double), d[j] =
 *                 radius · cosf θ, d[j + 8] = radius · sinf θ); when n % 16 ≠ 0
 *                 the last 16 get 16 NEW uniforms and are computed again.
 *               n < 16: cpu_serial_kernel of normal_distribution<double>
 *                 (DistributionsHelper.h): the cached double normal if any,
 *                 else u1, u2 = uniform_real<double>(random64()) (53 bits ·
 *                 2⁻⁵³), r = sqrt(−2 · log1p(−u2)), θ = 2π · u1, cache r · sin θ,
 *                 return r · cos θ; the float is the double rounded.
 *               The float path never reads or writes the cached double normal.
 *               `· std + mean` turns −0 into +0, kept here as `+ 0`.
 *   randperm  — randperm_cpu (native/TensorFactories.cpp), its small-n path
 *               (n < 2³² / 20, which every picture size under the pixel caps
 *               is): 0 … n − 1, then for i < n − 1 swap i with
 *               i + random() % (n − i). Larger n takes a random64 path that is
 *               not ported: refused.
 *
 * Parity (R2 rule 10): random, random64, rand and randperm are EXACT. randn's
 * float log / sin / cos are this Mac's libm in torch (logf, and sinf / cosf
 * of one angle fused by the compiler into __sincosf_stret) and the correctly
 * rounded float here (V8's double function rounded). Bit-exact wherever libm
 * rounds correctly; where it doesn't (about 1 angle in 1,500 for sincosf; logf
 * never, on the fixture) one ulp of sin / cos, which the product with the
 * radius can make two ulps of the draw. The spec proves each differing draw
 * against the fixture's libm record. The looks built on randn are LIBRARY.
 */

export interface TorchGenerator {
  /** torch.Generator().manual_seed(seed): mt19937 initialised from the seed's low 32 bits; the cached normals cleared. */
  seed(seed: bigint | number): void
  random(): number // one 32-bit mt19937 draw (CPUGeneratorImpl::random)
  random64(): bigint // two draws, as make64BitsFrom32Bits
  /** torch.rand(n, dtype=float32): serial, one random() per element, (x & (2^24 − 1)) · 2^-24. */
  rand(n: number): Float32Array
  /** torch.randn(n, dtype=float32): n < 16 → normal_distribution<double> per element; n ≥ 16 → normal_fill. */
  randn(n: number): Float32Array
  /** torch.randperm(n): as randperm_cpu does for this n. */
  randperm(n: number): Int32Array
}

export function rngCore() {
  const N = 624
  const M = 397
  const f = Math.fround
  const TWO_POW_M24 = 1 / 16777216
  const TWO_POW_32 = 4294967296
  const TWO_POW_M53 = 1 / 9007199254740992
  // randperm_cpu's small-n bound: std::numeric_limits<uint32_t>::max() / 20.
  const RANDPERM_SMALL_N = Math.floor(0xFFFFFFFF / 20)

  function generator(): TorchGenerator {
    const mt = new Uint32Array(N)
    let left = 1
    let next = 0
    // CPUGeneratorImpl::next_double_normal_sample_ (normal_distribution<double>'s second sample).
    let cachedNormal: number | null = null

    const twist = (u: number, v: number) => ((((u & 0x80000000) | (v & 0x7FFFFFFF)) >>> 1) ^ (v & 1 ? 0x9908B0DF : 0)) >>> 0

    function nextState(): void {
      left = N
      next = 0
      let i = 0
      for (; i < N - M; i++) mt[i] = mt[i + M]! ^ twist(mt[i]!, mt[i + 1]!)
      for (; i < N - 1; i++) mt[i] = mt[i + M - N]! ^ twist(mt[i]!, mt[i + 1]!)
      mt[N - 1] = mt[M - 1]! ^ twist(mt[N - 1]!, mt[0]!)
    }

    function seed(s: bigint | number): void {
      const low = Number(BigInt.asUintN(32, BigInt(s)))
      mt[0] = low
      for (let j = 1; j < N; j++) {
        const p = mt[j - 1]!
        mt[j] = (Math.imul(1812433253, (p ^ (p >>> 30)) >>> 0) + j) >>> 0
      }
      left = 1
      next = 0
      cachedNormal = null
    }

    function random(): number {
      if (--left === 0) nextState()
      let y = mt[next++]!
      y ^= y >>> 11
      y ^= (y << 7) & 0x9D2C5680
      y ^= (y << 15) & 0xEFC60000
      y ^= y >>> 18
      return y >>> 0
    }

    function random64(): bigint {
      const hi = random()
      const lo = random()
      return (BigInt(hi) << BigInt(32)) | BigInt(lo)
    }

    /** uniform_real_distribution<float>(0, 1): 24 bits of one draw. */
    const uniformFloat = () => (random() & 0xFFFFFF) * TWO_POW_M24

    /** uniform_real_distribution<double>(0, 1): the low 53 bits of random64, exactly in a double. */
    function uniformDouble(): number {
      const hi = random()
      const lo = random()
      return ((hi & 0x1FFFFF) * TWO_POW_32 + lo) * TWO_POW_M53
    }

    function rand(n: number): Float32Array {
      const out = new Float32Array(n)
      for (let i = 0; i < n; i++) out[i] = uniformFloat()
      return out
    }

    /** normal_fill_16<float>, mean 0, std 1. */
    function fill16(d: Float32Array, o: number): void {
      for (let j = 0; j < 8; j++) {
        const u1 = f(1 - d[o + j]!)
        const u2 = d[o + j + 8]!
        const radius = f(Math.sqrt(f(-2 * f(Math.log(u1)))))
        const theta = f(2 * Math.PI * u2)
        d[o + j] = f(radius * f(Math.cos(theta))) + 0
        d[o + j + 8] = f(radius * f(Math.sin(theta))) + 0
      }
    }

    /** normal_distribution<double>(0, 1), one sample. */
    function normalDouble(): number {
      if (cachedNormal !== null) {
        const v = cachedNormal
        cachedNormal = null
        return v
      }
      const u1 = uniformDouble()
      const u2 = uniformDouble()
      const r = Math.sqrt(-2 * Math.log1p(-u2))
      const theta = 2 * Math.PI * u1
      cachedNormal = r * Math.sin(theta)
      return r * Math.cos(theta)
    }

    function randn(n: number): Float32Array {
      const d = new Float32Array(n)
      if (n < 16) {
        for (let i = 0; i < n; i++) d[i] = normalDouble() + 0
        return d
      }
      for (let i = 0; i < n; i++) d[i] = uniformFloat()
      for (let i = 0; i < n - 15; i += 16) fill16(d, i)
      if (n % 16 !== 0) {
        const o = n - 16
        for (let i = 0; i < 16; i++) d[o + i] = uniformFloat()
        fill16(d, o)
      }
      return d
    }

    function randperm(n: number): Int32Array {
      if (!Number.isInteger(n) || n < 0) throw new Error('randperm needs a whole number of at least 0')
      if (n >= RANDPERM_SMALL_N) throw new Error('randperm is only ported for n below 2³² / 20')
      const r = new Int32Array(n)
      for (let i = 0; i < n; i++) r[i] = i
      for (let i = 0; i < n - 1; i++) {
        const z = random() % (n - i)
        const sav = r[i]!
        r[i] = r[z + i]!
        r[z + i] = sav
      }
      return r
    }

    seed(67280421310721) // CPUGeneratorImpl's default seed (default_rng_seed_val)
    return { seed, random, random64, rand, randn, randperm }
  }

  return { generator }
}

export type RngCore = ReturnType<typeof rngCore>
