// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { useBrushPaint, paintMatchesLayer } from '~/composables/useBrushPaint'
import BrushToolbar from '~/components/vue-canvas/compositor/BrushToolbar.vue'
beforeEach(() => localStorage.clear())
describe('brush paint choice', () => {
  it('matches layers by paint', () => {
    expect(paintMatchesLayer(undefined, null)).toBe(true)
    expect(paintMatchesLayer({ id: 'lava' }, 'lava')).toBe(true)
    expect(paintMatchesLayer({ id: 'lava' }, null)).toBe(false)
    expect(paintMatchesLayer(undefined, 'foil')).toBe(false)
  })
  it('starts on Colour, remembers a material, ignores junk', () => {
    expect(useBrushPaint().material.value).toBeNull()
    localStorage.setItem('sailor.brushTips.v1', JSON.stringify({ material: 'chrome' }))
    expect(useBrushPaint().material.value).toBe('chrome')
    localStorage.setItem('sailor.brushTips.v1', JSON.stringify({ material: 'gold' }))
    expect(useBrushPaint().material.value).toBeNull()
  })
  it('toolbar swatches pick a material', async () => {
    const brush = useBrushPaint()
    const w = mount(BrushToolbar, { props: { brush }, global: { stubs: { StudioColor: true } } })
    await w.get('[data-testid="brush-material-neon"]').trigger('click')
    expect(brush.material.value).toBe('neon')
    expect(w.get('[data-testid="brush-material-neon"]').attributes('aria-label')).toBe('Neon')
  })
})
