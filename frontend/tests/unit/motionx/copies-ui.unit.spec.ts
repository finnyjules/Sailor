// @vitest-environment happy-dom
/**
 * THE COPIES CARD — the Motion tab's card for a cloned layer's motion (Task 5 of the
 * cloner motion plan). Mounted with `@vue/test-utils`, same idiom `motion-easing-curve-ui`
 * uses: `MotionCopiesPanel.vue` is not shared with another in-flight task, so there is no
 * need for `letters-ui.unit.spec`'s source-string extraction.
 *
 * Covers:
 *   1. A fresh (non-staggered) cloner: heading "Copies", Stagger at 0, Order "First to last".
 *   2. Stagger is a gesture-coalesced slider: one drag records ONE `before-change`, not one
 *      per pixel — same `undoCoalesce` idiom `MotionInspector.vue` uses.
 *   3. Picking "Random" order is its own undo step and shows the shuffle button; any other
 *      order hides it.
 *   4. Shuffle re-rolls `motionSeed` — its own undo step too.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import MotionCopiesPanel from '~/components/vue-canvas/compositor/MotionCopiesPanel.vue'
import { DEFAULT_CLONER, type Cloner } from '~/composables/useCloner'

function makeCloner(patch: Partial<Cloner> = {}): Cloner {
  return { ...DEFAULT_CLONER, enabled: true, ...patch }
}

describe('MotionCopiesPanel: a fresh cloner', () => {
  it('shows the Copies heading, Stagger at 0, and Order "First to last"', () => {
    const w = mount(MotionCopiesPanel, { props: { cloner: makeCloner() } })
    expect(w.find('.mi-heading').text()).toBe('Copies')

    const stagger = w.findComponent('[data-testid="copies-stagger"]')
    expect(stagger.exists()).toBe(true)
    expect(stagger.props('modelValue')).toBe(0)
    expect(stagger.props('min')).toBe(0)
    expect(stagger.props('max')).toBe(2)
    expect(stagger.props('step')).toBe(0.01)

    const order = w.get('[data-testid="copies-order"]')
    const first = order.get('[data-value="first"]')
    expect(first.text()).toBe('First to last')
    expect(first.attributes('aria-checked')).toBe('true')
  })

  it('hides the shuffle button — order is not random', () => {
    const w = mount(MotionCopiesPanel, { props: { cloner: makeCloner() } })
    expect(w.find('[data-testid="copies-shuffle"]').exists()).toBe(false)
  })
})

describe('MotionCopiesPanel: Stagger drag', () => {
  it('one drag records ONE before-change; the rest of the drag rides along, each update carrying motionStagger', async () => {
    const w = mount(MotionCopiesPanel, { props: { cloner: makeCloner() } })
    const stagger = w.findComponent('[data-testid="copies-stagger"]')

    await stagger.trigger('pointerdown')
    await stagger.vm.$emit('update:modelValue', 0.2)
    await stagger.vm.$emit('update:modelValue', 0.35)
    await stagger.trigger('pointerup')

    expect(w.emitted('before-change')?.length).toBe(1)
    const updates = w.emitted('update') as unknown[][]
    expect(updates.length).toBe(2)
    expect((updates[0]![0] as Cloner).motionStagger).toBe(0.2)
    expect((updates[1]![0] as Cloner).motionStagger).toBe(0.35)
    // Every other field rides along unchanged.
    expect((updates[1]![0] as Cloner).mode).toBe('linear')
  })

  it('a second, separate drag records its own before-change', async () => {
    const w = mount(MotionCopiesPanel, { props: { cloner: makeCloner() } })
    const stagger = w.findComponent('[data-testid="copies-stagger"]')

    await stagger.trigger('pointerdown')
    await stagger.vm.$emit('update:modelValue', 0.1)
    await stagger.trigger('pointerup')
    await stagger.trigger('pointerdown')
    await stagger.vm.$emit('update:modelValue', 0.4)
    await stagger.trigger('pointerup')

    expect(w.emitted('before-change')?.length).toBe(2)
  })
})

describe('MotionCopiesPanel: Order', () => {
  it('picking Random is its own undo step, emits motionOrder, and reveals the shuffle button', async () => {
    const w = mount(MotionCopiesPanel, { props: { cloner: makeCloner() } })
    await w.get('[data-testid="copies-order"] [data-value="random"]').trigger('click')

    expect(w.emitted('before-change')?.length).toBe(1)
    const updates = w.emitted('update') as unknown[][]
    expect((updates.at(-1)![0] as Cloner).motionOrder).toBe('random')

    await w.setProps({ cloner: makeCloner({ motionOrder: 'random' }) })
    expect(w.find('[data-testid="copies-shuffle"]').exists()).toBe(true)
  })

  it('offers all four orders, in COPY_ORDERS order, with their gallery labels', () => {
    const w = mount(MotionCopiesPanel, { props: { cloner: makeCloner() } })
    const order = w.get('[data-testid="copies-order"]')
    const buttons = order.findAll('[role="radio"]')
    expect(buttons.map((b) => b.attributes('data-value'))).toEqual(['first', 'last', 'centre', 'random'])
    expect(buttons.map((b) => b.text())).toEqual(['First to last', 'Last to first', 'Centre out', 'Random'])
  })
})

describe('MotionCopiesPanel: Shuffle', () => {
  it('is hidden for every non-random order', () => {
    for (const motionOrder of ['first', 'last', 'centre'] as const) {
      const w = mount(MotionCopiesPanel, { props: { cloner: makeCloner({ motionOrder }) } })
      expect(w.find('[data-testid="copies-shuffle"]').exists()).toBe(false)
    }
  })

  it('re-rolls motionSeed to a new value and records its own undo step', async () => {
    const w = mount(MotionCopiesPanel, { props: { cloner: makeCloner({ motionOrder: 'random', motionSeed: 1 }) } })
    const shuffle = w.get('[data-testid="copies-shuffle"]')
    expect(shuffle.attributes('title')).toBe('New order')

    await shuffle.trigger('click')

    expect(w.emitted('before-change')?.length).toBe(1)
    const updates = w.emitted('update') as unknown[][]
    const cl = updates.at(-1)![0] as Cloner
    expect(cl.motionOrder).toBe('random')
    expect(cl.motionSeed).not.toBe(1)
  })
})
