import { computed, inject, provide, ref, toValue, type ComputedRef, type InjectionKey, type MaybeRefOrGetter, type Ref } from 'vue'
import { blurAllowed, countVisible, nodesWithSomethingBehind, type GlassMode, type NodeBox, type Wire } from '~/lib/canvas/glassPolicy'

export interface GlassFlow {
  onMoveStart(cb: () => void): void
  onMoveEnd(cb: () => void): void
  viewport: Ref<{ x: number; y: number; zoom: number }>
  boxes: () => NodeBox[]
  wires: () => Wire[]
  size: () => { width: number; height: number }
}

/**
 * The canvas's glass switch. Blur is decided once per REST, never per frame: move start
 * turns it off with a single class change on the root, move end (after a short settle)
 * recomputes which nodes have something behind them and turns it back on. The zoom used
 * for the one-screen-pixel border is also published only at rest, so a pinch never
 * restyles every node on every frame.
 */
export function createCanvasGlass(flow: GlassFlow, opts: { mode?: Ref<GlassMode>; settleMs?: number } = {}) {
  const mode = opts.mode ?? ref<GlassMode>('smart')
  const settleMs = opts.settleMs ?? 150
  const moving = ref(false)
  const zoomAtRest = ref(flow.viewport.value.zoom)
  const visible = ref(0)
  const blurIds = ref<Set<string>>(new Set())
  let settle: ReturnType<typeof setTimeout> | null = null

  function recompute() {
    const boxes = flow.boxes()
    const { width, height } = flow.size()
    visible.value = countVisible(boxes, { ...flow.viewport.value, width, height })
    blurIds.value = nodesWithSomethingBehind(boxes, flow.wires())
  }

  flow.onMoveStart(() => {
    if (settle) { clearTimeout(settle); settle = null }
    moving.value = true
  })
  flow.onMoveEnd(() => {
    if (settle) clearTimeout(settle)
    settle = setTimeout(() => {
      settle = null
      zoomAtRest.value = flow.viewport.value.zoom
      recompute()
      moving.value = false
    }, settleMs)
  })

  const allowed = computed(() => blurAllowed({ mode: mode.value, moving: moving.value, zoom: zoomAtRest.value, visibleNodes: visible.value }))
  const rootClass = computed(() => (allowed.value ? 'canvas-glass canvas-glass--blur' : 'canvas-glass'))
  const rootStyle = computed(() => ({ '--canvas-zoom': String(zoomAtRest.value) }))
  return { rootClass, rootStyle, blurIds, recompute, moving }
}

export const CANVAS_GLASS_KEY: InjectionKey<{ blurIds: Ref<Set<string>> }> = Symbol('canvas-glass')

export function provideCanvasGlass(g: { blurIds: Ref<Set<string>> }) {
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
