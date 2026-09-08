// @vitest-environment happy-dom
/**
 * THE INLINE TOOLBAR'S STACK GATE.
 *
 * The Frame's floating toolbar (`CompositorInlineToolbar`) is the FOURTH surface that could
 * silently collapse a stroke stack, and the one the modal's Task 9 fix did not reach. Its
 * Stroke colour + Stroke width fields write the LEGACY `stroke` / `strokeWidth` pair straight
 * onto the selected layer (`ArtifactFrameNode.onToolbarSet` -> `editor.setLocal`), and
 * `strokeStackOf` treats a live legacy field as AUTHORITATIVE and ignores the stored array —
 * so on a three-stroke rect, one nudge of those fields deletes two outlines.
 *
 * Driven END TO END rather than by reading the DOM alone: every patch the toolbar emits is
 * applied to the layer, and the assertion is made by `strokeStackOf` — the same reader the
 * painter, the pad helpers, the SVG writer and the agent go through. A gate that hid the row
 * but left some other field writing the legacy pair would still fail here.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import Toolbar from '~/components/vue-canvas/CompositorInlineToolbar.vue'
import { strokeStackOf, type StrokeInstance } from '~/lib/compositor/strokeStack'

const W = 1200

const stroke = (id: string, width: number, distance: number): StrokeInstance =>
  ({ id, paint: '#ff0000', width, distance, align: 'center', join: 'sharp', style: 'band' })

/** A rect that STORES three outlines — the shape the toolbar must not be able to flatten. */
const stackedRect = () => ({
  id: 'r1', kind: 'rect', x: 0.5, y: 0.5, w: 0.3, h: 0.2, fill: '#3b82f6',
  strokes: [stroke('a', 0.01, 0), stroke('b', 0.006, 0.02), stroke('c', 0.004, 0.05)],
} as Record<string, any>)

/** Every control the toolbar renders, driven once — the user mashing the whole bar. Returns
 *  the layer with every emitted patch applied, in emit order. */
function driveEveryControl(layer: Record<string, any>) {
  const w = mount(Toolbar, { props: { layer, pxBase: W } })
  for (const input of w.findAll('input')) {
    const el = input.element as HTMLInputElement
    el.value = el.type === 'color' ? '#00ff00' : '7'
    input.trigger('input')
  }
  for (const sel of w.findAll('select')) sel.trigger('change')
  const patched = { ...layer }
  for (const [patch] of (w.emitted('set') ?? []) as [Record<string, any>][]) Object.assign(patched, patch)
  return { wrapper: w, patched }
}

describe('CompositorInlineToolbar — the legacy stroke fields are gated on the stack', () => {
  it('a rect storing three strokes still has three after the whole toolbar is driven', () => {
    const layer = stackedRect()
    expect(strokeStackOf(layer as any)).toHaveLength(3)
    const { wrapper, patched } = driveEveryControl(layer)
    // Nothing the toolbar can emit may make a legacy field live…
    expect(patched.stroke).toBeUndefined()
    expect(patched.strokeWidth).toBeUndefined()
    // …which is what keeps the reader on the stored array.
    expect(strokeStackOf(patched as any)).toHaveLength(3)
    expect(strokeStackOf(patched as any).map(s => s.id)).toEqual(['a', 'b', 'c'])
    expect(wrapper.find('[data-testid="toolbar-stroke-width"]').exists()).toBe(false)
  })

  it('a path storing a stack is gated too — the second arm with the same two fields', () => {
    const layer = {
      id: 'p1', kind: 'path', x: 0.5, y: 0.5, d: 'M0 0 L10 0 L10 10 Z', bbox: { w: 10, h: 10 },
      scale: 1, fill: '#3b82f6', strokes: [stroke('a', 0.5, 0), stroke('b', 0.25, 1)],
    } as Record<string, any>
    const { wrapper, patched } = driveEveryControl(layer)
    expect(patched.stroke).toBeUndefined()
    expect(patched.strokeWidth).toBeUndefined()
    expect(strokeStackOf(patched as any)).toHaveLength(2)
    expect(wrapper.find('[data-testid="toolbar-stroke-width"]').exists()).toBe(false)
  })

  it('a LINE keeps its Thickness field — a line is not stackable and that field is its stroke', () => {
    // Given a `strokes` array anyway (an agent could write one; the tree offers a line no
    // plus-menu), because a gate that hid Thickness whenever an array is present would take
    // away the ONLY way to edit a line's stroke. `strokeSupportsStack` excludes 'line'.
    const line = {
      id: 'l1', kind: 'line', x: 0.5, y: 0.5, w: 0.4, stroke: '#ffffff', strokeWidth: 0.004,
      strokes: [stroke('a', 0.01, 0)],
    } as Record<string, any>
    const w = mount(Toolbar, { props: { layer: line, pxBase: W } })
    const thickness = w.findAll('input').filter(i => (i.element as HTMLInputElement).title === 'Thickness')
    expect(thickness).toHaveLength(1)
    thickness[0]!.element.value = '12'
    thickness[0]!.trigger('input')
    expect((w.emitted('set') ?? []).map(([p]) => p)).toContainEqual({ strokeWidth: 12 / W })
  })

  it('a LEGACY rect keeps both fields — the gate must not hide a live control', () => {
    const legacy = {
      id: 'r2', kind: 'rect', x: 0.5, y: 0.5, w: 0.3, h: 0.2, fill: 'none',
      stroke: '#ffffff', strokeWidth: 0.005,
    } as Record<string, any>
    const w = mount(Toolbar, { props: { layer: legacy, pxBase: W } })
    expect(w.find('[data-testid="toolbar-stroke-width"]').exists()).toBe(true)
    expect(w.findAll('input').filter(i => (i.element as HTMLInputElement).title === 'Stroke')).toHaveLength(1)
  })
})
