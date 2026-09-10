// @vitest-environment happy-dom
//
// Component-level proof for Fix 1 / Fix 3 on the Layout tab's tile (see
// frame-layout-tab.spec.ts for the E2E proof). The E2E fixture can't isolate
// this cleanly: `elements.images` (frameContext.ts / posterLayerViews) only
// ever contains `kind:'image'` layers — a pattern's own "photo" role can
// never be a wired layer — so a tile's colour-diversity in the dev-lab
// fixture is dominated by its local `pic` layer regardless of whether the
// wired span is open. This test isolates the wired span itself: it mocks
// `useCompositorLayers` and asserts LayoutTile opens `withWiredContent` with
// its `wiredContent` prop around the paint, and awaits both image and font
// readiness BEFORE that span opens (never inside it — see withWiredContent's
// own doc on why the span must stay synchronous).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import LayoutTile from '~/components/vue-canvas/compositor/LayoutTile.vue'

const calls: string[] = []
const fontsMock = vi.fn(async () => { calls.push('fonts') })
const imagesMock = vi.fn(async () => { calls.push('images') })
const paintMock = vi.fn(() => { calls.push('paint') })
const wiredMock = vi.fn((_provider: unknown, fn: () => void) => { calls.push('wired'); return fn() })

vi.mock('~/composables/useCompositorLayers', () => ({
  paintLayerStack: (...args: unknown[]) => paintMock(...args),
  ensureLayerFonts: (...args: unknown[]) => fontsMock(...args),
  ensureLayerImages: (...args: unknown[]) => imagesMock(...args),
  withWiredContent: (...args: unknown[]) => wiredMock(args[0], args[1] as () => void),
}))

const basePlan = {
  layers: [{ id: 'l1', kind: 'text', text: 'Hi' }],
  order: ['l:l1'],
  posterState: { patternId: 'runoff', seed: 1 },
} as any

beforeEach(() => {
  calls.length = 0
  fontsMock.mockClear(); imagesMock.mockClear(); paintMock.mockClear(); wiredMock.mockClear()
  // happy-dom's canvas has no real 2D context (getContext('2d') returns
  // null) — stub just enough for the component's OWN setup calls; the actual
  // drawing (paintLayerStack) is mocked above, so nothing here needs to draw.
  HTMLCanvasElement.prototype.getContext = (() => ({ setTransform: () => {}, clearRect: () => {} })) as any
})

describe('LayoutTile — wired content span (Fix 1 / Fix 3)', () => {
  it('opens a withWiredContent span around the paint, using the wiredContent prop', async () => {
    const provider = (_slot: number) => null
    mount(LayoutTile, { props: { plan: basePlan, frameW: 100, frameH: 100, label: 'Test', wiredContent: provider } })
    await flushPromises()
    expect(wiredMock).toHaveBeenCalledTimes(1)
    expect(wiredMock.mock.calls[0]![0]).toBe(provider)
    expect(paintMock).toHaveBeenCalledTimes(1)
  })

  it('defaults the provider to null when no wiredContent prop is given (never crashes without one)', async () => {
    mount(LayoutTile, { props: { plan: basePlan, frameW: 100, frameH: 100, label: 'Test' } })
    await flushPromises()
    expect(wiredMock.mock.calls[0]![0]).toBeNull()
  })

  it('awaits BOTH ensureLayerFonts and ensureLayerImages before the span opens, and paints inside it', async () => {
    mount(LayoutTile, { props: { plan: basePlan, frameW: 100, frameH: 100, label: 'Test' } })
    await flushPromises()
    expect(calls.indexOf('fonts')).toBeGreaterThanOrEqual(0)
    expect(calls.indexOf('images')).toBeGreaterThanOrEqual(0)
    expect(calls.indexOf('fonts')).toBeLessThan(calls.indexOf('wired'))
    expect(calls.indexOf('images')).toBeLessThan(calls.indexOf('wired'))
    expect(calls.indexOf('wired')).toBeLessThan(calls.indexOf('paint'))
  })
})
