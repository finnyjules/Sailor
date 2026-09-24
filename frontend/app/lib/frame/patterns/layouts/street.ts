import type { Box } from '../kit/check'
import type { Colour, Content, El, LayoutDef, RoleKey, Sheet, TextEl } from '../kit/types'
import { isNumberish } from '../hierarchy'

// ═══════════════════════ Street layouts ═══════════════════════
// Ported from the prototype (docs/superpowers/specs/assets/2026-09-23-frame-layout-system/
// layout-pane.html, `defS('street', …)` ~1506–1588, with `fillLines` and `streetFoot`, and the
// kit's `tag()` ~1159): capitals that fill the Frame, overlap, a tag that breaks the angle.
// Geometry is the prototype's. What differs:
// - A block whose text is absent is skipped (and takes no height) — as the prototype already does.
// - Text is measured in the face of the role it is drawn in.
// - The tag holds the user's own line — the number (the date's text) or else the details — so
//   its text has that line's role (the prototype's `tagtext`); the title lies across it by name.
// - The button is the kit's `button()` pair (a hard-edged box: Street's button shape), built at
//   its final position. The logo is the brand kit's (`c.logo`), at its own aspect.
// - Ruling S5: text may overlap the image only where a band or a tag lies between them (rule 10).
//   Tag and Repeat put the title (and Tag the foot) straight on the image; see each for the fix.
// - Repeat: the title is ONE layer. Its repeats are placed lines (runs) of that layer, so they
//   share its opacity and its place in the stack: they are drawn solid, and only where they
//   clear the real title, the image and the foot (the prototype drew them at 13% behind both).
// - UI copy says "image", not "photo".

const ALL = ['word', 'phrase', 'sentence'] as const

/** The number a Street layout sets on its tag or up its edge: the date's text when it is number-like. */
const numberOf = (c: Content): string | null => (c.date && isNumberish(c.date) ? c.date : null)

/** The line the tag (or Drop's edge) holds: the number, else the details — with its role. */
function sideLine(c: Content): { s: string; role: RoleKey } | null {
  const n = numberOf(c)
  if (n) return { s: n, role: 'date' }
  return c.details ? { s: c.details, role: 'details' } : null
}

const centre = (S: Sheet) => (S.X(1) + S.XR(12)) / 2

/** Every line in capitals fitted to the full width, stacked from `top`; shrunk together to end by
 *  `bottom`. `over`: what the title may lie across (the image, the tag and the tag's line). */
function fillLines(S: Sheet, lines: string[], top: number, bottom: number, over: string[]): { els: TextEl[]; bottom: number } {
  const { RH, CAP, X, SPAN, fitSize, disp } = S
  const gapL = RH * 0.12
  let sizes = lines.map(l => fitSize([l], SPAN(1, 12)))
  const capSum = sizes.reduce((a, s) => a + CAP * s, 0), need = capSum + gapL * (lines.length - 1), avail = bottom - top
  if (need > avail) { const f = (avail - gapL * (lines.length - 1)) / capSum; sizes = sizes.map(s => s * f) }
  const els: TextEl[] = []; let y = top
  lines.forEach((l, i) => { els.push(disp(l, { size: sizes[i], x: X(1), top: y, role: i ? 'title' + i : 'title', over })); y += CAP * sizes[i]! + gapL })
  return { els, bottom: y - gapL }
}

/** The details line, when the tag does not hold it (ruling R10): it goes in the foot. */
const footDetails = (c: Content): string | undefined => (c.details && sideLine(c)?.role !== 'details' ? c.details : undefined)

/** The foot: a hard-edged button bottom-left, the fine print bottom-right (design columns `cap`).
 *  `details` (ruling R10): the details line above the fine print in the same column, where it fits
 *  (two lines at most, clear of the button); else it is left out (the planner hides and quotes it). */
function streetFoot(S: Sheet, c: Content, o: { color?: Colour; bg?: Colour; fg?: Colour; cap?: [number, number]; details?: string } = {}): { els: El[]; top: number } {
  const { X, SPAN, L, GAP, INFO, countLines, blockH, info, button } = S
  const [a, b] = o.cap ?? [7, 12]
  const els: El[] = []; let top = L(16)
  let btnBox: { x1: number; y0: number } | null = null
  if (c.action) {
    const bo = { bg: o.bg ?? 'ink', fg: o.fg ?? 'field' }
    const h = button(c.action, X(1), 0, bo).btn.h
    const bt = button(c.action, X(1), L(16) - h, bo)
    els.push(bt.btn, bt.text); top = bt.btn.y
    btnBox = { x1: bt.btn.x + bt.btn.w, y0: bt.btn.y }
  }
  let base = L(16)
  if (c.caption) {
    const n = countLines(c.caption, SPAN(a, b), INFO, INFO.size)
    els.push(info(c.caption, { x: X(a), w: SPAN(a, b), align: 'right', base: L(16), color: o.color ?? 'ink', role: 'caption' }))
    const capTop = L(16) - blockH(n, INFO.size, INFO.lh)
    top = Math.min(top, capTop)
    base = capTop - INFO.size * 1.25
  }
  if (o.details) {
    const n = countLines(o.details, SPAN(a, b), { ...INFO, role: 'details' }, INFO.size)
    const dTop = base - blockH(n, INFO.size, INFO.lh)
    const clearOfButton = !btnBox || btnBox.x1 + GAP <= X(a) || base + GAP <= btnBox.y0
    if (n <= 2 && clearOfButton) {
      els.push(info(o.details, { x: X(a), w: SPAN(a, b), align: 'right', base, color: o.color ?? 'ink', role: 'details' }))
      top = Math.min(top, dTop)
    }
  }
  return { els, top }
}

/** Fill — every line in capitals fitted to the full width, a rotated tag across the last one. */
export const stFill: LayoutDef = {
  id: 'stFill', name: 'Fill', fits: [...ALL], style: 'street',
  // arr 1 moves the image left; arr 2 turns the tag the other way (it tilts down, 6°, not up 7°).
  arrLabels: ['Image right', 'Image left', 'Tilted tag'],
  fn(S, { c, ph, lines, arr = 0 }) {
    const { X, XR, SPAN, L, M, RH, GAP, PHOTO_ASPECT, tag } = S
    const side = sideLine(c)
    const foot = streetFoot(S, c, { details: footDetails(c) })
    const f = fillLines(S, lines, M, ph ? L(6) : foot.top - GAP * 1.5, ['photo', 'tag', ...(side ? [side.role] : [])])
    const els: El[] = [...f.els, ...foot.els]
    if (ph) {
      // Type over an image needs a contrast check first; until then only the tag bridges them (S5).
      const top = f.bottom + GAP, h = Math.min(foot.top - GAP - top, SPAN(1, 12) * PHOTO_ASPECT), w = h / PHOTO_ASPECT
      els.unshift(h > RH * 2 ? { k: 'p', x: arr === 1 ? X(1) : XR(12) - w, y: top, w, h, role: 'photo', over: ['tag', ...(side ? [side.role] : [])] } : { k: 'missing' })
    }
    if (side) els.push(...tag(side.s, XR(12), f.bottom - GAP * 0.2, arr === 2 ? 6 : -7, ['title', 'photo'], side.role))
    return { els, did: 'Every line in capitals fitted to the full width, a rotated tag across the last one.' }
  },
}

/** Tag — the image full bleed, the title in capitals across the bottom on a band, a tag knocked onto it.
 *  Ruling S5: the prototype set the title and the foot straight on the image (in the page colour);
 *  here they sit on a band of page colour rising from the foot, in the ink colour. */
export const stTag: LayoutDef = {
  id: 'stTag', name: 'Tag', fits: [...ALL], style: 'street',
  needs: { image: true },
  fn(S, { c, ph, lines }) {
    const { X, XR, SPAN, L, M, H, RH, GAP, CAP, fitSize, cover, band, logo, logoH, tag } = S
    const side = sideLine(c)
    const els: El[] = [cover(ph)]
    if (c.logo) els.push(logo(X(1), M, logoH(), { aspect: c.logo.aspect }))
    const foot = streetFoot(S, c, { details: footDetails(c) })
    const sizes = lines.map(l => fitSize([l], SPAN(1, 12)))
    const total = sizes.reduce((a, s) => a + CAP * s, 0) + RH * 0.12 * (lines.length - 1)
    const f = fillLines(S, lines, Math.max(L(4), foot.top - GAP * 1.5 - total), foot.top - GAP * 1.5, ['photo', 'tag', ...(side ? [side.role] : [])])
    const first = f.els[0]!
    els.push(band('bottom', first.top!, H), ...f.els, ...foot.els)
    if (side) els.push(...tag(side.s, XR(12), first.top! - GAP * 0.2, -8, ['title', 'photo'], side.role))
    return { els, did: 'The image full bleed, the title in capitals across the bottom on a band, a tag knocked onto it.' }
  },
}

/** Drop — stacked capitals from the top; the number runs up the right edge. */
export const stDrop: LayoutDef = {
  id: 'stDrop', name: 'Drop', fits: [...ALL], style: 'street',
  fn(S, { c, ph, lines }) {
    const { X, XR, SPAN, L, M, GAP, CAP, DISPLAY, fitSize, sizeFor, blockH, w100, disp, photoIn } = S
    const els: El[] = []
    const side = sideLine(c)
    if (side) {
      const st = { ...DISPLAY, role: side.role }
      const nsz = Math.min(fitSize([side.s], L(16) - M, st), SPAN(11, 12) / CAP)
      const cap = CAP * nsz, k = w100(side.s, st) / 100 * nsz
      els.push(disp(side.s, { size: nsz, x: XR(12) - cap, top: L(16), rot: -90, origin: 'top left', w: k, color: 'accent', role: side.role }))
    }
    const foot = streetFoot(S, c, { cap: [5, 10], details: footDetails(c) })
    const size = sizeFor(lines, SPAN(1, 10), (ph ? L(7) : foot.top - GAP * 2) - M)
    els.push(disp(lines.join('\n'), { size, x: X(1), top: M }))
    const tb = M + blockH(lines.length, size, DISPLAY.lh)
    els.push(...foot.els)
    if (ph) els.push(photoIn({ c1: 1, c2: 10, top: tb + GAP, bottom: foot.top - GAP }, { ax: 'left' }))
    return { els, did: 'Stacked capitals from the top; the number runs up the right edge.' }
  },
}

const hits = (a: Box, b: Box) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0

/** Repeat — the title repeated down the page, the real one large across the middle, a tag across its corner.
 *  The repeats are placed lines (runs) of the ONE title layer: they share its opacity and its place
 *  in the stack, so they are drawn solid and only where they clear the real title, the image and
 *  the foot. Ruling S5: the prototype set the real title over the image (centred on the same line);
 *  with an image, the image now sits above the title, between the top margin and the title. */
export const stRepeat: LayoutDef = {
  id: 'stRepeat', name: 'Repeat', fits: [...ALL], style: 'street',
  fn(S, { c, ph, lines }) {
    const { X, XR, SPAN, L, M, RH, GAP, CAP, DISPLAY, PHOTO_ASPECT, fitSize, sizeFor, blockH, disp, tag } = S
    const side = sideLine(c)
    const els: El[] = []
    const foot = streetFoot(S, c, { details: footDetails(c) })
    const size = sizeFor(lines, SPAN(1, 12), RH * 6)
    const tH = blockH(lines.length, size, DISPLAY.lh), tTop = L(8) - tH / 2
    const title = disp(lines.join('\n'), { size, x: X(1), top: tTop, over: ['photo', 'tag', ...(side ? [side.role] : [])] })
    // The real title first: the layer takes its look (the repeats are its runs).
    els.push(title)
    const clearOf: Box[] = [{ x0: 0, y0: tTop - GAP, x1: 100, y1: tTop + tH + GAP }]
    if (ph) {
      // Above the title: the larger of the two spaces the title leaves (below it the foot takes room).
      const top = M, bottom = tTop - GAP * 2
      const h = Math.min(bottom - top, RH * 8, SPAN(3, 10) * PHOTO_ASPECT), w = h / PHOTO_ASPECT
      if (h > RH * 2) {
        els.push({ k: 'p', x: centre(S) - w / 2, y: top + (bottom - top - h) / 2, w, h, role: 'photo', over: ['tag', ...(side ? [side.role] : [])] })
        clearOf.push({ x0: 0, y0: top - GAP, x1: 100, y1: bottom + GAP })
      } else els.push({ k: 'missing' })
    }
    clearOf.push({ x0: 0, y0: foot.top - GAP, x1: 100, y1: 1e9 })
    // The repeats: the whole title on one line, full width, the prototype's row pitch — stepping
    // away from the real title (up from its top, down from its bottom) and kept where they clear.
    const ts = fitSize([c.title], SPAN(1, 12)), rowH = CAP * ts * 1.18, rowGap = rowH - CAP * ts
    const rows: number[] = []
    for (let y = tTop - rowGap - CAP * ts - GAP; y >= M - 0.01; y -= rowH) rows.unshift(y)
    for (let y = tTop + tH + rowGap + GAP; y + CAP * ts <= L(16) + 0.01; y += rowH) rows.push(y)
    let n = 0
    for (const y of rows) {
      const row: Box = { x0: 0, y0: y, x1: 100, y1: y + CAP * ts }
      if (clearOf.some(b => hits(b, row))) continue
      els.push(disp(c.title, { size: ts, x: X(1), top: y, role: 'title' + ++n, over: ['tag', ...(side ? [side.role] : [])] }))
    }
    if (side) els.push(...tag(side.s, XR(12), tTop - GAP * 0.2, 7, ['title', 'photo'], side.role))
    els.push(...foot.els)
    return { els, did: 'The title repeated down the page, the real one large across the middle, a tag across its corner.' }
  },
}

/** Strip — one row for wide formats: the title in capitals, a tag, a hard-edged button. */
export const stStrip: LayoutDef = {
  id: 'stStrip', name: 'Strip', fits: [...ALL], style: 'street',
  wideOnly: true,
  fn(S, { c, ph }) {
    const { X, XR, H, M, GAP, CAP, PHOTO_ASPECT, fitSize, disp, button, tag } = S
    const els: El[] = [], mid = H / 2
    let x = X(1), right = XR(12)
    if (ph) { const h = H, w = h / PHOTO_ASPECT; els.push({ k: 'p', x: 0, y: 0, w, h, role: 'photo', bleed: true }); x = w + GAP * 2 }
    if (c.action) {
      const bh = button(c.action, XR(12), 0, { align: 'right' }).btn.h
      const b = button(c.action, XR(12), mid - bh / 2, { align: 'right' })
      els.push(b.btn, b.text); right = b.btn.x - GAP * 3
    }
    const side = sideLine(c)
    if (side) {
      const tg = tag(side.s, right, mid, -6, ['title'], side.role)
      els.push(...tg); right -= tg[0].w + GAP * 3
    }
    const size = Math.min(fitSize([c.title], right - x), (H - 2 * M) * 0.9 / CAP)
    els.push(disp(c.title, { size, x, base: mid + CAP * size / 2 }))
    return { els, did: 'One row for wide formats: the title in capitals, a tag, a hard-edged button.' }
  },
}

/** The Street layouts, in the prototype's order (seed order: after Editorial). */
export const STREET_LAYOUTS: LayoutDef[] = [stFill, stTag, stDrop, stRepeat, stStrip]
