import type { El, LayoutDef, Sheet } from '../kit/types'

// ═══════════════════════ Swiss shape and letter layouts ═══════════════════════
// Ported from the prototype (docs/superpowers/specs/assets/2026-09-23-frame-layout-system/
// layout-sheet.html `def(...)` bodies; Badge from layout-pane.html, which adds the date's
// `inside: 'shape'`). Geometry is the prototype's, unchanged. The same two non-geometry
// differences as the core layouts:
// - A block whose text is absent is skipped (and takes no height) rather than set as `undefined`.
// - Text is measured in the face of the role it is drawn in.
// Letters set one by one carry the roles `title0`, `title1`, …: the planner joins them back into
// the title layer as placed runs.

const ALL = ['word', 'phrase', 'sentence'] as const

/** Knockout — a full-width band in the ink colour; the title reversed out of it. */
export const knockout: LayoutDef = {
  id: 'knockout', name: 'Knockout', fits: [...ALL],
  needs: { shape: true },
  fn(S, { c, ph, lines }) {
    const { X, XR, SPAN, L, M, RH, GAP, SECOND, sizeFor, blockH, countLines, disp, sec, info, photoIn } = S
    const bandTop = ph ? L(9) : L(5), bandBot = ph ? L(14) : L(11)
    const pad = RH * 0.6
    const ls = lines.length > 2 ? lines : [c.title]
    const size = sizeFor(ls, SPAN(1, 12), bandBot - bandTop - 2 * pad)
    const els: El[] = [{ k: 'r', x: 0, y: bandTop, w: XR(12) + M, h: bandBot - bandTop, color: 'ink', role: 'shape', ok: true, bleed: true }]
    els.push(disp(ls.join('\n'), { size, x: X(1), base: bandBot - pad, color: 'field', ok: true }))
    let dh = 0
    if (c.details) {
      els.push(sec(c.details, { x: X(1), w: SPAN(1, 8), top: M }))
      dh = blockH(countLines(c.details, SPAN(1, 8), SECOND, SECOND.size), SECOND.size, SECOND.lh)
    }
    if (c.date) els.push(info(c.date, { x: X(9), w: SPAN(9, 12), top: M, role: 'date' }))
    if (c.caption) els.push(info(c.caption, { x: X(1), w: SPAN(1, 6), base: L(16), role: 'caption' }))
    if (ph) els.push(photoIn({ c1: 1, c2: 12, top: M + dh + GAP, bottom: bandTop - GAP }))
    return { els, did: 'A full-width band in the ink colour; the title reversed out of it.' }
  },
}

/** Bleed — a circle bleeds off the top and right; the title takes the lower third. */
export const shapeBleed: LayoutDef = {
  id: 'shapeBleed', name: 'Bleed', fits: [...ALL],
  needs: { shape: true }, ownPhoto: true,
  fn(S, { c, ph, lines }) {
    const { X, SPAN, L, W, GAP, sizeFor, disp, sec, infoRow, FOOT2 } = S
    const cy = L(4), rad = Math.min(W * 0.5, L(9) - cy), cx = W - rad * 0.4
    const els: El[] = [{ k: 'c', cx, cy, r: rad, photo: ph, color: 'accent', role: 'shape', bleed: true }]
    if (c.details) els.push(sec(c.details, { x: X(1), w: SPAN(1, 3), top: S.M }))
    const base = L(14)
    const size = sizeFor(lines, SPAN(1, 12), base - (cy + rad) - GAP * 1.5)
    els.push(disp(lines.join('\n'), { size, x: X(1), base }))
    els.push(...infoRow(c, FOOT2, 'foot').els)
    return { els, did: `A circle ${ph ? 'of image ' : ''}bleeds off the top and right; the title takes the lower third.` }
  },
}

/** Badge — the date in a small round badge, top right; the title large below. */
export const badge: LayoutDef = {
  id: 'badge', name: 'Badge', fits: [...ALL],
  needs: { shape: true },
  fn(S, { c, ph, lines }) {
    const { X, XR, SPAN, L, M, GAP, DISPLAY, SECOND, INFO, sizeFor, blockH, countLines, disp, sec, info, photoIn, q } = S
    let rad = Math.min(SPAN(9, 12), L(5) - M) / 2
    // Kit fix (not in the prototype): the badge grows just enough to hold the date's real ink —
    // the renderer does not break inside a word, so on a short frame "19.09.–15.11.2026" spills
    // past a row-5 badge. Where the date already fits (every frame the prototype showed), the
    // radius is the prototype's. Never wider than columns 9–12.
    if (c.date) {
      for (let i = 0; i < 4; i++) {
        const need = dateReach(S, c.date, rad) / 0.95
        if (need <= rad) break
        rad = Math.min(need, SPAN(9, 12) / 2)
      }
    }
    const cx = XR(12) - rad, cy = M + rad
    const els: El[] = [{ k: 'c', cx, cy, r: rad, color: 'ink', role: 'shape', ok: true }]
    if (c.date) {
      const dn = countLines(c.date, rad * 1.4, { ...INFO, role: 'date' }, INFO.size)
      const dh = blockH(dn, INFO.size, INFO.lh)
      els.push(info(c.date, { x: cx - rad * 0.7, w: rad * 1.4, top: cy - dh / 2, align: 'center', color: 'field', role: 'date', ok: true, wt: 500, inside: 'shape' }))
    }
    let detB = M
    if (c.details) {
      els.push(sec(c.details, { x: X(1), w: SPAN(1, 7), top: M }))
      detB = M + blockH(countLines(c.details, SPAN(1, 7), SECOND, SECOND.size), SECOND.size, SECOND.lh)
    }
    const base = L(14)
    const size = sizeFor(lines, SPAN(1, 12), base - (ph ? L(9) : cy + rad + GAP))
    els.push(disp(lines.join('\n'), { size, x: X(1), base }))
    if (c.caption) els.push(info(c.caption, { x: X(1), w: SPAN(1, 6), base: L(16), role: 'caption' }))
    const capTop = base - blockH(lines.length, size, DISPLAY.lh)
    if (ph) els.push(photoIn({ c1: 1, c2: 8, top: detB + GAP, bottom: capTop - GAP }, { ax: 'left' }))
    return { els, did: `${q(c.date)} in a small round badge, top right; the title large below.` }
  },
}

/** Split — the image takes the upper half, cropped by the page edge; type the lower. */
export const split: LayoutDef = {
  id: 'split', name: 'Split', fits: [...ALL],
  needs: { image: true },
  fn(S, { c, ph, lines }) {
    const { X, SPAN, L, W, GAP, SECOND, PHOTO_ASPECT, sizeFor, blockH, countLines, disp, sec, infoRow, FOOT2 } = S
    const w = W, h = W * PHOTO_ASPECT, bottom = L(8)
    const els: El[] = [{ k: 'p', x: 0, y: bottom - h, w, h, stand: !ph, role: 'photo', bleed: true }]
    let dB = bottom + GAP
    if (c.details) {
      els.push(sec(c.details, { x: X(1), w: SPAN(1, 8), top: bottom + GAP }))
      dB += blockH(countLines(c.details, SPAN(1, 8), SECOND, SECOND.size), SECOND.size, SECOND.lh)
    }
    const f = infoRow(c, FOOT2, 'foot'); els.push(...f.els)
    const base = f.top - GAP * 1.5
    const size = sizeFor(lines, SPAN(1, 12), base - dB - GAP)
    els.push(disp(lines.join('\n'), { size, x: X(1), base }))
    return { els, did: 'The image takes the upper half, cropped by the page edge; type the lower.' }
  },
}

/** Scatter — letters dealt into a 4 × 7 module grid, still in reading order. */
export const scatter: LayoutDef = {
  id: 'scatter', name: 'Scatter', fits: ['word', 'phrase'],
  fn(S, { c, ph, r }) {
    const { X, SPAN, L, M, RH, GAP, CAP, fitSize, disp, infoRow, photoIn, FOOT3 } = S
    const letters = [...c.title.replace(/\s+/g, '')]
    const cells: { i: number; j: number }[] = []
    for (let j = 0; j < 7; j++) for (let i = 0; i < 4; i++) {
      if (ph && i >= 2 && j < 4) continue
      cells.push({ i, j })
    }
    const chosen = cells.map(cc => ({ cc, v: r() })).sort((a, b) => a.v - b.v).slice(0, Math.min(letters.length, cells.length))
      .map(o => o.cc).sort((a, b) => a.j - b.j || a.i - b.i)
    const size = Math.min(fitSize(['W'], SPAN(1, 3) * 0.95), 2 * RH * 0.82 / CAP)
    const els: El[] = chosen.map((cc, n) => disp(letters[n]!, { size, x: X(cc.i * 3 + 1), top: L(cc.j * 2), role: 'title' + n }))
    els.push(...infoRow(c, FOOT3, 'foot').els)
    if (ph) els.push(photoIn({ c1: 7, c2: 12, top: M, bottom: L(8) - GAP }))
    return { els, did: 'Letters dealt into a 4 × 7 module grid, still in reading order.' }
  },
}

/** Cascade — one letter per line, each a few columns further right. */
export const cascade: LayoutDef = {
  id: 'cascade', name: 'Cascade', fits: ['word'],
  fn(S, { c, ph }) {
    const { X, SPAN, L, M, GAP, CAP, DISPLAY, fitSize, disp, infoRow, photoIn, FOOT3 } = S
    const letters = [...c.title]
    const n = letters.length
    const step = n > 1 ? Math.max(1, Math.min(3, Math.floor(10 / (n - 1)))) : 0
    const starts = letters.map((_, i) => Math.min(12, 1 + i * step))
    const avail = (ph ? L(10) : L(15) - GAP) - M
    const size = Math.min(avail / ((n - 1) * DISPLAY.lh + CAP), fitSize(['W'], SPAN(starts[n - 1]!, 12)))
    const bases = letters.map((_, i) => M + CAP * size + i * DISPLAY.lh * size)
    const els: El[] = letters.map((l, i) => disp(l, { size, x: X(starts[i]!), base: bases[i], role: 'title' + i }))
    const f = infoRow(c, FOOT3, 'foot'); els.push(...f.els)
    if (ph) els.push(photoIn({ c1: 1, c2: Math.max(2, starts[n - 1]! - 1), top: bases[Math.max(0, n - 2)]! + GAP, bottom: f.top - GAP }, { ax: 'left', ay: 'bottom' }))
    return { els, did: `One letter per line, each ${step} column${step > 1 ? 's' : ''} further right.` }
  },
}

/** Ring — the word repeated three times around a ring that fills the width. */
export const ring: LayoutDef = {
  id: 'ring', name: 'Ring', fits: ['word'],
  ownPhoto: true,
  fn(S, { c, ph }) {
    const { X, SPAN, L, M, W, GAP, CAP, DISPLAY, SECOND, w100, sec, infoRow, FOOT2 } = S
    const unit = c.title + ' — '
    const outer = Math.min(SPAN(1, 12), L(12) - M) / 2
    let size = 10
    for (let i = 0; i < 4; i++) { const R = outer - CAP * size; size = Math.min(2 * Math.PI * R / (3 * w100(unit, DISPLAY) / 100), R * 0.4 / CAP) }
    const R = outer - CAP * size, cx = W / 2, cy = M + outer
    const els: El[] = [{ k: 'ring', cx, cy, R, size, s: unit.repeat(3), role: 'title' }]
    if (ph) els.push({ k: 'c', cx, cy, r: R - GAP, photo: true, role: 'photo', ok: true })
    else if (c.details) els.push(sec(c.details, { x: cx - R * 0.7, w: R * 1.4, top: cy - SECOND.size * CAP / 2, align: 'center', ok: true }))
    const below = cy + outer + GAP
    if (ph && c.details) els.push(sec(c.details, { x: X(1), w: SPAN(1, 8), top: below }))
    els.push(...infoRow(c, FOOT2, 'foot').els)
    return { els, did: 'The word repeated three times around a ring that fills the width.' }
  },
}

/** Cells — letters in ruled cells, a few to a row. */
export const cells: LayoutDef = {
  id: 'cells', name: 'Cells', fits: ['word', 'phrase'],
  fn(S, { c, ph }) {
    const { X, SPAN, L, M, RH, GAP, CAP, fitSize, disp, rule, infoRow, photoIn, FOOT3 } = S
    const letters = [...c.title.replace(/\s+/g, '')]
    const n = letters.length
    const f = infoRow(c, FOOT3, 'foot')
    const avail = (ph ? L(9) : f.top - GAP) - M
    let best: { p: number; cellW: number; cellH: number; rows: number; size: number } | null = null
    for (const p of [2, 3, 4, 6]) {
      const cellW = SPAN(1, 12 / p), rows = Math.ceil(n / p)
      const cellH = Math.min(cellW * 1.15, avail / rows)
      const size = Math.min(fitSize(['W'], cellW * 0.8), (cellH - RH * 0.5) / CAP)
      if (!best || size > best.size) best = { p, cellW, cellH, rows, size }
    }
    const { p, cellH, size } = best!
    const els: El[] = []
    letters.forEach((l, k) => {
      const i = k % p, j = Math.floor(k / p)
      const y = M + j * cellH
      if (i === 0) els.push(rule(X(1), y, SPAN(1, 12)))
      els.push(disp(l, { size, x: X(i * (12 / p) + 1), top: y + RH * 0.35, role: 'title' + k }))
    })
    const gridB = M + best!.rows * cellH
    els.push(rule(X(1), gridB, SPAN(1, 12)))
    els.push(...f.els)
    if (ph) els.push(photoIn({ c1: 1, c2: 12, top: gridB + GAP, bottom: f.top - GAP }, { ay: 'bottom' }))
    return { els, did: `Letters in ruled cells, ${p} to a row.` }
  },
}

/** How far the badge's date ink reaches from the badge's centre (its farthest corner), for a
 *  badge of radius `rad`: the date as Badge sets it — INFO size, a box 1.4 × rad wide, centred,
 *  vertically centred by the layout's own block height — measured as the checker measures it. */
function dateReach(S: Sheet, date: string, rad: number): number {
  const { INFO, blockH, measure } = S
  const boxW = rad * 1.4
  const lines = date.split('\n').flatMap(p => measure.lines(p, 'date', INFO.size, INFO.ls, boxW))
  const ink = Math.max(...lines.map(l => measure.w100(l, 'date', INFO.ls) * INFO.size / 100))
  const dh = blockH(lines.length, INFO.size, INFO.lh)
  const inkH = (lines.length - 1) * INFO.lh * INFO.size + (measure.capAbove('date') + measure.baseBelow('date')) * INFO.size
  const dy = Math.max(dh / 2, Math.abs(inkH - dh / 2))
  return Math.hypot(ink / 2, dy)
}
