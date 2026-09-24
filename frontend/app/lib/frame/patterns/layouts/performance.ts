import type { Content, El, LayoutDef, Sheet, Style } from '../kit/types'
import { isNumberish } from '../hierarchy'

// ═══════════════════════ Performance layouts ═══════════════════════
// Ported from the prototype (docs/superpowers/specs/assets/2026-09-23-frame-layout-system/
// layout-pane.html, `defS('performance', …)` ~1219–1292, with its helpers `offerBox`,
// `offerStack` and `headStack` ~1189–1216). The product fills the Frame; text only ever sits on
// the page colour (bands, cards, panels, stickers). Geometry is the prototype's, unchanged.
// What differs, none of it geometry:
// - A block whose text is absent is skipped (and takes no height) — as the prototype already does.
// - Text is measured in the face of the role it is drawn in: the number (the date's text, drawn
//   in the display style) in the date's face, the title in the title's.
// - The prototype's `scrim` is the kit's `band`; its button element is the kit's `button()`
//   pair (the owned shape + the user's own action text), built at its final position.
// - The logo is the brand kit's (`c.logo`: `{ url, aspect }`), drawn at its own aspect.
// - UI copy says "image", not "photo"; a missing piece quotes the Frame's own text.

const ALL = ['word', 'phrase', 'sentence'] as const

/** The number an offer leads with: the date's text when it is number-like ("–30%", "€49"). */
export const numberOf = (c: Content): string | null => (c.date && isNumberish(c.date) ? c.date : null)

/** The number is drawn in the display style but measured in the date's own face. */
export const numStyle = (S: Sheet): Style => ({ ...S.DISPLAY, role: 'date' })

/** The offer, up from the bottom of a box: fine print; the number and the button on one line;
 *  the product name. Returns the elements and the top of the stack. */
export function offerBox(S: Sheet, c: Content, bx: { x: number; w: number; bottom: number }, align: 'left' | 'center' = 'left'): { els: El[]; top: number } {
  const { INFO, SECOND, CAP, RH, GAP, SPAN, countLines, blockH, info, disp, sec, fitSize, w100, button, gapBelow, groupGap } = S
  const els: El[] = []
  const { x, w } = bx
  const cx = x + w / 2
  const o = align === 'center' ? { x, w, align } : { x, w }
  let y = bx.bottom
  if (c.caption) {
    const n = countLines(c.caption, w, INFO, INFO.size)
    els.push(info(c.caption, { ...o, base: y, role: 'caption' }))
    y -= blockH(n, INFO.size, INFO.lh) + groupGap() * 0.55
  }
  const num = numberOf(c)
  const action = c.action
  // The button's size does not depend on where it goes: measure it once, build it where it lands.
  const bt = action ? button(action, 0, 0).btn : null
  const placeBtn = () => {
    const b = button(action!, align === 'center' ? cx : x, y - bt!.h, align === 'center' ? { align: 'center' } : {})
    els.push(b.btn, b.text)
    y = b.btn.y - gapBelow(b.btn.size) * 1.6
  }
  if (num) {
    const NUM = numStyle(S)
    const ns = Math.min(fitSize([num], w > SPAN(1, 8) ? w * 0.42 : w * 0.72, NUM), RH * 1.6 / CAP)
    const nw = w100(num, NUM) / 100 * ns
    if (bt && align !== 'center' && nw + bt.w + GAP * 3 <= w) {   // number left, button right, on one centre line
      const rowH = Math.max(CAP * ns, bt.h), mid = y - rowH / 2
      els.push(disp(num, { size: ns, x, base: mid + CAP * ns / 2, color: 'accent', role: 'date' }))
      const b = button(action!, x + w, mid - bt.h / 2, { align: 'right' })
      els.push(b.btn, b.text)
      y -= rowH + gapBelow(SECOND.size) * 1.5
    } else {
      if (bt) placeBtn()
      els.push(disp(num, { ...o, size: ns, base: y, color: 'accent', role: 'date' }))
      y -= CAP * ns + gapBelow(SECOND.size) * 1.5
    }
  } else if (bt) placeBtn()
  // The prototype stepped up one line for the product name; in a narrow column (Price tag's half
  // on a 300×250 banner: 35.6 wide) "Halden Trail 2" wraps to two, and its second line ran into
  // the headline. Step up by the lines it really takes — the same height when it is one line.
  if (c.details) {
    els.push(sec(c.details, { ...o, base: y }))
    y -= blockH(countLines(c.details, w, SECOND, SECOND.size), SECOND.size, SECOND.lh)
  }
  return { els, top: y }
}

/** The offer at the foot of design columns `a`..`b`. */
const offerStack = (S: Sheet, c: Content, a: number, b: number, align: 'left' | 'center' = 'left') =>
  offerBox(S, c, { x: S.X(a), w: S.SPAN(a, b), bottom: S.L(16) }, align)

/** The logo (when the brand kit has one) and the headline from the top margin. */
export function headStack(S: Sheet, c: Content, lines: string[], a: number, b: number, align: 'left' | 'center' = 'left', maxRows = 1.9): { els: El[]; bottom: number } {
  const { M, RH, DISPLAY, X, XR, SPAN, sizeFor, blockH, disp, logo, logoH, clear } = S
  const els: El[] = []
  let top = M
  if (c.logo) {
    const lg = logo(align === 'center' ? (X(1) + XR(12)) / 2 : X(a), M, logoH(), { aspect: c.logo.aspect, align })
    els.push(lg)
    top = M + lg.h + clear(lg)
  }
  const size = sizeFor(lines, SPAN(a, b), RH * maxRows)
  els.push(disp(lines.join('\n'), align === 'center' ? { size, x: X(a), w: SPAN(a, b), align, top } : { size, x: X(a), top }))
  return { els, bottom: top + blockH(lines.length, size, DISPLAY.lh) }
}

/** Offer — the product fills the page; headline on a band at the top, the offer on a band at the foot
 *  (B: everything in one band rising from the foot). */
export const perfOffer: LayoutDef = {
  id: 'perfOffer', name: 'Offer', fits: [...ALL], style: 'performance', oneLineFirst: true,
  needs: { image: true },
  arrLabels: ['Two bands', 'One band'],
  fn(S, { c, ph, lines, arr = 0 }) {
    const { X, SPAN, RH, GAP, H, M, DISPLAY, sizeFor, blockH, disp, cover, band, logo, logoH } = S
    const foot = offerStack(S, c, 1, 12)
    if (arr === 1) {
      const size = sizeFor(lines, SPAN(1, 12), RH * 2.2)
      const tb = foot.top - GAP * 1.2, t = disp(lines.join('\n'), { size, x: X(1), base: tb })
      const top = tb - blockH(lines.length, size, DISPLAY.lh)
      const els: El[] = [cover(ph), band('bottom', top, H), t, ...foot.els]
      if (c.logo) els.push(band('top', 0, M + logoH()), logo(X(1), M, logoH(), { aspect: c.logo.aspect }))
      return { els, did: 'The product fills the page; headline and offer sit together on a band rising from the foot.' }
    }
    const head = headStack(S, c, lines, 1, 12)
    return {
      els: [cover(ph), band('top', 0, head.bottom), band('bottom', foot.top, H), ...head.els, ...foot.els],
      did: 'The product fills the page; headline on a band at the top, the offer on a band at the foot.',
    }
  },
}

/** Sticker — the product fills the page with the number on a round sticker. */
export const perfSticker: LayoutDef = {
  id: 'perfSticker', name: 'Sticker', fits: [...ALL], style: 'performance', oneLineFirst: true,
  needs: { image: true, number: true },
  arrLabels: ['Sticker right', 'Sticker left'],
  fn(S, { c, ph, lines, arr = 0 }) {
    const { X, XR, SPAN, H, RH, GAP, CAP, INFO, fitSize, disp, cover, band, q } = S
    const head = headStack(S, c, lines, 1, 12, 'left', 2.8)
    const num = numberOf(c)
    const { date: _number, ...cc } = c                       // the number goes on the sticker
    const foot = offerStack(S, cc, 1, 12)
    const els: El[] = [cover(ph), band('top', 0, head.bottom), band('bottom', foot.top, H), ...head.els, ...foot.els]
    if (num) {
      const r = Math.min(SPAN(1, 4), (foot.top - head.bottom) * 0.45) / 2
      const cx = arr === 1 ? X(1) + r : XR(12) - r, cy = head.bottom + GAP * 2.5 + r
      const ns = Math.min(fitSize([num], r * 1.4, numStyle(S)), r * 0.8 / CAP)
      if (ns < INFO.size * 1.5 || r < RH) els.push({ k: 'missing', why: `${q(num)} is too small to read on the sticker` })
      else {
        els.push(
          { k: 'c', cx, cy, r, color: 'accent', role: 'sticker', over: ['photo', 'band'] },
          disp(num, { size: ns, x: cx - r * 0.7, w: r * 1.4, align: 'center', base: cy + CAP * ns / 2, color: 'field', role: 'date', over: ['sticker', 'photo'], inside: 'sticker' }),
        )
      }
    }
    return { els, did: 'The product fills the page with the number on a round sticker; headline and button on soft bands.' }
  },
}

/** Price tag — the product fills half the Frame; the other half is a solid panel with the logo,
 *  the message and the offer. */
export const perfPriceTag: LayoutDef = {
  id: 'perfPriceTag', name: 'Price tag', fits: [...ALL], style: 'performance', oneLineFirst: true,
  needs: { image: true, number: true },
  arrLabels: ['Image left', 'Image right'],
  fn(S, { c, ph, lines, arr = 0 }) {
    const { XR, G, W, H, M, RH, CAP, DISPLAY, SECOND, fitSize, disp, cover, logo, logoH, clear, gapBelow, groupGap, inset } = S
    const right = arr !== 1, split = XR(6) + G / 2
    const px = right ? split : 0, pw = right ? W - split : split, pad = inset()
    const x0 = px + pad, cw = pw - 2 * pad
    const els: El[] = [cover(ph), { k: 'r', x: px, y: 0, w: pw, h: H, color: 'field', role: 'panel', ok: true, bleed: true }]
    let top = Math.max(M, pad * 0.8)
    if (c.logo) { const lg = logo(x0, top, logoH(), { aspect: c.logo.aspect }); els.push(lg); top += lg.h + clear(lg) }
    const offer = offerBox(S, c, { x: x0, w: cw, bottom: H - Math.max(M, pad * 0.8) })
    const hh = (lines.length - 1) * DISPLAY.lh + CAP
    const size = Math.min(fitSize(lines, cw), RH * 3.5 / hh, (offer.top - gapBelow(SECOND.size) - top - groupGap()) / hh)
    els.push(disp(lines.join('\n'), { size, x: x0, base: offer.top - gapBelow(size) }))
    els.push(...offer.els)
    return { els, did: 'The product fills half the Frame edge to edge; on the other half, the logo at the top and the message and offer at the foot.' }
  },
}

/** Card — the product fills the page; the offer sits on a solid card in a corner. */
export const perfCard: LayoutDef = {
  id: 'perfCard', name: 'Card', fits: [...ALL], style: 'performance', oneLineFirst: true,
  needs: { image: true },
  arrLabels: ['Card left', 'Card right'],
  fn(S, { c, ph, lines, arr = 0 }) {
    const { X, SPAN, L, M, INFO, cover, band } = S
    const head = headStack(S, c, lines, 1, 12)
    // The prototype pads the card by exactly the checker's minimum (0.9 × the margin) when the
    // margin wins; the checker's rule 6 allows 1e-6 of rounding for that tie (ruling R5).
    const [a, b] = arr === 1 ? [6, 12] : [1, 7], pad = Math.max(M * 0.9, INFO.size * 2.2)
    const offer = offerBox(S, c, { x: X(a) + pad, w: SPAN(a, b) - 2 * pad, bottom: L(16) - pad })
    const cardTop = offer.top - pad
    return {
      els: [cover(ph), band('top', 0, head.bottom), ...head.els,
        { k: 'r', x: X(a), y: cardTop, w: SPAN(a, b), h: L(16) - cardTop, color: 'field', radius: 1.4, role: 'card', ok: true }, ...offer.els],
      did: 'The product fills the page; the offer sits on a solid card in a corner.',
    }
  },
}

/** Centred — the product fills the page; everything else on one centre line, on soft bands. */
export const perfCentred: LayoutDef = {
  id: 'perfCentred', name: 'Centred', fits: [...ALL], style: 'performance', oneLineFirst: true,
  needs: { image: true },
  fn(S, { c, ph, lines }) {
    const { H, cover, band } = S
    const head = headStack(S, c, lines, 2, 11, 'center')
    const foot = offerStack(S, c, 2, 11, 'center')
    return {
      els: [cover(ph), band('top', 0, head.bottom), band('bottom', foot.top, H), ...head.els, ...foot.els],
      did: 'The product fills the page; everything else on one centre line, on soft bands top and bottom.',
    }
  },
}

/** Strip — one row for wide formats: the image on the left, then the logo, headline, number and
 *  button. Offered only when the (composed) sheet is wide (`wideOnly`). */
export const perfStrip: LayoutDef = {
  id: 'perfStrip', name: 'Strip', fits: [...ALL], style: 'performance', oneLineFirst: true,
  wideOnly: true,
  fn(S, { c, ph }) {
    const { X, XR, SPAN, W, H, M, GAP, CAP, PHOTO_ASPECT, fitSize, w100, disp, button, logo, logoH, clear } = S
    const els: El[] = [], mid = H / 2
    let x = X(1), right = XR(12)
    if (ph) {
      const w = Math.max(H / PHOTO_ASPECT, W * 0.3), h = w * PHOTO_ASPECT
      els.push({ k: 'p', x: 0, y: (H - h) / 2, w, h, role: 'photo', bleed: true })
      x = w + GAP * 2
    }
    if (c.logo) {
      const h = logoH(), lg = logo(x, mid - h / 2, h, { aspect: c.logo.aspect })
      els.push(lg)
      x = lg.x + lg.w + clear(lg)
    }
    if (c.action) {
      const bh = button(c.action, XR(12), 0, { align: 'right' }).btn.h
      const b = button(c.action, XR(12), mid - bh / 2, { align: 'right' })
      els.push(b.btn, b.text)
      right = b.btn.x - GAP * 2
    }
    const num = numberOf(c)
    if (num) {
      const NUM = numStyle(S)
      const ns = Math.min(fitSize([num], SPAN(1, 3), NUM), (H - 2 * M) * 0.7 / CAP)
      const nw = w100(num, NUM) / 100 * ns
      els.push(disp(num, { size: ns, x: right - nw, base: mid + CAP * ns / 2, color: 'accent', role: 'date' }))
      right -= nw + GAP * 2
    }
    const size = Math.min(fitSize([c.title], right - x), (H - 2 * M) * 0.8 / CAP)
    els.push(disp(c.title, { size, x, base: mid + CAP * size / 2 }))
    return { els, did: 'One row for wide formats: the image edge to edge on the left, then headline, the number, the button.' }
  },
}

/** The Performance layouts, in the prototype's order (seed order: appended after the 42). */
export const PERFORMANCE_LAYOUTS: LayoutDef[] = [perfOffer, perfSticker, perfPriceTag, perfCard, perfCentred, perfStrip]
