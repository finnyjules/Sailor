import { computed, onMounted, onScopeDispose, ref, watch, type Ref } from 'vue'
import { masterFrameIndex } from '~/lib/compositor/masterClock'
import { onCanvasOcclusion } from '~/lib/studio/occlusion'

/**
 * useCanvasCardPreviewLoop — ONE gated, fps-throttled rAF preview loop for a
 * canvas studio card.
 *
 * Every studio card on the canvas (Frame, Space Type, Shader, Gradient, Vector
 * Type, Timeline, …) used to hand-roll its own per-frame render loop. Most of
 * those loops never paused: a card scrolled out of the viewport, a hidden tab,
 * or a fullscreen studio modal covering the whole canvas all kept the loop
 * running, rendering WebGL/video frames nobody could see and competing with
 * whatever preview WAS on screen for the main thread. A board with several
 * animated cards therefore ran N concurrent loops at the display refresh rate
 * (up to 120Hz on ProMotion), repainting identical frames.
 *
 * This composable consolidates the three hand-rolled copies of the proven Frame
 * pattern (ArtifactFrameNode, SpaceTypeNode, CompositorModal) into one place. It
 * owns, entirely:
 *   - the `{ visible, tabActive, editorOpen, hovered }` gate and `gateOk()`;
 *   - the IntersectionObserver on `rootEl` (visible);
 *   - the document `visibilitychange` listener (tabActive);
 *   - the `onCanvasOcclusion` subscription (editorOpen) — see occlusion.ts's
 *     header for WHY the gate matters (a card behind a fullscreen modal renders
 *     a scene nobody sees, ~13fps measured in the Space Type case);
 *   - the hover `pointerenter`/`pointerleave` listeners (hovered) when
 *     `hoverToPlay`, matching the canvas-scenes-hover-to-play behaviour;
 *   - the rAF loop with the `masterFrameIndex`/`lastRenderedFrame` throttle so a
 *     30fps scene is rendered once per distinct content frame, not once per
 *     display repaint; and an async in-flight guard that SKIPS (never queues) a
 *     tick while an async `onFrame` is outstanding, so a slow pull degrades to a
 *     lower frame rate instead of piling up.
 *
 * It ONLY ever skips work — it never changes WHAT a card renders, only WHEN. On
 * hover-leave (or any pause) it calls `onIdle` once so the card settles on a
 * stable still (t=0) rather than freezing mid-animation.
 *
 * NO `will-change`/GPU-layer promotion anywhere: promoting a layer over a WebGL
 * surface crashed a tab earlier (compositor-modal-pan-lag). This is pure loop
 * gating.
 */
export interface CanvasCardPreviewLoopOptions {
  /** IntersectionObserver + hover listeners attach here. */
  rootEl: Ref<HTMLElement | null>
  /** Is there anything to animate right now (the card's needsClock/animated/shouldLoop). */
  active: () => boolean
  /** Content fps for the throttle. Default 30. */
  fps?: () => number
  /** Hover-to-play: only animate while the pointer is over the card. Default true. */
  hoverToPlay?: boolean
  /** The card's per-tick render. May be async (awaited; further ticks skip while in flight). */
  onFrame: (ctx: { frameIdx: number; t: number }) => void | Promise<void>
  /** Render a still/poster (t=0) when the loop pauses or the pointer leaves. Optional. */
  onIdle?: () => void
}

export interface CanvasCardPreviewLoop {
  /** True when the loop is currently allowed to run (visible, tab active, not occluded, hovered). */
  gateOk: () => boolean
}

export function useCanvasCardPreviewLoop(opts: CanvasCardPreviewLoopOptions): CanvasCardPreviewLoop {
  const hoverToPlay = opts.hoverToPlay ?? true
  const activeC = computed(() => opts.active())

  // The gate: the loop runs only when ALL are satisfied. `hovered` is required
  // only under hoverToPlay (otherwise it stays true and never gates).
  const gate = { visible: true, tabActive: true, editorOpen: false, hovered: !hoverToPlay }
  function gateOk(): boolean {
    return gate.visible && gate.tabActive && !gate.editorOpen && (!hoverToPlay || gate.hovered)
  }

  let raf = 0
  let animStart = 0
  let inFlight = false
  let lastRenderedFrame = -1

  function animate(ts: number) {
    if (!animStart) animStart = ts
    const t = (ts - animStart) / 1000
    const previewFps = Math.max(1, opts.fps?.() ?? 30)
    const frameIdx = masterFrameIndex(t, previewFps)
    // Render once per DISTINCT content frame, not once per display repaint; and
    // skip (don't queue) a tick while an async onFrame is still outstanding.
    if (!inFlight && frameIdx !== lastRenderedFrame) {
      lastRenderedFrame = frameIdx
      const ret = opts.onFrame({ frameIdx, t })
      if (ret && typeof (ret as Promise<void>).then === 'function') {
        inFlight = true
        Promise.resolve(ret).finally(() => { inFlight = false })
      }
    }
    raf = requestAnimationFrame(animate)
  }

  function start() {
    cancelAnimationFrame(raf)
    animStart = 0
    inFlight = false
    lastRenderedFrame = -1
    if (activeC.value && gateOk()) raf = requestAnimationFrame(animate)
  }
  function stop() {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
  }
  function apply() {
    const shouldRun = activeC.value && gateOk()
    if (shouldRun && !raf) start()
    else if (!shouldRun && raf) { stop(); opts.onIdle?.() }
  }

  // Restart/stop whenever the card's "should I animate" predicate flips.
  watch(activeC, apply)

  // ── Gate wiring (mount) ──────────────────────────────────────────────────
  let io: IntersectionObserver | null = null
  let onVisibility: (() => void) | null = null
  let unsubOcclusion: (() => void) | null = null
  let onEnter: (() => void) | null = null
  let onLeave: (() => void) | null = null

  onMounted(() => {
    io = new IntersectionObserver(([entry]) => { gate.visible = !!entry?.isIntersecting; apply() }, { threshold: 0.01 })
    if (opts.rootEl.value) io.observe(opts.rootEl.value)
    onVisibility = () => { gate.tabActive = !document.hidden; apply() }
    document.addEventListener('visibilitychange', onVisibility)
    // One canonical signal for "a fullscreen studio modal now covers the canvas".
    // Fires immediately with the current state, so a card mounted mid-modal starts paused.
    unsubOcclusion = onCanvasOcclusion((open) => { gate.editorOpen = open; apply() })
    if (hoverToPlay && opts.rootEl.value) {
      onEnter = () => { gate.hovered = true; apply() }
      onLeave = () => { gate.hovered = false; apply() }
      opts.rootEl.value.addEventListener('pointerenter', onEnter)
      opts.rootEl.value.addEventListener('pointerleave', onLeave)
    }
    apply()
  })

  onScopeDispose(() => {
    stop()
    io?.disconnect(); io = null
    if (onVisibility) document.removeEventListener('visibilitychange', onVisibility)
    unsubOcclusion?.(); unsubOcclusion = null
    if (opts.rootEl.value) {
      if (onEnter) opts.rootEl.value.removeEventListener('pointerenter', onEnter)
      if (onLeave) opts.rootEl.value.removeEventListener('pointerleave', onLeave)
    }
    onEnter = onLeave = null
  })

  return { gateOk }
}
