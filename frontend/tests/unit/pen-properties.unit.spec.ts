// @vitest-environment happy-dom
//
// Pen stage 6, the Properties panel: the heading and the sizes for a point,
// a line and an arc (typed with the value row's field — Enter commits as one
// step, Escape or leaving the field puts it back), disabled sizes for fixed
// points, the radius lock, the rules list (named, hover lights the pieces and
// clears when the row goes, × removes, copy rules hidden) and the + list —
// cheap check on open, the full check on hover or pick (controller ruling
// C1); inert while Clean up previews. The value row still works through the
// shared field.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref, nextTick } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addLine, addPath, addConstraint } from '~/lib/sketch/edit'
import { usePen } from '~/composables/pen/usePen'

vi.mock('~/components/pen/PenTipCard.vue', async () => {
  const { defineComponent: dc } = await import('vue')
  return { default: dc({ setup: (_, { slots }) => () => slots.default?.() }) }
})
vi.mock('~/components/ui/tooltip', async () => {
  const { defineComponent: dc } = await import('vue')
  const pass = dc({ setup: (_, { slots }) => () => slots.default?.() })
  return { TooltipProvider: pass, Tooltip: pass, TooltipTrigger: pass }
})
// counts the full rule check's trial solves (passes through)
vi.mock('~/lib/sketch/ruleCheck', async (orig) => {
  const m = await orig<typeof import('~/lib/sketch/ruleCheck')>()
  return { ...m, checkRule: vi.fn(m.checkRule) }
})
const { checkRule } = await import('~/lib/sketch/ruleCheck')
const { default: PenProperties } = await import('~/components/pen/PenProperties.vue')
const { default: PenValueRow } = await import('~/components/pen/PenValueRow.vue')
const { default: PenNumberInput } = await import('~/components/pen/PenNumberInput.vue')

const view = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }
// a line into a tangent arc (the joint form), as in the pieces test
function scene() {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  const d = doc.value
  const p1 = addPoint(d, 2, 2), p2 = addPoint(d, 6, 2), p5 = addPoint(d, 8, 4), c = addPoint(d, 6, 4)
  const line = addLine(d, p1, p2)
  const arc = addPath(d, [p2, p5], [{ kind: 'arc', center: c, sweep: 1 }])
  const tan = addConstraint(d, 'perpendicular', [p1, p2, p2, c])
  return { doc, p1, p2, p5, c, line, arc, tan, pen: usePen({ doc, view: ref(view) }) }
}
let wrapper: ReturnType<typeof mount> | null = null
afterEach(() => { wrapper?.unmount(); wrapper = null; vi.useRealTimers() })
async function type(w: ReturnType<typeof mount>, sel: string, v: string, k = 'Enter') {
  const input = w.find(`${sel} input`)
  await input.setValue(v)
  await input.trigger('keydown', { key: k })
  await nextTick()
}
const P = (d: SketchDoc, id: string) => d.entities.find(e => e.id === id) as any
const shown = (w: ReturnType<typeof mount>, sel: string) => (w.find(`${sel} input`).element as HTMLInputElement).value

describe('PenProperties', () => {
  it('nothing selected: the heading only; host attrs land on the panel', () => {
    const s = scene()
    wrapper = mount(PenProperties, { props: { pen: s.pen }, attrs: { 'data-testid': 'host-props', class: 'host-class' } })
    const panel = wrapper.find('[data-pen-properties]')
    expect(panel.attributes('data-testid')).toBe('host-props')
    expect(panel.classes()).toContain('host-class')
    expect(wrapper.find('[data-props-header]').text()).toBe('Nothing selected')
    expect(wrapper.find('[data-prop]').exists()).toBe(false)
    expect(wrapper.find('[data-props-rules]').exists()).toBe(false)
  })

  it('a point: X and Y, typed with Enter as one step; Escape puts the value back', async () => {
    const s = scene()
    s.pen.pick(s.p1)
    wrapper = mount(PenProperties, { props: { pen: s.pen } })
    await nextTick()
    expect(wrapper.find('[data-props-header]').text()).toBe('1 point')
    expect(shown(wrapper, '[data-prop="x"]')).toBe('2')
    expect(s.pen.canUndo()).toBe(false)
    await type(wrapper, '[data-prop="x"]', '1.5')
    expect(P(s.doc.value, s.p1)).toMatchObject({ x: 1.5, y: 2 })
    expect(shown(wrapper, '[data-prop="x"]')).toBe('1.5')
    s.pen.undo()
    expect(s.pen.canUndo()).toBe(false)                     // exactly one step
    expect(P(s.doc.value, s.p1).x).toBe(2)
    s.pen.pick(s.p1)                                        // (undo drops the selection)
    await nextTick()
    expect(shown(wrapper, '[data-prop="x"]')).toBe('2')     // follows the drawing
    await type(wrapper, '[data-prop="y"]', '9', 'Escape')
    expect(P(s.doc.value, s.p1).y).toBe(2)
    expect(shown(wrapper, '[data-prop="y"]')).toBe('2')
  })

  it('Enter-only: leaving the field without Enter puts the shown value back; typing alone changes nothing', async () => {
    const s = scene()
    s.pen.pick(s.p1)
    wrapper = mount(PenProperties, { props: { pen: s.pen } })
    await nextTick()
    const input = wrapper.find('[data-prop="x"] input')
    await input.setValue('7')
    expect(P(s.doc.value, s.p1).x).toBe(2)
    await input.trigger('blur')
    expect(shown(wrapper, '[data-prop="x"]')).toBe('2')
    expect(s.pen.canUndo()).toBe(false)
  })

  it('Enter and Escape stop at the field (hosts never see them)', async () => {
    const s = scene()
    s.pen.pick(s.p1)
    wrapper = mount(PenProperties, { props: { pen: s.pen }, attachTo: document.body })
    await nextTick()
    const seen: string[] = []
    const onKey = (e: KeyboardEvent) => seen.push(e.key)
    document.body.addEventListener('keydown', onKey)
    const input = wrapper.find('[data-prop="x"] input')
    input.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    input.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    input.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    document.body.removeEventListener('keydown', onKey)
    expect(seen).toEqual(['a'])
  })

  it('a fixed point’s X / Y are disabled', async () => {
    const s = scene()
    P(s.doc.value, s.p1).fixed = true
    s.pen.pick(s.p1)
    wrapper = mount(PenProperties, { props: { pen: s.pen } })
    await nextTick()
    expect(wrapper.find('[data-prop="x"] input').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-prop="y"] input').attributes('disabled')).toBeDefined()
  })

  it('a line: Length and Angle; disabled only when both ends are fixed', async () => {
    const s = scene()
    s.pen.pick(s.line)
    wrapper = mount(PenProperties, { props: { pen: s.pen } })
    await nextTick()
    expect(wrapper.find('[data-props-header]').text()).toBe('1 line')
    expect(shown(wrapper, '[data-prop="length"]')).toBe('4')
    expect(shown(wrapper, '[data-prop="angle"]')).toBe('0')
    expect(wrapper.find('[data-prop="length"] input').attributes('disabled')).toBeUndefined()
    P(s.doc.value, s.p1).fixed = true
    await nextTick()
    expect(wrapper.find('[data-prop="length"] input').attributes('disabled')).toBeUndefined()
    P(s.doc.value, s.p2).fixed = true
    await nextTick()
    expect(wrapper.find('[data-prop="length"] input').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-prop="angle"] input').attributes('disabled')).toBeDefined()
  })

  it('an arc: its sizes, the lock, and its rules — hover lights both pieces, × removes', async () => {
    const s = scene()
    s.pen.pickSegment(s.arc, 0)
    wrapper = mount(PenProperties, { props: { pen: s.pen } })
    await nextTick()
    expect(wrapper.find('[data-props-header]').text()).toBe('1 arc')
    for (const k of ['radius', 'length', 'sweep']) expect(wrapper.find(`[data-prop="${k}"]`).exists()).toBe(true)
    expect(wrapper.findAll('[data-rule-row]')).toHaveLength(1)          // the arc's own rule is not listed
    const row = wrapper.find(`[data-rule-row="${s.tan}"]`)
    expect(row.text()).toContain('Tangent — Line 1 · Arc 1')
    await row.trigger('mouseenter')
    expect(s.pen.highlight.value).toHaveLength(2)
    await row.trigger('mouseleave')
    expect(s.pen.highlight.value).toHaveLength(0)
    await wrapper.find('[data-act="radius-lock"]').trigger('click')
    await nextTick()
    expect(wrapper.find('[data-act="radius-lock"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.text()).toContain('Radius 2 — Arc 1')
    await wrapper.find(`[data-rule-row="${s.tan}"] [data-act="rule-remove"]`).trigger('click')
    await nextTick()
    expect(s.doc.value.constraints.some(k => k.id === s.tan)).toBe(false)
    expect(wrapper.find(`[data-rule-row="${s.tan}"]`).exists()).toBe(false)
  })

  it('a length or radius of 0 reaches the pen, which says why (no silent floor)', async () => {
    const s = scene()
    s.pen.pick(s.line)
    wrapper = mount(PenProperties, { props: { pen: s.pen } })
    await nextTick()
    await type(wrapper, '[data-prop="length"]', '0')
    expect(s.pen.status.value).toBe('A length must be more than 0')
    expect(shown(wrapper, '[data-prop="length"]')).toBe('4')
    await type(wrapper, '[data-prop="length"]', '-2')
    expect(s.pen.status.value).toBe('A length must be more than 0')
  })
  it('an arc whose end is fixed: Sweep and Length disabled, Radius still typed', async () => {
    const s = scene()
    P(s.doc.value, s.p5).fixed = true
    s.pen.pickSegment(s.arc, 0)
    wrapper = mount(PenProperties, { props: { pen: s.pen } })
    await nextTick()
    expect(wrapper.find('[data-prop="sweep"] input').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-prop="length"] input').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-prop="radius"] input').attributes('disabled')).toBeUndefined()
  })

  it('a hovered rule that goes away (undo) clears its highlight; so does unmounting', async () => {
    const s = scene()
    s.pen.pick(s.line)
    const k = addConstraint(s.doc.value, 'horizontal', [s.line])
    s.pen.commitHistory()
    wrapper = mount(PenProperties, { props: { pen: s.pen } })
    await nextTick()
    await wrapper.find(`[data-rule-row="${k}"]`).trigger('mouseenter')
    expect(s.pen.highlight.value).toHaveLength(1)
    s.doc.value.constraints = s.doc.value.constraints.filter(x => x.id !== k)   // gone without a mouse-leave
    await nextTick(); await nextTick()
    expect(wrapper.find(`[data-rule-row="${k}"]`).exists()).toBe(false)
    expect(s.pen.highlight.value).toHaveLength(0)
    await wrapper.find(`[data-rule-row="${s.tan}"]`).trigger('mouseenter')
    expect(s.pen.highlight.value).toHaveLength(2)
    wrapper.unmount(); wrapper = null
    expect(s.pen.highlight.value).toHaveLength(0)
  })

  it('hides Repeat / Mirror copy rules (C2)', async () => {
    const s = scene()
    const q = addPoint(s.doc.value, 3, 5)
    addConstraint(s.doc.value, 'rotatedFrom', [q, s.p1, s.c], 90)
    addConstraint(s.doc.value, 'mirroredFrom', [q, s.p1, s.line])
    const h = addConstraint(s.doc.value, 'horizontal', [s.p1, q])   // positive control: a normal rule on the same points
    s.pen.pick(s.p1)
    wrapper = mount(PenProperties, { props: { pen: s.pen } })
    await nextTick()
    expect(wrapper.findAll('[data-rule-row]').map(r => r.attributes('data-rule-row'))).toEqual([h])
    expect(wrapper.find(`[data-rule-row="${h}"]`).text()).toContain('Horizontal — Point 1 · Point 5')
    expect(wrapper.text()).not.toContain('Repeat copy')
    expect(wrapper.text()).not.toContain('Mirror copy')
  })

  it('the + list offers the rules row’s rules; an exact duplicate is greyed on open; a conflicting pick adds nothing and says why', async () => {
    const s = scene()
    addConstraint(s.doc.value, 'horizontal', [s.line])
    s.pen.pick(s.line)
    wrapper = mount(PenProperties, { props: { pen: s.pen } })
    await nextTick()
    const add = wrapper.find('[data-act="rule-add"]')
    expect(add.attributes('aria-expanded')).toBe('false')
    await add.trigger('click')
    await nextTick()
    expect(add.attributes('aria-expanded')).toBe('true')
    expect(wrapper.find('[data-rule-add="rule:horizontal"]').attributes('aria-disabled')).toBe('true')
    // the cheap check can't see the conflict: shown enabled until hovered or picked
    const vertical = wrapper.find('[data-rule-add="rule:vertical"]')
    expect(vertical.attributes('aria-disabled')).toBeUndefined()
    const before = s.doc.value.constraints.length
    await vertical.trigger('click')
    await nextTick()
    expect(s.doc.value.constraints.length).toBe(before)                    // nothing added
    expect(s.doc.value.constraints.some(k => k.kind === 'vertical')).toBe(false)
    expect(s.pen.status.value).toBe('Conflicts with another rule')
    expect(wrapper.find('[data-rule-add="rule:vertical"]').attributes('aria-disabled')).toBe('true')
    expect(s.pen.canUndo()).toBe(false)
  })

  it('C1: opening the + list runs no full check; resting on an item runs it once', async () => {
    vi.useFakeTimers()
    const s = scene()
    addConstraint(s.doc.value, 'horizontal', [s.line])
    s.pen.pick(s.line)
    const spy = vi.spyOn(s.pen, 'checkRuleItem')
    wrapper = mount(PenProperties, { props: { pen: s.pen } })
    await nextTick()
    await wrapper.find('[data-act="rule-add"]').trigger('click')
    await nextTick()
    expect(spy).not.toHaveBeenCalled()
    const vertical = wrapper.find('[data-rule-add="rule:vertical"]')
    await vertical.trigger('mouseenter')
    await vertical.trigger('mouseleave')                         // a pass-over: nothing runs
    vi.advanceTimersByTime(500)
    expect(spy).not.toHaveBeenCalled()
    await vertical.trigger('mouseenter')
    vi.advanceTimersByTime(500)
    await nextTick()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-rule-add="rule:vertical"]').attributes('aria-disabled')).toBe('true')
    await vertical.trigger('mouseleave'); await vertical.trigger('mouseenter')
    vi.advanceTimersByTime(500)
    expect(spy).toHaveBeenCalledTimes(1)                         // remembered, not re-solved
  })

  it('an allowed pick adds the rule as one step and closes the list', async () => {
    const s = scene()
    s.pen.pick(s.p1); s.pen.pick(s.p5, true)
    wrapper = mount(PenProperties, { props: { pen: s.pen } })
    await nextTick()
    await wrapper.find('[data-act="rule-add"]').trigger('click')
    await nextTick()
    const vert = wrapper.find('[data-rule-add="rule:vertical"]')
    expect(vert.exists()).toBe(true)
    await vert.trigger('click')
    await nextTick()
    expect(s.doc.value.constraints.some(k => k.kind === 'vertical')).toBe(true)
    expect(wrapper.find('[data-rule-add]').exists()).toBe(false)
    // the selection stays, so the new rule shows in this very list
    expect(s.pen.selection.value).toEqual([s.p1, s.p5])
    expect(wrapper.find('[data-props-header]').text()).toBe('2 points')
    expect(wrapper.findAll('[data-rule-row]').map(r => r.text())).toContain('Vertical — Point 1 · Point 3')
    s.pen.undo()
    expect(s.doc.value.constraints.some(k => k.kind === 'vertical')).toBe(false)
    expect(s.pen.canUndo()).toBe(false)
  })

  it('a pick runs the trial solve once — not again inside the run (fresh verdict)', async () => {
    const s = scene()
    s.pen.pick(s.p1); s.pen.pick(s.p5, true)
    wrapper = mount(PenProperties, { props: { pen: s.pen } })
    await nextTick()
    await wrapper.find('[data-act="rule-add"]').trigger('click')
    await nextTick()
    vi.mocked(checkRule).mockClear()
    await wrapper.find('[data-rule-add="rule:vertical"]').trigger('click')
    await nextTick()
    expect(s.doc.value.constraints.some(k => k.kind === 'vertical')).toBe(true)
    expect(vi.mocked(checkRule)).toHaveBeenCalledTimes(1)
  })

  it('remembered verdicts are dropped on any drawing change (a commit), not only on count changes', async () => {
    vi.useFakeTimers()
    const s = scene()
    addConstraint(s.doc.value, 'horizontal', [s.line])
    s.pen.pick(s.line)
    const spy = vi.spyOn(s.pen, 'checkRuleItem')
    wrapper = mount(PenProperties, { props: { pen: s.pen } })
    await nextTick()
    await wrapper.find('[data-act="rule-add"]').trigger('click')
    await nextTick()
    const vertical = () => wrapper!.find('[data-rule-add="rule:vertical"]')
    await vertical().trigger('mouseenter'); vi.advanceTimersByTime(500); await nextTick()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(vertical().attributes('aria-disabled')).toBe('true')
    // move a point and commit: same counts, a new revision
    P(s.doc.value, s.p5).x += 0.5
    s.pen.commitHistory()
    await nextTick()
    expect(vertical().attributes('aria-disabled')).toBeUndefined()   // forgotten, back to the cheap check
    await vertical().trigger('mouseleave'); await vertical().trigger('mouseenter'); vi.advanceTimersByTime(500)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('the + list closes when the selection changes', async () => {
    const s = scene()
    s.pen.pick(s.line)
    wrapper = mount(PenProperties, { props: { pen: s.pen } })
    await nextTick()
    await wrapper.find('[data-act="rule-add"]').trigger('click')
    await nextTick()
    expect(wrapper.find('[data-rule-add]').exists()).toBe(true)
    s.pen.pick(s.p1)
    await nextTick()
    expect(wrapper.find('[data-rule-add]').exists()).toBe(false)
  })

  it('is inert while Clean up previews', async () => {
    const s = scene()
    s.pen.startCleanup()
    wrapper = mount(PenProperties, { props: { pen: s.pen } })
    await nextTick()
    expect(wrapper.find('[data-pen-properties]').attributes('inert')).toBeDefined()
  })
})

describe('speed (a 150-piece connected drawing)', () => {
  // a closed path of 150 pieces — every third an arc with its own centre —
  // with a distance on every piece and a right angle at every straight joint
  function big() {
    const doc = ref<SketchDoc>({ entities: [], constraints: [] })
    const d = doc.value
    const N = 150, R = 40
    const pts = Array.from({ length: N }, (_, i) => addPoint(d, R * Math.cos(2 * Math.PI * i / N), R * Math.sin(2 * Math.PI * i / N)))
    const segs = pts.map((_, i) => (i % 3 === 2
      ? { kind: 'arc' as const, center: addPoint(d, 0, 0), sweep: 1 as const }
      : { kind: 'line' as const }))
    const path = addPath(d, pts, segs, true)
    for (let i = 0; i < N; i++) addConstraint(d, 'distance', [pts[i]!, pts[(i + 1) % N]!], 1.6)
    for (let i = 0; i < N; i += 3) addConstraint(d, 'perpendicular', [pts[i]!, pts[i + 1]!, pts[i + 1]!, pts[i + 2]!])
    return { doc, path, pts, pen: usePen({ doc, view: ref(view) }) }
  }
  it('selecting the whole path computes its rules and names in under 50 ms', async () => {
    const s = big()
    expect(s.doc.value.constraints.length).toBeGreaterThanOrEqual(250)
    wrapper = mount(PenProperties, { props: { pen: s.pen } })
    await nextTick()
    const vm = wrapper.vm as unknown as { rules: unknown[]; names: Map<string, string> }
    s.pen.pick(s.path)
    const t0 = performance.now()
    const n = vm.rules.length
    const names = vm.names.size
    const ms = performance.now() - t0
    expect(n).toBeGreaterThan(150)
    expect(names).toBeGreaterThan(150)
    expect(ms).toBeLessThan(50)
  })
})

describe('PenNumberInput', () => {
  it('shows two decimals at most, ignores an empty or below-min draft, exposes commit()', async () => {
    wrapper = mount(PenNumberInput, { props: { value: 3.14159, min: 1 } })
    const input = wrapper.find('input')
    expect((input.element as HTMLInputElement).value).toBe('3.14')
    await input.setValue('')
    await input.trigger('keydown', { key: 'Enter' })
    await input.setValue('0.5')
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('submit')).toBeUndefined()
    await input.setValue('2.5')
    ;(wrapper.vm as unknown as { commit: () => void }).commit()
    expect(wrapper.emitted('submit')).toEqual([[2.5]])
  })
  it('a refused submit (the value did not change) shows the value again', async () => {
    wrapper = mount(PenNumberInput, { props: { value: 4 } })
    const input = wrapper.find('input')
    await input.setValue('9')
    await input.trigger('keydown', { key: 'Enter' })
    await nextTick()
    expect((input.element as HTMLInputElement).value).toBe('4')
  })
})

describe('PenValueRow through the shared field', () => {
  it('still submits on Enter (Distance… between two points)', async () => {
    const s = scene()
    wrapper = mount(PenValueRow, { props: { pen: s.pen } })
    s.pen.pick(s.p1); s.pen.pick(s.c, true)
    const done = s.pen.applyWithValue({ kind: 'distance', label: 'Distance…', value: true })
    await nextTick()
    const input = wrapper.find('[data-testid="pen-value-input"]')
    await input.setValue('4')
    await input.trigger('keydown', { key: 'Enter' })
    await done
    expect(s.doc.value.constraints.at(-1)).toMatchObject({ kind: 'distance', value: 4 })
  })
  it('the ✓ button commits what was typed even after the field lost focus', async () => {
    const s = scene()
    wrapper = mount(PenValueRow, { props: { pen: s.pen } })
    s.pen.pick(s.p1); s.pen.pick(s.c, true)
    const done = s.pen.applyWithValue({ kind: 'distance', label: 'Distance…', value: true })
    await nextTick()
    const input = wrapper.find('[data-testid="pen-value-input"]')
    await input.setValue('3')
    await input.trigger('blur')
    await wrapper.find('[data-act="value-submit"]').trigger('click')
    await done
    expect(s.doc.value.constraints.at(-1)).toMatchObject({ kind: 'distance', value: 3 })
  })
  it('Escape cancels the request', async () => {
    const s = scene()
    wrapper = mount(PenValueRow, { props: { pen: s.pen } })
    s.pen.pick(s.p1); s.pen.pick(s.c, true)
    const done = s.pen.applyWithValue({ kind: 'distance', label: 'Distance…', value: true })
    await nextTick()
    await wrapper.find('[data-testid="pen-value-input"]').trigger('keydown', { key: 'Escape' })
    await done
    await nextTick()
    expect(s.pen.valueRequest.value).toBeNull()
    expect(s.doc.value.constraints.some(k => k.kind === 'distance')).toBe(false)
  })
})
