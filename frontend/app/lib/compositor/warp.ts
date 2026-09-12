/**
 * Projective (corner-pin / perspective) image warp for the 2D-canvas compositor.
 *
 * Canvas 2D transforms are affine-only, so a true 4-corner projective warp is done
 * by: solve the homography that maps the unit square → the destination quad, sample
 * a subdivided grid, and draw each grid cell as two affine triangles (texture-mapped
 * from the source canvas). With enough subdivision the affine triangles converge to
 * the projective map, so straight edges stay straight and the quad foreshortens
 * correctly — that's what makes perspective read as depth rather than a flat stretch.
 *
 * `squareToQuad` / `applyHomography` are pure (no DOM) so the math is unit-tested;
 * `drawQuadWarp` does the canvas drawing.
 */

export interface Pt { x: number; y: number }
export type Quad = [Pt, Pt, Pt, Pt] // tl, tr, br, bl ← unit-square corners (0,0)(1,0)(1,1)(0,1)

/**
 * Homography mapping the unit square's corners (0,0),(1,0),(1,1),(0,1) onto `quad`
 * (tl, tr, br, bl). Returns a 3×3 as [a,b,c, d,e,f, g,h,i] (row-major) such that a
 * point (u,v) maps to ((a·u+b·v+c)/(g·u+h·v+i), (d·u+e·v+f)/(g·u+h·v+i)). Heckbert's
 * "Projective Mappings for Image Warping" closed form. Falls back to affine when the
 * quad is a parallelogram (no projective component).
 */
export function squareToQuad(quad: Quad): number[] {
  const [p0, p1, p2, p3] = quad
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, sx = p0.x - p1.x + p2.x - p3.x
  const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, sy = p0.y - p1.y + p2.y - p3.y
  let a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
    // Affine (parallelogram) — no perspective term.
    a = p1.x - p0.x; b = p3.x - p0.x; c = p0.x
    d = p1.y - p0.y; e = p3.y - p0.y; f = p0.y
    g = 0; h = 0
  } else {
    const denom = dx1 * dy2 - dx2 * dy1 || 1e-12
    g = (sx * dy2 - dx2 * sy) / denom
    h = (dx1 * sy - sx * dy1) / denom
    a = p1.x - p0.x + g * p1.x
    b = p3.x - p0.x + h * p3.x
    c = p0.x
    d = p1.y - p0.y + g * p1.y
    e = p3.y - p0.y + h * p3.y
    f = p0.y
  }
  return [a, b, c, d, e, f, g, h, 1]
}

/** Map a unit-square point (u,v) through the homography → a destination point. */
export function applyHomography(m: number[], u: number, v: number): Pt {
  const x = m[0]! * u + m[1]! * v + m[2]!
  const y = m[3]! * u + m[4]! * v + m[5]!
  const w = m[6]! * u + m[7]! * v + m[8]!
  const iw = Math.abs(w) < 1e-12 ? 0 : 1 / w
  return { x: x * iw, y: y * iw }
}

/** Texture-map one source triangle (uv, in src px) onto a dest triangle (xy) via an
 *  affine transform clipped to the dest triangle. Standard canvas texture-tri. */
function drawTri(
  ctx: CanvasRenderingContext2D, src: CanvasImageSource,
  x0: number, y0: number, x1: number, y1: number, x2: number, y2: number,
  u0: number, v0: number, u1: number, v1: number, u2: number, v2: number,
): void {
  // Inflate the CLIP triangle ~0.6px outward from its centroid so adjacent cells
  // overlap — hides the anti-aliased seams between triangles. The affine solve
  // still uses the original (un-inflated) correspondences, so geometry is exact.
  const gx = (x0 + x1 + x2) / 3, gy = (y0 + y1 + y2) / 3
  const push = (x: number, y: number): [number, number] => {
    const dx = x - gx, dy = y - gy, d = Math.hypot(dx, dy) || 1
    return [x + (dx / d) * 0.6, y + (dy / d) * 0.6]
  }
  const [cx0, cy0] = push(x0, y0), [cx1, cy1] = push(x1, y1), [cx2, cy2] = push(x2, y2)
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(cx0, cy0); ctx.lineTo(cx1, cy1); ctx.lineTo(cx2, cy2); ctx.closePath()
  ctx.clip()
  u1 -= u0; u2 -= u0; v1 -= v0; v2 -= v0; x1 -= x0; x2 -= x0; y1 -= y0; y2 -= y0
  const det = u1 * v2 - u2 * v1
  if (det) {
    const a = (v2 * x1 - v1 * x2) / det
    const b = (v2 * y1 - v1 * y2) / det
    const c = (u1 * x2 - u2 * x1) / det
    const d = (u1 * y2 - u2 * y1) / det
    ctx.transform(a, b, c, d, x0 - a * u0 - c * v0, y0 - b * u0 - d * v0)
    ctx.drawImage(src, 0, 0)
  }
  ctx.restore()
}

/**
 * Draw `src` (a fully-rendered layer-content canvas) onto `ctx`, warped so its rect
 * maps to `quad` (in ctx coordinates), via an N×N subdivided projective grid.
 */
export function drawQuadWarp(
  ctx: CanvasRenderingContext2D,
  src: HTMLCanvasElement,
  quad: Quad,
  subdiv = 16,
): void {
  const sw = src.width, sh = src.height
  if (!(sw > 0 && sh > 0)) return
  const m = squareToQuad(quad)
  const N = Math.max(1, Math.round(subdiv))
  // Destination grid (projective image of a uniform unit-square grid).
  const dst: Pt[][] = []
  for (let j = 0; j <= N; j++) {
    const row: Pt[] = []
    for (let i = 0; i <= N; i++) row.push(applyHomography(m, i / N, j / N))
    dst.push(row)
  }
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const su0 = (i / N) * sw, sv0 = (j / N) * sh, su1 = ((i + 1) / N) * sw, sv1 = ((j + 1) / N) * sh
      const a = dst[j]![i]!, b = dst[j]![i + 1]!, c = dst[j + 1]![i + 1]!, d = dst[j + 1]![i]!
      drawTri(ctx, src, a.x, a.y, b.x, b.y, c.x, c.y, su0, sv0, su1, sv0, su1, sv1)
      drawTri(ctx, src, a.x, a.y, c.x, c.y, d.x, d.y, su0, sv0, su1, sv1, su0, sv1)
    }
  }
}
