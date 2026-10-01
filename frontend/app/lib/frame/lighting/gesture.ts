/**
 * One undo step per slider gesture for the light panels. Call `start()` on the slider's
 * pointerdown (capture); every write then asks `take()` whether it should record history: the
 * first write of a pointer gesture does, the rest do not. A write with no pointer gesture under
 * way (arrow keys, typed entry, double-click reset) records on its own.
 *
 * The end is deferred a tick: StudioRow emits a click-to-position value on the element's own
 * pointerup, which a window capture listener would otherwise see the end of the gesture before.
 */
export interface SliderGesture { start(): void; take(): boolean }

export function sliderGesture(): SliderGesture {
  let active = false
  let recorded = false
  const finish = () => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointerup', end, true)
      window.removeEventListener('pointercancel', end, true)
    }
    setTimeout(() => { active = false; recorded = false }, 0)
  }
  function end() { finish() }
  return {
    start() {
      active = true; recorded = false
      if (typeof window !== 'undefined') {
        window.addEventListener('pointerup', end, true)
        window.addEventListener('pointercancel', end, true)
      }
    },
    take() {
      if (!active) return true
      if (recorded) return false
      recorded = true
      return true
    },
  }
}
