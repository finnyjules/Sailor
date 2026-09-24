import type { Content, TextKey, El, LayoutDef } from '../kit/types'

// ═══════════════════════ Swiss line layouts ═══════════════════════
// Ported from the prototype (docs/superpowers/specs/assets/2026-09-23-frame-layout-system/
// layout-sheet.html `def(...)` bodies; the pane has the same bodies for these nine). Geometry is
// the prototype's, unchanged. The same two non-geometry differences as the core layouts:
// - A block whose text is absent is skipped (and takes no height) rather than set as `undefined`.
// - Text is measured in the face of the role it is drawn in.
// Each word or line of a title set as its own element carries the role `title`, `title1`,
// `title2`, …: the planner joins them back into the title layer as placed lines.

const LINES = ['phrase', 'sentence'] as const
const ALL = ['word', 'phrase', 'sentence'] as const

/** `infoStack` items for the roles present, in order, with their weights (a role with no text
 *  is left out). */
export function presentItems(c: Content, keys: [TextKey, number?][]): { s: string; wt?: number; role: string }[] {
  return keys.flatMap(([key, wt]) => (c[key] ? [{ s: c[key]!, role: key, ...(wt ? { wt } : {}) }] : []))
}

/** The prototype's details / date / caption column (details at weight 500). */
const COLUMN: [TextKey, number?][] = [['details', 500], ['date'], ['caption']]

/** Title role for the i-th separately set word or line. */
const titleRole = (i: number) => (i ? 'title' + i : 'title')

/** Spaced lines — each word on its own line, the lines spread from the top margin to the foot. */
export const spacedLines: LayoutDef = {
  id: 'spacedLines', name: 'Spaced lines', fits: [...LINES],
  fn(S, { c, ph, words }) {
    const { X, SPAN, L, M, GAP, CAP, fitSize, disp, infoStack, photoIn } = S
    const n = words.length
    const total = L(16) - M
    const size = Math.min(fitSize(words, SPAN(1, 9)), total / (n * CAP * 1.35))
    const cap = CAP * size
    const els: El[] = []
    words.forEach((w, i) => {
      const base = n === 1 ? L(16) : M + cap + i * (total - cap) / (n - 1)
      els.push(disp(w, { size, x: X(1), base, role: titleRole(i) }))
    })
    const st = infoStack(presentItems(c, COLUMN), 10, 12, M)
    els.push(...st.els)
    if (ph) els.push(photoIn({ c1: 10, c2: 12, top: st.bottom + GAP * 2, bottom: L(16) }, { ay: 'bottom' }))
    return { els, did: 'Each word on its own line, the lines spread from the top margin to the foot.' }
  },
}

/** Ragged — lines start on different columns, set on one baseline rhythm. */
export const ragged: LayoutDef = {
  id: 'ragged', name: 'Ragged', fits: [...LINES],
  // Its seed (index 10) starts the second line on column 4, 7 or 5 for arr 0, 1, 2.
  arrLabels: ['Short indent', 'Long indent', 'Medium indent'],
  fn(S, { c, ph, r, words }) {
    const { X, SPAN, L, M, GAP, CAP, DISPLAY, w100, disp, infoRow, photoIn, pick, FOOT3 } = S
    const starts = words.map((_, i) => i === 0 ? 1 : pick(r, [1, 3, 4, 5, 7]))
    const maxH = ph ? L(13) - L(7) : L(13) - M
    let size = Math.min(...words.map((w, i) => SPAN(starts[i]!, 12) * 100 / w100(w, DISPLAY)))
    size = Math.min(size, maxH / ((words.length - 1) * DISPLAY.lh + CAP))
    const lastBase = L(13)
    const firstBase = lastBase - (words.length - 1) * DISPLAY.lh * size
    const els: El[] = words.map((w, i) => disp(w, { size, x: X(starts[i]!), base: firstBase + i * DISPLAY.lh * size, role: titleRole(i) }))
    const f = infoRow(c, FOOT3, 'foot'); els.push(...f.els)
    if (ph) els.push(photoIn({ c1: 1, c2: 12, top: M, bottom: firstBase - CAP * size - GAP }))
    return { els, did: `Lines start on different columns (${starts.join(', ')}), set on one baseline rhythm.` }
  },
}

/** Edges — words pushed to alternate margins and spread from top to foot. */
export const edges: LayoutDef = {
  id: 'edges', name: 'Edges', fits: [...LINES],
  fn(S, { c, ph, words }) {
    const { X, SPAN, L, M, GAP, CAP, fitSize, disp, infoRow, photoIn, FOOT3 } = S
    const n = words.length
    const f = infoRow(c, FOOT3, 'foot')
    const top = ph ? L(8) : M, bottom = f.top - GAP * 1.5
    const size = Math.min(fitSize(words, SPAN(1, 9)), (bottom - top) / (n * CAP * 1.3))
    const cap = CAP * size
    const els: El[] = words.map((w, i) => {
      const base = n === 1 ? bottom : top + cap + i * (bottom - top - cap) / (n - 1)
      return disp(w, { size, x: X(1), w: SPAN(1, 12), align: i % 2 ? 'right' : 'left', base, role: titleRole(i) })
    })
    els.push(...f.els)
    if (ph) els.push(photoIn({ c1: 1, c2: 12, top: M, bottom: top - GAP }, { ax: 'right' }))
    return { els, did: 'Words pushed to alternate margins and spread from top to foot.' }
  },
}

/** Staircase — each word steps a few columns to the right. */
export const staircase: LayoutDef = {
  id: 'staircase', name: 'Staircase', fits: [...LINES],
  fn(S, { c, ph, words }) {
    const { X, SPAN, L, M, GAP, CAP, DISPLAY, w100, disp, infoRow, photoIn, FOOT3 } = S
    const n = words.length
    const step = n > 1 ? Math.max(1, Math.min(4, Math.floor(8 / (n - 1)))) : 0
    const starts = words.map((_, i) => 1 + i * step)
    const maxH = (ph ? L(11) : L(14)) - M
    let size = Math.min(...words.map((w, i) => SPAN(starts[i]!, 12) * 100 / w100(w, DISPLAY)))
    size = Math.min(size, maxH / ((n - 1) * DISPLAY.lh + CAP))
    const bases = words.map((_, i) => M + CAP * size + i * DISPLAY.lh * size)
    const els: El[] = words.map((w, i) => disp(w, { size, x: X(starts[i]!), base: bases[i], role: titleRole(i) }))
    const f = infoRow(c, FOOT3, 'foot'); els.push(...f.els)
    if (ph) els.push(photoIn({ c1: 1, c2: 12, top: bases[n - 1]! + GAP, bottom: f.top - GAP }, { ax: 'left', ay: 'bottom' }))
    return { els, did: `Each word steps ${step} column${step > 1 ? 's' : ''} to the right.` }
  },
}

/** Block — the title set as one justified block across all 12 columns. */
export const block: LayoutDef = {
  id: 'block', name: 'Block', fits: [...LINES],
  keepScale: true,
  fn(S, { c, ph, words }) {
    const { X, SPAN, L, M, GAP, CAP, DISPLAY, w100, fitSize, blockH, breakLines, disp, infoRow, photoIn, FOOT3 } = S
    const target = (ph ? L(8) : L(12)) - M
    let size = fitSize([words.reduce((a, b) => w100(a, DISPLAY) > w100(b, DISPLAY) ? a : b)], SPAN(1, 12))
    // Seeded before the loop so a size already ≤ 2 still has lines (the prototype would crash).
    let lines: string[] = breakLines(words, SPAN(1, 12), size, DISPLAY)
    for (; size > 2; size *= 0.97) {
      lines = breakLines(words, SPAN(1, 12), size, DISPLAY)
      if (blockH(lines.length, size, DISPLAY.lh) <= target) break
    }
    const els: El[] = lines.map((l, i) => disp(l, { size, x: X(1), w: SPAN(1, 12), base: M + CAP * size + i * DISPLAY.lh * size, just: lines.length > 1 && l.includes(' '), role: titleRole(i) }))
    const bottom = M + blockH(lines.length, size, DISPLAY.lh)
    const f = infoRow(c, FOOT3, 'foot'); els.push(...f.els)
    if (ph) els.push(photoIn({ c1: 1, c2: 12, top: bottom + GAP * 1.5, bottom: f.top - GAP }, { ay: 'bottom' }))
    return { els, did: 'The title set as one justified block across all 12 columns.' }
  },
}

/** Diagonal — the title rotated as one block, kept inside the free band. */
export const diagonal: LayoutDef = {
  id: 'diagonal', name: 'Diagonal', fits: [...ALL],
  premise: { rotated: ['title'] },
  // Its seed (index 18) turns the title 36° for arr 0 and 2 (the same run) and 26° for arr 1.
  arrLabels: ['Steep', 'Gentle'],
  fn(S, { c, ph, r, lines }) {
    const { X, XR, SPAN, L, M, GAP, CAP, DISPLAY, SECOND, INFO, w100, blockH, countLines, disp, sec, info, photoIn, pick } = S
    const deg = pick(r, [-18, -26, -36]), a = Math.abs(deg) * Math.PI / 180
    const els: El[] = []
    let headB = M
    if (c.details) {
      els.push(sec(c.details, { x: X(1), w: SPAN(1, 8), top: M }))
      headB = M + blockH(countLines(c.details, SPAN(1, 8), SECOND, SECOND.size), SECOND.size, SECOND.lh)
    }
    if (c.date) els.push(info(c.date, { x: X(9), w: SPAN(9, 12), top: M, role: 'date' }))
    let footTop = L(16)
    if (c.caption) {
      els.push(info(c.caption, { x: X(1), w: SPAN(1, 6), base: L(16), role: 'caption' }))
      footTop = L(16) - blockH(countLines(c.caption, SPAN(1, 6), { ...INFO, role: 'caption' }, INFO.size), INFO.size, INFO.lh)
    }
    let zTop = headB + GAP
    if (ph) {
      const p = photoIn({ c1: 1, c2: 12, top: headB + GAP, bottom: headB + GAP + (footTop - headB) * 0.42 }, { ax: 'left' })
      els.push(p); if (p.k === 'p') zTop = p.y + p.h + GAP
    }
    const zH = footTop - GAP - zTop
    const k = Math.max(...lines.map(l => w100(l, DISPLAY))) / 100
    const hh = (lines.length - 1) * DISPLAY.lh + CAP
    const size = Math.min(SPAN(1, 12) / (k * Math.cos(a) + hh * Math.sin(a)), zH / (k * Math.sin(a) + hh * Math.cos(a)))
    const len = k * size, bh = hh * size
    const cx = (X(1) + XR(12)) / 2, cy = zTop + zH / 2
    els.push(disp(lines.join('\n'), { size, x: cx - len / 2, top: cy - bh / 2, w: len, rot: deg, origin: 'center' }))
    return { els, did: `Title rotated ${Math.abs(deg)}° as one block, kept inside the free band.` }
  },
}

/** Wall — every line fitted to the full width at its own size, stacked into a wall. */
export const wall: LayoutDef = {
  id: 'wall', name: 'Wall', fits: [...LINES],
  keepScale: true,
  fn(S, { c, ph, words, kind }) {
    const { X, SPAN, L, M, RH, GAP, CAP, fitSize, balance, disp, infoRow, photoIn, FOOT3 } = S
    const lines = kind === 'phrase' ? words : balance(words, 4)
    const f = infoRow(c, FOOT3, 'foot')
    const avail = (ph ? L(9) : f.top - GAP) - M
    const gapL = RH * 0.28
    let sizes = lines.map(l => fitSize([l], SPAN(1, 12)))
    const capSum = sizes.reduce((a, s) => a + CAP * s, 0)
    const need = capSum + gapL * (lines.length - 1)
    if (need > avail) { const fct = (avail - gapL * (lines.length - 1)) / capSum; sizes = sizes.map(s => s * fct) }
    const els: El[] = []; let y = M
    lines.forEach((l, i) => { els.push(disp(l, { size: sizes[i], x: X(1), top: y, role: titleRole(i) })); y += CAP * sizes[i]! + gapL })
    els.push(...f.els)
    if (ph) els.push(photoIn({ c1: 1, c2: 12, top: y - gapL + GAP, bottom: f.top - GAP }, { ay: 'bottom' }))
    return { els, did: 'Every line fitted to the full width at its own size, stacked into a wall.' }
  },
}

/** Kicker — a small eyebrow tight above a one-line title, both flush-left. */
export const kicker: LayoutDef = {
  id: 'kicker', name: 'Kicker', fits: ['phrase'],
  fn(S, { c, ph }) {
    const { X, SPAN, L, M, RH, GAP, CAP, INFO, fitSize, disp, info, infoRow, photoIn, FOOT2 } = S
    const base = ph ? L(13) : L(9)
    const size = Math.min(fitSize([c.title], SPAN(1, 12)), RH * 3 / CAP)
    const capTop = base - CAP * size
    const eyeBase = capTop - RH * 0.6
    const els: El[] = [disp(c.title, { size, x: X(1), base })]
    if (c.details) els.push(info(c.details, { x: X(1), w: SPAN(1, 8), base: eyeBase, wt: 500, role: 'details' }))
    els.push(...infoRow(c, FOOT2, 'foot').els)
    if (ph) els.push(photoIn({ c1: 1, c2: 12, top: M, bottom: eyeBase - INFO.size * CAP - GAP }))
    return { els, did: 'A small eyebrow tight above a one-line title, both flush-left.' }
  },
}

/** Sidebar — title in eight columns; information in the last three, from the same cap line. */
export const sidebar: LayoutDef = {
  id: 'sidebar', name: 'Sidebar', fits: [...LINES], smallText: true,
  fn(S, { c, ph, lines }) {
    const { X, SPAN, L, M, GAP, DISPLAY, sizeFor, blockH, disp, infoStack, photoIn } = S
    const maxH = (ph ? L(8) : L(16)) - M
    const size = sizeFor(lines, SPAN(1, 8), maxH)
    const els: El[] = [disp(lines.join('\n'), { size, x: X(1), top: M })]
    const st = infoStack(presentItems(c, COLUMN), 10, 12, M)
    els.push(...st.els)
    const tb = M + blockH(lines.length, size, DISPLAY.lh)
    if (ph) els.push(photoIn({ c1: 1, c2: 8, top: tb + GAP, bottom: L(16) }, { ax: 'left', ay: 'bottom' }))
    return { els, did: 'Title in eight columns; information in the last three, from the same cap line.' }
  },
}
