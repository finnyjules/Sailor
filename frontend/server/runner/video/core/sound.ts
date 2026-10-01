/**
 * The sound effects' arithmetic (step 3, R6.9), as comfy_extras/nodes_audio.py
 * and nodes_audio_effects.py compute it in torch float32 (a Python float
 * scalar meets a float32 tensor as float32, as torch's CPU kernels take it).
 * Self-contained: the compositor worker builds it from its source text (core
 * `sfx`, ../cores.ts), and the heavy ops run there (`sfx.run`, a sound per
 * call, its channels handed over); the same functions run in this thread for
 * tests and for the cheap steps (a slice, a gain worked out).
 *
 * A sound is its channels, each a Float32Array of the same length (Python's
 * [1, C, N]: the runner's sounds are one item).
 *
 * Exact (bit for bit): Adjust volume, Merge, Fade's `linear` and
 * `exponential` ramps (torch.linspace's own float32 steps, `linspace32`),
 * Normalize to a peak, the moving average's decisions aside, Silence cut's
 * ranges. Library (within a few float32 steps): the equalizer (sin, cos, exp
 * and sqrt of its coefficients, then its feedback loop), `equal_power`
 * (sin), Normalize to an RMS (torch's summation order), Duck (exp, log10
 * and pow).
 *
 * Silence cut's walk is FIXED, not copied (the user's matching rule 3):
 * Python restarts a loud run at the next loud sample after a short silence,
 * so every run followed by a short pause was dropped (with the default 300 ms,
 * the speech before each breath). Here the short silence is absorbed and the
 * run keeps its start, as the node's own comment says it should.
 */

export interface SoundOpResult { channels?: Float32Array[]; ranges?: number[]; handedOn?: true; current?: number }

export function soundCore() {
  const f = Math.fround
  const stopped = (isStopped: (() => boolean) | undefined, i: number) => {
    if ((i & 0xffff) === 0 && isStopped && isStopped()) throw new Error('Stopped')
  }

  /** Python's round() of a float: halves to even. */
  function pyRound(x: number): number {
    const r = Math.round(x)
    return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r
  }

  /**
   * torch.linspace(a, b, n) in float32 on the CPU: the step in float32
   * ((b − a) / (n − 1)), each value one rounding of a + step·i in the first
   * half and of b − step·(n − 1 − i) in the second (checked against torch
   * 2.x, the fixture's `linspace`).
   */
  function linspace32(a: number, b: number, n: number): Float32Array {
    const out = new Float32Array(Math.max(0, n))
    if (n <= 0) return out
    const a32 = f(a)
    const b32 = f(b)
    if (n === 1) { out[0] = a32; return out }
    const step = f(f(b32 - a32) / f(n - 1))
    const half = Math.floor(n / 2)
    for (let i = 0; i < n; i++) out[i] = i < half ? a32 + step * i : b32 - step * (n - 1 - i)
    return out
  }

  /** Every channel times a float32 gain (Adjust volume, Normalize). */
  function gain(chs: Float32Array[], p: { gain: number }, isStopped?: () => boolean): SoundOpResult {
    const g = f(p.gain)
    const channels = chs.map((x) => {
      const y = new Float32Array(x.length)
      for (let i = 0; i < x.length; i++) { stopped(isStopped, i); y[i] = x[i]! * g }
      return y
    })
    return { channels }
  }

  /**
   * Audio merge (nodes_audio.py:670-728) of two sounds at one rate, the
   * second already its length: `chs` holds the first's channels then the
   * second's (`split`: the first's count). torch broadcasts one channel
   * against several. Then divided by the largest magnitude when it passes 1.
   */
  function merge(chs: Float32Array[], p: { split: number; method: string }, isStopped?: () => boolean): SoundOpResult {
    const a = chs.slice(0, p.split)
    const b = chs.slice(p.split)
    const C = Math.max(a.length, b.length)
    const n = a[0]?.length ?? 0
    const out: Float32Array[] = []
    let peak = 0
    for (let c = 0; c < C; c++) {
      const x = a[a.length === 1 ? 0 : c]!
      const y = b[b.length === 1 ? 0 : c]!
      const w = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        stopped(isStopped, i)
        const u = x[i]!
        const v = y[i]!
        const r = p.method === 'add' ? u + v : p.method === 'subtract' ? u - v : p.method === 'multiply' ? u * v : f(u + v) / 2
        w[i] = r
        const m = Math.abs(w[i]!)
        if (m > peak) peak = m
      }
      out.push(w)
    }
    if (peak > 1) for (const w of out) for (let i = 0; i < w.length; i++) w[i] = w[i]! / peak
    return { channels: out }
  }

  /** Audio fade's ramp (nodes_audio_effects.py:58-69). */
  function ramp(len: number, rising: boolean, curve: string): Float32Array {
    const t = linspace32(0, 1, len)
    if (!rising) for (let i = 0; i < len; i++) t[i] = 1 - t[i]!
    if (curve === 'linear') return t
    if (curve === 'equal_power') {
      const k = f(Math.PI / 2)
      for (let i = 0; i < len; i++) t[i] = Math.sin(f(t[i]! * k))
      return t
    }
    for (let i = 0; i < len; i++) t[i] = t[i]! * t[i]!
    return t
  }

  /** Audio fade (:48-77): one envelope, ones with the ramps multiplied in, times every channel. `nIn`, `nOut`: already min(round(s·rate), N). */
  function fade(chs: Float32Array[], p: { nIn: number; nOut: number; curve: string }, isStopped?: () => boolean): SoundOpResult {
    const n = chs[0]?.length ?? 0
    const env = new Float32Array(n).fill(1)
    if (p.nIn > 0) {
      const r = ramp(p.nIn, true, p.curve)
      for (let i = 0; i < p.nIn; i++) env[i] = env[i]! * r[i]!
    }
    if (p.nOut > 0) {
      const r = ramp(p.nOut, false, p.curve)
      for (let i = 0; i < p.nOut; i++) env[n - p.nOut + i] = env[n - p.nOut + i]! * r[i]!
    }
    const channels = chs.map((x) => {
      const y = new Float32Array(n)
      for (let i = 0; i < n; i++) { stopped(isStopped, i); y[i] = x[i]! * env[i]! }
      return y
    })
    return { channels }
  }

  /**
   * Audio normalize (:104-119): the peak (`abs().max()`) or the RMS
   * (`pow(2).mean().sqrt()`, summed here in double: within a float32 step or
   * two of torch's order); ≤ 1e-9 hands the sound on; else × f32(10^(dB/20) / current).
   */
  function normalize(chs: Float32Array[], p: { mode: string; target_db: number }, isStopped?: () => boolean): SoundOpResult {
    let current = 0
    let count = 0
    if (p.mode === 'peak') {
      for (const x of chs) for (let i = 0; i < x.length; i++) { const m = Math.abs(x[i]!); if (m > current) current = m }
    }
    else {
      let sum = 0
      for (const x of chs) {
        for (let i = 0; i < x.length; i++) { stopped(isStopped, i); sum += f(x[i]! * x[i]!) }
        count += x.length
      }
      current = count ? f(Math.sqrt(f(sum / count))) : 0
    }
    if (current <= 1e-9) return { handedOn: true, current }
    return { ...gain(chs, { gain: 10 ** (p.target_db / 20) / current }, isStopped), current }
  }

  // ── The 3-band equalizer: torchaudio 2.10's biquads and lfilter ─────────────

  /** A biquad's [b0, b1, b2, a0, a1, a2] as torchaudio designs it in float32 (filtering.py). */
  function biquadOf(kind: 'bass' | 'eq' | 'treble', rate: number, freq: number, gainDb: number, q: number): number[] {
    const cf = f(freq)
    const Q = f(q)
    const g = f(gainDb)
    const w0 = f(f(f(2 * Math.PI) * cf) / f(rate))
    const alpha = f(f(f(Math.sin(w0)) / 2) / Q)
    const A = f(Math.exp(f(f(g / 40) * f(Math.log(10)))))
    const cosw = f(Math.cos(w0))
    if (kind === 'eq') {
      const aA = f(alpha * A)
      const adA = f(alpha / A)
      const m2c = f(-2 * cosw)
      return [f(1 + aA), m2c, f(1 - aA), f(1 + adA), m2c, f(1 - adA)]
    }
    const temp1 = f(f(2 * f(Math.sqrt(A))) * alpha)
    const temp2 = f(f(A - 1) * cosw)
    const temp3 = f(f(A + 1) * cosw)
    const Ap1 = f(A + 1)
    const Am1 = f(A - 1)
    if (kind === 'bass') {
      const b0 = f(A * f(f(Ap1 - temp2) + temp1))
      const b1 = f(f(2 * A) * f(Am1 - temp3))
      const b2 = f(A * f(f(Ap1 - temp2) - temp1))
      const a0 = f(f(Ap1 + temp2) + temp1)
      const a1 = f(-2 * f(Am1 + temp3))
      const a2 = f(f(Ap1 + temp2) - temp1)
      // bass_biquad hands biquad its coefficients divided by a0 already.
      return [f(b0 / a0), f(b1 / a0), f(b2 / a0), f(a0 / a0), f(a1 / a0), f(a2 / a0)]
    }
    const b0 = f(A * f(f(Ap1 + temp2) + temp1))
    const b1 = f(f(-2 * A) * f(Am1 + temp3))
    const b2 = f(A * f(f(Ap1 + temp2) - temp1))
    const a0 = f(f(Ap1 - temp2) + temp1)
    const a1 = f(2 * f(Am1 - temp3))
    const a2 = f(f(Ap1 - temp2) - temp1)
    return [b0, b1, b2, a0, a1, a2]
  }

  /**
   * lfilter (clamp on): the coefficients divided by a0, the forward part
   * (conv1d of the 3 taps), the feedback loop (_lfilter_core_loop: y[n] =
   * x[n] − y[n−2]·a2 − y[n−1]·a1), each step float32; then clamped to ±1.
   */
  function lfilter(x: Float32Array, c: number[], isStopped?: () => boolean): Float32Array {
    const a0 = c[3]!
    const b0 = f(c[0]! / a0)
    const b1 = f(c[1]! / a0)
    const b2 = f(c[2]! / a0)
    const a1 = f(c[4]! / a0)
    const a2 = f(c[5]! / a0)
    const n = x.length
    const y = new Float32Array(n)
    let x1 = 0
    let x2 = 0
    let y1 = 0
    let y2 = 0
    for (let i = 0; i < n; i++) {
      stopped(isStopped, i)
      const x0 = x[i]!
      // conv1d's sum (torch's BLAS; its order is opaque: this one agrees with it most often).
      const fir = f(f(f(b2 * x2) + f(b0 * x0)) + f(b1 * x1))
      // The loop's `o0 -= y·a` compiled as fused multiply-adds (one rounding each): measured exact against torchaudio.
      const o = f(f(fir - y2 * a2) - y1 * a1)
      y[i] = o
      x2 = x1; x1 = x0
      y2 = y1; y1 = o
    }
    for (let i = 0; i < n; i++) y[i] = y[i]! < -1 ? -1 : y[i]! > 1 ? 1 : y[i]!
    return y
  }

  /** The 3-band equalizer (nodes_audio.py:851-871): each band only when its gain isn't 0, in order, every channel. */
  function eq(chs: Float32Array[], p: Record<string, number>, isStopped?: () => boolean): SoundOpResult {
    const bands: number[][] = []
    if (p.low_gain_dB !== 0) bands.push(biquadOf('bass', p.rate!, p.low_freq!, p.low_gain_dB!, 0.707))
    if (p.mid_gain_dB !== 0) bands.push(biquadOf('eq', p.rate!, p.mid_freq!, p.mid_gain_dB!, p.mid_q!))
    if (p.high_gain_dB !== 0) bands.push(biquadOf('treble', p.rate!, p.high_freq!, p.high_gain_dB!, 0.707))
    const channels = chs.map((x) => {
      let y: Float32Array = x.slice()
      for (const c of bands) y = lfilter(y, c, isStopped)
      return y
    })
    return { channels }
  }

  // ── Duck and Silence cut ────────────────────────────────────────────────────

  /** The mean of |x| over the channels, per sample (torch's mean over batch and channels). */
  function meanAbs(chs: Float32Array[], isStopped?: () => boolean): Float32Array {
    const n = chs[0]?.length ?? 0
    const out = new Float32Array(n)
    const C = chs.length
    for (let i = 0; i < n; i++) {
      stopped(isStopped, i)
      let s = 0
      for (let c = 0; c < C; c++) s = f(s + Math.abs(chs[c]![i]!))
      out[i] = C === 1 ? s : s / C
    }
    return out
  }

  /** 20·log10(clamp(x, 1e-9)) in float32. */
  const db = (x: number) => f(20 * f(Math.log10(x < f(1e-9) ? f(1e-9) : x)))

  /**
   * Audio duck (nodes_audio_effects.py:157-210): `chs` the sound's channels
   * then the sidechain's (`split`: the sound's count). The sidechain moved to
   * the sound's rate by nearest sample, its envelope the mean of |x|, padded
   * or cut to the sound; a one-pole follower in doubles; the gain in float32.
   */
  function duck(chs: Float32Array[], p: { split: number; rate: number; sideRate: number; threshold_db: number; depth_db: number; attack_ms: number; release_ms: number }, isStopped?: () => boolean): SoundOpResult {
    const sound = chs.slice(0, p.split)
    let side = chs.slice(p.split)
    const L = side[0]?.length ?? 0
    if (p.sideRate !== p.rate && side.length * L > 0) {
      const nT = pyRound((L * p.rate) / p.sideRate)
      const at = linspace32(0, L - 1, nT)
      const idx = new Int32Array(nT)
      for (let i = 0; i < nT; i++) idx[i] = pyRound(at[i]!)
      side = side.map((x) => {
        const y = new Float32Array(nT)
        for (let i = 0; i < nT; i++) y[i] = x[idx[i]!]!
        return y
      })
    }
    const mono = side.length ? meanAbs(side, isStopped) : new Float32Array(0)
    const n = sound[0]?.length ?? 0
    const aA = f(Math.exp(f(-1 / Math.max((p.attack_ms / 1000) * p.rate, 1))))
    const aR = f(Math.exp(f(-1 / Math.max((p.release_ms / 1000) * p.rate, 1))))
    const thr = f(p.threshold_db)
    const span = f(Math.max(-p.threshold_db, 1e-6))
    const depth = f(p.depth_db)
    const g = new Float32Array(n)
    let prev = 0
    for (let i = 0; i < n; i++) {
      stopped(isStopped, i)
      const x = i < mono.length ? mono[i]! : 0
      const a = x > prev ? aA : aR
      prev = a * prev + (1 - a) * x
      let over = f(db(f(prev)) - thr)
      if (!(over >= 0)) over = over < 0 ? 0 : over
      let amount = f(over / span)
      if (amount > 1) amount = 1
      g[i] = f(10 ** f(f(amount * depth) / 20))
    }
    const channels = sound.map((x) => {
      const y = new Float32Array(n)
      for (let i = 0; i < n; i++) y[i] = x[i]! * g[i]!
      return y
    })
    return { channels }
  }

  /**
   * Silence cut's loud mask (:233-245): the mean of |x| over the channels,
   * its 20 ms moving average (conv1d with zero padding `win // 2`: the
   * products in float32, summed here in double, a window at a time), and
   * 20·log10 of it above the threshold.
   */
  function loudMask(chs: Float32Array[], p: { rate: number; threshold_db: number }, isStopped?: () => boolean): Uint8Array {
    const mono = meanAbs(chs, isStopped)
    const N = mono.length
    const win = Math.max(Math.trunc(p.rate * 0.020), 1)
    const thr = f(p.threshold_db)
    const mask = new Uint8Array(N)
    if (win <= 1) {
      for (let i = 0; i < N; i++) mask[i] = db(mono[i]!) > thr ? 1 : 0
      return mask
    }
    const k = f(1 / win)
    const prod = new Float32Array(N)
    for (let i = 0; i < N; i++) prod[i] = mono[i]! * k
    const h = Math.floor(win / 2)
    // Output k reads samples [k − h, k − h + win): a running sum, redone from scratch every 4096 outputs.
    let sum = 0
    for (let i = 0; i < N; i++) {
      stopped(isStopped, i)
      const lo = i - h
      const hi = lo + win
      if (i % 4096 === 0) {
        sum = 0
        for (let t = Math.max(0, lo); t < Math.min(N, hi); t++) sum += prod[t]!
      }
      else {
        if (lo - 1 >= 0 && lo - 1 < N) sum -= prod[lo - 1]!
        if (hi - 1 >= 0 && hi - 1 < N) sum += prod[hi - 1]!
      }
      mask[i] = db(f(Math.max(0, sum))) > thr ? 1 : 0
    }
    return mask
  }

  /**
   * Silence cut's ranges [s, e) of samples to keep, merged, flat: each loud
   * run, short silences (under `min_silence_ms`) absorbed with the run's start
   * kept (the fix), padded by `keep_padding_ms` each side. None: nothing loud.
   */
  function silence(chs: Float32Array[], p: { rate: number; threshold_db: number; min_silence_ms: number; keep_padding_ms: number }, isStopped?: () => boolean): SoundOpResult {
    const mask = loudMask(chs, p, isStopped)
    return { ranges: keepRanges(mask, Math.trunc((p.rate * p.min_silence_ms) / 1000), Math.trunc((p.rate * p.keep_padding_ms) / 1000)) }
  }

  /** The walk over a loud mask (fixed: a short silence is absorbed into the run, which keeps its start), then the merge. */
  function keepRanges(mask: Uint8Array, minSilent: number, pad: number): number[] {
    const n = mask.length
    const keep: number[] = []
    let i = 0
    while (i < n) {
      if (!mask[i]) { i++; continue }
      const start = i
      for (;;) {
        while (i < n && mask[i]) i++
        let j = i
        while (j < n && !mask[j] && j - i < minSilent) j++
        if (j < n && mask[j]) { i = j; continue }
        break
      }
      const s = Math.max(0, start - pad)
      const e = Math.min(n, i + pad)
      const last = keep.length - 1
      if (last > 0 && s <= keep[last]!) keep[last] = Math.max(keep[last]!, e)
      else keep.push(s, e)
    }
    return keep
  }

  return { pyRound, linspace32, gain, merge, fade, normalize, biquadOf, lfilter, eq, meanAbs, duck, loudMask, keepRanges, silence }
}

export type SoundCore = ReturnType<typeof soundCore>
