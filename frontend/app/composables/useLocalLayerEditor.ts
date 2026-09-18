/**
 * Reusable inline editing engine for a Compositor/Frame's local layers
 * (text / shapes / images). Drives both the modal and on-canvas (Frame) editing.
 *
 * All pointer math is done against the canvas element's *screen* rect, so it is
 * zoom-agnostic: a Frame on the Vue Flow canvas (scaled by zoom) and the modal
 * (zoom 1) share the same code. Handle/SVG positions are returned in *logical*
 * canvas coords (0..dims), which scale correctly because they live inside the
 * (possibly zoomed) artboard element.
 */
import {
  type LocalLayer, type TextLayer, type RectLayer, type LineLayer, type PathLayer, type Paint,
  type PostEffect,
  createTextLayer, createRectLayer, createEllipseLayer, createLineLayer, createImageLayer,
  createPolygonLayer, createStarLayer,
  localLayerBox, textVAlignCenterOffset, shapeToPathLayer, withWiredContent,
  type WiredContentProvider, type WiredLayer,
} from '~/composables/useCompositorLayers'
import { svgToPathLayers, pathLayerBoolean, type BooleanOp } from '~/composables/useVectorSvg'
import {
  type LayerGroup, topGroupOf, layersInGroup, ancestorsOf, isDescendantOrSelf,
  createGroupFromSelection, dissolveGroup as dissolveGroupOp, renameGroup as renameGroupOp,
  reparentGroup as reparentGroupOp, pruneEmptyGroups, resolveGroupCascade, upsertGroup,
} from '~/lib/compositor/layerGroups'
import { nudgeLayers, duplicateLayers, snapAngle, computeSnapAdjust, mapKeyToEdit, dragHud } from '~/lib/compositor/layerEdits'
import { extractForCopy, materializePaste, setClipboard, getClipboard, hasClipboard, type ClipboardPayload } from '~/lib/compositor/layerClipboard'
import { resizeBox, type Handle, type Box } from '~/lib/compositor/resizeBox'
import { unionBox, cornerOf, anchorOf, groupScaleFactor, scaleLayerAbout, type Handle as GHandle, type Box as GBox } from '~/lib/compositor/groupResize'
import { imageUrlToFile } from '~/lib/canvas/imageUrlToFile'
import { syncAllWiredWidgets, wiredLayerHeight, type ContentDims } from '~/lib/compositor/wiredLayer'
import { inject, type Ref } from 'vue'
import type { BrandKit } from '~~/shared/brand/types'
import { readGrid, gridProperty } from '~/lib/frame/gridConfig'
import { resolveGrid, type FrameGrid, type Rect } from '~/lib/frame/grid'

interface EditorOpts {
  node: () => any                       // the compositor node (reactive)
  dims: () => { w: number; h: number }  // logical artboard size
  getRect: () => DOMRect | null         // canvas element's on-screen rect
  /**
   * Content pixel dimensions of a wired slot's upstream image / studio frame,
   * for the `layer{N}_*` write-through's contain-fit. HOST-OWNED: only the host
   * decodes wired content, so the editor never guesses — omit it and the
   * write-through falls back to each layer's cached `lastAspect`, which pins the
   * same ratio (see `syncWiredWidgets`).
   */
  wiredDims?: (slot: number) => ContentDims | undefined
  /**
   * The host's `slot → live content` resolver, used to MEASURE wired layers (see
   * `boxPx`). Same host-owned indirection `paintLayerStack` uses; passing it here
   * is what makes selection handles and hit boxes hug what actually paints.
   */
  wiredContent?: WiredContentProvider
  /**
   * Called with the `wired` layers a delete just removed, BEFORE the removal is
   * committed. Deleting a wired layer has a graph consequence the editor cannot
   * reach — the slot's edge must come out too, or the backend keeps compositing
   * pixels the editor no longer shows. Hosts wire this to the canvas's edge
   * removal. Routed through the delete choke points so every call site (keyboard,
   * panel, inspector, group delete) gets it without remembering to.
   */
  onWiredRemoved?: (layers: WiredLayer[]) => void
  /**
   * Called for each `wired` layer in a ⌘D / copy, instead of cloning it. A wired
   * layer's pixels belong to ONE slot: a second layer on the same slot would
   * paint twice and both would fight over that slot's widgets. The honest copy is
   * a SNAPSHOT (the host's "copy wired into frame" path); hosts that have one
   * pass it here, hosts that don't simply skip wired layers.
   *
   * May return a Promise. `duplicateSelection` awaits each call before starting
   * the next, so a multi-wired ⌘D materializes them one at a time instead of
   * racing several snapshots against the same host-side "one in flight" guard
   * (which used to make every wired member but the first vanish silently).
   */
  materializeWired?: (layer: WiredLayer) => void | Promise<void>
  /**
   * Called after a ⌘C fills the in-session clipboard, with the same payload, so
   * the host can ALSO push it to the OS clipboard (Sailor layer JSON + a
   * composited PNG) — the half that survives across projects and sessions. The
   * in-session clipboard is already set by the time this runs, so a host that
   * omits it (or whose OS write is denied) loses nothing but the cross-session
   * reach. Best-effort: never throw here, the copy is already "done".
   */
  onOSCopy?: (payload: ClipboardPayload) => void
}

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)) }

let _scratch: CanvasRenderingContext2D | null = null
function scratchCtx(): CanvasRenderingContext2D | null {
  if (!_scratch && typeof document !== 'undefined') _scratch = document.createElement('canvas').getContext('2d')
  return _scratch
}

/** Box layers (independent width+height) get full Figma resize (corners AND
 *  edges); text/line/path keep uniform corner scaling (no 2D box to resize). */
export function resizableKind(kind: string): boolean {
  return kind === 'rect' || kind === 'ellipse' || kind === 'image' || kind === 'polygon' || kind === 'star'
}

/** A `wired` layer has no independent height — its height is `w * lastAspect`,
 *  set by the live content — so it gets no EDGE handles. Its corners still resize
 *  the Figma way (grabbed corner follows the pointer, opposite corner pinned);
 *  the aspect lock is implicit rather than a Shift modifier. A `brush` layer is
 *  the same shape of control: its height is derived too — `w × (its strokes'
 *  natural aspect)`, not the wired `w * lastAspect` — so `w` alone drives a
 *  uniform "keep proportions" scale of the whole painted shape. */
export function aspectLockedResizeKind(kind: string): boolean {
  return kind === 'wired' || kind === 'brush'
}

/** Kinds whose CORNER handles route to the anchored `resizeBox` path rather than
 *  the uniform-from-centre `startScale` fallback. Hosts gate their corner
 *  handles on this; `resizableKind` still gates the edge handles. */
export function cornerResizableKind(kind: string): boolean {
  return resizableKind(kind) || aspectLockedResizeKind(kind)
}

/** A text layer WITH a box resizes the box (boxW/boxH) like a rectangle — corners
 *  and edges — instead of scaling the font. Boxless text keeps uniform corner
 *  scaling. Hosts OR this into their edge- and corner-handle gates. */
export function textBoxResizable(l: { kind: string; boxW?: number; boxH?: number } | null | undefined): boolean {
  return !!l && l.kind === 'text' && (((l.boxW ?? 0) > 0) || ((l.boxH ?? 0) > 0))
}

/** Compute handle positions (corners, edges, rotation, center) from box geometry
 *  and rotation. All positions are rotated and translated to world space. */
export function boxHandles(cx: number, cy: number, hw: number, hh: number, rotationDeg: number) {
  const rad = (rotationDeg * Math.PI) / 180
  const cosA = Math.cos(rad), sinA = Math.sin(rad)
  const t = (dx: number, dy: number) => ({ x: cx + dx * cosA - dy * sinA, y: cy + dx * sinA + dy * cosA })
  return {
    tl: t(-hw, -hh), tr: t(hw, -hh), br: t(hw, hh), bl: t(-hw, hh),
    t: t(0, -hh), r: t(hw, 0), b: t(0, hh), l: t(-hw, 0),
    rot: t(0, -hh - 26), topCenter: t(0, -hh), center: { x: cx, y: cy },
  }
}

export function useLocalLayerEditor(opts: EditorOpts) {
  const { node, dims, getRect } = opts

  // Active brand kit → font default for new text layers. Optional: the
  // editor also runs in dev labs with no project shell above it.
  const projectBrand = inject<{ activeKit: Ref<BrandKit | undefined> } | null>('sailor:brand', null)

  const localLayers = computed<LocalLayer[]>(() =>
    (node()?.data?.properties?.sailor_localLayers as LocalLayer[]) ?? [])

  function commit(next: LocalLayer[]) {
    const n = node(); if (!n) return
    if (!n.data.properties) n.data.properties = {}
    n.data.properties.sailor_localLayers = next
    // One-way write-through: a `wired` layer's transform is still read by the
    // Python Compositor node and the server Render out of its `layer{N}_*`
    // widgets, which know nothing about the layer model. Mirroring here — the
    // editor's single mutation choke point — is what makes "every wired edit
    // reaches the backend" true for moves, resizes, rotation, opacity, blend,
    // undo/redo and every future edit, with no call site having to remember.
    // Layers absent from `next` are left alone on purpose: deleting a wired
    // layer must not clear its widgets (disconnecting the edge is what removes
    // it server-side).
    syncAllWiredWidgets(n, next, dims(), opts.wiredDims)
  }
  // The unified z-order (wired + local StackKeys) lives alongside the layers;
  // history captures it too so reorders/grouping undo cleanly.
  function readOrder(): string[] { return ((node()?.data?.properties as any)?.sailor_stackOrder as string[]) ?? [] }
  function writeOrder(order: string[]) {
    const n = node(); if (!n) return
    if (!n.data.properties) n.data.properties = {}
    ;(n.data.properties as any).sailor_stackOrder = order
  }

  // Nested-group registry: LayerGroup { id, name?, parentId? } describing the
  // group tree. Layers keep their flat `groupId` (immediate group); this only
  // adds parent links + names. Absent ⇒ every group is a flat root (old frames).
  const localGroups = computed<LayerGroup[]>(() =>
    ((node()?.data?.properties as any)?.sailor_localGroups as LayerGroup[]) ?? [])
  function writeGroups(next: LayerGroup[]) {
    const n = node(); if (!n) return
    if (!n.data.properties) n.data.properties = {}
    ;(n.data.properties as any).sailor_localGroups = next
  }
  /** Commit layers + registry together (registry pruned of empty groups). */
  function commitBoth(nextLayers: LocalLayer[], nextGroups: LayerGroup[]) {
    commit(nextLayers)
    writeGroups(pruneEmptyGroups(nextLayers, nextGroups))
  }

  // Doc-level background fill (behind every layer; baked into output).
  const background = computed<Paint | undefined>(() => (node()?.data?.properties as any)?.sailor_localBg as Paint | undefined)
  function writeBg(p: Paint | undefined) {
    const n = node(); if (!n) return
    if (!n.data.properties) n.data.properties = {}
    if (p === undefined || p === 'none' || p === '') delete (n.data.properties as any).sailor_localBg
    else (n.data.properties as any).sailor_localBg = p
  }
  function setBackground(p: Paint | undefined) { recordHistory(); writeBg(p) }

  // Doc-level post-processing chain (adjust/bloom/grain/vignette/duotone over
  // the finished composite). Persisted like the background: on node properties.
  const postEffects = computed<PostEffect[]>(() =>
    ((node()?.data?.properties as any)?.sailor_localFx as PostEffect[]) ?? [])
  function writeFx(fx: PostEffect[] | undefined) {
    const n = node(); if (!n) return
    if (!n.data.properties) n.data.properties = {}
    if (!fx || !fx.length) delete (n.data.properties as any).sailor_localFx
    else (n.data.properties as any).sailor_localFx = fx
  }
  function setPostEffects(fx: PostEffect[]) { recordHistory(); writeFx(fx) }

  // Doc-level grid config (layout guide + snap source). Persisted like background/
  // postEffects: on node properties, absent-key defaulted via readGrid so old
  // frames (no sailor_localGrid at all) resolve to mode:'off'. Not part of the
  // undo Snapshot below — a layout-guide tweak isn't a content edit, and folding
  // it into history would push no-op restore entries (Snapshot has no grid field).
  const grid = computed<FrameGrid>(() => readGrid(node()?.data?.properties as any))
  function setGrid(g: FrameGrid) {
    const n = node(); if (!n) return
    if (!n.data.properties) n.data.properties = {}
    Object.assign(n.data.properties, gridProperty(g))
  }

  // ── Undo / redo (snapshot history over local layers + z-order) ──────────────
  // The editor is the single mutation choke point, so one history stack here
  // covers every vector edit. Discrete ops record before mutating; a drag
  // records once at pointer-down (coalesced) so it's a single undo step.
  type Snapshot = { layers: LocalLayer[]; order: string[]; bg: Paint | undefined; fx: PostEffect[]; groups: LayerGroup[]; frameTemplates: unknown[] }
  const HISTORY_CAP = 120
  const _past = ref<Snapshot[]>([])
  const _future = ref<Snapshot[]>([])
  function snapshot(): Snapshot { return { layers: JSON.parse(JSON.stringify(localLayers.value)), order: [...readOrder()], bg: background.value, fx: JSON.parse(JSON.stringify(postEffects.value)), groups: JSON.parse(JSON.stringify(localGroups.value)), frameTemplates: JSON.parse(JSON.stringify((node()?.data?.properties as any)?.sailor_frametemplates ?? [])) } }
  function restore(s: Snapshot) {
    commit(s.layers); writeOrder([...s.order]); writeBg(s.bg); writeFx(s.fx?.length ? s.fx : undefined); writeGroups([...s.groups])
    const n = node()
    if (n) {
      if (!n.data.properties) n.data.properties = {}
      ;(n.data.properties as any).sailor_frametemplates = s.frameTemplates
    }
  }
  function recordHistory() {
    _past.value.push(snapshot())
    if (_past.value.length > HISTORY_CAP) _past.value.shift()
    _future.value = []
  }
  const canUndo = computed(() => _past.value.length > 0)
  const canRedo = computed(() => _future.value.length > 0)
  function undo() {
    if (!_past.value.length) return
    _future.value.push(snapshot())
    restore(_past.value.pop()!)
    if (selectedId.value && !localLayers.value.some(l => l.id === selectedId.value)) selectedId.value = null
  }
  function redo() {
    if (!_future.value.length) return
    _past.value.push(snapshot())
    restore(_future.value.pop()!)
    if (selectedId.value && !localLayers.value.some(l => l.id === selectedId.value)) selectedId.value = null
  }

  function setLocal(id: string, patch: Record<string, any>) {
    if (!drag.value) recordHistory() // drags record once at pointer-down
    commit(localLayers.value.map(l => (l.id === id ? { ...l, ...patch } as LocalLayer : l)))
  }
  function addLocal(layer: LocalLayer) { recordHistory(); commit([...localLayers.value, layer]); selectLocal(layer.id) }
  /** Tell the host about any `wired` layers a delete is about to remove, so it
   *  can take the slot's edge out with them (see `onWiredRemoved`). */
  function notifyWiredRemoval(ids: Set<string>) {
    if (!opts.onWiredRemoved) return
    const wired = localLayers.value.filter(l => ids.has(l.id) && l.kind === 'wired') as WiredLayer[]
    if (wired.length) opts.onWiredRemoved(wired)
  }
  function deleteLocal(id: string) {
    recordHistory()
    notifyWiredRemoval(new Set([id]))
    commitBoth(localLayers.value.filter(l => l.id !== id), localGroups.value)
    if (selectedId.value === id) selectedId.value = null
  }
  /** Delete many layers in one history step (e.g. a whole group). */
  function deleteLayers(ids: string[]) {
    if (!ids.length) return
    recordHistory()
    const set = new Set(ids)
    notifyWiredRemoval(set)
    commitBoth(localLayers.value.filter(l => !set.has(l.id)), localGroups.value)
    if (selectedId.value && set.has(selectedId.value)) selectLocal(null)
  }
  function moveLocalZ(id: string, dir: -1 | 1) {
    const arr = [...localLayers.value]
    const i = arr.findIndex(l => l.id === id); const j = i + dir
    if (i < 0 || j < 0 || j >= arr.length) return
    recordHistory()
    ;[arr[i], arr[j]] = [arr[j], arr[i]]; commit(arr)
  }

  // ── Selection / editing state ──────────────────────────────────────────────
  const selectedId = ref<string | null>(null)
  const selected = computed(() => localLayers.value.find(l => l.id === selectedId.value) ?? null)
  // Multi-selection (superset of selectedId) for booleans / group / align.
  const selectedIds = ref<Set<string>>(new Set())
  /** Every layer id under the same OUTERMOST group as `id` (just `id` if
   *  ungrouped). Nesting-aware: clicking a nested layer selects the whole top
   *  group, matching Figma. For a flat (un-nested) group this is byte-identical
   *  to the old "same groupId" behavior. */
  function groupSiblings(id: string): string[] {
    const l = localLayers.value.find(x => x.id === id)
    if (!l?.groupId) return [id]
    const top = topGroupOf(l.groupId, localGroups.value)
    const ids = layersInGroup(top, localLayers.value, localGroups.value)
    return ids.length ? ids : [id]
  }
  function selectLocal(id: string | null) {
    selectedId.value = id
    selectedIds.value = id ? new Set(groupSiblings(id)) : new Set() // selecting a grouped layer selects the group
  }
  /** Select exactly one group's subtree (a specific level, not expanded to the
   *  outermost like a canvas click). Used by the layers panel. */
  function selectGroupById(groupId: string) {
    const ids = layersInGroup(groupId, localLayers.value, localGroups.value)
    if (!ids.length) return
    selectedIds.value = new Set(ids)
    selectedId.value = ids[ids.length - 1] ?? null
  }
  /** Shift-click: toggle `id` (and its group) in the multi-selection. */
  function toggleSelect(id: string) {
    const sibs = groupSiblings(id)
    const s = new Set(selectedIds.value)
    if (s.has(id)) { for (const x of sibs) s.delete(x); if (sibs.includes(selectedId.value!)) selectedId.value = [...s][s.size - 1] ?? null }
    else { for (const x of sibs) s.add(x); selectedId.value = id }
    selectedIds.value = s
  }
  let _groupSeq = 0
  let _dupSeq = 0
  /** Group the current multi-selection (≥2 layers). Fully-selected existing
   *  groups nest under the new group; loose layers become direct members. */
  function groupSelected() {
    if (selectedIds.value.size < 2) return
    const gid = `g-${Date.now().toString(36)}-${++_groupSeq}`
    recordHistory()
    const r = createGroupFromSelection(localLayers.value, localGroups.value, selectedIds.value, gid)
    commitBoth(r.layers as LocalLayer[], r.groups)
  }
  /** Rename a group (stored in the registry). */
  function renameGroup(groupId: string, name: string) {
    recordHistory()
    writeGroups(renameGroupOp(localGroups.value, groupId, name))
  }
  /** Per-layer display name (overrides the derived label in the panel). */
  const editingLayerNameId = ref<string | null>(null)
  const layerNameDraft = ref('')
  function setLayerName(id: string, name: string) {
    const nm = name.trim()
    recordHistory()
    commit(localLayers.value.map(l => (l.id === id ? ({ ...l, name: nm || undefined } as LocalLayer) : l)))
  }
  function startLayerRename(id: string) {
    editingLayerNameId.value = id
    const l = localLayers.value.find(x => x.id === id)
    layerNameDraft.value = (l as any)?.name ?? ''
  }
  function commitLayerRename() {
    if (editingLayerNameId.value) setLayerName(editingLayerNameId.value, layerNameDraft.value)
    editingLayerNameId.value = null
  }
  /** Set a group's own hidden flag (cascades to descendants via resolveGroupCascade). */
  function setGroupHidden(groupId: string, hidden: boolean) { recordHistory(); writeGroups(upsertGroup(localGroups.value, groupId, { hidden })) }
  /** Set a group's own locked flag (cascades to descendants via resolveGroupCascade). */
  function setGroupLocked(groupId: string, locked: boolean) { recordHistory(); writeGroups(upsertGroup(localGroups.value, groupId, { locked })) }
  /** Set a group's own opacity (multiplies with ancestors via resolveGroupCascade). */
  function setGroupOpacity(groupId: string, opacity: number) { recordHistory(); writeGroups(upsertGroup(localGroups.value, groupId, { opacity: Math.max(0, Math.min(1, opacity)) })) }
  /** Effective (cascaded) hidden/locked/opacity for a group, for the layers panel. */
  function groupCascade(groupId: string) { return resolveGroupCascade(groupId, localGroups.value) }
  /** Dissolve one specific group level (used by the layers panel). */
  function ungroupGroup(groupId: string) {
    recordHistory()
    const r = dissolveGroupOp(localLayers.value, localGroups.value, groupId)
    commitBoth(r.layers as LocalLayer[], r.groups)
  }
  /** Ungroup the outermost group(s) in the current selection. */
  function ungroupSelected() {
    const sel = selectedIds.value
    if (!sel.size) return
    const tops = new Set<string>()
    for (const l of localLayers.value) if (sel.has(l.id) && l.groupId) tops.add(topGroupOf(l.groupId, localGroups.value))
    if (!tops.size) return
    recordHistory()
    let L = localLayers.value as LocalLayer[]
    let G = localGroups.value
    for (const t of tops) { const r = dissolveGroupOp(L, G, t); L = r.layers as LocalLayer[]; G = r.groups }
    commitBoth(L, G)
    selectedIds.value = new Set([...sel].filter(id => L.some(l => l.id === id)))
  }
  /** Move a layer into `groupId` (or out to loose when undefined). Panel drag. */
  function setLayerGroup(layerId: string, groupId: string | undefined) {
    recordHistory()
    commitBoth(localLayers.value.map(l => (l.id === layerId ? { ...l, groupId } as LocalLayer : l)), localGroups.value)
  }
  /** Re-parent a group under `parentId` (root when undefined). Panel drag. */
  function setGroupParent(groupId: string, parentId: string | undefined) {
    if (parentId && isDescendantOrSelf(parentId, groupId, localGroups.value)) return // no cycles
    recordHistory()
    writeGroups(reparentGroupOp(localGroups.value, groupId, parentId))
  }
  const canGroup = computed(() => selectedIds.value.size >= 2)
  const canUngroup = computed(() => selectedLayers.value.some(l => !!l.groupId))
  const selectedLayers = computed(() =>
    localLayers.value.filter(l => selectedIds.value.has(l.id))) // preserves z-order
  const editingId = ref<string | null>(null)
  const editingLayer = computed(() =>
    localLayers.value.find(l => l.id === editingId.value && l.kind === 'text') as TextLayer | undefined)
  function beginEdit(id: string) { selectLocal(id); editingId.value = id }
  function endEdit() { editingId.value = null }

  // ── Inline text-editor focus contract ──────────────────────────────────────
  // `beginEdit` only flips `editingId`; the <textarea> that renders it belongs
  // to the HOST (the Frame card, the modal). Hosts register their textarea
  // getter ONCE here, so EVERY path into text editing — Add text, a canvas
  // double-click, the layers panel — lands with the caret in the box and the
  // placeholder selected, instead of each host wiring its own watcher per
  // entry point (which is how "Add text then type" ended up doing nothing).
  let editFocusTarget: (() => HTMLTextAreaElement | null | undefined) | null = null
  function registerEditFocus(get: () => HTMLTextAreaElement | null | undefined) { editFocusTarget = get }
  /** Focus + select-all the host's textarea once the DOM has caught up with
   *  `editingId`. Two ticks because a host may gate the textarea on state it
   *  flips in the same tick (the card's `editMode`). */
  function focusEditTarget() {
    const get = editFocusTarget
    if (!get) return
    const take = () => { const el = get(); if (!el) return false; el.focus(); el.select(); return true }
    nextTick(() => { if (!take()) nextTick(() => { take() }) })
  }
  watch(editingId, (id) => { if (id) focusEditTarget() })

  // ── Geometry ────────────────────────────────────────────────────────────────
  // Every box measurement in the editor goes through here, so this is the one
  // place the host's wired resolver has to be installed: a `wired` layer's box
  // follows its LIVE content aspect, and without the host's provider it would
  // fall back to `lastAspect` — right often enough to hide the bug, wrong exactly
  // when an upstream node has just re-run. `withWiredContent` scopes it to this
  // synchronous call so a second live host can't be measured with our slots.
  function boxPx(layer: LocalLayer) {
    return withWiredContent(opts.wiredContent, () => localLayerBox(scratchCtx(), layer, dims().w, dims().h))
  }
  const handlePositions = computed(() => {
    const l = selected.value
    if (!l) return null
    const b = boxPx(l)
    return boxHandles(l.x * dims().w, l.y * dims().h + textVAlignCenterOffset(l, b.h), b.w / 2, b.h / 2, l.rotation)
  })

  /** Union box (px) of the current multi-selection (≥2), else null. */
  const selectionBox = computed<GBox | null>(() => {
    if (selectedIds.value.size < 2) return null
    const W = dims().w, H = dims().h
    const boxes = selectedLayers.value.map((l) => { const b = boxPx(l); return { cx: l.x * W, cy: l.y * H + textVAlignCenterOffset(l, b.h), w: b.w, h: b.h } })
    return boxes.length ? unionBox(boxes) : null
  })
  const selectionHandles = computed(() => {
    const b = selectionBox.value; if (!b) return null
    return { tl: cornerOf(b, 'tl'), tr: cornerOf(b, 'tr'), br: cornerOf(b, 'br'), bl: cornerOf(b, 'bl') }
  })

  const hud = computed(() => {
    const d = drag.value
    if (!d) return null
    if (d.type === 'groupResize') {
      const b = selectionBox.value; if (!b) return null
      const hh = dragHud('scale', { wPx: b.w, hPx: b.h, xPx: b.cx, yPx: b.cy, rotation: 0 })
      if (!hh) return null
      return { text: hh.text, left: b.cx, top: b.cy - b.h / 2 - 12 }
    }
    const l = selected.value
    if (!l) return null
    const b = boxPx(l); const W = dims().w, H = dims().h
    const kind = d.type === 'resize' ? 'scale' : d.type
    const hh = dragHud(kind, { wPx: b.w, hPx: b.h, xPx: l.x * W, yPx: l.y * H, rotation: l.rotation })
    if (!hh) return null
    return { text: hh.text, left: l.x * W, top: l.y * H + textVAlignCenterOffset(l, b.h) - b.h / 2 - 12 }
  })

  // ── Align / distribute (operates on the multi-selection) ────────────────────
  type AlignMode = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom' | 'hdist' | 'vdist'
  function alignSelected(mode: AlignMode) {
    const sel = selectedLayers.value
    if (sel.length < 2) return
    const W = dims().w, H = dims().h
    // Per-layer extents in normalized coords (x of width, y of height).
    const ext = sel.map(l => {
      const b = boxPx(l)
      return { l, hx: b.w / 2 / W, hy: b.h / 2 / H }
    })
    recordHistory()
    const patch = (id: string, p: Record<string, number>) =>
      commit(localLayers.value.map(x => (x.id === id ? { ...x, ...p } as LocalLayer : x)))
    if (mode === 'left') { const t = Math.min(...ext.map(e => e.l.x - e.hx)); for (const e of ext) patch(e.l.id, { x: t + e.hx }) }
    else if (mode === 'right') { const t = Math.max(...ext.map(e => e.l.x + e.hx)); for (const e of ext) patch(e.l.id, { x: t - e.hx }) }
    else if (mode === 'hcenter') { const lo = Math.min(...ext.map(e => e.l.x - e.hx)), hi = Math.max(...ext.map(e => e.l.x + e.hx)); const c = (lo + hi) / 2; for (const e of ext) patch(e.l.id, { x: c }) }
    else if (mode === 'top') { const t = Math.min(...ext.map(e => e.l.y - e.hy)); for (const e of ext) patch(e.l.id, { y: t + e.hy }) }
    else if (mode === 'bottom') { const t = Math.max(...ext.map(e => e.l.y + e.hy)); for (const e of ext) patch(e.l.id, { y: t - e.hy }) }
    else if (mode === 'vcenter') { const lo = Math.min(...ext.map(e => e.l.y - e.hy)), hi = Math.max(...ext.map(e => e.l.y + e.hy)); const c = (lo + hi) / 2; for (const e of ext) patch(e.l.id, { y: c }) }
    else if (mode === 'hdist' && sel.length >= 3) {
      const s = [...ext].sort((a, b) => a.l.x - b.l.x)
      const lo = s[0].l.x, hi = s[s.length - 1].l.x, step = (hi - lo) / (s.length - 1)
      s.forEach((e, i) => patch(e.l.id, { x: lo + step * i }))
    } else if (mode === 'vdist' && sel.length >= 3) {
      const s = [...ext].sort((a, b) => a.l.y - b.l.y)
      const lo = s[0].l.y, hi = s[s.length - 1].l.y, step = (hi - lo) / (s.length - 1)
      s.forEach((e, i) => patch(e.l.id, { y: lo + step * i }))
    }
  }

  /** Move the whole multi-selection by a normalized delta (keyboard nudge). */
  function nudgeSelection(dx: number, dy: number) {
    if (!selectedIds.value.size || (dx === 0 && dy === 0)) return
    recordHistory()
    commit(nudgeLayers(localLayers.value, selectedIds.value, dx, dy))
  }

  /** The selection minus its `wired` members — the part that can be CLONED. A
   *  wired layer is a live link to one slot, so it is snapshotted instead (see
   *  `materializeWired`); cloning it would put two layers on one slot. */
  function clonableSelection(): { ids: Set<string>; wired: WiredLayer[] } {
    const wired = localLayers.value.filter(
      l => selectedIds.value.has(l.id) && l.kind === 'wired') as WiredLayer[]
    if (!wired.length) return { ids: selectedIds.value, wired }
    const drop = new Set(wired.map(l => l.id))
    return { ids: new Set([...selectedIds.value].filter(id => !drop.has(id))), wired }
  }

  /** Duplicate the current multi-selection; the copies become the selection.
   *  Wired members are materialized SEQUENTIALLY — awaiting each snapshot before
   *  starting the next — because the host's materializer (e.g. "copy into frame")
   *  guards against re-entrancy: firing all of them at once meant every wired
   *  layer after the first silently no-op'd out from under the guard. */
  async function duplicateSelection() {
    if (!selectedIds.value.size) return
    const { ids, wired } = clonableSelection()
    for (const w of wired) await opts.materializeWired?.(w)
    if (!ids.size) return
    recordHistory()
    const r = duplicateLayers(
      localLayers.value, localGroups.value, ids, 0.02,
      () => `ll-${Date.now().toString(36)}-${++_dupSeq}`,
      () => `g-${Date.now().toString(36)}-${++_groupSeq}`,
    )
    commitBoth(r.layers as LocalLayer[], r.groups)
    selectedIds.value = new Set(r.newIds)
    selectedId.value = r.newIds[r.newIds.length - 1] ?? null
  }

  /** Copy the current multi-selection to the shared in-app clipboard AND (via
   *  `onOSCopy`) the OS clipboard. Wired members are materialized to a baked
   *  snapshot FIRST — the same path ⌘D uses — so a slot never rides the
   *  clipboard live (it would point at a different input in another frame); the
   *  fresh baked layers are what gets copied in its place. When the selection has
   *  no wired member this runs fully synchronously, keeping the OS-clipboard
   *  write inside the ⌘C user gesture. */
  async function copySelection() {
    const { ids, wired } = clonableSelection()
    // Bake wired members into the frame (snapshot rule), then copy the resulting
    // real layers instead of the live wired ones.
    let copyIds = ids
    if (wired.length) {
      const before = new Set(localLayers.value.map(l => l.id))
      for (const w of wired) await opts.materializeWired?.(w)
      const baked = localLayers.value.filter(l => !before.has(l.id)).map(l => l.id)
      copyIds = new Set([...ids, ...baked])
    }
    if (!copyIds.size) return
    const p = extractForCopy(localLayers.value, localGroups.value, copyIds)
    if (!p) return
    setClipboard(p)
    try { opts.onOSCopy?.(p) } catch { /* OS write is best-effort; in-session clipboard already set */ }
  }
  /** Paste the clipboard into THIS frame; offset unless inPlace. Copies become the selection. */
  function pasteClipboard(inPlace: boolean) {
    const p = getClipboard()
    if (!p) return
    recordHistory()
    const r = materializePaste(
      p, localLayers.value, localGroups.value, inPlace ? 0 : 0.02,
      () => `ll-${Date.now().toString(36)}-${++_dupSeq}`,
      () => `g-${Date.now().toString(36)}-${++_groupSeq}`,
    )
    commitBoth(r.layers as LocalLayer[], r.groups)
    selectedIds.value = new Set(r.newIds)
    selectedId.value = r.newIds[r.newIds.length - 1] ?? null
  }

  /** Keyboard: arrow-nudge (1px / shift 10px), cmd/ctrl-D duplicate,
   *  cmd/ctrl-C copy, cmd/ctrl-V paste (offset) / +Shift paste in-place.
   *  Paste only needs a clipboard; nudge/duplicate/copy need a selection.
   *  Returns true if consumed. */
  function handleEditorKey(e: KeyboardEvent): boolean {
    const a = mapKeyToEdit(e, 1, 10)
    if (!a) return false
    if (a.type === 'paste') {
      if (!hasClipboard()) return false
      e.preventDefault(); pasteClipboard(a.inPlace); return true
    }
    if (!selectedIds.value.size) return false
    e.preventDefault()
    if (a.type === 'nudge') nudgeSelection(a.dxPx / dims().w, a.dyPx / dims().h)
    else if (a.type === 'duplicate') void duplicateSelection()
    else if (a.type === 'copy') void copySelection()
    return true
  }

  // ── Pointer interaction (zoom-agnostic via screen rect) ─────────────────────
  type Drag =
    | { type: 'move'; id: string; sx: number; sy: number; origins: { id: string; ox: number; oy: number }[] }
    | { type: 'scale'; id: string; cx: number; cy: number; startDist: number; start: Record<string, number> }
    | { type: 'rotate'; id: string; cx: number; cy: number; startAngle: number; startRot: number }
    | { type: 'resize'; id: string; handle: Handle; rot: number; start: Box; p0: { x: number; y: number } }
    | { type: 'groupResize'; handle: GHandle; anchor: { x: number; y: number }; cornerStart: { x: number; y: number }; ids: string[]; start: Record<string, { x: number; y: number; size: Record<string, number> }> }
    | null
  const drag = ref<Drag>(null)
  // Active snap guide lines (normalized positions) shown while moving.
  const snapGuides = ref<{ vx: number | null; hy: number | null }>({ vx: null, hy: null })
  const SNAP_PX = 6 // snap distance threshold in screen pixels

  // Grid line positions, normalized to [0,1], for drag snapping (Task 6). A Vue
  // `computed` — recomputed only when `grid` (itself computed off the node's
  // properties) or the canvas dims change, NOT on every pointermove; `resolveGrid`
  // reseeds a PRNG and walks the axis-edge algorithm, so re-running it per pointer
  // event would be real, avoidable work on every dragged pixel.
  const gridSnapLines = computed(() => {
    const g = grid.value
    if (g.mode === 'off') return { xs: [] as number[], ys: [] as number[] }
    const { w: W, h: H } = dims()
    const { xs, ys } = resolveGrid(g, W, H)
    return { xs: xs.map(x => x / W), ys: ys.map(y => y / H) }
  })

  // screen px → normalized [0,1] within the artboard
  function toNorm(clientX: number, clientY: number, r: DOMRect) {
    return { nx: (clientX - r.left) / r.width, ny: (clientY - r.top) / r.height }
  }

  function hitTest(clientX: number, clientY: number): string | null {
    const r = getRect(); if (!r) return null
    const { nx, ny } = toNorm(clientX, clientY, r)
    const W = dims().w, H = dims().h
    const px = nx * W, py = ny * H
    for (let i = localLayers.value.length - 1; i >= 0; i--) {
      const l = localLayers.value[i]
      // Hidden/locked layers are transparent to canvas hits (the layers panel
      // can still select a locked layer; the canvas can't).
      if (l.visible === false || l.locked) continue
      const gc = resolveGroupCascade(l.groupId, localGroups.value)
      if (gc.hidden || gc.locked) continue
      const b = boxPx(l)
      const cx = l.x * W, cy = l.y * H + textVAlignCenterOffset(l, b.h)
      const rad = (-l.rotation * Math.PI) / 180
      const dx = px - cx, dy = py - cy
      const lx = dx * Math.cos(rad) - dy * Math.sin(rad)
      const ly = dx * Math.sin(rad) + dy * Math.cos(rad)
      const pad = 8
      if (Math.abs(lx) <= b.w / 2 + pad && Math.abs(ly) <= b.h / 2 + pad) return l.id
    }
    return null
  }

  function startMove(id: string, e: PointerEvent) {
    const l = localLayers.value.find(x => x.id === id); if (!l) return
    recordHistory() // coalesce the whole drag into one undo step
    // Move the whole selection (group) together when dragging within it.
    const moveIds = selectedIds.value.has(id) ? [...selectedIds.value] : [id]
    const origins = moveIds
      .map(mid => { const m = localLayers.value.find(x => x.id === mid); return m ? { id: mid, ox: m.x, oy: m.y } : null })
      .filter(Boolean) as { id: string; ox: number; oy: number }[]
    drag.value = { type: 'move', id, sx: e.clientX, sy: e.clientY, origins }
    attach()
  }

  /** Snap the primary layer's edges/center to other layers + canvas center.
   *  Returns adjusted (dx,dy) and sets the visible guide lines. */
  function applySnap(primaryId: string, ox: number, oy: number, dx: number, dy: number) {
    const W = dims().w, H = dims().h
    const prim = localLayers.value.find(l => l.id === primaryId)
    if (!prim) return { dx, dy }
    const b = boxPx(prim); const hx = b.w / 2 / W, hy = b.h / 2 / H
    const cx = ox + dx, cy = oy + dy
    const movingIds = new Set((drag.value as any)?.origins?.map((o: any) => o.id) ?? [primaryId])
    const others = [] as { cx: number; cy: number; hx: number; hy: number }[]
    for (const l of localLayers.value) {
      if (movingIds.has(l.id)) continue
      const lb = boxPx(l)
      others.push({ cx: l.x, cy: l.y, hx: lb.w / 2 / W, hy: lb.h / 2 / H })
    }
    const gl = gridSnapLines.value
    const res = computeSnapAdjust({ cx, cy, hx, hy }, others, SNAP_PX / W, SNAP_PX / H, [0, 0.5, 1], gl.xs, gl.ys)
    snapGuides.value = { vx: res.guideX, hy: res.guideY }
    return { dx: dx + res.dx, dy: dy + res.dy }
  }
  function startScale(e: PointerEvent) {
    e.preventDefault(); e.stopPropagation()
    const l = selected.value; const r = getRect(); if (!l || !r) return
    const cx = r.left + l.x * r.width, cy = r.top + l.y * r.height
    const start: Record<string, number> = {}
    if (l.kind === 'text') start.fontSize = (l as TextLayer).fontSize
    else if (l.kind === 'line') start.w = (l as LineLayer).w
    else if (l.kind === 'path') start.scale = (l as PathLayer).scale
    // A wired layer has NO independent height — it is `w * lastAspect`, so the
    // corner scale is width-only and stays aspect-locked. Snapshotting
    // `(l as RectLayer).h` (undefined) made onMove's clamp yield NaN, which the
    // commit then persisted as the layer's `h`.
    else if (l.kind === 'wired') start.w = (l as WiredLayer).w
    else { start.w = (l as RectLayer).w; start.h = (l as RectLayer).h }
    recordHistory()
    drag.value = { type: 'scale', id: l.id, cx, cy, startDist: Math.max(1, Math.hypot(e.clientX - cx, e.clientY - cy)), start }
    attach()
  }
  function startRotate(e: PointerEvent) {
    e.preventDefault(); e.stopPropagation()
    const l = selected.value; const r = getRect(); if (!l || !r) return
    const cx = r.left + l.x * r.width, cy = r.top + l.y * r.height
    recordHistory()
    drag.value = { type: 'rotate', id: l.id, cx, cy, startAngle: Math.atan2(e.clientY - cy, e.clientX - cx), startRot: l.rotation }
    attach()
  }
  function startResize(handle: Handle, e: PointerEvent) {
    e.preventDefault(); e.stopPropagation()
    const l = selected.value; const r = getRect(); if (!l || !r) return
    const W = dims().w, H = dims().h
    const b = boxPx(l)
    // A text box resizes its own boxW/boxH (px = fraction·WIDTH), so start from
    // those when set — not the painted glyph bounds — so the drag maths is honest.
    const tb = textBoxResizable(l)
    const sw = tb ? ((l as TextLayer).boxW ?? b.w / W) * W : b.w
    const sh = tb ? ((l as TextLayer).boxH ?? b.h / W) * W : b.h
    const { nx, ny } = toNorm(e.clientX, e.clientY, r)
    recordHistory()
    drag.value = {
      type: 'resize', id: l.id, handle, rot: l.rotation,
      // Start from the DISPLAYED centre (valign shifts a text box's centre off its
      // stored y), so the drag maths and the handles share one frame; the writeback
      // converts the resized centre back through the new offset.
      start: { cx: l.x * W, cy: l.y * H + textVAlignCenterOffset(l, sh), w: sw, h: sh },
      p0: { x: nx * W, y: ny * H },
    }
    attach()
  }
  /** Begin a proportional resize of the whole multi-selection from a corner
   *  handle of the union box. Each layer's start x/y/size is snapshotted so
   *  onMove always scales from the ORIGINAL (never compounds across moves). */
  function startGroupResize(handle: GHandle, e: PointerEvent) {
    e.preventDefault(); e.stopPropagation()
    const box = selectionBox.value; const r = getRect(); if (!box || !r) return
    const anchor = anchorOf(box, handle, e.altKey)
    const cornerStart = cornerOf(box, handle)
    // Snapshot each selected layer's start center (px) + size fields so f re-derives from the ORIGINAL each move.
    const start: Record<string, { x: number; y: number; size: Record<string, number> }> = {}
    for (const l of selectedLayers.value) {
      const s: Record<string, number> = {}
      const ll = l as any
      if (ll.kind === 'text') s.fontSize = ll.fontSize
      else if (ll.kind === 'line') s.w = ll.w
      else if (ll.kind === 'path') s.scale = ll.scale
      // Wired: width plus its DERIVED height, so the snapshot is a real box
      // rather than `h: undefined`. `scaleLayerAbout` scales the width only —
      // the height follows `lastAspect`, and no `h` is ever written back.
      else if (ll.kind === 'wired') { s.w = ll.w; s.h = wiredLayerHeight(ll) }
      else { s.w = ll.w; s.h = ll.h }
      start[l.id] = { x: l.x, y: l.y, size: s }
    }
    recordHistory()
    drag.value = { type: 'groupResize', handle, anchor, cornerStart, ids: selectedLayers.value.map(l => l.id), start }
    attach()
  }
  function onMove(e: PointerEvent) {
    const d = drag.value; if (!d) return
    const r = getRect(); if (!r) return
    if (d.type === 'move') {
      const prim = d.origins.find(o => o.id === d.id) ?? d.origins[0]
      let dx = (e.clientX - d.sx) / r.width, dy = (e.clientY - d.sy) / r.height
      if (!e.altKey && prim) ({ dx, dy } = applySnap(prim.id, prim.ox, prim.oy, dx, dy)) // Alt disables snap
      else snapGuides.value = { vx: null, hy: null }
      const map = new Map(d.origins.map(o => [o.id, o]))
      commit(localLayers.value.map(l => {
        const o = map.get(l.id)
        return o ? { ...l, x: clamp(o.ox + dx, -0.5, 1.5), y: clamp(o.oy + dy, -0.5, 1.5) } as LocalLayer : l
      }))
    } else if (d.type === 'scale') {
      const ratio = Math.max(0.05, Math.hypot(e.clientX - d.cx, e.clientY - d.cy) / d.startDist)
      const patch: Record<string, number> = {}
      for (const k in d.start) patch[k] = clamp(d.start[k] * ratio, 0.002, 4)
      setLocal(d.id, patch)
    } else if (d.type === 'rotate') {
      let rot = d.startRot + ((Math.atan2(e.clientY - d.cy, e.clientX - d.cx) - d.startAngle) * 180) / Math.PI
      while (rot > 180) rot -= 360
      while (rot < -180) rot += 360
      setLocal(d.id, { rotation: Math.round(snapAngle(rot, e.shiftKey ? 15 : null)) })
    } else if (d.type === 'resize') {
      const W = dims().w, H = dims().h
      const { nx, ny } = toNorm(e.clientX, e.clientY, r)
      // A wired layer's height is DERIVED (`w * lastAspect`), so its corner drag is
      // aspect-locked whether or not Shift is held, and only the width + the
      // recomputed centre are written back. `d.start.h` is the derived height, which
      // is what keeps the anchored maths honest: the opposite corner stays pinned in
      // BOTH axes, exactly like a rect's.
      const cur = localLayers.value.find(l => l.id === d.id)
      const locked = aspectLockedResizeKind(cur?.kind ?? '')
      const box = resizeBox(d.start, d.rot, d.handle, d.p0, { x: nx * W, y: ny * H }, { aspect: e.shiftKey || locked, fromCenter: e.altKey })
      // px → normalized (w,h fractions of WIDTH; x of width, y of height). A text
      // box writes its boxW/boxH — the same normalized-to-width fields — instead of
      // a rect's w/h, so the handles resize the box rather than nothing.
      const tb = textBoxResizable(cur)
      // `box.cy` is the resized DISPLAY centre; the render re-adds the valign offset
      // for the NEW height, so store y with that offset removed — this pins the
      // aligned edge (top/bottom) instead of the centre while the box is dragged.
      const oy = cur ? textVAlignCenterOffset(cur, box.h) : 0
      const patch: Record<string, number> = { x: box.cx / W, y: (box.cy - oy) / H }
      patch[tb ? 'boxW' : 'w'] = box.w / W
      if (!locked) patch[tb ? 'boxH' : 'h'] = box.h / W
      setLocal(d.id, patch)
    } else if (d.type === 'groupResize') {
      const W = dims().w, H = dims().h
      const { nx, ny } = toNorm(e.clientX, e.clientY, r)
      const f = groupScaleFactor(d.anchor, d.cornerStart, { x: nx * W, y: ny * H })
      commit(localLayers.value.map((l) => {
        const s = d.start[l.id]; if (!s) return l
        const startLayer = { ...l, x: s.x, y: s.y, ...s.size } as LocalLayer
        return { ...l, ...scaleLayerAbout(startLayer, d.anchor, f, W, H) } as LocalLayer
      }))
    }
  }
  function onUp() { drag.value = null; snapGuides.value = { vx: null, hy: null }; window.removeEventListener('pointermove', onMove) }

  // ── Marquee (rubber-band) selection ─────────────────────────────────────────
  const marquee = ref<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  function startMarquee(nx: number, ny: number) { marquee.value = { x0: nx, y0: ny, x1: nx, y1: ny } }
  function moveMarquee(nx: number, ny: number) { if (marquee.value) marquee.value = { ...marquee.value, x1: nx, y1: ny } }
  function endMarquee(additive = false) {
    const m = marquee.value; marquee.value = null
    if (!m) return
    const lo = { x: Math.min(m.x0, m.x1), y: Math.min(m.y0, m.y1) }
    const hi = { x: Math.max(m.x0, m.x1), y: Math.max(m.y0, m.y1) }
    if (hi.x - lo.x < 0.005 && hi.y - lo.y < 0.005) return // a click, not a drag
    const hits = localLayers.value.filter(l => l.x >= lo.x && l.x <= hi.x && l.y >= lo.y && l.y <= hi.y)
    const ids = new Set(additive ? selectedIds.value : [])
    for (const l of hits) for (const sib of groupSiblings(l.id)) ids.add(sib)
    selectedIds.value = ids
    selectedId.value = hits.length ? hits[hits.length - 1].id : (additive ? selectedId.value : null)
  }
  function attach() {
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
  }

  // ── Grid-driven section ops (Task 7) ────────────────────────────────────────
  // "Fill grid with sections", "Draw section" and "Re-snap to grid" all key off
  // the same `gridSnapLines` (Task 6) the drag-snap already uses, so a section's
  // edges always land exactly on the lines the overlay draws.

  /** Create one empty (unfilled) `rect` layer per grid region — `regions` are the
   *  PIXEL boxes `resolveGrid` returns, same basis as `dims()`. Grouped (when >1)
   *  and selected together, in one history step. The caller enforces the
   *  region-count cap (dense fills are a later feature) before calling this —
   *  this function just lays the rects down. */
  function fillGridWithSections(regions: Rect[]) {
    if (!regions.length) return
    const W = dims().w, H = dims().h
    recordHistory()
    const gid = regions.length > 1 ? `g-${Date.now().toString(36)}-${++_groupSeq}` : undefined
    const layers = regions.map(r => createRectLayer({
      x: (r.x + r.w / 2) / W, y: (r.y + r.h / 2) / H,
      // RectLayer w/h are both normalized to canvas WIDTH (see localLayerBox).
      w: r.w / W, h: r.h / W,
      fill: 'none', stroke: '', strokeWidth: 0,
      ...(gid ? { groupId: gid } : {}),
    }))
    commit([...localLayers.value, ...layers])
    if (gid) writeGroups([...localGroups.value, { id: gid }])
    selectedIds.value = new Set(layers.map(l => l.id))
    selectedId.value = layers[layers.length - 1]?.id ?? null
  }

  /** Snap each currently-selected layer's box edges to the nearest grid line,
   *  independently per layer, in one history step. A large threshold (0.5) means
   *  it always finds the nearest line rather than requiring the layer to already
   *  be close — "re-snap", not "snap if close". No-op with the grid off or an
   *  empty selection. */
  function resnapSelected() {
    const gl = gridSnapLines.value
    if (!gl.xs.length && !gl.ys.length) return
    const sel = selectedLayers.value
    if (!sel.length) return
    const W = dims().w, H = dims().h
    const patches = new Map<string, { x: number; y: number }>()
    for (const l of sel) {
      const b = boxPx(l)
      const hx = b.w / 2 / W, hy = b.h / 2 / H
      const res = computeSnapAdjust({ cx: l.x, cy: l.y, hx, hy }, [], 0.5, 0.5, [], gl.xs, gl.ys)
      if (res.dx || res.dy) patches.set(l.id, { x: l.x + res.dx, y: l.y + res.dy })
    }
    if (!patches.size) return
    recordHistory()
    commit(localLayers.value.map(l => (patches.has(l.id) ? { ...l, ...patches.get(l.id)! } as LocalLayer : l)))
  }

  /** "Draw section" mode: while on, a marquee drag on the artboard creates a
   *  snapped rect instead of selecting (see `finishDrawSection`). A separate flag
   *  from every other tool mode — the host gates its own pointer handlers on it,
   *  same pattern as brush/pen/node-edit — so normal marquee selection is
   *  byte-identical when the mode is off. */
  const drawSectionActive = ref(false)
  function setDrawSectionActive(v: boolean) { drawSectionActive.value = v }

  function nearestGridLine(v: number, lines: number[]): number {
    if (!lines.length) return v
    let best = lines[0]!, bd = Math.abs(v - lines[0]!)
    for (const ln of lines) { const d = Math.abs(v - ln); if (d < bd) { bd = d; best = ln } }
    return best
  }

  /** End a "Draw section" drag: reuses the same `marquee` rect `startMarquee`/
   *  `moveMarquee` build, but on up snaps BOTH corners to the nearest grid line
   *  (falling back to the canvas edges [0,1] with no grid) and creates a rect
   *  instead of running the selection hit-test. Too-small drags (a click) are a
   *  no-op, same threshold as `endMarquee`. */
  function finishDrawSection() {
    const m = marquee.value; marquee.value = null
    if (!m) return
    const W = dims().w, H = dims().h
    const gl = gridSnapLines.value
    const xs = gl.xs.length ? gl.xs : [0, 1]
    const ys = gl.ys.length ? gl.ys : [0, 1]
    const x0 = nearestGridLine(Math.min(m.x0, m.x1), xs)
    const x1 = nearestGridLine(Math.max(m.x0, m.x1), xs)
    const y0 = nearestGridLine(Math.min(m.y0, m.y1), ys)
    const y1 = nearestGridLine(Math.max(m.y0, m.y1), ys)
    const wN = x1 - x0            // fraction of W, same convention as x0/x1
    const hN = ((y1 - y0) * H) / W // fraction of H → px → fraction of W (RectLayer.h convention)
    if (wN < 0.005 || hN < 0.002) return // a click, not a drag
    recordHistory()
    const layer = createRectLayer({
      x: x0 + wN / 2, y: y0 + (y1 - y0) / 2, w: wN, h: hN,
      fill: 'none', stroke: '', strokeWidth: 0,
    })
    commit([...localLayers.value, layer])
    selectLocal(layer.id)
  }

  // Consumer binds these to the artboard element (capture phase recommended so
  // it wins over node-drag). Returns true if it handled (hit a layer).
  // `forcedId` lets the caller supply the hit layer from a more accurate (e.g.
  // pixel-perfect, z-aware-with-wired) hit test; when omitted we fall back to the
  // editor's own bbox hit test. Pass `null` to mean "an explicit miss".
  function onCanvasPointerDown(e: PointerEvent, forcedId?: string | null): boolean {
    if ((e.target as HTMLElement)?.closest?.('[data-handle]')) return true
    const id = forcedId !== undefined ? forcedId : hitTest(e.clientX, e.clientY)
    if (id) {
      e.preventDefault(); e.stopPropagation()
      if (e.shiftKey) { toggleSelect(id); return true } // add/remove from multi-selection
      if (!selectedIds.value.has(id)) selectLocal(id)    // keep group if clicking within it
      else selectedId.value = id
      startMove(id, e)
      return true
    }
    selectedId.value = null; selectedIds.value = new Set()
    return false
  }
  function onCanvasDblClick(e: MouseEvent, forcedId?: string | null): boolean {
    const id = forcedId !== undefined ? forcedId : hitTest(e.clientX, e.clientY)
    if (!id) return false
    const l = localLayers.value.find(x => x.id === id)
    if (l?.kind === 'text') { e.preventDefault(); e.stopPropagation(); beginEdit(id); return true }
    return false
  }

  onScopeDispose(() => window.removeEventListener('pointermove', onMove))

  // ── Factories ────────────────────────────────────────────────────────────--
  function addText() {
    const fontDisplay = projectBrand?.activeKit.value?.fontDisplay
    const l = createTextLayer(fontDisplay ? { fontFamily: fontDisplay } : {})
    addLocal(l); nextTick(() => beginEdit(l.id)); return l
  }
  function addRect() { addLocal(createRectLayer()) }
  function addEllipse() { addLocal(createEllipseLayer()) }
  function addLine() { addLocal(createLineLayer()) }
  function addPolygon() { addLocal(createPolygonLayer()) }
  function addStar() { addLocal(createStarLayer()) }
  async function addImageFromFile(file: File) {
    if (!file.type.startsWith('image/')) return
    const ts = Date.now()
    const safe = `frame_${ts}_${(file.name || 'image.png').replace(/[^\w.-]+/g, '_')}`
    const fd = new FormData()
    fd.append('image', new File([file], safe, { type: file.type }))
    fd.append('overwrite', 'true')
    const res = await fetch('/upload/image', { method: 'POST', body: fd })
    if (!res.ok) throw new Error(`upload ${res.status}`)
    const name = (await res.json())?.name || safe
    const aspect = await new Promise<number>((resolve) => {
      const im = new Image()
      im.onload = () => resolve(im.naturalWidth && im.naturalHeight ? im.naturalWidth / im.naturalHeight : 1)
      im.onerror = () => resolve(1)
      im.src = `/view?${new URLSearchParams({ filename: name, type: 'input' })}`
    })
    addLocal(createImageLayer(name, aspect))
  }

  // Add an image layer from an already-uploaded input name (e.g. a generative-
  // fill result), with optional transform overrides (x/y/w/h).
  function addImageFromName(name: string, aspect = 1, partial: Partial<LocalLayer> = {}) {
    addLocal(createImageLayer(name, aspect, partial as any))
  }

  // Add an image layer from a canvas node's image URL (a snapshot: the URL is
  // fetched + uploaded to the input dir, exactly like drag-drop/paste).
  async function addImageFromCanvasSrc(src: string) {
    if (!src) return
    await addImageFromFile(await imageUrlToFile(src))
  }

  // Insert pre-built path layers (e.g. from SVG import / pen tool / AI vector).
  // All layers from one import are added together; the topmost is selected.
  function addPathLayers(layers: PathLayer[]) {
    if (!layers.length) return
    recordHistory()
    // Auto-group a multi-path import (e.g. an SVG) so it lists and moves as one
    // unit instead of flooding the layer panel with dozens of loose paths.
    if (layers.length > 1) {
      const gid = `g-${Date.now().toString(36)}-${++_groupSeq}`
      for (const l of layers) (l as any).groupId = gid
    }
    commit([...localLayers.value, ...layers])
    selectLocal(layers[layers.length - 1].id)
  }
  /** Parse an SVG string and add it as path layer(s), centered on the artboard. */
  async function addPathFromSvg(svg: string, opts: { targetWidth?: number; cx?: number; cy?: number } = {}) {
    const layers = await svgToPathLayers(svg, opts)
    addPathLayers(layers)
    return layers
  }

  /**
   * Apply a boolean op to the selected path layers (≥2). Replaces the operands
   * with a single result layer at the topmost operand's z-position.
   */
  async function applyBoolean(op: BooleanOp): Promise<boolean> {
    // Operate on any closed-outline shapes; convert rect/ellipse/line/polygon/star
    // → path so they can boolean with real paths. Keep the originals (with their
    // ids) for removal, and z-order is preserved (selectedLayers is z-ordered).
    const originals = selectedLayers.value.filter(l => l.kind === 'path' || l.kind === 'rect' || l.kind === 'ellipse' || l.kind === 'line'
      || l.kind === 'polygon' || l.kind === 'star')
    if (originals.length < 2) return false
    const operands = originals.map(l => shapeToPathLayer(l)).filter(Boolean) as PathLayer[]
    if (operands.length < 2) return false
    const result = await pathLayerBoolean(operands, op, dims())
    if (!result) return false
    const operandIds = new Set(originals.map(o => o.id))
    const arr = localLayers.value
    const topIdx = Math.max(...arr.map((l, i) => (operandIds.has(l.id) ? i : -1)))
    const next = arr.filter(l => !operandIds.has(l.id))
    next.splice(Math.min(topIdx - (operands.length - 1), next.length), 0, result)
    recordHistory()
    commit(next)
    selectLocal(result.id)
    return true
  }

  return {
    localLayers, selectedId, selected, selectLocal,
    setLocal, addLocal, deleteLocal, moveLocalZ,
    editingId, editingLayer, beginEdit, endEdit, registerEditFocus, focusEditTarget,
    boxPx, handlePositions, hud,
    selectionBox, selectionHandles, startGroupResize,
    hitTest, startScale, startRotate, startResize,
    onCanvasPointerDown, onCanvasDblClick,
    addText, addRect, addEllipse, addLine, addPolygon, addStar, addImageFromFile, addImageFromName, addImageFromCanvasSrc,
    addPathLayers, addPathFromSvg, deleteLayers, commit, recordHistory,
    writeOrder,
    background, setBackground,
    writeBackground: writeBg, // non-recording: for callers that batch a layers write + background write under ONE recordHistory()
    postEffects, setPostEffects,
    grid, setGrid,
    undo, redo, canUndo, canRedo,
    selectedIds, selectedLayers, toggleSelect, applyBoolean, alignSelected, nudgeSelection, duplicateSelection, handleEditorKey,
    copySelection, pasteClipboard,
    groupSelected, ungroupSelected, ungroupGroup, renameGroup, canGroup, canUngroup,
    setGroupHidden, setGroupLocked, setGroupOpacity, groupCascade,
    editingLayerNameId, layerNameDraft, startLayerRename, commitLayerRename, setLayerName,
    localGroups, commitBoth, writeGroups, setLayerGroup, setGroupParent, selectGroupById,
    snapGuides, marquee, startMarquee, moveMarquee, endMarquee,
    fillGridWithSections, resnapSelected,
    drawSectionActive, setDrawSectionActive, finishDrawSection,
  }
}
