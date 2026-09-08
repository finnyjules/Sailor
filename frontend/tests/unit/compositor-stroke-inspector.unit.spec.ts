// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import StrokeStyleRow from '~/components/vue-canvas/compositor/StrokeStyleRow.vue'
import ShapeStrokeRow from '~/components/vue-canvas/compositor/ShapeStrokeRow.vue'
import CompositorStrokeRow from '~/components/vue-canvas/compositor/CompositorStrokeRow.vue'
import {
  strokeInspectorRows, strokeStylePatch, seedShapeSpec, strokeDistanceOf,
  STROKE_JOIN_OPTIONS, STROKE_STYLE_OPTIONS, showsTextDistantNote,
} from '~/lib/compositor/strokeInspector'
import { createStroke, type StrokeInstance } from '~/lib/compositor/strokeStack'

/**
 * The Frame's stroke inspector, row by row.
 *
 * Every gate asserted here was read out of the PAINTER (`useCompositorLayers.ts`), not out
 * of the plan: a row shown for a dial that painter never reads is a dead control, and a row
 * hidden for a dial it does read is a feature the user cannot reach. Both are defects, so
 * each rule below names the painter statement it protects.
 *
 * `v-scrubnum` is a global Nuxt directive; the mounts stub it, since none of these
 * assertions are about scrubbing.
 */
const scrub = { directives: { scrubnum: {} } }

const stroke = (over: Partial<StrokeInstance> = {}): StrokeInstance => ({ ...createStroke(), ...over })

const SHAPEABLE = ['rect', 'ellipse', 'polygon', 'star', 'path']

describe('strokeInspectorRows — the row set per kind', () => {
  it('gives an on-edge band stroke on a shape every band row plus Style', () => {
    for (const kind of SHAPEABLE) {
      expect(strokeInspectorRows(kind, stroke())).toEqual(
        ['paint', 'width', 'distance', 'align', 'dash', 'style'],
      )
    }
  })

  // `strokeSupportsShapes` excludes text: the Frame's text layer stores a CSS family name,
  // never glyph outlines, so `paintStrokeStack` — which is what a shapes stroke needs — is
  // never reached for text at all (`paintTextStrokeBands` handles it instead).
  it('offers no Style row on text, so no shapes row can follow', () => {
    const rows = strokeInspectorRows('text', stroke())
    expect(rows).not.toContain('style')
    expect(rows).not.toContain('shapes')
  })

  // `strokeAligned` — the whole distance-0 path — never touches `lineJoin`. `join` reaches
  // the canvas only in `paintStrokeBand`'s non-zero-distance branch.
  it('hides Corners at distance 0 and shows it at a distance', () => {
    expect(strokeInspectorRows('rect', stroke({ distance: 0 }))).not.toContain('join')
    expect(strokeInspectorRows('rect', stroke({ distance: 0.01 }))).toContain('join')
    expect(strokeInspectorRows('rect', stroke({ distance: -0.01 }))).toContain('join')
    // Text bands at a distance through the same helper, so Corners is live there too.
    expect(strokeInspectorRows('text', stroke({ distance: 0.01 }))).toContain('join')
  })

  // A dashed offset band is not expressible: the band is the difference of two dilations
  // and there is no offset curve to run a dash pattern along. `paintStrokeBand`'s non-zero
  // branch never reads `o.dash`.
  it('hides Dash for any stroke with a distance', () => {
    expect(strokeInspectorRows('rect', stroke({ distance: 0 }))).toContain('dash')
    expect(strokeInspectorRows('rect', stroke({ distance: 0.02 }))).not.toContain('dash')
    expect(strokeInspectorRows('rect', stroke({ distance: -0.02 }))).not.toContain('dash')
    expect(strokeInspectorRows('text', stroke({ distance: 0.02 }))).not.toContain('dash')
  })

  // `strokeText` takes no path and is always centred, so a text stroke ON THE EDGE ignores
  // `strokeAlign` — but `paintTextStrokeBands` hands `align: st.align` straight to
  // `paintStrokeBand`, so a text stroke AT A DISTANCE honours it.
  it('offers Alignment on text only at a distance', () => {
    expect(strokeInspectorRows('text', stroke({ distance: 0 }))).not.toContain('align')
    expect(strokeInspectorRows('text', stroke({ distance: 0.02 }))).toContain('align')
    // Every other kind has alignment at both.
    expect(strokeInspectorRows('rect', stroke({ distance: 0 }))).toContain('align')
    expect(strokeInspectorRows('rect', stroke({ distance: 0.02 }))).toContain('align')
  })

  // `paintStrokeStack` dispatches on style and `continue`s inside the shapes arm BEFORE its
  // `st.width > 0` gate; `paintShapeStroke` reads only shapeId/size/spacing/follow/distance.
  // So width, alignment, corners and dash are all dead while Shapes is picked.
  it('drops every band-only row for a shapes stroke', () => {
    const rows = strokeInspectorRows('rect', stroke({ style: 'shapes', shapes: seedShapeSpec(0.005), distance: 0.01 }))
    expect(rows).toEqual(['paint', 'distance', 'style', 'shapes'])
    for (const dead of ['width', 'align', 'dash', 'join']) expect(rows).not.toContain(dead)
  })

  it('reads a non-finite distance as the on-the-edge stroke the painter draws', () => {
    expect(strokeDistanceOf({ distance: Number.NaN })).toBe(0)
    expect(strokeInspectorRows('rect', stroke({ distance: Number.NaN }))).toContain('dash')
  })

  it('says out loud that a distant text stroke sits beneath the on-edge ones', () => {
    expect(showsTextDistantNote('text', stroke({ distance: 0.02 }))).toBe(true)
    expect(showsTextDistantNote('text', stroke({ distance: 0 }))).toBe(false)
    expect(showsTextDistantNote('rect', stroke({ distance: 0.02 }))).toBe(false)
  })
})

describe('strokeStylePatch — style and its payload in ONE patch', () => {
  // The half-applied edit (style written, shapes not yet) is the exact state that used to
  // paint a full band at whatever stale width the row still carried.
  it('carries a usable shapes spec in the same object that sets the style', () => {
    const patch = strokeStylePatch(stroke({ width: 0.01 }), 'shapes')
    expect(patch.style).toBe('shapes')
    expect(patch.shapes).toEqual({ shapeId: 'sparkle', size: 0.02, spacing: 0.04, follow: true })
  })

  it('keeps an existing spec rather than reseeding it', () => {
    const spec = { shapeId: 'circle', size: 0.03, spacing: 0.05, follow: false }
    expect(strokeStylePatch(stroke({ style: 'shapes', shapes: spec }), 'shapes').shapes).toBe(spec)
  })

  it('seeds a visible mark even from a zero-width stroke', () => {
    const spec = seedShapeSpec(0)
    expect(spec.size).toBeGreaterThan(0)
    expect(spec.spacing).toBeGreaterThan(0)
  })

  it('going back to Band writes no shapes key at all', () => {
    expect(strokeStylePatch(stroke({ style: 'shapes', shapes: seedShapeSpec(0.005) }), 'band')).toEqual({ style: 'band' })
  })
})

describe('StrokeStyleRow — what actually reaches the DOM', () => {
  const mountRow = (props: Record<string, unknown>) =>
    mount(StrokeStyleRow, { props: { outWidth: 1200, ...props }, global: scrub })

  it('shows only the rows it is told to', () => {
    const bare = mountRow({})
    expect(bare.find('[data-stroke-join]').exists()).toBe(false)
    expect(bare.find('[data-stroke-align]').exists()).toBe(false)
    expect(bare.find('[data-stroke-style]').exists()).toBe(false)
    // Dash defaults ON, so the six single-stroke call sites that predate the stack keep it.
    expect(bare.find('[data-stroke-dashed]').exists()).toBe(true)

    const full = mountRow({ showJoin: true, showAlign: true, showStyle: true })
    for (const sel of ['[data-stroke-join]', '[data-stroke-align]', '[data-stroke-dashed]', '[data-stroke-style]']) {
      expect(full.find(sel).exists()).toBe(true)
    }
    expect(mountRow({ showDash: false }).find('[data-stroke-dashed]').exists()).toBe(false)
  })

  // House rule: no internal identifier in UI copy. `sharp`, `band` and `shapes` are stored
  // values, never words a person should read.
  it('labels every option in sentence case, never with the stored slug', () => {
    const w = mountRow({ showJoin: true, showAlign: true, showStyle: true })
    const joins = w.findAll('[data-stroke-join] option').map(o => o.text())
    const styles = w.findAll('[data-stroke-style] option').map(o => o.text())
    expect(joins).toEqual(['Sharp', 'Rounded'])
    expect(styles).toEqual(['Band', 'Shapes'])
    // Values are still the stored slugs — that is the point of a label.
    expect(w.findAll('[data-stroke-join] option').map(o => o.attributes('value'))).toEqual(['sharp', 'round'])
    expect(w.findAll('[data-stroke-style] option').map(o => o.attributes('value'))).toEqual(['band', 'shapes'])

    const visible = w.text()
    for (const slug of ['sharp', 'round', 'band', 'shapes', 'center', 'inside', 'outside']) {
      expect(visible.split(/\s+/)).not.toContain(slug)
    }
    // Every option this component draws is covered by an explicit label map or literal.
    expect(STROKE_JOIN_OPTIONS.map(o => o.label)).toEqual(['Sharp', 'Rounded'])
    expect(STROKE_STYLE_OPTIONS.map(o => o.label)).toEqual(['Band', 'Shapes'])
  })

  it('emits the picked join and style, not a merged patch', async () => {
    const w = mountRow({ showJoin: true, showStyle: true })
    await w.get('[data-stroke-join]').setValue('round')
    await w.get('[data-stroke-style]').setValue('shapes')
    expect(w.emitted('update:join')!.at(-1)).toEqual(['round'])
    expect(w.emitted('update:style')!.at(-1)).toEqual(['shapes'])
  })
})

describe('ShapeStrokeRow', () => {
  const spec = { shapeId: 'sparkle', size: 0.02, spacing: 0.04, follow: true }
  const mountRow = (over: Record<string, unknown> = {}) =>
    mount(ShapeStrokeRow, { props: { spec: { ...spec, ...over }, outWidth: 1200 }, global: scrub })

  it('shows a human shape name, size and spacing in px, and the follow toggle', () => {
    const w = mountRow()
    expect(w.get('[data-stroke-shape]').text()).not.toBe('sparkle')
    expect((w.get('[data-stroke-shape-size]').element as HTMLInputElement).value).toBe('24')
    expect((w.get('[data-stroke-shape-spacing]').element as HTMLInputElement).value).toBe('48')
    expect((w.get('[data-stroke-shape-follow]').element as HTMLInputElement).checked).toBe(true)
    expect(w.text()).toContain('Turn with the edge')
  })

  it('converts a px edit back into stored units', async () => {
    const w = mountRow()
    await w.get('[data-stroke-shape-size]').setValue('60')
    expect(w.emitted('update')!.at(-1)).toEqual([{ size: 0.05 }])
  })

  // A path stores size/spacing in local units at scale 1, so the row divides by the scale
  // too — the same conversion StrokeStyleRow makes for a dash.
  it('folds a path layer scale into the px conversion', () => {
    const w = mount(ShapeStrokeRow, { props: { spec, outWidth: 1200, scale: 2 }, global: scrub })
    expect((w.get('[data-stroke-shape-size]').element as HTMLInputElement).value).toBe('48')
  })

  it('does not show a raw id when the stored shape is unknown', () => {
    const w = mountRow({ shapeId: '' })
    expect(w.get('[data-stroke-shape]').text()).toBe('Choose a shape')
  })
})

describe('CompositorStrokeRow — keyboard parity with the effect row', () => {
  const mountRow = (over: Partial<StrokeInstance> = {}) =>
    mount(CompositorStrokeRow, {
      props: { stroke: stroke(over), layerId: 'l1', depth: 2, selected: false, outWidth: 1200 },
      global: scrub,
    })

  // "Effect rows a keyboard could not reach" was a finding in that feature's own review.
  it('is reachable and operable from the keyboard', async () => {
    const w = mountRow()
    const row = w.get('[data-testid="stroke-row"]')
    expect(row.attributes('role')).toBe('button')
    expect(row.attributes('tabindex')).toBe('0')
    expect(row.attributes('aria-label')).toBeTruthy()
    await row.trigger('keydown.enter')
    await row.trigger('keydown.space')
    expect(w.emitted('select')!.length).toBe(2)
    expect(w.emitted('select')![0]).toEqual(['l1', w.props('stroke').id])
  })

  it('reveals its hover buttons on focus-within too, not only on hover', () => {
    const w = mountRow()
    for (const label of ['Duplicate outline', 'Remove outline']) {
      const cls = w.get(`[aria-label="${label}"]`).classes().join(' ')
      expect(cls).toContain('group-hover/st:opacity-100')
      expect(cls).toContain('group-focus-within/st:opacity-100')
    }
  })

  it('labels the row in human words, never with a stored value', () => {
    // 6px on a 1200 frame, pushed 12px out.
    const w = mountRow({ width: 0.005, distance: 0.01 })
    expect(w.get('[data-testid="stroke-row"] span.flex-1').text()).toBe('6 px, 12 px out')
    const shapes = mountRow({ style: 'shapes', shapes: seedShapeSpec(0.005) })
    expect(shapes.get('[data-testid="stroke-row"] span.flex-1').text()).toBe('Sparkle')
  })

  it('emits remove, duplicate and visibility against its own id', async () => {
    const w = mountRow()
    const id = w.props('stroke').id
    await w.get('[aria-label="Remove outline"]').trigger('click')
    await w.get('[aria-label="Duplicate outline"]').trigger('click')
    await w.get('[aria-label="Hide outline"]').trigger('click')
    expect(w.emitted('remove')!.at(-1)).toEqual(['l1', id])
    expect(w.emitted('duplicate')!.at(-1)).toEqual(['l1', id])
    expect(w.emitted('toggleVisible')!.at(-1)).toEqual(['l1', id])
  })
})
