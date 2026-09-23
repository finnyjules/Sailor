import type { Content, El, LayoutDef } from '../kit/types'

// ═══════════════════════ Swiss core layouts ═══════════════════════
// Ported from the prototype (docs/superpowers/specs/assets/2026-09-23-frame-layout-system/
// layout-sheet.html `def(...)` bodies; layout-pane.html where it is newer). Geometry is the
// prototype's, unchanged. Task 8 ported Run-off (the planner's end-to-end layout); Task 9 adds
// the other nine (the pane and sheet bodies are identical for those nine).
//
// Two things differ from the prototype, neither of them geometry:
// - The prototype always has details, date and caption; a real Frame may not. A block whose
//   text is absent is skipped (and takes no height) rather than set as `undefined`.
// - Text is measured in the face of the role it is drawn in (the checker's rule), e.g. Index's
//   large date is fitted in the date's face, its table rows in their own role's face.

const ALL = ['word', 'phrase', 'sentence'] as const

/** Run-off — the pane version (arrangements A: right edge · B: left edge · C: lower baseline). */
export const runoff: LayoutDef = {
  id: 'runoff', name: 'Run-off', fits: [...ALL],
  oneLineFirst: true, keepScale: true,
  premise: { bleed: ['title'] },
  fn(S, { c, ph, kind, lines, arr = 0 }) {
    const { X, XR, SPAN, L, M, GAP, CAP, DISPLAY, fitSize, w100, disp, sec, infoRow, photoIn, FOOT2 } = S
    const base = arr === 2 ? L(12) : L(10)                 // A: right edge · B: left edge · C: lower baseline
    const ls = kind === 'word' ? [c.title] : lines
    const hh = (ls.length - 1) * DISPLAY.lh + CAP
    let size = fitSize(ls, (XR(12) + M) * 1.1 - M)
    size = Math.min(size, (base - (ph ? L(5) : L(1))) / hh)
    const capTop = base - hh * size
    const wpx = Math.max(...ls.map(l => w100(l, DISPLAY))) * size / 100
    const els: El[] = [disp(ls.join('\n'), arr === 1
      ? { size, x: XR(12) - wpx + 0.03 * size, w: wpx, align: 'right', base, bleed: true }
      : { size, x: M - 0.04 * size, base, bleed: true })]
    // The prototype always has details; a real Frame may not — skip the block rather than set `undefined`.
    if (c.details) els.push(sec(c.details, { x: X(1), w: SPAN(1, 9), top: base + GAP }))
    els.push(...infoRow(c, FOOT2, 'foot').els)
    if (ph) els.push(photoIn({ c1: 1, c2: 12, top: M, bottom: capTop - GAP }))
    return { els, did: `Title fitted to run off the ${arr === 1 ? 'left' : 'right'} edge, baseline on row ${arr === 2 ? 12 : 10}.` }
  },
}

/** Statement — one line per word (or balanced lines), fitted to the margins, top or foot. */
export const statement: LayoutDef = {
  id: 'statement', name: 'Statement', fits: [...ALL],
  fn(S, { c, ph, r, lines }) {
    const { X, SPAN, L, M, GAP, DISPLAY, sizeFor, blockH, disp, infoRow, photoIn, FOOT3 } = S
    const top = r() < 0.5
    const maxH = (ph ? L(8) : L(12)) - M
    const size = sizeFor(lines, SPAN(1, 12), maxH)
    const h = blockH(lines.length, size, DISPLAY.lh)
    const els: El[] = []
    if (top) {
      els.push(disp(lines.join('\n'), { size, x: X(1), top: M }))
      const f = infoRow(c, FOOT3, 'foot'); els.push(...f.els)
      if (ph) els.push(photoIn({ c1: 1, c2: 12, top: M + h + GAP, bottom: f.top - GAP }, { ay: 'bottom' }))
    } else {
      els.push(disp(lines.join('\n'), { size, x: X(1), base: L(16) }))
      const hd = infoRow(c, FOOT3, 'head'); els.push(...hd.els)
      if (ph) els.push(photoIn({ c1: 1, c2: 12, top: hd.bottom + GAP, bottom: L(16) - h - GAP }))
    }
    return { els, did: `One word per line, fitted to the margins, ${top ? 'from the top' : 'on the foot'}.` }
  },
}

/** Index — title top-left, a ruled table on the right, the date large at the foot in accent. */
export const index: LayoutDef = {
  id: 'index', name: 'Index', fits: [...ALL], smallText: true,
  fn(S, { c, ph, lines }) {
    const { X, SPAN, L, M, RH, GAP, CAP, DISPLAY, INFO, fitSize, sizeFor, blockH, countLines, disp, info, rule, photoIn, q } = S
    const size = sizeFor(lines, SPAN(1, 8), RH * 5)
    const tb = M + blockH(lines.length, size, DISPLAY.lh)
    const els: El[] = [disp(lines.join('\n'), { size, x: X(1), top: M })]
    let y = M
    for (const [key, wt] of [['details', 500], ['caption', 400]] as const) {
      const s = c[key]; if (!s) continue
      els.push(rule(X(9), y, SPAN(9, 12)))
      const n = countLines(s, SPAN(9, 12), { ...INFO, role: key }, INFO.size)
      els.push(info(s, { x: X(9), w: SPAN(9, 12), top: y + INFO.size * 0.9, wt, role: key }))
      y += INFO.size * 0.9 + blockH(n, INFO.size, INFO.lh) + INFO.size * 1.4
    }
    els.push(rule(X(9), y, SPAN(9, 12)))
    let dSize = 0
    if (c.date) {
      dSize = Math.min(fitSize([c.date], SPAN(1, 12), { ...DISPLAY, role: 'date' }), RH * 2.4 / CAP)
      els.push(disp(c.date, { size: dSize, x: X(1), base: L(16), color: 'accent', role: 'date' }))
    }
    if (ph) els.push(photoIn({ c1: 1, c2: 8, top: tb + GAP * 1.5, bottom: L(16) - CAP * dSize - GAP }, { ax: 'left' }))
    return { els, did: `Title top-left, a ruled table on the right, ${q(c.date)} large at the foot in accent.` }
  },
}

/** Shape counter-form — a circle (accent, or the image inside it); the title overprints it. */
export const shapeCounter: LayoutDef = {
  id: 'shapeCounter', name: 'Shape counter-form', fits: [...ALL],
  needs: { shape: true }, ownPhoto: true,
  fn(S, { c, ph, kind, lines }) {
    const { X, XR, SPAN, L, M, RH, GAP, CAP, DISPLAY, fitSize, disp, sec, infoRow, FOOT2 } = S
    const rad = Math.min(SPAN(4, 12), L(10) - M) / 2, cx = XR(12) - rad, cy = M + rad
    const els: El[] = [{ k: 'c', cx, cy, r: rad, photo: ph, color: 'accent', role: 'shape', ok: true }]
    const ls = kind === 'sentence' ? lines : [c.title]
    const hh = (ls.length - 1) * DISPLAY.lh + CAP
    const size = Math.min(fitSize(ls, SPAN(1, 12)), RH * (ls.length > 1 ? 6 : 3.4) / hh, (L(14) - cy) / hh)
    const base = cy + rad * 0.45 + (ls.length - 1) * DISPLAY.lh * size
    els.push(disp(ls.join('\n'), { size, x: X(1), base, ok: true, blend: !ph }))
    if (c.details) els.push(sec(c.details, { x: X(1), w: SPAN(1, 8), top: Math.max(base, cy + rad) + GAP }))
    els.push(...infoRow(c, FOOT2, 'foot').els)
    return { els, did: `A circle in ${ph ? 'the image' : 'accent'}; the title overprints it.` }
  },
}

/** Image behind — the image sits under the title; the title crosses its top edge on purpose. */
export const photoBehind: LayoutDef = {
  id: 'photoBehind', name: 'Image behind', fits: [...ALL],
  needs: { image: true },
  fn(S, { c, ph, lines }) {
    const { X, XR, SPAN, L, RH, GAP, CAP, DISPLAY, fitSize, disp, sec, infoRow, FOOT2, PHOTO_ASPECT } = S
    const top = L(1.5), h = Math.min(SPAN(3, 12) * PHOTO_ASPECT, L(12) - top), w = h / PHOTO_ASPECT
    const els: El[] = [{ k: 'p', x: XR(12) - w, y: top, w, h, stand: !ph, role: 'photo', ok: true }]
    const ls = lines.length > 2 ? lines : [c.title]
    const size = Math.min(fitSize(ls, SPAN(1, 12)), RH * 3.2 / CAP)
    const base = top + CAP * size * 0.5 + (ls.length - 1) * DISPLAY.lh * size
    els.push(disp(ls.join('\n'), { size, x: X(1), base, ok: true }))
    if (c.details) els.push(sec(c.details, { x: XR(12) - w, w, top: top + h + GAP }))
    els.push(...infoRow(c, FOOT2, 'foot').els)
    return { els, did: 'The image sits under the title; the title crosses its top edge on purpose.' }
  },
}

/** Full bleed — the image covers the page; title and information overprint it in the field colour. */
export const fullBleed: LayoutDef = {
  id: 'fullBleed', name: 'Full bleed', fits: [...ALL],
  needs: { image: true },
  fn(S, { c, ph, lines }) {
    const { X, SPAN, L, W, H, RH, sizeFor, disp, infoRow, FOOT3, PHOTO_ASPECT } = S
    const w = Math.max(W, H / PHOTO_ASPECT), h = w * PHOTO_ASPECT
    const els: El[] = [{ k: 'p', x: (W - w) / 2, y: (H - h) / 2, w, h, stand: !ph, role: 'photo', ok: true, bleed: true }]
    const size = sizeFor(lines, SPAN(1, 12), RH * 5)
    els.push(disp(lines.join('\n'), { size, x: X(1), base: L(16), color: 'field' }))
    const hd = infoRow(c, FOOT3, 'head')
    hd.els.forEach(e => { e.color = 'field' }); els.push(...hd.els)
    return { els, did: 'The image covers the page; title and information overprint it in the field colour.' }
  },
}

/** Tilt — the title turned to run up the left edge; everything else hangs from the next free column. */
export const tilt: LayoutDef = {
  id: 'tilt', name: 'Tilt', fits: [...ALL],
  premise: { rotated: ['title'] },
  fn(S, { c, ph, kind, lines }) {
    const { X, SPAN, L, M, G, GAP, CAP, DISPLAY, SECOND, fitSize, blockH, countLines, w100, disp, sec, infoStack, photoIn } = S
    const len = L(16) - M
    const ls = kind === 'sentence' ? lines : [c.title]
    const hh = (ls.length - 1) * DISPLAY.lh + CAP
    const size = Math.min(fitSize(ls, len), SPAN(1, 7) / hh)
    const cap = hh * size
    const k = Math.max(...ls.map(l => w100(l, DISPLAY))) / 100 * size
    const els: El[] = [disp(ls.join('\n'), { size, x: M, top: L(16), rot: -90, origin: 'top left', w: k })]
    let sc = 1; while (sc < 12 && X(sc) < M + cap + G) sc++
    sc = Math.min(sc, 9)
    let dBottom = M
    if (c.details) {
      els.push(sec(c.details, { x: X(sc), w: SPAN(sc, 12), top: M }))
      const dn = countLines(c.details, SPAN(sc, 12), SECOND, SECOND.size)
      dBottom = M + blockH(dn, SECOND.size, SECOND.lh)
    }
    const st = infoStack(stackItems(c, [['date'], ['caption']]), sc, 12, 0)
    const stH = st.bottom
    st.els.forEach(e => { e.top = (e.top ?? 0) + L(16) - stH })
    els.push(...st.els)
    if (ph) els.push(photoIn({ c1: sc, c2: 12, top: dBottom + GAP, bottom: L(16) - stH - GAP }))
    return { els, did: 'Title turned to run up the left edge; everything else hangs from the next free column.' }
  },
}

/** Bottom-heavy — the title owns the lower half; the small texts wait at the top. */
export const bottomHeavy: LayoutDef = {
  id: 'bottomHeavy', name: 'Bottom-heavy', fits: [...ALL],
  fn(S, { c, ph, lines }) {
    const { X, SPAN, L, M, GAP, DISPLAY, SECOND, sizeFor, blockH, countLines, disp, sec, infoStack, photoIn } = S
    const maxH = L(16) - (ph ? L(9) : L(5))
    const size = sizeFor(lines, SPAN(1, 12), maxH)
    const capTop = L(16) - blockH(lines.length, size, DISPLAY.lh)
    const els: El[] = [disp(lines.join('\n'), { size, x: X(1), base: L(16) })]
    let detailsBottom = M
    if (c.details) {
      els.push(sec(c.details, { x: X(1), w: SPAN(1, 8), top: M }))
      const dn = countLines(c.details, SPAN(1, 8), SECOND, SECOND.size)
      detailsBottom = M + blockH(dn, SECOND.size, SECOND.lh)
    }
    const st = infoStack(stackItems(c, [['date'], ['caption']]), 9, 12, M)
    els.push(...st.els)
    const headBottom = Math.max(detailsBottom, st.bottom)
    if (ph) els.push(photoIn({ c1: 1, c2: 12, top: headBottom + GAP, bottom: capTop - GAP }, { ax: 'left' }))
    return { els, did: 'Title owns the lower half; the small texts wait at the top.' }
  },
}

/** Four corners — the title flush-left mid-page; the small texts pinned to three corners of the grid. */
export const fourCorners: LayoutDef = {
  id: 'fourCorners', name: 'Four corners', fits: [...ALL], smallText: true,
  fn(S, { c, ph, lines }) {
    const { X, SPAN, L, M, GAP, DISPLAY, SECOND, sizeFor, blockH, countLines, disp, sec, info, photoIn } = S
    const maxH = ph ? L(12) - L(8) : L(12) - L(3)
    const size = sizeFor(lines, SPAN(1, 10), maxH)
    const base = L(12)
    const capTop = base - blockH(lines.length, size, DISPLAY.lh)
    const els: El[] = [disp(lines.join('\n'), { size, x: X(1), base })]
    let detailsH = 0
    if (c.details) {
      els.push(sec(c.details, { x: X(1), w: SPAN(1, 6), top: M }))
      const dn = countLines(c.details, SPAN(1, 6), SECOND, SECOND.size)
      detailsH = blockH(dn, SECOND.size, SECOND.lh)
    }
    if (c.date) els.push(info(c.date, { x: X(9), w: SPAN(9, 12), top: M, role: 'date' }))
    if (c.caption) els.push(info(c.caption, { x: X(1), w: SPAN(1, 6), base: L(16), role: 'caption' }))
    if (ph) els.push(photoIn({ c1: 1, c2: 12, top: M + detailsH + GAP, bottom: capTop - GAP }))
    return { els, did: 'Title flush-left mid-page; the small texts pinned to three corners of the grid.' }
  },
}

/** Footer — title from the top margin; the smaller text in three columns on the foot line. */
export const footer: LayoutDef = {
  id: 'footer', name: 'Footer', fits: [...ALL],
  fn(S, { c, ph, lines }) {
    const { X, SPAN, L, M, GAP, DISPLAY, sizeFor, blockH, disp, infoRow, photoIn, FOOT3 } = S
    const maxH = (ph ? L(7) : L(14)) - M
    const size = sizeFor(lines, SPAN(1, 12), maxH)
    const els: El[] = [disp(lines.join('\n'), { size, x: X(1), top: M })]
    const f = infoRow(c, FOOT3, 'foot'); els.push(...f.els)
    const tb = M + blockH(lines.length, size, DISPLAY.lh)
    if (ph) els.push(photoIn({ c1: 1, c2: 12, top: tb + GAP, bottom: f.top - GAP }, { ay: 'bottom' }))
    return { els, did: 'Title from the top margin; the smaller text in three columns on the foot line.' }
  },
}

/** `infoStack` items for the roles present, in order (a role with no text is left out). */
function stackItems(c: Content, keys: [keyof Content][]): { s: string; role: string }[] {
  return keys.flatMap(([key]) => (c[key] ? [{ s: c[key]!, role: key }] : []))
}
