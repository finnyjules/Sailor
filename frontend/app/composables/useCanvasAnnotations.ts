import type { Node } from '@vue-flow/core'

/**
 * Canvas annotations are FigJam-style overlays that live ON the canvas but
 * AREN'T part of the executable graph: sticky notes, checklists, pinned
 * images, pinned results, and narrative arrows.
 *
 * They serve as scaffolding around the graph — labeling intent, recording
 * experiments to try, attaching reference imagery — so the canvas can carry
 * the *story* of a workflow, not just its wiring.
 *
 * Persistence: stored under `workflow.extra.sailor.annotations`. The
 * `extra` field round-trips through ComfyUI untouched, so annotations
 * survive save / load without bridge changes.
 *
 * Optional attachment: an annotation may set `attachedToGroup: groupId`. The
 * canvas treats attached annotations as children of their group — they move
 * together, collapse together, delete together. This keeps annotations
 * meaningful (anchored to a part of the graph) instead of free-floating
 * stickers that go stale.
 */

// Discriminated union — `kind` drives both rendering and validation.
export type AnnotationKind = 'sticky' | 'checklist' | 'pin-image' | 'pin-result' | 'arrow'

// Shared positional fields. Arrows use endpoints instead of x/y/w/h and so
// don't carry them — the union below handles that.
interface PositionedAnnotation {
  id: string
  x: number
  y: number
  width: number
  height: number
  attachedToGroup?: string | null
}

export interface StickyAnnotation extends PositionedAnnotation {
  kind: 'sticky'
  text: string
  color: string         // hex; one of STICKY_COLORS
  rotation?: number     // small degrees, for personality
}

export interface ChecklistItem {
  id: string
  text: string
  done: boolean
}

export interface ChecklistAnnotation extends PositionedAnnotation {
  kind: 'checklist'
  title: string
  items: ChecklistItem[]
  color: string
}

export interface PinImageAnnotation extends PositionedAnnotation {
  kind: 'pin-image'
  src: string           // data URL or http(s) URL
  caption?: string
}

/**
 * A generation result pinned to the canvas. Distinct from pin-image so it
 * can carry metadata and a "rerun this" affordance later. `src` is the image
 * URL (Comfy's view endpoint); `metadata` is a free-form blob of whatever
 * was captured at pin time (seed, prompt snippet, model name, etc.).
 */
export interface PinResultAnnotation extends PositionedAnnotation {
  kind: 'pin-result'
  src: string
  metadata: {
    seed?: number | string
    prompt?: string
    model?: string
    cfg?: number
    steps?: number
    sourceNodeId?: string
    [key: string]: any
  }
  caption?: string
}

/**
 * An arrow connects two endpoints. Each endpoint is either a group, an
 * annotation, or a free point on the canvas. We resolve to coordinates at
 * render time so endpoints follow their referenced object.
 */
export type ArrowEndpoint =
  | { kind: 'group';      id: string }
  | { kind: 'annotation'; id: string }
  | { kind: 'point';      x: number; y: number }

export interface ArrowAnnotation {
  id: string
  kind: 'arrow'
  from: ArrowEndpoint
  to: ArrowEndpoint
  label?: string
  color?: string
  // Perpendicular offset of the curve midpoint, in graph-space pixels.
  // 0 = straight; positive = curve to the "right" of from→to direction,
  // negative = curve to the "left." Driven by the midpoint drag handle when
  // the arrow is selected.
  curveOffset?: number
  // Stroke width in graph-space pixels. Defaults to 2.5.
  thickness?: number
}

export type Annotation =
  | StickyAnnotation
  | ChecklistAnnotation
  | PinImageAnnotation
  | PinResultAnnotation
  | ArrowAnnotation

// Sticky paper: soft white by default, gallery-placard style on the dark
// canvas, plus two dark papers (graphite, ink). The FigJam-flavored colour
// palette (yellow/pink/blue/green/lavender/peach) was retired 2026-09-01 by
// owner call — colours read loud and messy for a creative tool. The picker
// shows whenever STICKY_COLORS has more than one entry.
export const STICKY_PAPER = '#f8f8f6'
export const STICKY_GRAPHITE = '#2a2a2d'
export const STICKY_INK = '#111113'
export const STICKY_COLORS: string[] = [STICKY_PAPER, STICKY_GRAPHITE, STICKY_INK]

/** True for papers dark enough that the note's text and chrome must go light. */
export function isDarkPaper(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return false
  const n = parseInt(m[1]!, 16)
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.45
}

type VueFlowNode = Node<Record<string, any>>

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

export interface AnnotationsBridge {
  load: (raw: unknown) => void
  export: () => unknown
}

export function useCanvasAnnotations(_nodesRef: Ref<VueFlowNode[]>) {
  const annotations = ref<Annotation[]>([])

  // ---- Queries --------------------------------------------------------------

  function byId(id: string): Annotation | undefined {
    return annotations.value.find(a => a.id === id)
  }

  /** Positioned annotations only (excludes arrows). */
  function positioned(): (Annotation & PositionedAnnotation)[] {
    return annotations.value.filter(a => a.kind !== 'arrow') as any
  }

  function inGroup(groupId: string): Annotation[] {
    return annotations.value.filter(a => 'attachedToGroup' in a && a.attachedToGroup === groupId)
  }

  // ---- Creation -------------------------------------------------------------

  function createSticky(opts: { x: number; y: number; text?: string; color?: string; attachedToGroup?: string }): StickyAnnotation {
    const a: StickyAnnotation = {
      id: newId('a'),
      kind: 'sticky',
      x: opts.x,
      y: opts.y,
      width: 200,
      height: 200,
      text: opts.text ?? '',
      color: opts.color ?? STICKY_PAPER, // always white by default; dark papers are picked, never cycled
      rotation: 0, // was ±2° "hand-placed" tilt — retired with the palette; square reads calmer
      attachedToGroup: opts.attachedToGroup ?? null,
    }
    annotations.value.push(a)
    return a
  }

  function createChecklist(opts: { x: number; y: number; title?: string; attachedToGroup?: string }): ChecklistAnnotation {
    const a: ChecklistAnnotation = {
      id: newId('a'),
      kind: 'checklist',
      x: opts.x,
      y: opts.y,
      width: 260,
      height: 220,
      title: opts.title ?? 'To try',
      items: [],
      color: STICKY_PAPER,
      attachedToGroup: opts.attachedToGroup ?? null,
    }
    annotations.value.push(a)
    return a
  }

  function createImagePin(opts: { x: number; y: number; src: string; caption?: string; attachedToGroup?: string }): PinImageAnnotation {
    const a: PinImageAnnotation = {
      id: newId('a'),
      kind: 'pin-image',
      x: opts.x,
      y: opts.y,
      width: 240,
      height: 240,
      src: opts.src,
      caption: opts.caption,
      attachedToGroup: opts.attachedToGroup ?? null,
    }
    annotations.value.push(a)
    return a
  }

  function createResultPin(opts: {
    x: number; y: number; src: string; metadata?: PinResultAnnotation['metadata']; caption?: string; attachedToGroup?: string
  }): PinResultAnnotation {
    const a: PinResultAnnotation = {
      id: newId('a'),
      kind: 'pin-result',
      x: opts.x,
      y: opts.y,
      width: 260,
      height: 300, // taller — metadata strip below the image
      src: opts.src,
      metadata: opts.metadata ?? {},
      caption: opts.caption,
      attachedToGroup: opts.attachedToGroup ?? null,
    }
    annotations.value.push(a)
    return a
  }

  function createArrow(opts: { from: ArrowEndpoint; to: ArrowEndpoint; label?: string; color?: string }): ArrowAnnotation {
    const a: ArrowAnnotation = {
      id: newId('a'),
      kind: 'arrow',
      from: opts.from,
      to: opts.to,
      label: opts.label,
      // Brighter default than slate-400 — the previous color disappeared
      // against the dark canvas grid. Violet matches the pending-arrow
      // preview color for visual consistency.
      color: opts.color ?? '#a78bfa',
    }
    annotations.value.push(a)
    return a
  }

  // ---- Mutation -------------------------------------------------------------

  function update(id: string, patch: Partial<Annotation>): void {
    const idx = annotations.value.findIndex(a => a.id === id)
    if (idx < 0) return
    const current = annotations.value[idx]!
    // Preserve id + kind; everything else is patchable.
    annotations.value[idx] = { ...current, ...patch, id: current.id, kind: current.kind } as Annotation
  }

  function move(id: string, dx: number, dy: number) {
    const a = byId(id)
    if (!a || a.kind === 'arrow') return
    a.x += dx
    a.y += dy
  }

  function resize(id: string, width: number, height: number) {
    const a = byId(id)
    if (!a || a.kind === 'arrow') return
    a.width = Math.max(80, width)
    a.height = Math.max(60, height)
  }

  function remove(id: string) {
    // Also remove arrows that reference this annotation as an endpoint —
    // otherwise we'd be left with dangling arrows pointing at nothing.
    annotations.value = annotations.value.filter(a => {
      if (a.id === id) return false
      if (a.kind === 'arrow') {
        const from = a.from
        const to = a.to
        if (from.kind === 'annotation' && from.id === id) return false
        if (to.kind === 'annotation' && to.id === id) return false
      }
      return true
    })
  }

  /** Bulk-remove every annotation attached to a group (and orphan arrows referencing them). */
  function removeForGroup(groupId: string) {
    const attachedIds = new Set(inGroup(groupId).map(a => a.id))
    annotations.value = annotations.value.filter(a => {
      if (a.id && attachedIds.has(a.id)) return false
      if (a.kind === 'arrow') {
        if (a.from.kind === 'group' && a.from.id === groupId) return false
        if (a.to.kind === 'group' && a.to.id === groupId) return false
        if (a.from.kind === 'annotation' && attachedIds.has(a.from.id)) return false
        if (a.to.kind === 'annotation' && attachedIds.has(a.to.id)) return false
      }
      return true
    })
  }

  /** Move every annotation attached to a group by (dx, dy). Called when the group is dragged. */
  function dragGroupAttached(groupId: string, dx: number, dy: number) {
    for (const a of annotations.value) {
      if (a.kind === 'arrow') continue
      if (a.attachedToGroup !== groupId) continue
      a.x += dx
      a.y += dy
    }
  }

  function setGroupAttachment(id: string, groupId: string | null) {
    const a = byId(id)
    if (!a || a.kind === 'arrow') return
    a.attachedToGroup = groupId
  }

  function clear() {
    annotations.value = []
  }

  function setAll(next: Annotation[]) {
    annotations.value = next
  }

  // ---- Persistence ----------------------------------------------------------
  //
  // We store the live array verbatim under workflow.extra.sailor.annotations.
  // No schema translation — annotations are entirely a Sailor concept, so
  // the round-trip is just JSON in / JSON out with a defensive parse.

  function exportToExtra(): { annotations: Annotation[] } {
    return { annotations: JSON.parse(JSON.stringify(annotations.value)) }
  }

  function loadFromExtra(raw: unknown): void {
    if (!raw || typeof raw !== 'object') { annotations.value = []; return }
    const list = (raw as any).annotations
    if (!Array.isArray(list)) { annotations.value = []; return }
    // Defensive: drop anything that doesn't at least have an id and kind we know.
    const VALID: Record<string, true> = { sticky: true, checklist: true, 'pin-image': true, 'pin-result': true, arrow: true }
    annotations.value = list.filter((a: any) => a && typeof a.id === 'string' && VALID[a.kind])
  }

  return {
    annotations,
    // queries
    byId,
    positioned,
    inGroup,
    // create
    createSticky,
    createChecklist,
    createImagePin,
    createResultPin,
    createArrow,
    // mutate
    update,
    move,
    resize,
    remove,
    removeForGroup,
    dragGroupAttached,
    setGroupAttachment,
    clear,
    setAll,
    // persist
    exportToExtra,
    loadFromExtra,
  }
}
