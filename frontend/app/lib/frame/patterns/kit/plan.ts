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
import { layoutEntry } from '../layouts/catalog'
import { formatFor } from '~/lib/frame/formats'
import type { FrameFormat, KeepClear } from '~/lib/frame/formats'
import { makeSheet } from './sheet'
import type { Sheet, SheetOpts } from './sheet'
import { makeCanvasMeasure } from './measure'
import { boxOf, checkPlan } from './check'
import { elementsToOps } from './toOps'
import { hex6, isSolid, pieceFills } from './contrast'
import type { FillCtx, PieceFill, PieceFills } from './contrast'
import { contrastRatio } from '../palette'
import type { RoleTargets } from './toOps'
import { isOwned, mergeOwned } from './owned'
import { enumerate, lineOptions } from './vary'
import type { Candidate, Choice, LineOption } from './vary'
import type { BrandLogo, Content, El, FaceKey, Kind, LayoutDef, LayoutOut, Measure, PhotoEl, RoleKey } from './types'
import { STYLES } from './styles'
import { BASE_ROLES, elementsOf, NEW_TEXT_ROLES, readContent } from './content'
import type { ContentTags, ReadContent } from './content'
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
  /** Lines the Frame has that this layout does not place (a style layout only — e.g. Strip sets
   *  no details or fine print), in role order, with their text for the Layout tab to quote. Their
   *  layers are hidden the way a format's levels are (a hidden-only op, tracked `visible`), so a
   *  later layout that places them shows them again. Always empty for Swiss. */
  notPlaced: { role: RoleKey; text: string }[]
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
  hidden: FaceKey[]
  /** The style asked for (absent: `'swiss'`): only its own layouts fit. */
  style: StyleId
  /** The height (kit units) the layout composes on — for `wideOnly`. */
  composedH: number
  /** What the contrast picker (ruling R6) reads: the palette, recolour, the user's own colours. */
  fillCtx: FillCtx
  /** The Frame's content (Stage 4, `kit/content.ts`) in the view the layout reads (ruling C2). */
  read: ReadContent
  /** The base view's elements (ruling C2): what `posterState.roles` stores, whatever the view, so
   *  applying a Stage 4 layout never changes how the other layouts read the Frame. */
  baseElements: FrameElements
  /** The face a layout's own words are set in (Stage 4, ruling R10): the family AND weight of the
   *  layer the caption face is measured from (the caption, else the first content line measured in
   *  that face), else the title's — so what the checker measured is what is drawn. */
  ownFace: { family: string; weight: number } | undefined
}

/** Every text role a Frame can hold: the targets, the measure and the stored roles cover all of
 *  them. Level order (which a format keeps) is the style's `levels`, not this list. */
const ROLES: FaceKey[] = ['title', 'details', 'date', 'caption', 'action']
/** Every role a text layer can hold (Stage 4 adds the content roles; they are not levels). */
const TEXT_ROLES: RoleKey[] = [...ROLES, ...NEW_TEXT_ROLES]

/** Re-exported so existing importers keep working; the one copy lives in `hierarchy.ts`
 *  (which `inferElements` also needs it in, and can't import from here without a cycle). */
export { isNumberish }

function prepare(a: Omit<LayoutPlanArgs, 'choice'>): Prepared | null {
  const entry = layoutEntry(a.layoutId)
  if (!entry) return null
  const { def, index } = entry
  const layers = (a.props?.sailor_localLayers as LocalLayer[] | undefined) ?? []
  // Ruling C2: a Stage 4 layout (`needsContent`) reads the content view; every other layout reads
  // the base view — the Stage 1–3 roles exactly as before, whatever the Frame's new content.
  const views = readFrame(a, layers)
  const contentView = def.needsContent != null
  const { elements, read } = contentView ? views.content : views.base
  if (!elements.title) return null
  const content = contentOf(elements)
  if (a.brandLogo) content.logo = { ...a.brandLogo }
  // Stage 4 content shapes (not levels: a format's `carries` never hides them).
  if (contentView) {
    if (read.review) content.review = read.review
    if (read.list) content.list = read.list
    if (read.compare) content.compare = read.compare
    if (read.stat) content.stat = read.stat
  }
  // Levels (Stage 2): a format that carries N levels keeps the first N of the lines the Frame
  // has, in the style's level order (Swiss: title → details → date → action → caption); the rest
  // leave the content before the layout runs, and their layers are hidden.
  const fmt = formatFor(a.props, a.frameW, a.frameH)
  const hidden = hiddenRoles(fmt, content, a.style)
  for (const r of hidden) delete content[r]
  const kind = kindOf(elements.title.words.length) as Kind
  const targets: RoleTargets = {}
  for (const r of ROLES) if (elements[r]) targets[r] = elements[r]!.id
  if (contentView) {
    for (const r of NEW_TEXT_ROLES) if (read.roles[r]) targets[r] = read.roles[r]
    // The first image is the one that is not the second (a tag can name any image the second).
    const firstImage = elements.images.find(i => i.id !== read.roles.image2)
    if (firstImage) targets.image = firstImage.id
    if (read.roles.image2) targets.image2 = read.roles.image2
  } else if (elements.images[0]) targets.image = elements.images[0].id
  if (elements.shapes[0]) {
    targets.shape = elements.shapes[0].id
    const kind = layers.find(l => l.id === targets.shape)?.kind
    if (kind) targets.shapeKind = kind
  }
  const hasImage = elements.images.length > 0 || elements.imageMode
  const layerOf = (r: RoleKey) => {
    const id = targets[r]
    return id ? layers.find(l => l.id === id && l.kind === 'text') as TextLayer | undefined : undefined
  }
  // The action is measured in its own layer's face (a button grows with it). Stage 4 roles are
  // measured in the details face (quote, stat) or the caption face (the rest — `faceOf`): with no
  // details or caption layer of its own, that face is the content line's layer.
  const captionFace = layerOf('caption') ?? layerOf('by') ?? layerOf('list') ?? layerOf('statline') ?? layerOf('rating') ?? layerOf('them')
  const measure = a.measure ?? makeCanvasMeasure({
    title: layerOf('title'), details: layerOf('details') ?? layerOf('quote') ?? layerOf('stat'), date: layerOf('date'),
    caption: captionFace,
    action: layerOf('action'),
  })
  const faceLayer = captionFace ?? layerOf('title')
  const ownFace = faceLayer ? { family: faceLayer.fontFamily, weight: faceLayer.fontWeight } : undefined
  // The height the layout composes on: the band a format leaves uncovered, or the whole frame.
  const fullH = 100 * a.frameH / a.frameW
  const composedH = fmt?.keep ? fullH * (1 - fmt.keep.top - fmt.keep.bottom) : fullH
  // Ruling R6: the colour each text is drawn in (the user's own, recolour off), and the user's own
  // shape's fill (a layout's `shape` piece is drawn by that layer).
  const colourOf = (id: string | undefined) => id ? (layers.find(l => l.id === id) as { color?: unknown } | undefined)?.color : undefined
  const shapeLayer = targets.shape ? layers.find(l => l.id === targets.shape) as { fill?: unknown } | undefined : undefined
  const fillCtx: FillCtx = {
    palette: a.palette, recolour: a.recolour ?? false, hasAction: !!targets.action,
    layerColour: role => (TEXT_ROLES as string[]).includes(role) && targets[role as RoleKey] ? colourOf(targets[role as RoleKey]) ?? null : undefined,
    ...(shapeLayer ? { shapeFill: shapeLayer.fill ?? null } : {}),
  }
  return { def, index, layers, elements, baseElements: views.base.elements, content, kind, targets, hasImage, measure, grid: readGrid(a.props), fmt, hidden, style: a.style ?? 'swiss', composedH, fillCtx, read, ownFace }
}

type FrameArgs = Pick<LayoutPlanArgs, 'props' | 'frameW' | 'frameH' | 'shapeMode' | 'imageMode' | 'style'>

interface View { elements: FrameElements; read: ReadContent }

/** Which of the Frame's layers holds which role: size inference over the user's own layers, then
 *  the roles the last apply stored. A layout's own pieces (bands, rules, dots) are not the user's
 *  shapes: inference reads the user's layers only.
 *
 *  Stage 4 — two views (ruling C2), the user's tags (`sailor_posterState.tags`) winning in both:
 *  - BASE: the Stage 1–3 roles exactly as before. Only base-role tags and `'unused'` apply (those
 *    layers are left out of size inference and the stored roles); nothing is recognised. Every
 *    layout without `needsContent` reads it.
 *  - CONTENT: every tag applies, R2 recognition runs, and the lines claimed as new content leave
 *    their base roles, which are re-inferred from the remaining lines. Stage 4 layouts read it.
 *  With no tags the base view is exactly Stage 3's; with none of the new content either, the two
 *  views agree. */
function readFrame(a: FrameArgs, layers: LocalLayer[]): { base: View; content: View } {
  const userLayers = layers.filter(l => !isOwned(l as { owner?: { by: string } }))
  const st = a.props?.sailor_posterState as { roles?: StoredRoles; tags?: ContentTags } | undefined
  const tags = st?.tags && Object.keys(st.tags).length ? st.tags : undefined
  // Base-role tags and 'unused' settle a layer in both views; new-content tags only in the content view.
  const baseSettled = new Set(Object.entries(tags ?? {})
    .filter(([, t]) => t === 'unused' || (BASE_ROLES as readonly string[]).includes(t)).map(([id]) => id))
  const inferWithout = (out: Set<string>): FrameElements => {
    const kept = out.size ? userLayers.filter(l => !out.has(l.id)) : userLayers
    return withStoredRoles(
      inferElements(posterLayerViews({ ...a.props, sailor_localLayers: kept }), a.shapeMode ?? null, a.imageMode ?? false),
      kept, st?.roles)
  }
  const inferred = inferWithout(baseSettled)
  const baseRead = readContent(userLayers, inferred, tags, { view: 'base' })
  const read = readContent(userLayers, inferred, tags, {
    reinfer: claimed => inferWithout(new Set([...baseSettled, ...claimed])),
  })
  return {
    base: { elements: elementsOf(baseRead, inferred, userLayers), read: baseRead },
    content: { elements: elementsOf(read, inferred, userLayers), read },
  }
}

/** The base view's elements (ruling C2) — what every Stage 1–3 reader of the Frame uses. */
const frameElements = (a: FrameArgs, layers: LocalLayer[]): FrameElements => readFrame(a, layers).base.elements

/** The Frame's content as the Stage 4 layouts read it (the content view, ruling C2): which layer
 *  holds which role — the Stage 1–3 roles and the content roles — and the review / list /
 *  comparison / stat it makes. */
export function contentForFrame(a: FrameArgs): ReadContent {
  return readFrame(a, (a.props?.sailor_localLayers as LocalLayer[] | undefined) ?? []).content.read
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
function hiddenRoles(fmt: FrameFormat | null, content: Content, style: StyleId = 'swiss'): FaceKey[] {
  if (!fmt || fmt.carries == null) return []
  // Levels are the Stage 1–3 text roles only (the Stage 4 content roles are never levels).
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

/** Which layer holds which role, as the planner reads the Frame (the stored roles, then size
 *  inference) — the Layout tab's face pickers target these, so they agree with the plans. */
export function roleIdsForFrame(a: FrameArgs): StoredRoles {
  return rolesOf(frameElements(a, (a.props?.sailor_localLayers as LocalLayer[] | undefined) ?? []))
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
  const kept = new Map<FaceKey, string>()
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

/** Whether a layout can run on this frame at all: its style, its kinds, and the image / shape / number it needs. */
function fitsFrame(p: Prepared): boolean {
  const { def, elements } = p
  // Stage 3: a style's library holds only its own layouts (no style asked for: Swiss).
  if ((def.style ?? 'swiss') !== p.style) return false
  // One row for wide formats: only on a wide sheet (the prototype's `wideOnly`, `H < 70`).
  if (def.wideOnly && !(p.composedH < 70)) return false
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
/** Ruling R7: `cta: 'native'` on a platform-button format with an action line drops the action
 *  from the content the layout runs on — no button is built, no action text is placed (it lands
 *  in `notPlaced`, ruling R7). Every other case (no platform button, no action, `cta: 'drawn'`
 *  or unset) runs on `p.content` unchanged. */
function contentForChoice(p: Prepared, choice: Choice): Content {
  if (choice.cta !== 'native' || !offersCta(p)) return p.content
  const { action: _action, ...rest } = p.content
  return rest
}

/** Ruling R7: the platform's-own-button choice is a Performance thing (the style table's Button
 *  row lists "pill, drawn or platform's own" only for Performance — Editorial's is a link,
 *  Street's a hard-edged box; neither names a platform alternative), offered only on a format
 *  that draws its own button, with a Frame that has an action line to hide. */
const offersCta = (p: Prepared): boolean => p.style === 'performance' && !!p.fmt?.platformButton && !!p.content.action

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
  const c = contentForChoice(p, choice)
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
    for (const k of ['y', 'top', 'base', 'cy', 'y1', 'y2'] as const) if (m[k] != null) m[k] = m[k]! + inset
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
function checkRun({ out, S, side, keep, fullH, style }: Run, premise: LayoutDef['premise'], pf: PieceFills): string[] {
  const bleed = premise?.bleed ?? []
  // Swiss (no style) checks exactly as in Stages 1–2; a style adds its own rules (rule 10). Rule 10
  // reads the picker's buttons: only a filled one covers its label (an outline or a link does not).
  const styled = style && style !== 'swiss'
  const opts = keep || styled
    ? { ...(keep ? { keep, fullH } : {}), ...(styled ? { style, btnFilled: (e: El) => isSolid(pf.fills.get(e)) } : {}) }
    : undefined
  const issues = !side || !bleed.length
    ? checkPlan(out.els, S, premise, opts)
    : (() => {
        const withoutBleed = checkPlan(out.els, S, { ...premise, bleed: [] }, opts)
        const sb = boxOf(side, S)!
        for (const role of bleed) {
          const e = out.els.find(x => x.k !== 'missing' && x.role === role)
          const b = e ? boxOf(e, S) : null
          const runsOff = b != null && (b.x0 < 0 || b.y0 < 0 || b.x1 > S.W || b.y1 > S.H)
          // "Under" means a real overlap — the checker's collision threshold (0.25 units both axes).
          const under = b != null && Math.min(b.x1, sb.x1) - Math.max(b.x0, sb.x0) > 0.25 && Math.min(b.y1, sb.y1) - Math.max(b.y0, sb.y0) > 0.25
          if (!runsOff && !under) withoutBleed.push(`promise broken: ${role} should run off the page`)
        }
        return withoutBleed
      })()
  // Task 4: the style's own check (product visibility for Performance), in addition to the
  // shared rules above.
  const styleCheck = style && style !== 'swiss' ? STYLES[style].check : undefined
  if (styleCheck) issues.push(...styleCheck(out.els, { W: S.W, H: S.H }, keep))
  // Ruling R6: text must be readable on the piece it sits on.
  issues.push(...pf.issues)
  return issues
}

/** The contrast picker over a run (ruling R6) — the one result the checker and toOps share. */
const fillsOf = (p: Prepared, { out, S }: Run): PieceFills => pieceFills(out.els, S, p.fillCtx)

/** A piece's fill (`pieceFills`'s pick, ruling R6), resolved to a hex and measured against the
 *  page (`palette.field`) — Stage 4 ruling R8's button-contrast reward reads this. `undefined`:
 *  no fill (an outline or a link, or the piece was never a candidate for one). */
function fillContrastOf(fill: PieceFill | undefined, palette: ResolvedPalette): number | undefined {
  if (fill == null) return undefined
  const field = hex6(palette.field)
  if (!field) return undefined
  const bg = typeof fill === 'string' ? hex6(palette[fill]) : 'plain' in fill ? hex6(fill.plain) : null
  return bg ? contrastRatio(bg, field) : undefined
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
  const pf = fillsOf(p, ran)
  const issues = checkRun(ran, p.def.premise, pf)

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
  // A layout's own words (Stage 4, ruling R10) take the caption layer's family and weight — only
  // passed when drawn.
  if (out.els.some(e => e.k === 'own') && p.ownFace) { pieces.ownFamily = p.ownFace.family; pieces.ownWeight = p.ownFace.weight }
  // The fills the check just read (ruling R6): only when a piece carries text, so a layout without
  // one (every Swiss layout but Badge, Knockout and the panels) calls toOps exactly as before.
  if (pf.fills.size) pieces.fills = pf.fills
  // A style layout may leave a line out (Strip: no details, no fine print). Its layer is hidden
  // like a level the format does not carry, rather than left where it was under the new layout.
  const notPlaced = notPlacedRoles(p, out.els, a.style)
  const hide = [...p.hidden, ...notPlaced]
  if (hide.length) pieces.hide = hide
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
    posterState: { patternId: p.def.id, seed: seedFor(p.index, a.choice), choice: { ...a.choice }, roles: rolesOf(p.baseElements) },
    format: p.fmt ? { id: p.fmt.id, label: p.fmt.label, hidden: [...p.hidden] } : null,
    notPlaced: notPlaced.map(role => ({ role, text: p.content[role] as string })),
  }
}

/** The text roles in the (carried) content that no text element of the layout's output places
 *  (base role: `title2` counts as `title`; a ring is the title). Swiss (no style, or `'swiss'`):
 *  the action line only (ruling R9) — no Swiss layout places it, so it is hidden and quoted rather
 *  than stranded where it was; every other Swiss line is as in Stages 1–2. */
function notPlacedRoles(p: Prepared, els: El[], style: StyleId | undefined): FaceKey[] {
  const placed = new Set(els.filter(e => e.k === 't' || e.k === 'ring').map(e => (e.role ?? '').replace(/\d+$/, '')))
  const roles: FaceKey[] = !style || style === 'swiss' ? ['action'] : ROLES
  return roles.filter(r => p.content[r] != null && !placed.has(r))
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
  const runs = new WeakMap<LayoutOut, Run & { pf: PieceFills }>()
  // Each choice runs on its own sheet (scale/flip can differ) — so an element's box needs the
  // Sheet its own run built, not just any Sheet; keyed per element rather than per `LayoutOut`
  // because `enumerate`'s cover check (`vary.ts`) only ever hands us elements, not their `out`.
  const sheetOf = new WeakMap<El, Sheet>()
  const run = (choice: Choice) => {
    const ran = runChoice(p, a, choice)
    runs.set(ran.out, { ...ran, pf: fillsOf(p, ran) })
    for (const e of ran.out.els) sheetOf.set(e, ran.S)
    return ran.out
  }
  const check = (out: LayoutOut) => { const r = runs.get(out)!; return checkRun(r, p.def.premise, r.pf) }
  const format = formatSheetOpts(p.fmt)
  const infoSize = makeSheet({ frameW: a.frameW, frameH: a.frameH, grid: p.grid, measure: p.measure, ...(format ? { format } : {}), ...(a.style ? { style: a.style } : {}) }).INFO.size
  const box = (e: El) => {
    const S = sheetOf.get(e)
    return S ? boxOf(e, S) : null
  }
  // Task 4: the style's own reward, added to the Stage 1 score. Swiss (no style, or 'swiss')
  // passes no `rank` — candidatesForFrame's scores stay exactly Stage 1's.
  const styleRank = a.style && a.style !== 'swiss' ? STYLES[a.style].rank : undefined
  const W = 100, H = 100 * a.frameH / a.frameW
  // A button counts only when it is drawn (filled or outlined — ruling R8), not as a link.
  const rank = styleRank ? (out: LayoutOut) => {
    const fills = runs.get(out)?.pf.fills
    return styleRank(out, {
      infoSize, W, H, boxOf: box, drawn: e => (fills ? fills.get(e) != null : true),
      // Stage 4 ruling R8 (research): the same fill `pieceFills` picked, resolved against the
      // page (`palette.field`) — a plain hex or a palette role reads as a real fill; an outline
      // or a link (no fill) contrasts nothing.
      fillContrast: e => fillContrastOf(fills?.get(e), a.palette),
    })
  } : undefined
  const result = enumerate(p.def, {
    kind: p.kind, title: p.content.title, hasImage: p.hasImage, run, check, infoSize, boxOf: box, rank,
    platformButton: offersCta(p), hasAction: !!p.content.action,
  })
  // Fix round 1, ruling R11: the platform's own button is an alternative, never a rescue. A
  // layout is offered only when at least one DRAWN candidate (no `cta`, or `cta: 'drawn'`) passes
  // on its own; a `cta: 'native'` candidate may only ride along beside one that does. Without the
  // axis (`offersCta` false) every candidate is drawn already, so this never refuses anything new.
  if (offersCta(p) && !result.some(c => (c.choice.cta ?? 'drawn') === 'drawn')) return []
  return result
}

/** The ways this frame's title can break into lines for a layout (`lineOptions` on the frame's
 *  own title), so a picker can quote them. Empty when the layout is unknown or does not fit. */
export function lineOptionsForFrame(a: Omit<LayoutPlanArgs, 'choice'>): LineOption[] {
  const p = prepare(a)
  if (!p || !fitsFrame(p)) return []
  return lineOptions(p.kind, p.content.title, p.def.oneLineFirst)
}
