/**
 * Cells and glyphs (family `effects-cells`, step 3 R2.6): Pixelate, Halftone,
 * Kuwahara and Ascii, built on R2.2's area / nearest resizes, avg pooling
 * and remainder.
 *
 * SELF-CONTAINED apart from its arguments (the tensor core and the kernels),
 * as ../../pixels/core.ts is: the compositor worker composes it from its
 * source text. Do not reference anything from outside this body but `k` and
 * `kn`.
 *
 * Each op takes the node's tensors by input name, its widgets as ComfyUI's
 * validation converted them (Ascii's glyph atlas already read on the main
 * thread, effects/table.ts `prepare` and ../asciiGlyphs.ts), a Stop check,
 * the effect's batch state, and the picture's index in the batch Python
 * worked on and that batch's size. FLOAT32, OP BY OP as torch: every
 * product, sum and difference rounded, a Python double scalar rounded to
 * float32 once where it meets a tensor (a comparison too), and a Python
 * expression of scalars worked out in double first.
 *
 * Every class is EXACT (R2 rule 10): float32 bit for bit with Python.
 * Halftone's cos / sin are Python doubles (scalars, rounded to float32 once),
 * Ascii's gamma a pow whose exponent torch may have no special case for
 * (kernels.ts powScalar): it only decides a rounded glyph index, and the
 * fixtures hold it to Python's bits.
 */
import type { EffectResult, Tensor, TensorCore } from './tensor'
import type { KernelsCore } from './kernels'

type Inputs = Record<string, Tensor>
type Params = Record<string, unknown>
type Stop = (() => boolean) | undefined

/** Ascii's glyphs for one node (../asciiGlyphs.ts asciiAtlasFor): each distinct character's cell × cell bitmap, and the ramp's glyph by position. */
export interface AsciiAtlas {
  cell: number
  /** Distinct glyphs, cell × cell uint8 each, row-major (the float is u / 255). */
  glyphs: Uint8Array
  /** The ramp, light to dark: position → its glyph in `glyphs`. */
  ramp: Int32Array
}

export function cellsCore(k: TensorCore, kn: KernelsCore) {
  const f = Math.fround

  // ── Shared steps ────────────────────────────────────────────────────────

  /** A Stop check between single passes that run inside a kernel with no Stop of its own. */
  function stopNow(stop: Stop): void {
    if (stop?.()) throw new Error('Stopped')
  }

  /** torch.round (nearbyint): halves to the even neighbour. */
  function rne(x: number): number {
    const r = Math.round(x)
    return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r
  }

  /** Python's a % b of two ints (floor modulo), b > 0. */
  const pyMod = (a: number, b: number) => ((a % b) + b) % b

  /** torch.remainder of two float32 (fmod, then + b where the signs differ). */
  function rem(a: number, b: number): number {
    let m = f(a % b)
    if (m !== 0 && (b < 0) !== (m < 0)) m = f(m + b)
    return m
  }

  /** `.clamp(0, 1)` in place (an intermediate or a result whose values never hold −0). */
  function clampInPlace(t: Tensor, stop: Stop): Tensor {
    const d = t.data
    const n = t.w * t.h
    k.rows(t.h, stop, (y) => {
      for (let c = 0; c < t.c; c++) {
        for (let i = c * n + y * t.w, end = i + t.w; i < end; i++) d[i] = kn.clamp01(d[i]!)
      }
    })
    return t
  }

  /**
   * The node's last `.clamp(0, 1)` over its (B, H, W, C) contiguous result,
   * in place: torch's vector loop turns −0 into +0; its scalar tails
   * (kernels.ts inScalarTail, over the whole batch in memory order) keep it
   * (as tone.ts `finish`).
   */
  function finish(t: Tensor, stop: Stop, index: number, count: number): Tensor {
    const n = t.w * t.h
    const C = t.c
    const total = count * n * C
    const base = index * n * C
    const d = t.data
    k.rows(t.h, stop, (y) => {
      for (let i = y * t.w, end = i + t.w; i < end; i++) {
        for (let c = 0; c < C; c++) {
          const v = d[c * n + i]!
          d[c * n + i] = Object.is(v, -0) && kn.inScalarTail(base + i * C + c, total, kn.TORCH_THREADS) ? -0 : kn.clamp01(v)
        }
      }
    })
    return t
  }

  /** `_luma` of a picture as a 1-channel tensor: (0.2126·r + 0.7152·g) + 0.0722·b, op by op. */
  const lumaOf = (x: Tensor, stop: Stop): Tensor => ({ c: 1, h: x.h, w: x.w, data: k.luma709(x, stop) })

  // ── nodes_stylize.py ────────────────────────────────────────────────────

  /**
   * Pixelate (nodes_stylize.py:33-44): size 1 is a clamp; otherwise an area
   * resize of the permuted (channels-last) picture to (max(1, h // n),
   * max(1, w // n)) — a mean to 1 × 1, whose sum the batch splits — then
   * nearest back to (h, w), then the clamp. EXACT.
   */
  function Pixelate(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const x = inp.image!
    const n = Math.max(1, Math.trunc(p.size as number))
    if (n === 1) return { outputs: [finish({ c: x.c, h: x.h, w: x.w, data: new Float32Array(x.data) }, stop, index, count)], preview: null }
    const small = kn.resizeArea(x, Math.max(1, Math.floor(x.h / n)), Math.max(1, Math.floor(x.w / n)), { cl: true, batch: count, index, stop })
    stopNow(stop)
    const big = kn.resizeNearest(small, x.h, x.w)
    return { outputs: [clampInPlace(big, stop)], preview: null }
  }

  // ── nodes_glsl_lens.py ──────────────────────────────────────────────────

  /**
   * Halftone (nodes_glsl_lens.py:80-110): each pixel's (x, y) rotated by the
   * angle (cos, sin as Python doubles, rounded to float32 where they meet the
   * grid), its place in the cell (torch.remainder, − cell / 2) and its
   * distance from the cell's centre; the luma's avg_pool2d(cell, stride 1,
   * pad cell // 2) — h + 1 rows when the cell is even — nearest back to
   * (h, w); a dot where the distance is under (1 − avg)·0.55·cell. Dark dots
   * on white on every channel. EXACT.
   */
  function Halftone(inp: Inputs, p: Params, stop?: Stop): EffectResult {
    const x = inp.image!
    const cell = p.cell_size as number
    const angle = p.angle as number
    const rad = angle * (Math.PI / 180)
    const cs = k.s32(Math.cos(rad))
    const sn = k.s32(Math.sin(rad))
    const cellF = k.s32(cell)
    const half = k.s32(cell / 2)
    const maxR = k.s32(cell * 0.55)
    const { h, w } = x
    const luma = lumaOf(x, stop)
    const pooled = kn.avgPool2d(luma, cell, Math.floor(cell / 2), stop)
    stopNow(stop)
    const avg = kn.resizeNearest(pooled, h, w).data
    const out = k.tensor(x.c, h, w)
    const n = h * w
    k.rows(h, stop, (y) => {
      for (let xi = 0, i = y * w; xi < w; xi++, i++) {
        const rx = f(f(xi * cs) + f(y * sn))
        const ry = f(f(-xi * sn) + f(y * cs))
        const u = f(rem(rx, cellF) - half)
        const v = f(rem(ry, cellF) - half)
        const d = f(Math.sqrt(f(f(u * u) + f(v * v))))
        const target = f(f(1 - avg[i]!) * maxR)
        const value = d < target ? 0 : 1
        for (let c = 0; c < x.c; c++) out.data[c * n + i] = value
      }
    })
    return { outputs: [out], preview: null }
  }

  // ── nodes_glsl_stylize.py ───────────────────────────────────────────────

  /**
   * Kuwahara (nodes_glsl_stylize.py:120-148): k = r + 1; the mean and the
   * mean of squares by avg_pool2d(k, stride 1, pad k // 2) — one pixel larger
   * each way when k is even (an odd radius), which the output keeps; the
   * variance (m2 − m²).clamp(min=0) summed over EVERY channel (alpha too);
   * the four quadrants as torch.roll of the means and variances by
   * (−r // 2, −r // 2), (r // 2, −r // 2), (−r // 2, r // 2), (r // 2, r // 2)
   * (Python's floor division); per pixel the first of the lowest variance
   * (argmin), its means gathered; the clamp. EXACT.
   */
  function Kuwahara(inp: Inputs, p: Params, stop?: Stop): EffectResult {
    const x = inp.image!
    const r = Math.max(1, Math.trunc(p.radius as number))
    const kk = r + 1
    const pad = Math.floor(kk / 2)
    const m = kn.avgPool2d(x, kk, pad, stop)
    const sq = k.tensor(x.c, x.h, x.w)
    for (let i = 0; i < x.data.length; i++) sq.data[i] = f(x.data[i]! * x.data[i]!)
    const m2 = kn.avgPool2d(sq, kk, pad, stop)
    const H = m.h
    const W = m.w
    const n = H * W
    const C = x.c
    const variance = new Float32Array(n)
    k.rows(H, stop, (y) => {
      for (let i = y * W, end = i + W; i < end; i++) {
        let s = 0
        for (let c = 0; c < C; c++) {
          const mv = m.data[c * n + i]!
          let v = f(m2.data[c * n + i]! - f(mv * mv))
          if (!(v >= 0)) v = v === v ? 0 : v
          s = f(s + v)
        }
        variance[i] = s
      }
    })
    const a = Math.floor(-r / 2)
    const b = Math.floor(r / 2)
    const shifts: [number, number][] = [[a, a], [b, a], [a, b], [b, b]]
    const out = k.tensor(C, H, W)
    k.rows(H, stop, (y) => {
      for (let xi = 0, i = y * W; xi < W; xi++, i++) {
        let from = -1
        let bestVar = 0
        for (const [dy, dx] of shifts) {
          const j = pyMod(y - dy, H) * W + pyMod(xi - dx, W)
          const v = variance[j]!
          // argmin: the first of the lowest (a NaN is the lowest, as torch's argmin takes it).
          if (from < 0 || v < bestVar || (v !== v && bestVar === bestVar)) { from = j; bestVar = v }
        }
        for (let c = 0; c < C; c++) out.data[c * n + i] = m.data[c * n + from]!
      }
    })
    return { outputs: [clampInPlace(out, stop)], preview: null }
  }

  /**
   * Ascii (nodes_glsl_stylize.py:274-367): the picture rolled by (pos_y, pos_x)
   * (Python's %), cropped to whole cells; each cell's luma mean
   * (avg_pool2d(cell)), clamped and raised to gamma unless |gamma − 1| ≤
   * 1e-3; its index into the ramp, (1 − mean)·(n − 1) (the mean itself when
   * invert_order) + phase·(n − 1), rounded half to even, floor-mod n; the
   * glyph's bitmap (u / 255) across the cell. Monochrome: the glyph on three
   * channels; texture: × the cell's mean colour (avg_pool2d, nearest back),
   * every channel. Over a background: white less the glyph (monochrome in
   * order), the glyph (inverted, or texture); no background: 0 + the glyph.
   * Padded back to (h, w) with 1 (white background) or 0, rolled back,
   * clamped; blended with the picture (_apply_blend), mixed when mix < 0.999,
   * clamped. EXACT.
   *
   * Python raises: a picture smaller than a cell (avg_pool2d of nothing), and
   * a 4-channel picture in monochrome (3 channels) wherever the two meet —
   * padding, a blend other than normal, a mix. In monochrome with no
   * padding, normal and mix ≥ 0.999, a 4-channel picture comes out RGB.
   * Both are refused here before any pixel work.
   */
  function Ascii(inp: Inputs, p: Params, stop?: Stop, _s?: unknown, index = 0, count = 1): EffectResult {
    const x = inp.image!
    const atlas = p.atlas as AsciiAtlas
    const cell = Math.max(4, Math.trunc(p.cell_size as number))
    if (!atlas || atlas.cell !== cell) throw new Error('The characters for this effect were not read')
    const nChars = atlas.ramp.length
    const { h, w, c: C } = x
    const texture = p.color_mode === 'texture'
    const background = p.background as boolean
    const invert = p.invert_order as boolean
    const blend = p.blend_mode as string
    const mix = p.mix as number
    const gamma = p.gamma as number
    const phase = p.phase as number
    const h2 = Math.floor(h / cell) * cell
    const w2 = Math.floor(w / cell) * cell
    if (h2 === 0 || w2 === 0) throw new Error(k.EFFECT_ERRORS.tooSmall)
    const padded = h2 !== h || w2 !== w
    const OC = texture ? C : 3
    const blends = blend === 'multiply' || blend === 'screen' || blend === 'overlay'
    if (OC !== C && (padded || blends || mix < 0.999)) {
      throw new Error(k.EFFECT_ERRORS.needsRgb)
    }
    const ox = pyMod(Math.trunc(p.pos_x as number), w)
    const oy = pyMod(Math.trunc(p.pos_y as number), h)
    const n = h * w
    const n2 = h2 * w2
    // The cropped picture of the rolled one: cropped[Y][X] = image[(Y − oy) mod h][(X − ox) mod w].
    const cropped = k.tensor(C, h2, w2)
    k.rows(h2, stop, (Y) => {
      const sy = pyMod(Y - oy, h) * w
      for (let X = 0; X < w2; X++) {
        const si = sy + pyMod(X - ox, w)
        for (let c = 0; c < C; c++) cropped.data[c * n2 + Y * w2 + X] = x.data[c * n + si]!
      }
    })
    let means = kn.avgPool2dStrided(lumaOf(cropped, stop), cell, stop)
    if (Math.abs(gamma - 1.0) > 1e-3) {
      for (let i = 0; i < means.data.length; i++) means.data[i] = kn.clamp01(means.data[i]!)
      means = kn.powScalar(means, gamma)
    }
    const sh = means.h
    const sw = means.w
    const last = nChars - 1
    const shift = k.s32(phase * last)
    const glyphOf = new Int32Array(sh * sw)
    for (let i = 0; i < glyphOf.length; i++) {
      const L = means.data[i]!
      const base = invert ? f(L * last) : f(f(1 - L) * last)
      const r = rne(f(base + shift))
      // .long(): an integral float (NaN reads 0, as arm64 converts it).
      const idx = r === r ? pyMod(r, nChars) : 0
      glyphOf[i] = atlas.ramp[idx]!
    }
    stopNow(stop)
    const unit = new Float32Array(256)
    for (let u = 0; u < 256; u++) unit[u] = f(u / 255)
    const cc = cell * cell
    // Texture: each cell's mean colour, nearest back to the cropped size.
    const tint = texture ? kn.resizeNearest(kn.avgPool2dStrided(cropped, cell, stop), h2, w2) : null
    stopNow(stop)
    const padValue = background && !texture && !invert ? 1 : 0
    const layer = k.tensor(OC, h, w)
    // The layer before the roll back: L[Y][X], for Y < h2 and X < w2 the glyph layer, else the pad.
    // After the roll back, out[y][x] = L[(y + oy) mod h][(x + ox) mod w].
    k.rows(h, stop, (y) => {
      const Y = (y + oy) % h
      for (let xi = 0, i = y * w; xi < w; xi++, i++) {
        const X = (xi + ox) % w
        if (Y >= h2 || X >= w2) {
          for (let c = 0; c < OC; c++) layer.data[c * n + i] = padValue
          continue
        }
        const cy = Math.floor(Y / cell)
        const cx = Math.floor(X / cell)
        const g = unit[atlas.glyphs[glyphOf[cy * sw + cx]! * cc + (Y - cy * cell) * cell + (X - cx * cell)]!]!
        for (let c = 0; c < OC; c++) {
          const glyph = tint ? f(g * tint.data[c * n2 + Y * w2 + X]!) : g
          let v: number
          if (!background) v = f(0 + glyph)
          else if (texture || invert) v = glyph
          else v = f(1 - glyph)
          layer.data[c * n + i] = kn.clamp01(v)
        }
      }
    })
    // _apply_blend against the picture, then the mix.
    const keep = k.s32(1 - mix)
    const take = k.s32(mix)
    const mixed = mix < 0.999
    const out = k.tensor(OC, h, w)
    k.rows(h, stop, (y) => {
      for (let c = 0; c < OC; c++) {
        for (let i = c * n + y * w, end = i + w; i < end; i++) {
          const over = layer.data[i]!
          const base = x.data[i]!
          let v: number
          if (blend === 'multiply') v = f(base * over)
          else if (blend === 'screen') v = f(1 - f(f(1 - base) * f(1 - over)))
          else if (blend === 'overlay') v = base < 0.5 ? f(f(2 * base) * over) : f(1 - f(f(2 * f(1 - base)) * f(1 - over)))
          else v = over
          out.data[i] = mixed ? f(f(base * keep) + f(v * take)) : v
        }
      }
    })
    return { outputs: [finish(out, stop, index, count)], preview: null }
  }

  return { Pixelate, Halftone, Kuwahara, Ascii }
}

export type CellsCore = ReturnType<typeof cellsCore>
