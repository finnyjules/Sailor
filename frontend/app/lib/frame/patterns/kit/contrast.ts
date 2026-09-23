import type { ResolvedPalette } from '../palette'
import { contrastRatio } from '../palette'
import { boxOf } from './check'
import type { Box } from './check'
import type { Colour, El, Sheet, TextEl } from './types'

// ═══════════════════════ text on a piece: one contrast picker (ruling R6) ═══════════════════════
// Every layout-drawn piece that carries the user's text — a tag, a sticker, a button, a band, a
// card, a panel, and the Swiss shape a Badge or a Knockout sets its text in — takes the first
// palette role, in the piece's own order, that every text sitting on it can be read on (3:1). A
// tag, a sticker and a button must also stand out from the page (1.5:1 against `field`). When no
// role passes, a button is drawn as an outline (ruling R8) and any other piece refuses the
// candidate. The planner runs this ONCE per candidate: the checker reads its issues and toOps
// draws its fills, so the check and the drawing cannot disagree.

/** Readable text on its piece (WCAG large text). */
export const READABLE = 3
/** A piece that stands out from the page. */
export const STAND_OUT = 1.5

/** A piece's fill: a palette role; a plain paper colour (a tag, sticker or button no role can
 *  carry — ruling R12); an outline in the label's colour (a button that can't stand out — ruling
 *  R8); or null (a button drawn as a link: no shape, the label underlined). */
export type PieceFill = Colour | { plain: string } | { outline: string } | null

/** Ruling R12: the plain paper colours a tag, sticker or button tries when no palette role
 *  passes — white, then near-black (a white label with dark text on a coloured page). */
export const PLAIN = ['#ffffff', '#111111'] as const

/** The first plain colour every text reads on (≥ 3:1) that stands out from the page (≥ 1.5:1). */
export function pickPlain(texts: string[], palette: ResolvedPalette): string | null {
  const field = hex6(palette.field)
  for (const bg of PLAIN) {
    if (!texts.every(t => contrastRatio(t, bg) >= READABLE)) continue
    if (field && contrastRatio(bg, field) < STAND_OUT) continue
    return bg
  }
  return null
}

/** A piece drawn solid (a role or a plain colour): it covers what lies under it. */
export const isSolid = (f: PieceFill | undefined): boolean => typeof f === 'string' || (!!f && 'plain' in f)

/** A `#rgb` / `#rrggbb` / `#rrggbbaa` colour as `#rrggbb`; null for anything else. */
export function hex6(c: unknown): string | null {
  if (typeof c !== 'string') return null
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(c.trim())
  if (!m) return null
  const h = m[1]!
  return '#' + (h.length === 3 ? h.split('').map(x => x + x).join('') : h.slice(0, 6)).toLowerCase()
}

/** Tags and stickers: the accent first. */
const TAG_ORDER: readonly Colour[] = ['accent', 'ink', 'field']
/** Bands, cards and panels: the page colour first. */
const PANEL_ORDER: readonly Colour[] = ['field', 'ink', 'accent']

/**
 * The first role in `order` that every text colour in `texts` reads on (≥ 3:1), and — with
 * `standOut` — that stands out from the page (≥ 1.5:1 against `field`). Null when none passes.
 * A role whose colour is not a plain hex is skipped; an unknown page colour skips the stand-out test.
 */
export function pickFill(order: readonly Colour[], texts: string[], palette: ResolvedPalette, standOut: boolean): Colour | null {
  const field = hex6(palette.field)
  for (const role of order) {
    const bg = hex6(palette[role])
    if (!bg) continue
    if (!texts.every(t => contrastRatio(t, bg) >= READABLE)) continue
    if (standOut && field && contrastRatio(bg, field) < STAND_OUT) continue
    return role
  }
  return null
}

/** A button's role order (ruling S1): the most contrast with its label first; with recolour on,
 *  the layout's own `bg` leads. */
function buttonOrder(label: string, palette: ResolvedPalette, bg?: Colour): Colour[] {
  const ratio = (r: Colour) => { const h = hex6(palette[r]); return h ? contrastRatio(label, h) : 0 }
  const byContrast = (['ink', 'accent', 'field'] as const).slice().sort((a, b) => ratio(b) - ratio(a))
  return bg ? [bg, ...byContrast.filter(r => r !== bg)] : byContrast
}

/** A button's fill for a label colour (ruling S1 + R6 + R12 + R8): a readable role that stands
 *  out; else a plain paper colour that does; an outline in the label's colour when neither does;
 *  null (a link) when the label's colour is unknown. */
export function buttonFill(labelColour: unknown, palette: ResolvedPalette, bg?: Colour): PieceFill {
  const label = hex6(labelColour)
  if (!label) return null
  const role = pickFill(buttonOrder(label, palette, bg), [label], palette, true)
  if (role) return role
  const plain = pickPlain([label], palette)
  return plain ? { plain } : { outline: label }
}

/** `title2` → `title`. */
const baseRole = (role: string | undefined) => (role ?? '').replace(/\d+$/, '')

/** The kind of piece an element is, when text can sit on it. */
type PieceKind = 'tag' | 'sticker' | 'band' | 'card' | 'panel' | 'btn' | 'shape'
function pieceKind(e: El): PieceKind | null {
  if (e.k === 'band') return 'band'
  if (e.k === 'btn') return 'btn'
  if (e.k === 'r' || (e.k === 'c' && !e.photo)) {
    const r = baseRole(e.role)
    // (A band is the kit's `band` element; a rect a layout merely names 'band' keeps its colour.)
    if (r === 'tag' || r === 'sticker' || r === 'card' || r === 'panel' || r === 'shape') return r
  }
  return null
}

const intersects = (a: Box, b: Box) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0

/** True when text box `b` lies inside piece `p` (a circle: all four corners inside it). */
function within(b: Box, p: El, pb: Box): boolean {
  if (p.k === 'c') {
    return ([[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]] as const)
      .every(([x, y]) => Math.hypot(x - p.cx, y - p.cy) <= p.r)
  }
  const eps = 0.05
  return b.x0 >= pb.x0 - eps && b.x1 <= pb.x1 + eps && b.y0 >= pb.y0 - eps && b.y1 <= pb.y1 + eps
}

/**
 * The text sitting on piece `els[i]`: text drawn after it (above it) that lies inside it, is set
 * `inside` it, or — for every piece but a Swiss shape — names it in `over` and overlaps it (the
 * collision rule's reading, as rule 10 reads covers). Text drawn before a piece lies under it.
 * A Swiss shape counts only the text set inside it (Badge, Knockout): a title that merely crosses
 * a shape on purpose (Overlap, Counter) is the layout's premise, not text on a piece.
 */
export function textsOn(els: El[], i: number, S: Sheet): TextEl[] {
  const p = els[i]!
  const kind = pieceKind(p)
  const pb = kind ? boxOf(p, S) : null
  if (!kind || !pb) return []
  const role = kind === 'btn' ? 'btn' : baseRole((p as { role?: string }).role) || kind
  const out: TextEl[] = []
  for (let j = i + 1; j < els.length; j++) {
    const e = els[j]!
    if (e.k !== 't') continue
    const b = boxOf(e, S)
    if (!b) continue
    const over = kind !== 'shape' && !!e.over?.includes(role) && intersects(b, pb)
    if (over || e.inside === role || within(b, p, pb)) out.push(e)
  }
  return out
}

/** What the picker needs to know about the Frame beyond the elements. */
export interface FillCtx {
  palette: ResolvedPalette
  /** Recolour is on: text takes `palette[e.color]` (ink when unnamed), and the user's own shape
   *  takes a role colour too. */
  recolour?: boolean
  /** The user's own colour of the text layer that holds `role` (a base role); undefined when the
   *  Frame has no layer for it (the text is not drawn). */
  layerColour(role: string): unknown
  /** The Frame has an action layer (a button is drawn only then). */
  hasAction: boolean
  /** The Frame's own shape layer's fill, when the layout's shape is drawn by it — its colour is the
   *  user's own unless recolour is on. Undefined: the shape is a library shape or a layout piece. */
  shapeFill?: unknown
}

export interface PieceFills {
  /** The fill picked for each piece that carries text (and every button). A piece absent from the
   *  map keeps its layout colour. */
  fills: Map<El, PieceFill>
  /** `"<text role> is unreadable on its <piece>"` for each piece no role can carry. */
  issues: string[]
}

/** The colour a text element is drawn in, as a hex; null when unknown or not drawn. */
function textColour(e: TextEl, ctx: FillCtx): string | null {
  if (ctx.layerColour(baseRole(e.role)) === undefined) return null
  return hex6(ctx.recolour ? ctx.palette[e.color ?? 'ink'] : ctx.layerColour(baseRole(e.role)))
}

/** Run the picker over every piece of a candidate. */
export function pieceFills(els: El[], S: Sheet, ctx: FillCtx): PieceFills {
  const fills = new Map<El, PieceFill>()
  const issues: string[] = []
  const on = new Map<number, TextEl[]>()
  els.forEach((p, i) => { if (pieceKind(p)) on.set(i, textsOn(els, i, S)) })
  // Buttons first: a filled button is what its label sits on.
  els.forEach((p, i) => {
    if (p.k !== 'btn') return
    if (p.shape === 'link' || !ctx.hasAction) { fills.set(p, null); return }
    const label = on.get(i)!.find(t => baseRole(t.role) === 'action')
    fills.set(p, buttonFill(label ? textColour(label, ctx) : null, ctx.palette, ctx.recolour ? (p.bg ?? 'ink') : undefined))
  })
  /** Text sits on the topmost piece under it: a card on a band holds its own text, a filled button
   *  its label. An outline or a link covers nothing — its label is on whatever lies beneath. */
  const coveredAbove = (t: TextEl, i: number) => [...on.entries()].some(([k, ts]) => k > i && ts.includes(t)
    && (els[k]!.k !== 'btn' || isSolid(fills.get(els[k]!))))
  els.forEach((p, i) => {
    const kind = pieceKind(p)
    if (!kind || kind === 'btn') return
    const texts = on.get(i)!.filter(t => !coveredAbove(t, i))
      .map(t => ({ t, c: textColour(t, ctx) })).filter((x): x is { t: TextEl; c: string } => x.c != null)
    if (!texts.length) return
    const colours = texts.map(x => x.c)
    const pieceName = baseRole((p as { role?: string }).role) || kind
    const refuse = (bg: string | null) => {
      const bad = texts.find(x => !bg || contrastRatio(x.c, bg) < READABLE) ?? texts[0]!
      issues.push(`${baseRole(bad.t.role)} is unreadable on its ${pieceName}`)
    }
    if (kind === 'shape' && ctx.shapeFill !== undefined && !ctx.recolour) {
      // The user's own shape keeps its own colour: it is only checked.
      const own = hex6(ctx.shapeFill)
      if (own && !colours.every(c => contrastRatio(c, own) >= READABLE)) refuse(own)
      return
    }
    const color = (p as { color?: Colour }).color
    const order = kind === 'tag' || kind === 'sticker' ? TAG_ORDER
      : kind === 'shape' ? [color ?? 'accent', ...PANEL_ORDER.filter(r => r !== (color ?? 'accent'))]
        : PANEL_ORDER
    const standOut = kind === 'tag' || kind === 'sticker'
    const fill = pickFill(order, colours, ctx.palette, standOut)
    // Ruling R12: a tag or a sticker tries plain paper before refusing. Bands, cards, panels and
    // Swiss shapes stay role-only.
    const plain = !fill && standOut ? pickPlain(colours, ctx.palette) : null
    if (fill) fills.set(p, fill)
    else if (plain) fills.set(p, { plain })
    else refuse(hex6(ctx.palette[order[0]!]))
  })
  return { fills, issues }
}
