/**
 * The frame looks (step 3, R6.4): Ken Burns, Aspect convert, Chroma key, LUT
 * and 3-way color (nodes_video_pro.py:138-624), one output frame at a time,
 * as Python's float32 torch code computes it.
 *
 * `lookCore` is SELF-CONTAINED apart from its arguments, as ./time.ts is: the
 * compositor worker composes it from its source text (../cores.ts). `kn` is
 * R2.2's kernels (linspace, affine_grid, grid_sample, the 3-D grid_sample,
 * fmaf). `parseCubeLut` below it runs on the main thread only (the plan and
 * the start pass read the LUT file); the core never calls it.
 */
import type { Tensor, TensorCore } from '../../effects/core/tensor'
import type { KernelsCore } from '../../effects/core/kernels'
import type { VideoOpResult } from './time'

/** Aspect convert's output (nodes_video_pro.py:220-271): its size, and where the frame sits (pad) or the crop starts. */
export interface AspectLayout { method: 'pad' | 'crop_center' | 'auto_pan'; ow: number; oh: number; offX: number; offY: number; axis: 'x' | 'y' }

export function lookCore(tk: TensorCore, kn: KernelsCore) {
  const f = Math.fround

  /** Python's round() of a double: halves to the even neighbour. */
  function roundEven(x: number): number {
    const r = Math.round(x)
    return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r
  }

  /** Python's str.strip()'s blanks (ASCII, U+001C–U+001F and the Unicode spaces). */
  const PY_BLANK = /^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g
  /** int(s, 16)'s grammar once int() strips its blanks: a sign, an optional 0x, hex digits with single underscores between. */
  const PY_HEX = /^[+-]?(?:0[xX]_?)?[0-9a-fA-F](?:_?[0-9a-fA-F])*$/
  const PY_NUM_BLANK = /^[\t\n\v\f\r \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g

  /** Python's int(s, 16), or null where it raises. */
  function hexInt(s: string): number | null {
    const t = s.replace(PY_NUM_BLANK, '')
    if (!PY_HEX.test(t)) return null
    const neg = t.startsWith('-')
    const body = t.replace(/^[+-]/, '').replace(/^0[xX]/, '').replace(/_/g, '')
    const v = Number.parseInt(body, 16)
    return neg ? -v : v
  }

  /**
   * `_hex_rgb` (nodes_video_pro.py:26-35): stripped, every leading '#' cut,
   * three characters doubled; six, each pair by int(…, 16) / 255 (doubles),
   * else the fallback whole.
   */
  function hexRgb(s: unknown, fallback: readonly [number, number, number]): [number, number, number] {
    let t = typeof s === 'string' ? s.replace(PY_BLANK, '').replace(/^#+/, '') : ''
    let cps = Array.from(t)
    if (cps.length === 3) {
      t = cps.map(c => c + c).join('')
      cps = Array.from(t)
    }
    if (cps.length !== 6) return [...fallback]
    const out: number[] = []
    for (let k = 0; k < 3; k++) {
      const v = hexInt(cps[2 * k]! + cps[2 * k + 1]!)
      if (v === null) return [...fallback]
      out.push(v / 255.0)
    }
    return out as [number, number, number]
  }

  function clampInPlace(t: Tensor): Tensor {
    const d = t.data
    for (let i = 0; i < d.length; i++) {
      const v = d[i]!
      if (v < 0) d[i] = 0
      else if (v > 1) d[i] = 1
    }
    return t
  }

  // ── Ken Burns ─────────────────────────────────────────────────────────────

  /** `_ease` (nodes_video_pro.py:38-44) of one float32, each op rounded (cos: this runtime's, LIBRARY). */
  function ease(t: number, mode: unknown): number {
    if (mode === 'ease_in') return f(t * t)
    if (mode === 'ease_out') {
      const a = f(1 - t)
      return f(1 - f(a * a))
    }
    if (mode === 'ease_in_out') return f(0.5 - f(0.5 * f(Math.cos(f(t * f(Math.PI))))))
    return t
  }

  /**
   * Ken Burns (:161-185), frame `index` of `count`: t = ease(linspace(0, 1,
   * T))[i]; z, x, y lerped in float32 (the Python scalars rounded to float32
   * as torch does); θ = [[1/z, 0, 2x], [0, 1/z, 2y]] (1/z in doubles, then
   * float32); affine_grid (`grid`), grid_sample (bilinear, border); clamped.
   * EXACT but ease_in_out (LIBRARY: cos).
   */
  function kenBurns(inputs: Tensor[], p: Record<string, unknown>, _state: ArrayBuffer | undefined, index: number, count: number, stop?: () => boolean): VideoOpResult {
    const x0 = inputs[0]
    if (!x0) throw new Error('A video frame is missing')
    const t = ease(kn.linspace(0, 1, count)[index]!, p.easing)
    const lerp = (a: unknown, b: unknown) => f(f(f((b as number) - (a as number)) * t) + f(a as number))
    const z = lerp(p.start_zoom, p.end_zoom)
    const x = lerp(p.start_x, p.end_x)
    const y = lerp(p.start_y, p.end_y)
    const g = grid(f(1.0 / z), f(x * 2.0), f(y * 2.0), x0.h, x0.w)
    const out = kn.gridSample(x0, g.gx, g.gy, { padding: 'border', alignCorners: false, oh: x0.h, ow: x0.w }, stop)
    return { out: clampInPlace(out) }
  }

  /**
   * F.affine_grid([[s, 0, tx], [0, s, ty]], align_corners=False) as torch
   * 2.10 computes it on this machine (measured): the base grid
   * linspace(−1, 1, n)·(n − 1)/n, then each coordinate x·θ₀ + y·θ₁ + θ₂ with
   * every product and sum rounded to float32 in that order (no fused
   * multiply-add). EXACT (R2.2's affineGrid sums in double: one ulp off
   * where the translation isn't 0).
   */
  function grid(s: number, tx: number, ty: number, h: number, w: number): { gx: Float32Array; gy: Float32Array } {
    const base = (n: number) => {
      if (n <= 1) return new Float32Array(1)
      const r = kn.linspace(-1, 1, n)
      for (let i = 0; i < n; i++) r[i] = f(f(r[i]! * (n - 1)) / n)
      return r
    }
    const bx = base(w)
    const by = base(h)
    const gx = new Float32Array(h * w)
    const gy = new Float32Array(h * w)
    for (let yy = 0; yy < h; yy++) {
      const Y = by[yy]!
      const ys = f(Y * s)
      const y0 = f(Y * 0)
      for (let xx = 0; xx < w; xx++) {
        const X = bx[xx]!
        gx[yy * w + xx] = f(f(f(X * s) + y0) + tx)
        gy[yy * w + xx] = f(f(f(X * 0) + ys) + ty)
      }
    }
    return { gx, gy }
  }

  // ── Aspect convert ────────────────────────────────────────────────────────

  /**
   * Aspect convert's output size and placement (:209-271): the target's ratio
   * ar = float(w) / float(h). pad: the smallest enclosing size at ar
   * (int(round(W / ar)) or int(round(H·ar))), the frame centred ((o − in)
   * // 2). A crop: the largest size inside at ar, centred; auto_pan moves it
   * along `axis` (x when W is larger than the crop's width, else y).
   */
  function aspectLayout(p: Record<string, unknown>, W: number, H: number): AspectLayout {
    const [a, b] = String(p.target).split(':')
    const ar = Number(a) / Number(b)
    if (!(ar > 0) || !Number.isFinite(ar)) throw new Error('Aspect convert’s target is not a ratio')
    const method = p.method === 'pad' || p.method === 'auto_pan' ? p.method : 'crop_center'
    if (method === 'pad') {
      let ow: number
      let oh: number
      if (W / H > ar) { ow = W; oh = roundEven(W / ar) }
      else { oh = H; ow = roundEven(H * ar) }
      return { method, ow, oh, offX: Math.floor((ow - W) / 2), offY: Math.floor((oh - H) / 2), axis: 'x' }
    }
    let cw: number
    let ch: number
    if (W / H > ar) { ch = H; cw = roundEven(H * ar) }
    else { cw = W; ch = roundEven(W / ar) }
    return { method, ow: cw, oh: ch, offX: Math.max(0, Math.floor((W - cw) / 2)), offY: Math.max(0, Math.floor((H - ch) / 2)), axis: W > cw ? 'x' : 'y' }
  }

  /**
   * auto_pan's edge for one frame (:228-247): luma (0.2126·r + 0.7152·g +
   * 0.0722·b, float32 as torch), each column's (or row's) variance over the
   * other axis (unbiased; torch's Welford sums in double, here two passes in
   * double, rounded once), their box average over the crop's width (conv1d
   * with taps f(1/k): here summed in double, rounded once), and the first
   * highest (argmax; a NaN counts as highest). BAND: the edge is Python's
   * but where two scores sit within an ulp or two (the spec checks).
   */
  function autoPanScores(x: Tensor, L: AspectLayout): { scores: Float32Array; variance: Float32Array; edge: number } {
    const { w: W, h: H } = x
    const n = W * H
    const d = x.data
    const lum = new Float32Array(n)
    const cr = f(0.2126)
    const cg = f(0.7152)
    const cb = f(0.0722)
    for (let i = 0; i < n; i++) lum[i] = f(f(f(cr * d[i]!) + f(cg * d[n + i]!)) + f(cb * d[2 * n + i]!))
    const across = L.axis === 'x'
    const lines = across ? W : H
    const len = across ? H : W
    const at = (line: number, k: number) => (across ? lum[k * W + line]! : lum[line * W + k]!)
    const variance = new Float32Array(lines)
    for (let l = 0; l < lines; l++) {
      let s = 0
      for (let k = 0; k < len; k++) s += at(l, k)
      const mean = s / len
      let q = 0
      for (let k = 0; k < len; k++) {
        const e = at(l, k) - mean
        q += e * e
      }
      variance[l] = f(q / (len - 1))
    }
    const k = across ? L.ow : L.oh
    const tap = f(1 / k)
    const scores = new Float32Array(lines - k + 1)
    for (let j = 0; j < scores.length; j++) {
      let s = 0
      for (let i = 0; i < k; i++) s += variance[j + i]! * tap
      scores[j] = f(s)
    }
    let edge = 0
    for (let j = 1; j < scores.length; j++) {
      const v = scores[j]!
      const best = scores[edge]!
      if (best !== best) break
      if (v !== v || v > best) edge = j
    }
    return { scores, variance, edge }
  }

  /** Aspect convert of one frame (:209-271): pad, crop_center or auto_pan. Selection and a fill only: EXACT (auto_pan's edge BAND). */
  function aspect(inputs: Tensor[], p: Record<string, unknown>): VideoOpResult {
    const x = inputs[0]
    if (!x) throw new Error('A video frame is missing')
    const L = aspectLayout(p, x.w, x.h)
    if (!(L.ow > 0 && L.oh > 0)) throw new Error('Aspect convert would make a frame with no width or height')
    const out = tk.tensor(3, L.oh, L.ow)
    const on = L.ow * L.oh
    const n = x.w * x.h
    if (L.method === 'pad') {
      const bg = hexRgb(p.pad_color, [0, 0, 0])
      for (let ch = 0; ch < 3; ch++) out.data.fill(f(bg[ch]!), ch * on, (ch + 1) * on)
      for (let ch = 0; ch < 3; ch++) {
        for (let y = 0; y < x.h; y++) out.data.set(x.data.subarray(ch * n + y * x.w, ch * n + (y + 1) * x.w), ch * on + (y + L.offY) * L.ow + L.offX)
      }
      return { out: clampInPlace(out) }
    }
    let left = L.offX
    let top = L.offY
    if (L.method === 'auto_pan') {
      const e = autoPanScores(x, L).edge
      if (L.axis === 'x') left = e
      else top = e
    }
    for (let ch = 0; ch < 3; ch++) {
      for (let y = 0; y < L.oh; y++) out.data.set(x.data.subarray(ch * n + (y + top) * x.w + left, ch * n + (y + top) * x.w + left + L.ow), ch * on + y * L.ow)
    }
    return { out: clampInPlace(out) }
  }

  // ── Chroma key ────────────────────────────────────────────────────────────

  /** `_rgb_to_hsv` (:311-330) of one pixel, each op rounded to float32; `%` as torch.remainder. */
  function hsv(r: number, g: number, b: number): [number, number, number] {
    const maxc = Math.max(r, g, b)
    const minc = Math.min(r, g, b)
    const delta = f(maxc - minc)
    const eps = f(1e-6)
    const s = maxc > 0 ? f(delta / Math.max(maxc, eps)) : 0
    const dc = Math.max(delta, eps)
    const rc = f(f(maxc - r) / dc)
    const gc = f(f(maxc - g) / dc)
    const bc = f(f(maxc - b) / dc)
    let h = r === maxc ? f(bc - gc) : g === maxc ? f(f(2.0 + rc) - bc) : f(f(4.0 + gc) - rc)
    h = f(h / 6.0)
    let m = f(h % 1.0)
    if (m !== 0 && m < 0) m = f(m + 1.0)
    h = delta > 0 ? m : 0
    return [h, s, maxc]
  }

  /**
   * Chroma key's picture (:333-368): each pixel's hue distance from the key
   * (wrapped, ×2) and saturation distance, dist = dh·0.7 + ds·0.3, keep a
   * clamped ramp from tolerance − smoothness to tolerance + smoothness; spill
   * pulled out where (1 − keep)·spill > 0.01; frames·keep + bg·(1 − keep),
   * clamped. Every op in float32 as torch's (the Python scalars rounded to
   * float32). EXACT. Its mask output is not made (ruling (l)).
   */
  function chroma(inputs: Tensor[], p: Record<string, unknown>): VideoOpResult {
    const x = inputs[0]
    if (!x) throw new Error('A video frame is missing')
    const key = hexRgb(p.key_color, [0, 1, 0]).map(v => f(v))
    const bg = hexRgb(p.bg_color, [0, 0, 0]).map(v => f(v))
    const [kh, ks] = hsv(key[0]!, key[1]!, key[2]!)
    const tol = p.tolerance as number
    const smooth = p.smoothness as number
    const spill = p.spill_suppression as number
    const lo = f(Math.max(0.0, tol - smooth))
    const span = f(Math.max(tol + smooth - Math.max(0.0, tol - smooth), 1e-6))
    const k07 = f(0.7)
    const k03 = f(0.3)
    const sp = f(spill)
    const k001 = f(0.01)
    const n = x.w * x.h
    const d = x.data
    const out = tk.tensor(3, x.h, x.w)
    const o = out.data
    for (let i = 0; i < n; i++) {
      let r = d[i]!
      let g = d[n + i]!
      let b = d[2 * n + i]!
      const [h, s] = hsv(r, g, b)
      let dh = f(f(h - kh) % 1.0)
      if (dh !== 0 && dh < 0) dh = f(dh + 1.0)
      dh = f(Math.min(dh, f(1.0 - dh)) * 2.0)
      const ds = Math.abs(f(s - ks))
      const dist = f(f(dh * k07) + f(ds * k03))
      let keep = f(f(dist - lo) / span)
      keep = keep < 0 ? 0 : keep > 1 ? 1 : keep
      const inv = f(1.0 - keep)
      if (spill > 0.0) {
        const amt = f(inv * sp)
        if (amt > k001) {
          const pull = (v: number, kc: number) => {
            const q = f(v - f(f(v * amt) * kc))
            return q < 0 ? 0 : q > 1 ? 1 : q
          }
          r = pull(r, key[0]!)
          g = pull(g, key[1]!)
          b = pull(b, key[2]!)
        }
      }
      o[i] = f(f(r * keep) + f(bg[0]! * inv))
      o[n + i] = f(f(g * keep) + f(bg[1]! * inv))
      o[2 * n + i] = f(f(b * keep) + f(bg[2]! * inv))
    }
    return { out: clampInPlace(out) }
  }

  // ── LUT ───────────────────────────────────────────────────────────────────

  /**
   * LUT (:540-579): the frame graded through the 3-D table the plan read and
   * hands over as `state` (float32, channel-first: 3 × b × g × r), the grid
   * (r, g, b)·2 − 1 of the clamped frame, grid_sample (trilinear,
   * align_corners=True, border; kn.gridSample3d); strength below 0.999 lerps
   * with the frame; clamped. The table goes back as the state for the next
   * frame. EXACT (torch's 3-D loop reproduced, fused multiply-adds included).
   */
  function lut(inputs: Tensor[], p: Record<string, unknown>, state: ArrayBuffer | undefined, _index?: number, _count?: number, stop?: () => boolean): VideoOpResult {
    const x = inputs[0]
    if (!x) throw new Error('A video frame is missing')
    if (!state) throw new Error('The LUT’s table is missing')
    const vol = new Float32Array(state)
    const size = Math.round(Math.cbrt(vol.length / 3))
    if (!(size >= 1 && size * size * size * 3 === vol.length)) throw new Error('The LUT’s table is the wrong size')
    const n = x.w * x.h
    const d = x.data
    const gx = new Float32Array(n)
    const gy = new Float32Array(n)
    const gz = new Float32Array(n)
    const c01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
    for (let i = 0; i < n; i++) {
      gx[i] = f(f(c01(d[i]!) * 2.0) - 1.0)
      gy[i] = f(f(c01(d[n + i]!) * 2.0) - 1.0)
      gz[i] = f(f(c01(d[2 * n + i]!) * 2.0) - 1.0)
    }
    const graded = kn.gridSample3d(vol, 3, size, size, size, gx, gy, gz, stop)
    const out = tk.tensor(3, x.h, x.w)
    const s = p.strength as number
    const lerp = s < 0.999
    const a = f(1.0 - s)
    const bw = f(s)
    for (let ch = 0; ch < 3; ch++) {
      const gch = graded[ch]!
      for (let i = 0; i < n; i++) out.data[ch * n + i] = lerp ? f(f(d[ch * n + i]! * a) + f(gch[i]! * bw)) : gch[i]!
    }
    return { out: clampInPlace(out), state }
  }

  // ── 3-way color ───────────────────────────────────────────────────────────

  /**
   * 3-way color (:612-624): (x·gain + lift) clamped at 0, to the power
   * 1 / max(gamma, 0.05) per channel, clamped to [0, 1]; the widgets
   * rounded to float32 as torch.tensor does. EXACT at gamma 1; else LIBRARY
   * (pow: torch's Sleef against this runtime's).
   */
  function threeWay(inputs: Tensor[], p: Record<string, unknown>): VideoOpResult {
    const x = inputs[0]
    if (!x) throw new Error('A video frame is missing')
    const n = x.w * x.h
    const out = tk.tensor(3, x.h, x.w)
    const chans = ['r', 'g', 'b'] as const
    for (let ch = 0; ch < 3; ch++) {
      const gain = f(p[`gain_${chans[ch]}`] as number)
      const lift = f(p[`lift_${chans[ch]}`] as number)
      const e = f(1.0 / Math.max(f(p[`gamma_${chans[ch]}`] as number), f(0.05)))
      for (let i = 0; i < n; i++) {
        let v = f(f(x.data[ch * n + i]! * gain) + lift)
        v = v < 0 ? 0 : v + 0
        v = e === 1 ? v : f(Math.pow(v, e))
        out.data[ch * n + i] = v < 0 ? 0 : v > 1 ? 1 : v
      }
    }
    return { out }
  }

  return { hexRgb, aspectLayout, autoPanScores, kenBurns, aspect, chroma, lut, threeWay }
}

export type LookCore = ReturnType<typeof lookCore>

// ── The LUT file (main thread only) ─────────────────────────────────────────

/** Why a .cube file won't load, in plain words. */
export const LUT_WORDS = {
  notText: 'This LUT file isn’t text',
  noSize: 'This LUT file has no LUT_3D_SIZE line or no table',
  badSize: 'This LUT file’s LUT_3D_SIZE isn’t a whole number',
  badDomain: 'This LUT file’s DOMAIN line isn’t three numbers',
  countWrong: 'This LUT file’s table doesn’t have LUT_3D_SIZE³ rows',
} as const

/** Python's str.strip()/split() blanks. */
const BLANKS = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const STRIP = new RegExp(`^[${BLANKS}]+|[${BLANKS}]+$`, 'g')
const SPLIT = new RegExp(`[${BLANKS}]+`)
/** int()'s and float()'s own blanks (not U+001C–U+001F). */
const NUM_STRIP = /^[\t\n\v\f\r \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g
const PY_INT = /^[+-]?\d(?:_?\d)*$/
const DIGITS = '\\d(?:_?\\d)*'
const PY_FLOAT = new RegExp(`^[+-]?(?:(?:${DIGITS}(?:\\.(?:${DIGITS})?)?|\\.${DIGITS})(?:[eE][+-]?${DIGITS})?|inf|infinity|nan)$`, 'i')

function pyInt(s: string): number | null {
  const t = s.replace(NUM_STRIP, '')
  return PY_INT.test(t) ? Number.parseInt(t.replace(/_/g, ''), 10) : null
}
function pyFloat(s: string): number | null {
  const t = s.replace(NUM_STRIP, '')
  if (!PY_FLOAT.test(t)) return null
  const body = t.toLowerCase().replace(/^[+-]/, '')
  const neg = t.startsWith('-')
  if (body === 'nan') return Number.NaN
  if (body === 'inf' || body === 'infinity') return neg ? -Infinity : Infinity
  return Number(t.replace(/_/g, ''))
}

/**
 * `_load_cube_lut` (nodes_video_pro.py:474-509) of a file's bytes: UTF-8 text
 * read line by line as Python's text mode reads it (\r\n and \r end a line);
 * each line stripped; blank and '#' lines skipped; LUT_3D_SIZE read with
 * int(); DOMAIN_MIN / DOMAIN_MAX read with float() (a bad one fails, as in
 * Python) and unused; LUT_1D_SIZE and TITLE skipped; any other line of
 * exactly three parts a row when all three are floats (else skipped). The
 * rows must number size³. Returns the table channel-first (3 × b × g × r,
 * float32, R fastest as .cube lists it), or the plain reason it won't load.
 */
export function parseCubeLut(bytes: Uint8Array): { size: number; table: Float32Array } | { error: string } {
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { return { error: LUT_WORDS.notText } }
  let size: number | null = null
  const rows: number[] = []
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.replace(STRIP, '')
    if (!line || line.startsWith('#')) continue
    const upper = line.toUpperCase()
    const parts = line.split(SPLIT)
    if (upper.startsWith('LUT_3D_SIZE')) {
      const v = parts.length > 1 ? pyInt(parts[1]!) : null
      if (v === null) return { error: LUT_WORDS.badSize }
      size = v
      continue
    }
    if (upper.startsWith('DOMAIN_MIN') || upper.startsWith('DOMAIN_MAX')) {
      if (parts.slice(1, 4).some(x => pyFloat(x) === null)) return { error: LUT_WORDS.badDomain }
      continue
    }
    if (upper.startsWith('LUT_1D_SIZE') || upper.startsWith('TITLE')) continue
    if (parts.length === 3) {
      const v = parts.map(pyFloat)
      if (v.some(x => x === null)) continue
      rows.push(v[0]!, v[1]!, v[2]!)
    }
  }
  if (size === null || !rows.length) return { error: LUT_WORDS.noSize }
  const count = rows.length / 3
  if (size < 1 || count !== size ** 3) return { error: LUT_WORDS.countWrong }
  const cube = size ** 3
  const table = new Float32Array(3 * cube)
  for (let i = 0; i < cube; i++) for (let c = 0; c < 3; c++) table[c * cube + i] = Math.fround(rows[i * 3 + c]!)
  return { size, table }
}
