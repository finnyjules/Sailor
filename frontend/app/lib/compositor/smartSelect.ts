/**
 * Smart select — pure geometry and mask math (no DOM, unit-tested in node).
 *
 * The Compositor's smart-select mode scribbles in ARTBOARD px, but SAM-2 runs
 * on the target layer's own pixels (capped by capDims). Everything that maps
 * between those two spaces, or crunches raw RGBA arrays, lives here; canvas
 * plumbing stays in CompositorModal.vue.
 *
 * The affine convention matches runRegionFill's inline math (artboard→image):
 *   xi = a*xa + c*ya + e ;  yi = b*xa + d*ya + f
 * with the layer model's transforms: x,y as fractions of artboard W/H, and
 * w,h both normalized to artboard WIDTH.
 */

export interface Pt { x: number; y: number }
export interface SamPoint { x: number; y: number; label: 0 | 1 }
export interface Affine { a: number; b: number; c: number; d: number; e: number; f: number }

export interface LayerBox { x: number; y: number; w: number; h: number; rotation?: number }
export interface BBox { minX: number; minY: number; maxX: number; maxY: number }

/** Even arc-length resample of a stroke polyline into ≤ max prompt points.
 *  Sampling at (i+0.5)/max fractions avoids the exact endpoints (which often
 *  overshoot the object); minDist collapses tiny scribbles to fewer points. */
export function samplePointsFromStroke(stroke: Pt[], opts: { max?: number; minDist?: number } = {}): Pt[] {
  const max = opts.max ?? 8
  const minDist = opts.minDist ?? 6
  if (stroke.length === 0) return []
  if (stroke.length === 1) return [{ ...stroke[0]! }]

  const cum: number[] = [0]
  for (let i = 1; i < stroke.length; i++) {
    const dx = stroke[i]!.x - stroke[i - 1]!.x, dy = stroke[i]!.y - stroke[i - 1]!.y
    cum.push(cum[i - 1]! + Math.hypot(dx, dy))
  }
  const total = cum[cum.length - 1]!
  if (total === 0) return [{ ...stroke[0]! }]

  const at = (dist: number): Pt => {
    let i = 1
    while (i < cum.length - 1 && cum[i]! < dist) i++
    const seg = cum[i]! - cum[i - 1]!
    const t = seg > 0 ? (dist - cum[i - 1]!) / seg : 0
    return {
      x: stroke[i - 1]!.x + (stroke[i]!.x - stroke[i - 1]!.x) * t,
      y: stroke[i - 1]!.y + (stroke[i]!.y - stroke[i - 1]!.y) * t,
    }
  }

  const out: Pt[] = []
  for (let i = 0; i < max; i++) {
    const p = at(((i + 0.5) / max) * total)
    const prev = out[out.length - 1]
    if (prev && Math.hypot(p.x - prev.x, p.y - prev.y) < minDist) continue
    out.push(p)
  }
  return out.length ? out : [at(total / 2)]
}

/** Artboard px → image px, mirroring runRegionFill's inline affine. */
export function layerAffine(layer: LayerBox, W: number, H: number, capW: number, capH: number): Affine {
  const cx = layer.x * W, cy = layer.y * H
  const bw = (layer.w || 0.0001) * W, bh = (layer.h || 0.0001) * W
  const th = ((layer.rotation || 0) * Math.PI) / 180
  const cos = Math.cos(th), sin = Math.sin(th)
  const a = (capW * cos) / bw, c = (capW * sin) / bw
  const b = (-capH * sin) / bh, d = (capH * cos) / bh
  const e = capW / 2 - a * cx - c * cy
  const f = capH / 2 - b * cx - d * cy
  return { a, b, c, d, e, f }
}

export function applyAffine(m: Affine, p: Pt): Pt {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f }
}

export function invertAffine(m: Affine): Affine {
  const det = m.a * m.d - m.b * m.c
  const a = m.d / det, b = -m.b / det, c = -m.c / det, d = m.a / det
  return { a, b, c, d, e: -(a * m.e + c * m.f), f: -(b * m.e + d * m.f) }
}

/** SAM returns an OPAQUE white-on-black mask; the compositor composites masks
 *  by ALPHA. Convert in place: alpha ← luminance, RGB ← white. */
export function luminanceToAlpha(data: Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) {
    const lum = 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!
    const a = data[i + 3]! / 255
    data[i] = 255; data[i + 1] = 255; data[i + 2] = 255
    data[i + 3] = Math.round(lum * a)
  }
}

/** Tight bbox of pixels with alpha > thresh (same convention as genMaskBounds). */
export function alphaBounds(data: Uint8ClampedArray, w: number, h: number, thresh = 20): BBox | null {
  let minX = w, minY = h, maxX = -1, maxY = -1
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (data[(y * w + x) * 4 + 3]! > thresh) {
      if (x < minX) minX = x; if (x > maxX) maxX = x
      if (y < minY) minY = y; if (y > maxY) maxY = y
    }
  }
  return maxX < minX ? null : { minX, minY, maxX, maxY }
}

export interface MaskCandidate { data: Uint8ClampedArray; w: number; h: number }

/** Assign each foreground point to the SMALLEST segment that contains it
 *  (segment-everything returns background/object/part segments — smallest
 *  containing = most specific), union the winners, and subtract the segments
 *  claimed the same way by background (label-0) points. Segments covering
 *  more than maxWhiteFrac of the image (default 0.5) are never assignable —
 *  that excludes background sheets, so a stray point off the object is simply
 *  ignored rather than selecting the whole background. Points are in the
 *  space of the image SENT to SAM; candidates may differ in resolution, so
 *  containment samples at the point's fractional position. Returns the sorted
 *  candidate indices to UNION, empty if nothing qualifies. */
export function pickSamSegments(
  candidates: MaskCandidate[],
  fgPoints: Pt[],
  bgPoints: Pt[],
  imgW: number,
  imgH: number,
  opts: { maxWhiteFrac?: number } = {},
): number[] {
  const maxWhiteFrac = opts.maxWhiteFrac ?? 0.5

  const whiteFracs: number[] = []
  const isWhiteByCand: Uint8Array[] = []
  for (let i = 0; i < candidates.length; i++) {
    const { data, w, h } = candidates[i]!
    const total = w * h
    const isWhite = new Uint8Array(total)
    let whiteCount = 0
    for (let p = 0; p < total; p++) {
      const o = p * 4
      const lum = 0.2126 * data[o]! + 0.7152 * data[o + 1]! + 0.0722 * data[o + 2]!
      const a = data[o + 3]! / 255
      if (lum * a > 127) { isWhite[p] = 1; whiteCount++ }
    }
    whiteFracs.push(total > 0 ? whiteCount / total : 0)
    isWhiteByCand.push(isWhite)
  }

  const hits = (pt: Pt, i: number): boolean => {
    const { w, h } = candidates[i]!
    let px = Math.round((pt.x / imgW) * w)
    let py = Math.round((pt.y / imgH) * h)
    if (px < 0) px = 0; if (px >= w) px = w - 1
    if (py < 0) py = 0; if (py >= h) py = h - 1
    return isWhiteByCand[i]![py * w + px] === 1
  }

  // Smallest qualifying (whiteFrac ≤ max) candidate that contains the point;
  // lower index wins ties (strict-less comparison, scanned in index order).
  const smallestFor = (pt: Pt): number => {
    let best = -1
    let bestFrac = Infinity
    for (let i = 0; i < candidates.length; i++) {
      if (whiteFracs[i]! > maxWhiteFrac) continue
      if (!hits(pt, i)) continue
      if (whiteFracs[i]! < bestFrac) { bestFrac = whiteFracs[i]!; best = i }
    }
    return best
  }

  const winners = new Set<number>()
  for (const pt of fgPoints) {
    const idx = smallestFor(pt)
    if (idx >= 0) winners.add(idx)
  }
  for (const pt of bgPoints) {
    const idx = smallestFor(pt)
    if (idx >= 0) winners.delete(idx)
  }
  return Array.from(winners).sort((a, b) => a - b)
}

/** Union the selected SAM candidate masks into ONE white-on-OPAQUE-black RGBA
 *  buffer sized (w,h) — the format the Inpaint modal's mask consumers expect
 *  (rebuildSilhouette reads max(RGB)→alpha; FLUX Fill reads white = fill).
 *  Candidates may be at any resolution; each is nearest-neighbour sampled to
 *  (w,h). A pixel is white if ANY selected candidate is white there
 *  (luminance*alpha > 127). An empty selection yields an all-black opaque mask. */
export function unionSelectedMasks(
  candidates: MaskCandidate[], idxs: number[], w: number, h: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4)
  for (let p = 0; p < w * h; p++) out[p * 4 + 3] = 255   // opaque black backdrop
  for (const idx of idxs) {
    const c = candidates[idx]
    if (!c) continue
    for (let y = 0; y < h; y++) {
      const sy = Math.min(c.h - 1, Math.floor((y / h) * c.h))
      for (let x = 0; x < w; x++) {
        const sx = Math.min(c.w - 1, Math.floor((x / w) * c.w))
        const so = (sy * c.w + sx) * 4
        const lum = 0.2126 * c.data[so]! + 0.7152 * c.data[so + 1]! + 0.0722 * c.data[so + 2]!
        const a = c.data[so + 3]! / 255
        if (lum * a > 127) {
          const o = (y * w + x) * 4
          out[o] = 255; out[o + 1] = 255; out[o + 2] = 255
        }
      }
    }
  }
  return out
}

/** Single-click select: choose the smallest segment containing `point`
 *  (segment-everything SAM returns background/object/part candidates) and return
 *  a white-on-opaque-black mask buffer sized (imgW,imgH), or null if no segment
 *  qualifies (caller falls back to manual brushing). This is the single-point
 *  restriction of the Compositor smart-select flow (pickSamSegments + union) —
 *  the Inpaint modal's click-to-select consumes it. `point` is in the (imgW,imgH)
 *  pixel space, i.e. the space of the image sent to SAM. */
export function pickClickMask(
  candidates: MaskCandidate[], point: Pt, imgW: number, imgH: number,
): Uint8ClampedArray | null {
  const idxs = pickSamSegments(candidates, [point], [], imgW, imgH)
  if (!idxs.length) return null
  return unionSelectedMasks(candidates, idxs, imgW, imgH)
}

/** Layer-model transform for a crop of the source image: where an image-space
 *  bbox lands on the artboard when extracted as its own layer. Keeps the
 *  source rotation; w/h follow the layer convention (width-normalized). */
export function cutoutPlacement(
  bbox: BBox, layer: LayerBox, capW: number, capH: number, W: number, H: number,
): { x: number; y: number; w: number; h: number; rotation: number } {
  const inv = invertAffine(layerAffine(layer, W, H, capW, capH))
  const center = applyAffine(inv, { x: (bbox.minX + bbox.maxX + 1) / 2, y: (bbox.minY + bbox.maxY + 1) / 2 })
  const cropW = bbox.maxX - bbox.minX + 1, cropH = bbox.maxY - bbox.minY + 1
  return {
    x: center.x / W,
    y: center.y / H,
    w: cropW * (layer.w || 0.0001) / capW,
    h: cropH * (layer.h || 0.0001) / capH,
    rotation: layer.rotation || 0,
  }
}

export interface WiredXform { x: number; y: number; scale: number; rotation: number }

/** Artboard px → a wired image's CAPPED pixel space, matching drawWiredImageLayer's
 *  fit-contain → translate → rotate → scale chain (useCompositorLayers.ts). The
 *  native image (iw×ih) fills a fitW×fitH box; we map that box onto capW×capH. */
export function wiredImageAffine(
  layer: WiredXform, W: number, H: number, iw: number, ih: number, capW: number, capH: number,
): Affine {
  const cAspect = W / H, iAspect = iw / (ih || 1)
  let fitW: number, fitH: number
  if (iAspect > cAspect) { fitW = W; fitH = W / iAspect } else { fitH = H; fitW = H * iAspect }
  // Compose forward (image-cap px → artboard px), then invert.
  // image-cap (0..capW,0..capH) → box (−fitW/2..fitW/2): bx = (cxp/capW − 0.5)·fitW
  // → scale · rotate · translate(center).
  const th = (layer.rotation * Math.PI) / 180
  const cos = Math.cos(th), sin = Math.sin(th)
  const s = layer.scale || 1e-6
  const cx = W / 2 + layer.x * W, cy = H / 2 + layer.y * H
  // Forward matrix F (cap px → artboard px):
  //   v = box(cap);  box_x = (capx/capW − .5)·fitW,  box_y = (capy/capH − .5)·fitH
  //   then p = center + s·R·box
  // a·capx + c·capy + e  with box linear in cap → fold constants.
  const kx = fitW / capW, ky = fitH / capH
  // box = [kx·capx − fitW/2, ky·capy − fitH/2]
  // R·box scaled by s, plus center:
  const Fa = s * cos * kx,  Fc = -s * sin * ky
  const Fb = s * sin * kx,  Fd = s * cos * ky
  const boxOffX = -fitW / 2, boxOffY = -fitH / 2
  const Fe = cx + s * (cos * boxOffX - sin * boxOffY)
  const Ff = cy + s * (sin * boxOffX + cos * boxOffY)
  return invertAffine({ a: Fa, b: Fb, c: Fc, d: Fd, e: Fe, f: Ff })
}

/** wiredCutoutPlacement's counterpart to cutoutPlacement: where an image-space
 *  bbox (in the wired image's capped px) lands on the artboard when extracted
 *  as its own local layer. Mirrors cutoutPlacement's math via wiredImageAffine's
 *  inverse instead of layerAffine's — center comes straight from the inverse
 *  affine (cap px → artboard px), and size follows the same fit-contain box
 *  (fitW×fitH, scaled by the wired layer's `scale`) that wiredImageAffine used
 *  to build the forward mapping. Keeps the source rotation. */
export function wiredCutoutPlacement(
  bbox: BBox, layer: WiredXform, iw: number, ih: number, capW: number, capH: number, W: number, H: number,
): { x: number; y: number; w: number; h: number; rotation: number } {
  const inv = invertAffine(wiredImageAffine(layer, W, H, iw, ih, capW, capH))
  const center = applyAffine(inv, { x: (bbox.minX + bbox.maxX + 1) / 2, y: (bbox.minY + bbox.maxY + 1) / 2 })
  const cropW = bbox.maxX - bbox.minX + 1, cropH = bbox.maxY - bbox.minY + 1
  const cAspect = W / H, iAspect = iw / (ih || 1)
  let fitW: number, fitH: number
  if (iAspect > cAspect) { fitW = W; fitH = W / iAspect } else { fitH = H; fitW = H * iAspect }
  const s = layer.scale || 1e-6
  return {
    x: center.x / W,
    y: center.y / H,
    w: (cropW / capW) * fitW * s / W,
    h: (cropH / capH) * fitH * s / W,
    rotation: layer.rotation || 0,
  }
}
