import { describe, it, expect } from 'vitest'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import { animatableProperties, groupAnimatableProperties, PROPERTY_GROUP_ORDER, FRAME_DARKNESS_PROPERTY } from '~/lib/motionx/adapter/frame'

// The "Add property" picker (MotionPropertyPicker.vue) renders exactly these groups, in order.
describe('Add property groups (Frame light layers stage 4)', () => {
  const lamp = { id: 'lp', kind: 'light', x: 0.5, y: 0.5, rotation: 0, opacity: 1,
    light: { type: 'lamp', height: 0.55, color: '#ffb36b', brightness: 1.6, reach: 1, aimX: 0.5, aimY: 0.5, cone: 0.35, edge: 0.5 } } as unknown as LocalLayer
  const text = { id: 'tx', kind: 'text', text: 'Hi', x: 0.5, y: 0.5, rotation: 0, opacity: 1 } as unknown as LocalLayer

  it('Light is a picker group, after the others', () => {
    expect(PROPERTY_GROUP_ORDER).toEqual(['Transform', 'Fill', 'Effects', 'Copies', 'Light'])
  })
  it('a light shows Transform then Light', () => {
    const g = groupAnimatableProperties(animatableProperties(lamp))
    expect(g.map((x) => x.group)).toEqual(['Transform', 'Light'])
    expect(g[1]!.items.map((p) => p.label)).toEqual(['Height', 'Colour', 'Brightness', 'Reach'])
  })
  it('a casting layer offers Lift under Light while the Frame has a light, and no Light group without one', () => {
    const g = groupAnimatableProperties(animatableProperties(text, { hasLight: true }))
    expect(g.at(-1)).toMatchObject({ group: 'Light', items: [{ label: 'Lift', min: 0.005, max: 0.15 }] })
    expect(groupAnimatableProperties(animatableProperties(text)).map((x) => x.group)).not.toContain('Light')
  })
  it('the All lights row offers just Darkness', () => {
    expect(FRAME_DARKNESS_PROPERTY).toEqual({ path: 'frame.darkness', type: 'number', label: 'Darkness', group: 'Light', min: 0, max: 1 })
    expect(groupAnimatableProperties([FRAME_DARKNESS_PROPERTY])).toEqual([{ group: 'Light', items: [FRAME_DARKNESS_PROPERTY] }])
  })
})
