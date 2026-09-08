export interface Pt { x: number; y: number }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const f = (v: number) => +v.toFixed(4)

// N vertices on the (w/2, h/2) ellipse, first at top (angle -90°), clockwise.
export function polygonVertices(sides: number, w: number, h: number): Pt[] {
  const n = Math.max(3, Math.round(sides))
  const rx = w / 2, ry = h / 2
  const out: Pt[] = []
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n
    out.push({ x: rx * Math.cos(a), y: ry * Math.sin(a) })
  }
  return out
}

// 2*points vertices alternating outer (rx,ry) and inner (innerRatio*rx, innerRatio*ry),
// first outer at top.
export function starVertices(points: number, innerRatio: number, w: number, h: number): Pt[] {
  const n = Math.max(3, Math.round(points))
  const ir = clamp(innerRatio, 0.01, 0.99)
  const rx = w / 2, ry = h / 2
  const step = Math.PI / n // half the angular gap between outer points
  const out: Pt[] = []
  for (let i = 0; i < 2 * n; i++) {
    const a = -Math.PI / 2 + i * step
    const outer = i % 2 === 0
    const kx = outer ? rx : rx * ir
    const ky = outer ? ry : ry * ir
    out.push({ x: kx * Math.cos(a), y: ky * Math.sin(a) })
  }
  return out
}

// Build an SVG `d`. cornerRadius 0..1: per corner r = cr * min(prevEdge, nextEdge) / 2;
// inset along both adjacent edges by r, join with a quadratic (control = the vertex).
export function roundedPolygonPath(vertices: Pt[], cornerRadius: number): string {
  const n = vertices.length
  if (n < 3) return ''
  const cr = clamp(cornerRadius, 0, 1)
  if (cr <= 0) {
    let d = `M ${f(vertices[0].x)} ${f(vertices[0].y)}`
    for (let i = 1; i < n; i++) d += ` L ${f(vertices[i].x)} ${f(vertices[i].y)}`
    return d + ' Z'
  }
  const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y)
  const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
  let d = ''
  for (let i = 0; i < n; i++) {
    const prev = vertices[(i - 1 + n) % n]
    const curr = vertices[i]
    const next = vertices[(i + 1) % n]
    const lenPrev = dist(curr, prev)
    const lenNext = dist(curr, next)
    // radius as a length, clamped to half of each adjacent edge so arcs never overlap
    const r = (cr * Math.min(lenPrev, lenNext)) / 2
    const tPrev = lenPrev > 0 ? r / lenPrev : 0
    const tNext = lenNext > 0 ? r / lenNext : 0
    const p1 = lerp(curr, prev, tPrev) // entry tangent point (on edge toward prev)
    const p2 = lerp(curr, next, tNext) // exit tangent point (on edge toward next)
    d += i === 0 ? `M ${f(p1.x)} ${f(p1.y)}` : ` L ${f(p1.x)} ${f(p1.y)}`
    d += ` Q ${f(curr.x)} ${f(curr.y)} ${f(p2.x)} ${f(p2.y)}`
  }
  return d + ' Z'
}

export function polygonPathData(sides: number, w: number, h: number, cornerRadius: number): string {
  if (w <= 1e-6 || h <= 1e-6) return ''
  return roundedPolygonPath(polygonVertices(sides, w, h), cornerRadius)
}

export function starPathData(points: number, innerRatio: number, w: number, h: number, cornerRadius: number): string {
  if (w <= 1e-6 || h <= 1e-6) return ''
  return roundedPolygonPath(starVertices(points, innerRatio, w, h), cornerRadius)
}

/**
 * A rounded rect as SVG path data, tracing EXACTLY the outline
 * `ctx.roundRect(x, y, w, h, [tl, tr, br, bl])` draws.
 *
 * Why it exists: a shapes stroke (library marks marching along the edge) needs the layer's
 * outline as a path string to flatten, and a rect had none — it was only ever a canvas
 * primitive. A disagreement here is invisible: the marks would simply sit a little off the
 * real edge with nothing to flag it, so `tests/compositor-multi-stroke.spec.ts` rasterises
 * this path and `ctx.roundRect` side by side and compares the pixels.
 *
 * The radii are clamped exactly as `cornerRadii` clamps them (0 … half the shorter side),
 * so the two can never disagree about an over-large radius. That clamp also guarantees no
 * pair of adjacent radii can overrun their shared side, which is why the SVG arcs need no
 * scale-down pass of their own.
 *
 * Corners are traced clockwise (sweep flag 1 on a y-down canvas) from the top edge, and an
 * arc is emitted only for a corner with a radius — so an all-square rect is a plain
 * four-line ring rather than four degenerate arcs.
 */
export function roundedRectPathData(
  x: number, y: number, w: number, h: number,
  tl: number, tr: number, br: number, bl: number,
): string {
  if (!(w > 1e-6) || !(h > 1e-6)) return ''
  const max = Math.min(w, h) / 2
  const r = (v: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, 0, max) : 0)
  const a = r(tl), b = r(tr), c = r(br), e = r(bl)
  if (a === 0 && b === 0 && c === 0 && e === 0) {
    return `M ${f(x)} ${f(y)} L ${f(x + w)} ${f(y)} L ${f(x + w)} ${f(y + h)} L ${f(x)} ${f(y + h)} Z`
  }
  const arc = (rad: number, px: number, py: number) =>
    rad > 0 ? ` A ${f(rad)} ${f(rad)} 0 0 1 ${f(px)} ${f(py)}` : ''
  let d = `M ${f(x + a)} ${f(y)}`
  d += ` L ${f(x + w - b)} ${f(y)}` + arc(b, x + w, y + b)
  d += ` L ${f(x + w)} ${f(y + h - c)}` + arc(c, x + w - c, y + h)
  d += ` L ${f(x + e)} ${f(y + h)}` + arc(e, x, y + h - e)
  d += ` L ${f(x)} ${f(y + a)}` + arc(a, x + a, y)
  return d + ' Z'
}

/**
 * An origin-centred ellipse as SVG path data, tracing exactly what
 * `ctx.ellipse(0, 0, rx, ry, 0, 0, 2π)` draws — two half-arcs from the right-hand vertex,
 * sweeping clockwise on a y-down canvas (which is what the canvas primitive's default
 * `anticlockwise = false` means there). Same purpose as `roundedRectPathData` above.
 */
export function ellipsePathData(rx: number, ry: number): string {
  if (!(rx > 1e-6) || !(ry > 1e-6)) return ''
  return `M ${f(rx)} 0 A ${f(rx)} ${f(ry)} 0 0 1 ${f(-rx)} 0 A ${f(rx)} ${f(ry)} 0 0 1 ${f(rx)} 0 Z`
}
