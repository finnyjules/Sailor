/**
 * Frame Morph transition — the pure pieces of drawing one frame of a morph (spec
 * 2026-09-23). The compositor-coupled part (`resolveMorphs`) lives in useCompositorLayers.ts.
 */
import type { Paint } from '~/lib/compositor/paint'
import { mixHex } from '~/lib/color/mix'
import { ringsFromD, ringsToD, type MorphFrame } from '~/lib/vector/morphPieces'
import type { P } from '~/lib/vector/medial'
import type { TextCell } from '~/lib/motionx/text/units'

// `mixHex` reads all three through `parseHexA` (8-digit keeps its alpha; 3-digit expands).
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i

export function morphFillOf(layer: { kind: string; fill?: Paint; color?: Paint }): Paint | undefined {
  return layer.kind === 'text' ? layer.color : layer.fill
}

/** Solid ↔ solid blends (exact at the ends); anything else switches at the midpoint. */
export function blendMorphPaint(a: Paint | undefined, b: Paint | undefined, t: number): Paint {
  if (typeof a === 'string' && typeof b === 'string' && HEX.test(a) && HEX.test(b)) return mixHex(a, b, t)
  return (t < 0.5 ? a : b) ?? ''
}

export function ringsBBoxOfD(d: string): { w: number; h: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const r of ringsFromD(d)) for (const p of r) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]) }
  return Number.isFinite(x0) ? { w: x1 - x0, h: y1 - y0 } : { w: 0, h: 0 }
}

export interface MorphPlacement { x: number; y: number; rotation?: number; skewX?: number; skewY?: number }

/**
 * A's placement → B's at `t`: x/y/skews linear (missing skew = 0), rotation along the SHORTEST
 * turn (difference normalised into (−180, 180]). Exact at the ends: t ≤ 0 is A's, t ≥ 1 B's.
 */
export function lerpPlacement(a: MorphPlacement, b: MorphPlacement, t: number): Required<MorphPlacement> {
  const ra = a.rotation ?? 0, rb = b.rotation ?? 0
  if (t <= 0) return { x: a.x, y: a.y, rotation: ra, skewX: a.skewX ?? 0, skewY: a.skewY ?? 0 }
  if (t >= 1) return { x: b.x, y: b.y, rotation: rb, skewX: b.skewX ?? 0, skewY: b.skewY ?? 0 }
  let dr = (((rb - ra) % 360) + 540) % 360 - 180
  if (dr === -180) dr = 180
  const lin = (p: number, q: number) => p + (q - p) * t
  return {
    x: lin(a.x, b.x), y: lin(a.y, b.y), rotation: ra + dr * t,
    skewX: lin(a.skewX ?? 0, b.skewX ?? 0), skewY: lin(a.skewY ?? 0, b.skewY ?? 0),
  }
}

/**
 * The extra stroke width, in px, Chromium adds when it draws a face at a weight the face
 * does not ship (it synthesises bold). A morph draws the face's REAL outline, so without
 * this a Boldonse at weight 800 (the file is 400) lost ~12% of its ink at the end of the bar
 * and visibly jumped (2026-09-24). Skia's rule: stroke by fontPx × 1/24 at ≤ 9 px, 1/32 at
 * ≥ 36 px, linear between — measured live at 0.00% ink error at 141 px. Synthesis happens
 * when 600+ is asked of a face under 600 that has no weight axis to draw it with.
 */
export function syntheticBoldPx(
  requestedWeight: number,
  font: { axes?: readonly { tag: string }[]; raw?: unknown } | null,
  fontPx: number,
): number {
  if (!font || !(requestedWeight >= 600) || !(fontPx > 0)) return 0
  if (font.axes?.some(a => a.tag === 'wght')) return 0
  const face = Number((font.raw as { 'OS/2'?: { usWeightClass?: number } } | undefined)?.['OS/2']?.usWeightClass) || 400
  if (face >= 600) return 0
  const ratio = fontPx <= 9 ? 1 / 24 : fontPx >= 36 ? 1 / 32 : 1 / 24 + ((fontPx - 9) / 27) * (1 / 32 - 1 / 24)
  return fontPx * ratio
}

/** The part of a letter behaviour's per-glyph draw a morphing piece can take: where the glyph
 *  sits, its turn, its size and its opacity (a Decode's substitute character, a Slot's reel and a
 *  mask's clip have no meaning on a shape between two fonts, so they are not carried). */
export interface LetterPose { x: number; y: number; rotation: number; scale: number; opacity: number }

/**
 * Letter behaviours riding a morph (USER 09-24: a Cascade in under a Morph into was invisible —
 * the morph draws a shape, and letter behaviours only moved real text). Every ring of the morph
 * frame belongs to the A letter at its anchor (the nearest cell); it takes that letter's pose:
 * `p' = pose + R(pose.rotation) · scale · R(−cell.angle) · (p − cell)`, which is the identity for
 * a letter at rest. Rings are grouped by opacity; a letter at opacity 0 (not started, "hide
 * before it starts") is left out. Coordinates are A's own local px, the same the cells use.
 */
export function rideLetterMotion(frame: MorphFrame, cells: TextCell[], poses: LetterPose[]): { d: string; opacity: number }[] {
  if (!cells.length) return [{ d: ringsToD(frame.rings), opacity: 1 }]
  const groups = new Map<number, P[][]>()
  frame.rings.forEach((ring, i) => {
    const a = frame.anchors[i]!
    let best = 0, bd = Infinity
    cells.forEach((c, k) => { const d = (c.x - a[0]) ** 2 + (c.y - a[1]) ** 2; if (d < bd) { bd = d; best = k } })
    const c = cells[best]!, pose = poses[best]
    if (!pose) return
    const op = Math.round(Math.max(0, Math.min(1, pose.opacity)) * 1000) / 1000
    if (!(op > 0) || ![pose.x, pose.y, pose.rotation, pose.scale].every(Number.isFinite)) return
    const back = -c.angle, turn = pose.rotation
    const cb = Math.cos(back), sb = Math.sin(back), ct = Math.cos(turn), st = Math.sin(turn)
    const moved = ring.map(([px, py]) => {
      const dx = px - c.x, dy = py - c.y
      const lx = (dx * cb - dy * sb) * pose.scale, ly = (dx * sb + dy * cb) * pose.scale
      return [pose.x + lx * ct - ly * st, pose.y + lx * st + ly * ct] as P
    })
    const g = groups.get(op); if (g) g.push(moved); else groups.set(op, [moved])
  })
  return [...groups].map(([opacity, rings]) => ({ d: ringsToD(rings), opacity }))
}
