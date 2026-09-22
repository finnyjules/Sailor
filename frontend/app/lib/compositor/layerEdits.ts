/**
 * Pure layer-edit operations for the Compositor / Frame editor — the Figma
 * interaction layer (nudge, duplicate, rotate-snap, snap-to-edge). All functions
 * are side-effect-free and return new arrays, so useLocalLayerEditor stays a thin
 * wiring layer and every behavior is unit-tested without Vue or canvas. Mirrors
 * the pure-lib pattern of layerGroups.ts.
 */
import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { LayerGroup } from '~/lib/compositor/layerGroups'

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/** Move every selected layer by a normalized delta (clamped like the drag path). */
export function nudgeLayers(layers: LocalLayer[], selectedIds: Set<string>, dx: number, dy: number): LocalLayer[] {
  if (!selectedIds.size || (dx === 0 && dy === 0)) return layers
  return layers.map(l => (selectedIds.has(l.id)
    ? ({ ...l, x: clamp(l.x + dx, -0.5, 1.5), y: clamp(l.y + dy, -0.5, 1.5) } as LocalLayer)
    : l))
}

/**
 * A `wired` layer is a live link to ONE graph slot, so it is never clonable —
 * see `duplicateLayers`. Shared with `layerClipboard` so both copy paths refuse
 * on the same rule.
 */
export function isClonableLayer(l: Pick<LocalLayer, 'kind'>): boolean {
  return l?.kind !== 'wired'
}

/** Duplicate the selected layers: fresh ids, offset, and a fresh group id per
 *  distinct source group (added as a registry root). Deep-clones layer data.
 *  mkId/mkGid are injected so callers control id minting (and tests stay
 *  deterministic). Nested-group parent links are NOT remapped (v1 flat copy).
 *
 *  `wired` members of the selection are SKIPPED, always. A wired layer's pixels
 *  arrive down one graph edge into one slot: a second layer on that slot would
 *  paint the same pixels twice, both copies would fight over the slot's
 *  `layer{N}_*` widgets (last write wins), and the server would still render a
 *  single image — so the copy would look right in the editor and wrong in the
 *  output. The honest copy is a SNAPSHOT, which needs the host's bake + upload;
 *  that half lives at the editor boundary (`duplicateSelection` →
 *  `materializeWired`). This function stays pure and just refuses. */
export function duplicateLayers(
  layers: LocalLayer[],
  groups: LayerGroup[],
  selectedIds: Set<string>,
  offset: number,
  mkId: () => string,
  mkGid: () => string,
): { layers: LocalLayer[]; groups: LayerGroup[]; newIds: string[]; idMap: Map<string, string> } {
  const sel = layers.filter(l => selectedIds.has(l.id) && isClonableLayer(l))
  if (!sel.length) return { layers, groups, newIds: [], idMap: new Map() }
  const groupMap = new Map<string, string>()
  const newIds: string[] = []
  const idMap = new Map<string, string>()
  const clones = sel.map((l) => {
    const c = JSON.parse(JSON.stringify(l)) as any
    c.id = mkId(); newIds.push(c.id)
    idMap.set(l.id, c.id)
    c.x = clamp(l.x + offset, -0.5, 1.5)
    c.y = clamp(l.y + offset, -0.5, 1.5)
    if (l.groupId) {
      if (!groupMap.has(l.groupId)) groupMap.set(l.groupId, mkGid())
      c.groupId = groupMap.get(l.groupId)
    }
    return c as LocalLayer
  })
  const newGroups: LayerGroup[] = [...groups, ...[...groupMap.values()].map(id => ({ id }))]
  return { layers: [...layers, ...clones], groups: newGroups, newIds, idMap }
}

/** Round an angle (degrees) to the nearest `step`; pass through when step falsy. */
export function snapAngle(deg: number, step: number | null): number {
  if (!step) return deg
  return Math.round(deg / step) * step
}

export interface SnapBox { cx: number; cy: number; hx: number; hy: number }

/** Snap a moving box's edges/center to target lines (other boxes' edges/centers
 *  plus canvas targets, default the two edges + center). Returns the adjustment
 *  and the guide line to draw per axis (null = no snap on that axis). */
export function computeSnapAdjust(
  prim: SnapBox,
  others: SnapBox[],
  thresholdX: number,
  thresholdY: number,
  canvasTargets: number[] = [0, 0.5, 1],
  gridX: number[] = [],
  gridY: number[] = [],
): { dx: number; dy: number; guideX: number | null; guideY: number | null } {
  const xt = [...canvasTargets]
  const yt = [...canvasTargets]
  for (const o of others) {
    xt.push(o.cx - o.hx, o.cx, o.cx + o.hx)
    yt.push(o.cy - o.hy, o.cy, o.cy + o.hy)
  }
  xt.push(...gridX)
  yt.push(...gridY)
  let bestX = { d: thresholdX, adj: 0, guide: null as number | null }
  for (const edge of [prim.cx - prim.hx, prim.cx, prim.cx + prim.hx]) for (const t of xt) {
    const dd = Math.abs(edge - t); if (dd < bestX.d) bestX = { d: dd, adj: t - edge, guide: t }
  }
  let bestY = { d: thresholdY, adj: 0, guide: null as number | null }
  for (const edge of [prim.cy - prim.hy, prim.cy, prim.cy + prim.hy]) for (const t of yt) {
    const dd = Math.abs(edge - t); if (dd < bestY.d) bestY = { d: dd, adj: t - edge, guide: t }
  }
  return { dx: bestX.adj, dy: bestY.adj, guideX: bestX.guide, guideY: bestY.guide }
}

export type EditAction =
  | { type: 'nudge'; dxPx: number; dyPx: number }
  | { type: 'duplicate' }
  | { type: 'copy' }
  | { type: 'paste'; inPlace: boolean }

/** Map a keyboard event to an edit action (arrows → nudge in logical px,
 *  cmd/ctrl+D → duplicate, cmd/ctrl+C → copy, cmd/ctrl+V (+Shift) → paste).
 *  Pure; the editor converts px → normalized. */
export function mapKeyToEdit(
  e: { key: string; shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean },
  pxSmall: number,
  pxLarge: number,
): EditAction | null {
  const px = e.shiftKey ? pxLarge : pxSmall
  switch (e.key) {
    case 'ArrowLeft': return { type: 'nudge', dxPx: -px, dyPx: 0 }
    case 'ArrowRight': return { type: 'nudge', dxPx: px, dyPx: 0 }
    case 'ArrowUp': return { type: 'nudge', dxPx: 0, dyPx: -px }
    case 'ArrowDown': return { type: 'nudge', dxPx: 0, dyPx: px }
  }
  const meta = e.metaKey || e.ctrlKey
  if (meta && (e.key === 'c' || e.key === 'C')) return { type: 'copy' }
  if (meta && (e.key === 'v' || e.key === 'V')) return { type: 'paste', inPlace: !!e.shiftKey }
  if (meta && (e.key === 'd' || e.key === 'D')) return { type: 'duplicate' }
  return null
}

/** HUD text for the active drag: scale → "W × H", rotate → "N°", move → "X, Y". */
export function dragHud(
  kind: 'move' | 'scale' | 'rotate' | null,
  info: { wPx: number; hPx: number; xPx: number; yPx: number; rotation: number },
): { text: string } | null {
  if (kind === 'scale') return { text: `${Math.round(info.wPx)} × ${Math.round(info.hPx)}` }
  if (kind === 'rotate') return { text: `${Math.round(info.rotation)}°` }
  if (kind === 'move') return { text: `${Math.round(info.xPx)}, ${Math.round(info.yPx)}` }
  return null
}
