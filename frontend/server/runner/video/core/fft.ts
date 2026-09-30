/**
 * The shared FFT (step 3, R6.5): Stabilize's phase correlation, and later
 * R6.7's audio waveform and R6.10's noise removal.
 *
 * SELF-CONTAINED, as the other cores are (./time.ts): the compositor worker
 * composes it from its source text (../cores.ts, `ft`), and tests call the
 * same code in this thread. Do not reference anything from outside the
 * function's body.
 *
 * Every transform is in float64, whatever the length: an iterative radix-2
 * transform for powers of two, and Bluestein's chirp transform (on a
 * power-of-two length of at least 2n − 1) for every other length. The
 * matching rule (USER, 2026-09-30) asks for a correct FFT, not pocketfft's
 * own rounding: the spec checks it against numpy within a relative 1e-12
 * (tests/unit/runner-media-vfx-stabilize.unit.spec.ts). A float32 caller
 * rounds the result once.
 *
 * Signs and scales are numpy's: the forward transform is
 * X[k] = Σ x[j]·e^(−2πi·jk/n), unscaled; the inverse has the + sign and is
 * divided by n.
 */
export function fftCore() {
  /** Twiddles and bit reversal for each power-of-two length, kept (lengths repeat: a frame's rows, a sound's blocks). */
  const radix: Map<number, { cos: Float64Array; sin: Float64Array; rev: Uint32Array }> = new Map()
  /** Bluestein's chirp and its transformed filter for each other length. */
  const chirps: Map<number, { m: number; cr: Float64Array; ci: Float64Array; br: Float64Array; bi: Float64Array }> = new Map()

  const isPow2 = (n: number) => n > 0 && (n & (n - 1)) === 0

  function radixOf(n: number) {
    let r = radix.get(n)
    if (r) return r
    const cos = new Float64Array(n >> 1)
    const sin = new Float64Array(n >> 1)
    for (let j = 0; j < n >> 1; j++) {
      // Each twiddle from its own angle (no running product): error stays near one ulp.
      const a = (2 * Math.PI * j) / n
      cos[j] = Math.cos(a)
      sin[j] = Math.sin(a)
    }
    const rev = new Uint32Array(n)
    let bits = 0
    while ((1 << bits) < n) bits++
    for (let i = 0; i < n; i++) {
      let x = i
      let y = 0
      for (let b = 0; b < bits; b++) { y = (y << 1) | (x & 1); x >>= 1 }
      rev[i] = y
    }
    r = { cos, sin, rev }
    radix.set(n, r)
    return r
  }

  /** In place, unscaled, power-of-two n; `sign` −1 forward, +1 inverse. */
  function pow2(re: Float64Array, im: Float64Array, sign: number): void {
    const n = re.length
    if (n <= 1) return
    const { cos, sin, rev } = radixOf(n)
    for (let i = 0; i < n; i++) {
      const j = rev[i]!
      if (j > i) {
        let t = re[i]!; re[i] = re[j]!; re[j] = t
        t = im[i]!; im[i] = im[j]!; im[j] = t
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1
      const step = n / size
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = cos[k * step]!
          const wi = sign * sin[k * step]!
          const a = start + k
          const b = a + half
          const xr = re[b]! * wr - im[b]! * wi
          const xi = re[b]! * wi + im[b]! * wr
          re[b] = re[a]! - xr
          im[b] = im[a]! - xi
          re[a] = re[a]! + xr
          im[a] = im[a]! + xi
        }
      }
    }
  }

  function chirpOf(n: number) {
    let c = chirps.get(n)
    if (c) return c
    let m = 1
    while (m < 2 * n - 1) m <<= 1
    // w[k] = e^(−πi·k²/n); k² taken mod 2n first, so the angle stays exact for long lengths.
    const cr = new Float64Array(n)
    const ci = new Float64Array(n)
    for (let k = 0; k < n; k++) {
      const a = (Math.PI * ((k * k) % (2 * n))) / n
      cr[k] = Math.cos(a)
      ci[k] = -Math.sin(a)
    }
    // The filter b[k] = conj(w[k]), wrapped round, transformed once.
    const br = new Float64Array(m)
    const bi = new Float64Array(m)
    br[0] = cr[0]!
    bi[0] = -ci[0]!
    for (let k = 1; k < n; k++) {
      br[k] = br[m - k] = cr[k]!
      bi[k] = bi[m - k] = -ci[k]!
    }
    pow2(br, bi, -1)
    c = { m, cr, ci, br, bi }
    chirps.set(n, c)
    return c
  }

  /** In place, unscaled, any n (Bluestein); `sign` −1 forward, +1 inverse. */
  function bluestein(re: Float64Array, im: Float64Array, sign: number): void {
    const n = re.length
    const { m, cr, ci, br, bi } = chirpOf(n)
    // The inverse is the forward transform of the conjugate, conjugated.
    const s = sign < 0 ? 1 : -1
    const ar = new Float64Array(m)
    const ai = new Float64Array(m)
    for (let k = 0; k < n; k++) {
      const xr = re[k]!
      const xi = s * im[k]!
      ar[k] = xr * cr[k]! - xi * ci[k]!
      ai[k] = xr * ci[k]! + xi * cr[k]!
    }
    pow2(ar, ai, -1)
    for (let k = 0; k < m; k++) {
      const xr = ar[k]!
      const xi = ai[k]!
      ar[k] = xr * br[k]! - xi * bi[k]!
      ai[k] = xr * bi[k]! + xi * br[k]!
    }
    pow2(ar, ai, 1)
    for (let k = 0; k < n; k++) {
      const xr = ar[k]! / m
      const xi = ai[k]! / m
      re[k] = xr * cr[k]! - xi * ci[k]!
      im[k] = s * (xr * ci[k]! + xi * cr[k]!)
    }
  }

  function inPlace(re: Float64Array, im: Float64Array, sign: number): void {
    if (re.length !== im.length) throw new Error('A transform’s two halves differ in length')
    if (re.length <= 1) return
    if (isPow2(re.length)) pow2(re, im, sign)
    else bluestein(re, im, sign)
  }

  /** numpy.fft.fft, in place (unscaled). */
  function fft(re: Float64Array, im: Float64Array): void {
    inPlace(re, im, -1)
  }

  /** numpy.fft.ifft, in place (divided by n). */
  function ifft(re: Float64Array, im: Float64Array): void {
    inPlace(re, im, 1)
    const n = re.length
    for (let i = 0; i < n; i++) { re[i] = re[i]! / n; im[i] = im[i]! / n }
  }

  /** numpy.fft.rfft of real samples: the first ⌊n/2⌋ + 1 terms. */
  function rfft(x: ArrayLike<number>): { re: Float64Array; im: Float64Array } {
    const n = x.length
    const re = Float64Array.from(x)
    const im = new Float64Array(n)
    fft(re, im)
    const k = (n >> 1) + 1
    return { re: re.slice(0, n ? k : 0), im: im.slice(0, n ? k : 0) }
  }

  /** numpy.fft.irfft of ⌊n/2⌋ + 1 terms back to n real samples (n defaults to 2(len − 1)). */
  function irfft(re: ArrayLike<number>, im: ArrayLike<number>, n = 2 * (re.length - 1)): Float64Array {
    const fr = new Float64Array(n)
    const fi = new Float64Array(n)
    const half = (n >> 1) + 1
    for (let k = 0; k < half && k < re.length; k++) { fr[k] = re[k]!; fi[k] = im[k]! }
    // The spectrum of a real signal is Hermitian: the rest mirrors the first half.
    for (let k = half; k < n; k++) { fr[k] = fr[n - k]!; fi[k] = -fi[n - k]! }
    // numpy drops the imaginary part of the zero-frequency term (and of n/2's, for even n).
    fi[0] = 0
    if (n % 2 === 0 && n > 0) fi[n >> 1] = 0
    ifft(fr, fi)
    return fr
  }

  /** A 2-D transform of an h × w row-major array, in place: every row, then every column. */
  function twoD(re: Float64Array, im: Float64Array, h: number, w: number, inverse: boolean): void {
    if (re.length !== h * w || im.length !== h * w) throw new Error('A 2-D transform is not the size it says')
    const sign = inverse ? 1 : -1
    const rr = new Float64Array(w)
    const ri = new Float64Array(w)
    for (let y = 0; y < h; y++) {
      rr.set(re.subarray(y * w, (y + 1) * w))
      ri.set(im.subarray(y * w, (y + 1) * w))
      inPlace(rr, ri, sign)
      re.set(rr, y * w)
      im.set(ri, y * w)
    }
    const cr = new Float64Array(h)
    const cim = new Float64Array(h)
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) { cr[y] = re[y * w + x]!; cim[y] = im[y * w + x]! }
      inPlace(cr, cim, sign)
      for (let y = 0; y < h; y++) { re[y * w + x] = cr[y]!; im[y * w + x] = cim[y]! }
    }
    if (inverse) {
      const n = h * w
      for (let i = 0; i < n; i++) { re[i] = re[i]! / n; im[i] = im[i]! / n }
    }
  }

  /** numpy.fft.fft2 of an h × w array, in place. */
  const fft2 = (re: Float64Array, im: Float64Array, h: number, w: number) => twoD(re, im, h, w, false)
  /** numpy.fft.ifft2 of an h × w array, in place (divided by h·w). */
  const ifft2 = (re: Float64Array, im: Float64Array, h: number, w: number) => twoD(re, im, h, w, true)

  return { fft, ifft, rfft, irfft, fft2, ifft2 }
}

export type FftCore = ReturnType<typeof fftCore>
