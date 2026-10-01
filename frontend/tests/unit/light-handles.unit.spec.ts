// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import LightHandles from '~/components/vue-canvas/compositor/LightHandles.vue'
import { newLightLayer } from '~/lib/frame/lighting/settings'
import { lightingDragging, setLightingDrag } from '~/lib/frame/lighting/drag'

function lights() {
  const lamp = { ...newLightLayer('lamp', { x: 0.25, y: 0.5 }), id: 'lamp1' }
  const s = newLightLayer('spot', { x: 0.5, y: 0.04 })
  const spot = { ...s, id: 'spot1', light: { ...s.light, aimX: 0.5, aimY: 0.55 } }
  const sun = { ...newLightLayer('sun', { x: 0.02, y: 0.35 }), id: 'sun1' }
  return [lamp, spot, sun]
}
function make(extra: Record<string, unknown> = {}) {
  return mount(LightHandles, { props: { lights: lights(), selectedIds: ['spot1'], w: 400, h: 500, ...extra }, attachTo: document.body })
}
const pe = (type: string, x: number, y: number) => {
  const e = new Event(type, { bubbles: true, cancelable: true }) as any
  e.clientX = x; e.clientY = y; e.button = 0; e.pointerId = 1
  return e as PointerEvent
}

describe('LightHandles', () => {
  afterEach(() => { setLightingDrag(false); document.body.innerHTML = '' })
  it('draws a dot per light in its colour, a ring on the selected one, an aim ring for the spot only', () => {
    const w = make()
    const dots = w.findAll('[data-testid="light-dot"]')
    expect(dots.map(d => d.attributes('data-light-id'))).toEqual(['lamp1', 'spot1', 'sun1'])
    expect(dots[0]!.attributes('style')).toContain('left: 100px')
    expect(dots[0]!.attributes('style')).toContain('top: 250px')
    expect(dots[1]!.classes()).toContain('is-selected')
    expect(dots[0]!.classes()).not.toContain('is-selected')
    const aims = w.findAll('[data-testid="light-aim"]')
    expect(aims).toHaveLength(1)
    expect(aims[0]!.attributes('data-light-id')).toBe('spot1')
    expect(w.findAll('line').length).toBe(4)   // spot + sun, each a dark under-line and a dashed line
    for (const d of dots) expect(d.attributes('data-handle')).toBeDefined()
    expect(w.text()).toContain('Lamp')
  })
  it('hides hidden lights and makes locked ones inert', () => {
    const ls = lights(); ls[0] = { ...ls[0]!, visible: false }; ls[2] = { ...ls[2]!, locked: true }
    const w = make({ lights: ls })
    expect(w.findAll('[data-testid="light-dot"]').map(d => d.attributes('data-light-id'))).toEqual(['spot1', 'sun1'])
    expect(w.find('[data-light-id="sun1"]').classes()).toContain('pointer-events-none')
  })
  it('a click selects and records nothing', async () => {
    const w = make()
    const dot = w.find('[data-light-id="lamp1"][data-testid="light-dot"]')
    dot.element.dispatchEvent(pe('pointerdown', 10, 10))
    window.dispatchEvent(pe('pointerup', 10, 10))
    expect(w.emitted('select')).toEqual([['lamp1']])
    expect(w.emitted('record')).toBeUndefined()
    expect(w.emitted('change')).toBeUndefined()
    expect(lightingDragging.value).toBe(false)
  })
  it('a drag is one record, then changes; the live flag is on while it moves and off after', () => {
    const w = make()
    const dot = w.find('[data-light-id="lamp1"][data-testid="light-dot"]')
    dot.element.dispatchEvent(pe('pointerdown', 10, 10))
    // happy-dom's rect is 0×0 at 0,0: pointerToLightPos guards the zero size, positions clamp to the range
    window.dispatchEvent(pe('pointermove', 20, 20))
    expect(lightingDragging.value).toBe(true)
    window.dispatchEvent(pe('pointermove', 30, 30))
    window.dispatchEvent(pe('pointerup', 30, 30))
    expect(w.emitted('record')).toHaveLength(1)
    expect(w.emitted('change')).toHaveLength(2)
    const [id, patch] = w.emitted('change')![1] as [string, any]
    expect(id).toBe('lamp1')
    expect(Object.keys(patch).sort()).toEqual(['x', 'y'])
    expect(lightingDragging.value).toBe(false)
    window.dispatchEvent(pe('pointermove', 40, 40))
    expect(w.emitted('change')).toHaveLength(2)   // listeners gone
  })
  it('dragging the aim ring writes the spot aim, not its position', () => {
    const w = make()
    w.find('[data-testid="light-aim"]').element.dispatchEvent(pe('pointerdown', 10, 10))
    window.dispatchEvent(pe('pointermove', 20, 20))
    window.dispatchEvent(pe('pointerup', 20, 20))
    const [id, patch] = w.emitted('change')![0] as [string, any]
    expect(id).toBe('spot1')
    expect(patch.x).toBeUndefined()
    expect(patch.light.type).toBe('spot')
    expect(typeof patch.light.aimX).toBe('number')
  })
  it('the flag is cleared when unmounted mid-drag, and on window blur', () => {
    const w = make()
    w.find('[data-light-id="lamp1"][data-testid="light-dot"]').element.dispatchEvent(pe('pointerdown', 10, 10))
    window.dispatchEvent(pe('pointermove', 20, 20))
    expect(lightingDragging.value).toBe(true)
    w.unmount()
    expect(lightingDragging.value).toBe(false)
    const w2 = make()
    w2.find('[data-light-id="lamp1"][data-testid="light-dot"]').element.dispatchEvent(pe('pointerdown', 10, 10))
    window.dispatchEvent(pe('pointermove', 20, 20))
    window.dispatchEvent(new Event('blur'))
    expect(lightingDragging.value).toBe(false)
  })
  it('arrow keys nudge a focused dot 1% (Shift 5%), one record a press', async () => {
    const w = make()
    const dot = w.find('[data-light-id="lamp1"][data-testid="light-dot"]')
    await dot.trigger('keydown', { key: 'ArrowRight' })
    await dot.trigger('keydown', { key: 'ArrowUp', shiftKey: true })
    await dot.trigger('keydown', { key: 'Delete' })
    expect(w.emitted('record')).toHaveLength(2)
    const changes = w.emitted('change')! as [string, any][]
    expect(changes[0]![1].x).toBeCloseTo(0.26)
    expect(changes[0]![1].y).toBeCloseTo(0.5)
    expect(changes[1]![1].y).toBeCloseTo(0.45)
  })
  it('focusing a dot or aim ring (Tab) selects its light; a key on it does too', async () => {
    const w = make({ selectedIds: ['spot1'] })
    await w.find('[data-light-id="sun1"][data-testid="light-dot"]').trigger('focus')
    expect(w.emitted('select')).toEqual([['sun1']])
    await w.find('[data-testid="light-aim"]').trigger('focus')
    expect(w.emitted('select')).toHaveLength(1)   // the spot is already the selection
    await w.find('[data-light-id="lamp1"][data-testid="light-dot"]').trigger('keydown', { key: 'Delete' })
    expect(w.emitted('select')![1]).toEqual(['lamp1'])
    expect(w.emitted('record')).toBeUndefined()
  })
  it('a held arrow is one undo step: repeats change but do not record', async () => {
    const w = make()
    const dot = w.find('[data-light-id="lamp1"][data-testid="light-dot"]')
    await dot.trigger('keydown', { key: 'ArrowRight' })
    await dot.trigger('keydown', { key: 'ArrowRight', repeat: true })
    await dot.trigger('keydown', { key: 'ArrowRight', repeat: true })
    expect(w.emitted('record')).toHaveLength(1)
    expect(w.emitted('change')).toHaveLength(3)
    expect(lightingDragging.value).toBe(true)   // arrow nudges preview through the fast capped paint
  })
  it('counter-scales dots and aim rings by the zoom; marks the selected dot pressed; names the aim ring', () => {
    const w = make({ zoom: 2 })
    expect(w.find('[data-light-id="lamp1"][data-testid="light-dot"]').attributes('style')).toContain('scale(0.5)')
    expect(w.find('[data-testid="light-aim"]').attributes('style')).toContain('scale(0.5)')
    expect(w.find('[data-light-id="spot1"][data-testid="light-dot"]').attributes('aria-pressed')).toBe('true')
    expect(w.find('[data-light-id="lamp1"][data-testid="light-dot"]').attributes('aria-pressed')).toBe('false')
    expect(w.find('[data-testid="light-aim"]').attributes('aria-label')).toBe('Aim Spot')
  })
  it('scroll over a dot changes Height, one record per wheel run', async () => {
    const w = make()
    const dot = w.find('[data-light-id="lamp1"][data-testid="light-dot"]')
    await dot.trigger('wheel', { deltaY: -100 })
    await dot.trigger('wheel', { deltaY: -100 })
    expect(w.emitted('record')).toHaveLength(1)
    const [, patch] = w.emitted('change')![0] as [string, any]
    expect(patch.light.height).toBeCloseTo(0.65)
    expect(lightingDragging.value).toBe(true)   // nudged; turns off after the run goes quiet
  })
})
