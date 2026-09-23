import type { Content, El, LayoutDef, MissingEl, RoleKey, Sheet, Style } from '../kit/types'
import { faceOf } from '../kit/types'
import { STAR_GAP } from '../kit/check'
import { numberOf, numStyle, offerBox } from './performance'

// ═══════════════════════ Performance ad layouts (Stage 4) ═══════════════════════
// Ported from the prototype (docs/superpowers/specs/assets/2026-09-23-frame-layout-system/
// layout-pane.html, "Ad layouts from the research" ~1289–1366: `perfOfferFirst`, `perfStat`,
// `perfReview`, `perfVersus`, and the `stars` renderer ~1052). Each needs the kind of content it is
// built around (`needsContent`, gated in `fitsFrame`), and so reads the Frame's CONTENT view
// (ruling C2). Geometry is the prototype's; what differs, none of it geometry:
// - Rulings R4/R5: the quote is the user's own text — no quote marks are added around it (nor a
//   "— " before the reviewer); a list is ONE user layer placed as runs (roles list, list1, …), each
//   row the user's own line (their markers kept, R5), wrapped by the kit's line breaking.
// - The stars are owned shapes only; the rating number beside them is the user's rating line.
// - Us vs them: the "them" heading is the user's `them` line as they wrote it ("vs a typical trail
//   shoe"), the product heading is the details line, ✓/✕ are owned text (the layout's own words).
// - Offer first's number panel is an owned `panel` (the contrast picker picks its fill); the
//   prototype's `scrim` is the kit's `band`; buttons go through `button()`, so the platform's own
//   button (`cta: 'native'`) drops them like every Performance layout's.
// - Layouts never set the family, weight or colour of the user's text (`color` is what recolour
//   paints); a missing piece says "image", not "product".

const ALL = ['word', 'phrase', 'sentence'] as const

/** The top of the first block: the margin, or most of the panel inset. */
const topY = (S: Sheet) => Math.max(S.M, S.inset() * 0.8)

/** `st`, measured in the face of the line `role` holds. */
const inFace = (st: Style, role: RoleKey): Style => ({ ...st, role: faceOf(role) })

/** Cap height (cap top → baseline) of the face `role` is measured in, as a fraction of size. */
const capOf = (S: Sheet, role: RoleKey) => S.measure.capAbove(faceOf(role)) + S.measure.baseBelow(faceOf(role))

const noRoom: MissingEl = { k: 'missing', why: 'no room for the image' }

/** A comparison row's "both" marker (`kit/content.ts`, ruling R2): its meaning is drawn in the
 *  glyph columns, so it leaves the row's label. */
const BOTH_RE = /\s+(?:✓✓|\(both\))\s*$/

/** The list's lines as the user wrote them (markers kept, ruling R5), one per item — or the items
 *  themselves when the layer's lines do not line up with them. */
function listLines(c: Content, items: string[]): string[] {
  const raw = c.raw?.list?.split('\n').map(l => l.trim()).filter(Boolean)
  return raw && raw.length === items.length ? raw : items
}

/** Offer first — the number leads on a solid panel of colour at the top; the product fills the rest,
 *  with the product name and the button on a band at the foot. */
export const perfOfferFirst: LayoutDef = {
  id: 'perfOfferFirst', name: 'Offer first', fits: [...ALL], style: 'performance', oneLineFirst: true,
  needs: { image: true }, needsContent: ['number'],
  fn(S, { c, ph, lines }) {
    const { X, SPAN, RH, CAP, W, H, L, INFO, DISPLAY, fitSize, sizeFor, blockH, countLines, disp, info, logo, logoH, clear, gapBelow, inset, band } = S
    const num = numberOf(c)!
    const pad = inset()
    let y = topY(S)
    const blk: El[] = []
    if (c.logo) { const lg = logo(X(1), y, logoH(), { aspect: c.logo.aspect }); blk.push(lg); y += lg.h + clear(lg) }
    // Inside a panel the padding wins over optical alignment.
    const ns = Math.min(fitSize([num], SPAN(1, 12) * 0.9, numStyle(S)), RH * 3.4 / CAP)
    blk.push(disp(num, { size: ns, x: X(1), top: y, color: 'field', role: 'date' }))
    y += CAP * ns + gapBelow(ns) * 0.6
    const size = sizeFor(lines, SPAN(1, 12), RH * 1.6)
    blk.push(disp(lines.join('\n'), { size, x: X(1), top: y, color: 'field' }))
    y += blockH(lines.length, size, DISPLAY.lh)
    if (c.caption) {
      y += gapBelow(size) * 0.8
      const n = countLines(c.caption, SPAN(1, 9), INFO, INFO.size)
      blk.push(info(c.caption, { x: X(1), w: SPAN(1, 9), top: y, color: 'field', role: 'caption' }))
      y += blockH(n, INFO.size, INFO.lh)
    }
    const blockB = y + pad
    const { date: _number, caption: _caption, ...rest } = c              // both are on the panel
    const foot = offerBox(S, rest, { x: X(1), w: SPAN(1, 12), bottom: L(16) })
    // The prototype does not guard it; a panel that reaches the foot leaves the product no room.
    const photo: El = foot.top - blockB > RH * 2
      ? { k: 'p', x: 0, y: blockB, w: W, h: H - blockB, stand: !ph, role: 'photo', ok: true, bleed: true }
      : noRoom
    return {
      els: [photo, { k: 'r', x: 0, y: 0, w: W, h: blockB, color: 'accent', role: 'panel', ok: true, bleed: true }, ...blk,
        band('bottom', foot.top, H), ...foot.els],
      did: 'The number leads on a solid panel of colour; the product fills the rest, with the button at the foot.',
    }
  },
}

/** Stat — one giant figure and the line that explains it; the product runs edge to edge below. */
export const perfStat: LayoutDef = {
  id: 'perfStat', name: 'Stat', fits: [...ALL], style: 'performance', oneLineFirst: true,
  needs: { image: true }, needsContent: ['stat'],
  fn(S, { c, ph }) {
    const { X, SPAN, RH, CAP, W, L, DISPLAY, SECOND, fitSize, blockH, countLines, disp, sec, logo, logoH, clear, gapBelow, groupGap } = S
    const st = c.stat!
    let y = topY(S)
    const els: El[] = []
    if (c.logo) { const lg = logo(X(1), y, logoH(), { aspect: c.logo.aspect }); els.push(lg); y += lg.h + clear(lg) }
    const ss = Math.min(fitSize([st.value], SPAN(1, 12) * 0.8, inFace(DISPLAY, 'stat')), RH * 3.6 / CAP)
    // The prototype's optical nudge (0.03 × the size to the left) — only on the kit's own margin. A
    // wider one is a platform's side keep-clear (a story) or the Frame's grid: there the margin wins,
    // as inside a panel (the nudge put "198 g" 1.2 under a story's side bar).
    const nudge = S.M <= Math.min(4, S.H * 0.06) + 1e-6 ? 0.03 * ss : 0
    els.push(disp(st.value, { size: ss, x: X(1) - nudge, top: y, color: 'accent', role: 'stat' }))
    y += CAP * ss + gapBelow(ss) * 0.5
    // The stat's own line, else the headline (the prototype's `c.statLine || c.title`).
    const role: RoleKey = st.line ? 'statline' : 'title'
    const line = st.line ?? c.title
    const n = countLines(line, SPAN(1, 9), inFace(SECOND, role), SECOND.size)
    els.push(sec(line, { x: X(1), w: SPAN(1, 9), top: y, role }))
    y += blockH(n, SECOND.size, SECOND.lh)
    const top = y + groupGap()
    const { date: _number, ...rest } = c                                  // the stat is the figure
    const foot = offerBox(S, rest, { x: X(1), w: SPAN(1, 12), bottom: L(16) })
    const h = foot.top - groupGap() * 0.7 - top
    els.unshift(h > RH * 3 ? { k: 'p', x: 0, y: top, w: W, h, stand: !ph, role: 'photo', bleed: true } : noRoom)
    return { els: [...els, ...foot.els], did: 'One giant figure and the line that explains it; the product runs edge to edge below.' }
  },
}

/** Review — a customer's words lead: stars and the quote, the product below, logo and button at the foot. */
export const perfReview: LayoutDef = {
  id: 'perfReview', name: 'Review', fits: [...ALL], style: 'performance', oneLineFirst: true,
  needs: { image: true }, needsContent: ['review'],
  fn(S, { c, ph }) {
    const { X, XR, SPAN, RH, W, L, INFO, SECOND, DISPLAY, blockH, countLines, breakLines, text, disp, info, button, logo, logoH, stars, gapBelow, groupGap } = S
    const rv = c.review!
    const els: El[] = []
    let y = topY(S)
    const sSize = Math.max(INFO.size * 2.2, SECOND.size * 0.85)
    const rating = c.raw?.rating
    if (rv.stars != null) {
      els.push(stars(rv.stars, X(1), y, sSize))
      // The number after the stars (the prototype's `.stars b`: 0.62 em, 0.5 em after, centred on
      // the stars) — the user's own rating line.
      if (rating) {
        const rs = Math.max(sSize * 0.62, INFO.size)
        const x = X(1) + sSize * (5 + 4 * STAR_GAP) + 0.5 * rs
        els.push(text(rating, { role: 'rating', size: rs, ls: 0, lh: 1, pre: true, x, base: y + sSize / 2 + capOf(S, 'rating') * rs / 2 }))
      }
      y += sSize + gapBelow(sSize) * 0.6
    } else if (rating) {
      // A rating line tagged by the user that is not a number of stars: set as it is.
      const n = countLines(rating, SPAN(1, 10), inFace(INFO, 'rating'), INFO.size)
      els.push(info(rating, { x: X(1), w: SPAN(1, 10), top: y, role: 'rating' }))
      y += blockH(n, INFO.size, INFO.lh) + gapBelow(INFO.size)
    }
    // Ruling R4: the quote as the user wrote it — no quote marks added.
    const QUOTE = inFace(DISPLAY, 'quote')
    const words = rv.quote.split(/\s+/).filter(Boolean)
    let qs = Math.max(RH * 2, INFO.size * 1.6)
    let ql = breakLines(words, SPAN(1, 12), qs, QUOTE)
    for (; qs > INFO.size * 1.5; qs *= 0.95) {
      ql = breakLines(words, SPAN(1, 12), qs, QUOTE)
      if (ql.length <= 3 && blockH(ql.length, qs, DISPLAY.lh) <= RH * 4.2) break
    }
    els.push(disp(ql.join('\n'), { size: qs, x: X(1), top: y, role: 'quote' }))
    y += blockH(ql.length, qs, DISPLAY.lh) + gapBelow(qs) * 0.9
    if (rv.by) {
      // The reviewer as written (the prototype added "— "; the user's line carries its own dash).
      const n = countLines(rv.by, SPAN(1, 10), inFace(INFO, 'by'), INFO.size)
      els.push(info(rv.by, { x: X(1), w: SPAN(1, 10), top: y, role: 'by' }))
      y += blockH(n, INFO.size, INFO.lh)
    }
    const top = y + groupGap()
    let footTop = L(16)
    let btnMid: number | null = null
    if (c.action) {
      const bh = button(c.action, 0, 0).btn.h
      const b = button(c.action, XR(12), L(16) - bh, { align: 'right' })
      els.push(b.btn, b.text)
      footTop = b.btn.y
      btnMid = b.btn.y + b.btn.h / 2
    }
    if (c.logo) {
      const h = logoH()
      const lg = logo(X(1), btnMid != null ? btnMid - h / 2 : L(16) - h, h, { aspect: c.logo.aspect })
      els.push(lg)
      footTop = Math.min(footTop, lg.y)
    }
    const h = footTop - groupGap() * 0.8 - top
    els.unshift(h > RH * 3 ? { k: 'p', x: X(5), y: top, w: W - X(5), h, stand: !ph, role: 'photo', bleed: true } : noRoom)
    return { els, did: 'A customer’s words lead: stars and the quote, the product below, logo and button at the foot.' }
  },
}

/** Us vs them — the headline, then a two-column table: yours ticked in accent, the other side greyed out. */
export const perfVersus: LayoutDef = {
  id: 'perfVersus', name: 'Us vs them', fits: [...ALL], style: 'performance', oneLineFirst: true,
  needs: { image: true }, needsContent: ['compare'],
  fn(S, { c, ph, lines }) {
    const { X, SPAN, RH, CAP, L, INFO, SECOND, DISPLAY, sizeFor, blockH, countLines, breakLines, text, disp, info, rule, own, gapBelow, groupGap } = S
    const cmp = c.compare!
    const els: El[] = []
    let y = topY(S)
    const size = sizeFor(lines, SPAN(1, 12), RH * 1.8)
    els.push(disp(lines.join('\n'), { size, x: X(1), top: y }))
    y += blockH(lines.length, size, DISPLAY.lh) + groupGap()
    const usX = X(7), usW = SPAN(7, 9), thX = X(10), thW = SPAN(10, 12)
    const imgH = Math.min(usW * 1.1, RH * 3.2)
    els.push({ k: 'p', x: usX, y, w: usW, h: imgH, stand: !ph, role: 'photo', radius: 1 })
    y += imgH + gapBelow(INFO.size)
    // The column headings: the product name (the details line) and the user's own "vs …" line.
    const them = c.raw?.them ?? cmp.them
    const usN = c.details ? countLines(c.details, usW, inFace(INFO, 'details'), INFO.size) : 1
    const hn = Math.max(usN, countLines(them, thW, inFace(INFO, 'them'), INFO.size))
    els.push(c.details
      ? info(c.details, { x: usX, w: usW, top: y, role: 'details' })
      : own('Ours', { x: usX, top: y, role: 'us' }))
    els.push(info(them, { x: thX, w: thW, top: y, role: 'them', opacity: 0.55 }))
    y += blockH(hn, INFO.size, INFO.lh) + gapBelow(INFO.size) * 1.2
    // The rows: each the user's own list line (ruling R5 — runs of the one list layer), wrapped
    // inside columns 1–6; ✓ / ✕ are the layout's own words.
    const ls = SECOND.size * 0.72, rowH = Math.max(ls * 2.4, INFO.size * 3), LH = 1.1
    const LIST: Style = { role: faceOf('list'), ls: -0.01, lh: LH }
    const gs = ls * 1.15, gCap = capOf(S, 'caption')
    const labels = listLines(c, cmp.rows.map(r => r.label))
    cmp.rows.forEach((row, i) => {
      els.push(rule(X(1), y, SPAN(1, 12)))
      const label = labels[i]!.replace(BOTH_RE, '')
      const ll = breakLines(label.split(/\s+/).filter(Boolean), SPAN(1, 6), ls, LIST)
      const bh = blockH(ll.length, ls, LH)
      const h = Math.max(rowH, bh + rowH - CAP * ls)                     // the prototype's padding, around every line
      const base = y + (h - bh) / 2 + bh
      els.push(text(ll.join('\n'), { size: ls, ls: -0.01, lh: LH, x: X(1), w: SPAN(1, 6), base, role: i ? `list${i}` : 'list' }))
      const gBase = y + h / 2 + gCap * gs / 2
      els.push(own(row.us ? '✓' : '✕', { size: gs, wt: 700, x: usX, base: gBase, color: row.us ? 'accent' : 'ink', ...(row.us ? {} : { opacity: 0.4 }), role: `us${i}` }))
      els.push(own(row.them ? '✓' : '✕', { size: gs, wt: 700, x: thX, base: gBase, opacity: 0.4, role: `th${i}` }))
      y += h
    })
    els.push(rule(X(1), y, SPAN(1, 12)))
    const { details: _details, ...rest } = c                              // the product name heads its column
    const foot = offerBox(S, rest, { x: X(1), w: SPAN(1, 12), bottom: L(16) })
    if (foot.top < y + groupGap() * 0.8) els.push({ k: 'missing', why: 'the table leaves no room for the offer' })
    return { els: [...els, ...foot.els], did: 'The headline, then a two-column table: yours ticked in accent, the other side greyed out.' }
  },
}

/** The Stage 4 Performance layouts, in the prototype's order (seed order: appended after Street). */
export const PERFORMANCE_AD_LAYOUTS: LayoutDef[] = [perfOfferFirst, perfStat, perfReview, perfVersus]
