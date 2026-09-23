import type { TextKey, El, LayoutDef, PhotoEl, RectEl } from '../kit/types'
import { presentItems } from './swissLines'

// ═══════════════════════ the overlap family ═══════════════════════
// The main elements cross on purpose. Ported from the prototype (docs/superpowers/specs/assets/
// 2026-09-23-frame-layout-system/layout-sheet.html `defOver(...)` bodies; the pane has the same
// bodies, and renames Date behind to "Number behind" and gates it on a number). Geometry is the
// prototype's, unchanged. Each layout's `over` declarations exempt its own crossings from the
// collision rule, and its `premise.overlap` pairs make the checker insist the crossing is real.
// The same non-geometry differences as the Swiss layouts:
// - A block whose text is absent is skipped. When that text IS the crossing (Overprint's and
//   Ghost's details, Label's tag), the premise then fails and the layout refuses.
// - Text is measured in the face of the role it is drawn in (Overprint's and Ghost's large
//   details in the details face, Date behind's large date in the date face).
// - UI copy says "image", not "photo".

const ALL = ['word', 'phrase', 'sentence'] as const

/** The prototype's details / date / caption column (details at weight 500). */
const COLUMN: [TextKey, number?][] = [['details', 500], ['date'], ['caption']]

/** Overprint — the details, set as large as the title, overprint its lower half in accent. */
export const overprint: LayoutDef = {
  id: 'overprint', name: 'Overprint', fits: [...ALL],
  premise: { overlap: [['title', 'details']] },
  fn(S, { c, ph, lines }) {
    const { X, SPAN, L, M, GAP, DISPLAY, sizeFor, blockH, disp, info, infoRow, photoIn, FOOT2, q } = S
    const els: El[] = []
    const tTop = ph ? L(6) : L(2)
    const size = sizeFor(lines, SPAN(1, 12), (ph ? L(10) : L(9)) - tTop)
    const tH = blockH(lines.length, size, DISPLAY.lh)
    els.push(disp(lines.join('\n'), { size, x: X(1), top: tTop, over: ['details'] }))
    if (c.details) {
      const dLines = c.details.split(' ')
      const dTop = tTop + tH * 0.55
      const dSize = Math.min(size, sizeFor(dLines, SPAN(1, 12), L(15) - GAP - dTop, { ...DISPLAY, role: 'details' }))
      els.push(disp(dLines.join('\n'), { size: dSize, x: X(1), top: dTop, color: 'accent', blend: true, role: 'details', over: ['title'] }))
    }
    if (ph) {
      if (c.date) els.push(info(c.date, { x: X(1), w: SPAN(1, 6), top: M, role: 'date' }))
      els.push(photoIn({ c1: 7, c2: 12, top: M, bottom: tTop - GAP }))
      if (c.caption) els.push(info(c.caption, { x: X(1), w: SPAN(1, 6), base: L(16), role: 'caption' }))
    } else els.push(...infoRow(c, FOOT2, 'foot').els)
    return { els, did: `${q(c.details)}, set as large as the title, overprints its lower half in accent.` }
  },
}

/** Number behind — the date (a number), huge in accent, sits behind the title. */
export const dateBehind: LayoutDef = {
  id: 'dateBehind', name: 'Number behind', fits: [...ALL], smallText: true,
  needs: { number: true },
  premise: { overlap: [['title', 'date']] },
  fn(S, { c, ph, lines }) {
    const { X, SPAN, L, M, RH, GAP, DISPLAY, sizeFor, blockH, disp, infoRow, photoIn, q } = S
    // `needs.number` guarantees a date; without one there is nothing to set behind the title.
    if (!c.date) return { els: [{ k: 'missing', why: 'no number to set behind the title' }], did: '' }
    // short lines set bigger: "19.09.–15.11.2026" → 19.09. / –15.11. / 2026
    let dl = c.date.replace('–', '\n–').split('\n')
    const yr = dl[dl.length - 1]!.match(/^(.*\.)(\d{4})$/)
    if (yr && !/\d{4}/.test(dl[0]!)) dl = [...dl.slice(0, -1), yr[1]!, yr[2]!]
    const f = infoRow(c, [['details', 1, 4], ['caption', 5, 12]], 'foot')
    const dSize = sizeFor(dl, SPAN(1, 12), (ph ? L(7) : f.top - GAP) - M, { ...DISPLAY, role: 'date' })
    const els: El[] = [disp(dl.join('\n'), { size: dSize, x: X(1), top: M, color: 'accent', role: 'date', over: ['title'] })]
    const dH = blockH(dl.length, dSize, DISPLAY.lh)
    const size = sizeFor(lines, SPAN(1, 12), Math.min(RH * 6, dH * 0.8))
    const tH = blockH(lines.length, size, DISPLAY.lh)
    const base = M + dH / 2 + tH / 2                    // the title sits on the middle of the date block
    els.push(disp(lines.join('\n'), { size, x: X(1), base, blend: true, over: ['date'] }))
    els.push(...f.els)
    if (ph) els.push(photoIn({ c1: 1, c2: 12, top: Math.max(base, M + dH) + GAP, bottom: f.top - GAP }, { ay: 'bottom' }))
    return { els, did: `${q(c.date)}, huge in accent, sits behind the title.` }
  },
}

/** Tight stack — lines pulled so close that the letters cut into each other. */
export const tightStack: LayoutDef = {
  id: 'tightStack', name: 'Tight stack', fits: ['phrase', 'sentence'],
  fn(S, { c, ph, lines }) {
    const { X, SPAN, L, M, GAP, CAP, fitSize, disp, infoRow, photoIn, FOOT3 } = S
    const lh = 0.64
    const f = infoRow(c, FOOT3, 'foot')
    const base = ph ? L(8) : f.top - GAP * 1.5
    const size = Math.min(fitSize(lines, SPAN(1, 12)), (base - M) / ((lines.length - 1) * lh + CAP))
    const els: El[] = [disp(lines.join('\n'), { size, x: X(1), base, lh })]
    els.push(...f.els)
    if (ph) els.push(photoIn({ c1: 1, c2: 12, top: base + GAP, bottom: f.top - GAP }, { ay: 'bottom' }))
    return { els, did: 'Lines pulled so close that the letters cut into each other.' }
  },
}

/** Behind the image — the title passes behind the image and shows on either side of it. */
export const behindPhoto: LayoutDef = {
  id: 'behindPhoto', name: 'Behind the image', fits: [...ALL],
  needs: { image: true },
  premise: { overlap: [['title', 'photo']] },
  fn(S, { c, ph, kind, lines }) {
    const { X, XR, SPAN, L, M, RH, CAP, DISPLAY, fitSize, disp, sec, info, PHOTO_ASPECT } = S
    const top = L(2.5), h = Math.min(SPAN(4, 9) * PHOTO_ASPECT, L(14) - top), w = h / PHOTO_ASPECT
    const photo: PhotoEl = { k: 'p', x: (X(4) + XR(9) - w) / 2, y: top, w, h, stand: !ph, role: 'photo', over: ['title'] }
    const ls = kind === 'sentence' ? lines : [c.title]
    const hh = (ls.length - 1) * DISPLAY.lh + CAP
    const size = Math.min(fitSize(ls, SPAN(1, 12)), RH * 4.5 / hh, h * 0.8 / hh)
    const base = top + h / 2 + hh * size / 2
    const els: El[] = [disp(ls.join('\n'), { size, x: X(1), w: SPAN(1, 12), base, over: ['photo'], just: ls.length === 1 && ls[0]!.includes(' ') }), photo]
    if (c.details) els.push(sec(c.details, { x: X(1), w: SPAN(1, 8), top: M }))
    if (c.date) els.push(info(c.date, { x: X(9), w: SPAN(9, 12), top: M, role: 'date' }))
    if (c.caption) els.push(info(c.caption, { x: X(1), w: SPAN(1, 6), base: L(16), role: 'caption' }))
    return { els, did: 'The title passes behind the image and shows on either side of it.' }
  },
}

/** Collage — image, a circle and the title layered: the circle bites the corner, the title crosses the foot. */
export const collage: LayoutDef = {
  id: 'collage', name: 'Collage', fits: [...ALL],
  needs: { image: true, shape: true },
  premise: { overlap: [['title', 'photo'], ['shape', 'photo']] },
  fn(S, { c, ph, lines }) {
    const { X, SPAN, L, RH, GAP, CAP, DISPLAY, sizeFor, disp, sec, infoRow, FOOT2, PHOTO_ASPECT } = S
    const top = L(1), h = Math.min(SPAN(1, 8) * PHOTO_ASPECT, L(10) - top), w = h / PHOTO_ASPECT
    const photo: PhotoEl = { k: 'p', x: X(1), y: top, w, h, stand: !ph, role: 'photo', over: ['title', 'shape'] }
    const rad = Math.min(SPAN(1, 4), h * 0.7) / 2
    const circle: El = { k: 'c', cx: X(1) + w, cy: top + rad * 0.9, r: rad, color: 'accent', role: 'shape', over: ['photo'] }
    const size = sizeFor(lines, SPAN(1, 12), RH * 5)
    const base = top + h + CAP * size * 0.45 + (lines.length - 1) * DISPLAY.lh * size
    const els: El[] = [photo, circle, disp(lines.join('\n'), { size, x: X(1), base, over: ['photo'] })]
    if (c.details) els.push(sec(c.details, { x: X(1), w: SPAN(1, 8), top: base + GAP }))
    els.push(...infoRow(c, FOOT2, 'foot').els)
    return { els, did: 'Image, a circle and the title layered: the circle bites the corner, the title crosses the foot.' }
  },
}

/** Label — a tag in the field colour holds the smaller text and sits over the image's corner. */
export const label: LayoutDef = {
  id: 'label', name: 'Label', fits: [...ALL], smallText: true,
  // Its tag is always its own piece, never the user's shape, so a shape is not required (prototype asked for one).
  needs: { image: true },
  premise: { overlap: [['label', 'photo']] },
  fn(S, { c, ph, lines }) {
    const { X, SPAN, L, M, GAP, INFO, sizeFor, disp, infoStack, PHOTO_ASPECT } = S
    const h = Math.min(SPAN(1, 12) * PHOTO_ASPECT, L(10) - M), w = h / PHOTO_ASPECT
    const photo: PhotoEl = { k: 'p', x: X(1), y: M, w, h, stand: !ph, role: 'photo', over: ['label', 'details', 'date', 'caption'] }
    const pad = INFO.size * 1.1, lw = SPAN(1, 5) + 2 * pad
    const items = presentItems(c, COLUMN)
    const probe = infoStack(items, 1, 5, 0)
    const lh = probe.bottom + 2 * pad
    const ly = M + h - lh * 0.55
    const els: El[] = [photo]
    // With no smaller text there is nothing to put on the tag: no tag, so the premise refuses.
    if (items.length) {
      const tag: RectEl = { k: 'r', x: X(1), y: ly, w: lw, h: lh, color: 'field', role: 'label', over: ['photo'], ok: false }
      const st = infoStack(items, 1, 5, ly + pad)
      st.els.forEach((e) => { e.x = X(1) + pad; e.over = ['photo', 'label'] })
      els.push(tag, ...st.els)
    }
    const top = ly + lh + GAP * 1.5
    const size = sizeFor(lines, SPAN(1, 12), L(16) - top)
    els.push(disp(lines.join('\n'), { size, x: X(1), top }))
    return { els, did: 'A tag in the field colour holds the smaller text and sits over the image’s corner.' }
  },
}

/** Ghost — the details, enormous and faint, sit behind the title and run off the page. */
export const ghost: LayoutDef = {
  id: 'ghost', name: 'Ghost', fits: [...ALL],
  keepScale: true,
  premise: { overlap: [['title', 'details']] },
  fn(S, { c, ph, lines }) {
    const { X, L, M, W, RH, GAP, CAP, DISPLAY, SPAN, fitSize, sizeFor, blockH, disp, infoRow, photoIn, FOOT2, q } = S
    const size = sizeFor(lines, SPAN(1, 12), ph ? L(12) - L(8) : RH * 7)
    const base = L(12)
    const els: El[] = []
    if (c.details) {
      const gSize = Math.min(fitSize([c.details], (W - M) * 1.3, { ...DISPLAY, role: 'details' }), (L(15) - GAP - base) / (CAP * 0.5))
      const gBase = base + CAP * gSize * 0.5               // the ghost crosses the title's lower half
      els.push(disp(c.details, { size: gSize, x: M - 0.04 * gSize, base: gBase, bleed: true, opacity: 0.16, role: 'details', over: ['title', 'photo'] }))
    }
    els.push(disp(lines.join('\n'), { size, x: X(1), base, over: ['details'] }))
    els.push(...infoRow(c, FOOT2, 'foot').els)
    if (ph) els.push(photoIn({ c1: 1, c2: 12, top: M, bottom: base - blockH(lines.length, size, DISPLAY.lh) - GAP }))
    return { els, did: `${q(c.details)}, enormous and faint, sits behind the title and runs off the page.` }
  },
}
