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
import { makeSheet, splitDateRange } from './sheet'
import type { Sheet, SheetOpts } from './sheet'
import { makeCanvasMeasure } from './measure'
import type { MeasurePool } from './measure'
import { boxOf, checkPlan, checkSideRunOff, freeRects, inkBoxOf } from './check'
import type { Box } from './check'
import { elementsToOps } from './toOps'
import { hex6, isSolid, pieceFills } from './contrast'
import type { FillCtx, PieceFill, PieceFills } from './contrast'
import { contrastRatio } from '../palette'
import type { AccentCopy, RoleTargets } from './toOps'
import { hexToOklab } from '~/lib/color/convert'
import { isOwned, mergeOwned } from './owned'
import { imageLabel, isFromLayout, isImageKind } from '../userImages'
import { enumerate, lineOptions } from './vary'
import type { Candidate, Choice, LineOption } from './vary'
import type { BrandLogo, Content, El, FaceKey, Kind, LayoutDef, LayoutOut, Measure, PhotoEl, RoleKey } from './types'
import { STYLES } from './styles'
import { BASE_ROLES, elementsOf, NEW_TEXT_ROLES, readContent } from './content'
import type { ContentRole, ContentTags, ReadContent } from './content'
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
  /** Stage 5 (a set): where the default canvas measure comes from — one pool shared by every plan
   *  of the set (`makeMeasurePool`), so they share its cache. Absent: a fresh canvas measure per
   *  plan, as before. Ignored when `measure` is given. */
  measures?: MeasurePool
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
  /** `placed` (layout limits, fix 3): a Stage 4 layout's content lines (`PosterState.placed`); only
   *  on a Stage 4 layout's plan. */
  posterState: { patternId: string; seed: number; choice: Choice; roles: StoredRoles; placed?: string[] }
  /** The format the Frame is sized for (ruling P5), the roles it hid because the format carries
   *  fewer levels, and their text in the same order (`lines`, what the Layout tab quotes — read in
   *  the view this layout reads, final review I1). Null: no format, the Stage 1 plan. */
  format: { id: string; label: string; hidden: RoleKey[]; lines: string[] } | null
  /** What the Frame has that this plan leaves hidden, with its text for the Layout tab to quote
   *  ("Not shown"), each once:
   *  - the lines this layout does not place, in role order: Swiss, the action line (ruling R9); a
   *    style layout, any level it has no place for (Strip sets no details or fine print); a Stage 4
   *    layout, any content line too;
   *  - ruling R15, in layer order: a line or image an EARLIER layout hid (tracked `visible`) that
   *    this one does not place (an image: named by its own name, else "Image n"; `image: true`, the
   *    tab names it rather than quoting it) — it stays hidden and is named by its own text, even when it holds
   *    no role any more (untagged, or tagged Not used: role `'unused'`); and one a previous Stage 4
   *    layout placed that this one does not — hidden too, never left stranded over the new layout.
   *  Hidden the way a format's levels are (a hidden-only op, tracked `visible`), so a later layout
   *  that places one shows it again. A Frame no Stage 4 layout has touched gets only the first kind.
   *  A showing image is listed only when it is tagged Not used (rulings D3, D7: hidden by this plan
   *  and named, `'unused'`); otherwise never — since Task 7 of the layout decisions every layout
   *  places the Frame's extra images (`placeExtras`) or is refused. This replaces Stage 4's ruling
   *  R14, which hid and named a second image a Stage 4 layout did not place. An image is named as
   *  its Content row names it (`imageLabel`). */
  notPlaced: NotPlaced[]
}

/** One entry of `LayoutPlan.notPlaced`: the role it holds (`'unused'`: none any more — a line an
 *  earlier layout hid that was since untagged or tagged Not used), its text (an image: its name,
 *  else "Image n"), and `image` for an image. */
export interface NotPlaced { role: ContentRole | 'unused'; text: string; image?: true }

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
  /** The content view's reading of the Frame (ruling C2), whatever view this layout reads: what a
   *  previous Stage 4 layout placed (ruling R15) and the role a line held, for naming it. */
  contentRead: ReadContent
  /** The face a layout's own words are set in (Stage 4, ruling R10): the family AND weight of the
   *  layer the caption face is measured from (the caption, else the first content line measured in
   *  that face), else the title's — so what the checker measured is what is drawn. */
  ownFace: { family: string; weight: number } | undefined
  /** Ruling D2: the overlap layout draws its crossing line as an owned accent copy (the face of the
   *  user's line it copies). Undefined: the layout runs exactly as before. */
  accentCopy: AccentCopy | undefined
  /** Layout decisions, Task 7: the Frame's images a layout may leave for the planner to tile, in
   *  document order — every image but the first (`targets.image`), and not one the user hid. The
   *  second leaves the list for a layout that places it itself (`extrasOf`). */
  extraImages: string[]
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
    // Each content line's own text (Task 4): the layouts place these layers and measure what they draw.
    const raw: NonNullable<Content['raw']> = {}
    for (const r of NEW_TEXT_ROLES) {
      const l = read.roles[r] ? layers.find(x => x.id === read.roles[r] && x.kind === 'text') as TextLayer | undefined : undefined
      if (l?.text?.trim()) raw[r] = l.text
    }
    if (Object.keys(raw).length) content.raw = raw
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
  // The action is measured in its own layer's face (a button grows with it), and so is each Stage 4
  // content line (final review I2: `faceOf` names the role, the measure gets its layer) — each is
  // drawn by its own layer. With no details or caption layer of its own, that face is a content
  // line's layer (the caption face is also what the layout's own words are measured and drawn in,
  // ruling R10).
  const captionFace = layerOf('caption') ?? layerOf('by') ?? layerOf('list') ?? layerOf('statline') ?? layerOf('rating') ?? layerOf('them')
  const contentFaces: Partial<Record<RoleKey, TextLayer>> = {}
  if (contentView) for (const r of NEW_TEXT_ROLES) { const l = layerOf(r); if (l) contentFaces[r] = l }
  const measure = a.measure ?? (a.measures ?? makeCanvasMeasure)({
    title: layerOf('title'), details: layerOf('details') ?? layerOf('quote') ?? layerOf('stat'), date: layerOf('date'),
    caption: captionFace,
    action: layerOf('action'),
    ...contentFaces,
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
  const accentCopy = accentCopyFor(def, layers, targets, a.palette, a.recolour)
  // Task 7: the images beyond the first. Not one the user hid (`visible` false that no layout set):
  // their hiding is theirs. One a layout hid (tracked) is placed — and so shown — again. An image
  // tagged Not used never reaches `elements` (ruling D3: it stays hidden).
  const extraImages = elements.images.map(i => i.id).filter(id => {
    if (id === targets.image) return false
    const l = layers.find(x => x.id === id) as { visible?: boolean; layoutPrev?: { visible?: { set: unknown } } } | undefined
    return !(l?.visible === false && l.layoutPrev?.visible?.set !== false)
  })
  return { def, index, layers, elements, baseElements: views.base.elements, content, kind, targets, hasImage, measure, grid: readGrid(a.props), fmt, hidden, style: a.style ?? 'swiss', composedH, fillCtx, read, contentRead: views.content.read, ownFace, accentCopy, extraImages }
}

/** The Frame and how to read it. `layoutId` (the functions below that quote or restore a format's
 *  hidden lines): the layout they are about — a Stage 4 layout (`needsContent`) reads the content
 *  view (ruling C2), so its format hides the lines THAT view gives the levels (final review I1).
 *  Absent, or any other layout: the base view. */
type FrameArgs = Pick<LayoutPlanArgs, 'props' | 'frameW' | 'frameH' | 'shapeMode' | 'imageMode' | 'style'> & { layoutId?: string }

interface View { elements: FrameElements; read: ReadContent }

// `isFromLayout` lives with the user-image helpers (`../userImages`); re-exported for its callers.
export { isFromLayout }

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
  const userLayers = layers.filter(l => !isOwned(l as { owner?: { by: string } }) && !isFromLayout(l as { fromLayout?: unknown }))
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

/** The elements of the view `a.layoutId` reads (a Stage 4 layout: the content view; else, or
 *  without one, the base view — ruling C2). */
function viewElements(a: FrameArgs, layers: LocalLayer[]): FrameElements {
  const views = readFrame(a, layers)
  return a.layoutId && layoutEntry(a.layoutId)?.def.needsContent != null ? views.content.elements : views.base.elements
}

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
 *  `planLayout` hides for `a.layoutId` (read in its view), worked out from the format and the Frame
 *  alone (no layout needs to have been planned or applied). Empty without a format, or without a
 *  title. */
export function hiddenLinesForFrame(a: FrameArgs): string[] {
  const fmt = formatFor(a.props, a.frameW, a.frameH)
  if (!fmt || fmt.carries == null) return []
  const elements = viewElements(a, (a.props?.sailor_localLayers as LocalLayer[] | undefined) ?? [])
  if (!elements.title) return []
  const content = contentOf(elements)
  return hiddenRoles(fmt, content, a.style).map(r => content[r] as string)
}

/** The ids of the text layers this Frame's format leaves out — the layers of the roles
 *  `hiddenLinesForFrame` quotes (in `a.layoutId`'s view). Empty without a format, or without a
 *  title. */
export function hiddenLayerIdsForFrame(a: FrameArgs): string[] {
  const fmt = formatFor(a.props, a.frameW, a.frameH)
  if (!fmt || fmt.carries == null) return []
  const elements = viewElements(a, (a.props?.sailor_localLayers as LocalLayer[] | undefined) ?? [])
  if (!elements.title) return []
  return hiddenRoles(fmt, contentOf(elements), a.style).map(r => elements[r]!.id)
}

/** The ids of the layers holding a level (title, details, date, action, caption) in `a.layoutId`'s
 *  view — the only lines a format can hide (Stage 2). A format change restores only these
 *  (`restoreFormatHiddenLines`): a content line or an image a layout hid is not the format's. */
export function levelLayerIdsForFrame(a: FrameArgs): string[] {
  const elements = viewElements(a, (a.props?.sailor_localLayers as LocalLayer[] | undefined) ?? [])
  return ROLES.map(r => elements[r]?.id).filter((id): id is string => !!id)
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
  // Stage 4 (Task 4): a layout built around a kind of content is offered only when the Frame has it
  // (read in the content view, ruling C2 — `needsContent` is what puts the layout there).
  if (def.needsContent && !def.needsContent.every(k => hasContent(p, k))) return false
  return true
}

/** Whether the Frame (in the content view) has the content a Stage 4 layout is built around. The
 *  number is the date's text when it is number-like, as `needs.number` reads it (a hidden date
 *  never counts). */
function hasContent(p: Prepared, k: NonNullable<LayoutDef['needsContent']>[number]): boolean {
  switch (k) {
    case 'number': return isNumberish(p.content.date)
    case 'stat': return p.content.stat != null
    case 'review': return p.content.review != null
    case 'compare': return p.content.compare != null
    case 'list': return p.content.list != null
    case 'image2': return p.targets.image2 != null
  }
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

/** Ruling R7 (Task 2 lifts it off Performance alone): the platform's-own-button choice is
 *  offered in every style that draws a button at all — Performance's pill, Editorial's link,
 *  Street's hard-edged box (`STYLES[style].button`) — on a format that draws its own button, with
 *  a Frame that has an action line to hide. Swiss has no `button` spec (it never draws one; ruling
 *  R9 always hides its action line instead), so it never offers the axis. */
const offersCta = (p: Prepared): boolean => STYLES[p.style].button != null && !!p.fmt?.platformButton && !!p.content.action

function runChoice(p: Prepared, a: { frameW: number; frameH: number; style?: StyleId }, choice: Choice, breakDates = false): Run {
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
    ...(breakDates ? { breakDates } : {}),
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
  const out = p.def.fn(S, { c, kind: p.kind, ph: p.hasImage && !side, r, words, lines, arr: choice.arr, ...(p.accentCopy ? { accentCopy: true as const } : {}) })
  // Run-off keeps its image OVER the title (the title runs under it); everything else puts it behind.
  if (side && p.def.id === 'runoff') { side.ok = true; out.els.push(side) } else if (side) out.els.unshift(side)
  const designW = fmt ? { designW: fmt.w } : {}
  if (!keep) return { out, S, side, ...(a.style ? { style: a.style } : {}), ...designW }

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
  return { out, S: makeSheet(fullOpts), side, keep, fullH: H_full, ...(a.style ? { style: a.style } : {}), ...designW }
}

interface Run { out: LayoutOut; S: Sheet; side: PhotoEl | null; keep?: KeepClear; fullH?: number; style?: StyleId
  /** The format's own width in px (its design width, never the on-screen size). Absent: no format. */
  designW?: number }

/** The checker, with one adaptation for the side image of a wide frame: there the side image's
 *  edge is the page's edge for the type, so a `bleed` premise holds when the role runs off the
 *  page OR runs under the side image (Run-off's title on a wide frame runs under the image, as
 *  in the prototype). Every other rule and premise is checked unchanged. */
function checkRun({ out, S, side, keep, fullH, style, designW }: Run, premise: LayoutDef['premise'], pf: PieceFills): string[] {
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
          // The side image is drawn over the title (Run-off, `ok`): only the title's run-off end may
          // go under it, never its start (fix 2026-09-24).
          if (e && under && side.ok) withoutBleed.push(...checkSideRunOff(e, side, S))
        }
        return withoutBleed
      })()
  // Task 4: the style's own check (product visibility for Performance), in addition to the
  // shared rules above.
  const styleCheck = style && style !== 'swiss' ? STYLES[style].check : undefined
  if (styleCheck) issues.push(...styleCheck(out.els, { W: S.W, H: S.H, ...(designW != null ? { designW } : {}) }, keep))
  // Ruling R6: text must be readable on the piece it sits on.
  issues.push(...pf.issues)
  return issues
}

/** The contrast picker over a run (ruling R6) — the one result the checker and toOps share. */
const fillsOf = (p: Prepared, { out, S }: Run): PieceFills => pieceFills(out.els, S, p.fillCtx)

/** Layout decisions, Task 7: the smallest side of an extra image's tile — 12% of the frame's
 *  SHORTER side. Kit units are percent of the frame's width, so on a portrait or square frame
 *  (the width is the shorter side) that is this constant unchanged; on a landscape frame it scales
 *  down by the frame's aspect ratio (fix: a 728×90 banner's width-relative 12% is 87px, taller than
 *  the whole 90px frame, so no room ever passed — `minTileFor` converts to the frame's own units). */
export const EXTRA_MIN_TILE = 12

/** `EXTRA_MIN_TILE`, scaled for a frame's own aspect (fix above): `fullH` is the frame's full
 *  height in kit units (`100 * frameH / frameW`, ruling: portrait/square keep `fullH >= 100` so
 *  this is a no-op there; landscape frames have `fullH < 100` and get a proportionally smaller
 *  minimum, still 12% of the shorter (height) side). */
function minTileFor(fullH: number): number {
  return Math.min(EXTRA_MIN_TILE, EXTRA_MIN_TILE * fullH / 100)
}
/** The checker's reason when the extra images have no room (Task 7). */
export const NO_ROOM_FOR_IMAGES = 'no room for the other images'

/** The extra images this run leaves for the planner (Task 7): `p.extraImages`, less the second
 *  image when the layout places it itself (Before / after's `photo2`). */
function extrasOf(p: Prepared, els: El[]): string[] {
  if (!p.extraImages.length) return p.extraImages
  const second = p.targets.image2 && els.some(e => e.k === 'p' && e.role === 'photo2') ? p.targets.image2 : undefined
  return second ? p.extraImages.filter(id => id !== second) : p.extraImages
}

/** Task 7 — every layout places the Frame's extra images. After the layout has built its elements:
 *  the largest free rectangle inside the content area (the sheet's margin, inside the band a
 *  format's keep-clear areas leave) that clears every placed element's ink by the kit's gap
 *  (`freeRects`) takes the N extra images as N equal tiles, one row or one column — whichever gives
 *  the bigger tiles — the kit's gap apart. A tile's smaller side is at least `minTileFor`'s result; when
 *  the largest room cannot hold that, the next largest is tried, and with no room at all the run
 *  gets a `missing` element: the variation is refused, `NO_ROOM_FOR_IMAGES`. The tiles are
 *  appended after the layout's own elements (no index moves), cropped to cover by toOps. A Frame
 *  with no extra image runs exactly as before: nothing is added. */
function placeExtras(p: Prepared, ran: Run): Run {
  const n = extrasOf(p, ran.out.els).length
  if (!n) return ran
  const { S, keep } = ran
  const H = ran.fullH ?? S.H
  const top = keep ? H * keep.top : 0, bottom = keep ? H * (1 - keep.bottom) : H
  const area: Box = { x0: S.M, y0: top + S.M, x1: S.W - S.M, y1: bottom - S.M }
  const els = ran.out.els
  const boxes = els.map(e => takenBox(e, S, S.GAP))
  const minTile = minTileFor(H)
  let tiles = tileRooms(freeRects(area, boxes.filter((b): b is Box => b != null), S.GAP, minTile), n, S.GAP, minTile)
  let over: string[] | undefined
  if (!tiles) {
    // Ruling D5: no room off the image — when the layout's own image is full-bleed (it covers the
    // content area), the tiles may go ON it as an inset, still clear of every other element (the
    // text, the owned pieces) by the gap. The checker lets them lie on that image (`over`), and
    // Performance counts them as covering it ("the image is mostly hidden").
    const bleed = els.map((e, i) => (e.k === 'p' && e.extra == null && boxes[i] && contains(boxes[i]!, area) ? i : -1)).filter(i => i >= 0)
    if (bleed.length) {
      const rest = boxes.filter((b, i): b is Box => b != null && !bleed.includes(i))
      tiles = tileRooms(freeRects(area, rest, S.GAP, minTile), n, S.GAP, minTile, { maxSide: EXTRA_INSET_MAX * (area.x1 - area.x0), S, frameH: H })
      over = [...new Set(bleed.map(i => (els[i]!.k === 'p' ? els[i]!.role ?? 'p' : 'p').replace(/\d+$/, '')))]
    }
  }
  if (!tiles) els.push({ k: 'missing', why: NO_ROOM_FOR_IMAGES })
  else tiles.forEach((t, i) => els.push({ k: 'p', x: t.x0, y: t.y0, w: t.x1 - t.x0, h: t.y1 - t.y0, role: 'extra', extra: i, ...(over ? { over } : {}) }))
  return ran
}

/** Whether box `a` covers box `b` entirely. */
const contains = (a: Box, b: Box): boolean => a.x0 <= b.x0 && a.y0 <= b.y0 && a.x1 >= b.x1 && a.y1 >= b.y1

/** The room an element takes for the extra images (Task 7): its ink box — a logo's grown to its
 *  own clear space (checker rule 9: 0.35 × its height) where that is more than the kit's gap, so a
 *  tile never breaks it. */
function takenBox(e: El, S: Sheet, gap: number): Box | null {
  const b = inkBoxOf(e, S)
  if (!b || e.k !== 'logo') return b
  const g = Math.max(0, 0.35 * (b.y1 - b.y0) - gap)
  return { x0: b.x0 - g, y0: b.y0 - g, x1: b.x1 + g, y1: b.y1 + g }
}

/** Ruling D6: the longest a tile may be, as a multiple of its other side (1:2 to 2:1). */
export const EXTRA_MAX_ASPECT = 2
/** Ruling D5 (fix round 1): an inset on the layout's image is a small picture on it, not a second
 *  cover — each side at most a third of the content area's width. (A room-filling inset hid the
 *  image under Performance's rule on every layout.) */
export const EXTRA_INSET_MAX = 1 / 3

/** `n` equal slots, `gap` apart, in the first room (largest first) that holds them at `minTile`
 *  (`minTileFor`'s result for this frame) or more: as one row or one column, whichever tile is
 *  bigger (the row on a tie). Ruling D6: each tile keeps an aspect between 1:2 and 2:1 — its longer
 *  side is cut to twice the shorter, and it sits centred in its slot (the shorter side, and so the
 *  minimum, is unchanged). `inset` (ruling D5): no side longer than `maxSide` (never under the
 *  minimum), and the tiles sit in a corner of the room on the grid (`insetInCorner`, ruling D8)
 *  rather than centred. Null: no room holds them. */
function tileRooms(rooms: Box[], n: number, gap: number, minTile: number, inset?: { maxSide: number; S: Sheet; frameH: number }): Box[] | null {
  const maxSide = inset?.maxSide ?? Infinity
  const clamp = (w: number, h: number) => {
    const w1 = Math.min(w, EXTRA_MAX_ASPECT * h, maxSide)
    const th = Math.min(h, EXTRA_MAX_ASPECT * w1, maxSide)
    return { tw: Math.min(w1, EXTRA_MAX_ASPECT * th), th }
  }
  for (const r of rooms) {
    const rw = r.x1 - r.x0, rh = r.y1 - r.y0
    const row = { w: (rw - (n - 1) * gap) / n, h: rh, row: true }
    const col = { w: rw, h: (rh - (n - 1) * gap) / n, row: false }
    const fits = [row, col].filter(t => Math.min(t.w, t.h) >= minTile)
    if (!fits.length) continue
    const area = (t: { w: number; h: number }) => { const { tw, th } = clamp(t.w, t.h); return tw * th }
    const t = fits.length === 2 && area(col) > area(row) ? col : fits[0]!
    const { tw, th } = clamp(t.w, t.h)
    if (inset) return insetInCorner(r, n, t.row, tw, th, gap, inset.S, inset.frameH)
    return Array.from({ length: n }, (_, i) => {
      const sx = t.row ? r.x0 + i * (t.w + gap) : r.x0
      const sy = t.row ? r.y0 : r.y0 + i * (t.h + gap)
      const x0 = sx + (t.w - tw) / 2, y0 = sy + (t.h - th) / 2
      return { x0, y0, x1: x0 + tw, y1: y0 + th }
    })
  }
  return null
}

/** The corners of a room, in ruling D8's tie order: bottom-right, bottom-left, top-right, top-left. */
const CORNERS = [['right', 'bottom'], ['left', 'bottom'], ['right', 'top'], ['left', 'top']] as const

/** Ruling D8: an inset's `n` tiles (at most `tw × th` each, one row or one column) in the corner of
 *  room `r` nearest a corner of the frame (the distance from each of the room's corners to the
 *  frame's own corner on the same sides; ties in `CORNERS` order), on the grid: each tile spans
 *  whole columns of the sheet (`Xr(c)` .. `Xr(c) + CW`, the way `photoIn` sizes the image), the
 *  widest span no wider than `tw` that keeps the minimum tile, a row's tiles one gutter apart; the
 *  tiles' height is cut to 2:1 of the span (ruling D6). A room whose columns cannot hold that keeps
 *  the tiles' own width, still in the corner. The tiles meet the room's edges on the corner's
 *  sides. Deterministic: a function of the room, the sizes and the sheet only. */
export function insetInCorner(r: Box, n: number, row: boolean, tw: number, th: number, gap: number, S: Sheet, frameH: number): Box[] {
  const minTile = minTileFor(frameH)
  let corner: typeof CORNERS[number] = CORNERS[0], best = Infinity
  for (const c of CORNERS) {
    const d = Math.hypot(c[0] === 'right' ? S.W - r.x1 : r.x0, c[1] === 'bottom' ? frameH - r.y1 : r.y0)
    if (d < best - 1e-6) { best = d; corner = c }
  }
  const right = corner[0] === 'right', bottom = corner[1] === 'bottom'
  // The sheet's columns that lie wholly inside the room, left to right.
  const cols: number[] = []
  for (let c = 1; c <= S.NC; c++) if (S.Xr(c) >= r.x0 - 1e-6 && S.Xr(c) + S.CW <= r.x1 + 1e-6) cols.push(S.Xr(c))
  let w = tw, h = th
  let xs: number[] | null = null
  for (let k = cols.length; k >= 1; k--) {
    const need = row ? n * k : k
    const sw = k * S.CW + (k - 1) * S.G
    if (need > cols.length || sw > tw + 1e-9) continue
    const sh = Math.min(th, EXTRA_MAX_ASPECT * sw)
    if (Math.min(sw, sh) < minTile) break                        // a narrower span only gets smaller
    const first = right ? cols.length - need : 0
    xs = row ? Array.from({ length: n }, (_, i) => cols[first + i * k]!) : [cols[first]!]
    w = sw; h = sh
    break
  }
  if (!xs) {
    const gw = row ? n * tw + (n - 1) * gap : tw
    const x0 = right ? r.x1 - gw : r.x0
    xs = row ? Array.from({ length: n }, (_, i) => x0 + i * (tw + gap)) : [x0]
  }
  const gh = row ? h : n * h + (n - 1) * gap
  const y0 = bottom ? r.y1 - gh : r.y0
  return Array.from({ length: n }, (_, i) => {
    const x = row ? xs![i]! : xs![0]!, y = row ? y0 : y0 + i * (h + gap)
    return { x0: x, y0: y, x1: x + w, y1: y + h }
  })
}

/** Run and check one choice (the ONE path plan and candidates share). Task 3 of the layout
 *  decisions: a date range too wide for its box may break after its dash ("19.09.–" /
 *  "15.11.2026"). The choice runs first exactly as before; only when that fails, on a recognised
 *  format (ruling D1), and the Frame's date has such a dash, does it run again with the break
 *  allowed — kept when it passes. So every
 *  choice that passed before is byte-identical; the break only ever adds candidates. */
function runChecked(p: Prepared, a: { frameW: number; frameH: number; style?: StyleId }, choice: Choice): { ran: Run; pf: PieceFills; issues: string[] } {
  const ran = placeExtras(p, runChoice(p, a, choice))
  const pf = fillsOf(p, ran)
  const issues = checkRun(ran, p.def.premise, pf)
  // Ruling D1: only on a recognised format — a Frame with no format plans exactly as in Stage 1.
  const date = p.content.date
  if (!issues.length || !p.fmt || !date || !date.split(/\s+/).some(t => splitDateRange(t))) return { ran, pf, issues }
  const ran2 = placeExtras(p, runChoice(p, a, choice, true))
  const pf2 = fillsOf(p, ran2)
  const issues2 = checkRun(ran2, p.def.premise, pf2)
  return issues2.length ? { ran, pf, issues } : { ran: ran2, pf: pf2, issues: issues2 }
}

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
  const { ran, pf, issues } = runChecked(p, a, a.choice)
  const { out, S } = ran

  const libraryShape = p.targets.shape ? undefined : pickLibraryShape(p.elements.shapeMode, seedFor(p.index, a.choice))
  // Task 7: the extra images the run tiled (`placeExtras`), each by its index.
  const extras = extrasOf(p, out.els)
  const targets = libraryShape || extras.length
    ? { ...p.targets, ...(libraryShape ? { libraryShape } : {}), ...(extras.length ? { extras } : {}) }
    : p.targets
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
  // Ruling D2: an overlap layout's accent copy of its crossing line (recolour off) — the face is
  // only passed when the layout drew a copy, so every other call is unchanged.
  if (p.accentCopy && out.els.some(e => e.k === 't' && e.copy)) pieces.accentCopy = p.accentCopy
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
  // Rulings R15 and D3: what this plan leaves hidden beyond its own roles — what an earlier layout hid
  // or a previous Stage 4 layout placed, and what the user tagged Not used. (The extra images are
  // placed by the run itself, Task 7 — ruling R14's hide is gone.)
  const carried = carriedOver(p, a, ops, out.els.length)
  ops.push(...carried.hide)
  const next = applyPlacement(merged, { ops, did: out.did }, p.elements, a.palette, { recolour: a.recolour ?? false })

  const saved = (a.props?.sailor_stackOrder as string[] | undefined) ?? []
  const present = framePresentKeys(a.connectedSlots, next)
  const order = nextOrderFor(saved, present, ops, p.elements, ins.inserted)
  return {
    layers: next, order, did: out.did, issues,
    posterState: {
      patternId: p.def.id, seed: seedFor(p.index, a.choice), choice: { ...a.choice }, roles: rolesOf(p.baseElements),
      ...(p.def.needsContent ? { placed: contentLinesOf(p) } : {}),
    },
    format: p.fmt ? { id: p.fmt.id, label: p.fmt.label, hidden: [...p.hidden], lines: p.hidden.map(r => p.elements[r]?.text ?? '') } : null,
    notPlaced: [...notPlaced.map(role => ({ role, text: lineText(p, role) })), ...carried.named],
  }
}

/** Layout limits, fix 3: the user's text lines holding a role in the content view (what a Stage 4
 *  layout read as the Frame's content), in layer order — stored with its apply (`posterState.placed`). */
function contentLinesOf(p: Prepared): string[] {
  const held = new Set(Object.values(p.contentRead.roles).filter((id): id is string => !!id))
  return p.layers.filter(l => l.kind === 'text' && held.has(l.id)).map(l => l.id)
}

/** How far apart (Oklab distance) the accent and the user's line colour must be for the accent
 *  copy to be drawn: 0.1 is about five just-noticeable differences (≈ 0.02 each) — clearly another
 *  colour, not a shade of the same one. */
export const ACCENT_COPY_MIN_DIFF = 0.1

/** The colour the renderer draws a text layer with no `color` in: the canvas's initial fillStyle. */
const TEXT_RENDER_DEFAULT_INK = '#000000'

const oklabDistance = (a: string, b: string): number => {
  const [l1, a1, b1] = hexToOklab(a), [l2, a2, b2] = hexToOklab(b)
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2)
}

/** The accent copy an overlap layout draws (`LayoutDef.accentCopy`, ruling D2), or undefined when
 *  it draws none and the layout runs as before. It draws none when:
 *  - recolour is on (the user's line takes the accent itself);
 *  - the Frame has no text layer for that role;
 *  - the user's line colour is not a plain colour; or
 *  - that colour is within `ACCENT_COPY_MIN_DIFF` of the palette's accent (the same colour, or
 *    nearly), so a copy would not show. A line with no colour at all counts as the renderer's
 *    black.
 *  Otherwise both overlap layouts set the big line in the accent. The copy's face is the user's
 *  layer's, with its own letter case as this apply leaves it (a case an earlier layout set and the
 *  user kept goes back to theirs). */
function accentCopyFor(def: LayoutDef, layers: LocalLayer[], targets: RoleTargets, palette: ResolvedPalette, recolour: boolean | undefined): AccentCopy | undefined {
  const role = def.accentCopy
  if (!role || recolour) return undefined
  const id = targets[role]
  const layer = id ? layers.find(l => l.id === id && l.kind === 'text') as TextLayer | undefined : undefined
  if (!layer) return undefined
  // A text layer with no colour at all draws in the canvas's initial fill, black: `resolvePaint`
  // hands the renderer an undefined paint, which a canvas ignores (its fillStyle starts '#000000').
  const mine = hex6(layer.color ?? TEXT_RENDER_DEFAULT_INK), accent = hex6(palette.accent)
  if (!mine || !accent || oklabDistance(mine, accent) < ACCENT_COPY_MIN_DIFF) return undefined
  const prevCase = (layer as { layoutPrev?: Record<string, { was: unknown; set: unknown }> }).layoutPrev?.textTransform
  const ownCase = (prevCase && layer.textTransform === prevCase.set ? prevCase.was : layer.textTransform) as AccentCopy['textTransform'] | null
  return {
    role, fontFamily: layer.fontFamily, fontWeight: layer.fontWeight,
    ...(layer.axes ? { axes: layer.axes } : {}),
    ...(ownCase ? { textTransform: ownCase } : {}),
  }
}

/** Layout limits, fix 1: the id of the user's line whose words the Frame's accent copy (ruling D2)
 *  no longer draws — the layer the applied layout's owned copy was made from, when its text has
 *  changed since that apply. Undefined when the Frame has no owned copy, its layout draws none, or
 *  the copy still draws the line's words (whitespace aside: the layout re-breaks them, so a copy is
 *  compared by its letters). The copy's source is the layer that held the copied role when it was
 *  applied (`posterState.roles`), else the one holding it now in the layout's own view. */
export function staleAccentCopySource(a: FrameArgs): string | undefined {
  const layers = (a.props?.sailor_localLayers as LocalLayer[] | undefined) ?? []
  const copy = layers.find(l => l.kind === 'text' && isOwned(l as { owner?: { by: string } })
    && /^copy-\d+$/.test((l as { owner?: { key?: string } }).owner?.key ?? '')) as TextLayer | undefined
  if (!copy) return undefined
  const st = a.props?.sailor_posterState as { patternId?: string; roles?: StoredRoles } | undefined
  const role = st?.patternId ? layoutEntry(st.patternId)?.def.accentCopy : undefined
  if (!role) return undefined
  const id = st?.roles?.[role] ?? viewElements({ ...a, layoutId: st!.patternId }, layers)[role as FaceKey]?.id
  const line = id ? layers.find(l => l.id === id && l.kind === 'text') as TextLayer | undefined : undefined
  if (!line) return undefined
  const letters = (t: string | undefined) => (t ?? '').replace(/\s+/g, '')
  return letters(line.text) === letters(copy.text) ? undefined : line.id
}

/** Rulings R15 and D3, over the layers this plan does not place or hide itself:
 *  - a layer an earlier layout hid (`visible` false, tracked as the layout's) stays hidden — apply
 *    leaves an untargeted layer as it is — and is NAMED;
 *  - a layer a previous Stage 4 layout placed (the Frame's `posterState.patternId` is a
 *    `needsContent` layout, and the layer holds a role in the content view) that is still showing
 *    is HIDDEN and named — never left where that layout put it, under this one;
 *  - (Stage 4's ruling R14 — a Stage 4 layout hid the second image it did not place — is gone: since
 *    Task 7 of the layout decisions every layout places the Frame's extra images, or is refused.)
 *  The user's own hiding (untracked `visible`) is theirs: not named. A layer an earlier layout hid
 *  that holds no role any more is named as `'unused'`; a SHOWING layer with no role in either view
 *  is left where it is — unless the user tagged it Not used:
 *  - Layout limits, fix 3: a SHOWING line the previous Stage 4 layout read as content
 *    (`posterState.placed`) that holds no role now (it was untagged) is a line that layout moved:
 *    hidden and named by its own text as `'unused'`, like the others.
 *  - Ruling D3 ("Gone from the Frame"): a layer TAGGED Not used (`tags[id] === 'unused'`) that is
 *    showing is HIDDEN by every layout (tracked, so a later layout that places it — after an
 *    untag — shows it again) and named as `'unused'`. Only the explicit tag: a Frame with no tags
 *    plans exactly as before. */
function carriedOver(p: Prepared, a: LayoutPlanArgs, ops: LayerOp[], z: number): { hide: LayerOp[]; named: NotPlaced[] } {
  const placed = new Set(ops.filter(o => !o.hidden && !o.insert).map(o => o.target))
  const hiddenHere = new Set(ops.filter(o => o.hidden).map(o => o.target))
  const prevSt = a.props?.sailor_posterState as { patternId?: string; placed?: string[] } | undefined
  const prev = prevSt?.patternId
  const prevWasStage4 = !!prev && layoutEntry(prev)?.def.needsContent != null
  // Layout limits, fix 3: the lines that previous Stage 4 layout read as content (and so placed or
  // hid) — one of them that holds no role now (untagged) is still a line it moved.
  const prevContent = new Set(prevWasStage4 && Array.isArray(prevSt?.placed) ? prevSt!.placed : [])
  // The role a layer holds in the content view (what a previous Stage 4 layout read), else in the base view.
  const contentRole = new Map<string, ContentRole>()
  for (const [r, id] of Object.entries(p.contentRead.roles) as [ContentRole, string | undefined][]) if (id) contentRole.set(id, r)
  const roleOf = new Map(contentRole)
  for (const r of ROLES) { const id = p.baseElements[r]?.id; if (id && !roleOf.has(id)) roleOf.set(id, r) }
  // Ruling D7: a wired image is an image here too (hidden, tracked and named like one). Owned and
  // layout-moved layers are skipped below, so every image reaching the naming is a user image.
  const isImage = isImageKind
  const tags = (a.props?.sailor_posterState as { tags?: Record<string, string> } | undefined)?.tags
  const hide: LayerOp[] = []
  const named: NotPlaced[] = []
  for (const l of p.layers) {
    if (l.kind !== 'text' && !isImage(l)) continue
    if (isOwned(l as { owner?: { by: string } }) || isFromLayout(l as { fromLayout?: unknown })) continue
    if (placed.has(l.id) || hiddenHere.has(l.id)) continue
    const tracked = l as { visible?: boolean; layoutPrev?: Record<string, { was: unknown; set: unknown }> }
    const layoutHid = tracked.visible === false && tracked.layoutPrev?.visible?.set === false
    const showing = tracked.visible !== false
    // A line an earlier layout hid is named whether or not it still holds a role (an untag, or
    // "Not used", can take it away): by its own text, as `'unused'` — never hidden in silence.
    // Ruling D3: tagged Not used — gone from the Frame (a showing one is hidden below).
    const tagUnused = tags?.[l.id] === 'unused'
    const role: NotPlaced['role'] | undefined = tagUnused ? 'unused'
      : isImage(l)
        ? (l.id === p.contentRead.roles.image2 ? 'image2' : layoutHid ? 'unused' : undefined)
        : roleOf.get(l.id) ?? (layoutHid || prevContent.has(l.id) ? 'unused' : undefined)
    // Task 6 fix round 2: a line hidden BECAUSE it was tagged Not used (D3's hide, marked
    // `by: 'unused'`), now untagged and holding no role, that was showing before, comes back — a
    // tracked show op — rather than staying hidden and named as `'unused'` for ever. A line a
    // layout hid for not placing it (R15, with or without a role now) is not this: it stays.
    const hasRole = isImage(l) ? l.id === p.contentRead.roles.image2 : roleOf.has(l.id)
    const prevVis = tracked.layoutPrev?.visible as { was: unknown; set: unknown; by?: string } | undefined
    if (layoutHid && prevVis?.by === 'unused' && !tags?.[l.id] && !hasRole && prevVis.was !== false) {
      hide.push({ target: l.id, kind: isImage(l) ? 'image' : 'text', shown: true, z })
      continue
    }
    if (!role) continue
    const strand = showing && (tagUnused || (prevWasStage4 && (contentRole.has(l.id) || prevContent.has(l.id))))
    if (!layoutHid && !strand) continue
    if (strand) hide.push({ target: l.id, kind: isImage(l) ? 'image' : 'text', hidden: true, z, ...(tagUnused ? { hiddenBy: 'unused' as const } : {}) })
    if (isImage(l)) {
      // Named as its Content row names it (`imageLabel`: its own name, else "Image n" among the
      // user's images, wired ones included).
      named.push({ role, text: imageLabel(p.layers, l), image: true })
    } else named.push({ role, text: (l as TextLayer).text ?? '' })
  }
  return { hide, named }
}

/** The text roles in the (carried) content that no text element of the layout's output places
 *  (base role: `title2` counts as `title`; a ring is the title). Swiss (no style, or `'swiss'`):
 *  the action line only (ruling R9) — no Swiss layout places it, so it is hidden and quoted rather
 *  than stranded where it was; every other Swiss line is as in Stages 1–2. */
function notPlacedRoles(p: Prepared, els: El[], style: StyleId | undefined): RoleKey[] {
  const placed = new Set(els.filter(e => e.k === 't' || e.k === 'ring').map(e => (e.role ?? '').replace(/\d+$/, '')))
  const roles: FaceKey[] = !style || style === 'swiss' ? ['action'] : ROLES
  const base: RoleKey[] = roles.filter(r => p.content[r] != null && !placed.has(r))
  // Stage 4 (Task 4): a content-view layout hides the content lines it does not place too (Offer
  // first leaves a quote out), rather than leaving them where they were under the new layout.
  if (!p.def.needsContent) return base
  return [...base, ...NEW_TEXT_ROLES.filter(r => p.content.raw?.[r] != null && !placed.has(r))]
}

/** The text of a line `notPlacedRoles` named. */
const lineText = (p: Prepared, r: RoleKey): string =>
  ((NEW_TEXT_ROLES as readonly string[]).includes(r) ? p.content.raw?.[r as keyof NonNullable<Content['raw']>] : p.content[r as FaceKey]) ?? ''

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
  const runs = new WeakMap<LayoutOut, Run & { pf: PieceFills; issues: string[] }>()
  // Each choice runs on its own sheet (scale/flip can differ) — so an element's box needs the
  // Sheet its own run built, not just any Sheet; keyed per element rather than per `LayoutOut`
  // because `enumerate`'s cover check (`vary.ts`) only ever hands us elements, not their `out`.
  const sheetOf = new WeakMap<El, Sheet>()
  const run = (choice: Choice) => {
    const { ran, pf, issues } = runChecked(p, a, choice)
    runs.set(ran.out, { ...ran, pf, issues })
    for (const e of ran.out.els) sheetOf.set(e, ran.S)
    return ran.out
  }
  const check = (out: LayoutOut) => runs.get(out)!.issues
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
