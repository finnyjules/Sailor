/**
 * A Frame's size and its Responsive switch — the ONE place they are written.
 *
 * Two surfaces edit them: the Frame node's header on the canvas (ArtifactFrameNode) and the
 * "Frame" section of the Frame editor's right panel (CompositorModal). Both write through
 * these functions, so they always touch the same fields the same way:
 *
 *   - the node's `width` / `height` INT widgets (0 = no explicit size: the frame follows its
 *     bottom wired image, else the editor canvas);
 *   - `properties.sailor_frame.responsive` (see `isResponsiveFrame`) and
 *     `properties.sailor_frame.preset` (which preset, or 'custom', was last picked).
 *
 * Every write spreads the existing `sailor_frame`, so its other keys (e.g. `clock`) survive.
 * `data` is the node's reactive `data` object; writes mutate it in place.
 *
 * A size write that changes the Frame's format (Stage 2) also shows again the lines the old
 * format hid and the new one carries (`restoreFormatHiddenLines`), in the same `data`, so the
 * editor's one undo step (its snapshot holds the layers and the size) covers both.
 */
import { isResponsiveFrame } from './responsive/fromNode'
import { FRAME_FORMATS, formatFor, frameFormatGroup } from './formats'
import { PLAIN_SIZE_PRESETS } from './plainPresets'
import { hiddenLayerIdsForFrame, levelLayerIdsForFrame } from './patterns/kit/plan'
import type { StyleId } from './patterns/kit/styles'
import type { FrameElements } from './patterns/types'

export interface FrameSizePreset { id: string; label: string; w: number; h: number }

/** The six plain size presets, then one preset per real ad/social format (table order). */
export const FRAME_SIZE_PRESETS: readonly FrameSizePreset[] = [
  ...PLAIN_SIZE_PRESETS,
  ...FRAME_FORMATS.map(f => ({ id: f.id, label: f.label, w: f.w, h: f.h })),
]

/** `FRAME_SIZE_PRESETS`'s UI group per index: "Sizes" for the six plain presets, then each
 *  format's own group ("Social" / "Display ads") — for a grouped Size select (StudioSelect's
 *  `optionGroups`, or a native `<optgroup>`). */
export const FRAME_SIZE_PRESET_GROUPS: readonly string[] = [
  ...PLAIN_SIZE_PRESETS.map(() => 'Sizes'),
  ...FRAME_FORMATS.map(f => frameFormatGroup(f.id)),
]

/** The parts of a Frame node's `data` this module reads and writes. */
export interface FrameSizeNodeData {
  widgetDefs?: readonly { name?: string }[] | null
  widgetsValues?: unknown[] | null
  properties?: Record<string, any> | null
}

type Dim = 'width' | 'height'

function widgetIdx(data: FrameSizeNodeData, name: Dim): number {
  return data.widgetDefs?.findIndex(d => d?.name === name) ?? -1
}
function readDim(data: FrameSizeNodeData, name: Dim): number {
  const i = widgetIdx(data, name)
  return i >= 0 ? Number(data.widgetsValues?.[i] ?? 0) || 0 : 0
}
function writeDim(data: FrameSizeNodeData, name: Dim, value: number) {
  const i = widgetIdx(data, name)
  if (i >= 0 && data.widgetsValues) data.widgetsValues[i] = value
}
function patchFrameProps(data: FrameSizeNodeData, patch: Record<string, unknown>) {
  if (!data.properties) data.properties = {}
  data.properties.sailor_frame = { ...data.properties.sailor_frame, ...patch }
}

/** The frame's explicit size (0 for a side that is not set). */
export function readFrameSize(data: FrameSizeNodeData): { w: number; h: number } {
  return { w: readDim(data, 'width'), h: readDim(data, 'height') }
}

/** The size select's value: the preset `w`×`h` matches exactly — the `stored` one
 *  (`sailor_frame.preset`) when it has that size, since two presets can share one (1280×720 is
 *  plain 16:9 and a video thumbnail), else the first — 'custom' for any other explicit size, ''
 *  when the frame has no explicit size. */
export function framePresetId(w: number, h: number, stored?: string): string {
  const own = stored ? FRAME_SIZE_PRESETS.find(p => p.id === stored && p.w === w && p.h === h) : undefined
  const match = own ?? FRAME_SIZE_PRESETS.find(p => p.w === w && p.h === h)
  return match ? match.id : (w > 0 && h > 0 ? 'custom' : '')
}

/** The format the Frame's explicit size and stored preset name ('' for none). */
function formatIdOf(data: FrameSizeNodeData): string {
  const { w, h } = readFrameSize(data)
  return formatFor(data.properties ?? undefined, w, h)?.id ?? ''
}

/** Run a size write; when it changed the Frame's format, show again the lines the old one hid. */
function sizeWrite(data: FrameSizeNodeData, write: () => void) {
  const before = formatIdOf(data)
  // The Frame as it was sized (and named) before the write: what the old format hid is read from it.
  const from: FormatOrigin = { ...readFrameSize(data), frame: data.properties?.sailor_frame }
  write()
  if (formatIdOf(data) !== before) restoreFormatHiddenLines(data, from)
}

/** The size and `sailor_frame` a Frame had before a size write — the format it had then. */
export interface FormatOrigin { w: number; h: number; frame?: unknown }

type HideTracked = { id: string; visible?: boolean; layoutPrev?: Record<string, { was: unknown; set: unknown }> }

/** Show again every line a layout hid for a format (`layoutPrev.visible` still `set: false`, the
 *  layer still hidden) that the Frame's CURRENT format carries — every such line when it has no
 *  format. `visible` goes back to what it was (removed when it had none) and the entry is
 *  dropped. A line the user showed or hid again by hand since is theirs, and left alone.
 *
 *  The lines are read the way the layout that hid them read the Frame (`posterState.patternId`: a
 *  Stage 4 layout reads the content view, ruling C2 — final review I1). Only a level (title,
 *  details, date, action, caption in that view) can be a format's: a content line or an image a
 *  layout hid stays hidden here (ruling R15). An image hidden that way is placed — and shown —
 *  again by the next apply (every layout places the Frame's extra images since Task 7 of the
 *  layout decisions), unless it is tagged Not used (rulings D3, D7).
 *
 *  `from` (every size write passes it): the Frame's size and `sailor_frame` before the write. Then
 *  only a line the OLD format hid comes back (read in the same view, from the same layers): a level
 *  the layout left out — Review's headline, Strip's details — stays hidden. Without it (a caller
 *  that no longer knows the old size), every tracked-hidden level the new format carries comes back,
 *  as before. */
export function restoreFormatHiddenLines(data: FrameSizeNodeData, from?: FormatOrigin) {
  const props = data.properties
  const layers = props?.sailor_localLayers as HideTracked[] | undefined
  if (!props || !Array.isArray(layers)) return
  const { w, h } = readFrameSize(data)
  const st = props.sailor_posterState as { patternId?: string; shapeMode?: FrameElements['shapeMode']; imageMode?: boolean; style?: StyleId } | undefined
  // The levels a format keeps follow the style of the layout that hid them (Performance ranks the
  // date above the details), and the view it read.
  const args = { props, frameW: w, frameH: h, shapeMode: st?.shapeMode ?? undefined, imageMode: st?.imageMode, style: st?.style ?? 'swiss', ...(st?.patternId ? { layoutId: st.patternId } : {}) }
  const still = new Set(hiddenLayerIdsForFrame(args))
  const levels = new Set(levelLayerIdsForFrame(args))
  // Layout limits, fix 2: with the Frame's old size known, only the lines its OLD format hid can be
  // the format's. A level the layout itself left out (Review's headline, Strip's details) was hidden
  // for the layout, not the format — it stays hidden, and the layout keeps naming it.
  const old = from ? new Set(hiddenLayerIdsForFrame({
    ...args, frameW: from.w, frameH: from.h,
    props: { ...props, sailor_frame: from.frame } as Record<string, unknown>,
  })) : null
  let changed = false
  const next = layers.map((l) => {
    const e = l.layoutPrev?.visible
    if (!e || e.set !== false || l.visible !== false || still.has(l.id) || !levels.has(l.id)) return l
    if (old && !old.has(l.id)) return l
    changed = true
    const out: HideTracked = { ...l }
    if (e.was == null) delete out.visible; else out.visible = e.was as boolean
    const { visible: _v, ...prev } = l.layoutPrev!
    if (Object.keys(prev).length) out.layoutPrev = prev; else delete out.layoutPrev
    return out
  })
  if (changed) props.sailor_localLayers = next
}

/** Write a preset's size. Leaves Responsive as it is. False (and no write) for an unknown id. */
export function applyFramePreset(data: FrameSizeNodeData, id: string): boolean {
  const p = FRAME_SIZE_PRESETS.find(x => x.id === id)
  if (!p) return false
  sizeWrite(data, () => {
    writeDim(data, 'width', p.w)
    writeDim(data, 'height', p.h)
    patchFrameProps(data, { preset: id })
  })
  return true
}

/** The value `setFrameDim` would write for a typed number — rounded, never negative, NaN → 0 —
 *  or null when it refuses: a responsive frame's side cannot be cleared, because its design
 *  size must stay concrete (slice 2; a 0 would re-derive it from the live editor canvas). */
export function frameDimFor(data: FrameSizeNodeData, value: number): number | null {
  const v = Math.max(0, Math.round(Number.isFinite(value) ? value : 0))
  return v <= 0 && isResponsiveFrame(data.properties ?? undefined) ? null : v
}

/** Write one side from a typed number (see `frameDimFor`). False, and no write, when refused. */
export function setFrameDim(data: FrameSizeNodeData, which: Dim, value: number): boolean {
  const v = frameDimFor(data, value)
  if (v == null) return false
  sizeWrite(data, () => {
    writeDim(data, which, v)
    patchFrameProps(data, { preset: 'custom' })
  })
  return true
}

/** A concrete size of `aspect` (w/h) with 1024 on its long side; square for a bad aspect. */
export function designSizeForAspect(aspect: number): { w: number; h: number } {
  const L = 1024
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1
  return a >= 1 ? { w: L, h: Math.round(L / a) } : { w: Math.round(L * a), h: L }
}

/**
 * Turn Responsive on or off. `aspect` is the frame's CURRENT effective aspect (its explicit size,
 * else its bottom wired image, else 1) — read only when turning on a frame with no explicit size.
 *
 * Slice 2's rule: a frame with no explicit size follows its bottom wired image, so on becoming
 * responsive its current effective size is written as a concrete design size — the design size
 * must be stable, never re-derived from the live canvas. An explicit size is kept untouched.
 * Turning off keeps whatever size the frame has.
 */
export function setFrameResponsive(data: FrameSizeNodeData, on: boolean, aspect: number) {
  sizeWrite(data, () => {
    if (on) {
      const { w, h } = readFrameSize(data)
      if (!(w > 0 && h > 0)) {
        const d = designSizeForAspect(aspect)
        writeDim(data, 'width', d.w)
        writeDim(data, 'height', d.h)
      }
    }
    patchFrameProps(data, { responsive: on })
  })
}

/** Everything this module writes, as the editor's undo history keeps it. `responsive` and
 *  `preset` are the raw `sailor_frame` values, absent when the key is absent. */
export interface FrameSizeState { w: number; h: number; responsive?: boolean; preset?: string }

/** The frame's size state, or undefined for a node without size widgets. */
export function readFrameSizeState(data: FrameSizeNodeData): FrameSizeState | undefined {
  if (widgetIdx(data, 'width') < 0 || widgetIdx(data, 'height') < 0) return undefined
  const sf = data.properties?.sailor_frame as { responsive?: boolean; preset?: string } | undefined
  return {
    ...readFrameSize(data),
    ...(sf?.responsive !== undefined ? { responsive: sf.responsive } : {}),
    ...(sf?.preset !== undefined ? { preset: sf.preset } : {}),
  }
}

/** Put a saved size state back exactly: raw widgets, and `responsive` / `preset` set or removed
 *  as saved; the rest of `sailor_frame` is kept, and an emptied one is removed. Writes nothing
 *  that already matches, so restoring an unchanged size does not churn reactive state. */
export function writeFrameSizeState(data: FrameSizeNodeData, s: FrameSizeState) {
  const cur = readFrameSize(data)
  if (cur.w !== s.w) writeDim(data, 'width', s.w)
  if (cur.h !== s.h) writeDim(data, 'height', s.h)
  const sf = data.properties?.sailor_frame as Record<string, unknown> | undefined
  if (sf?.responsive === s.responsive && sf?.preset === s.preset) return
  const next: Record<string, unknown> = { ...sf }
  if (s.responsive === undefined) delete next.responsive; else next.responsive = s.responsive
  if (s.preset === undefined) delete next.preset; else next.preset = s.preset
  if (!data.properties) data.properties = {}
  if (Object.keys(next).length) data.properties.sailor_frame = next
  else delete data.properties.sailor_frame
}
