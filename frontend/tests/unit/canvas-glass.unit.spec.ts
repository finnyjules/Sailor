import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, nextTick } from 'vue'
import { createCanvasGlass, type GlassFlow } from '~/composables/useCanvasGlass'

function fakeFlow() {
  let start = () => {}, end = () => {}
  const viewport = ref({ x: 0, y: 0, zoom: 1 })
  const state = {
    boxes: [{ id: 'a', x: 0, y: 0, w: 100, h: 100 }, { id: 'b', x: 50, y: 50, w: 100, h: 100 }, { id: 'c', x: 400, y: 0, w: 100, h: 100 }],
    wires: [] as any[],
  }
  const boxes = vi.fn(() => state.boxes)
  const flow: GlassFlow = {
    onMoveStart: (cb) => { start = cb }, onMoveEnd: (cb) => { end = cb },
    viewport, boxes, wires: () => state.wires, size: () => ({ width: 1200, height: 800 }),
  }
  return { flow, viewport, state, boxes, fireStart: () => start(), fireEnd: () => end() }
}

describe('createCanvasGlass', () => {
  beforeEach(() => { vi.useFakeTimers() })

  it('blurs only overlapping nodes at rest (smart)', () => {
    const f = fakeFlow()
    const g = createCanvasGlass(f.flow, { mode: ref('smart') })
    g.recompute()
    expect(g.rootClass.value).toContain('canvas-glass--blur')
    expect(g.blurIds.value).toEqual(new Set(['a', 'b']))
  })

  // Adapted: "moving" now comes from the viewport, not from move events, so this
  // drives a viewport write where it used to fire moveStart/moveEnd.
  it('drops blur the moment the viewport moves, restores it after settling (smart)', async () => {
    const f = fakeFlow()
    const g = createCanvasGlass(f.flow, { mode: ref('smart'), settleMs: 150 })
    g.recompute()
    f.viewport.value = { x: 10, y: 0, zoom: 1 }
    expect(g.rootClass.value).not.toContain('canvas-glass--blur')
    vi.advanceTimersByTime(100)
    f.viewport.value = { x: 20, y: 0, zoom: 1 } // still moving: the settle re-arms
    vi.advanceTimersByTime(100)
    expect(g.rootClass.value).not.toContain('canvas-glass--blur')
    vi.advanceTimersByTime(50)
    await nextTick()
    expect(g.rootClass.value).toContain('canvas-glass--blur')
  })

  it('updates --canvas-zoom only once the viewport settles', () => {
    const f = fakeFlow()
    const g = createCanvasGlass(f.flow, { settleMs: 0 })
    f.fireStart()
    f.viewport.value = { x: 0, y: 0, zoom: 2 }
    expect(g.rootStyle.value['--canvas-zoom']).toBe('1')
    f.fireEnd(); vi.advanceTimersByTime(0)
    expect(g.rootStyle.value['--canvas-zoom']).toBe('2')
  })

  it('a programmatic viewport write (no move events) drops blur, then publishes the zoom and restores blur (smart)', () => {
    const f = fakeFlow()
    const g = createCanvasGlass(f.flow, { mode: ref('smart'), settleMs: 150 })
    g.recompute()
    expect(g.rootClass.value).toContain('canvas-glass--blur')
    f.viewport.value = { x: -30, y: 12, zoom: 0.8 } // fitView / setViewport: no moveStart, no moveEnd
    expect(g.rootClass.value).not.toContain('canvas-glass--blur')
    expect(g.rootStyle.value['--canvas-zoom']).toBe('1')
    vi.advanceTimersByTime(150)
    expect(g.rootStyle.value['--canvas-zoom']).toBe('0.8')
    expect(g.rootClass.value).toContain('canvas-glass--blur')
    expect(g.moving.value).toBe(false)
  })

  it('a move start with no viewport change leaves blur on', () => {
    const f = fakeFlow()
    const g = createCanvasGlass(f.flow, { settleMs: 150 })
    g.recompute()
    f.fireStart()
    expect(g.rootClass.value).toContain('canvas-glass--blur')
    vi.advanceTimersByTime(1000)
    expect(g.moving.value).toBe(false)
    expect(g.rootClass.value).toContain('canvas-glass--blur')
  })

  it('several invalidate() calls coalesce into one recompute (smart)', () => {
    const f = fakeFlow()
    const g = createCanvasGlass(f.flow, { mode: ref('smart'), settleMs: 150 })
    f.boxes.mockClear()
    g.invalidate(); g.invalidate(); g.invalidate()
    expect(f.boxes).not.toHaveBeenCalled()
    expect(g.rootClass.value).toContain('canvas-glass--blur') // invalidate never sets moving
    vi.advanceTimersByTime(150)
    expect(f.boxes).toHaveBeenCalledTimes(1)
    expect(g.blurIds.value).toEqual(new Set(['a', 'b']))
  })

  it('pause() drops blur for a drag and resume() restores it after the settle (smart)', () => {
    const f = fakeFlow()
    const g = createCanvasGlass(f.flow, { mode: ref('smart'), settleMs: 150 })
    g.recompute()
    g.pause()
    expect(g.rootClass.value).not.toContain('canvas-glass--blur')
    g.invalidate() // a resize mid-drag must not end the pause
    vi.advanceTimersByTime(500)
    expect(g.rootClass.value).not.toContain('canvas-glass--blur')
    g.resume()
    expect(g.rootClass.value).not.toContain('canvas-glass--blur')
    vi.advanceTimersByTime(150)
    expect(g.rootClass.value).toContain('canvas-glass--blur')
  })

  it('skips the behind-test when blur is not allowed, but still counts visible nodes', () => {
    const f = fakeFlow()
    const g = createCanvasGlass(f.flow, { settleMs: 0 })
    f.viewport.value = { x: 0, y: 0, zoom: 0.3 } // under the zoom floor
    vi.advanceTimersByTime(0)
    expect(g.rootStyle.value['--canvas-zoom']).toBe('0.3')
    expect(g.rootClass.value).not.toContain('canvas-glass--blur')
    expect(g.blurIds.value.size).toBe(0)
  })

  it('default mode (always) keeps blur on through a viewport move', () => {
    const f = fakeFlow()
    const g = createCanvasGlass(f.flow) // default: 'always'
    g.recompute()
    expect(g.rootClass.value).toContain('canvas-glass--blur')
    f.viewport.value = { x: 10, y: 0, zoom: 1 } // pan
    expect(g.rootClass.value).toContain('canvas-glass--blur')
    vi.advanceTimersByTime(150)
    expect(g.rootClass.value).toContain('canvas-glass--blur')
  })

  it('default mode (always) marks a node with nothing behind it — what useNodeGlass reads', () => {
    const f = fakeFlow()
    const g = createCanvasGlass(f.flow) // default: 'always'
    g.recompute()
    // 'c' does not overlap a/b and has no wire behind it, yet 'always' blurs every node,
    // so useNodeGlass('c') (which reads exactly this set) would resolve to true.
    expect(g.blurIds.value.has('c')).toBe(true)
  })

  it('default mode (always) drops blur after settling at zoom 0.4 and restores it at 0.6', () => {
    const f = fakeFlow()
    const g = createCanvasGlass(f.flow, { settleMs: 150 }) // default: 'always'
    g.recompute()
    f.viewport.value = { x: 0, y: 0, zoom: 0.4 }
    vi.advanceTimersByTime(150)
    expect(g.rootClass.value).not.toContain('canvas-glass--blur')
    expect(g.blurIds.value.size).toBe(0)
    f.viewport.value = { x: 0, y: 0, zoom: 0.6 }
    vi.advanceTimersByTime(150)
    expect(g.rootClass.value).toContain('canvas-glass--blur')
    expect(g.blurIds.value).toEqual(new Set(['a', 'b', 'c']))
  })

  it('pause() does not turn off blur in always mode', () => {
    const f = fakeFlow()
    const g = createCanvasGlass(f.flow) // default: 'always'
    g.recompute()
    g.pause()
    expect(g.rootClass.value).toContain('canvas-glass--blur')
    g.resume()
    expect(g.rootClass.value).toContain('canvas-glass--blur')
  })

  it("mode 'never' keeps the root un-blurred and marks the mode", () => {
    const f = fakeFlow()
    const g = createCanvasGlass(f.flow, { mode: ref('never') })
    g.recompute()
    expect(g.rootClass.value).toBe('canvas-glass canvas-glass--never')
    expect(g.blurIds.value.size).toBe(0)
  })
})
