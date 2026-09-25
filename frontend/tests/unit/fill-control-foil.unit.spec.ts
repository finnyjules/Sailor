// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'

// happy-dom has no WebGL 2; the picker asks the finish pass whether foil can be lit here.
const gpu = vi.hoisted(() => ({ ok: true }))
vi.mock('~/lib/compositor/finishPass', async (importOriginal) => {
  const orig = await importOriginal<typeof import('~/lib/compositor/finishPass')>()
  return {
    ...orig,
    finishAvailable: () => gpu.ok,
    finishUnavailableReason: () => (gpu.ok ? '' : "Finishes need WebGL 2, which this browser can't provide right now."),
  }
})
import FillControl from '~/components/vue-canvas/compositor/FillControl.vue'
import FillSwatch from '~/components/vue-canvas/compositor/FillSwatch.vue'
import { DEFAULT_FOIL_FILL } from '~/lib/compositor/paint'
import { METALS } from '~/lib/compositor/finishPass'
import { DEFAULT_FRAME_LIGHT, LIGHT_PRESETS } from '~/lib/compositor/frameLight'

const optionValues = (w: ReturnType<typeof mount>) => w.findAll('option').map(o => o.attributes('value'))
async function openPanel(w: ReturnType<typeof mount>) {
  await w.findAll('button')[0]!.trigger('click')
}

describe('FillControl — Foil', () => {
  beforeEach(() => { gpu.ok = true })
  it('offers Foil only when the host passes allowFoil', async () => {
    const plain = mount(FillControl, { props: { modelValue: '#ff0000' } })
    await openPanel(plain)
    expect(optionValues(plain)).not.toContain('foil')

    const frame = mount(FillControl, { props: { modelValue: '#ff0000', allowFoil: true } })
    await openPanel(frame)
    const values = optionValues(frame)
    expect(values).toContain('foil')
    // right after Holographic
    expect(values.indexOf('foil')).toBe(values.indexOf('holographic') + 1)
    expect(frame.find('option[value="foil"]').text()).toBe('Foil')
  })

  it('is never offered on a nested (shader input) picker', async () => {
    const w = mount(FillControl, { props: { modelValue: '#ff0000', allowFoil: true, nested: true } })
    await openPanel(w)
    expect(optionValues(w)).not.toContain('foil')
  })

  it('picking Foil emits a copy of the default foil', async () => {
    const w = mount(FillControl, { props: { modelValue: '#ff0000', allowFoil: true } })
    await openPanel(w)
    await w.find('select').setValue('foil')
    const emitted = w.emitted('update:modelValue')!.at(-1)![0]
    expect(emitted).toEqual(DEFAULT_FOIL_FILL)
    expect(emitted).not.toBe(DEFAULT_FOIL_FILL)
  })

  it('reads a foil value back as Foil and shows its dials in sentence case', async () => {
    const w = mount(FillControl, { props: { modelValue: { ...DEFAULT_FOIL_FILL, metal: 'rose' }, allowFoil: true, light: DEFAULT_FRAME_LIGHT } })
    await openPanel(w)
    expect((w.find('select').element as HTMLSelectElement).value).toBe('foil')
    const text = w.text()
    for (const label of ['Metal', 'Brushed', 'Pressed in', 'Grain', 'Gold', 'Silver', 'Rose gold', 'Copper', 'Light']) expect(text).toContain(label)
    expect(text).not.toMatch(/pressed_in|rose\b(?! gold)|gold_foil/)
  })

  it('a metal pick keeps the other dials', async () => {
    const start = { ...DEFAULT_FOIL_FILL, brushed: 0.2, pressed: 0.9, grain: 0.7 }
    const w = mount(FillControl, { props: { modelValue: start, allowFoil: true } })
    await openPanel(w)
    await w.findAll('button').find(b => b.text() === 'Silver')!.trigger('click')
    expect(w.emitted('update:modelValue')!.at(-1)![0]).toEqual({ ...start, metal: 'silver' })
  })

  it('the light control emits update:light for the host', async () => {
    const w = mount(FillControl, { props: { modelValue: { ...DEFAULT_FOIL_FILL }, allowFoil: true, light: DEFAULT_FRAME_LIGHT } })
    await openPanel(w)
    await w.findAll('button').find(b => b.text() === 'Raking')!.trigger('click')
    expect(w.emitted('update:light')![0]).toEqual([LIGHT_PRESETS.raking])
  })

  it('without WebGL 2 it says why and hides the light (nothing it could light)', async () => {
    gpu.ok = false
    const w = mount(FillControl, { props: { modelValue: { ...DEFAULT_FOIL_FILL }, allowFoil: true, light: DEFAULT_FRAME_LIGHT } })
    await openPanel(w)
    expect(w.text()).toContain('WebGL 2')
    expect(w.find('[data-testid="finish-light-preset"]').exists()).toBe(false)
  })

  it('leaving Foil for Solid keeps the metal\'s mid colour, not a default blue', async () => {
    const w = mount(FillControl, { props: { modelValue: { ...DEFAULT_FOIL_FILL, metal: 'copper' }, allowFoil: true } })
    await openPanel(w)
    await w.find('select').setValue('solid')
    expect(w.emitted('update:modelValue')!.at(-1)![0]).toBe(METALS.copper[2])
  })
})

describe('FillSwatch — Foil', () => {
  it('shows a foil paint as its metal\'s mid colour, not as "no fill"', () => {
    const fills: unknown[] = []
    const strokes: unknown[] = []
    const ctx: any = { clearRect: vi.fn(), fillRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn() }
    Object.defineProperty(ctx, 'fillStyle', { set: (v) => fills.push(v), get: () => fills.at(-1) })
    Object.defineProperty(ctx, 'strokeStyle', { set: (v) => strokes.push(v), get: () => strokes.at(-1) })
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx)
    try {
      mount(FillSwatch, { props: { paint: { ...DEFAULT_FOIL_FILL, metal: 'silver' } } })
      expect(fills).toContain(METALS.silver[2])
      expect(ctx.fillRect).toHaveBeenCalled()
      expect(ctx.stroke).not.toHaveBeenCalled()   // the "none" diagonal
    } finally { spy.mockRestore() }
  })
})
