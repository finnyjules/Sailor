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
  const flow: GlassFlow = {
    onMoveStart: (cb) => { start = cb }, onMoveEnd: (cb) => { end = cb },
    viewport, boxes: () => state.boxes, wires: () => state.wires, size: () => ({ width: 1200, height: 800 }),
  }
  return { flow, viewport, state, fireStart: () => start(), fireEnd: () => end() }
}

describe('createCanvasGlass', () => {
  beforeEach(() => { vi.useFakeTimers() })

  it('blurs only overlapping nodes at rest', () => {
    const f = fakeFlow()
    const g = createCanvasGlass(f.flow)
    g.recompute()
    expect(g.rootClass.value).toContain('canvas-glass--blur')
    expect(g.blurIds.value).toEqual(new Set(['a', 'b']))
  })

  it('drops blur the moment the canvas moves, restores it after settling', async () => {
    const f = fakeFlow()
    const g = createCanvasGlass(f.flow, { settleMs: 150 })
    g.recompute()
    f.fireStart()
    expect(g.rootClass.value).not.toContain('canvas-glass--blur')
    f.fireEnd()
    expect(g.rootClass.value).not.toContain('canvas-glass--blur') // still settling
    vi.advanceTimersByTime(150)
    await nextTick()
    expect(g.rootClass.value).toContain('canvas-glass--blur')
  })

  it('updates --canvas-zoom only at move end', () => {
    const f = fakeFlow()
    const g = createCanvasGlass(f.flow, { settleMs: 0 })
    f.fireStart()
    f.viewport.value = { x: 0, y: 0, zoom: 2 }
    expect(g.rootStyle.value['--canvas-zoom']).toBe('1')
    f.fireEnd(); vi.advanceTimersByTime(0)
    expect(g.rootStyle.value['--canvas-zoom']).toBe('2')
  })

  it("mode 'never' keeps the root un-blurred", () => {
    const f = fakeFlow()
    const g = createCanvasGlass(f.flow, { mode: ref('never') })
    g.recompute()
    expect(g.rootClass.value).toBe('canvas-glass')
  })
})
