/**
 * When the canvas may pay for real backdrop blur, and which nodes would show it.
 *
 * The glass LOOK never depends on blur: tint, border and shadow carry it, and a blur of
 * the flat canvas behind a node is the same flat colour. So blur only earns its cost where
 * something is actually behind a node — another node, or a wire — and only while nothing
 * is moving. Everything here is pure so it can be tested without a canvas.
 *
 * 'never' is the exit route: if the benchmark says blur costs frames, the canvas runs
 * 'never' and nothing else in the design changes.
 *
 * 'always' (the shipped decision, 2026-09-27): blur every glass shell, always — while
 * panning, zooming or dragging, whatever is behind it — with one exception: below
 * GLASS_LIMITS.minZoom the glass is too small to read, so it turns off, decided at rest
 * like everything else here. No crowding limit and no "something behind" rule apply to
 * 'always'; 'smart' keeps both, for the dev benchmark to compare against.
 */
export const GLASS_LIMITS = { minZoom: 0.5, maxVisibleNodes: 24 }

export type GlassMode = 'smart' | 'always' | 'never'

export function blurAllowed(s: { mode: GlassMode; moving: boolean; zoom: number; visibleNodes: number }): boolean {
  if (s.mode === 'never') return false
  if (s.mode === 'always') return s.zoom >= GLASS_LIMITS.minZoom
  if (s.moving) return false
  if (s.zoom < GLASS_LIMITS.minZoom) return false
  if (s.visibleNodes > GLASS_LIMITS.maxVisibleNodes) return false
  return true
}

export interface NodeBox { id: string; x: number; y: number; w: number; h: number }
export interface Wire { source: string; target: string; sx: number; sy: number; tx: number; ty: number }

/**
 * Points along a wire, using the same control points as Vue Flow's bezier edge
 * (horizontal handles, offset by half the horizontal distance, at least 25px).
 * An approximation is fine: it only decides whether a node MIGHT show a wire through it.
 */
export function sampleWire(w: Wire, n = 16): Array<{ x: number; y: number }> {
  const off = Math.max(25, Math.abs(w.tx - w.sx) * 0.5)
  const c1x = w.sx + off, c1y = w.sy, c2x = w.tx - off, c2y = w.ty
  const pts: Array<{ x: number; y: number }> = []
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t
    pts.push({
      x: u * u * u * w.sx + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * w.tx,
      y: u * u * u * w.sy + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * w.ty,
    })
  }
  return pts
}

/** Strictly inside, so a port sitting on the edge never counts. */
function inside(p: { x: number; y: number }, b: NodeBox, inset = 2): boolean {
  return p.x > b.x + inset && p.x < b.x + b.w - inset && p.y > b.y + inset && p.y < b.y + b.h - inset
}

function overlaps(a: NodeBox, b: NodeBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

export function nodesWithSomethingBehind(nodes: NodeBox[], wires: Wire[]): Set<string> {
  const out = new Set<string>()
  // Overlap: sort by x and sweep, so a big canvas is not n² in the common case.
  const byX = [...nodes].sort((a, b) => a.x - b.x)
  for (let i = 0; i < byX.length; i++) {
    const a = byX[i]!
    for (let j = i + 1; j < byX.length && byX[j]!.x < a.x + a.w; j++) {
      const b = byX[j]!
      if (overlaps(a, b)) { out.add(a.id); out.add(b.id) }
    }
  }
  for (const w of wires) {
    const pts = sampleWire(w)
    for (const n of nodes) {
      if (out.has(n.id) || n.id === w.source || n.id === w.target) continue
      if (pts.some(p => inside(p, n))) out.add(n.id)
    }
  }
  return out
}

export function countVisible(nodes: NodeBox[], view: { x: number; y: number; zoom: number; width: number; height: number }): number {
  let count = 0
  for (const n of nodes) {
    const left = n.x * view.zoom + view.x, top = n.y * view.zoom + view.y
    const right = left + n.w * view.zoom, bottom = top + n.h * view.zoom
    if (right > 0 && bottom > 0 && left < view.width && top < view.height) count++
  }
  return count
}
