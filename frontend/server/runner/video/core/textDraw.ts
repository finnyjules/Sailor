/**
 * Text on video (step 3, R6.8): Text clip (nodes_text.py:67-165) and Caption
 * track (nodes_video_pro.py:375-466), one output frame at a time, on the
 * worker.
 *
 * The letters themselves are drawn on the main thread (../text.ts: the font,
 * the layout and each letter's coverage, rendered once per text); this core
 * only lays that coverage onto a frame with Pillow's own integer blend of an
 * ink colour through an 8-bit mask (`draw_bitmap` → `fill_mask_L`,
 * libImaging/Paste.c):
 *
 *   out = DIV255(in · (255 − m) + ink · m),  DIV255(a) = ((a + 128) + ((a + 128) >> 8)) >> 8
 *
 * Caption track draws the outline colour through the outline's mask, then the
 * text colour through the text's, over each frame's 8-bit form (Python's
 * `(x · 255).clip(0, 255).astype(uint8)`, the frame back as u8 / 255); a
 * frame with no caption is handed on as it came (its 8-bit form is itself:
 * trunc(f32(f32(k / 255) · 255)) = k for every k). Text clip is the
 * background with the text drawn once over it.
 *
 * SELF-CONTAINED apart from its arguments, as ./time.ts is: the compositor
 * worker composes it from its source text (../cores.ts). `vx` turns an rgb24
 * frame into its tensor; `look` gives `_hex_rgb`'s port (both nodes' parse).
 */
import type { Tensor, TensorCore } from '../../effects/core/tensor'
import type { FramesCore, VideoOpResult } from './time'

/** A text's coverage, cut to the frame: its place, its size, the letters' mask and the outline's (or none). */
export interface TextMask { x: number; y: number; w: number; h: number; fill: Uint8Array; line: Uint8Array | null }

export function textDrawCore(_tk: TensorCore, vx: FramesCore, look: { hexRgb(s: unknown, fallback: readonly [number, number, number]): [number, number, number] }) {
  const f = Math.fround

  /** A colour widget as the nodes read it: `_hex_rgb`, then int(c · 255) (the same whole number back), held to a byte. */
  function ink(s: unknown, fallback: readonly [number, number, number]): [number, number, number] {
    const c = look.hexRgb(s, fallback)
    return c.map(v => Math.min(255, Math.max(0, Math.trunc(v * 255)))) as [number, number, number]
  }

  /** Pillow's fill_mask_L: `ink` through `mask` (w × h at (x, y)) onto an rgb24 frame of width W, in place. */
  function blend(rgb: Uint8Array, W: number, m: TextMask, mask: Uint8Array, c: readonly number[]): void {
    for (let y = 0; y < m.h; y++) {
      let o = ((m.y + y) * W + m.x) * 3
      let i = y * m.w
      for (let x = 0; x < m.w; x++, i++, o += 3) {
        const a = mask[i]!
        if (a === 0) continue
        const b = 255 - a
        for (let k = 0; k < 3; k++) {
          const t = rgb[o + k]! * b + c[k]! * a + 128
          rgb[o + k] = ((t >> 8) + t) >> 8
        }
      }
    }
  }

  /**
   * Text clip: the background (`bg_color`, black when unreadable) with the
   * text (`color`, white when unreadable) drawn through the whole frame's
   * mask, carried as the op's state (read once, ../text.ts textClipMask).
   * Every frame of the clip is this one frame.
   */
  function clip(_inputs: Tensor[], p: Record<string, unknown>, state: ArrayBuffer | undefined): VideoOpResult {
    const W = Math.trunc(p.width as number)
    const H = Math.trunc(p.height as number)
    if (!state || state.byteLength !== W * H) throw new Error('The text clip’s letters are missing')
    const mask = new Uint8Array(state)
    const bg = ink(p.bg_color, [0, 0, 0])
    const rgb = new Uint8Array(W * H * 3)
    for (let i = 0; i < W * H; i++) {
      rgb[3 * i] = bg[0]
      rgb[3 * i + 1] = bg[1]
      rgb[3 * i + 2] = bg[2]
    }
    blend(rgb, W, { x: 0, y: 0, w: W, h: H, fill: mask, line: null }, mask, ink(p.color, [1, 1, 1]))
    return { out: vx.fromRgb(rgb, W, H), state }
  }

  /**
   * Caption track, one frame: `_cap` is this frame's caption's coverage
   * (null: no caption covers the frame, handed on). The pixels under the
   * mask are taken to 8 bits, the outline then the text drawn, and put back
   * as u8 / 255; every other pixel is its own 8-bit value already.
   */
  function caption(inputs: Tensor[], p: Record<string, unknown>): VideoOpResult {
    const x = inputs[0]
    if (!x) throw new Error('A video frame is missing')
    const m = p._cap as TextMask | null | undefined
    if (!m) return { out: x }
    const W = x.w
    const n = x.w * x.h
    if (m.x < 0 || m.y < 0 || m.x + m.w > x.w || m.y + m.h > x.h) throw new Error('A caption was placed outside its frame')
    // The region's 8-bit form (row-major rgb24 of the box).
    const box = new Uint8Array(m.w * m.h * 3)
    for (let y = 0; y < m.h; y++) {
      for (let xx = 0; xx < m.w; xx++) {
        const src = (m.y + y) * W + m.x + xx
        const o = (y * m.w + xx) * 3
        for (let k = 0; k < 3; k++) {
          const v = Math.trunc(f(x.data[k * n + src]! * 255))
          box[o + k] = v < 0 ? 0 : v > 255 ? 255 : v
        }
      }
    }
    const local: TextMask = { ...m, x: 0, y: 0 }
    if (m.line) blend(box, m.w, local, m.line, ink(p.outline_color, [0, 0, 0]))
    blend(box, m.w, local, m.fill, ink(p.color, [1, 1, 1]))
    for (let y = 0; y < m.h; y++) {
      for (let xx = 0; xx < m.w; xx++) {
        const dst = (m.y + y) * W + m.x + xx
        const o = (y * m.w + xx) * 3
        for (let k = 0; k < 3; k++) x.data[k * n + dst] = f(box[o + k]! / 255)
      }
    }
    return { out: x }
  }

  return { ink, blend, clip, caption }
}

export type TextDrawCore = ReturnType<typeof textDrawCore>
