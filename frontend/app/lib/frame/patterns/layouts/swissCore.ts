import type { El, LayoutDef } from '../kit/types'

// ═══════════════════════ Swiss core layouts ═══════════════════════
// Ported from the prototype (docs/superpowers/specs/assets/2026-09-23-frame-layout-system/
// layout-sheet.html `def(...)` bodies; layout-pane.html where it is newer). Geometry is the
// prototype's, unchanged. Task 8 ports Run-off (the planner's end-to-end layout); Task 9 adds
// the other nine here.

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
