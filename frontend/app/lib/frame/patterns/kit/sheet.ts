import { faceOf } from './types'
import type { BandEl, ButtonEl, Colour, Content, LineEl, LogoEl, Measure, MissingEl, OwnTextEl, PhotoEl, RectEl, RoleKey, RuleEl, StarsEl, Style, TextEl, TextKey } from './types'
import { STYLES } from './styles'
import type { StyleId } from './styles'

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
  /** The format's rules for the sheet: the minimum text size from its viewing width, its column
   *  count, and the platform's side margins. Absent: Stage 1 behaviour, unchanged. */
  format?: { view?: number; nc?: number; keepSide?: number }
  /** Compose on a band this tall (kit units) instead of the full height — the part the platform
   *  leaves uncovered. `B` still comes from the FULL height. */
  composeH?: number
  /** The style's type: DISPLAY and INFO weight, letter spacing, line height and letter case
   *  (SECOND keeps its Swiss values in every style). Absent: `'swiss'` — Stages 1–2, unchanged. */
  style?: StyleId
  /** A date range too wide for its box may break after its dash (`dateLines`). Absent: never —
   *  every line wraps as the renderer does, exactly as before. The planner turns it on only for a
   *  choice that fails without it. */
  breakDates?: boolean
}

export interface Sheet {
  /** The measure this sheet was built with — lets consumers (e.g. the checker) get
   *  cap-above/base-below metrics per role without re-deriving them. */
  measure: Measure
  W: number; H: number; M: number; G: number; NC: number; CW: number; RH: number; GAP: number; CAP: number; B: number
  /** The margin is the kit's own (`min(4, 6% of H)`) — not the Frame's grid margin, and not widened
   *  to a platform's side keep-clear (a story). Optical nudges past the margin apply only then. */
  defaultMargin: boolean
  DISPLAY: Style; SECOND: Style & { size: number }; INFO: Style & { size: number }
  X(c: number): number; XR(c: number): number; SPAN(a: number, b: number): number; L(r: number): number; Xr(c: number): number
  w100(s: string, st?: Style): number
  fitSize(lines: string[], width: number, st?: Style): number
  sizeFor(lines: string[], width: number, maxH: number, st?: Style): number
  blockH(n: number, size: number, lh: number): number
  countLines(s: string, width: number, st: Style, size: number): number
  /** A date line's breaks after its range dash, or null when the renderer's wrap stands. */
  dateLines(s: string, width: number, st: Style, size: number): string[] | null
  breakLines(words: string[], width: number, size: number, st: Style): string[]
  balance(words: string[], n: number): string[]
  text(s: string, o: Partial<TextEl>): TextEl
  disp(s: string, o: Partial<TextEl>): TextEl
  sec(s: string, o: Partial<TextEl>): TextEl
  info(s: string, o: Partial<TextEl>): TextEl
  rule(x: number, y: number, w: number): RuleEl
  infoStack(items: { s: string; wt?: number; role?: string }[], c1: number, c2: number, top: number): { els: TextEl[]; bottom: number }
  infoRow(c: Content, spec: [TextKey, number, number][], where: 'foot' | 'head'): { els: TextEl[]; top: number; bottom: number }
  infoRowAt(c: Content, spec: [TextKey, number, number][], base: number): { els: TextEl[]; top: number }
  stackBottom(items: { s: string; wt?: number; role?: string }[], c1: number, c2: number, bottom: number): { els: TextEl[]; top: number }
  photoIn(z: { c1: number; c2: number; top: number; bottom: number }, o?: { ax?: 'left' | 'right'; ay?: 'top' | 'bottom' }): PhotoEl | MissingEl
  cover(ph: boolean): PhotoEl
  pick<T>(r: () => number, arr: readonly T[]): T
  /** UI copy: quote the Frame's own words (first line, max 20 chars) instead of naming a role. */
  q(s: string | undefined, fallback?: string): string
  FOOT2: [TextKey, number, number][]; FOOT3: [TextKey, number, number][]
  PHOTO_ASPECT: number
  // ── Stage 3 pieces (the prototype's `scrim`, `button`, `logo` and spacing, ~1140–1188) ──
  /** A band of page colour rising from an edge: solid behind the text (`from`..`to`, plus a gap),
   *  fading into the image over 1.6 rows. `side: 'top'` runs 0..`to`; `'bottom'` runs `from`..H. */
  band(side: 'top' | 'bottom', from: number, to: number): BandEl
  /** A button that grows with its label (the style's look: pill, box or link). `btn` is the
   *  owned shape; `text` is the user's own action line placed on it (role `'action'`). */
  button(label: string, x: number, top: number, o?: { align?: 'left' | 'center' | 'right'; bg?: Colour; fg?: Colour; color?: Colour }): { btn: ButtonEl; text: TextEl }
  /** The brand logo `h` tall at its own `aspect` (h / w). */
  logo(x: number, top: number, h: number, o: { aspect: number; align?: 'left' | 'center' | 'right' }): LogoEl
  /** The logo's height. */
  logoH(): number
  /** Space to leave after a logo (at least its own clear space). */
  clear(lg: { h: number }): number
  /** After a line of size `s`, before the next item of its group. */
  gapBelow(s: number): number
  /** Between groups (message / offer / fine print). */
  groupGap(): number
  /** Inside panels and cards: at least the page margin. */
  inset(): number
  /** A rotated tag in accent (Street): an owned rect and the user's own text on it (`role`, the
   *  line it holds), in the display style. Placed by its rotated edge: the rotated box ends at
   *  `right`, centred on `cy`, turned `deg` degrees. `over`: what the tag may lie across. */
  tag(s: string, right: number, cy: number, deg: number, over?: string[], role?: RoleKey): [RectEl, TextEl]
  // ── Stage 4 pieces ──
  /** The layout's own words (✓, "Before", a list number): an owned text layer in the caption
   *  layer's family. Defaults: the information size and weight, no letter spacing, line height 1,
   *  role `'own'`, at x 0 — `o` sets the rest (`top` or `base`). */
  own(s: string, o: Partial<OwnTextEl>): OwnTextEl
  /** Five stars filled to `value`, each `size` square, top-left at (x, y). */
  stars(value: number, x: number, y: number, size: number): StarsEl
  /** A leader line from (x1, y1) to (x2, y2). */
  leader(x1: number, y1: number, x2: number, y2: number): LineEl
}

/** Design rows. */
const NR = 16

/** A date part: a day, month or year, with its dots or slashes ("19.09.", "15.11.2026", "9/19"). */
const DATE_PART = /^\d{1,4}(?:[./]\d{1,4})*[./]?$/
/** Where a date range may break: right after an en dash, or a hyphen, that sits between two date
 *  parts ("19.09.–15.11.2026" → "19.09.–" / "15.11.2026"). A hyphen only when both sides carry a
 *  dot or slash — so an ISO date ("2026-09-19") is one date, never a range. Null: no such dash.
 *  Only a line break is ever added: the pieces joined give back the user's characters. */
export function splitDateRange(token: string): [string, string] | null {
  for (let i = 1; i < token.length - 1; i++) {
    const ch = token[i]
    if (ch !== '–' && ch !== '-') continue
    const a = token.slice(0, i), b = token.slice(i + 1)
    if (!DATE_PART.test(a) || !DATE_PART.test(b)) continue
    if (ch === '-' && !(/[./]/.test(a) && /[./]/.test(b))) continue
    return [a + ch, b]
  }
  return null
}

/** The kit's own sizes for a Frame shape, in kit units (percent of width), with the Frame grid OFF:
 *  the size unit B, the margin, the real column count, and the info (body) type size and leading.
 *  The Frame's suggested layout grid is built from these (lib/frame/layoutGrid.ts). */
export function kitBasics(frameW: number, frameH: number, format?: SheetOpts['format'], style: StyleId = 'swiss') {
  const W = 100
  const H_full = 100 * frameH / frameW
  const B = Math.sqrt(W * H_full) / Math.sqrt(100 * 100 * 1280 / 895)
  let margin = Math.min(4, H_full * 0.06)
  if (format?.keepSide != null) margin = Math.max(margin, format.keepSide * 100)
  const nc = format?.nc ?? (H_full / W >= 0.7 ? 12 : W / H_full >= 2.5 ? 20 : 16)
  const infoFloor = format?.view ? 900 / format.view : 0
  const infoSize = Math.max(1.95 * B, infoFloor)
  return { B, margin, nc, infoSize, infoLh: STYLES[style].info.lh }
}

export function makeSheet(o: SheetOpts): Sheet {
  const { measure } = o
  const SCALE = o.scale ?? 1
  const FLIP = !!o.flip
  const grid = o.grid ?? null
  const gridOn = !!grid && grid.mode !== 'off'

  const W = 100
  const H_full = 100 * o.frameH / o.frameW
  const H = o.composeH ?? H_full
  const kb = kitBasics(o.frameW, o.frameH, o.format, o.style ?? 'swiss')
  const B = kb.B   // size unit: 1 on the portrait poster — from the FULL height
  const kitM = Math.min(4, H * 0.06)
  let M = gridOn ? grid!.margin * 100 : kitM
  if (o.format?.keepSide != null) M = Math.max(M, o.format.keepSide * 100)
  const defaultMargin = !gridOn && M === kitM
  const NC = grid?.mode === 'explicit' ? grid.columns : (o.format?.nc ?? (H_full / W >= 0.7 ? 12 : W / H_full >= 2.5 ? 20 : 16))
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

  // Swiss styles — minimum text size from the format's viewing width (Stage 2), Stage 1 sizes when absent.
  const infoSize = kb.infoSize
  const secondSize = o.format?.view ? Math.max(4.4 * B, 1.6 * infoSize) : 4.4 * B
  // The style's display and information type; `upper` only when the style sets capitals, so the
  // Swiss styles are exactly the Stage 1 objects.
  const sty = STYLES[o.style ?? 'swiss']
  const upperOf = (u: boolean | undefined) => (u ? { upper: true } : {})
  const DISPLAY: Style = { role: 'title', wt: sty.display.wt, ls: sty.display.ls, lh: sty.display.lh, ...upperOf(sty.display.upper) }
  const SECOND: Style & { size: number } = { role: 'details', size: secondSize, wt: 500, ls: -0.02, lh: 1.04 }
  const INFO: Style & { size: number } = { role: 'caption', size: infoSize, wt: sty.info.wt, ls: sty.info.ls, lh: sty.info.lh, ...upperOf(sty.info.upper) }

  // measurement: width at size 100, with the letter spacing the layout will set
  const w100 = (s: string, st: Style = DISPLAY) => measure.w100(s, st.role ?? 'title', st.ls, st.upper)
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
  /** The date line's own breaks (Task 3 of the layout decisions): the renderer wraps only at
   *  spaces, so a date range too wide for its box ("19.09.–15.11.2026") may break after the dash
   *  between its two dates — nowhere else. Returns the lines to place, or null when no such break
   *  is needed and the renderer's own wrap stands. The text is cut ONLY right after such a dash
   *  (a range token that alone is wider than the box): every other character, spaces included,
   *  stays exactly where the user put it, so the lines joined give back the user's text. Each line
   *  is measured with `w100`, exactly as `displayOp` draws placed lines. Only on a sheet with
   *  `breakDates`. */
  function dateLines(s: string, width: number, st: Style, size: number): string[] | null {
    if (!o.breakDates || !(width > 0)) return null
    const wOf = (t: string) => w100(t, st) * size / 100
    let broke = false
    const out: string[] = []
    for (const para of s.split('\n')) {
      let from = 0
      for (const m of para.matchAll(/\S+/g)) {
        const tok = m[0]
        const r = wOf(tok) > width ? splitDateRange(tok) : null
        if (!r) continue
        const cut = m.index! + r[0].length
        out.push(para.slice(from, cut))
        from = cut
        broke = true
      }
      out.push(para.slice(from))
    }
    return broke ? out : null
  }
  /** The date face: `dateLines` applies. */
  const isDate = (st: Style) => st.role === 'date'
  // The renderer's own wrap, paragraph by paragraph — so line counts match what the Frame draws.
  // A date range that has to break after its dash is drawn as placed lines (`text` below), and
  // counted as those lines.
  const countLines = (s: string, width: number, st: Style, size: number) => {
    const dl = isDate(st) ? dateLines(s, width, st, size) : null
    if (dl) return dl.length
    return s.split('\n').reduce((a, p) => a + measure.lines(p, st.role ?? 'caption', size, st.ls, width, st.upper).length, 0)
  }
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
  // A flowing date line (its own box, `w`) that has to break after its range dash becomes placed
  // lines — the mechanism a title's line breaks use (`pre`: the op carries the lines as runs, the
  // layer's text is never rewritten), so the break measured here is the break drawn.
  const text = (s: string, o: Partial<TextEl>): TextEl => {
    const e = { k: 't', s, ...o } as TextEl
    if (e.pre || e.w == null || faceOf(e.role) !== 'date' || e.size == null) return e
    const dl = dateLines(s, e.w, { role: 'date', ls: e.ls ?? 0, lh: e.lh, upper: e.upper }, e.size)
    return dl ? { ...e, s: dl.join('\n'), pre: true } : e
  }
  const disp = (s: string, o: Partial<TextEl>) => text(s, { wt: DISPLAY.wt, ls: DISPLAY.ls, lh: DISPLAY.lh, role: 'title', pre: true, ...upperOf(DISPLAY.upper), ...o })
  const sec = (s: string, o: Partial<TextEl>) => text(s, { size: SECOND.size, wt: SECOND.wt, ls: SECOND.ls, lh: SECOND.lh, role: 'details', ...o })
  const info = (s: string, o: Partial<TextEl>) => text(s, { role: 'info', size: INFO.size, wt: INFO.wt, ls: INFO.ls, lh: INFO.lh, ...upperOf(INFO.upper), ...o })
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
  function infoRow(c: Content, spec: [TextKey, number, number][], where: 'foot' | 'head') {
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
  function infoRowAt(c: Content, spec: [TextKey, number, number][], base: number) {
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
  const FOOT3: [TextKey, number, number][] = [['details', 1, 4], ['date', 5, 8], ['caption', 9, 12]]
  const FOOT2: [TextKey, number, number][] = [['date', 1, 4], ['caption', 5, 12]]

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

  // ── Stage 3 pieces: the prototype's builders (~1140–1188), maths verbatim ──
  function band(side: 'top' | 'bottom', from: number, to: number): BandEl {
    const fade = RH * 1.6, pad = GAP
    if (side === 'top') { const h = Math.min(H, to + pad + fade); return { k: 'band', side, y: 0, h, solid: (to + pad) / h, role: 'band', ok: true, bleed: true } }
    const y = Math.max(0, from - pad - fade), h = H - y
    return { k: 'band', side, y, h, solid: (H - from + pad) / h, role: 'band', ok: true, bleed: true }
  }
  // A button: the user's action text in a padded shape that grows with it (a link in Editorial).
  // Measured in the action's face (the info face) with the style's button spacing and case.
  const BUTTON = sty.button ?? { shape: 'pill' as const, wt: 600, ls: 0 }
  function button(label: string, x: number, top: number, o: { align?: 'left' | 'center' | 'right'; bg?: Colour; fg?: Colour; color?: Colour } = {}) {
    const size = Math.max(INFO.size * 1.3, SECOND.size * 0.5)
    const st: Style = { role: faceOf('action'), wt: BUTTON.wt, ls: BUTTON.ls, lh: 1, ...upperOf(INFO.upper) }
    const tw = w100(label, st) / 100 * size
    const place = (w: number) => o.align === 'center' ? x - w / 2 : o.align === 'right' ? x - w : x
    const capH = (measure.capAbove(faceOf('action')) + measure.baseBelow(faceOf('action'))) * size
    const label0 = { role: 'action', over: ['btn'], size, wt: st.wt, ls: st.ls, lh: 1, ...upperOf(INFO.upper) }
    if (BUTTON.shape === 'link') {
      const w = tw, h = size * 1.7
      const btn: ButtonEl = { k: 'btn', shape: 'link', x: place(w), y: top, w, h, size, role: 'btn' }
      // The box is a little wider than the measured text, so the renderer never wraps it.
      return { btn, text: text(label, { ...label0, x: btn.x, w: tw + size, align: 'left', top: top + (h - capH) / 2, color: o.color ?? 'ink' }) }
    }
    const w = tw + size * 2.6, h = size * 2.8
    const btn: ButtonEl = { k: 'btn', shape: BUTTON.shape, x: place(w), y: top, w, h, size, role: 'btn', bg: o.bg ?? 'ink' }
    return { btn, text: text(label, { ...label0, x: btn.x, w, align: 'center', top: top + (h - capH) / 2, color: o.fg ?? 'field', inside: 'btn' }) }
  }
  const logoH = () => Math.max(INFO.size * 1.9, RH * 0.5)
  const clear = (lg: { h: number }) => Math.max(GAP * 1.5, lg.h * 0.5)          // at least the logo's own clear space
  function logo(x: number, top: number, h: number, o: { aspect: number; align?: 'left' | 'center' | 'right' }): LogoEl {
    const w = h / o.aspect
    return { k: 'logo', x: o.align === 'center' ? x - w / 2 : o.align === 'right' ? x - w : x, y: top, w, h, role: 'logo' }
  }
  // Spacing, from the type rather than per layout:
  const gapBelow = (s: number) => Math.max(s * 0.4, INFO.size * 1.1)
  const groupGap = () => Math.max(RH * 1.4, INFO.size * 3.4)
  const inset = () => Math.max(M, INFO.size * 2.4)
  // A rotated tag in accent (Street), the prototype's `tag()` (~1159), maths verbatim. The text is
  // the user's own line (`role`), measured in that line's face with the display style.
  function tag(s: string, right: number, cy: number, deg: number, over: string[] = [], role: RoleKey = 'date'): [RectEl, TextEl] {
    const st: Style = { ...DISPLAY, role: faceOf(role) }
    const cap = measure.capAbove(faceOf(role)) + measure.baseBelow(faceOf(role))
    let ts = Math.max(SECOND.size * 1.15, INFO.size * 2)
    const maxW = SPAN(4, 12), a = Math.abs(deg) * Math.PI / 180
    const widthAt = (t: number) => w100(s, st) / 100 * t + t * 0.9
    if (widthAt(ts) > maxW) ts *= maxW / widthAt(ts)
    const w = widthAt(ts), h = cap * ts + ts * 0.8
    const cx = right - (w * Math.cos(a) + h * Math.sin(a)) / 2       // the rotated box ends at the right edge
    return [
      { k: 'r', x: cx - w / 2, y: cy - h / 2, w, h, color: 'accent', rot: deg, role: 'tag', over },
      disp(s, { size: ts, x: cx - w / 2, w, align: 'center', top: cy - cap * ts / 2, rot: deg, origin: 'center', color: 'field', role, over: ['tag', ...over], inside: 'tag' }),
    ]
  }

  // ── Stage 4 pieces: owned words, stars and leader lines ──
  const own = (s: string, o: Partial<OwnTextEl>): OwnTextEl =>
    ({ k: 'own', s, x: 0, size: INFO.size, wt: INFO.wt ?? 400, ls: 0, lh: 1, role: 'own', ...o } as OwnTextEl)
  const stars = (value: number, x: number, y: number, size: number): StarsEl =>
    ({ k: 'stars', x, y, size, value, role: 'stars' })
  const leader = (x1: number, y1: number, x2: number, y2: number): LineEl =>
    ({ k: 'ln', x1, y1, x2, y2, role: 'leader' })

  return {
    measure,
    W, H, M, G, NC, CW, RH, GAP, CAP, B, defaultMargin,
    DISPLAY, SECOND, INFO,
    X, XR, SPAN, L, Xr,
    w100, fitSize, sizeFor, blockH, countLines, dateLines, breakLines, balance,
    text, disp, sec, info, rule,
    infoStack, infoRow, infoRowAt, stackBottom, photoIn, cover, pick, q,
    FOOT2, FOOT3, PHOTO_ASPECT,
    band, button, logo, logoH, clear, gapBelow, groupGap, inset, tag,
    own, stars, leader,
  }
}
