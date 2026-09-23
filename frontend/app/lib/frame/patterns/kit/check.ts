import { faceOf } from './types'
import type { KeepClear } from '~/lib/frame/formats'
import type { El, LayoutDef, MissingEl, RectEl, Sheet, Style, TextEl } from './types'
import { STYLES } from './styles'
import type { StyleId } from './styles'

// ═══════════════════════ the checker ═══════════════════════
// Ported from the prototype (docs/superpowers/specs/assets/2026-09-23-frame-layout-system/
// layout-pane.html, `check` + `pageCheck`). One checker every layout plan passes through:
// collisions, off-page, minimum size, fit inside a shape, panel padding, and the layout's
// own premise (roles it promised to overlap, bleed or rotate).

export interface Box { x0: number; y0: number; x1: number; y1: number }

type Present = Exclude<El, MissingEl>

/** `title3` → `title`: the role a `title`/`title2`/`title3` element shares for `over` checks. */
function baseRole(role: string): string {
  return role.replace(/\d+$/, '')
}

/** The label used in a reason string: text falls back to `'t'`, everything else to its kind. */
function roleLabel(e: Present): string {
  return e.role ?? (e.k === 't' ? 't' : e.k)
}

/** Rotate a box's four corners about `origin` ('top left', the box's own top-left corner, or
 *  'center') by `rot` degrees (CSS `rotate()`, clockwise in screen space) and return the new
 *  axis-aligned bounding box. */
function rotateBox(b: Box, rot: number, origin: string | undefined): Box {
  const rad = (rot * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const [ox, oy] = origin === 'center' ? [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2] : [b.x0, b.y0]
  const corners: [number, number][] = [
    [b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1],
  ]
  const xs: number[] = []
  const ys: number[] = []
  for (const [px, py] of corners) {
    xs.push(ox + (px - ox) * cos - (py - oy) * sin)
    ys.push(oy + (px - ox) * sin + (py - oy) * cos)
  }
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
}

/** The ink box of a text element: widest measured line × cap-top..last-baseline.
 *  `overflow`: a word wider than the box is not clipped to it — the renderer only wraps at
 *  spaces, so an unbreakable word (a date such as "19.09.–15.11.2026") spills past its box. */
function textBox(e: TextEl, S: Sheet, overflow = false): Box {
  const face = faceOf(e.role)
  const CAP = S.measure.capAbove(face) + S.measure.baseBelow(face)

  let n: number
  let widestLine: number
  if (e.pre) {
    const lines = e.s.split('\n')
    n = lines.length
    widestLine = Math.max(...lines.map(l => (S.measure.w100(l, face, e.ls, e.upper) * e.size) / 100))
  } else {
    const w = e.w ?? 0
    const style: Style = { role: face, ls: e.ls, lh: e.lh, upper: e.upper }
    n = S.countLines(e.s, w, style, e.size)
    const wrapped = e.s.split('\n').flatMap(p => S.measure.lines(p, face, e.size, e.ls, w, e.upper))
    widestLine = Math.max(...wrapped.map(l => (S.measure.w100(l, face, e.ls, e.upper) * e.size) / 100))
  }
  const height = (n - 1) * e.lh * e.size + CAP * e.size

  // `x` is the LEFT edge of a box `w` wide (prototype model); `align` places the ink inside it.
  // The ink is the widest line, except justified flow text, which fills the box.
  const boxW = e.w ?? widestLine
  const align = e.align ?? 'left'
  const width = e.just && !e.pre ? Math.max(boxW, overflow ? widestLine : 0) : overflow ? widestLine : Math.min(widestLine, boxW)
  const x0 = align === 'center' ? e.x + (boxW - width) / 2 : align === 'right' ? e.x + boxW - width : e.x

  // Cap top of the first line .. baseline of the last line.
  let y0: number
  let y1: number
  if (e.top != null) { y0 = e.top; y1 = e.top + height } else { y1 = e.base ?? 0; y0 = y1 - height }

  let box: Box = { x0, y0, x1: x0 + width, y1 }
  if (e.rot) box = rotateBox(box, e.rot, e.origin)
  return box
}

/** Measured ink box of an element in kit units (text: widest measured line × cap-top..last-baseline,
 *  rotation applied as the rotated bounding box). */
export function boxOf(e: El, S: Sheet): Box | null {
  switch (e.k) {
    case 'missing':
      return null
    case 't':
      return textBox(e, S)
    case 'p':
      return { x0: e.x, y0: e.y, x1: e.x + e.w, y1: e.y + e.h }
    case 'r': {
      const box: Box = { x0: e.x, y0: e.y, x1: e.x + e.w, y1: e.y + e.h }
      return e.rot ? rotateBox(box, e.rot, 'center') : box
    }
    case 'c':
      return { x0: e.cx - e.r, y0: e.cy - e.r, x1: e.cx + e.r, y1: e.cy + e.r }
    case 'l':
      // The prototype draws a rule as a 0.16-thick border whose TOP is at `y`.
      return { x0: e.x, y0: e.y, x1: e.x + e.w, y1: e.y + 0.16 }
    case 'ring': {
      const rad = e.R + e.size / 2
      return { x0: e.cx - rad, y0: e.cy - rad, x1: e.cx + rad, y1: e.cy + rad }
    }
    case 'band':
      // Full width, over its own height (fade included).
      return { x0: 0, y0: e.y, x1: S.W, y1: e.y + e.h }
    case 'btn':
    case 'logo':
      return { x0: e.x, y0: e.y, x1: e.x + e.w, y1: e.y + e.h }
  }
}

/** True when `box` lies inside the union of `covers` (rectangle subtraction; 0.05-unit slack). */
function insideUnion(box: Box, covers: Box[]): boolean {
  const eps = 0.05
  let rest: Box[] = [box]
  for (const c of covers) {
    const next: Box[] = []
    for (const r of rest) {
      if (!(Math.min(r.x1, c.x1) - Math.max(r.x0, c.x0) > 0 && Math.min(r.y1, c.y1) - Math.max(r.y0, c.y0) > 0)) { next.push(r); continue }
      // The parts of r outside c: above, below, then left and right in the middle strip.
      if (r.y0 < c.y0) next.push({ ...r, y1: c.y0 })
      if (r.y1 > c.y1) next.push({ ...r, y0: c.y1 })
      const y0 = Math.max(r.y0, c.y0), y1 = Math.min(r.y1, c.y1)
      if (r.x0 < c.x0) next.push({ x0: r.x0, y0, x1: c.x0, y1 })
      if (r.x1 > c.x1) next.push({ x0: c.x1, y0, x1: r.x1, y1 })
    }
    rest = next.filter(r => r.x1 - r.x0 > eps && r.y1 - r.y0 > eps)
    if (!rest.length) return true
  }
  return !rest.length
}

/** The pieces that carry text over an image in a `textOffImage` style (rule 10). */
const COVER_ROLES = ['card', 'panel', 'sticker', 'tag']

function intersects(a: Box, b: Box): boolean {
  return Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0
}

/** A format's keep-clear rule for the checker (Stage 2): the areas the platform covers, and the
 *  frame's full height in kit units (the band is measured from it). */
export interface CheckOpts { keep?: KeepClear; fullH?: number
  /** The style (Stage 3): a style with `textOffImage` runs rule 10. Absent: `'swiss'`. */
  style?: StyleId }

/** Every rule; returns human-readable reasons (empty = passes). */
export function checkPlan(els: El[], S: Sheet, premise?: LayoutDef['premise'], opts?: CheckOpts): string[] {
  const issues: string[] = []

  // Rule 1: an element the layout couldn't place.
  for (const e of els) {
    if (e.k === 'missing') issues.push(e.why ?? 'no room for the image')
  }

  const present = els.filter((e): e is Present => e.k !== 'missing')
  // Rules 3 and 4 measure the real ink: a word wider than its text box spills past it (the
  // renderer only wraps at spaces), so it counts towards off-page and overlap.
  const boxed = present
    .map(e => ({ e, box: e.k === 't' ? textBox(e, S, true) : boxOf(e, S) }))
    .filter((it): it is { e: Present; box: Box } => it.box != null)

  // Rule 2: text below the minimum size. A ring (the title set on a path) is text too, as in
  // rule 8 — without it, Ring on a 320×50 banner set its title at 1.89 against a floor of 2.81.
  for (const e of present) {
    if ((e.k === 't' || e.k === 'ring') && e.size < S.INFO.size - 0.01) issues.push(`${roleLabel(e)}: below minimum size`)
  }

  // Rule 3: off the page.
  for (const { e, box } of boxed) {
    if (!e.bleed && (box.x0 < -0.3 || box.y0 < -0.3 || box.x1 > S.W + 0.3 || box.y1 > S.H + 0.3)) {
      issues.push(`${roleLabel(e)}: off the page`)
    }
  }

  // Rule 4: collisions — every pair once, reported in element order.
  for (let i = 0; i < boxed.length; i++) {
    for (let j = i + 1; j < boxed.length; j++) {
      const a = boxed[i]!
      const b = boxed[j]!
      if (a.e.ok || b.e.ok) continue
      const aRole = roleLabel(a.e)
      const bRole = roleLabel(b.e)
      if (a.e.over?.includes(baseRole(bRole)) || b.e.over?.includes(baseRole(aRole))) continue
      const ix = Math.min(a.box.x1, b.box.x1) - Math.max(a.box.x0, b.box.x0)
      const iy = Math.min(a.box.y1, b.box.y1) - Math.max(a.box.y0, b.box.y0)
      if (ix > 0.25 && iy > 0.25) issues.push(`${aRole} overlaps ${bRole}`)
    }
  }

  // Rule 5: text meant to sit inside a shape must fit inside it — measured on the real ink, so a
  // word that overflows its text box (the renderer does not break inside a word) is caught.
  for (const e of present) {
    if (e.k !== 't' || !e.inside) continue
    const box = textBox(e, S, true)
    const shape = present.find(s => s.role === e.inside)
    const shapeBox = shape ? boxOf(shape, S) : null
    if (!shape || !shapeBox) continue
    const corners: [number, number][] = [[box.x0, box.y0], [box.x1, box.y0], [box.x0, box.y1], [box.x1, box.y1]]
    const fits = shape.k === 'c'
      ? (() => {
          const cx = (shapeBox.x0 + shapeBox.x1) / 2
          const cy = (shapeBox.y0 + shapeBox.y1) / 2
          const r = (shapeBox.x1 - shapeBox.x0) / 2
          return corners.every(([x, y]) => Math.hypot(x - cx, y - cy) <= r * 0.97)
        })()
      : box.x0 >= shapeBox.x0 && box.x1 <= shapeBox.x1 && box.y0 >= shapeBox.y0 && box.y1 <= shapeBox.y1
    if (!fits) issues.push(`${roleLabel(e)} does not fit inside its ${e.inside}`)
  }

  // Rule 6: text too close to the edge of its panel/card.
  const panels: Box[] = present
    .filter((e): e is RectEl => e.k === 'r' && (e.role === 'panel' || e.role === 'card'))
    .map(e => boxOf(e, S))
    .filter((b): b is Box => b != null)
    .map(b => ({ x0: Math.max(0, b.x0), y0: Math.max(0, b.y0), x1: Math.min(S.W, b.x1), y1: Math.min(S.H, b.y1) }))
  if (panels.length) {
    const minPad = 0.9 * S.M
    for (const e of present) {
      if (e.k !== 't' || e.rot) continue
      const box = boxOf(e, S)
      if (!box) continue
      const cx = (box.x0 + box.x1) / 2
      const cy = (box.y0 + box.y1) / 2
      for (const p of panels) {
        if (cx > p.x0 && cx < p.x1 && cy > p.y0 && cy < p.y1) {
          const pad = Math.min(box.x0 - p.x0, p.x1 - box.x1, box.y0 - p.y0, p.y1 - box.y1)
          if (pad < minPad) { issues.push('too close to the edge of its panel'); break }
        }
      }
    }
  }

  // Rule 7: the layout's own premise.
  if (premise) {
    const byRole = (role: string) => present.find(e => e.role === role)
    for (const [a, b] of premise.overlap ?? []) {
      const ea = byRole(a)
      const eb = byRole(b)
      const ba = ea ? boxOf(ea, S) : null
      const bb = eb ? boxOf(eb, S) : null
      if (!ba || !bb || !intersects(ba, bb)) issues.push(`promise broken: ${a} should overlap ${b}`)
    }
    for (const role of premise.bleed ?? []) {
      const e = byRole(role)
      const box = e ? boxOf(e, S) : null
      const runsOff = box != null && (box.x0 < 0 || box.y0 < 0 || box.x1 > S.W || box.y1 > S.H)
      if (!runsOff) issues.push(`promise broken: ${role} should run off the page`)
    }
    for (const role of premise.rotated ?? []) {
      const e = byRole(role)
      const rot = e && 'rot' in e ? e.rot : undefined
      if (!rot) issues.push(`promise broken: ${role} should be rotated`)
    }
  }

  // Rule 8: text under the platform's interface (a format with keep-clear areas). Text only —
  // images, panels and bands run on under the app's bars. Measured on the real ink, like rule 3;
  // a ring (the title set on a path) is text too, as in the prototype.
  const keep = opts?.keep
  if (keep) {
    const fullH = opts?.fullH ?? S.H
    const top = fullH * keep.top, bottom = fullH * (1 - keep.bottom)
    const left = 100 * keep.left, right = 100 - 100 * keep.right
    for (const { e, box } of boxed) {
      if (e.k !== 't' && e.k !== 'ring') continue
      if (box.y0 < top - 0.3 || box.y1 > bottom + 0.3 || box.x0 < left - 0.3 || box.x1 > right + 0.3) {
        issues.push(`${roleLabel(e)}: under the app's interface`)
      }
    }
  }

  // Rule 9: space kept clear around the logo — nothing closer than 0.35 × its height (spec §7;
  // the prototype's check). Pieces that may lie anywhere (`ok`) and pieces set over the logo on
  // purpose (`over`) are exempt, as in the prototype.
  for (const lg of boxed) {
    if (lg.e.k !== 'logo') continue
    const pad = 0.35 * (lg.box.y1 - lg.box.y0)
    const zone: Box = { x0: lg.box.x0 - pad, y0: lg.box.y0 - pad, x1: lg.box.x1 + pad, y1: lg.box.y1 + pad }
    for (const o of boxed) {
      if (o === lg || o.e.ok) continue
      if (o.e.over?.includes('logo') || lg.e.over?.includes(baseRole(roleLabel(o.e)))) continue
      if (Math.min(zone.x1, o.box.x1) - Math.max(zone.x0, o.box.x0) > 0.01 && Math.min(zone.y1, o.box.y1) - Math.max(zone.y0, o.box.y0) > 0.01) {
        issues.push('logo: needs clear space')
        break
      }
    }
  }

  // Rule 10 (a style with `textOffImage`): text never sits on a raw image. Text that overlaps an
  // image (more than 0.25 on both axes, the collision threshold) must lie inside the union of the
  // bands, cards, panels, stickers and tags drawn ABOVE that image (later in element order).
  if (opts?.style && STYLES[opts.style].textOffImage) {
    const isImage = (e: Present) => e.k === 'p' || (e.k === 'c' && !!e.photo)
    const images = boxed.map((it, i) => ({ ...it, i })).filter(it => isImage(it.e))
    boxed.forEach(({ e, box }) => {
      if (e.k !== 't') return
      for (const img of images) {
        const ix = Math.min(box.x1, img.box.x1) - Math.max(box.x0, img.box.x0)
        const iy = Math.min(box.y1, img.box.y1) - Math.max(box.y0, img.box.y0)
        if (!(ix > 0.25 && iy > 0.25)) continue
        // A drawn button covers its own label (`over: ['btn']`). A link draws no shape, so it
        // covers nothing. Residual risk: toOps may still fall back to a link when no palette role
        // contrasts 3:1 with the action text's colour — the checker cannot know that colour here.
        const ownBtn = (c: Present) => c.k === 'btn' && c.shape !== 'link' && !!e.over?.includes('btn')
        const above = boxed.slice(img.i + 1).filter(c => c.e.k === 'band' || ownBtn(c.e)
          || ((c.e.k === 'r' || (c.e.k === 'c' && !c.e.photo)) && COVER_ROLES.includes(baseRole(c.e.role ?? ''))))
        // A circle (a sticker) holds the text when all four corners lie inside it.
        const inCircle = above.some(c => {
          if (c.e.k !== 'c') return false
          const { cx, cy, r } = c.e
          return ([[box.x0, box.y0], [box.x1, box.y0], [box.x0, box.y1], [box.x1, box.y1]] as const)
            .every(([x, y]) => Math.hypot(x - cx, y - cy) <= r)
        })
        if (!inCircle && !insideUnion(box, above.filter(c => c.e.k !== 'c').map(c => c.box))) {
          issues.push(`${roleLabel(e)}: sits on the raw image`)
          return
        }
      }
    })
  }

  return issues
}
