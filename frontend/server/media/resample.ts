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
 * ceil(new · length / orig) samples. The sums are taken in float64 and rounded
 * once, so the result is the exact convolution of the float32 kernel; torch's
 * own float32 sums and its vectorised sin/cos land within a millionth of it
 * (the encode spec checks every sample against torchaudio's own output).
 */

const f = Math.fround

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b]
  return a
}

interface Kernel { taps: Float32Array[]; width: number; orig: number; next: number }

const kernels = new Map<string, Kernel>()

/** `_get_sinc_resample_kernel` for float32, one row of taps per output phase. */
function sincKernel(origFreq: number, newFreq: number): Kernel {
  const key = `${origFreq}/${newFreq}`
  const known = kernels.get(key)
  if (known) return known
  const g = gcd(origFreq, newFreq)
  const orig = origFreq / g
  const next = newFreq / g
  const lowpass = 6
  const rolloff = 0.99
  // Python floats (double) until the tensors start.
  const baseFreq = Math.min(orig, next) * rolloff
  const width = Math.ceil((lowpass * orig) / baseFreq)
  const n = 2 * width + orig
  const scale = baseFreq / orig
  // A Python float times a float32 tensor is taken in float32: the scalar is rounded first.
  const baseF = f(baseFreq)
  const scaleF = f(scale)
  const piF = f(Math.PI)
  const taps: Float32Array[] = []
  for (let j = 0; j < next; j++) {
    const row = new Float32Array(n)
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
      row[k] = f(sinc * f(window * scaleF))
    }
    taps.push(row)
  }
  const kernel = { taps, width, orig, next }
  kernels.set(key, kernel)
  return kernel
}

/** One channel from `origFreq` to `newFreq`, as torchaudio.functional.resample does it. */
export function resampleChannel(x: Float32Array, origFreq: number, newFreq: number): Float32Array {
  if (!(Number.isInteger(origFreq) && Number.isInteger(newFreq) && origFreq > 0 && newFreq > 0)) throw new RangeError('resample: rates must be positive integers')
  if (origFreq === newFreq) return x
  const { taps, width, orig, next } = sincKernel(origFreq, newFreq)
  const length = x.length
  // ceil(new · length / orig), exactly (torch.ceil of a float division; integers here stay exact).
  const target = Math.ceil((next * length) / orig)
  const out = new Float32Array(target)
  const n = taps[0]!.length
  for (let o = 0; o < target; o++) {
    const block = Math.floor(o / next)
    const row = taps[o % next]!
    // conv1d output `block` reads padded[block · orig + k] = x[block · orig + k − width].
    const start = block * orig - width
    let sum = 0
    const k0 = Math.max(0, -start)
    const k1 = Math.min(n, length - start)
    for (let k = k0; k < k1; k++) sum += row[k]! * x[start + k]!
    out[o] = sum
  }
  return out
}

/** Every channel. */
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
