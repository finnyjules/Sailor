import type { Content, El, LayoutDef, Sheet, Style, TextKey } from '../kit/types'

// ═══════════════════════ Editorial layouts ═══════════════════════
// Ported from the prototype (docs/superpowers/specs/assets/2026-09-23-frame-layout-system/
// layout-pane.html, `defS('editorial', …)` ~1450–1522): centred, small, quiet; the image and the
// empty space do the work. Geometry is the prototype's, unchanged. What differs, none of it
// geometry:
// - A block whose text is absent is skipped (and takes no height) — as the prototype already does.
// - Text is measured in the face of the role it is drawn in (the title in whatever face the
//   title layer has — the suggested serif is the user's choice, never assumed here).
// - The button is the kit's `button()` pair, built at its final position. Editorial's button is
//   a link (the style's `button.shape`): the user's action text, underlined, with no shape.
// - The logo is the brand kit's (`c.logo`: `{ url, aspect }`), drawn at its own aspect.
// - UI copy says "image", not "photo".

const ALL = ['word', 'phrase', 'sentence'] as const

/** Gentle scale: the title never shouts. */
const cap2 = (S: Sheet) => S.SECOND.size * 2.5

/** The centre line of the page's columns. */
const centre = (S: Sheet) => (S.X(1) + S.XR(12)) / 2

/** INFO measured in the face of the line's own role. */
const infoOf = (S: Sheet, role: TextKey): Style => ({ ...S.INFO, role: role === 'action' ? 'caption' : role })

/** The action link, centred on `cx`, its bottom at `bottom`; returns the elements and its top. */
function linkUp(S: Sheet, c: Content, cx: number, bottom: number, color?: 'field'): { els: El[]; top: number } {
  if (!c.action) return { els: [], top: bottom }
  const o = color ? { align: 'center' as const, color } : { align: 'center' as const }
  const h = S.button(c.action, cx, 0, o).btn.h
  const b = S.button(c.action, cx, bottom - h, o)
  return { els: [b.btn, b.text], top: b.btn.y }
}

/** Cover — the image covers the page; a small centred title and the logo sit on it, with a lot of air. */
export const edCover: LayoutDef = {
  id: 'edCover', name: 'Cover', fits: [...ALL], style: 'editorial',
  needs: { image: true },
  fn(S, { c, ph, lines }) {
    const { X, SPAN, L, M, RH, GAP, CAP, INFO, countLines, blockH, sizeFor, info, disp, cover, logo, logoH } = S
    const cx = centre(S), els: El[] = [cover(ph)]
    if (c.logo) els.push(logo(cx, M, logoH(), { aspect: c.logo.aspect, align: 'center' }))
    let yb = L(16)
    if (c.action) { const b = linkUp(S, c, cx, yb, 'field'); els.push(...b.els); yb = b.top - GAP * 1.4 }
    for (const k of ['caption', 'date'] as const) {
      const s = c[k]; if (!s) continue
      const n = countLines(s, SPAN(3, 10), infoOf(S, k), INFO.size)
      els.push(info(s, { x: X(3), w: SPAN(3, 10), align: 'center', base: yb, color: 'field', role: k }))
      yb -= blockH(n, INFO.size, INFO.lh) + GAP * 0.8
    }
    if (c.details) {
      els.push(info(c.details, { x: X(2), w: SPAN(2, 11), align: 'center', base: yb - GAP * 0.4, color: 'field', role: 'details' }))
      yb -= CAP * INFO.size + GAP * 1.6
    }
    const size = Math.min(sizeFor(lines, SPAN(3, 10), RH * 2.6), cap2(S))
    els.push(disp(lines.join('\n'), { size, x: X(1), w: SPAN(1, 12), align: 'center', base: yb, color: 'field' }))
    return { els, did: 'The image covers the page; a small centred title and the logo sit on it, with a lot of air.' }
  },
}

/** Framed — the image framed on the centre line with generous margins; small centred type below it. */
export const edFramed: LayoutDef = {
  id: 'edFramed', name: 'Framed', fits: [...ALL], style: 'editorial',
  needs: { image: true },
  fn(S, { c, ph, lines, arr = 0 }) {
    const { X, SPAN, L, M, RH, GAP, INFO, DISPLAY, PHOTO_ASPECT, countLines, blockH, sizeFor, info, disp, logo, logoH, clear } = S
    const cx = centre(S), els: El[] = []
    let y = M
    if (c.logo) { const lg = logo(cx, y, logoH(), { aspect: c.logo.aspect, align: 'center' }); els.push(lg); y += lg.h + clear(lg) * 1.3 }
    let yb = L(16)
    if (c.action) { const b = linkUp(S, c, cx, yb); els.push(...b.els); yb = b.top - GAP * 1.4 }
    for (const k of ['caption', 'date', 'details'] as const) {
      const s = c[k]; if (!s) continue
      const n = countLines(s, SPAN(3, 10), infoOf(S, k), INFO.size)
      els.push(info(s, { x: X(3), w: SPAN(3, 10), align: 'center', base: yb, role: k }))
      yb -= blockH(n, INFO.size, INFO.lh) + GAP * 0.7
    }
    const size = Math.min(sizeFor(lines, SPAN(3, 10), RH * 2.2), cap2(S))
    const tb = yb - GAP * 0.6
    els.push(disp(lines.join('\n'), { size, x: X(1), w: SPAN(1, 12), align: 'center', base: tb }))
    const tTop = tb - blockH(lines.length, size, DISPLAY.lh), avail = tTop - GAP * 2 - y
    const h = Math.min(avail, SPAN(arr === 1 ? 4 : 3, arr === 1 ? 9 : 10) * PHOTO_ASPECT), w = h / PHOTO_ASPECT
    els.push(h > RH * 2 ? { k: 'p', x: cx - w / 2, y: y + (avail - h) / 2, w, h, stand: !ph, role: 'photo' } : { k: 'missing' })
    return { els, did: 'The image framed on the centre line with generous margins; small centred type below it.' }
  },
}

/** Quiet — a small title on the centre of the page and almost nothing else. */
export const edQuiet: LayoutDef = {
  id: 'edQuiet', name: 'Quiet', fits: [...ALL], style: 'editorial',
  fn(S, { c, ph, lines }) {
    const { X, SPAN, L, M, RH, GAP, CAP, INFO, DISPLAY, PHOTO_ASPECT, countLines, blockH, sizeFor, info, disp, logo, logoH, clear } = S
    const cx = centre(S), els: El[] = []
    const size = Math.min(sizeFor(lines, SPAN(3, 10), RH * 3), cap2(S))
    const tH = blockH(lines.length, size, DISPLAY.lh), tTop = (ph ? L(10) : L(7.5)) - tH / 2
    els.push(disp(lines.join('\n'), { size, x: X(1), w: SPAN(1, 12), align: 'center', top: tTop }))
    const dTop = tTop - GAP * 1.4 - CAP * INFO.size
    if (c.details) els.push(info(c.details, { x: X(2), w: SPAN(2, 11), align: 'center', top: dTop, role: 'details' }))
    let y = tTop + tH + GAP * 1.6
    for (const k of ['date', 'caption'] as const) {
      const s = c[k]; if (!s) continue
      const n = countLines(s, SPAN(3, 10), infoOf(S, k), INFO.size)
      els.push(info(s, { x: X(3), w: SPAN(3, 10), align: 'center', top: y, role: k }))
      y += blockH(n, INFO.size, INFO.lh) + GAP * 0.7
    }
    let yb = L(16)
    if (c.logo) {
      const h = logoH(), lg = logo(cx, yb - h, h, { aspect: c.logo.aspect, align: 'center' })
      els.push(lg); yb = lg.y - clear(lg)
    }
    if (c.action) els.push(...linkUp(S, c, cx, yb).els)
    if (ph) {
      const avail = dTop - GAP * 2 - M, h = Math.min(avail, SPAN(5, 8) * PHOTO_ASPECT), w = h / PHOTO_ASPECT
      els.push(h > RH * 1.5 ? { k: 'p', x: cx - w / 2, y: M + (avail - h) / 2, w, h, role: 'photo' } : { k: 'missing' })
    }
    return { els, did: 'A small title on the centre of the page and almost nothing else.' }
  },
}

/** Diptych — half image, half calm: a centred column of small type, padded inside the other half. */
export const edDiptych: LayoutDef = {
  id: 'edDiptych', name: 'Diptych', fits: [...ALL], style: 'editorial',
  needs: { image: true },
  fn(S, { c, ph, lines, arr = 0 }) {
    const { W, H, M, L, RH, INFO, DISPLAY, countLines, blockH, sizeFor, info, disp, cover, logo, logoH, button, gapBelow, inset } = S
    const els: El[] = [cover(ph)], right = arr !== 1, pad = inset()
    els.push({ k: 'r', x: right ? W / 2 : 0, y: 0, w: W / 2, h: H, color: 'field', role: 'panel', ok: true, bleed: true })
    const x0 = (right ? W / 2 : 0) + pad, cw = W / 2 - 2 * pad, cx = x0 + cw / 2
    const col = { x: x0, w: cw, align: 'center' as const }
    if (c.logo) els.push(logo(cx, Math.max(M, pad * 0.8), logoH(), { aspect: c.logo.aspect, align: 'center' }))
    const size = Math.min(sizeFor(lines, cw, RH * 3), cap2(S))
    const tH = blockH(lines.length, size, DISPLAY.lh), tTop = L(8) - tH / 2
    els.push(disp(lines.join('\n'), { size, ...col, top: tTop }))
    if (c.details) els.push(info(c.details, { ...col, base: tTop - gapBelow(INFO.size) * 2, role: 'details' }))
    let y = tTop + tH + gapBelow(size) * 1.4
    for (const k of ['date', 'caption'] as const) {
      const s = c[k]; if (!s) continue
      const n = countLines(s, cw, infoOf(S, k), INFO.size)
      els.push(info(s, { ...col, top: y, role: k }))
      y += blockH(n, INFO.size, INFO.lh) + gapBelow(INFO.size)
    }
    if (c.action) {
      const h = button(c.action, cx, 0, { align: 'center' }).btn.h
      const b = button(c.action, cx, H - Math.max(M, pad * 0.8) - h, { align: 'center' })
      els.push(b.btn, b.text)
    }
    return { els, did: 'Half image, half calm: a centred column of small type, padded inside the other half.' }
  },
}

/** The Editorial layouts, in the prototype's order (seed order: after Performance). */
export const EDITORIAL_LAYOUTS: LayoutDef[] = [edCover, edFramed, edQuiet, edDiptych]
