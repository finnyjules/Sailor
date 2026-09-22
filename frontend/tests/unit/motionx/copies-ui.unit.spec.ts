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
import MotionCopiesPreview from '~/components/vue-canvas/compositor/MotionCopiesPreview.vue'
import MotionInspector from '~/components/vue-canvas/compositor/MotionInspector.vue'
import { DEFAULT_CLONER, type Cloner } from '~/composables/useCloner'
import type { StoredBehaviour } from '~/lib/motionx'

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

// ── The Copies gallery preview and the Copies inspector rows (Task 8) ────────
// The preview is one component for all five tiles; the inspector shows ONE Direction row for
// the four Copies kinds that run both ways, and none for `copies.spin`.

function behaviour(kind: string, params: Record<string, unknown> = {}): StoredBehaviour {
  return { id: 'b1', kind, params, timing: { start: 0, duration: 1 } } as StoredBehaviour
}
function mountInspector(kind: string, params: Record<string, unknown> = {}) {
  return mount(MotionInspector, {
    props: {
      motionx: [], behaviours: [behaviour(kind, params)],
      selection: { kind: 'behaviour', path: 'b1' }, duration: 5, t: 0,
    },
  })
}

describe('MotionCopiesPreview', () => {
  const MODES = ['build', 'spread', 'spin', 'fan', 'fade']

  it('mounts and unmounts for all five preview kinds, both directions, without throwing', () => {
    for (const mode of MODES) {
      for (const dir of [undefined, 'in', 'out']) {
        const w = mount(MotionCopiesPreview, { props: { mode, dir } })
        expect(w.find('canvas').exists()).toBe(true)
        // The tiny shared canvas every gallery preview draws on.
        expect(w.get('canvas').attributes('width')).toBe('48')
        expect(w.get('canvas').attributes('height')).toBe('30')
        w.unmount()
      }
    }
  })

  it('survives an unknown mode — a tile added before its branch exists must not crash the gallery', () => {
    const w = mount(MotionCopiesPreview, { props: { mode: 'not-a-mode' } })
    expect(w.find('canvas').exists()).toBe(true)
    w.unmount()
  })
})

describe('the Copies inspector rows', () => {
  it('shows a Direction row for copies.build, In / Out, defaulting to In', () => {
    const w = mountInspector('copies.build')
    const row = w.findComponent('[data-testid="copies-dir"]')
    expect(row.exists()).toBe(true)
    expect(row.props('modelValue')).toBe('in')
    expect(row.props('options')).toEqual(['in', 'out'])
    expect(row.props('optionLabels')).toEqual(['In', 'Out'])
    expect(row.props('label')).toBe('Direction')
  })

  it('shows NO Direction row for copies.spin — a ring turns one way', () => {
    const w = mountInspector('copies.spin')
    expect(w.find('[data-testid="copies-dir"]').exists()).toBe(false)
    // The bar is still a normal behaviour card: it keeps its timing rows.
    expect(w.find('[data-testid="beh-duration"]').exists()).toBe(true)
  })

  it('words the spread bar as the gallery tiles do, defaulting to Spread out', () => {
    const w = mountInspector('copies.spread')
    const row = w.findComponent('[data-testid="copies-dir"]')
    expect(row.props('modelValue')).toBe('out')
    expect(row.props('options')).toEqual(['out', 'in'])
    expect(row.props('optionLabels')).toEqual(['Spread out', 'Gather in'])
  })

  it('shows In / Out for fan and fade too, and reads a stored dir back', () => {
    for (const kind of ['copies.fan', 'copies.fade']) {
      const w = mountInspector(kind, { dir: 'out' })
      const row = w.findComponent('[data-testid="copies-dir"]')
      expect(row.exists(), `${kind} has no Direction row`).toBe(true)
      expect(row.props('modelValue')).toBe('out')
      expect(row.props('optionLabels')).toEqual(['In', 'Out'])
    }
  })

  it('every Copies bar keeps the Easing card and Open into keyframes', () => {
    for (const kind of ['copies.build', 'copies.spread', 'copies.spin', 'copies.fan', 'copies.fade']) {
      const w = mountInspector(kind)
      expect(w.findComponent({ name: 'MotionEasingCurve' }).exists(), `${kind} lost its easing card`).toBe(true)
      expect(w.find('[data-testid="beh-open"]').exists(), `${kind} lost Open into keyframes`).toBe(true)
    }
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
