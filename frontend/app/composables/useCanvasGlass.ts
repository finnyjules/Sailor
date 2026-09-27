import { computed, getCurrentScope, inject, onScopeDispose, provide, ref, toValue, watch, type ComputedRef, type InjectionKey, type MaybeRefOrGetter, type Ref } from 'vue'
import { blurAllowed, countVisible, nodesWithSomethingBehind, type GlassMode, type NodeBox, type Wire } from '~/lib/canvas/glassPolicy'

export interface GlassFlow {
  /** Optional. The viewport watch decides "moving"; a move start alone never turns blur off. */
  onMoveStart?(cb: () => void): void
  /** Optional. A move end only re-arms the settle timer. */
  onMoveEnd?(cb: () => void): void
  viewport: Ref<{ x: number; y: number; zoom: number }>
  boxes: () => NodeBox[]
  wires: () => Wire[]
  size: () => { width: number; height: number }
}

/**
 * The canvas's glass switch. Blur is decided once per REST, never per frame.
 *
 * "Moving" is read from the viewport itself, not from gesture events (Vue Flow emits no
 * move events for fitView, setViewport, zoom buttons or keyboard zoom). Any viewport
 * change turns blur off with a single class change on the root and re-arms a short
 * settle timer; when it fires, the zoom is published, the set of nodes with something
 * behind them is recomputed and blur comes back. The per-frame cost while moving is one
 * clearTimeout/setTimeout. The zoom used for the one-screen-pixel border is published
 * only at rest, so a pinch never restyles every node on every frame.
 *
 * invalidate(): graph changed (load, add, remove, resize) — recompute once after the
 * settle, coalescing any number of calls. pause()/resume(): a node drag.
 */
export function createCanvasGlass(flow: GlassFlow, opts: { mode?: Ref<GlassMode>; settleMs?: number } = {}) {
  const mode = opts.mode ?? ref<GlassMode>('always')
  const settleMs = opts.settleMs ?? 150
  const moving = ref(false)
  const zoomAtRest = ref(flow.viewport.value.zoom)
  const visible = ref(0)
  const blurIds = ref<Set<string>>(new Set())
  let settle: ReturnType<typeof setTimeout> | null = null
  let paused = false

  function recompute() {
    const vp = flow.viewport.value
    zoomAtRest.value = vp.zoom
    const boxes = flow.boxes()
    const { width, height } = flow.size()
    visible.value = countVisible(boxes, { ...vp, width, height })
    const allowedNow = blurAllowed({ mode: mode.value, moving: moving.value, zoom: vp.zoom, visibleNodes: visible.value })
    if (!allowedNow) {
      if (blurIds.value.size) blurIds.value = new Set()
    } else if (mode.value === 'always') {
      // 'always' means every glass shell blurs — skip the "something behind it" test.
      blurIds.value = new Set(boxes.map(b => b.id))
    } else {
      blurIds.value = nodesWithSomethingBehind(boxes, flow.wires())
    }
  }

  function settleSoon() {
    if (paused) return
    if (settle) clearTimeout(settle)
    settle = setTimeout(() => {
      settle = null
      moving.value = false
      recompute()
    }, settleMs)
  }

  // Only a real viewport change means "moving". Sync, so the per-frame cost is exactly
  // one clearTimeout/setTimeout (Vue Flow writes the viewport as one object).
  watch(
    [() => flow.viewport.value.x, () => flow.viewport.value.y, () => flow.viewport.value.zoom],
    () => { moving.value = true; settleSoon() },
    { flush: 'sync' },
  )
  watch(mode, () => settleSoon())
  flow.onMoveEnd?.(() => settleSoon())

  function invalidate() { settleSoon() }
  function pause() {
    paused = true
    if (settle) { clearTimeout(settle); settle = null }
    moving.value = true
  }
  function resume() {
    paused = false
    settleSoon()
  }

  if (getCurrentScope()) onScopeDispose(() => { if (settle) clearTimeout(settle); settle = null })

  const allowed = computed(() => blurAllowed({ mode: mode.value, moving: moving.value, zoom: zoomAtRest.value, visibleNodes: visible.value }))
  const rootClass = computed(() => {
    if (mode.value === 'never') return 'canvas-glass canvas-glass--never'
    return allowed.value ? 'canvas-glass canvas-glass--blur' : 'canvas-glass'
  })
  const rootStyle = computed(() => ({ '--canvas-zoom': String(zoomAtRest.value) }))
  return { rootClass, rootStyle, blurIds, recompute, invalidate, pause, resume, moving }
}

export interface CanvasGlassContext { blurIds: Readonly<Ref<ReadonlySet<string>>> }

export const CANVAS_GLASS_KEY: InjectionKey<CanvasGlassContext> = Symbol('canvas-glass')

export function provideCanvasGlass(g: CanvasGlassContext) {
  provide(CANVAS_GLASS_KEY, g)
}

/** True when this node should carry real blur. False outside a canvas (dev pages, studios). */
export function useNodeGlass(nodeId: MaybeRefOrGetter<string | undefined>): ComputedRef<boolean> {
  const g = inject(CANVAS_GLASS_KEY, null)
  return computed(() => {
    const id = toValue(nodeId)
    return !!g && !!id && g.blurIds.value.has(id)
  })
}
