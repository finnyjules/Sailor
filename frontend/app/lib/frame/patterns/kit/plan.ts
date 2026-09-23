import type { LocalLayer, TextLayer } from '~/composables/useCompositorLayers'
import { mulberry32 } from '~/lib/rng'
import { SHAPES, familyOf, shapeById } from '~/lib/shapes/catalog'
import { readGrid } from '~/lib/frame/gridConfig'
import { framePresentKeys } from '~/lib/compositor/frameStack'
import type { LayerGroup } from '~/lib/compositor/layerGroups'
import type { ResolvedPalette } from '../palette'
import type { FrameElements, LayerOp } from '../types'
import { kindOf } from '../types'
import { posterLayerViews } from '../frameContext'
import { inferElements, isNumberish } from '../hierarchy'
import { insertFromOps } from '../insert'
import { applyPlacement } from '../apply'
import { nextOrderFor } from '../order'
import { clearGroupPinsOfMoved, clearPinsOfMoved } from '../pins'
import { LAYOUTS } from '../layouts/catalog'
import { formatFor } from '~/lib/frame/formats'
import type { FrameFormat, KeepClear } from '~/lib/frame/formats'
import { makeSheet } from './sheet'
import type { Sheet, SheetOpts } from './sheet'
import { makeCanvasMeasure } from './measure'
import { boxOf, checkPlan } from './check'
import { elementsToOps } from './toOps'
import type { RoleTargets } from './toOps'
import { isOwned, mergeOwned } from './owned'
import { enumerate, lineOptions } from './vary'
import type { Candidate, Choice, LineOption } from './vary'
import type { BrandLogo, Content, El, Kind, LayoutDef, LayoutOut, Measure, PhotoEl, RoleKey } from './types'
import { STYLES } from './styles'
import type { StyleId } from './styles'

// ═══════════════════════ the planner ═══════════════════════
// Runs a kit layout on a real Frame: infer the user's elements, build the sheet from the
// Frame's shape and grid, run the layout for a `Choice`, check it, turn it into layer ops and
// owned pieces, and work out the next draw order. `applyLayoutToFrame` writes the result as
// ONE undo step. `candidatesForFrame` runs every variation through the very same pipeline,
// so each candidate is exactly what apply would produce.

export interface LayoutPlanArgs {
  props: Record<string, unknown> | undefined
  frameW: number
  frameH: number
  layoutId: string
  choice: Choice
  palette: ResolvedPalette
  /** Write colours from the role palette onto the user's own layers. Off by default. */
  recolour?: boolean
  /** Wired image slots connected on the node (for the present-keys reconcile). */
  connectedSlots: number[]
  /** Show image layouts with a stand-in when the frame has no image layer. */
  imageMode?: boolean
  /** A library shape to use when the frame has no shape layer. */
  shapeMode?: FrameElements['shapeMode']
  /** Injected in tests; default: the renderer-exact canvas measure over the frame's role layers. */
  measure?: Measure
  /** The style (Stage 3): its type on the sheet and its level order for a format's `carries`.
   *  Absent: `'swiss'` — Stages 1–2 exactly. */
  style?: StyleId
  /** The project's brand kit logo (ruling S2), passed through to `content.logo`. Absent: layouts
   *  simply omit it. */
  brandLogo?: BrandLogo
}

/** What apply writes through. `writeGroups` is required: a layout clears the pins of the groups
 *  it moves, and an editor without it would silently keep them. */
export interface LayoutEditor {
  recordHistory(): void
  commit(next: LocalLayer[]): void
  writeOrder(order: string[]): void
  writeGroups(next: LayerGroup[]): void
}

export interface LayoutPlan {
  layers: LocalLayer[]
  order: string[]
  did: string
  issues: string[]
  posterState: { patternId: string; seed: number; choice: Choice; roles: StoredRoles }
  /** The format the Frame is sized for (ruling P5) and the roles it hid because the format
   *  carries fewer levels (the UI quotes their text). Null: no format, the Stage 1 plan. */
  format: { id: string; label: string; hidden: RoleKey[] } | null
}

/** Which layer holds which role, as the last apply saw it (`sailor_posterState.roles`). */
export type StoredRoles = Partial<Record<RoleKey, string>>

/** Everything about the frame that does not depend on the choice. */
interface Prepared {
  def: LayoutDef
  index: number
  layers: LocalLayer[]
  elements: FrameElements
  content: Content
  kind: Kind
  targets: RoleTargets
  hasImage: boolean
  measure: Measure
  grid: ReturnType<typeof readGrid>
  /** The Frame's format (Stage 2), or null — then everything runs exactly as in Stage 1. */
  fmt: FrameFormat | null
  /** Roles on the Frame the format does not carry: removed from `content`, their layers hidden. */
  hidden: RoleKey[]
}

/** Every text role a Frame can hold: the targets, the measure and the stored roles cover all of
 *  them. Level order (which a format keeps) is the style's `levels`, not this list. */
const ROLES: RoleKey[] = ['title', 'details', 'date', 'caption', 'action']

/** Re-exported so existing importers keep working; the one copy lives in `hierarchy.ts`
 *  (which `inferElements` also needs it in, and can't import from here without a cycle). */
export { isNumberish }

function prepare(a: Omit<LayoutPlanArgs, 'choice'>): Prepared | null {
  const index = LAYOUTS.findIndex(l => l.id === a.layoutId)
  const def = LAYOUTS[index]
  if (!def) return null
  const layers = (a.props?.sailor_localLayers as LocalLayer[] | undefined) ?? []
  const elements = frameElements(a, layers)
  if (!elements.title) return null
  const content = contentOf(elements)
  if (a.brandLogo) content.logo = { ...a.brandLogo }
  // Levels (Stage 2): a format that carries N levels keeps the first N of the lines the Frame
  // has, in the style's level order (Swiss: title → details → date → action → caption); the rest
  // leave the content before the layout runs, and their layers are hidden.
  const fmt = formatFor(a.props, a.frameW, a.frameH)
  const hidden = hiddenRoles(fmt, content, a.style)
  for (const r of hidden) delete content[r]
  const kind = kindOf(elements.title.words.length) as Kind
  const targets: RoleTargets = {}
  for (const r of ROLES) if (elements[r]) targets[r] = elements[r]!.id
  if (elements.images[0]) targets.image = elements.images[0].id
  if (elements.shapes[0]) {
    targets.shape = elements.shapes[0].id
    const kind = layers.find(l => l.id === targets.shape)?.kind
    if (kind) targets.shapeKind = kind
  }
  const hasImage = elements.images.length > 0 || elements.imageMode
  const layerOf = (r: RoleKey) => {
    const id = elements[r]?.id
    return layers.find(l => l.id === id && l.kind === 'text') as TextLayer | undefined
  }
  const measure = a.measure ?? makeCanvasMeasure({
    title: layerOf('title'), details: layerOf('details'), date: layerOf('date'), caption: layerOf('caption'),
  })
  return { def, index, layers, elements, content, kind, targets, hasImage, measure, grid: readGrid(a.props), fmt, hidden }
}

type FrameArgs = Pick<LayoutPlanArgs, 'props' | 'frameW' | 'frameH' | 'shapeMode' | 'imageMode' | 'style'>

/** Which of the Frame's layers holds which role: size inference over the user's own layers, then
 *  the roles the last apply stored. A layout's own pieces (bands, rules, dots) are not the user's
 *  shapes: inference reads the user's layers only. */
function frameElements(a: FrameArgs, layers: LocalLayer[]): FrameElements {
  const userLayers = layers.filter(l => !isOwned(l as { owner?: { by: string } }))
  const inferred = inferElements(posterLayerViews({ ...a.props, sailor_localLayers: userLayers }), a.shapeMode ?? null, a.imageMode ?? false)
  return withStoredRoles(inferred, userLayers, (a.props?.sailor_posterState as { roles?: StoredRoles } | undefined)?.roles)
}

/** The text a layout places, by role. The title's words re-joined: the layout does its own line
 *  breaking. Call only when the Frame has a title. */
function contentOf(elements: FrameElements): Content {
  const content: Content = { title: elements.title!.words.join(' ') }
  for (const r of ['details', 'date', 'caption', 'action'] as const) {
    const t = elements[r]?.text
    if (t && t.trim()) content[r] = t
  }
  return content
}

/** The roles on this Frame a format does not carry: of the lines the Frame HAS, in the style's
 *  level order (Swiss: title → details → date → action → caption — Stage 2's order with the
 *  action one more level after the date), those past its `carries` (a two-line Frame on a
 *  two-level format hides nothing). None without a format, or when the format carries every level
 *  (`carries` absent). */
function hiddenRoles(fmt: FrameFormat | null, content: Content, style: StyleId = 'swiss'): RoleKey[] {
  if (!fmt || fmt.carries == null) return []
  return STYLES[style].levels.filter(r => content[r] != null).slice(fmt.carries)
}

/** The text of the lines this Frame's format leaves out (Stage 2), in role order — the same roles
 *  `planLayout` hides, worked out from the format and the Frame alone (no layout needs to have
 *  been planned or applied). Empty without a format, or without a title. */
export function hiddenLinesForFrame(a: FrameArgs): string[] {
  const fmt = formatFor(a.props, a.frameW, a.frameH)
  if (!fmt || fmt.carries == null) return []
  const elements = frameElements(a, (a.props?.sailor_localLayers as LocalLayer[] | undefined) ?? [])
  if (!elements.title) return []
  const content = contentOf(elements)
  return hiddenRoles(fmt, content, a.style).map(r => content[r] as string)
}

/** The ids of the text layers this Frame's format leaves out — the layers of the roles
 *  `hiddenLinesForFrame` quotes. Empty without a format, or without a title. */
export function hiddenLayerIdsForFrame(a: FrameArgs): string[] {
  const fmt = formatFor(a.props, a.frameW, a.frameH)
  if (!fmt || fmt.carries == null) return []
  const elements = frameElements(a, (a.props?.sailor_localLayers as LocalLayer[] | undefined) ?? [])
  if (!elements.title) return []
  return hiddenRoles(fmt, contentOf(elements), a.style).map(r => elements[r]!.id)
}

/** The roles the last apply stored win over size inference: an overlap layout (Ghost, Number
 *  behind, Overprint) sets the details or the date as large as the title or larger, and inferring
 *  from font size after it would pick the wrong title. A stored role holds while its layer still
 *  exists and still has text; a role whose layer is gone (or emptied) falls back to inference,
 *  unless the inferred layer already holds a stored role. One exception: a stored caption or details on
 *  the layer fresh inference reads as the action gives way to the action (ruling S3). */
function withStoredRoles(inferred: FrameElements, userLayers: LocalLayer[], stored: StoredRoles | undefined): FrameElements {
  if (!stored) return inferred
  const text = (id: string | undefined) => {
    const l = id ? userLayers.find(x => x.id === id && x.kind === 'text') as TextLayer | undefined : undefined
    const t = l?.text ?? ''
    return t.trim() ? t : null
  }
  const kept = new Map<RoleKey, string>()
  for (const r of ROLES) {
    const id = stored[r]
    if (!id || text(id) == null) continue
    // Ruling S3 over a pre-Stage-3 reading: a layer fresh inference reads as the action is the
    // action, even if an earlier apply stored it as the caption or the details (before Stage 3
    // "Shop now" had no role of its own). That slot falls back to fresh inference. A stored title
    // or date still wins — the overlap layouts need them.
    if ((r === 'caption' || r === 'details') && inferred.action?.id === id) continue
    kept.set(r, id)
  }
  if (!kept.size) return inferred
  const claimed = new Set(kept.values())
  const out: FrameElements = { ...inferred }
  for (const r of ROLES) {
    const id = kept.get(r)
    if (id) {
      const t = text(id)!
      out[r] = { role: r, id, text: t, words: t.trim().split(/\s+/).filter(Boolean) }
    } else if (inferred[r] && claimed.has(inferred[r]!.id)) {
      delete out[r]
    }
  }
  return out
}

/** Whether a layout can run on this frame at all: its kinds, and the image / shape / number it needs. */
function fitsFrame(p: Prepared): boolean {
  const { def, elements } = p
  if (!def.fits.includes(p.kind)) return false
  if (def.needs?.image && !p.hasImage) return false
  if (def.needs?.shape && !(elements.shapes.length > 0 || elements.shapeMode != null)) return false
  // A hidden role has left `content`, so a number in a hidden date never counts.
  if (def.needs?.number && !isNumberish(p.content.date)) return false
  // Built around the smaller text: no room for it in a format that carries fewer than three levels.
  if (def.smallText && p.fmt && (p.fmt.carries ?? 4) < 3) return false
  return true
}

/** The seed of a choice's random stream (the prototype's). */
const seedFor = (index: number, choice: Choice) => 7000 + index * 97 + 13 + choice.arr * 7919

/** The sheet options a format sets (Stage 2): its minimum text size, column count and side
 *  margins. Undefined without a format, so the sheet is exactly Stage 1's. */
function formatSheetOpts(fmt: FrameFormat | null): SheetOpts['format'] {
  if (!fmt) return undefined
  const keepSide = fmt.keep ? Math.max(fmt.keep.left, fmt.keep.right) : undefined
  return { view: fmt.view, nc: fmt.nc, ...(keepSide != null ? { keepSide } : {}) }
}

/** Run the layout for one choice — the ONE pipeline shared by plan and candidates. Wide frames
 *  with an image get the prototype's side image (`runCandidate`): the layout composes on the
 *  first 62% of the columns (the last ones when the image is on the left) and the image bleeds
 *  full height on the other side.
 *
 *  A format with keep-clear areas (Stage 2, the prototype's `runCandidate`): the layout composes
 *  inside the band the platform leaves uncovered, everything is moved down by the top inset, and
 *  a panel or a bleeding image that fills the band runs on to the real edges — only text keeps
 *  clear. The returned sheet is then the full-height one (for the checker and the ops). */
function runChoice(p: Prepared, a: { frameW: number; frameH: number; style?: StyleId }, choice: Choice): Run {
  const fmt = p.fmt
  const keep = fmt?.keep
  const H_full = 100 * a.frameH / a.frameW
  const inset = keep ? H_full * keep.top : 0
  const format = formatSheetOpts(fmt)
  const opts: SheetOpts = {
    frameW: a.frameW, frameH: a.frameH, grid: p.grid, measure: p.measure,
    scale: choice.scale === 'quiet' ? 0.8 : 1, flip: choice.side === 'left',
    ...(format ? { format } : {}),
    ...(a.style ? { style: a.style } : {}),
    ...(keep ? { composeH: H_full * (1 - keep.top - keep.bottom) } : {}),
  }
  let S = makeSheet(opts)
  let side: PhotoEl | null = null
  const wide = S.H < 70
  if (wide && p.hasImage && !p.def.needs?.image && !p.def.ownPhoto) {
    const { NC, Xr, G, W, H, PHOTO_ASPECT } = S
    const n = Math.round(NC * 0.62)
    if (choice.side === 'left') {
      const colA = NC - n + 1
      const x1 = Xr(colA) - G, w = Math.max(x1, H / PHOTO_ASPECT), h = w * PHOTO_ASPECT
      side = { k: 'p', x: x1 - w, y: (H - h) / 2, w, h, role: 'photo', bleed: true }
      S = makeSheet({ ...opts, colRange: [colA, NC] })
    } else {
      const x0 = Xr(n + 1), w = Math.max(W - x0, H / PHOTO_ASPECT), h = w * PHOTO_ASPECT
      side = { k: 'p', x: x0, y: (H - h) / 2, w, h, role: 'photo', bleed: true }
      S = makeSheet({ ...opts, colRange: [1, n] })
    }
  }
  const c = p.content
  const words = c.title.split(' ')
  const lineOpts = lineOptions(p.kind, c.title, p.def.oneLineFirst)
  const lines = (lineOpts[choice.lines] ?? lineOpts[0]!).lines
  const r = mulberry32(seedFor(p.index, choice))
  const out = p.def.fn(S, { c, kind: p.kind, ph: p.hasImage && !side, r, words, lines, arr: choice.arr })
  // Run-off keeps its image OVER the title (the title runs under it); everything else puts it behind.
  if (side && p.def.id === 'runoff') { side.ok = true; out.els.push(side) } else if (side) out.els.unshift(side)
  if (!keep) return { out, S, side, ...(a.style ? { style: a.style } : {}) }

  // Compose-in-the-band → the real frame: move down by the top inset, then extend what fills the band.
  const { W, PHOTO_ASPECT } = S
  const bandEnd = H_full * (1 - keep.bottom)
  for (const e of out.els) {
    const m = e as unknown as Record<string, number | undefined>
    for (const k of ['y', 'top', 'base', 'cy'] as const) if (m[k] != null) m[k] = m[k]! + inset
  }
  for (const e of out.els) {
    // A band (Stage 3, the prototype's scrim rule) that starts at the band's top runs on to the
    // real top, or that ends at its bottom runs on to the real bottom — its solid part keeps its
    // length, so the fade stays where the layout put it.
    if (e.k === 'band') {
      if (e.side === 'top' && e.y <= inset + 0.5) { const sp = e.h * e.solid + e.y; e.h += e.y; e.y = 0; e.solid = sp / e.h }
      else if (e.side === 'bottom' && e.y + e.h >= bandEnd - 0.5) { const sp = e.h * e.solid + (H_full - e.y - e.h); e.h = H_full - e.y; e.solid = sp / e.h }
      continue
    }
    // A panel, a band or a bleeding rect that touches an edge of the band runs on to that real
    // edge (the prototype's scrim rule, applied to rects); one that spans the band fills 0..H_full.
    if (e.k === 'r' && !e.rot && (e.role === 'panel' || e.role === 'band' || e.bleed)) {
      const bottom = e.y + e.h
      if (e.y <= inset + 0.5) e.y = 0
      if (bottom >= bandEnd - 0.5) e.h = H_full - e.y
      else e.h = bottom - e.y
      continue
    }
    // A bleeding circle whose top reaches the band's top margin (above the first design line,
    // where only edge-bound pieces go) belongs to the top edge: move it up by the inset so it sits
    // at the REAL top again (Shape bleed). Not a circle that holds text (`inside`) — moving it
    // would pull the circle away from its text.
    if (e.k === 'c' && e.bleed && e.cy - e.r <= inset + S.M
      && !out.els.some(t => t.k === 't' && t.inside != null && t.inside === e.role)) {
      e.cy -= inset
      continue
    }
    if (e.k !== 'p' || !e.bleed || e.y > inset + 0.5 || e.y + e.h < bandEnd - 0.5) continue
    if (e === side) {
      // The wide band's side image runs on to the real top and bottom on ITS side (the
      // prototype's centred cover would spread it across the whole frame, over the type).
      const w = Math.max(e.w, H_full / PHOTO_ASPECT), h = w * PHOTO_ASPECT
      Object.assign(e, { x: choice.side === 'left' ? e.x + e.w - w : e.x, y: (H_full - h) / 2, w, h })
      continue
    }
    const w = Math.max(W, H_full / PHOTO_ASPECT, e.w), h = w * PHOTO_ASPECT
    Object.assign(e, { x: e.x + (e.w - w) / 2, y: (H_full - h) / 2, w, h })
  }
  // The checker and the ops work on the real, full-height frame.
  const { composeH: _band, colRange: _cols, ...fullOpts } = opts
  return { out, S: makeSheet(fullOpts), side, keep, fullH: H_full, ...(a.style ? { style: a.style } : {}) }
}

interface Run { out: LayoutOut; S: Sheet; side: PhotoEl | null; keep?: KeepClear; fullH?: number; style?: StyleId }

/** The checker, with one adaptation for the side image of a wide frame: there the side image's
 *  edge is the page's edge for the type, so a `bleed` premise holds when the role runs off the
 *  page OR runs under the side image (Run-off's title on a wide frame runs under the image, as
 *  in the prototype). Every other rule and premise is checked unchanged. */
function checkRun({ out, S, side, keep, fullH, style }: Run, premise: LayoutDef['premise']): string[] {
  const bleed = premise?.bleed ?? []
  // Swiss (no style) checks exactly as in Stages 1–2; a style adds its own rules (rule 10).
  const opts = keep || (style && style !== 'swiss')
    ? { ...(keep ? { keep, fullH } : {}), ...(style && style !== 'swiss' ? { style } : {}) }
    : undefined
  if (!side || !bleed.length) return checkPlan(out.els, S, premise, opts)
  const issues = checkPlan(out.els, S, { ...premise, bleed: [] }, opts)
  const sb = boxOf(side, S)!
  for (const role of bleed) {
    const e = out.els.find(x => x.k !== 'missing' && x.role === role)
    const b = e ? boxOf(e, S) : null
    const runsOff = b != null && (b.x0 < 0 || b.y0 < 0 || b.x1 > S.W || b.y1 > S.H)
    // "Under" means a real overlap — the checker's collision threshold (0.25 units on both axes).
    const under = b != null && Math.min(b.x1, sb.x1) - Math.max(b.x0, sb.x0) > 0.25 && Math.min(b.y1, sb.y1) - Math.max(b.y0, sb.y0) > 0.25
    if (!runsOff && !under) issues.push(`promise broken: ${role} should run off the page`)
  }
  return issues
}

const rolesOf = (el: FrameElements): StoredRoles => {
  const out: StoredRoles = {}
  for (const r of ROLES) if (el[r]) out[r] = el[r]!.id
  return out
}

/** The shape picker's library shape for a frame with no shape layer (the old engine's
 *  `pickShape`): a named shape, or a seeded pick from a family. Its own random stream, so the
 *  layout's randomness is untouched. Undefined with no picker choice or an unknown shape. */
function pickLibraryShape(mode: FrameElements['shapeMode'], seed: number): { id: string; aspect: number } | undefined {
  if (!mode) return undefined
  let id: string | undefined
  if ('id' in mode) id = mode.id
  else {
    const pool = SHAPES.filter(s => familyOf(s.id) === mode.family)
    if (pool.length) id = pool[Math.floor(mulberry32(seed * 31 + 5)() * pool.length)]!.id
  }
  const sh = id ? shapeById(id) : undefined
  return sh ? { id: sh.id, aspect: sh.box[3] / sh.box[2] } : undefined
}

/** Run a layout on a frame and return the plan. Pure: nothing is written. Null when the layout
 *  is unknown, the frame has no title, or the layout does not fit the frame (`fitsFrame`). */
export function planLayout(a: LayoutPlanArgs): LayoutPlan | null {
  const p = prepare(a)
  if (!p || !fitsFrame(p)) return null
  const ran = runChoice(p, a, a.choice)
  const { out, S } = ran
  const issues = checkRun(ran, p.def.premise)

  const libraryShape = p.targets.shape ? undefined : pickLibraryShape(p.elements.shapeMode, seedFor(p.index, a.choice))
  const targets = libraryShape ? { ...p.targets, libraryShape } : p.targets
  // Stage 3 pieces: the button adapts to the action text's own colour (ruling S1), the logo comes
  // from the brand kit (ruling S2). Only passed when a layout drew them, so Swiss calls are unchanged.
  const pieces: Parameters<typeof elementsToOps>[5] = {}
  if (out.els.some(e => e.k === 'btn') && p.targets.action) {
    pieces.actionColor = (p.layers.find(l => l.id === p.targets.action) as TextLayer | undefined)?.color
    if (a.recolour) pieces.recolour = true
  }
  if (out.els.some(e => e.k === 'logo') && p.content.logo) pieces.logo = p.content.logo
  if (p.hidden.length) pieces.hide = p.hidden
  const el = elementsToOps(out.els, S, targets, { w: a.frameW, h: a.frameH }, a.palette, Object.keys(pieces).length ? pieces : undefined)
  // Stand-in image / library shape sentinels become real layers first (existing path).
  const ins = insertFromOps(p.layers, el.ops, a.palette, `stand-${p.def.id}-${seedFor(p.index, a.choice)}`)
  // Ruling R7: merge the owned pieces FIRST, so `present` (and so the order) includes them.
  const merged = mergeOwned(ins.layers, el.owned)
  // An owned piece that already existed keeps its old id — point its op at that id.
  const ownedId = new Map<string, string>()
  for (const l of merged) {
    const key = (l as { owner?: { by: string; key: string } }).owner
    if (key?.by === 'layout') ownedId.set(key.key, l.id)
  }
  const ops: LayerOp[] = ins.ops.map(op => (op.insert && ownedId.has(op.insert.key)
    ? { ...op, target: ownedId.get(op.insert.key)! }
    : op))
  const next = applyPlacement(merged, { ops, did: out.did }, p.elements, a.palette, { recolour: a.recolour ?? false })

  const saved = (a.props?.sailor_stackOrder as string[] | undefined) ?? []
  const present = framePresentKeys(a.connectedSlots, next)
  const order = nextOrderFor(saved, present, ops, p.elements, ins.inserted)
  return {
    layers: next, order, did: out.did, issues,
    posterState: { patternId: p.def.id, seed: seedFor(p.index, a.choice), choice: { ...a.choice }, roles: rolesOf(p.elements) },
    format: p.fmt ? { id: p.fmt.id, label: p.fmt.label, hidden: [...p.hidden] } : null,
  }
}

/** Apply a layout as ONE undo step: history → layers (pins of moved layers cleared) → groups →
 *  order. Refuses (`ok: false`, nothing written) when the plan has checker issues. */
export function applyLayoutToFrame(a: LayoutPlanArgs & { editor: LayoutEditor }): { ok: boolean; posterState?: LayoutPlan['posterState'] } {
  const plan = planLayout(a)
  if (!plan || plan.issues.length) return { ok: false }
  const before = (a.props?.sailor_localLayers as LocalLayer[] | undefined) ?? []
  const groups = (a.props?.sailor_localGroups as LayerGroup[] | undefined) ?? []
  const nextGroups = clearGroupPinsOfMoved(before, plan.layers, groups)
  a.editor.recordHistory()
  a.editor.commit(clearPinsOfMoved(before, plan.layers))
  if (nextGroups) a.editor.writeGroups(nextGroups)
  a.editor.writeOrder(plan.order)
  return { ok: true, posterState: plan.posterState }
}

/** Every checked, distinct variation of a layout on this frame, best first (see `enumerate`).
 *  Empty when the layout does not fit the frame's content. */
export function candidatesForFrame(a: Omit<LayoutPlanArgs, 'choice'>): Candidate[] {
  const p = prepare(a)
  if (!p || !fitsFrame(p)) return []
  const runs = new WeakMap<LayoutOut, Run>()
  // Each choice runs on its own sheet (scale/flip can differ) — so an element's box needs the
  // Sheet its own run built, not just any Sheet; keyed per element rather than per `LayoutOut`
  // because `enumerate`'s cover check (`vary.ts`) only ever hands us elements, not their `out`.
  const sheetOf = new WeakMap<El, Sheet>()
  const run = (choice: Choice) => {
    const ran = runChoice(p, a, choice)
    runs.set(ran.out, ran)
    for (const e of ran.out.els) sheetOf.set(e, ran.S)
    return ran.out
  }
  const check = (out: LayoutOut) => checkRun(runs.get(out)!, p.def.premise)
  const format = formatSheetOpts(p.fmt)
  const infoSize = makeSheet({ frameW: a.frameW, frameH: a.frameH, grid: p.grid, measure: p.measure, ...(format ? { format } : {}), ...(a.style ? { style: a.style } : {}) }).INFO.size
  const box = (e: El) => {
    const S = sheetOf.get(e)
    return S ? boxOf(e, S) : null
  }
  return enumerate(p.def, { kind: p.kind, title: p.content.title, hasImage: p.hasImage, run, check, infoSize, boxOf: box })
}

/** The ways this frame's title can break into lines for a layout (`lineOptions` on the frame's
 *  own title), so a picker can quote them. Empty when the layout is unknown or does not fit. */
export function lineOptionsForFrame(a: Omit<LayoutPlanArgs, 'choice'>): LineOption[] {
  const p = prepare(a)
  if (!p || !fitsFrame(p)) return []
  return lineOptions(p.kind, p.content.title, p.def.oneLineFirst)
}
