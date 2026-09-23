import { faceOf } from './types'
import type { El, LayoutDef, MissingEl, RectEl, Sheet, Style, TextEl } from './types'

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

/** The ink box of a text element: widest measured line × cap-top..last-baseline. */
function textBox(e: TextEl, S: Sheet): Box {
  const face = faceOf(e.role)
  const CAP = S.measure.capAbove(face) + S.measure.baseBelow(face)

  let n: number
  let widestLine: number
  if (e.pre) {
    const lines = e.s.split('\n')
    n = lines.length
    widestLine = Math.max(...lines.map(l => (S.measure.w100(l, face, e.ls) * e.size) / 100))
  } else {
    const w = e.w ?? 0
    const style: Style = { role: face, ls: e.ls, lh: e.lh }
    n = S.countLines(e.s, w, style, e.size)
    const wrapped = e.s.split('\n').flatMap(p => S.measure.lines(p, face, e.size, e.ls, w))
    widestLine = Math.max(...wrapped.map(l => (S.measure.w100(l, face, e.ls) * e.size) / 100))
  }
  const height = (n - 1) * e.lh * e.size + CAP * e.size

  // `x` is the LEFT edge of a box `w` wide (prototype model); `align` places the ink inside it.
  // The ink is the widest line, except justified flow text, which fills the box.
  const boxW = e.w ?? widestLine
  const align = e.align ?? 'left'
  const width = e.just && !e.pre ? boxW : Math.min(widestLine, boxW)
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
      return { x0: e.x, y0: e.y - 0.1, x1: e.x + e.w, y1: e.y + 0.1 }
    case 'ring': {
      const rad = e.R + e.size / 2
      return { x0: e.cx - rad, y0: e.cy - rad, x1: e.cx + rad, y1: e.cy + rad }
    }
  }
}

function intersects(a: Box, b: Box): boolean {
  return Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0
}

/** Every rule; returns human-readable reasons (empty = passes). */
export function checkPlan(els: El[], S: Sheet, premise?: LayoutDef['premise']): string[] {
  const issues: string[] = []

  // Rule 1: an element the layout couldn't place.
  for (const e of els) {
    if (e.k === 'missing') issues.push(e.why ?? 'no room for the image')
  }

  const present = els.filter((e): e is Present => e.k !== 'missing')
  const boxed = present
    .map(e => ({ e, box: boxOf(e, S) }))
    .filter((it): it is { e: Present; box: Box } => it.box != null)

  // Rule 2: text below the minimum size.
  for (const e of present) {
    if (e.k === 't' && e.size < S.INFO.size - 0.01) issues.push(`${roleLabel(e)}: below minimum size`)
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

  // Rule 5: text meant to sit inside a shape must fit inside it.
  for (const e of present) {
    if (e.k !== 't' || !e.inside) continue
    const box = boxOf(e, S)
    if (!box) continue
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

  return issues
}
