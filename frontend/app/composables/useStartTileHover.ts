// One shared rAF loop for the start modal: only hovered tiles whose studio is
// time-driven repaint, only while the page is visible; stops on leave/close.
import { onBeforeUnmount } from 'vue'
import type { StartPickId } from '~/data/start-modal'
import { ANIMATED_STILLS, paintStill } from '~/lib/startModal/stills'

export function useStartTileHover() {
  const live = new Map<StartPickId, { canvas: HTMLCanvasElement; t: number; busy: boolean }>()
  let raf = 0, last = 0
  const loop = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000); last = now
    if (document.visibilityState === 'visible') {
      for (const [id, s] of live) {
        if (s.busy) continue
        s.t += dt; s.busy = true
        void paintStill(id, s.canvas, s.t).finally(() => { s.busy = false })
      }
    }
    raf = live.size ? requestAnimationFrame(loop) : 0
  }
  function enter(id: StartPickId, canvas: HTMLCanvasElement) {
    if (!ANIMATED_STILLS.has(id)) return
    live.set(id, { canvas, t: 0, busy: false })
    if (!raf) { last = performance.now(); raf = requestAnimationFrame(loop) }
  }
  function leave(id: StartPickId) { live.delete(id) }
  function stopAll() { live.clear(); if (raf) cancelAnimationFrame(raf); raf = 0 }
  onBeforeUnmount(stopAll)
  return { enter, leave, stopAll }
}
