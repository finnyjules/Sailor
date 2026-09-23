import { ref, computed, shallowRef, watch, toRaw, getCurrentScope, onScopeDispose } from 'vue'
import type { Ref, ComputedRef } from 'vue'
import { applyLayoutToFrame, candidatesForFrame, lineOptionsForFrame, planLayout } from '~/lib/frame/patterns/kit/plan'
import type { LayoutEditor, LayoutPlan, LayoutPlanArgs } from '~/lib/frame/patterns/kit/plan'
import { DEFAULT_CHOICE } from '~/lib/frame/patterns/kit/vary'
import type { Candidate, Choice } from '~/lib/frame/patterns/kit/vary'
import type { Measure } from '~/lib/frame/patterns/kit/types'
import { LAYOUTS, layoutById } from '~/lib/frame/patterns/layouts/catalog'
import type { PosterState } from '~/lib/frame/patterns/applyToFrame'
import { paletteFromFrame } from '~/lib/frame/patterns/framePalette'
import { rolesFromFamily } from '~/lib/frame/patterns/palette'
import type { FrameElements } from '~/lib/frame/patterns/types'

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

export type VaryCandidate = Candidate & { plan: LayoutPlan }
export interface LibraryItem { id: string; name: string; plan: LayoutPlan | null; reason?: string }
export interface ChoiceRow { key: keyof Choice; label: string; options: { value: unknown; label: string; on: boolean }[] }

export interface LayoutVarySource {
  props: () => Record<string, unknown> | undefined
  frameW: () => number
  frameH: () => number
  connectedSlots: () => number[]
  editor: () => LayoutEditor
  /** Persist the applied state (UI memory, outside the undo step). */
  remember(s: { patternId: string; seed: number; choice: Choice; index: number }): void
  /** Whether the Layout tab is showing. The library plans only while it is. Default: always. */
  active?: () => boolean
  /** A text layer is being edited on the canvas: content re-plans wait until the edit ends. */
  editing?: () => boolean
  /** Injected in tests (the stub measure). Default: the renderer-exact canvas measure. */
  measure?: Measure
}

/** How long the layers must be still before a content change re-plans (ms). */
export const CONTENT_SETTLE_MS = 200

/** How many library layouts plan at once; the rest plan when the browser is idle. */
const LIBRARY_FIRST = 12

/** Fields a layout writes. A change in these alone (a drag, a resize handle, an apply) is not a
 *  change of the Frame's content, so it does not re-plan. */
const LAYOUT_FIELDS = new Set([
  'x', 'y', 'w', 'h', 'boxW', 'boxH', 'rotation', 'scale', 'fontSize', 'align', 'expressive', 'valign',
  'lineHeight', 'letterSpacing', 'runs', 'path', 'crop', 'mask', 'opacity', 'blend', 'layoutPrev', 'pins',
])

/** The Frame's content, as one string: every user layer minus the layout-set fields (the text
 *  with its line breaks folded, since a layout re-breaks it), the order of text sizes (it decides
 *  which text is the title), the grid and the Frame's size. Owned pieces are left out: a layout
 *  rebuilds its own. */
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
  return JSON.stringify([w, h, slots, rank, rows, props?.sailor_localGrid ?? null])
}

const sameChoice = (a: Choice, b: Choice) =>
  a.lines === b.lines && a.arr === b.arr && a.scale === b.scale && a.side === b.side

const AXES: { key: keyof Choice; label: string; values?: unknown[]; labels?: string[] }[] = [
  { key: 'lines', label: 'Line breaks' },
  { key: 'arr', label: 'Arrangement', values: [0, 1, 2], labels: ['A', 'B', 'C'] },
  { key: 'scale', label: 'Scale', values: ['full', 'quiet'], labels: ['Full', 'Quieter'] },
  { key: 'side', label: 'Image side', values: ['right', 'left'], labels: ['Right', 'Left'] },
]

/** Idle scheduling, with a timeout fallback (tests, Safari). */
function whenIdle(fn: () => void): () => void {
  const w = typeof window !== 'undefined' ? (window as Window & { requestIdleCallback?: (cb: () => void) => number; cancelIdleCallback?: (h: number) => void }) : null
  if (w?.requestIdleCallback) { const h = w.requestIdleCallback(fn); return () => w.cancelIdleCallback?.(h) }
  const t = setTimeout(fn, 0)
  return () => clearTimeout(t)
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
} {
  const stored = src.props()?.sailor_posterState as PosterState | undefined

  // ── the pickers that shape what is offered (unchanged from the old sheet) ──
  const shapeMode = ref<FrameElements['shapeMode'] | undefined>(stored?.shapeMode ?? undefined)
  const imageMode = ref<boolean>(stored?.imageMode ?? false)
  const paletteMode = ref<string[] | null>(stored?.palette?.length ? stored.palette : null)
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
  function settle() {
    clearTimeout(settleTimer); settleTimer = undefined
    const k = contentKey(toRaw(src.props()), src.frameW(), src.frameH(), src.connectedSlots())
    if (k !== settledKey.value) settledKey.value = k
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
  // A content change (a new layer array, grid, size or slots): settle after the debounce.
  watch(() => {
    if (!isActive()) return null
    const p = src.props()
    return [p?.sailor_localLayers, p?.sailor_localGrid, src.frameW(), src.frameH(), src.connectedSlots().join(',')]
  }, (v) => { if (v) settleSoon() })
  // The end of a text edit settles what was held back while typing.
  watch(() => !!src.editing?.(), (editing) => {
    if (editing) { clearTimeout(settleTimer); settleTimer = undefined; heldByEdit = true; return }
    if (heldByEdit && isActive()) { heldByEdit = false; settle() }
  })
  function baseArgs(): Omit<LayoutPlanArgs, 'choice' | 'layoutId'> {
    const raw = toRaw(src.props())
    const props = raw ? { ...raw } : undefined
    const palette = paletteMode.value ? rolesFromFamily({ hexes: [...paletteMode.value] }) : paletteFromFrame(props)
    return {
      props, frameW: src.frameW(), frameH: src.frameH(), palette, recolour: paletteMode.value != null,
      connectedSlots: [...src.connectedSlots()], shapeMode: toRaw(shapeMode.value) ?? undefined, imageMode: imageMode.value,
      measure: src.measure,
    }
  }
  const planKey = computed(() => JSON.stringify([settledKey.value, paletteMode.value, shapeMode.value ?? null, imageMode.value]))
  /** Bumped when the Frame was re-arranged as a whole: an apply from here (bumped directly, so a
   *  host with plain props still re-plans), or anything that writes a new draw order — apply,
   *  undo, redo, a layer reorder. Identity only, never deep: a drag writes no order. */
  const rev = ref(0)
  // Re-arranged as a whole: the new content (a recolour, new line breaks) is settled at once too,
  // so the rebuild that follows is the only one.
  watch(() => src.props()?.sailor_stackOrder, () => { if (isActive()) settle(); rev.value++ })

  // ── the current layout and its variations ──
  const layoutId = ref<string>(stored && layoutById(stored.patternId) ? stored.patternId : '')
  /** Whether the current layout has been applied (remembered on the Frame, or applied from here).
   *  Before that, the first Vary applies the variation on show rather than skipping past it. */
  const applied = ref<boolean>(!!layoutId.value)
  const choice = ref<Choice>(stored?.choice ? { ...DEFAULT_CHOICE, ...stored.choice } : { ...DEFAULT_CHOICE })

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
    if (!id) return []
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
    const rows: ChoiceRow[] = []
    for (const ax of AXES) {
      const order = ax.key === 'lines' ? lineLabels.value.map(o => o.v) : ax.values!
      const present = new Set(list.map(c => c.choice[ax.key]))
      const values = order.filter(v => present.has(v as never))
      if (values.length < 2) continue
      rows.push({
        key: ax.key, label: ax.label,
        options: values.map(v => ({
          value: v,
          label: ax.key === 'lines' ? lineLabels.value[v as number]!.label : ax.labels![ax.values!.indexOf(v)]!,
          on: cur != null && cur[ax.key] === v,
        })),
      })
    }
    return rows
  })

  // ── the library: one plan per fitting layout, built in two passes ──
  const libItems = shallowRef<LibraryItem[]>([])
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
    const a = baseArgs()
    const out: LibraryItem[] = []
    let i = 0
    const step = (budget: number) => {
      let n = 0
      while (i < LAYOUTS.length && n < budget) {
        const def = LAYOUTS[i++]!
        const item = libraryItem(def.id, def.name, a)
        if (item) { out.push(item); n++ }
      }
      libItems.value = [...out]
      if (!layoutId.value) layoutId.value = out.find(it => it.plan)?.id ?? ''
    }
    step(LIBRARY_FIRST)
    if (i < LAYOUTS.length) cancelIdle = whenIdle(() => { cancelIdle = null; step(Infinity) })
  }
  // The source reads the Frame only while the tab is showing: an inactive tab costs nothing, and
  // a host whose getters are not ready yet during its own setup is never called then.
  watch(() => ((src.active?.() ?? true) ? `${planKey.value}#${rev.value}` : null), (key) => {
    if (key == null || key === libBuilt) return
    libBuilt = key
    buildLibrary()
  }, { immediate: true })
  if (getCurrentScope()) onScopeDispose(() => { cancelIdle?.(); clearTimeout(settleTimer) })
  const library = computed(() => libItems.value)

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
    src.remember({ patternId: out.posterState.patternId, seed: out.posterState.seed, choice: { ...c.choice }, index: i })
    return true
  }
  const applyAt = (i: number) => applyChoice(layoutId.value, candidates.value, i)
  /** Switch to a layout by applying its first variation. The current layout (and `applied`) only
   *  change when that apply succeeds. */
  function select(id: string) {
    if (!layoutById(id)) return
    const list = id === layoutId.value ? candidates.value : candidatesForFrame({ ...baseArgs(), layoutId: id })
    applyChoice(id, list, 0)
  }
  function vary(step: 1 | -1) {
    const n = candidates.value.length
    if (!n) return
    if (!applied.value) { applyAt(index.value); return }   // the first Vary applies what is shown
    if (n < 2) return
    applyAt((index.value + step + n) % n)
  }
  function jump(i: number) { applyAt(i) }
  /** The prototype's `setAxis`: of the variations with that value, the one that keeps the most
   *  of the other choices. */
  function setChoice(key: keyof Choice, value: unknown) {
    const list = candidates.value
    const now = list[index.value]?.choice ?? choice.value
    let best = -1, bestSame = -1
    list.forEach((c, i) => {
      if (c.choice[key] !== value) return
      const same = (Object.keys(now) as (keyof Choice)[]).filter(k => k !== key && c.choice[k] === now[k]).length
      if (same > bestSame) { bestSame = same; best = i }
    })
    if (best >= 0) applyAt(best)
  }

  return {
    layoutId, index, applied, candidates, library, choices, select, vary, jump, setChoice,
    shapeMode, setShapeMode, imageMode, setImageMode, paletteMode, setPaletteMode,
  }
}
