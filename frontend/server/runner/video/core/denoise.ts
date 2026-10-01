/**
 * Audio denoise's spectral gating (step 3, R6.10, family `sound-denoise`):
 * noisereduce 3.0.3's two methods as comfy_extras/nodes_audio_denoise.py
 * calls them (`reduce_noise(y, sr, stationary, prop_decrease = strength)`,
 * every other setting at its default), on R6.5's shared float64 FFT.
 *
 * SELF-CONTAINED, as the other cores are: the compositor worker composes it
 * from its source text (../cores.ts, `dn`, with `ft`), and tests call the
 * same code in this thread. Do not reference anything from outside the
 * function's body.
 *
 * By the user's matching rule this is a "looks (sounds) the same" port,
 * judged by ear and a loose signal-to-noise figure, not last-bit parity:
 *   - the STFT is scipy's (`nperseg 1024`, `noverlap 768`, a periodic Hann
 *     window, `boundary='zeros'`, `padded=False`, scaled by the window's
 *     sum) and its inverse the matching overlap-add, all in doubles (Python
 *     takes the noise profile's STFT in single precision; here it is double);
 *   - the mask's smoothing (`fftconvolve(..., 'same')` with the outer
 *     product of two triangles) is done as the two 1-D passes it factors
 *     into, with zeros past the edges;
 *   - the non-stationary method's `filtfilt([b], [1, b − 1], padtype=None)`
 *     is the first-order filter run forward then backward from scipy's
 *     `lfilter_zi` start states.
 *
 * Python's bug FIXED, not copied (rule 3): the non-stationary method divides
 * by the smoothed level, so a stretch of exact digital silence (a whole sound
 * of it, or a whole chunk) is 0 / 0 and Python's output is NaN everywhere
 * the smoothing reaches. Here a bin with no level counts as fully below the
 * noise (its mask ~0): silence stays silence.
 *
 * Chunks (spectralgate/base.py): a sound is cut into 600,000-sample chunks
 * (one, when it is no longer), each read with 30,000 samples either side
 * (zeros past the ends), filtered on its own and its middle kept. One chunk
 * is one worker call (`chunk`); the stationary noise profile (`profile`) is
 * one call before them.
 */
import type { FftCore } from './fft'

export interface DenoiseResult { channels?: Float32Array[]; thresh?: Float64Array }

export function denoiseCore(ft: FftCore) {
  const N_FFT = 1024
  const HOP = 256
  const BINS = N_FFT / 2 + 1
  const CHUNK = 600000
  const PAD = 30000
  const N_STD = 1.5
  const TIME_CONSTANT_S = 2
  const THRESH_MULT = 2
  const SLOPE = 10
  const TOP_DB = 80
  const EPS = 2.220446049250313e-16

  // scipy.signal.get_window('hann', 1024): periodic.
  const win = new Float64Array(N_FFT)
  for (let i = 0; i < N_FFT; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT)
  let winSum = 0
  for (let i = 0; i < N_FFT; i++) winSum += win[i]!

  const stopped = (isStopped?: () => boolean) => {
    if (isStopped && isStopped()) throw new Error('Stopped')
  }

  /**
   * base.py's smoothing filter's two triangles (its outer product, divided by
   * its sum, is the product of each divided by its own sum), or a raise where
   * the rate leaves either under one step: 'low' or 'high'.
   */
  function smoothingOf(rate: number): { f: Float64Array; t: Float64Array } | 'low' | 'high' {
    const nf = Math.trunc(500 / (rate / (N_FFT / 2)))
    const nt = Math.trunc(50 / ((HOP / rate) * 1000))
    if (nf < 1) return 'high'
    if (nt < 1) return 'low'
    const tri = (n: number) => {
      // concatenate(linspace(0, 1, n + 1, endpoint=False), linspace(1, 0, n + 2))[1:-1]
      const out = new Float64Array(2 * n + 1)
      let sum = 0
      for (let i = 0; i < 2 * n + 1; i++) {
        const v = i < n ? (i + 1) / (n + 1) : 1 - (i - n) / (n + 1)
        out[i] = v
        sum += v
      }
      for (let i = 0; i < out.length; i++) out[i] = out[i]! / sum
      return out
    }
    return { f: tri(nf), t: tri(nt) }
  }

  /** A sound's STFT: `nseg` columns of BINS terms, column-major (column j at j·BINS). */
  function stft(x: ArrayLike<number>, isStopped?: () => boolean): { re: Float64Array; im: Float64Array; nseg: number } {
    const n = x.length
    const nseg = Math.floor(n / HOP) + 1
    const re = new Float64Array(nseg * BINS)
    const im = new Float64Array(nseg * BINS)
    const br = new Float64Array(N_FFT)
    const bi = new Float64Array(N_FFT)
    const scale = 1 / winSum
    for (let j = 0; j < nseg; j++) {
      if ((j & 255) === 0) stopped(isStopped)
      // The sound with N_FFT / 2 zeros each side (boundary='zeros').
      const start = j * HOP - N_FFT / 2
      for (let i = 0; i < N_FFT; i++) {
        const k = start + i
        br[i] = k >= 0 && k < n ? x[k]! * win[i]! : 0
        bi[i] = 0
      }
      ft.fft(br, bi)
      const o = j * BINS
      for (let k = 0; k < BINS; k++) { re[o + k] = br[k]! * scale; im[o + k] = bi[k]! * scale }
    }
    return { re, im, nseg }
  }

  /** scipy's istft of those columns: ((nseg − 1) · HOP samples). */
  function istft(re: Float64Array, im: Float64Array, nseg: number, isStopped?: () => boolean): Float64Array {
    const length = N_FFT + (nseg - 1) * HOP
    const x = new Float64Array(length)
    const norm = new Float64Array(length)
    for (let j = 0; j < nseg; j++) {
      if ((j & 255) === 0) stopped(isStopped)
      const o = j * BINS
      const seg = ft.irfft(re.subarray(o, o + BINS), im.subarray(o, o + BINS), N_FFT)
      const at = j * HOP
      for (let i = 0; i < N_FFT; i++) {
        x[at + i] = x[at + i]! + seg[i]! * winSum * win[i]!
        norm[at + i] = norm[at + i]! + win[i]! * win[i]!
      }
    }
    const half = N_FFT / 2
    const out = new Float64Array(Math.max(0, length - N_FFT))
    for (let i = 0; i < out.length; i++) {
      const nm = norm[i + half]!
      out[i] = x[i + half]! / (nm > 1e-10 ? nm : 1)
    }
    return out
  }

  /** 20·log10(|X| + eps) per bin, floored 80 dB below each frequency's loudest over time (utils._amp_to_db). */
  function dbOf(re: Float64Array, im: Float64Array, nseg: number): Float64Array {
    const db = new Float64Array(nseg * BINS)
    const top = new Float64Array(BINS).fill(-Infinity)
    for (let j = 0; j < nseg; j++) {
      for (let k = 0; k < BINS; k++) {
        const i = j * BINS + k
        const v = 20 * Math.log10(Math.hypot(re[i]!, im[i]!) + EPS)
        db[i] = v
        if (v > top[k]!) top[k] = v
      }
    }
    for (let j = 0; j < nseg; j++) {
      for (let k = 0; k < BINS; k++) {
        const i = j * BINS + k
        const floor = top[k]! - TOP_DB
        if (db[i]! < floor) db[i] = floor
      }
    }
    return db
  }

  /** fftconvolve(mask, outer(f, t), 'same'), as its two 1-D passes (zeros past the edges): along frequency, then time. */
  function smooth(mask: Float64Array, nseg: number, s: { f: Float64Array; t: Float64Array }, isStopped?: () => boolean): Float64Array {
    const hf = (s.f.length - 1) / 2
    const ht = (s.t.length - 1) / 2
    const a = new Float64Array(mask.length)
    for (let j = 0; j < nseg; j++) {
      if ((j & 255) === 0) stopped(isStopped)
      const o = j * BINS
      for (let k = 0; k < BINS; k++) {
        let sum = 0
        const lo = Math.max(0, k - hf)
        const hi = Math.min(BINS - 1, k + hf)
        for (let q = lo; q <= hi; q++) sum += mask[o + q]! * s.f[q - k + hf]!
        a[o + k] = sum
      }
    }
    const b = new Float64Array(mask.length)
    for (let j = 0; j < nseg; j++) {
      if ((j & 255) === 0) stopped(isStopped)
      const lo = Math.max(0, j - ht)
      const hi = Math.min(nseg - 1, j + ht)
      const o = j * BINS
      for (let q = lo; q <= hi; q++) {
        const w = s.t[q - j + ht]!
        const p = q * BINS
        for (let k = 0; k < BINS; k++) b[o + k] = b[o + k]! + a[p + k]! * w
      }
    }
    return b
  }

  /**
   * The stationary noise profile (stationary.py:62-82): the channels' mean
   * over the first 600,000 samples (float32, as numpy's mean of float32),
   * its dB per bin, and per frequency the threshold mean + 1.5 · std.
   */
  function profile(chs: Float32Array[], _p: Record<string, unknown>, isStopped?: () => boolean): DenoiseResult {
    const C = chs.length
    const n = Math.min(CHUNK, chs[0]?.length ?? 0)
    const mono = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      let sum = 0
      for (let c = 0; c < C; c++) sum = Math.fround(sum + chs[c]![i]!)
      mono[i] = Math.fround(sum / C)
    }
    const { re, im, nseg } = stft(mono, isStopped)
    const db = dbOf(re, im, nseg)
    const thresh = new Float64Array(BINS)
    for (let k = 0; k < BINS; k++) {
      let mean = 0
      for (let j = 0; j < nseg; j++) mean += db[j * BINS + k]!
      mean /= nseg
      let v = 0
      for (let j = 0; j < nseg; j++) { const d = db[j * BINS + k]! - mean; v += d * d }
      thresh[k] = mean + Math.sqrt(v / nseg) * N_STD
    }
    return { thresh }
  }

  /** filtfilt([b], [1, b − 1], x, padtype=None) along one frequency's row: forward from x[0]·zi, then back from y[end]·zi. */
  function filtfilt(x: Float64Array, b: number): Float64Array {
    const n = x.length
    const y = new Float64Array(n)
    if (!n) return y
    const keep = 1 - b
    // y[i] = b·x[i] + z;  z = (1 − b)·y[i]; lfilter_zi = 1 − b.
    let z = keep * x[0]!
    for (let i = 0; i < n; i++) { const v = b * x[i]! + z; y[i] = v; z = keep * v }
    z = keep * y[n - 1]!
    for (let i = n - 1; i >= 0; i--) { const v = b * y[i]! + z; y[i] = v; z = keep * v }
    return y
  }

  /**
   * One chunk, every channel (each `from` + its length + PAD samples long,
   * already padded): gated as the method says, inverted, and the samples
   * [from, to) kept as float32.
   */
  function chunk(chs: Float32Array[], p: { rate: number; stationary: boolean; prop: number; thresh?: Float64Array | number[]; from: number; to: number }, isStopped?: () => boolean): DenoiseResult {
    const s = smoothingOf(p.rate)
    if (typeof s === 'string') throw new Error(s === 'low' ? 'The sample rate is too low' : 'The sample rate is too high')
    const smoothOn = !(s.f.length === 1 && s.t.length === 1)
    const prop = p.prop
    const channels = chs.map((x) => {
      const { re, im, nseg } = stft(x, isStopped)
      const size = nseg * BINS
      let mask: Float64Array = new Float64Array(size)
      if (p.stationary) {
        const thresh = p.thresh!
        const db = dbOf(re, im, nseg)
        for (let j = 0; j < nseg; j++) {
          for (let k = 0; k < BINS; k++) {
            const i = j * BINS + k
            mask[i] = (db[i]! > thresh[k]! ? 1 : 0) * prop + (1 - prop)
          }
        }
        if (smoothOn) mask = smooth(mask, nseg, s, isStopped)
      }
      else {
        const tFrames = (TIME_CONSTANT_S * p.rate) / HOP
        const b = (Math.sqrt(1 + 4 * tFrames ** 2) - 1) / (2 * tFrames ** 2)
        const row = new Float64Array(nseg)
        for (let k = 0; k < BINS; k++) {
          if ((k & 63) === 0) stopped(isStopped)
          for (let j = 0; j < nseg; j++) { const i = j * BINS + k; row[j] = Math.hypot(re[i]!, im[i]!) }
          const sm = filtfilt(row, b)
          for (let j = 0; j < nseg; j++) {
            const a = row[j]!
            // 0 / 0 (digital silence) counts as fully below the noise: Python's NaN, fixed.
            const above = sm[j]! > 0 ? (a - sm[j]!) / sm[j]! : -1
            mask[j * BINS + k] = 1 / (1 + Math.exp(-(above - THRESH_MULT) * SLOPE))
          }
        }
        if (smoothOn) mask = smooth(mask, nseg, s, isStopped)
        for (let i = 0; i < size; i++) mask[i] = mask[i]! * prop + (1 - prop)
      }
      for (let i = 0; i < size; i++) { re[i] = re[i]! * mask[i]!; im[i] = im[i]! * mask[i]! }
      const y = istft(re, im, nseg, isStopped)
      const out = new Float32Array(p.to - p.from)
      // Past the inverse's end (a few samples of the last hop) Python's chunk holds zeros.
      for (let i = 0; i < out.length; i++) { const k = p.from + i; out[i] = k < y.length ? y[k]! : 0 }
      return out
    })
    return { channels }
  }

  /** The chunks of a sound of n samples: each [start, end) of the sound, read padded by PAD each side. */
  function chunksOf(n: number): { start: number; end: number }[] {
    if (n <= CHUNK) return [{ start: 0, end: n }]
    const out: { start: number; end: number }[] = []
    for (let s = 0; s < n; s += CHUNK) out.push({ start: s, end: Math.min(n, s + CHUNK) })
    return out
  }

  /**
   * A chunk's padded channels: [start − PAD, start + span + PAD), zeros past
   * the sound. `span` is the whole chunk size for a sound cut into chunks
   * (Python reads every chunk full length), else the sound's length.
   */
  function padded(chs: readonly Float32Array[], start: number, span: number): Float32Array[] {
    return chs.map((c) => {
      const y = new Float32Array(span + 2 * PAD)
      const a = Math.max(0, start - PAD)
      const b = Math.min(c.length, start + span + PAD)
      if (b > a) y.set(c.subarray(a, b), a - (start - PAD))
      return y
    })
  }

  /** The whole sound on this thread (tests): the profile, then each chunk. */
  function denoise(chs: Float32Array[], p: { rate: number; stationary: boolean; prop: number }, isStopped?: () => boolean): Float32Array[] {
    const n = chs[0]?.length ?? 0
    const thresh = p.stationary ? profile(chs, {}, isStopped).thresh : undefined
    const out = chs.map(() => new Float32Array(n))
    const cut = n > CHUNK
    for (const c of chunksOf(n)) {
      const r = chunk(padded(chs, c.start, cut ? CHUNK : n), { ...p, thresh, from: PAD, to: PAD + c.end - c.start }, isStopped)
      r.channels!.forEach((y, k) => out[k]!.set(y, c.start))
    }
    return out
  }

  return { CHUNK, PAD, smoothingOf, stft, istft, filtfilt, profile, chunk, chunksOf, padded, denoise }
}

export type DenoiseCore = ReturnType<typeof denoiseCore>
