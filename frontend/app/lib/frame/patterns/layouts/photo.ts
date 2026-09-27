import type { TextKey, El, LayoutDef } from '../kit/types'
import { presentItems } from './swissLines'

// ═══════════════════════ image-led layouts ═══════════════════════
// Ported from the prototype (docs/superpowers/specs/assets/2026-09-23-frame-layout-system/
// layout-sheet.html `defNew(...)` bodies; the pane has the same bodies). Geometry is the
// prototype's, unchanged. Every one of them `needs.image` (the prototype's `defNew`), so the
// planner never adds a side image: each layout places the frame's image itself. With no image
// layer the product shows them only in image mode, where the image is a stand-in (`stand`).
// The same non-geometry differences as the Swiss layouts:
// - A block whose text is absent is skipped (and takes no height) rather than set as `undefined`.
// - Text is measured in the face of the role it is drawn in.
// - UI copy says "image", not "photo".

const ALL = ['word', 'phrase', 'sentence'] as const

/** The prototype's details / date / caption column (details at weight 500). */
const COLUMN: [TextKey, number?][] = [['details', 500], ['date'], ['caption']]

/** Plate — like a museum plate: the image in nine columns, the smaller text beside it, the title underneath. */
export const plate: LayoutDef = {
  id: 'plate', name: 'Plate', fits: [...ALL],
  needs: { image: true },
  fn(S, { c, ph, lines }) {
    const { X, SPAN, L, LB, M, GAP, sizeFor, disp, infoStack, PHOTO_ASPECT } = S
    const h = Math.min(SPAN(1, 9) * PHOTO_ASPECT, L(10) - M), w = h / PHOTO_ASPECT
    const els: El[] = [{ k: 'p', x: X(1), y: M, w, h, stand: !ph, role: 'photo' }]
    els.push(...infoStack(presentItems(c, COLUMN), 10, 12, M).els)
    const top = M + h + GAP * 1.5
    const size = sizeFor(lines, SPAN(1, 12), LB(16) - top)
    els.push(disp(lines.join('\n'), { size, x: X(1), top }))
    return { els, did: 'Like a museum plate: the image in nine columns, the smaller text in a column beside it, the title underneath.' }
  },
}

/** Panel — the image covers the page; a solid panel in the field colour holds the type in the lower left. */
export const panel: LayoutDef = {
  id: 'panel', name: 'Panel', fits: [...ALL],
  needs: { image: true },
  fn(S, { c, ph, lines }) {
    const { X, XR, SPAN, L, LB, M, H, GAP, sizeFor, disp, info, infoRowAt, cover } = S
    const els: El[] = [cover(ph)]
    const px = XR(8) + M, py = L(9)
    els.push({ k: 'r', x: 0, y: py, w: px, h: H - py, color: 'field', role: 'panel', ok: true, bleed: true })
    const f = infoRowAt(c, [['details', 1, 4], ['date', 5, 8]], LB(16))
    els.push(...f.els)
    const top = py + M
    const size = sizeFor(lines, SPAN(1, 8), f.top - GAP * 1.5 - top)
    els.push(disp(lines.join('\n'), { size, x: X(1), top }))
    if (c.caption) els.push(info(c.caption, { x: X(1), w: SPAN(1, 6), top: M, color: 'field', role: 'caption' }))
    return { els, did: 'The image covers the page; a solid panel in the field colour holds the type in the lower left.' }
  },
}

/** Side split — the page split down the middle: the image on the left, type on a solid right half. */
export const sideSplit: LayoutDef = {
  id: 'sideSplit', name: 'Side split', fits: [...ALL],
  needs: { image: true },
  fn(S, { c, ph, words, lines, kind }) {
    const { X, XR, SPAN, L, LB, M, W, H, G, GAP, sizeFor, disp, stackBottom, cover } = S
    const els: El[] = [cover(ph)]
    const px = XR(5) + G / 2
    els.push({ k: 'r', x: px, y: 0, w: W - px, h: H, color: 'field', role: 'panel', ok: true, bleed: true })
    const st = stackBottom(presentItems(c, COLUMN), 7, 12, LB(16))
    els.push(...st.els)
    const ls = kind === 'word' ? lines : words
    const size = sizeFor(ls, SPAN(7, 12), st.top - GAP * 2 - M)
    els.push(disp(ls.join('\n'), { size, x: X(7), top: M }))
    return { els, did: 'The page split down the middle: the image on the left, type on a solid right half.' }
  },
}

/** Cross — a small centred image; the title runs across it and off the right edge. */
export const cross: LayoutDef = {
  id: 'cross', name: 'Cross', fits: [...ALL],
  needs: { image: true }, keepScale: true,
  fn(S, { c, ph, kind, lines }) {
    const { X, XR, SPAN, L, LB, M, W, RH, CAP, DISPLAY, fitSize, disp, sec, info, PHOTO_ASPECT } = S
    const top = L(3), h = Math.min(SPAN(4, 9) * PHOTO_ASPECT, L(14) - top), w = h / PHOTO_ASPECT
    const els: El[] = [{ k: 'p', x: (X(4) + XR(9) - w) / 2, y: top, w, h, stand: !ph, role: 'photo', ok: true }]
    const ls = kind === 'sentence' ? lines : [c.title]
    const hh = (ls.length - 1) * DISPLAY.lh + CAP
    const size = Math.min(fitSize(ls, W * 1.1 - M), RH * 4.5 / hh, (top + h * 0.62 - L(1.5)) / hh)
    const base = top + h * 0.62 + (ls.length - 1) * DISPLAY.lh * size * 0.5
    els.push(disp(ls.join('\n'), { size, x: M - 0.04 * size, base, bleed: true, ok: true }))
    if (c.details) els.push(sec(c.details, { x: X(1), w: SPAN(1, 8), top: M }))
    if (c.date) els.push(info(c.date, { x: X(9), w: SPAN(9, 12), top: M, role: 'date' }))
    if (c.caption) els.push(info(c.caption, { x: X(1), w: SPAN(1, 6), base: LB(16), role: 'caption' }))
    return { els, did: 'A small centred image; the title runs across it and off the right edge.' }
  },
}

/** Overlap — the image bleeds off the right edge; the title steps onto its left side. */
export const overlap: LayoutDef = {
  id: 'overlap', name: 'Overlap', fits: [...ALL],
  needs: { image: true },
  fn(S, { c, ph, lines }) {
    const { X, SPAN, L, LB, M, W, RH, sizeFor, disp, sec, info, PHOTO_ASPECT } = S
    const top = L(2), h = Math.min((W - X(5)) * PHOTO_ASPECT, L(14) - top), w = h / PHOTO_ASPECT, x = W - w
    const els: El[] = [{ k: 'p', x, y: top, w, h, stand: !ph, role: 'photo', ok: true, bleed: true }]
    const size = sizeFor(lines, SPAN(1, 8), RH * 6)
    const base = top + h * 0.55
    els.push(disp(lines.join('\n'), { size, x: X(1), base, ok: true }))
    if (c.details) els.push(sec(c.details, { x: X(1), w: SPAN(1, 4), top: M }))
    if (c.date) els.push(info(c.date, { x: X(9), w: SPAN(9, 12), top: M, role: 'date' }))
    if (c.caption) els.push(info(c.caption, { x: X(1), w: SPAN(1, 6), base: LB(16), role: 'caption' }))
    return { els, did: 'The image bleeds off the right edge; the title steps onto its left side.' }
  },
}

/** Stamp — the image small, like a stamp in the top-right module; the title takes the page. */
export const stamp: LayoutDef = {
  id: 'stamp', name: 'Stamp', fits: [...ALL],
  needs: { image: true },
  fn(S, { c, ph, lines }) {
    const { X, XR, SPAN, L, M, GAP, sizeFor, disp, sec, infoRow, PHOTO_ASPECT } = S
    const h = Math.min(SPAN(10, 12) * PHOTO_ASPECT, L(5) - M), w = h / PHOTO_ASPECT
    const els: El[] = [{ k: 'p', x: XR(12) - w, y: M, w, h, stand: !ph, role: 'photo' }]
    if (c.details) els.push(sec(c.details, { x: X(1), w: SPAN(1, 8), top: M }))
    const f = infoRow(c, [['date', 1, 4], ['caption', 5, 12]], 'foot'); els.push(...f.els)
    const base = f.top - GAP * 1.5
    const size = sizeFor(lines, SPAN(1, 12), base - (M + h + GAP * 1.5))
    els.push(disp(lines.join('\n'), { size, x: X(1), base }))
    return { els, did: 'The image small, like a stamp in the top-right module; the title takes the page.' }
  },
}

/** Column — the image in the first four columns; the title hangs from the same top line beside it. */
export const column: LayoutDef = {
  id: 'column', name: 'Column', fits: [...ALL],
  needs: { image: true },
  fn(S, { c, ph, kind, words, lines }) {
    const { X, SPAN, L, LB, M, GAP, sizeFor, disp, infoStack, PHOTO_ASPECT } = S
    const items = presentItems(c, COLUMN)
    const st0 = infoStack(items, 1, 4, 0)
    const h = Math.min(SPAN(1, 4) * PHOTO_ASPECT, LB(16) - M - st0.bottom - GAP), w = h / PHOTO_ASPECT
    const els: El[] = [{ k: 'p', x: X(1), y: M, w, h, stand: !ph, role: 'photo' }]
    els.push(...infoStack(items, 1, 4, M + h + GAP).els)
    const ls = kind === 'word' ? lines : words
    const size = sizeFor(ls, SPAN(6, 12), LB(16) - M)
    els.push(disp(ls.join('\n'), { size, x: X(6), top: M }))
    return { els, did: 'The image in the first four columns; the title hangs from the same top line beside it.' }
  },
}

/** Rising — type from the top margin; the image rises from the bottom edge. */
export const rising: LayoutDef = {
  id: 'rising', name: 'Rising', fits: [...ALL],
  needs: { image: true },
  fn(S, { c, ph, lines }) {
    const { X, SPAN, L, M, W, GAP, sizeFor, disp, infoRowAt, FOOT3, PHOTO_ASPECT } = S
    const top = L(9), w = W, h = W * PHOTO_ASPECT
    const els: El[] = [{ k: 'p', x: 0, y: top, w, h, stand: !ph, role: 'photo', bleed: true }]
    const row = infoRowAt(c, FOOT3, top - GAP)
    els.push(...row.els)
    const size = sizeFor(lines, SPAN(1, 12), row.top - GAP * 1.5 - M)
    els.push(disp(lines.join('\n'), { size, x: X(1), top: M }))
    return { els, did: 'Type from the top margin; the image rises from the bottom edge.' }
  },
}
