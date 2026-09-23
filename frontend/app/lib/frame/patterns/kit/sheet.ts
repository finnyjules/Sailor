import { faceOf } from './types'
import type { Content, Measure, MissingEl, PhotoEl, RuleEl, Style, TextEl } from './types'

// ═══════════════════════ the kit ═══════════════════════
// Ported from the prototype (docs/superpowers/specs/assets/2026-09-23-frame-layout-system/
// layout-pane.html, "the kit"). The sheet comes from the Frame's shape. Layouts are written
// on a 12-column, 16-row design grid; X/XR map those columns onto the real column count
// (12, 16 or 20, or the grid's own) and L maps rows proportionally onto the real height.
// Units: percent of frame width (W = 100, H = 100 × frameH / frameW).

export interface SheetOpts {
  frameW: number; frameH: number
  grid?: { mode: 'off' | 'explicit' | 'generated'; margin: number; gutter: number; columns: number } | null
  measure: Measure
  /** Multiplies every fitted size (a variation's scale). Default 1. */
  scale?: number
  /** Swaps `photoIn`'s horizontal anchor. */
  flip?: boolean
  /** The real columns the design grid spans (a sub-sheet). Default `[1, NC]`. */
  colRange?: [number, number]
}

export interface Sheet {
  /** The measure this sheet was built with — lets consumers (e.g. the checker) get
   *  cap-above/base-below metrics per role without re-deriving them. */
  measure: Measure
  W: number; H: number; M: number; G: number; NC: number; CW: number; RH: number; GAP: number; CAP: number; B: number
  DISPLAY: Style; SECOND: Style & { size: number }; INFO: Style & { size: number }
  X(c: number): number; XR(c: number): number; SPAN(a: number, b: number): number; L(r: number): number; Xr(c: number): number
  w100(s: string, st?: Style): number
  fitSize(lines: string[], width: number, st?: Style): number
  sizeFor(lines: string[], width: number, maxH: number, st?: Style): number
  blockH(n: number, size: number, lh: number): number
  countLines(s: string, width: number, st: Style, size: number): number
  breakLines(words: string[], width: number, size: number, st: Style): string[]
  balance(words: string[], n: number): string[]
  text(s: string, o: Partial<TextEl>): TextEl
  disp(s: string, o: Partial<TextEl>): TextEl
  sec(s: string, o: Partial<TextEl>): TextEl
  info(s: string, o: Partial<TextEl>): TextEl
  rule(x: number, y: number, w: number): RuleEl
  infoStack(items: { s: string; wt?: number; role?: string }[], c1: number, c2: number, top: number): { els: TextEl[]; bottom: number }
  infoRow(c: Content, spec: [keyof Content, number, number][], where: 'foot' | 'head'): { els: TextEl[]; top: number; bottom: number }
  infoRowAt(c: Content, spec: [keyof Content, number, number][], base: number): { els: TextEl[]; top: number }
  stackBottom(items: { s: string; wt?: number; role?: string }[], c1: number, c2: number, bottom: number): { els: TextEl[]; top: number }
  photoIn(z: { c1: number; c2: number; top: number; bottom: number }, o?: { ax?: 'left' | 'right'; ay?: 'top' | 'bottom' }): PhotoEl | MissingEl
  cover(ph: boolean): PhotoEl
  pick<T>(r: () => number, arr: readonly T[]): T
  /** UI copy: quote the Frame's own words (first line, max 20 chars) instead of naming a role. */
  q(s: string | undefined, fallback?: string): string
  FOOT2: [keyof Content, number, number][]; FOOT3: [keyof Content, number, number][]
  PHOTO_ASPECT: number
}

/** Design rows. */
const NR = 16

export function makeSheet(o: SheetOpts): Sheet {
  const { measure } = o
  const SCALE = o.scale ?? 1
  const FLIP = !!o.flip
  const grid = o.grid ?? null
  const gridOn = !!grid && grid.mode !== 'off'

  const W = 100
  const H = 100 * o.frameH / o.frameW
  const B = Math.sqrt(W * H) / Math.sqrt(100 * 100 * 1280 / 895)   // size unit: 1 on the portrait poster
  const M = gridOn ? grid!.margin * 100 : Math.min(4, H * 0.06)
  const NC = grid?.mode === 'explicit' ? grid.columns : (H / W >= 0.7 ? 12 : W / H >= 2.5 ? 20 : 16)
  const G = gridOn ? grid!.gutter * 100 : 1.6 * B
  const CW = (W - 2 * M - (NC - 1) * G) / NC
  const RH = (H - 2 * M) / NR
  const GAP = RH * 0.5
  const CAP = measure.capAbove('title') + measure.baseBelow('title')

  const [colA, colB] = o.colRange ?? [1, NC]                          // the real columns the design grid spans
  const Xr = (c: number) => M + (c - 1) * (CW + G)
  const cs = (c: number) => colA + Math.round((c - 1) * (colB - colA + 1) / 12)   // design column → real start column
  const ce = (c: number) => colA - 1 + Math.round(c * (colB - colA + 1) / 12)     // design column → real end column
  const X = (c: number) => Xr(cs(c))                                  // left edge of design column c
  const XR = (c: number) => Xr(ce(c)) + CW                            // right edge of design column c
  const SPAN = (a: number, b: number) => XR(b) - X(a)
  const L = (r: number) => M + r * RH                                 // line under design row r; L(0) = top margin

  // Swiss styles
  const DISPLAY: Style = { role: 'title', wt: 600, ls: -0.05, lh: 0.9 }
  const SECOND: Style & { size: number } = { role: 'details', size: 4.4 * B, wt: 500, ls: -0.02, lh: 1.04 }
  const INFO: Style & { size: number } = { role: 'caption', size: 1.95 * B, wt: 400, ls: 0, lh: 1.3 }

  // measurement: width at size 100, with the letter spacing the layout will set
  const w100 = (s: string, st: Style = DISPLAY) => measure.w100(s, st.role ?? 'title', st.ls)
  const fitSize = (lines: string[], width: number, st: Style = DISPLAY) =>
    SCALE * Math.min(...lines.map(l => width * 100 / Math.max(1, w100(l, st))))
  const blockH = (n: number, size: number, lh: number) => ((n - 1) * lh + CAP) * size
  const sizeFor = (lines: string[], width: number, maxH: number, st: Style = DISPLAY) =>
    Math.min(fitSize(lines, width, st), SCALE * maxH / ((lines.length - 1) * st.lh + CAP))
  function breakLines(words: string[], width: number, size: number, st: Style): string[] {
    const out: string[] = []; let cur = ''
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w
      if (cur && w100(t, st) * size / 100 > width) { out.push(cur); cur = w } else cur = t
    }
    if (cur) out.push(cur)
    return out
  }
  // The renderer's own wrap, paragraph by paragraph — so line counts match what the Frame draws.
  const countLines = (s: string, width: number, st: Style, size: number) =>
    s.split('\n').reduce((a, p) => a + measure.lines(p, st.role ?? 'caption', size, st.ls, width).length, 0)
  function balance(words: string[], n: number): string[] {
    const total = words.join(' ').length, target = total / n, out: string[] = []; let cur = ''
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w
      if (cur && out.length < n - 1 && t.length > target * 1.08) { out.push(cur); cur = w } else cur = t
    }
    out.push(cur)
    return out
  }

  // element builders
  const text = (s: string, o: Partial<TextEl>): TextEl => ({ k: 't', s, ...o } as TextEl)
  const disp = (s: string, o: Partial<TextEl>) => text(s, { wt: DISPLAY.wt, ls: DISPLAY.ls, lh: DISPLAY.lh, role: 'title', pre: true, ...o })
  const sec = (s: string, o: Partial<TextEl>) => text(s, { size: SECOND.size, wt: SECOND.wt, ls: SECOND.ls, lh: SECOND.lh, role: 'details', ...o })
  const info = (s: string, o: Partial<TextEl>) => text(s, { role: 'info', size: INFO.size, wt: INFO.wt, ls: INFO.ls, lh: INFO.lh, ...o })
  const rule = (x: number, y: number, w: number): RuleEl => ({ k: 'l', x, y, w })
  /** INFO measured in the face of the element's own role. */
  const infoIn = (role: string | undefined): Style => ({ ...INFO, role: faceOf(role) })

  // information stacked in a column, top-anchored; returns the bottom
  function infoStack(items: { s: string; wt?: number; role?: string }[], c1: number, c2: number, top: number) {
    const els: TextEl[] = []; let y = top; const w = SPAN(c1, c2)
    items.forEach((it, i) => {
      const n = countLines(it.s, w, infoIn(it.role), INFO.size)
      els.push(info(it.s, { x: X(c1), w, top: y, wt: it.wt || INFO.wt, role: it.role || 'info' }))
      y += blockH(n, INFO.size, INFO.lh) + (i < items.length - 1 ? INFO.size * 1.25 : 0)
    })
    return { els, bottom: y }
  }
  // a row of information blocks sharing one baseline or one cap line
  function infoRow(c: Content, spec: [keyof Content, number, number][], where: 'foot' | 'head') {
    const els: TextEl[] = []; let extent = 0
    for (const [key, a, b] of spec) {
      const s = c[key]; if (!s) continue
      const n = countLines(s, SPAN(a, b), infoIn(key), INFO.size)
      extent = Math.max(extent, blockH(n, INFO.size, INFO.lh))
      const e: Partial<TextEl> = { x: X(a), w: SPAN(a, b), wt: key === 'details' ? 500 : INFO.wt, role: key }
      if (where === 'foot') e.base = L(16); else e.top = M
      els.push(info(s, e))
    }
    return { els, top: where === 'foot' ? L(16) - extent : M, bottom: where === 'foot' ? L(16) : M + extent }
  }
  function infoRowAt(c: Content, spec: [keyof Content, number, number][], base: number) {
    const els: TextEl[] = []; let extent = 0
    for (const [key, a, b] of spec) {
      const s = c[key]; if (!s) continue
      extent = Math.max(extent, blockH(countLines(s, SPAN(a, b), infoIn(key), INFO.size), INFO.size, INFO.lh))
      els.push(info(s, { x: X(a), w: SPAN(a, b), base, wt: key === 'details' ? 500 : INFO.wt, role: key }))
    }
    return { els, top: base - extent }
  }
  function stackBottom(items: { s: string; wt?: number; role?: string }[], c1: number, c2: number, bottom: number) {
    const st = infoStack(items, c1, c2, 0)
    st.els.forEach(e => { e.top = (e.top ?? 0) + bottom - st.bottom })
    return { els: st.els, top: bottom - st.bottom }
  }
  const FOOT3: [keyof Content, number, number][] = [['details', 1, 4], ['date', 5, 8], ['caption', 9, 12]]
  const FOOT2: [keyof Content, number, number][] = [['date', 1, 4], ['caption', 5, 12]]

  // the photo: whole columns, 4:5, the largest that fits the zone
  const PHOTO_ASPECT = 1.25
  function photoIn(z: { c1: number; c2: number; top: number; bottom: number }, { ax = 'right', ay = 'top' }: { ax?: 'left' | 'right'; ay?: 'top' | 'bottom' } = {}): PhotoEl | MissingEl {
    if (FLIP) ax = ax === 'right' ? 'left' : 'right'
    const avail = z.bottom - z.top
    for (let n = z.c2 - z.c1 + 1; n >= 2; n--) {
      const w = SPAN(1, n), h = w * PHOTO_ASPECT
      if (h <= avail) {
        const c1 = ax === 'right' ? z.c2 - n + 1 : z.c1
        return { k: 'p', x: X(c1), y: ay === 'top' ? z.top : z.bottom - h, w, h, role: 'photo' }
      }
    }
    return { k: 'missing' }
  }
  const cover = (ph: boolean): PhotoEl => {
    const w = Math.max(W, H / PHOTO_ASPECT), h = w * PHOTO_ASPECT
    return { k: 'p', x: (W - w) / 2, y: (H - h) / 2, w, h, stand: !ph, role: 'photo', ok: true, bleed: true }
  }
  const pick = <T>(r: () => number, arr: readonly T[]): T => arr[Math.floor(r() * arr.length)] as T
  // Quote the Frame's own words instead of naming what they might be ("the dates", "the artist").
  const q = (s: string | undefined, fallback = 'the smaller text') => {
    if (!s) return fallback
    const l = s.split('\n')[0]!
    return `“${l.length > 20 ? l.slice(0, 19) + '…' : l}”`
  }

  return {
    measure,
    W, H, M, G, NC, CW, RH, GAP, CAP, B,
    DISPLAY, SECOND, INFO,
    X, XR, SPAN, L, Xr,
    w100, fitSize, sizeFor, blockH, countLines, breakLines, balance,
    text, disp, sec, info, rule,
    infoStack, infoRow, infoRowAt, stackBottom, photoIn, cover, pick, q,
    FOOT2, FOOT3, PHOTO_ASPECT,
  }
}
