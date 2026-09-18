/**
 * Turn a library shape's SVG outline (`d`, absolute M/L/C/Z in its 96-box) into a polygon in
 * the token's LOCAL space — centred on the shape's ink-box centre, y-UP, scaled to fit the
 * token plane (matching how drawShape fits the silhouette). Physics then builds a real collider
 * from this instead of a bounding box. Pure math (no canvas/DOM) → unit-testable.
 */
export interface V2 { x: number; y: number }

function cubic(p0: V2, c1: V2, c2: V2, p1: V2, t: number): V2 {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t
  return { x: a * p0.x + b * c1.x + c * c2.x + d * p1.x, y: a * p0.y + b * c1.y + c * c2.y + d * p1.y }
}

function polyArea(pts: V2[]): number {
  let s = 0
  for (let i = 0, n = pts.length; i < n; i++) { const a = pts[i]!, b = pts[(i + 1) % n]!; s += a.x * b.y - b.x * a.y }
  return s / 2
}

/** Flatten `d` (only M/L/C/Z, absolute) into one point list per subpath (curves subdivided). */
function flatten(d: string, segs: number): V2[][] {
  const toks: (string | number)[] = []
  const re = /([MLCZmlcz])|(-?\d*\.?\d+(?:[eE][-+]?\d+)?)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(d))) toks.push(m[1] ? m[1].toUpperCase() : parseFloat(m[2]!))
  const contours: V2[][] = []
  let cur: V2[] | null = null
  let cmd = ''
  let x = 0, y = 0, sx = 0, sy = 0
  let i = 0
  const n = () => toks[i++] as number
  while (i < toks.length) {
    const t = toks[i]
    if (typeof t === 'string') { cmd = t; i++; if (cmd === 'Z') { if (cur && cur.length > 1) contours.push(cur); cur = null; x = sx; y = sy; continue } }
    if (cmd === 'M') { const nx = n(), ny = n(); if (cur && cur.length > 1) contours.push(cur); cur = [{ x: nx, y: ny }]; x = nx; y = ny; sx = nx; sy = ny; cmd = 'L' }
    else if (cmd === 'L') { const nx = n(), ny = n(); cur?.push({ x: nx, y: ny }); x = nx; y = ny }
    else if (cmd === 'C') { const x1 = n(), y1 = n(), x2 = n(), y2 = n(), nx = n(), ny = n(); const p0 = { x, y }; for (let s = 1; s <= segs; s++) cur?.push(cubic(p0, { x: x1, y: y1 }, { x: x2, y: y2 }, { x: nx, y: ny }, s / segs)); x = nx; y = ny }
    else { i++ }
  }
  if (cur && cur.length > 1) contours.push(cur)
  return contours
}

/**
 * The largest subpath of `shape.d`, mapped to token-local coordinates: centred on the ink-box
 * centre, y flipped to world-up, and scaled to fit `planeW × planeH` (aspect kept, like drawShape).
 * Returns null if it can't produce a usable (≥3-vertex) polygon.
 */
export function parseShapePolygon(
  d: string, box: [number, number, number, number], planeW: number, planeH: number, segsPerCurve = 6,
): V2[] | null {
  if (!d || !(planeW > 0) || !(planeH > 0)) return null
  const [bx, by, bw, bh] = box
  if (!(bw > 0) || !(bh > 0)) return null
  const contours = flatten(d, segsPerCurve)
  if (!contours.length) return null
  let best = contours[0]!, bestA = Math.abs(polyArea(best))
  for (let k = 1; k < contours.length; k++) { const a = Math.abs(polyArea(contours[k]!)); if (a > bestA) { bestA = a; best = contours[k]! } }
  if (best.length < 3) return null
  const sf = Math.min(planeW / bw, planeH / bh)
  const cx = bx + bw / 2, cy = by + bh / 2
  return best.map(p => ({ x: (p.x - cx) * sf, y: -(p.y - cy) * sf }))
}
