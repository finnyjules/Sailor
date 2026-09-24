import { ref, computed, shallowRef, watch, toRaw, getCurrentScope, onScopeDispose } from 'vue'
import type { Ref, ComputedRef } from 'vue'
import { applyLayoutToFrame, candidatesForFrame, contentForFrame, hiddenLinesForFrame, isFromLayout, lineOptionsForFrame, planLayout, roleIdsForFrame, staleAccentCopySource } from '~/lib/frame/patterns/kit/plan'
import type { LayoutEditor, LayoutPlan, LayoutPlanArgs, StoredRoles } from '~/lib/frame/patterns/kit/plan'
import { axisValue, closestFirst, DEFAULT_CHOICE, sameChoice } from '~/lib/frame/patterns/kit/vary'
import type { Candidate, Choice } from '~/lib/frame/patterns/kit/vary'
import type { BrandLogo, Measure } from '~/lib/frame/patterns/kit/types'
import type { MeasurePool } from '~/lib/frame/patterns/kit/measure'
import { contentHints } from '~/lib/frame/patterns/kit/content'
import type { ContentTag, ContentTags } from '~/lib/frame/patterns/kit/content'
import { isOwned } from '~/lib/frame/patterns/kit/owned'
import { ownImageName, userImages } from '~/lib/frame/patterns/userImages'
import { layoutById, layoutsForStyle } from '~/lib/frame/patterns/layouts/catalog'
import { STYLES } from '~/lib/frame/patterns/kit/styles'
import type { StyleId } from '~/lib/frame/patterns/kit/styles'
import type { LocalLayer, TextLayer } from '~/composables/useCompositorLayers'
import type { BrandKit } from '~~/shared/brand/types'
import { brandLogoUrl, effectiveBrand } from '~~/shared/brand/resolve'
import { inputNameFromViewUrl } from '~~/shared/brand/assets'
import { uploadBrandImage } from '~/lib/brand/upload'
import type { PosterState } from '~/lib/frame/patterns/applyToFrame'
import { paletteFromFrame } from '~/lib/frame/patterns/framePalette'
import { rolesFromFamily } from '~/lib/frame/patterns/palette'
import type { FrameElements } from '~/lib/frame/patterns/types'
import { cssFontStack } from '~/composables/useCompositorLayers'
import { FRAME_FORMATS, formatFor, keepKind, keepNote } from '~/lib/frame/formats'
import { planSet as planSetKit } from '~/lib/frame/patterns/kit/set'
import type { SetEntry } from '~/lib/frame/patterns/kit/set'
import type { FrameFormat, KeepClear } from '~/lib/frame/formats'

// ═══════════════════════ the Layout tab's state ═══════════════════════
// One layout at a time, with every checked variation of it on this Frame (`candidatesForFrame`),
// plus the library: each fitting layout's first valid variation. Every pick applies at once as
// ONE undo step (`applyLayoutToFrame`) and is remembered on the Frame (`sailor_posterState`).
//
// Cost: the candidates run for the current layout only; the library plans its first 12 layouts
// at once and the rest when the browser is idle. Enumerating follows a content key (the Frame's
// text, faces and colours, and its size) — NOT the layout-set fields (position, size, spacing…),
// so a drag on the canvas re-plans nothing. The content key is only worked out ~200 ms after the
// layers stop changing (a trailing debounce), and not at all while a text layer is being edited on
// the canvas — typing never re-plans per keystroke; the edit's end settles it once. The PLANS (the
// library, and each variation's tile) are redone at once after every apply, undo, redo and
// reorder: all of them write a new draw order (`sailor_stackOrder`), which a drag never does — so
// the thumbnails show the Frame as it is.
//
// Stage 3: the tab shows one style at a time (`style`, ruling S4) — the library holds that style's
// layouts only and every planner call is given it. Switching style applies and writes nothing; an
// apply records the style it used on the Frame (`sailor_posterState.style`). The style's suggested
// title face is offered as its own undo step, and the project's brand kit logo is resolved once to
// an input filename and passed to the planner (ruling S2); until it resolves, plans run without it.

export type VaryCandidate = Candidate & { plan: LayoutPlan }
export interface LibraryItem { id: string; name: string; plan: LayoutPlan | null; reason?: string }
/** The Frame's format as the tab shows it: its name, its rules as plain sentences, and the text of
 *  the lines it leaves out (quoted in the UI). `keep` is the area the platform covers or may crop
 *  (the stage hatches it), and `keepKind` which of the two it is. */
export interface LayoutFormatInfo { label: string; notes: string[]; hidden: string[]; keep?: KeepClear; keepKind?: 'app' | 'crop' }
export interface ChoiceRow { key: keyof Choice; label: string; options: { value: unknown; label: string; on: boolean }[] }
/** One row of the Layout tab's Content section (Stage 4, ruling R1): a text layer (its text, for
 *  the row to quote), or an image layer beyond the first (`n`: its place among the images, 2 for
 *  the second; `name`: its user-set name). `tag`: what the user said it is (null: Automatic —
 *  recognition decides). */
export interface ContentRow { id: string; kind: 'text' | 'image'; text: string; n?: number; name?: string; tag: ContentTag | null }
/** The style's suggested title face, offered while the title is in another face: the family, its
 *  note, the weight it sets, and the title's own text (quoted by the button). */
export interface SuggestedFace { family: string; wt: number; note: string; title: string }
/** A brand image as a Frame image layer can use it: its input filename and h/w. */
export interface ResolvedBrandImage { name: string; aspect: number }

export interface LayoutVarySource {
  props: () => Record<string, unknown> | undefined
  frameW: () => number
  frameH: () => number
  connectedSlots: () => number[]
  /** The Frame's layer editor. `historyRev` (the real editor has it) moves with every history step:
   *  a late re-apply (after a suggested face loads) folds into the face's step only while it has
   *  not moved. */
  editor: () => LayoutEditor & { historyRev?: () => number }
  /** Persist the applied state (UI memory, outside the undo step). `placed` is the plan's own
   *  (layout limits, fix 3): passed on every apply, undefined for a layout that is not Stage 4, so a
   *  merging host drops the previous one. */
  remember(s: { patternId: string; seed: number; choice: Choice; index: number; roles?: StoredRoles; style?: StyleId; placed?: string[] }): void
  /** Whether the Layout tab is showing. The library plans only while it is. Default: always. */
  active?: () => boolean
  /** A text layer is being edited on the canvas: content re-plans wait until the edit ends. */
  editing?: () => boolean
  /** Injected in tests (the stub measure). Default: the renderer-exact canvas measure. */
  measure?: Measure
  /** The project's brand kit (`useBrandLibrary`'s active kit): its logo is offered to the layouts
   *  (ruling S2). Read only while the tab is showing. Absent or undefined: no logo. */
  brandKit?: () => BrandKit | undefined
  /** Load a font family the way the Frame's Title face picker does (a suggested face). */
  loadFace?: (family: string) => void
  /** Injected in tests. Default: `resolveBrandImage` (the brand image picker's route). */
  resolveImage?: (url: string) => Promise<ResolvedBrandImage | null>
  /** Injected in tests. Wait for one `document.fonts` face spec to load; true once it has, false
   *  when it has not within `ms`. Default: `waitForFont`. */
  loadFont?: (spec: string, ms: number) => Promise<boolean>
}

/** How long the layers must be still before a content change re-plans (ms). */
export const CONTENT_SETTLE_MS = 200

/** How long a re-plan waits for the Frame's faces to load before planning anyway (ms). */
export const FONT_WAIT_MS = 1500

/** How long a suggested face may take to load before its re-apply is given up (ms). */
export const FACE_LOAD_MS = 3000

/** The page's font set, or null where there is none (SSR, tests without a DOM). */
function fontSet(): FontFaceSet | null {
  return typeof document !== 'undefined' && (document as Document & { fonts?: FontFaceSet }).fonts ? document.fonts : null
}

/** Wait for a face to load (`document.fonts.load(spec)`), true once it has; false after `ms`. A
 *  Google family's stylesheet is injected by `loadFace` and arrives later: until it does, `load`
 *  finds no face and resolves empty at once, so it is asked again every 100 ms until the deadline.
 *  No font set (SSR, a test without a DOM): nothing to wait for — true. */
export function waitForFont(spec: string, ms: number = FACE_LOAD_MS): Promise<boolean> {
  const fonts = fontSet()
  if (!fonts) return Promise.resolve(true)
  const deadline = Date.now() + ms
  return new Promise<boolean>((resolve) => {
    const attempt = () => {
      if (Date.now() >= deadline) { resolve(false); return }
      Promise.resolve().then(() => fonts.load(spec)).then(
        got => (got.length ? resolve(true) : setTimeout(attempt, 100)),
        () => setTimeout(attempt, 100),
      )
    }
    attempt()
    setTimeout(() => resolve(false), ms)
  })
}

/** One `document.fonts` spec per face and weight of the Frame's own text layers (the faces the
 *  planner measures). Size does not change which face loads. */
function faceSpecs(props: Record<string, unknown> | undefined): string[] {
  const layers = ((props?.sailor_localLayers as Record<string, unknown>[] | undefined) ?? [])
    .filter(l => l.kind === 'text' && !l.owner && typeof l.fontFamily === 'string')
  return [...new Set(layers.map(l => `${l.fontWeight ?? 400} 32px ${cssFontStack(l.fontFamily as string)}`))]
}

/** How many library layouts plan at once; the rest plan when the browser is idle. */
const LIBRARY_FIRST = 12

/** Fields a layout writes. A change in these alone (a drag, a resize handle, an apply) is not a
 *  change of the Frame's content, so it does not re-plan. */
const LAYOUT_FIELDS = new Set([
  'x', 'y', 'w', 'h', 'boxW', 'boxH', 'rotation', 'scale', 'fontSize', 'align', 'expressive', 'valign',
  'lineHeight', 'letterSpacing', 'runs', 'path', 'crop', 'mask', 'opacity', 'blend', 'layoutPrev', 'pins',
  // A format hides the lines it does not carry (and a size change restores them): showing or
  // hiding a line is not new content. Role inference never reads `visible`.
  'visible',
])

/** The Frame's content, as one string: every user layer minus the layout-set fields (the text
 *  with its line breaks folded, since a layout re-breaks it), the order of text sizes and the
 *  stored roles (they decide which text is the title), the grid, the Frame's size and its format
 *  (two formats can share one size — 1280×720 is plain 16:9 and a video thumbnail). Owned
 *  pieces are left out: a layout rebuilds its own. */
function contentKey(props: Record<string, unknown> | undefined, w: number, h: number, slots: number[]): string {
  const layers = ((props?.sailor_localLayers as Record<string, unknown>[] | undefined) ?? [])
    .filter(l => !l.owner)
  const rank = layers.filter(l => l.kind === 'text')
    .map(l => [l.id, Number(l.fontSize) || 0] as const)
    .sort((a, b) => b[1] - a[1])
    .map(r => r[0])
  const rows = layers.map((l) => {
    const o: Record<string, unknown> = {}
    for (const k of Object.keys(l)) {
      if (LAYOUT_FIELDS.has(k)) continue
      o[k] = k === 'text' ? String(l.text ?? '').trim().split(/\s+/).join(' ') : l[k]
    }
    return o
  })
  // The roles the last apply stored decide which text is the title as much as the sizes do.
  const st = props?.sailor_posterState as { roles?: unknown; tags?: ContentTags } | undefined
  const roles = st?.roles ?? null
  // The user's content tags (Stage 4, ruling R1) decide what each line is: a tag change (and its
  // undo) is a content change.
  const tags = st?.tags && Object.keys(st.tags).length ? st.tags : null
  // The background is the palette's field (`paletteFromFrame`): it feeds the contrast picker and
  // whether an overlap layout draws its accent copy (ruling D2), so a new background re-plans.
  const bg = props?.sailor_localBg ?? null
  return JSON.stringify([w, h, formatFor(props, w, h)?.id ?? '', slots, rank, rows, props?.sailor_localGrid ?? null, roles, tags, bg])
}

const AXES: { key: keyof Choice; label: string; values?: unknown[]; labels?: string[] }[] = [
  { key: 'lines', label: 'Line breaks' },
  // Frame layout decisions, Task 5: each layout names its own arrangements (`LayoutDef.arrLabels`).
  { key: 'arr', label: 'Arrangement', values: [0, 1, 2] },
  { key: 'scale', label: 'Scale', values: ['full', 'quiet'], labels: ['Full', 'Quieter'] },
  { key: 'side', label: 'Image side', values: ['right', 'left'], labels: ['Right', 'Left'] },
  // Ruling R7: only a platform-button format with an action line offers it — in every style that
  // draws a button (`STYLES[style].button`; Frame layout decisions, Task 2).
  { key: 'cta', label: 'Button', values: ['drawn', 'native'], labels: ['In the image', 'Platform\'s own'] },
]

/** A format's rules, as the sentences the tab shows (Stage 2, spec §6). */
export function formatNotes(fmt: FrameFormat): string[] {
  const notes: string[] = []
  const keep = keepNote(fmt)
  if (keep) notes.push(keep)
  if (fmt.view) notes.push(`Seen about ${fmt.view} px wide, so no text is smaller than 9 px there.`)
  if (fmt.carries) notes.push(`Carries the ${fmt.carries === 2 ? 'two' : 'three'} most important lines.`)
  return notes
}

/** Idle scheduling, with a timeout fallback (tests, Safari). Returns a cancel. */
export function whenIdle(fn: () => void): () => void {
  const w = typeof window !== 'undefined' ? (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (h: number) => void }) : null
  if (w?.requestIdleCallback) { const h = w.requestIdleCallback(fn, { timeout: 250 }); return () => w.cancelIdleCallback?.(h) }
  const t = setTimeout(fn, 0)
  return () => clearTimeout(t)
}

/** A brand image's natural width / height (null when it does not load, or there is no DOM). */
function naturalAspect(url: string): Promise<number | null> {
  if (typeof Image === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    const im = new Image()
    im.onload = () => resolve(im.naturalWidth && im.naturalHeight ? im.naturalWidth / im.naturalHeight : null)
    im.onerror = () => resolve(null)
    im.src = url
  })
}

/** A brand kit image as an image layer can use it — the brand image picker's route
 *  (`components/brand/ImagePicker.vue`): a `/view?…&type=input` URL gives its input filename; an
 *  external URL is fetched and uploaded, and the upload's name read back. `aspect` is h/w (the
 *  kit's `BrandLogo.aspect`), from the image's natural size. Null when any step fails. */
export async function resolveBrandImage(url: string): Promise<ResolvedBrandImage | null> {
  try {
    let name = inputNameFromViewUrl(url)
    if (!name) {
      const blob = await (await fetch(url)).blob()
      const file = new File([blob], 'logo.png', { type: blob.type || 'image/png' })
      name = inputNameFromViewUrl(await uploadBrandImage(file))
    }
    if (!name) return null
    const wh = await naturalAspect(`/view?${new URLSearchParams({ filename: name, type: 'input' })}`)
    return wh ? { name, aspect: 1 / wh } : null
  } catch {
    return null
  }
}

/** Each brand image is resolved once per session (an external one is uploaded once). A failure is
 *  not kept: the entry is dropped, so the next try (the next library rebuild) resolves it again. */
const brandImages = new Map<string, Promise<ResolvedBrandImage | null>>()
function cachedBrandImage(url: string, resolve: (url: string) => Promise<ResolvedBrandImage | null>): Promise<ResolvedBrandImage | null> {
  let p = brandImages.get(url)
  if (!p) {
    const made: Promise<ResolvedBrandImage | null> = resolve(url).catch(() => null).then((r) => {
      if (!r && brandImages.get(url) === made) brandImages.delete(url)
      return r
    })
    p = made
    brandImages.set(url, p)
  }
  return p
}

/** The Layout tab's face pickers' targets from the planner's roles: the title for the Title face;
 *  the other text lines for the Text face — never the title's layer. */
export function faceTargets(roles: StoredRoles): { titleId: string | undefined; textIds: string[] } {
  const titleId = roles.title
  const textIds = [roles.details, roles.caption, roles.date, roles.action]
    .filter((id): id is string => !!id && id !== titleId)
  return { titleId, textIds: [...new Set(textIds)] }
}
/** Tests only: forget the resolved brand images. */
export function __clearBrandImagesForTest() { brandImages.clear() }

/** The style a layout belongs to (the 42 carry none: Swiss). */
const styleOfLayout = (id: string | undefined): StyleId | undefined => {
  const def = id ? layoutById(id) : undefined
  return def ? (def.style ?? 'swiss') : undefined
}

/** A line as the Layout tab quotes it: whitespace folded, the first 24 characters cut with an
 *  ellipsis, in quotation marks — unless it opens with its own (a review's quote), so no doubled
 *  marks. ("Not shown", and the Content section's rows.) */
export function quoteLine(t: string): string {
  const f = t.trim().split(/\s+/).join(' ')
  const s = f.length > 24 ? `${f.slice(0, 24).trimEnd()}…` : f
  return /^[“"«‘']/.test(f) ? s : `“${s}”`
}

/** The first 20 characters of a line, whitespace folded, cut with an ellipsis. */
const quoteStart = (t: string) => {
  const s = t.trim().split(/\s+/).join(' ')
  return s.length > 20 ? `${s.slice(0, 20).trimEnd()}…` : s
}

export function useLayoutVary(src: LayoutVarySource): {
  layoutId: Ref<string>; index: Ref<number>; applied: Ref<boolean>
  candidates: ComputedRef<VaryCandidate[]>
  library: ComputedRef<LibraryItem[]>
  choices: ComputedRef<ChoiceRow[]>
  select(id: string): void; vary(step: 1 | -1): void; jump(i: number): void; setChoice(key: keyof Choice, value: unknown): void
  shapeMode: Ref<FrameElements['shapeMode'] | undefined>; setShapeMode(m: FrameElements['shapeMode']): void
  imageMode: Ref<boolean>; setImageMode(on: boolean): void
  paletteMode: Ref<string[] | null>; setPaletteMode(hexes: string[] | null): void
  format: ComputedRef<LayoutFormatInfo | null>
  style: Ref<StyleId>; setStyle(s: StyleId): void
  /** Whether the library for the current style and content is complete (all its layouts planned). */
  libraryDone: Ref<boolean>
  /** Whether the Frame has a title (the planner's reading). Without one nothing is offered. */
  hasTitle: ComputedRef<boolean>
  /** Which layer holds which role, as the planner reads the Frame ({} while the tab is hidden). */
  roleIds: ComputedRef<StoredRoles>
  titleId: ComputedRef<string | undefined>
  suggestedFace: ComputedRef<SuggestedFace | null>
  /** `canReapply`: read when the face has loaded — false (the host shows the Frame at a viewing
   *  size, not its design size) skips the late re-apply, as every other apply is refused there. */
  applySuggestedFace(opts?: { canReapply?: () => boolean }): boolean
  /** The brand kit's logo as the planner takes it, once resolved (undefined: none, or not yet). */
  brandLogo: Ref<BrandLogo | undefined>
  /** The Content section's rows: every text layer of the user's, then each image beyond the first. */
  content: ComputedRef<ContentRow[]>
  /** The content hints (ruling R9) — advice under the Content section, never enforced. */
  hints: ComputedRef<string[]>
  /** Tag a layer (null: back to Automatic) as ONE undo step, and re-plan. False when nothing changed. */
  setTag(id: string, tag: ContentTag | null): boolean
  /** A text edit of layer `id` has been committed (the edit ended). When the Frame's layout drew an
   *  accent copy of that line (ruling D2) and the copy no longer shows its words, the layout is
   *  applied again, folded into the edit's own history step. True when it re-applied or tried to. */
  textEdited(id: string): boolean
  /** Stage 5, Make a set: the formats ticked for the set (`sailor_layoutSet.formats`; a Frame saved
   *  before reads `sailor_posterState.set.formats`), in `FRAME_FORMATS` order; unknown ids left out. */
  setFormats: ComputedRef<string[]>
  /** Remember the ticked formats on the Frame (`sailor_layoutSet`) — UI memory, NOT a history step,
   *  and never a write of the layout record (`sailor_posterState`) except to drop an old `set`. */
  setSetFormats(ids: readonly string[]): void
  /** The Frame's applied layout planned at each format (`planSet`), with the same inputs the tab
   *  plans with. Pure: the Frame is never written. [] when no layout is applied. `measures`: one
   *  measure pool for the whole set (`makeMeasurePool`), so its plans share one cache. */
  planSet(formats: readonly string[], o?: { measures?: MeasurePool }): SetEntry[]
  /** Everything a set is planned from, by identity (each write makes a new array or object) or as
   *  small values: the layers, draw order, background, groups, grid and size record; the layout
   *  record's layout, variation, style, roles and tags; the design size; the connected slots; the
   *  font revision; the tab's pickers and the brand's logo and accent. Equal, element by element:
   *  the set planned from it is still current. */
  setInputs(): unknown[]
} {
  const stored = src.props()?.sailor_posterState as PosterState | undefined

  // ── the pickers that shape what is offered (unchanged from the old sheet) ──
  const shapeMode = ref<FrameElements['shapeMode'] | undefined>(stored?.shapeMode ?? undefined)
  const imageMode = ref<boolean>(stored?.imageMode ?? false)
  const paletteMode = ref<string[] | null>(stored?.palette?.length ? stored.palette : null)
  /** The style whose layouts the tab shows (ruling S4): the one the Frame last applied, else Swiss.
   *  Switching it only changes what is offered; it is written to the Frame with each apply. */
  const style = ref<StyleId>(stored?.style && STYLES[stored.style] ? stored.style : (styleOfLayout(stored?.patternId) ?? 'swiss'))
  const writeState = (patch: Partial<PosterState>) => {
    const p = src.props(); if (!p) return
    p.sailor_posterState = { ...(p.sailor_posterState as object | undefined), ...patch }
  }
  function setShapeMode(m: FrameElements['shapeMode']) { shapeMode.value = m; writeState({ shapeMode: m }) }
  function setImageMode(on: boolean) { imageMode.value = on; writeState({ imageMode: on }) }
  function setPaletteMode(hexes: string[] | null) {
    paletteMode.value = hexes && hexes.length ? hexes : null
    writeState({ palette: paletteMode.value ?? undefined })
  }

  // ── what the planners read: a snapshot of the Frame, untracked ──
  // Nothing here reads the layers reactively. The only reactive reads are identities (the layer
  // array, the grid, the order), the Frame's size and the slots; the content key is stringified
  // from raw objects, and only when it settles (see `settle`).
  const isActive = () => src.active?.() ?? true
  const settledKey = ref('')
  /** Nothing is planned yet and the Frame's faces are still loading: plan nothing until they are
   *  (a plan measured in a fallback face is a wrong plan). */
  const waitingForFaces = ref(false)
  let pendingKey: string | null = null
  function settle() {
    clearTimeout(settleTimer); settleTimer = undefined
    const raw = toRaw(src.props())
    const k = contentKey(raw, src.frameW(), src.frameH(), src.connectedSlots())
    if (k === settledKey.value) { pendingKey = null; waitingForFaces.value = false; return }
    // The planner measures the Frame's own faces: load them first (bounded), then re-plan.
    const fonts = fontSet()
    const missing = fonts ? faceSpecs(raw).filter((spec) => { try { return !fonts.check(spec) } catch { return false } }) : []
    if (!missing.length) { pendingKey = null; waitingForFaces.value = false; settledKey.value = k; return }
    if (pendingKey === k) return
    pendingKey = k
    if (!settledKey.value) waitingForFaces.value = true
    const done = () => {
      if (pendingKey !== k) return
      pendingKey = null; waitingForFaces.value = false; settledKey.value = k
    }
    const loads = missing.map(spec => Promise.resolve().then(() => fonts!.load(spec)).catch(() => []))
    Promise.race([Promise.all(loads), new Promise(r => setTimeout(r, FONT_WAIT_MS))]).then(done, done)
  }
  /** Bumped whenever the page finishes loading fonts: a face that arrives after a plan was made
   *  (measured in a fallback) re-plans with the real one. */
  const fontRev = ref(0)
  {
    const fonts = fontSet()
    if (fonts && typeof fonts.addEventListener === 'function') {
      const onFonts = () => { fontRev.value++ }
      fonts.addEventListener('loadingdone', onFonts)
      if (getCurrentScope()) onScopeDispose(() => fonts.removeEventListener('loadingdone', onFonts))
    }
  }
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  let heldByEdit = false
  function settleSoon() {
    clearTimeout(settleTimer)
    settleTimer = setTimeout(() => {
      settleTimer = undefined
      if (src.editing?.()) { heldByEdit = true; return }   // the edit's end settles it
      settle()
    }, CONTENT_SETTLE_MS)
  }
  // The tab showing: settle at once (a first look must not wait for the debounce).
  watch(isActive, (on) => { if (on) settle() }, { immediate: true })
  // A content change (a new layer array, grid, background, size, format or slots): settle after the debounce.
  watch(() => {
    if (!isActive()) return null
    const p = src.props()
    const w = src.frameW(), h = src.frameH()
    return [p?.sailor_localLayers, p?.sailor_localGrid, p?.sailor_localBg, w, h, formatFor(p, w, h)?.id ?? '', src.connectedSlots().join(',')]
  }, (v) => { if (v) settleSoon() })
  // The end of a text edit settles what was held back while typing.
  watch(() => !!src.editing?.(), (editing) => {
    if (editing) { clearTimeout(settleTimer); settleTimer = undefined; heldByEdit = true; return }
    if (heldByEdit && isActive()) { heldByEdit = false; settle() }
  })
  // ── the brand kit's logo (ruling S2): resolved to an input filename once, never blocking ──
  // Until it resolves the layouts plan without it; when it arrives the plans are redone (it is in
  // the plan key). The kit is read only while the tab is showing.
  const brandLogo = shallowRef<BrandLogo | undefined>(undefined)
  const resolveImage = src.resolveImage ?? resolveBrandImage
  let logoKey: string | null = null
  let logoPending = false
  function resolveLogo(key: string) {
    const [primary, onDark] = JSON.parse(key) as [string, string]
    if (!primary) { brandLogo.value = undefined; return }
    logoPending = true
    void Promise.all([cachedBrandImage(primary, resolveImage), onDark ? cachedBrandImage(onDark, resolveImage) : null]).then(([main, dark]) => {
      if (logoKey !== key) return                              // the kit changed meanwhile
      logoPending = false
      brandLogo.value = main
        ? { url: main.name, aspect: main.aspect, ...(dark ? { onDarkUrl: dark.name, onDarkAspect: dark.aspect } : {}) }
        : undefined
    })
  }
  /** A logo that failed to resolve is tried again when the library is next rebuilt. */
  function retryLogo() {
    if (logoKey && !brandLogo.value && !logoPending && (JSON.parse(logoKey) as string[])[0]) resolveLogo(logoKey)
  }
  watch(() => {
    if (!isActive() || !src.brandKit) return null
    const kit = src.brandKit()
    return JSON.stringify([brandLogoUrl(kit, 'primary') ?? '', brandLogoUrl(kit, 'onDark') ?? ''])
  }, (key) => {
    if (key == null) return
    logoKey = key
    brandLogo.value = undefined
    resolveLogo(key)
  }, { immediate: true })

  // The brand kit's accent (ruling R7): the accent of a Frame with no shape colour of its own, the
  // way the kit's logo is offered. Read only while the tab is showing.
  const brandAccent = computed<string | undefined>(() => {
    if (!isActive() || !src.brandKit) return undefined
    return effectiveBrand(undefined, src.brandKit())?.accent || undefined
  })

  /** `accent`: the brand accent to use when given (a re-apply while the tab is hidden, where
   *  `brandAccent` reads nothing) — absent, the tab's own. */
  function baseArgs(o: { accent?: string } = {}): Omit<LayoutPlanArgs, 'choice' | 'layoutId'> {
    const raw = toRaw(src.props())
    const props = raw ? { ...raw } : undefined
    const palette = paletteMode.value ? rolesFromFamily({ hexes: [...paletteMode.value] }) : paletteFromFrame(props, 'accent' in o ? o.accent : brandAccent.value)
    const logo = brandLogo.value
    return {
      props, frameW: src.frameW(), frameH: src.frameH(), palette, recolour: paletteMode.value != null,
      connectedSlots: [...src.connectedSlots()], shapeMode: toRaw(shapeMode.value) ?? undefined, imageMode: imageMode.value,
      measure: src.measure, style: style.value,
      ...(logo ? { brandLogo: { ...logo } } : {}),
    }
  }
  const planKey = computed(() => JSON.stringify([settledKey.value, fontRev.value, paletteMode.value, shapeMode.value ?? null, imageMode.value, style.value, brandLogo.value ?? null, brandAccent.value ?? null]))
  /** Bumped when the Frame was re-arranged as a whole: an apply from here (bumped directly, so a
   *  host with plain props still re-plans), or anything that writes a new draw order — apply,
   *  undo, redo, a layer reorder. Identity only, never deep: a drag writes no order. */
  const rev = ref(0)
  // Re-arranged as a whole: the new content (a recolour, new line breaks) is settled at once too,
  // so the rebuild that follows is the only one.
  watch(() => src.props()?.sailor_stackOrder, () => { if (isActive()) settle(); rev.value++; followFrame() })

  // ── the current layout and its variations ──
  const layoutId = ref<string>(stored && layoutById(stored.patternId) ? stored.patternId : '')
  /** Whether the current layout has been applied (remembered on the Frame, or applied from here).
   *  Before that, the first Vary applies the variation on show rather than skipping past it. */
  const applied = ref<boolean>(!!layoutId.value)
  const choice = ref<Choice>(stored?.choice ? { ...DEFAULT_CHOICE, ...stored.choice } : { ...DEFAULT_CHOICE })

  /** Follow the layout the Frame records (`sailor_posterState`, which undo and redo restore with
   *  the layers): the layout, its variation — so "n of N" and the next V follow the Frame — and
   *  whether one is applied at all. */
  function followFrame() {
    const st = src.props()?.sailor_posterState as PosterState | undefined
    if (!st?.patternId || !layoutById(st.patternId)) { applied.value = false; return }
    // The Frame's layout belongs to another style than the one on show: keep showing this style
    // (its first layout, not yet applied) — the style picker is only changed by the user.
    if (styleOfLayout(st.patternId) !== style.value) {
      applied.value = false
      if (styleOfLayout(layoutId.value) !== style.value) { layoutId.value = ''; choice.value = { ...DEFAULT_CHOICE } }
      return
    }
    layoutId.value = st.patternId
    if (st.choice) choice.value = { ...DEFAULT_CHOICE, ...st.choice }
    applied.value = true
  }

  /** Show another style's layouts. Content, format and the Frame are left as they are; nothing is
   *  applied or written. The current layout becomes the Frame's own when it is of that style,
   *  else that style's first offered layout (not yet applied — the first Vary applies it). */
  function setStyle(s: StyleId) {
    if (!STYLES[s] || s === style.value) return
    style.value = s
    const st = src.props()?.sailor_posterState as PosterState | undefined
    if (st?.patternId && styleOfLayout(st.patternId) === s) { followFrame(); return }
    layoutId.value = ''
    applied.value = false
    choice.value = { ...DEFAULT_CHOICE }
  }

  /** A candidate whose plan is worked out on first read (only the tiles on screen are planned). */
  function withPlan(c: Candidate, a: Omit<LayoutPlanArgs, 'choice'>): VaryCandidate {
    let plan: LayoutPlan | undefined
    return Object.defineProperty({ ...c }, 'plan', {
      enumerable: true,
      get: () => (plan ??= planLayout({ ...a, choice: c.choice })!),
    }) as VaryCandidate
  }
  /** The checked variations (the expensive enumeration): content key and layout only. */
  const enumerated = computed<Candidate[]>(() => {
    void planKey.value
    const id = layoutId.value
    if (!id || waitingForFaces.value) return []
    return candidatesForFrame({ ...baseArgs(), layoutId: id })
  })
  /** Each with a lazy plan over the Frame as it is now (re-made on `rev`; cheap until read). */
  const candidates = computed<VaryCandidate[]>(() => {
    void rev.value
    const list = enumerated.value
    if (!list.length) return []
    const a = { ...baseArgs(), layoutId: layoutId.value }
    return list.map(c => withPlan(c, a))
  })

  const index = computed<number>({
    get: () => { const i = candidates.value.findIndex(c => sameChoice(c.choice, choice.value)); return i < 0 ? 0 : i },
    set: (i) => { const c = candidates.value[i]; if (c) choice.value = { ...c.choice } },
  })

  const lineLabels = computed(() => {
    void planKey.value
    if (!layoutId.value) return []
    return lineOptionsForFrame({ ...baseArgs(), layoutId: layoutId.value })
  })
  const choices = computed<ChoiceRow[]>(() => {
    const list = candidates.value
    const cur = list[index.value]?.choice
    const def = layoutById(layoutId.value)
    const arrLabels = def?.arrLabels
    // A layout whose arrangements are image sides (`arrMirrorsSide`, Fill) leaves the Arrangement
    // row out where the Image side row is offered: its side words could name the wrong side there.
    const sideOffered = new Set(list.map(c => axisValue(c.choice, 'side'))).size > 1
    const rows: ChoiceRow[] = []
    for (const ax of AXES) {
      if (ax.key === 'arr' && def?.arrMirrorsSide && sideOffered) continue
      const order = ax.key === 'lines' ? lineLabels.value.map(o => o.v) : ax.values!
      const present = new Set(list.map(c => axisValue(c.choice, ax.key)))
      const values = order.filter(v => present.has(v as never))
      if (values.length < 2) continue
      const labelOf = (v: unknown): string | undefined => ax.key === 'lines' ? lineLabels.value[v as number]!.label
        : ax.key === 'arr' ? arrLabels?.[v as number]
          : ax.labels![ax.values!.indexOf(v)]!
      // No fallback to letters: an arrangement the layout does not name is not offered as a pill
      // (the catalog test holds every layout whose arrangement can vary to naming each one).
      if (values.some(v => labelOf(v) == null)) continue
      rows.push({
        key: ax.key, label: ax.label,
        options: values.map(v => ({
          value: v,
          label: labelOf(v)!,
          on: cur != null && axisValue(cur, ax.key) === v,
        })),
      })
    }
    return rows
  })

  // ── the library: one plan per fitting layout, built in two passes ──
  const libItems = shallowRef<LibraryItem[]>([])
  const libraryDone = ref(false)
  let libBuilt = ''
  let cancelIdle: (() => void) | null = null
  function libraryItem(id: string, name: string, a: Omit<LayoutPlanArgs, 'choice' | 'layoutId'>): LibraryItem | null {
    const plan = planLayout({ ...a, layoutId: id, choice: { ...DEFAULT_CHOICE } })
    if (!plan) return null                                   // does not fit this Frame at all
    if (!plan.issues.length) return { id, name, plan }
    const first = candidatesForFrame({ ...a, layoutId: id })[0]
    if (first) return { id, name, plan: planLayout({ ...a, layoutId: id, choice: first.choice }) }
    return { id, name, plan: null, reason: 'None of its variations pass the checks.' }
  }
  function buildLibrary() {
    cancelIdle?.(); cancelIdle = null
    retryLogo()
    const a = baseArgs()
    const defs = layoutsForStyle(style.value)
    const out: LibraryItem[] = []
    let i = 0
    libraryDone.value = false
    const step = (budget: number) => {
      let n = 0
      while (i < defs.length && n < budget) {
        const def = defs[i++]!
        const item = libraryItem(def.id, def.name, a)
        if (item) { out.push(item); n++ }
      }
      libItems.value = [...out]
      if (!layoutId.value) layoutId.value = out.find(it => it.plan)?.id ?? ''
      if (i >= defs.length) libraryDone.value = true
    }
    step(LIBRARY_FIRST)
    if (i < defs.length) cancelIdle = whenIdle(() => { cancelIdle = null; step(Infinity) })
  }
  // The source reads the Frame only while the tab is showing: an inactive tab costs nothing, and
  // a host whose getters are not ready yet during its own setup is never called then.
  watch(() => ((src.active?.() ?? true) && !waitingForFaces.value ? `${planKey.value}#${rev.value}` : null), (key) => {
    if (key == null || key === libBuilt) return
    libBuilt = key
    buildLibrary()
  }, { immediate: true })
  if (getCurrentScope()) onScopeDispose(() => { cancelIdle?.(); clearTimeout(settleTimer) })
  const library = computed(() => libItems.value)

  // ── the format: the same inputs the plan uses (props, design size), no deep reads ──
  // The name and rules come from `formatFor`, which reads only the stored preset and the size. The
  // lines it leaves out come from the format and the Frame alone (`hiddenLinesForFrame`, the
  // planner's own role inference), so they show before any layout is planned or applied. The
  // layers are read raw; the content key (settled after the debounce, never on a drag) and `rev`
  // (apply, undo, redo, reorder) are what re-read them.
  const format = computed<LayoutFormatInfo | null>(() => {
    if (!isActive()) return null
    const fmt = formatFor(src.props(), src.frameW(), src.frameH())
    if (!fmt) return null
    void settledKey.value; void rev.value
    // Read in the current layout's view (a Stage 4 layout reads the content view — final review I1).
    const hidden = hiddenLinesForFrame({
      props: toRaw(src.props()), frameW: src.frameW(), frameH: src.frameH(),
      shapeMode: toRaw(shapeMode.value) ?? undefined, imageMode: imageMode.value, style: style.value,
      ...(layoutId.value ? { layoutId: layoutId.value } : {}),
    }).map(t => t.trim().split(/\s+/).join(' ')).filter(Boolean)
    const kind = keepKind(fmt)
    return {
      label: fmt.label, notes: formatNotes(fmt), hidden,
      ...(fmt.keep && kind ? { keep: { ...fmt.keep }, keepKind: kind } : {}),
    }
  })

  // ── actions: each applies at once, as one undo step ──
  /** Apply variation `i` of layout `id` (from `list`). Nothing changes here unless it applies. */
  function applyChoice(id: string, list: Candidate[], i: number): boolean {
    const c = list[i]
    if (!c) return false
    const out = applyLayoutToFrame({ ...baseArgs(), layoutId: id, choice: c.choice, editor: src.editor() })
    if (!out.ok || !out.posterState) return false
    layoutId.value = id
    choice.value = { ...c.choice }
    applied.value = true
    settle()
    rev.value++
    src.remember({ patternId: out.posterState.patternId, seed: out.posterState.seed, choice: { ...c.choice }, index: i, roles: out.posterState.roles, style: style.value, placed: out.posterState.placed })
    return true
  }
  const applyAt = (i: number) => applyChoice(layoutId.value, candidates.value, i)
  /** Switch to a layout by applying its first variation. The current layout (and `applied`) only
   *  change when that apply succeeds. */
  function select(id: string) {
    if (!layoutById(id) || styleOfLayout(id) !== style.value) return
    const list = id === layoutId.value ? candidates.value : candidatesForFrame({ ...baseArgs(), layoutId: id })
    applyChoice(id, list, 0)
  }
  /** Apply from variation `start` on, stepping by `step` past any the apply refuses (its plan with
   *  the real faces can fail the checks that passed when it was listed), for at most `tries`. */
  function applyFrom(start: number, step: 1 | -1, n: number, tries: number) {
    for (let k = 0; k < tries; k++) if (applyAt((((start + k * step) % n) + n) % n)) return
  }
  function vary(step: 1 | -1) {
    const n = candidates.value.length
    if (!n) return
    if (!applied.value) { applyFrom(index.value, step, n, n); return }   // the first Vary applies what is shown
    if (n < 2) return
    applyFrom(index.value + step, step, n, n - 1)                       // one full cycle, never the one on show
  }
  function jump(i: number) { applyAt(i) }
  /** The prototype's `setAxis`: of the variations with that value, the one that keeps the most
   *  of the other choices. */
  function setChoice(key: keyof Choice, value: unknown) {
    const list = candidates.value
    const now = list[index.value]?.choice ?? choice.value
    let best = -1, bestSame = -1
    list.forEach((c, i) => {
      if (axisValue(c.choice, key) !== value) return
      const same = (Object.keys(now) as (keyof Choice)[]).filter(k => k !== key && axisValue(c.choice, k) === axisValue(now, k)).length
      if (same > bestSame) { bestSame = same; best = i }
    })
    if (best >= 0) applyAt(best)
  }

  // ── the title, and the style's suggested face for it ──
  // Read like the format: raw layers, re-read on the settled content key and `rev` only.
  const roleIds = computed<StoredRoles>(() => {
    if (!isActive()) return {}
    void settledKey.value; void rev.value
    return roleIdsForFrame({
      props: toRaw(src.props()), frameW: src.frameW(), frameH: src.frameH(),
      shapeMode: toRaw(shapeMode.value) ?? undefined, imageMode: imageMode.value, style: style.value,
    })
  })
  const titleId = computed<string | undefined>(() => roleIds.value.title)
  const hasTitle = computed(() => !!titleId.value)
  const titleLayer = (): TextLayer | undefined => {
    const id = titleId.value
    const layers = (toRaw(src.props())?.sailor_localLayers as LocalLayer[] | undefined) ?? []
    return id ? layers.find(l => l.id === id && l.kind === 'text') as TextLayer | undefined : undefined
  }
  /** Editorial and Street suggest a title face; hidden once the title is in it. */
  const suggestedFace = computed<SuggestedFace | null>(() => {
    const face = STYLES[style.value].face
    if (!face) return null
    void settledKey.value; void rev.value
    const t = titleLayer()
    if (!t || (t.fontFamily ?? '').trim().toLowerCase() === face.family.toLowerCase()) return null
    return { family: face.family, wt: face.wt, note: face.note, title: quoteStart(String(t.text ?? '')) }
  })
  /** Set the title's face to the suggestion (family and the face's weight) as ONE undo step, load
   *  it the way the Title face picker does, and re-plan (after it loads — `settle` waits).
   *  Frame layout decisions, Task 6: once the face has loaded (`loadFont`, given up after
   *  `FACE_LOAD_MS`), the Frame's layout is applied again — measured in the real face — folded into
   *  the face's undo step (no new one). Not when the face never loads, the tab has gone, anything
   *  changed the Frame meanwhile (another step, an undo, a write to its layers, order or record),
   *  or the host's `canReapply` says no (a responsive Frame shown at a viewing size). */
  function applySuggestedFace(opts: { canReapply?: () => boolean } = {}): boolean {
    const face = suggestedFace.value
    const id = titleId.value
    const layers = (src.props()?.sailor_localLayers as LocalLayer[] | undefined) ?? []
    if (!face || !id || !layers.some(l => l.id === id)) return false
    src.loadFace?.(face.family)
    const ed = src.editor()
    ed.recordHistory()
    ed.commit(layers.map(l => (l.id === id ? { ...l, fontFamily: face.family, fontWeight: face.wt } as LocalLayer : l)))
    settle()
    rev.value++
    const mark = frameMark()
    const load = src.loadFont ?? waitForFont
    void Promise.resolve()
      .then(() => load(`${face.wt} 16px "${face.family}"`, FACE_LOAD_MS))
      .catch(() => false)
      .then((ok) => {
        if (!ok || disposed || !sameMark(mark, frameMark())) return
        if (opts.canReapply && !opts.canReapply()) return             // at a viewing size
        reapplyFrameLayout(folded(src.editor()))
      })
    return true
  }

  // ── re-applying the Frame's layout (Frame layout decisions, Task 6) ──
  let disposed = false
  if (getCurrentScope()) onScopeDispose(() => { disposed = true })
  /** What "the Frame has not changed" compares: the editor's history revision (any step, even one
   *  that changed nothing) and the identity of everything an edit writes — layers, order, groups,
   *  background, the layout record. Every write makes a new array or object; nothing is deep-read. */
  function frameMark(): unknown[] {
    const p = toRaw(src.props())
    return [src.editor().historyRev?.(), ...['sailor_localLayers', 'sailor_stackOrder', 'sailor_localGroups', 'sailor_localBg', 'sailor_posterState', 'sailor_localGrid'].map(k => toRaw(p?.[k]))]
  }
  const sameMark = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((v, i) => v === b[i])
  /** The editor, with `recordHistory` a no-op: an apply through it joins the step already recorded
   *  (the history holds each step's "before"; its "after" is the live Frame, so writing more of it
   *  before the next step extends that step — one undo restores both). */
  const folded = (ed: LayoutEditor): LayoutEditor => ({
    recordHistory: () => {},
    commit: n => ed.commit(n),
    writeOrder: o => ed.writeOrder(o),
    writeGroups: g => ed.writeGroups(g),
  })
  /** Apply the Frame's own layout (`sailor_posterState.patternId`) again, over the Frame as it is
   *  now: the variation equal to the recorded choice, else the closest (the most axes the same),
   *  else the first — any the apply refuses is passed over, in that order. Planned in the layout's
   *  own style. The tab follows only when that style is on show. 'none': no layout applied;
   *  'not-offered': no variation of it passes now — the Frame is left exactly as it is. */
  function reapplyFrameLayout(ed: LayoutEditor, o: { accent?: string } = {}): 'applied' | 'not-offered' | 'none' {
    const st = src.props()?.sailor_posterState as PosterState | undefined
    const id = st?.patternId
    const s = styleOfLayout(id)
    if (!id || !s) return 'none'
    const a = { ...baseArgs(o), style: s, layoutId: id }
    const list = candidatesForFrame(a)
    if (!list.length) return 'not-offered'
    const now: Choice = { ...DEFAULT_CHOICE, ...(st?.choice ?? {}) }
    // The kit's one closest-choice order (shared with a set, Stage 5): equal, then most axes the same.
    for (const { c, i } of closestFirst(list, now)) {
      const out = applyLayoutToFrame({ ...a, choice: c.choice, editor: ed })
      if (!out.ok || !out.posterState) continue
      if (s === style.value) { layoutId.value = id; choice.value = { ...c.choice }; applied.value = true }
      settle()
      rev.value++
      src.remember({ patternId: out.posterState.patternId, seed: out.posterState.seed, choice: { ...c.choice }, index: i, roles: out.posterState.roles, style: s, placed: out.posterState.placed })
      return 'applied'
    }
    return 'not-offered'
  }

  // ── the Content section (Stage 4, ruling R1) and its hints (ruling R9) ──
  // Read like the format: raw layers, re-read on the settled content key (which holds the tags)
  // and `rev` only.
  // A layout's own words the user moved (`fromLayout`, final review I3) are not the user's content.
  const userLayers = (): LocalLayer[] => ((toRaw(src.props())?.sailor_localLayers as LocalLayer[] | undefined) ?? [])
    .filter(l => !isOwned(l as { owner?: { by: string } }) && !isFromLayout(l))
  const storedTags = (): ContentTags => ((toRaw(src.props())?.sailor_posterState as { tags?: ContentTags } | undefined)?.tags ?? {})
  const content = computed<ContentRow[]>(() => {
    if (!isActive()) return []
    void settledKey.value; void rev.value
    const tags = storedTags()
    const layers = userLayers()
    const rows: ContentRow[] = []
    for (const l of layers) {
      if (l.kind !== 'text') continue
      const text = String((l as TextLayer).text ?? '')
      if (!text.trim()) continue
      rows.push({ id: l.id, kind: 'text', text, tag: tags[l.id] ?? null })
    }
    // Each image beyond the first may be the second image (before / after), in document order. A
    // wired image is one of the user's images too (`isUserImage`), so Not used (ruling D7) is
    // reachable from its row; `n` is the number "Not shown" names it by (`imageLabel`).
    userImages(layers).forEach((l, i) => {
      if (i === 0) return
      const name = ownImageName(l)
      rows.push({ id: l.id, kind: 'image', text: '', n: i + 1, ...(name ? { name } : {}), tag: tags[l.id] ?? null })
    })
    return rows
  })
  const hints = computed<string[]>(() => {
    if (!isActive()) return []
    void settledKey.value; void rev.value
    const read = contentForFrame({
      props: toRaw(src.props()), frameW: src.frameW(), frameH: src.frameH(),
      shapeMode: toRaw(shapeMode.value) ?? undefined, imageMode: imageMode.value, style: style.value,
    })
    return contentHints(read, userLayers())
  })
  /** Write the layer's tag into `sailor_posterState.tags` (an empty set removes the key) as ONE
   *  undo step — the editor's snapshot holds the tags (`LAYOUT_KEYS`), so undo and redo restore
   *  them — then re-plan at once: the content key holds the tags, so the variations and the
   *  library follow. Frame layout decisions, Task 6: with a layout applied, it is applied again
   *  with the new reading (`reapplyFrameLayout`) in the SAME step — one undo restores the tag and
   *  the layers. When the layout is no longer offered, the layers are left as they are (the tab
   *  then shows the layout with no variations and Vary disabled).
   *  Ruling R16: one line holds a role — tagging a role another line holds MOVES it there (that
   *  line goes back to Automatic), in the same step. "Not used" is not a role. */
  function setTag(id: string, tag: ContentTag | null): boolean {
    const p = src.props(); if (!p) return false
    const st = p.sailor_posterState as (PosterState & { tags?: ContentTags }) | undefined
    const was = st?.tags ?? {}
    if ((was[id] ?? null) === tag) return false
    if (!userLayers().some(l => l.id === id)) return false
    const tags: ContentTags = { ...was }
    if (tag && tag !== 'unused') for (const [other, t] of Object.entries(tags)) if (other !== id && t === tag) delete tags[other]
    if (tag) tags[id] = tag
    else delete tags[id]
    const ed0 = src.editor()
    ed0.recordHistory()
    const next: Record<string, unknown> = { ...(st ?? {}) }
    if (Object.keys(tags).length) next.tags = tags
    else delete next.tags
    p.sailor_posterState = next
    if (reapplyFrameLayout(folded(ed0)) !== 'applied') { settle(); rev.value++ }
    return true
  }

  /** Layout limits, fix 1: the end of a text edit. Only a line the applied layout's owned accent copy
   *  was made from, and only when the copy is stale (`staleAccentCopySource`): every other edit —
   *  another line, or no change to the words — does nothing here. The layout is applied again like a
   *  tag change (`reapplyFrameLayout`: the same layout, the same or the closest variation), folded
   *  into the history step the edit recorded last (typing records one per change; the re-apply joins
   *  the last, so no step is added). Planned in the layout's own style and palette whether or not the
   *  tab is showing (the brand accent is read directly). No longer offered: the layers are left as
   *  they are, and the tab says so (ruling D4). */
  function textEdited(id: string): boolean {
    const raw = toRaw(src.props())
    if (!raw) return false
    const accent = src.brandKit ? effectiveBrand(undefined, src.brandKit())?.accent || undefined : undefined
    const probe = { props: raw, frameW: src.frameW(), frameH: src.frameH(), shapeMode: toRaw(shapeMode.value) ?? undefined, imageMode: imageMode.value }
    if (staleAccentCopySource(probe) !== id) return false
    if (reapplyFrameLayout(folded(src.editor()), { accent }) !== 'applied') { settle(); rev.value++ }
    return true
  }

  // ── Make a set (Stage 5) ──
  // The ticks live in their own property (`sailor_layoutSet`), NOT in `sailor_posterState`: a tick
  // must not replace the layout record, whose identity a suggested face's late re-apply compares
  // (`frameMark`). A Frame saved before that keeps its ticks in `sailor_posterState.set`: read once
  // when there is no `sailor_layoutSet`, and dropped from the record on the next tick.
  const setFormats = computed<string[]>(() => {
    const p = src.props()
    const own = p?.sailor_layoutSet as { formats?: unknown } | undefined
    const old = (p?.sailor_posterState as { set?: { formats?: unknown } } | undefined)?.set
    const list = own ? own.formats : old?.formats
    const ids = Array.isArray(list) ? new Set(list as unknown[]) : null
    return ids ? FRAME_FORMATS.filter(f => ids.has(f.id)).map(f => f.id) : []
  })
  function setSetFormats(ids: readonly string[]) {
    const p = src.props(); if (!p) return
    const want = new Set(ids)
    const formats = FRAME_FORMATS.filter(f => want.has(f.id)).map(f => f.id)
    p.sailor_layoutSet = { formats }
    const st = p.sailor_posterState as Record<string, unknown> | undefined
    if (st && 'set' in st) { const { set: _old, ...rest } = st; p.sailor_posterState = rest }
  }
  function planSet(formats: readonly string[], o: { measures?: MeasurePool } = {}): SetEntry[] {
    const st = src.props()?.sailor_posterState as PosterState | undefined
    const id = st?.patternId
    const s = styleOfLayout(id)
    if (!id || !s || !formats.length) return []
    return planSetKit({
      ...baseArgs(), style: s, layoutId: id, choice: { ...DEFAULT_CHOICE, ...(st?.choice ?? {}) }, formats: [...formats],
      ...(o.measures ? { measures: o.measures } : {}),
    })
  }
  function setInputs(): unknown[] {
    const p = src.props()
    const st = p?.sailor_posterState as (PosterState & { tags?: ContentTags }) | undefined
    const small = (v: unknown) => JSON.stringify(v ?? null)
    return [
      p?.sailor_localLayers, p?.sailor_stackOrder, p?.sailor_localBg, p?.sailor_localGroups, p?.sailor_localGrid, p?.sailor_frame,
      st?.patternId ?? null, small(st?.choice), st?.style ?? null, small(st?.roles), small(st?.tags),
      src.frameW(), src.frameH(), src.connectedSlots().join(','), fontRev.value,
      small(paletteMode.value), small(shapeMode.value), imageMode.value, brandLogo.value ?? null, brandAccent.value ?? null,
    ]
  }

  return {
    layoutId, index, applied, candidates, library, choices, select, vary, jump, setChoice,
    shapeMode, setShapeMode, imageMode, setImageMode, paletteMode, setPaletteMode, format,
    style, setStyle, libraryDone, hasTitle, roleIds, titleId, suggestedFace, applySuggestedFace, brandLogo,
    content, hints, setTag, textEdited, setFormats, setSetFormats, planSet, setInputs,
  }
}
