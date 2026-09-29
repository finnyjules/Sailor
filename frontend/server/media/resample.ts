/**
 * torchaudio.functional.resample, ported (step 3, R5, ruling j): Opus export
 * needs 8, 12, 16, 24 or 48 kHz, and AudioSaveHelper.save_audio
 * (comfy_api/latest/_ui.py:293-307) converts any other rate with torchaudio's
 * default resampler (sinc_interp_hann, lowpass_filter_width 6, rolloff 0.99)
 * on the float32 waveform.
 *
 * The kernel is built as torchaudio 2.10 builds it for a float32 waveform
 * (`_get_sinc_resample_kernel`, dtype float32: every step rounded to float32),
 * then applied as its `conv1d` with stride `orig` over the waveform padded by
 * `width` zeros before and `width + orig` after, keeping
 * ceil(float32(new · length / orig)) samples (torch.as_tensor of a Python
 * float is float32). The sums are taken in float64 and rounded once, so the
 * result is the exact convolution of the float32 kernel; torch's own float32
 * sums and its vectorised sin/cos land within a millionth of it (the encode
 * spec checks every sample against torchaudio's own output).
 *
 * `resampleCore` is self-contained (no imports, no outer names): the
 * compositor worker runs it from its source text (compositor/worker.ts,
 * `audio.resample`), so a long sound never holds the server's main thread.
 * It stops between blocks of output when asked, keeps at most a few kernels
 * (a small LRU), and refuses a kernel over RESAMPLE_MAX_TAPS: a rate pair
 * whose reduced ratio is large (44101 → 48000 Hz asks for 7.9 GB) would
 * exhaust memory in torchaudio too.
 */

/** The largest kernel built: 2²⁴ float32 taps, 64 MiB (44.1, 22.05, 11.025, 32 kHz… need under 30,000). */
export const RESAMPLE_MAX_TAPS = 2 ** 24

export function resampleCore() {
  const f = Math.fround
  const MAX_TAPS = 2 ** 24
  /** The LRU keeps at most this many kernels, and this many taps in all. */
  const CACHE_KERNELS = 4
  const CACHE_TAPS = 2 ** 25
  /** Stop is checked every this many output samples. */
  const BLOCK = 65536

  interface Kernel { taps: Float32Array; n: number; width: number; orig: number; next: number }
  const cache = new Map<string, Kernel>()

  function gcd(a: number, b: number): number {
    while (b) [a, b] = [b, a % b]
    return a
  }

  /** The reduced ratio and kernel size for a pair, without building it. */
  function plan(origFreq: number, newFreq: number): { orig: number; next: number; width: number; n: number; taps: number } {
    if (!(Number.isInteger(origFreq) && Number.isInteger(newFreq) && origFreq > 0 && newFreq > 0)) throw new RangeError('resample: rates must be positive integers')
    const g = gcd(origFreq, newFreq)
    const orig = origFreq / g
    const next = newFreq / g
    const baseFreq = Math.min(orig, next) * 0.99
    const width = Math.ceil((6 * orig) / baseFreq)
    const n = 2 * width + orig
    return { orig, next, width, n, taps: n * next }
  }

  /** `_get_sinc_resample_kernel` for float32: `next` rows of `n` taps, one per output phase. */
  function kernel(origFreq: number, newFreq: number): Kernel {
    const key = `${origFreq}/${newFreq}`
    const known = cache.get(key)
    if (known) {
      cache.delete(key)
      cache.set(key, known)
      return known
    }
    const { orig, next, width, n, taps: size } = plan(origFreq, newFreq)
    if (size > MAX_TAPS) throw new RangeError('resample: kernel too large')
    const lowpass = 6
    // Python floats (double) until the tensors start; a Python float times a float32 tensor is taken in float32.
    const baseFreq = Math.min(orig, next) * 0.99
    const baseF = f(baseFreq)
    const scaleF = f(baseFreq / orig)
    const piF = f(Math.PI)
    const taps = new Float32Array(size)
    for (let j = 0; j < next; j++) {
      // torch.arange(0, -new, -1, float32) / new
      const tj = f(-j / next)
      for (let k = 0; k < n; k++) {
        // torch.arange(-width, width + orig, float32) / orig
        const idx = f((k - width) / orig)
        let t = f(tj + idx)
        t = f(t * baseF)
        t = Math.min(lowpass, Math.max(-lowpass, t))
        // torch.cos(t * pi / lowpass / 2) ** 2, each step in float32
        const c = f(Math.cos(f(f(f(t * piF) / lowpass) / 2)))
        const window = f(c * c)
        const tp = f(t * piF)
        const sinc = tp === 0 ? 1 : f(f(Math.sin(tp)) / tp)
        // kernels *= window * scale
        taps[j * n + k] = f(sinc * f(window * scaleF))
      }
    }
    const made: Kernel = { taps, n, width, orig, next }
    cache.set(key, made)
    let total = 0
    for (const v of cache.values()) total += v.taps.length
    for (const [k, v] of cache) {
      if (cache.size <= CACHE_KERNELS && total <= CACHE_TAPS) break
      if (v === made) continue
      cache.delete(k)
      total -= v.taps.length
    }
    return made
  }

  /** How many samples torchaudio keeps: ceil of float32(new · length / orig). */
  function outputLength(origFreq: number, newFreq: number, length: number): number {
    const { orig, next } = plan(origFreq, newFreq)
    return Math.ceil(f((next * length) / orig))
  }

  /** One channel from `origFreq` to `newFreq`; `stopped()` is asked between blocks of output. */
  function resample(x: Float32Array, origFreq: number, newFreq: number, stopped?: () => boolean): Float32Array {
    if (origFreq === newFreq) return x
    const { taps, n, width, orig, next } = kernel(origFreq, newFreq)
    const length = x.length
    const target = outputLength(origFreq, newFreq, length)
    const out = new Float32Array(target)
    for (let o = 0; o < target; o++) {
      if (o % BLOCK === 0 && stopped && stopped()) throw new Error('Stopped')
      const block = Math.floor(o / next)
      const row = (o % next) * n
      // conv1d output `block` reads padded[block · orig + k] = x[block · orig + k − width].
      const start = block * orig - width
      let sum = 0
      const k0 = Math.max(0, -start)
      const k1 = Math.min(n, length - start)
      for (let k = k0; k < k1; k++) sum += taps[row + k]! * x[start + k]!
      out[o] = sum
    }
    return out
  }

  return { plan, outputLength, resample, cachedKernels: () => cache.size }
}

const mainCore = resampleCore()

/** The kernel's size for a pair (taps), to refuse before any work. */
export function resampleTaps(origFreq: number, newFreq: number): number {
  return origFreq === newFreq ? 0 : mainCore.plan(origFreq, newFreq).taps
}

/** One channel, on the calling thread (tests; the server runs `resampleInWorker`). */
export function resampleChannel(x: Float32Array, origFreq: number, newFreq: number): Float32Array {
  return mainCore.resample(x, origFreq, newFreq)
}

/** Every channel, on the calling thread (tests). */
export function resampleLikeTorchaudio(channels: readonly Float32Array[], origFreq: number, newFreq: number): Float32Array[] {
  return channels.map(ch => resampleChannel(ch, origFreq, newFreq))
}

/** The Opus rates save_audio accepts. */
export const OPUS_RATES = [8000, 12000, 16000, 24000, 48000] as const

/** The rate save_audio writes an Opus file at: above 48 kHz, 48 kHz; else the next Opus rate up (48 kHz past the last). */
export function opusRate(rate: number): number {
  if (rate > 48000) return 48000
  if ((OPUS_RATES as readonly number[]).includes(rate)) return rate
  for (const r of OPUS_RATES) if (r > rate) return r
  return 48000
}
