/**
 * Text on video, the main thread's part (step 3, R6.8): the font, the layout
 * and the letters' coverage for Text clip (nodes_text.py:67-165) and Caption
 * track (nodes_video_pro.py:375-466). The worker lays the coverage onto the
 * frames (./core/textDraw.ts).
 *
 * The user's matching rule (applied to R6.8 by the controller): text must be
 * readable and placed as Python places it (the same anchors, sizes, colours,
 * wrapping width and timing), not letter-for-letter FreeType. So:
 *   - **The font** (ruling (b)): Python's `_FONT_PATHS` in order, the first
 *     file that reads (face 0 of a collection: Helvetica on this Mac); where
 *     none does, the bundled DejaVu Sans Bold (./fonts, copied from the
 *     venv's matplotlib, its licence beside it), never Pillow's 10-pixel
 *     fallback. Hosted reads ONLY the bundled file, never a system path.
 *   - **The layout** is Pillow's basic layout's arithmetic, from fontkit's
 *     reading of the same font: one glyph per character from the font's cmap
 *     (no shaping: Pillow's basic layout has none), each advance rounded to
 *     a whole pixel (FreeType's hinted advances), the ascender rounded up,
 *     each letter's ink top and bottom rounded (hinting snaps them to the
 *     pixel grid) and its sides floor/ceil'd; `textbbox((0, 0), s)` as Pillow's
 *     anchor `la` (x from min(0, ink) to max(advance, ink); y the ink's, the
 *     ascender line at 0). Python's wrap, line height, alignment and caption
 *     placement are then followed exactly on those numbers.
 *   - **The letters** are fontkit's outlines drawn by sharp (librsvg) as SVG
 *     paths, antialiased: the coverage the worker blends. An outline is the
 *     letters' paths stroked round at twice its width (Python draws the text
 *     at every whole offset within a disc of that radius: the same shape).
 *
 * Text is the person's content and is NEVER put into the SVG: only numbers
 * and the font's own path data (fontkit's toSVG of each glyph) are.
 */
/// <reference path="../../../app/lib/vectortype/fontkit.d.ts" />
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as fontkit from 'fontkit'
import sharp from 'sharp'
import { pyIntOf, pySplitlines, pyStrip } from '#shared/runner/pyText'
import { MEDIA_EFFECT_WORDS } from '#shared/runner/mediaEffects'
import type { TextMask } from './core/textDraw'

/** nodes_text.py `_FONT_PATHS`, in Python's order (face 0 of a collection, as ImageFont.truetype's index 0). */
export const TEXT_FONT_PATHS: readonly string[] = [
  '/System/Library/Fonts/Supplemental/Helvetica.ttc',
  '/System/Library/Fonts/Helvetica.ttc',
  '/System/Library/Fonts/SFNS.ttf',
  '/System/Library/Fonts/SFNSDisplay.ttf',
  '/Library/Fonts/Arial.ttf',
  '/System/Library/Fonts/Menlo.ttc',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
]


/** Tests only: the system list and the bundled file to use instead (undefined: the usual ones). */
let override: { system?: readonly string[]; bundled?: string | null } = {}
export function __setTextFontsForTests(o: { system?: readonly string[]; bundled?: string | null } | null): void {
  override = o ?? {}
  fonts.clear()
}

/** Where the bundled DejaVu Sans Bold is: beside this module (dev, tests), or under the server's folder from the working directory. */
export function bundledFontFile(): string | null {
  if (override.bundled !== undefined) return override.bundled && existsSync(override.bundled) ? override.bundled : null
  const candidates = [
    (() => { try { return fileURLToPath(new URL('./fonts/DejaVuSans-Bold.ttf', import.meta.url)) } catch { return null } })(),
    join(process.cwd(), 'server', 'runner', 'video', 'fonts', 'DejaVuSans-Bold.ttf'),
    join(process.cwd(), 'frontend', 'server', 'runner', 'video', 'fonts', 'DejaVuSans-Bold.ttf'),
  ].filter((c): c is string => !!c)
  return candidates.find(c => existsSync(c)) ?? null
}

type Font = fontkit.FontkitFont
const fonts = new Map<string, Font | null>()

/** A font file read and parsed (face 0 of a collection), or null where it isn't there or won't read (Pillow's OSError: the next one). */
function fontAt(path: string): Font | null {
  if (fonts.has(path)) return fonts.get(path)!
  let font: Font | null = null
  try {
    if (existsSync(path)) {
      const got = fontkit.create(readFileSync(path)) as Font & { fonts?: Font[] }
      font = Array.isArray(got.fonts) ? got.fonts[0] ?? null : got
      if (font && !(font.unitsPerEm > 0)) font = null
    }
  }
  catch { font = null }
  fonts.set(path, font)
  return font
}

/** The font text is drawn in (ruling (b)): hosted, the bundled file only; locally, Python's list, then the bundled file. */
export function textFont(hosted: boolean): { font: Font; path: string } | null {
  const list = hosted ? [] : (override.system ?? TEXT_FONT_PATHS)
  for (const p of list) {
    const font = fontAt(p)
    if (font) return { font, path: p }
  }
  const b = bundledFontFile()
  const font = b ? fontAt(b) : null
  return font && b ? { font, path: b } : null
}

// ── Pillow's basic layout, on fontkit's numbers ──────────────────────────────

/** A font at a pixel size: its scale and ascender (rounded up, as FreeType's size metrics). */
export interface Face { font: Font; s: number; asc: number }
export const faceAt = (font: Font, size: number): Face => {
  const s = size / font.unitsPerEm
  return { font, s, asc: Math.ceil(font.ascent * s) }
}

/** A line's measure so far: its pen, its ink's extent (pixels, the ascender line at 0), and its glyphs at their pens. */
interface Measure { pen: number; l: number; r: number; t: number; b: number; glyphs: { g: any; x: number }[] }
const EMPTY: Measure = { pen: 0, l: Infinity, r: -Infinity, t: Infinity, b: -Infinity, glyphs: [] }

/** A measure with `text` appended (one glyph per character, from the cmap; each advance a whole pixel). */
function extend(face: Face, m: Measure, text: string, keepGlyphs: boolean): Measure {
  let { pen, l, r, t, b } = m
  const glyphs = keepGlyphs ? [...m.glyphs] : m.glyphs
  for (const g of face.font.glyphsForString(text)) {
    const bb = g.bbox as { minX: number; minY: number; maxX: number; maxY: number } | undefined
    if (bb && Number.isFinite(bb.minX) && bb.maxX > bb.minX && bb.maxY > bb.minY) {
      l = Math.min(l, pen + Math.floor(bb.minX * face.s))
      r = Math.max(r, pen + Math.ceil(bb.maxX * face.s))
      t = Math.min(t, face.asc - Math.round(bb.maxY * face.s))
      b = Math.max(b, face.asc - Math.round(bb.minY * face.s))
    }
    if (keepGlyphs) glyphs.push({ g, x: pen })
    pen += Math.round((g.advanceWidth as number) * face.s)
  }
  return { pen, l, r, t, b, glyphs }
}

/** `textbbox((0, 0), s)` as Pillow's anchor `la` answers it, from a measure: '' is (0, 0, 0, 0); no ink sits on the ascender line. */
function bboxOf(face: Face, m: Measure, empty: boolean): [number, number, number, number] {
  if (empty) return [0, 0, 0, 0]
  const ink = Number.isFinite(m.l)
  return [Math.min(0, ink ? m.l : 0), ink ? m.t : face.asc, Math.max(m.pen, ink ? m.r : 0), ink ? m.b : face.asc]
}

/** A line laid out: its glyphs at their pens and its textbbox. */
export interface Laid { glyphs: { g: any; x: number }[]; bbox: [number, number, number, number] }
export function layLine(face: Face, text: string): Laid {
  const m = extend(face, EMPTY, text, true)
  return { glyphs: m.glyphs, bbox: bboxOf(face, m, text === '') }
}

/** textbbox((0, 0), s). */
export const textBbox = (face: Face, text: string) => bboxOf(face, extend(face, EMPTY, text, false), text === '')

/** `_wrap` (nodes_text.py:49-64): words split on ' ' only, each trial's textbbox width against max_w (a line always takes its first word). */
export function wrapText(face: Face, text: string, maxW: number): string[] {
  const lines: string[] = []
  const raws = pySplitlines(text)
  for (const raw of raws.length ? raws : ['']) {
    let cur = ''
    let m = EMPTY
    for (const w of raw.split(' ')) {
      const add = (cur ? ' ' : '') + w
      const trial = cur + add
      const tm = extend(face, m, add, false)
      const bb = bboxOf(face, tm, trial === '')
      if (bb[2] - bb[0] <= maxW || !cur) { cur = trial; m = tm }
      else {
        lines.push(cur)
        cur = w
        m = extend(face, EMPTY, w, false)
      }
    }
    lines.push(cur)
  }
  return lines
}

/** A line to draw: Pillow's draw.text((x, y)) origin (the ascender line's left end), fractional as Python's. */
export interface Placed { x: number; y: number; text: string }

/** render_text_to_pil's placement (nodes_text.py:92-120): the lines, and each line's (x, y). */
export function textClipLayout(face: Face, p: Record<string, unknown>): Placed[] {
  const W = Math.trunc(p.width as number)
  const H = Math.trunc(p.height as number)
  const padding = p.padding as number
  const insetX = Math.trunc(W * padding)
  const insetY = Math.trunc(H * padding)
  const maxW = W - 2 * insetX
  const lines = wrapText(face, typeof p.text === 'string' ? p.text : '', maxW)
  const sample = textBbox(face, 'Ag')
  const lineH = (sample[3] - sample[1]) * (p.line_spacing as number)
  const blockH = Math.max(1.0, lineH * lines.length)
  let y = p.v_align === 'top' ? insetY : p.v_align === 'bottom' ? H - insetY - blockH : (H - blockH) / 2.0
  const out: Placed[] = []
  for (const text of lines) {
    const bb = textBbox(face, text)
    const tw = bb[2] - bb[0]
    const x = p.align === 'center' ? (W - tw) / 2.0 : p.align === 'right' ? W - insetX - tw : insetX
    out.push({ x, y, text })
    y += lineH
  }
  return out
}

// ── Caption track's captions ─────────────────────────────────────────────────

/** Python str.split()'s blanks (str.isspace). */
const WS = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const SPLIT3 = new RegExp(`^([^${WS}]+)[${WS}]+([^${WS}]+)[${WS}]+([\\s\\S]+)$`)

/** A caption: frames [s, e) show `text`. */
export interface Caption { s: number; e: number; text: string }

/** execute's parse (nodes_video_pro.py:410-420): `start end Text…` (split(None, 2), int() of each); any other line skipped. EXACT. */
export function captionSegments(captions: unknown): Caption[] {
  const out: Caption[] = []
  for (const line of pySplitlines(typeof captions === 'string' ? captions : '')) {
    const m = SPLIT3.exec(pyStrip(line))
    if (!m) continue
    const s = pyIntOf(m[1]!)
    const e = pyIntOf(m[2]!)
    if (s === null || e === null) continue
    out.push({ s, e, text: m[3]! })
  }
  return out
}

/** The caption frame `i` shows: the LAST one with s ≤ i < e (Python's loop), or null. EXACT. */
export function captionAt(segs: readonly Caption[], i: number): string | null {
  let active: string | null = null
  for (const c of segs) if (c.s <= i && i < c.e) active = c.text
  return active || null
}

/**
 * captionAt for frames asked in order (0, 1, 2, …), as Caption track's feed
 * asks them (R8.3): one sweep over the captions sorted by start, the ones
 * started kept in a heap by their place in the list (the LAST one wins, as
 * Python's loop), the ended ones dropped from its top as they surface. Each
 * caption goes in and out once: O((captions + frames) · log captions), not
 * captions × frames. EXACT: the same caption as captionAt for every frame.
 */
export function captionSweep(segs: readonly Caption[]): (i: number) => string | null {
  const order = segs.map((_, k) => k).sort((a, b) => segs[a]!.s - segs[b]!.s || a - b)
  const heap: number[] = []
  const up = (j: number) => {
    while (j > 0) {
      const p = (j - 1) >> 1
      if (heap[p]! >= heap[j]!) break
      ;[heap[p], heap[j]] = [heap[j]!, heap[p]!]
      j = p
    }
  }
  const pop = () => {
    const last = heap.pop()!
    if (!heap.length) return
    heap[0] = last
    for (let j = 0; ;) {
      const l = 2 * j + 1
      const r = l + 1
      let m = j
      if (l < heap.length && heap[l]! > heap[m]!) m = l
      if (r < heap.length && heap[r]! > heap[m]!) m = r
      if (m === j) break
      ;[heap[m], heap[j]] = [heap[j]!, heap[m]!]
      j = m
    }
  }
  let next = 0
  let last = -Infinity
  return (i: number) => {
    if (i < last) throw new Error('Caption track asked for an earlier frame')
    last = i
    while (next < order.length && segs[order[next]!]!.s <= i) { heap.push(order[next]!); up(heap.length - 1); next++ }
    // A caption that has ended (or never began: e ≤ s) never shows again: dropped when it reaches the top.
    while (heap.length && segs[heap[0]!]!.e <= i) pop()
    return heap.length ? (segs[heap[0]!]!.text || null) : null
  }
}

/** Where Caption track draws `text` on a W × H frame (nodes_video_pro.py:440-450): Python's (x, y). */
export function captionPlace(face: Face, text: string, p: Record<string, unknown>, W: number, H: number): Placed {
  const bb = textBbox(face, text)
  const tw = bb[2] - bb[0]
  const th = bb[3] - bb[1]
  const inset = p.y_inset as number
  const x = (W - tw) / 2 - bb[0]
  const y = p.position === 'top' ? H * inset - bb[1] : p.position === 'middle' ? (H - th) / 2 - bb[1] : H - H * inset - th - bb[1]
  return { x, y, text }
}

// ── The letters' coverage ────────────────────────────────────────────────────

/** A number for the SVG (finite, short). */
const num = (v: number) => (Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : '0')

/** The SVGs a text's coverage is drawn from, and where they sit on the frame. */
export interface TextSvgs { x: number; y: number; w: number; h: number; fill: string; line: string | null }

/** A line ready to draw: its origin (Placed's x, y) and its glyphs at their pens. */
export interface LaidLine { x: number; y: number; glyphs: readonly { g: any; x: number }[] }

/** The letters' ink extent (pixels on the frame, unrounded) of laid lines, or null where nothing has ink. */
export interface InkBox { l: number; r: number; t: number; b: number }

/** A glyph's ink box in font units, or null where it has no ink (a space). */
function inkOf(g: any): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const bb = g.bbox as { minX: number; minY: number; maxX: number; maxY: number } | undefined
  return bb && Number.isFinite(bb.minX) && bb.maxX > bb.minX && bb.maxY > bb.minY ? bb : null
}

function inkBoxOf(face: Face, lines: readonly LaidLine[]): InkBox | null {
  let l = Infinity
  let r = -Infinity
  let t = Infinity
  let b = -Infinity
  for (const p of lines) {
    for (const { g, x } of p.glyphs) {
      const bb = inkOf(g)
      if (!bb) continue
      l = Math.min(l, p.x + x + bb.minX * face.s)
      r = Math.max(r, p.x + x + bb.maxX * face.s)
      t = Math.min(t, p.y + face.asc - bb.maxY * face.s)
      b = Math.max(b, p.y + face.asc - bb.minY * face.s)
    }
  }
  return Number.isFinite(l) ? { l, r, t, b } : null
}

/**
 * The SVGs of `lines` drawn on a W × H frame, cut to the frame (null: nothing
 * of it lands there): the letters, and with `outline` > 0 the letters stroked
 * round at twice its width. Only numbers and the font's own path data (each
 * glyph's outline, fontkit's toSVG, checked to be path commands and numbers
 * only) go into them, never the text.
 */
export function textSvgs(face: Face, lines: readonly Placed[], W: number, H: number, outline: number): TextSvgs | null {
  return laidSvgs(face, lines.map(p => ({ x: p.x, y: p.y, glyphs: layLine(face, p.text).glyphs })), W, H, outline)
}

/**
 * textSvgs on lines already laid out. `box`: the ink extent the cut is taken
 * from, where the lines hold only some of the glyphs (R8.3: a caption's
 * letters that can't land in the frame left out); without it, the lines' own.
 */
export function laidSvgs(face: Face, lines: readonly LaidLine[], W: number, H: number, outline: number, box?: InkBox | null): TextSvgs | null {
  const ink = box === undefined ? inkBoxOf(face, lines) : box
  if (!ink) return null
  const pad = outline + 2
  const x0 = Math.max(0, Math.floor(ink.l - pad))
  const y0 = Math.max(0, Math.floor(ink.t - pad))
  const x1 = Math.min(W, Math.ceil(ink.r + pad))
  const y1 = Math.min(H, Math.ceil(ink.b + pad))
  if (x1 <= x0 || y1 <= y0) return null
  const w = x1 - x0
  const h = y1 - y0
  const paths: string[] = []
  for (const p of lines) {
    for (const { g, x } of p.glyphs) {
      const d = g.path?.toSVG?.() as unknown
      if (typeof d !== 'string' || !d || !PATH_DATA.test(d)) continue
      paths.push(`<path transform="translate(${num(p.x + x - x0)} ${num(p.y + face.asc - y0)}) scale(${num(face.s)} ${num(-face.s)})" d="${d}"/>`)
    }
  }
  if (!paths.length) return null
  const svg = (stroke: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><g fill="#fff"${stroke}>${paths.join('')}</g></svg>`
  return {
    x: x0, y: y0, w, h,
    fill: svg(''),
    line: outline > 0 ? svg(` stroke="#fff" stroke-width="${num((2 * outline) / face.s)}" stroke-linejoin="round" stroke-linecap="round"`) : null,
  }
}

/** A glyph's path data as fontkit writes it: its commands and numbers, nothing else. */
const PATH_DATA = /^[MLQCZ0-9eE.+\- ]*$/

/** The coverage of `lines` on a W × H frame, cut to the frame (./core/textDraw.ts TextMask), drawn by sharp (librsvg, off this thread). */
export async function textMasks(face: Face, lines: readonly Placed[], W: number, H: number, outline: number): Promise<TextMask | null> {
  return svgMasks(textSvgs(face, lines, W, H, outline))
}

async function svgMasks(s: TextSvgs | null): Promise<TextMask | null> {
  if (!s) return null
  const fill = await coverage(s.fill, s.w, s.h)
  const line = s.line ? await coverage(s.line, s.w, s.h) : null
  return { x: s.x, y: s.y, w: s.w, h: s.h, fill, line }
}

/** An SVG's alpha (the coverage), w × h, by sharp. */
async function coverage(svg: string, w: number, h: number): Promise<Uint8Array> {
  const { data, info } = await sharp(Buffer.from(svg), { density: 72 }).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true })
  if (info.width !== w || info.height !== h || data.length !== w * h) throw new Error('The text’s letters came out the wrong size')
  return new Uint8Array(data.buffer, data.byteOffset, data.length)
}

/** Text clip's whole-frame mask (the op's state, ./core/textDraw.ts clip). */
export async function textClipMask(p: Record<string, unknown>, hosted: boolean): Promise<ArrayBuffer> {
  const got = textFont(hosted)
  if (!got) throw new Error(MEDIA_EFFECT_WORDS.textFontMissing)
  const W = Math.trunc(p.width as number)
  const H = Math.trunc(p.height as number)
  const face = faceAt(got.font, Math.trunc(p.font_size as number))
  const m = await textMasks(face, textClipLayout(face, p), W, H, 0)
  const full = new Uint8Array(W * H)
  if (m) for (let y = 0; y < m.h; y++) full.set(m.fill.subarray(y * m.w, (y + 1) * m.w), (m.y + y) * W + m.x)
  return full.buffer
}

/** A caption laid out (R8.3): its lines with only the glyphs that can land in the frame, and the whole block's ink extent. */
export interface CaptionLaid { lines: LaidLine[]; box: InkBox | null }

/** The side margin a wrapped caption keeps from each edge of the frame (live-check fix): 5% of its width. */
export const CAPTION_SIDE_MARGIN = 0.05
/** A wrapped caption's line step, in the height of "Ag" (its ink, Text clip's sample), plus the outline's width. */
export const CAPTION_LINE_SPACING = 1.15

/** The widest a caption line may be on a frame W wide (a wrapped caption's lines; one that fits keeps Python's single line). */
export const captionMaxWidth = (W: number) => Math.max(1, W - 2 * Math.trunc(W * CAPTION_SIDE_MARGIN))

/** A wrapped caption's line step on its face: the "Ag" sample's ink height × the spacing, plus the outline. */
export function captionLineStep(face: Face, outline: number): number {
  const sample = textBbox(face, 'Ag')
  return (sample[3] - sample[1]) * CAPTION_LINE_SPACING + outline
}

/**
 * A caption's lines, each at most `maxW` wide (textbbox width): words joined
 * by ' ' while they fit, a new line at a word; a word wider than a line on
 * its own is broken between letters (each line takes at least one). One pass
 * over the text's glyphs (each word and letter measured once, added to the
 * line's running measure).
 */
export function wrapCaption(face: Face, text: string, maxW: number): string[] {
  const lines: string[] = []
  let cur = ''
  let m = EMPTY
  const width = (mm: Measure, t: string) => { const bb = bboxOf(face, mm, t === ''); return bb[2] - bb[0] }
  for (const word of text.split(' ')) {
    const add = (cur ? ' ' : '') + word
    const tm = extend(face, m, add, false)
    if (!cur || width(tm, cur + add) <= maxW) { cur += add; m = tm }
    else { lines.push(cur); cur = word; m = extend(face, EMPTY, word, false) }
    if (width(m, cur) <= maxW) continue
    // Only a word on a line of its own can be too wide here: break it between letters.
    let piece = ''
    let pm = EMPTY
    for (const ch of Array.from(word)) {
      const next = extend(face, pm, ch, false)
      if (piece && width(next, piece + ch) > maxW) { lines.push(piece); piece = ch; pm = extend(face, EMPTY, ch, false) }
      else { piece += ch; pm = next }
    }
    cur = piece
    m = pm
  }
  lines.push(cur)
  return lines
}

/**
 * A caption laid out to draw (R8.3, ruling (c); wrapped since the live check).
 * - A caption that fits within the frame less its side margins is Python's
 *   one line at Python's place (nodes_video_pro.py:440-450), exactly as before.
 * - A wider one is wrapped (wrapCaption), each line centred, the block kept
 *   at its position: its ink's top at H·y_inset (top), centred (middle), or
 *   its bottom at H − H·y_inset, growing upward (bottom).
 * Of each line, only the glyphs whose ink (with the outline's pad) can reach
 * the frame are kept, and only the lines that can reach it down; the cut is
 * still taken from the whole block's ink extent (`box`), so leaving the rest
 * out changes no pixel.
 */
export function captionLaid(face: Face, text: string, p: Record<string, unknown>, W: number, H: number, outline: number, o: { every?: boolean } = {}): CaptionLaid {
  const maxW = captionMaxWidth(W)
  const whole = textBbox(face, text)
  let placed: Placed[]
  if (whole[2] - whole[0] <= maxW) placed = [captionPlace(face, text, p, W, H)]
  else {
    const rows = wrapCaption(face, text, maxW)
    const sample = textBbox(face, 'Ag')
    const step = captionLineStep(face, outline)
    const blockH = (rows.length - 1) * step + (sample[3] - sample[1])
    const inset = p.y_inset as number
    const top = p.position === 'top' ? H * inset : p.position === 'middle' ? (H - blockH) / 2 : H - H * inset - blockH
    placed = rows.map((row, k) => {
      const bb = textBbox(face, row)
      return { x: (W - (bb[2] - bb[0])) / 2 - bb[0], y: top + k * step - sample[1], text: row }
    })
  }
  const all: LaidLine[] = placed.map(at => ({ x: at.x, y: at.y, glyphs: layLine(face, at.text).glyphs }))
  const box = inkBoxOf(face, all)
  // Tests only: every glyph of every line (the cut's reference).
  if (o.every) return { lines: all, box }
  const pad = outline + 2
  const lines: LaidLine[] = []
  for (const line of all) {
    const glyphs = line.glyphs.filter(({ g, x }) => {
      const bb = inkOf(g)
      return !!bb
        && line.x + x + bb.minX * face.s - pad < W && line.x + x + bb.maxX * face.s + pad > 0
        && line.y + face.asc - bb.maxY * face.s - pad < H && line.y + face.asc - bb.minY * face.s + pad > 0
    })
    if (glyphs.length) lines.push({ x: line.x, y: line.y, glyphs })
  }
  return { lines, box }
}

/**
 * The most lines a caption is drawn in (the work bound's band): for typed
 * captions, the most any of them wraps to on a frame W wide, in every font
 * text may be drawn in here; for wired ones (unknown before the turn), the
 * lines that can fit in the frame: Infinity, the band then the frame's height.
 */
export function captionLinesAtMost(captions: unknown, fontSize: number, W: number, outline: number): number {
  if (typeof captions !== 'string') return Infinity
  const key = `${fontSize}|${W}|${outline}`
  const hit = linesMemo.get(captions)
  if (hit && hit.key === key) return hit.n
  let n = 1
  const maxW = captionMaxWidth(W)
  for (const got of [textFont(true), textFont(false)]) {
    if (!got) continue
    const face = faceAt(got.font, fontSize)
    for (const c of captionSegments(captions)) {
      const bb = textBbox(face, c.text)
      if (bb[2] - bb[0] > maxW) n = Math.max(n, wrapCaption(face, c.text, maxW).length)
    }
  }
  linesMemo.clear()
  linesMemo.set(captions, { key, n })
  return n
}
const linesMemo = new Map<string, { key: string; n: number }>()

/**
 * The tallest a line's letters can be, in ems, over the fonts text may be
 * drawn in here (the bundled one, and this machine's first of Python's list):
 * each font's own box (its head table's), so a caption's drawn band has a
 * bound before its text is known (R8.3: the work figure for wired captions).
 */
export function captionFontBoxEm(): number {
  let em = 0
  for (const got of [textFont(true), textFont(false)]) {
    const bb = got?.font.bbox as { minY: number; maxY: number } | undefined
    if (got && bb && Number.isFinite(bb.minY) && Number.isFinite(bb.maxY)) em = Math.max(em, (bb.maxY - bb.minY) / got.font.unitsPerEm)
  }
  // No font: the classes go to the engine (the font check); a full em-square of slack keeps the figure an upper bound.
  return em > 0 ? em : 2
}

/**
 * The renders Caption track keeps at once: the shown caption's band only
 * (captions are swept in frame order; it is drawn once when it comes up and
 * composited on every frame that shows it). Memory: one band.
 */
export const CAPTION_RENDERS_KEPT = 1

/**
 * Caption track's per-frame feed: for frame i (in order, from 0), the
 * caption it shows drawn at Python's place (`_cap`: its coverage), or null.
 * Each caption is drawn once when it comes up and its band reused on every frame that shows it.
 */
export function captionFeed(p: Record<string, unknown>, hosted: boolean, W: number, H: number): AsyncIterable<Record<string, unknown>> {
  const segs = captionSegments(p.captions)
  const shownAt = captionSweep(segs)
  const got = textFont(hosted)
  if (!got) throw new Error(MEDIA_EFFECT_WORDS.textFontMissing)
  const face = faceAt(got.font, Math.trunc(p.font_size as number))
  const ow = Math.trunc(p.outline_width as number)
  const kept = new Map<string, TextMask | null>()
  // Each distinct caption measured once: Python's place and the glyphs that can land, kept for the run
  // (at most the captions' own length in glyphs, all told).
  const laid = new Map<string, CaptionLaid>()
  return {
    async* [Symbol.asyncIterator]() {
      for (let i = 0; ; i++) {
        const text = shownAt(i)
        if (text === null) { yield { _cap: null }; continue }
        let m = kept.get(text)
        if (m === undefined) {
          let c = laid.get(text)
          if (!c) { c = captionLaid(face, text, p, W, H, ow > 0 ? ow : 0); laid.set(text, c) }
          m = await svgMasks(laidSvgs(face, c.lines, W, H, ow > 0 ? ow : 0, c.box))
          kept.set(text, m)
          if (kept.size > CAPTION_RENDERS_KEPT) kept.delete(kept.keys().next().value!)
        }
        // A copy each frame: the worker takes what it is handed.
        yield { _cap: m ? { ...m, fill: m.fill.slice(), line: m.line ? m.line.slice() : null } : null }
      }
    },
  }
}
