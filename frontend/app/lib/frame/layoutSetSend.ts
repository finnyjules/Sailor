/**
 * Make a set (Stage 5, Task 4): send one format of the set to the canvas as a new, independent
 * Frame node. Pure: the canvas (`VueNodeCanvas`, `sailor:frameSendToCanvas`) owns the graph and
 * calls these; nothing here touches Vue, the DOM or the source node.
 *
 *   - `sentFrameData`: the new node's `data` — a deep copy of the source's (as ⌘D copies a node),
 *     sized to the format through `applyFramePreset` (the Size menu's own write, so the preset is
 *     stored and `formatFor` finds this format even where two share a size), with the entry's
 *     layers, groups and stack order (what an apply at that size commits) and the plan's layout
 *     remembered in `sailor_posterState`, so its Layout tab opens on that layout.
 *   - `sentFrameEdges`: the source's incoming edges, re-targeted at the new node — each wired image
 *     slot keeps its wire (same source, same handles), as copy/paste copies an edge.
 *   - `placeRightOf`: where the new card goes — right of the source, stepping past every card
 *     already there, so repeated sends line up further right and never overlap.
 */
import type { SetEntry } from './patterns/kit/set'
import { applyFramePreset, readFrameSize } from './frameSize'
import { layoutById } from './patterns/layouts/catalog'
import { newFrameLayoutGrid } from './newFrameGrid'

/** A Frame's display name, as the modal and the canvas name it. */
export function frameDisplayName(data: { title?: unknown; subgraphName?: unknown } | null | undefined): string {
  return String(data?.title || data?.subgraphName || 'Frame')
}

/** The new Frame's name: `<source name> · <format label>`. */
export function sentFrameName(source: { title?: unknown; subgraphName?: unknown } | null | undefined, entry: Pick<SetEntry, 'label'>): string {
  return `${frameDisplayName(source)} · ${entry.label}`
}

/** The toast after a send: the new Frame's own name, quoted. */
export function sentFrameToast(source: { title?: unknown; subgraphName?: unknown } | null | undefined, entry: Pick<SetEntry, 'label'>): string {
  return `Added “${sentFrameName(source, entry)}” to the canvas.`
}

/** The toast when a send could not be made (`sentFrameData` gave nothing). */
export function sendFailedToast(entry: Pick<SetEntry, 'label'>): string {
  return `Couldn't send ${entry.label} to the canvas.`
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) // JSON: the editor hands Vue proxies

/** The new node's `data`, or null when the entry has nothing to send (nothing fits) or the source
 *  has no size widgets. The source is never written. */
export function sentFrameData(source: Record<string, any>, entry: SetEntry): Record<string, any> | null {
  if (!entry.plan || !entry.layers) return null
  const data = clone(source ?? {}) as Record<string, any>
  if (!applyFramePreset(data, entry.formatId)) return null
  const size = readFrameSize(data)
  if (size.w !== entry.w || size.h !== entry.h) return null
  const p = (data.properties ||= {}) as Record<string, any>
  p.sailor_localLayers = clone(entry.layers)
  // A new Frame at a new size: the suggested auto grid for THIS size (a user grid's px were set
  // for the source's size), keeping whether the source showed it.
  p.sailor_layoutGrid = newFrameLayoutGrid(data, { show: (p.sailor_layoutGrid as { show?: boolean } | undefined)?.show ?? true })
  if (entry.groups) p.sailor_localGroups = clone(entry.groups)
  p.sailor_stackOrder = [...entry.plan.order]
  // The source's picker state (shape, image, palette, tags) is kept: it is what the set planned
  // with. The layout, its variation, roles, style and placed lines are this plan's. The source's
  // set ticks (`sailor_layoutSet`, and the older `sailor_posterState.set`) and list position
  // (`index`, a place in another size's list) are not carried.
  delete p.sailor_layoutSet
  const { set: _set, index: _index, placed: _placed, ...keep } = (p.sailor_posterState ?? {}) as Record<string, any>
  const ps = entry.plan.posterState
  const def = layoutById(ps.patternId)
  p.sailor_posterState = {
    ...keep,
    patternId: ps.patternId,
    seed: ps.seed,
    choice: clone(entry.choice ?? ps.choice),
    roles: clone(ps.roles ?? {}),
    style: def?.style ?? 'swiss',
    ...(ps.placed ? { placed: [...ps.placed] } : {}),
  }
  // The source's baked picture is of the source's layout: the new Frame starts unbaked.
  delete p.sailor_renderKey
  delete data.images
  delete data.running
  data.title = sentFrameName(source, entry)
  return data
}

interface EdgeLike { id?: string; source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null; type?: string; data?: unknown }

/** The source's incoming edges (its wired slots), copied onto `newId`. */
export function sentFrameEdges(sourceId: string, newId: string, edges: readonly EdgeLike[]): EdgeLike[] {
  return edges
    .filter(e => String(e.target) === String(sourceId))
    .map(e => ({
      id: `e-set-${e.source}-${newId}-${e.sourceHandle || ''}-${e.targetHandle || ''}`,
      source: e.source,
      ...(e.sourceHandle != null ? { sourceHandle: e.sourceHandle } : {}),
      target: newId,
      ...(e.targetHandle != null ? { targetHandle: e.targetHandle } : {}),
      type: e.type || 'comfy',
      ...(e.data !== undefined ? { data: clone(e.data) } : {}),
    }))
}

interface NodeLike { id: string; position?: { x: number; y: number }; dimensions?: { width?: number; height?: number }; data?: any; hidden?: boolean }

const GAP = 40

/** A node's box on the canvas: measured, else its stored size, else a card's default. */
function boxOf(n: NodeLike): { x: number; y: number; w: number; h: number } {
  return {
    x: n.position?.x ?? 0, y: n.position?.y ?? 0,
    w: n.dimensions?.width || n.data?.size?.[0] || 240,
    h: n.dimensions?.height || n.data?.size?.[1] || 240,
  }
}

/** The Frame card's size for a `w`×`h` Frame (`ArtifactFrameNode`: the longest side is the card's
 *  `displayEdge`, 308 by default), plus the print's own glass (6px each side) and its name row
 *  (26px) above the glass. */
export function frameCardSize(displayEdge: unknown, w: number, h: number): { w: number; h: number } {
  const E = Number(displayEdge) || 308
  const a = w > 0 && h > 0 ? w / h : 1
  const box = a >= 1 ? { w: E, h: Math.round(E / a) } : { w: Math.round(E * a), h: E }
  return { w: box.w + 12, h: box.h + 12 + 26 }
}

/** Where a new card of `size` goes: level with `source`, right of it, and right of any card that
 *  would overlap it there — so each further send steps further right. */
export function placeRightOf(source: NodeLike, nodes: readonly NodeLike[], size: { w: number; h: number }): { x: number; y: number } {
  const s = boxOf(source)
  const y = s.y
  let x = s.x + s.w + GAP
  const others = nodes.filter(n => n.id !== source.id && !n.hidden).map(boxOf)
  for (let guard = 0; guard < 1000; guard++) {
    const hit = others.filter(o => o.x < x + size.w + GAP && x < o.x + o.w + GAP && o.y < y + size.h && y < o.y + o.h)
    if (!hit.length) break
    x = Math.max(...hit.map(o => o.x + o.w)) + GAP
  }
  return { x, y }
}
