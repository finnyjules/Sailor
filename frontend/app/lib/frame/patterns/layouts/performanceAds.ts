import type { Content, El, LayoutDef, MissingEl, RectEl, RoleKey, Sheet, Style, TextEl } from '../kit/types'
import { faceOf } from '../kit/types'
import { BOTH_RE } from '../kit/content'
import { STAR_GAP } from '../kit/check'
import { headStack, numberOf, numStyle, offerBox } from './performance'

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
//
// Task 5 adds `perfBeforeAfter`, `perfCallouts`, `perfListicle`, `perfNotes`, `perfPostit` (the
// prototype's ~1368–1451), with rulings R4–R6:
// - Before / after: the first image is "before", the second (`image2`) "after"; neither gets a
//   filter (the prototype greyed the "before" — that would change the user's image). "Before" and
//   "After" are the layout's own words, each on an owned card of page colour (owned text over an
//   image always sits on a covering piece).
// - Feature callouts, Reasons why, Notes app: the list is ONE user layer placed as runs (R5), each
//   item the user's own line. Reasons why's numbers and the Notes app's bullets are owned text, drawn
//   only when the user's lines carry no marker of their own — else their markers stand in for them.
//   The leader lines and dots are owned. Every item is placed (the prototype cut the list to three
//   or four; a line of the user's layer is never silently dropped).
// - Notes app: the paper (#fbf8f1), the amber chrome (#d49a1a) and the bullets (#2a2722) are fixed
//   colours by design (R6); the user's text on the paper is checked against it. The prototype's
//   title colour and weight are dropped (the user's own).
// - Post-it: the note (#ffe45c) is a fixed fill (R6); the user's text on it keeps its own face —
//   no handwriting face (Caveat), no red number (the number is the user's date line). No shadow
//   (the kit's pieces have none). It needs no content (ruling C2: `needsContent: []`), so it reads
//   the content view and hides the lines it does not place.

const ALL = ['word', 'phrase', 'sentence'] as const

/** The top of the first block: the margin, or most of the panel inset. */
const topY = (S: Sheet) => Math.max(S.M, S.inset() * 0.8)

/** `st`, measured in the face of the line `role` holds. */
const inFace = (st: Style, role: RoleKey): Style => ({ ...st, role: faceOf(role) })

/** Cap height (cap top → baseline) of the face `role` is measured in, as a fraction of size. */
const capOf = (S: Sheet, role: RoleKey) => S.measure.capAbove(faceOf(role)) + S.measure.baseBelow(faceOf(role))

const noRoom: MissingEl = { k: 'missing', why: 'no room for the image' }

/** What an offer foot (`offerBox`) really draws, for a layout's `did`, most prominent first: the
 *  offer (the number), the button (none without an action line, or with the platform's own — the
 *  action has then left the content), the fine print. Every Performance ad says only what it drew. */
function footOf(c: Content): string[] {
  return [numberOf(c) ? 'the offer' : '', c.action ? 'the button' : '', c.caption ? 'the fine print' : ''].filter(Boolean)
}

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
      els: [photo, { k: 'r', x: 0, y: 0, w: W, h: blockB, color: 'accent', prefer: 'accent', role: 'panel', ok: true, bleed: true }, ...blk,
        band('bottom', foot.top, H), ...foot.els],
      did: 'The number leads on a solid panel at the top — in the accent colour when the text reads on it; the product fills the rest'
        + (footOf(rest).includes('the button') ? ', with the button at the foot.' : '.'),
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
    // as inside a panel (the nudge put "198 g" under a story's side bar).
    const nudge = S.defaultMargin ? 0.03 * ss : 0
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
    // Say only what was drawn: stars only with a number of stars, the logo and the button only when there.
    const atFoot = [c.logo ? 'the logo' : '', ...footOf({ title: c.title, ...(c.action ? { action: c.action } : {}) })].filter(Boolean)
    const did = `A customer’s words lead: ${rv.stars != null ? 'stars and the quote' : 'the quote'}, the product below`
      + (atFoot.length ? `, ${atFoot.join(' and ')} at the foot.` : '.')
    return { els, did }
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

// ─── Task 5 ───

/** The Notes app's own colours (ruling R6): paper, the amber chrome, the body text (bullets). */
const NOTES_PAPER = '#fbf8f1'
const NOTES_CHROME = '#d49a1a'
const NOTES_INK = '#2a2722'
/** The Post-it's note (ruling R6). */
const POSTIT = '#ffe45c'

const wordsOf = (s: string) => s.split(/\s+/).filter(Boolean)
/** A list item's role: the one list layer's runs (`list`, `list1`, …). */
const listRole = (i: number) => (i ? `list${i}` : 'list')
/** Ruling R5: the user's lines carry markers of their own (a line differs from its stripped item). */
const hasMarkers = (c: Content, items: string[]) => listLines(c, items).some((l, i) => l !== items[i])
/** The list's style: measured in the list's face (the caption's). */
const listStyle = (ls: number, lh: number): Style => ({ role: faceOf('list'), ls, lh })

/** Before / after — two halves, the first image "before" and the second "after", over a band with
 *  the headline and the offer. */
export const perfBeforeAfter: LayoutDef = {
  id: 'perfBeforeAfter', name: 'Before / after', fits: [...ALL], style: 'performance', oneLineFirst: true,
  needs: { image: true }, needsContent: ['image2'],
  fn(S, { c, ph, lines }) {
    const { X, SPAN, RH, W, L, INFO, SECOND, DISPLAY, sizeFor, blockH, disp, own, w100, gapBelow, inset } = S
    const pad = inset()
    const foot = offerBox(S, c, { x: X(1), w: SPAN(1, 12), bottom: L(16) })
    const size = sizeFor(lines, SPAN(1, 12), RH * 1.6)
    const tb = foot.top - gapBelow(SECOND.size) * 1.5
    const bandTop = tb - blockH(lines.length, size, DISPLAY.lh) - pad
    const half = W / 2
    // The labels: the layout's own words on an owned card of page colour (the prototype's `tg`).
    const ts = INFO.size * 1.2, p = ts * 0.7, LS = 0.06, cap = capOf(S, 'caption')
    const label = (s: string, x: number, role: string): El[] => {
      const tw = w100(s, { role: 'caption', ls: LS, lh: 1 }) / 100 * ts, y = topY(S)
      const card: RectEl = { k: 'r', x, y, w: tw + 2 * p, h: cap * ts + 2 * p, color: 'field', role: 'card', ok: true }
      return [card, own(s, { size: ts, wt: 600, ls: LS, lh: 1, x: x + p, top: y + p, role, over: ['card', 'photo'] })]
    }
    // The prototype does not guard it: a foot that reaches the top leaves the images no room.
    if (bandTop < topY(S) + cap * ts + 2 * p + RH * 2) return { els: [{ k: 'missing', why: 'no room for the images' }], did: '' }
    return {
      els: [
        // Neither image gets a filter: the prototype greyed the "before", which would change the user's image.
        { k: 'p', x: 0, y: 0, w: half, h: bandTop, stand: !ph, role: 'photo', bleed: true },
        { k: 'p', x: half, y: 0, w: W - half, h: bandTop, stand: !ph, role: 'photo2', bleed: true },
        { k: 'r', x: half - 0.25, y: 0, w: 0.5, h: bandTop, color: 'field', role: 'divider', ok: true, bleed: true },
        ...label('Before', X(1), 'before'), ...label('After', half + X(1), 'after'),
        disp(lines.join('\n'), { size, x: X(1), base: tb }), ...foot.els],
      did: 'Two halves, before and after, with the headline and the offer below them on the page colour. Needs two images; Meta limits this for health products.',
    }
  },
}

/** Feature callouts — the product in the centre, the list's lines pointed at it by thin lines. */
export const perfCallouts: LayoutDef = {
  id: 'perfCallouts', name: 'Feature callouts', fits: [...ALL], style: 'performance', oneLineFirst: true,
  needs: { image: true }, needsContent: ['list'],
  fn(S, { c, ph, lines }) {
    const { X, XR, SPAN, RH, L, INFO, GAP, PHOTO_ASPECT, blockH, breakLines, text, leader, w100, groupGap } = S
    const items = c.list!
    const n = items.length
    // The prototype pointed at three; two a side is the most that reads. Every line is placed (R5).
    if (n > 4) return { els: [{ k: 'missing', why: 'more lines in the list than callouts can point at' }], did: '' }
    const head = headStack(S, c, lines, 1, 12)
    const els: El[] = [...head.els]
    const y = head.bottom + groupGap()
    const { details: _details, ...rest } = c                              // as the prototype: no product name
    const foot = offerBox(S, rest, { x: X(1), w: SPAN(1, 12), bottom: L(16) })
    const bottom = foot.top - groupGap()
    const h = Math.min(bottom - y, SPAN(4, 9) * PHOTO_ASPECT), w = h / PHOTO_ASPECT
    const px = (X(1) + XR(12)) / 2 - w / 2, py = y + (bottom - y - h) / 2
    if (h < RH * 4) return { els: [noRoom], did: '' }
    els.push({ k: 'p', x: px, y: py, w, h, stand: !ph, role: 'photo', over: ['dot'] })
    const ls = INFO.size * 1.25, LH = 1.2, lw = Math.max(SPAN(1, 3), px - X(1) - GAP * 2)
    const LIST = listStyle(0, LH)
    const labels = listLines(c, items)
    labels.forEach((t, i) => {
      // The prototype's 0.2 / 0.5 / 0.8 of the image's height, spread over however many there are.
      const left = i % 2 === 0, cy = py + h * (n === 1 ? 0.5 : 0.2 + 0.6 * i / (n - 1))
      const ll = breakLines(wordsOf(t), lw, ls, LIST), bh = blockH(ll.length, ls, LH)
      const x = left ? X(1) : XR(12) - lw
      els.push(text(ll.join('\n'), { size: ls, ls: 0, lh: LH, x, w: lw, top: cy - bh / 2, align: left ? 'left' : 'right', role: listRole(i) }))
      // The line starts beside the label's own ink (the prototype started it at the label's box, so a
      // short right-hand label floated away from its line).
      const ink = Math.min(lw, Math.max(...ll.map(l => w100(l, LIST) / 100 * ls)))
      const lx = left ? X(1) + ink + GAP * 0.6 : XR(12) - ink - GAP * 0.6, tx = left ? px + w * 0.22 : px + w * 0.78
      els.push(leader(lx, cy, tx, cy), { k: 'c', cx: tx, cy, r: 0.8, color: 'accent', role: 'dot', over: ['photo'] })
    })
    return { els: [...els, ...foot.els], did: 'The product in the centre with its features pointed out by thin lines.' }
  },
}

/** Reasons why — a numbered list of reasons beside the product, the offer at the foot. */
export const perfListicle: LayoutDef = {
  id: 'perfListicle', name: 'Reasons why', fits: [...ALL], style: 'performance', oneLineFirst: true,
  needs: { image: true }, needsContent: ['list'],
  fn(S, { c, ph, lines }) {
    const { X, XR, SPAN, G, W, L, INFO, SECOND, DISPLAY, breakLines, text, own, groupGap } = S
    const items = c.list!
    const head = headStack(S, c, lines, 1, 12)
    const els: El[] = [...head.els]
    const y = head.bottom + groupGap()
    const { details: _details, ...rest } = c                              // as the prototype: no product name
    const foot = offerBox(S, rest, { x: X(1), w: SPAN(1, 12), bottom: L(16) })
    const bottom = foot.top - groupGap(), slot = (bottom - y) / items.length
    if (slot < INFO.size * 3) return { els: [{ k: 'missing', why: 'no room for the list' }], did: '' }
    els.unshift({ k: 'p', x: X(8), y, w: W - X(8), h: bottom - y, stand: !ph, role: 'photo', bleed: true })
    // Ruling R5: the numbers are the layout's own words — unless the user numbered or bulleted the
    // lines themselves; then their markers lead and the lines start at the margin.
    const marked = hasMarkers(c, items)
    const ns = Math.min(SECOND.size * 1.5, slot * 0.55 / capOf(S, 'caption'))
    const ts = Math.max(INFO.size * 1.2, SECOND.size * 0.7), LH = 1.15
    const tx = marked ? X(1) : X(2) + G, tw = XR(7) - tx
    const LIST = listStyle(-0.01, LH)
    listLines(c, items).forEach((t, i) => {
      const top = y + i * slot
      if (!marked) els.push(own(String(i + 1), { size: ns, wt: 700, ls: DISPLAY.ls, x: X(1), top, color: 'accent', role: `n${i}` }))
      els.push(text(breakLines(wordsOf(t), tw, ts, LIST).join('\n'), { size: ts, ls: -0.01, lh: LH, x: tx, w: tw, top, role: listRole(i) }))
    })
    // Numbered only when the layout drew the numbers (the user's own markers lead otherwise).
    const inFoot = footOf(rest)[0]
    return { els: [...els, ...foot.els], did: `A ${marked ? '' : 'numbered '}list of reasons beside the product` + (inFoot ? `, ${inFoot} at the foot.` : '.') }
  },
}

/** Notes app — looks like a phone note, not an ad: the headline, the list, the image pasted in. */
export const perfNotes: LayoutDef = {
  id: 'perfNotes', name: 'Notes app', fits: [...ALL], style: 'performance', oneLineFirst: true,
  needs: { image: true }, needsContent: ['list'],
  fn(S, { c, ph, lines }) {
    const { X, XR, SPAN, RH, W, H, L, INFO, SECOND, PHOTO_ASPECT, sizeFor, blockH, breakLines, text, own, w100, gapBelow, groupGap } = S
    // The notes app's own paper and amber, on purpose (ruling R6).
    const els: El[] = [{ k: 'r', x: 0, y: 0, w: W, h: H, hex: NOTES_PAPER, role: 'paper', ok: true, bleed: true }]
    let y = topY(S)
    const ui = INFO.size * 1.3
    const doneW = w100('Done', { role: 'caption', ls: 0, lh: 1 }) / 100 * ui
    els.push(own('‹ Notes', { size: ui, wt: 500, x: X(1), top: y, hex: NOTES_CHROME, role: 'ui' }),
      own('Done', { size: ui, wt: 600, x: XR(12) - doneW, top: y, hex: NOTES_CHROME, role: 'ui2' }))
    y += capOf(S, 'caption') * ui + groupGap() * 0.8
    // The headline in the user's own face and colour (the prototype set it 700 in near-black).
    const T: Style = { role: 'title', ls: -0.02, lh: 1.05 }
    const ts = sizeFor(lines, SPAN(1, 12), RH * 1.3 * lines.length, T)
    els.push(text(lines.join('\n'), { size: ts, ls: -0.02, lh: 1.05, x: X(1), top: y, pre: true, role: 'title' }))
    y += blockH(lines.length, ts, 1.05) + gapBelow(ts)
    // The list: the user's lines as runs (R5); the bullets are the note's own, unless the user's
    // lines carry markers.
    const items = c.list!
    const marked = hasMarkers(c, items)
    const bs = Math.max(INFO.size * 1.25, SECOND.size * 0.7), LH = 1.3
    const tx = marked ? X(1) : X(1) + w100('•', { role: 'caption', ls: 0, lh: 1 }) / 100 * bs + bs * 0.55
    const LIST = listStyle(0, LH)
    listLines(c, items).forEach((t, i) => {
      if (!marked) els.push(own('•', { size: bs, x: X(1), top: y, hex: NOTES_INK, role: `b${i}` }))
      const ll = breakLines(wordsOf(t), XR(12) - tx, bs, LIST)
      els.push(text(ll.join('\n'), { size: bs, ls: 0, lh: LH, x: tx, w: XR(12) - tx, top: y, role: listRole(i) }))
      y += blockH(ll.length, bs, LH) + bs * 0.6
    })
    const top = y + groupGap(), h = Math.min(L(16) - top, SPAN(1, 7) * PHOTO_ASPECT), w = h / PHOTO_ASPECT
    els.push(h > RH * 3 ? { k: 'p', x: X(1), y: top, w, h, stand: !ph, role: 'photo', radius: 1.6 } : noRoom)
    return { els, did: 'Looks like a phone note, not an ad: the headline, the list, the image pasted in. No logo, no button.' }
  },
}

/** Where a text box's own centre must sit so that turning it `deg` about its centre puts it where
 *  turning it about `pivot` would — the prototype's `transform-origin` at the note's centre. */
function turnedAbout(e: TextEl, box: { x0: number; y0: number; x1: number; y1: number }, pivot: { x: number; y: number }, deg: number): TextEl {
  const a = deg * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a)
  const cx = (box.x0 + box.x1) / 2 - pivot.x, cy = (box.y0 + box.y1) / 2 - pivot.y
  const dx = cx * cos - cy * sin - cx, dy = cx * sin + cy * cos - cy
  return { ...e, x: e.x + dx, ...(e.top != null ? { top: e.top + dy } : {}), rot: deg, origin: 'center' }
}

/** Post-it — the product fills the page with a note stuck on it; the button on a band at the foot. */
export const perfPostit: LayoutDef = {
  id: 'perfPostit', name: 'Post-it', fits: [...ALL], style: 'performance', oneLineFirst: true,
  needs: { image: true }, needsContent: [],
  fn(S, { c, ph, lines }) {
    const { X, SPAN, GAP, H, L, CAP, sizeFor, fitSize, blockH, text, w100, cover, band } = S
    const { date: _number, details: _details, ...cc } = c                 // the number goes on the note
    const foot = offerBox(S, cc, { x: X(1), w: SPAN(1, 12), bottom: L(16) })
    const nw = SPAN(1, 7), nh = nw * 0.92, nx = X(1) + GAP, ny = topY(S) + GAP, pad = nw * 0.1, ROT = -4
    const LH = 1.02
    const T: Style = { role: 'title', ls: 0, lh: LH }, D: Style = { role: 'date', ls: 0, lh: LH }
    const num = numberOf(c)
    const rows = num ? [...lines, num] : lines
    let size = sizeFor(rows, nw - 2 * pad, nh * 0.62, T)
    if (num) size = Math.min(size, fitSize([num], nw - 2 * pad, D))
    const top = ny + (nh - blockH(rows.length, size, LH)) / 2
    const pivot = { x: nx + nw / 2, y: ny + nh / 2 }
    const over = ['sticker', 'photo']
    // Each text turns with the note, about the note's centre.
    const place = (s: string, st: Style, role: RoleKey, capTop: number, n: number): TextEl => {
      const wide = Math.max(...s.split('\n').map(l => w100(l, st) / 100 * size))
      const x0 = nx + pad, cap = role === 'title' ? CAP : capOf(S, role)
      return turnedAbout(text(s, { size, ls: 0, lh: LH, x: x0, top: capTop, pre: true, role, over }),
        { x0, y0: capTop, x1: x0 + wide, y1: capTop + ((n - 1) * LH + cap) * size }, pivot, ROT)
    }
    const els: El[] = [cover(ph), band('bottom', foot.top, H),
      { k: 'r', x: nx, y: ny, w: nw, h: nh, hex: POSTIT, rot: ROT, role: 'sticker', over: ['photo'] },
      place(lines.join('\n'), T, 'title', top, lines.length)]
    if (num) els.push(place(num, D, 'date', top + lines.length * size * LH, 1))
    // Say what the foot really holds: the button (none without an action, or with the platform's
    // own), else the fine print, else nothing.
    const inFoot = footOf(cc)[0]
    const foot1 = inFoot ? `; ${inFoot} sits on a band at the foot.` : '.'
    return { els: [...els, ...foot.els], did: 'The product fills the page with a note stuck on it' + foot1 }
  },
}

/** The Stage 4 Performance layouts, in the prototype's order (seed order: appended after Street). */
export const PERFORMANCE_AD_LAYOUTS: LayoutDef[] = [perfOfferFirst, perfStat, perfReview, perfVersus,
  perfBeforeAfter, perfCallouts, perfListicle, perfNotes, perfPostit]
