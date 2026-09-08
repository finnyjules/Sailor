// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import StrokeStyleRow from '~/components/vue-canvas/compositor/StrokeStyleRow.vue'
import ShapeStrokeRow from '~/components/vue-canvas/compositor/ShapeStrokeRow.vue'
import CompositorStrokeRow from '~/components/vue-canvas/compositor/CompositorStrokeRow.vue'
import {
  strokeInspectorRows, strokeStylePatch, seedShapeSpec, strokeDistanceOf,
  STROKE_JOIN_OPTIONS, STROKE_STYLE_OPTIONS, STROKE_WOBBLE_OPTIONS, showsTextDistantNote,
  strokeWobbleOf, strokeWobbleIsLive, strokeWobblePatch, seedWobbleFields,
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
  it('gives an on-edge band stroke on a shape every band row plus Style and Wobble', () => {
    for (const kind of SHAPEABLE) {
      expect(strokeInspectorRows(kind, stroke())).toEqual(
        ['paint', 'width', 'distance', 'wobble', 'align', 'dash', 'style'],
      )
    }
  })

  // `strokeSupportsShapes` excludes text: the Frame's text layer stores a CSS family name,
  // never glyph outlines, so `paintStrokeStack` — which is what a shapes stroke needs — is
  // never reached for text at all (`paintTextStrokeBands` handles it instead). Wobble needs
  // the same real outline to flatten, so it is excluded for exactly the same reason.
  it('offers no Style row on text, so no shapes row can follow — and no Wobble either', () => {
    const rows = strokeInspectorRows('text', stroke())
    expect(rows).not.toContain('style')
    expect(rows).not.toContain('shapes')
    expect(rows).not.toContain('wobble')
    expect(rows).not.toContain('wobbleAmount')
    expect(rows).not.toContain('wobbleLength')
    expect(rows).not.toContain('wobblePhase')
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

  // WIDENED gate: a wobbled band flattens the outline and strokes a real Path2D, which DOES
  // honour `lineJoin` — unlike `strokeAligned`'s distance-0 dilation-diff band. Its own case,
  // as the brief asks: distance 0 alone still hides Corners, but distance 0 WITH a wobble
  // must show it, or a zigzag's points are governed by a hidden control.
  it('also shows Corners at distance 0 once a wobble is on', () => {
    expect(strokeInspectorRows('rect', stroke({ distance: 0 }))).not.toContain('join')
    expect(strokeInspectorRows('rect', stroke({ distance: 0, wobble: 'wave', wobbleAmount: 0.01, wobbleLength: 0.05 })))
      .toContain('join')
    expect(strokeInspectorRows('rect', stroke({ distance: 0, wobble: 'zigzag', wobbleAmount: 0.01, wobbleLength: 0.05 })))
      .toContain('join')
    // A shapes-style stroke has no join at all — `paintShapeStroke` never sets `lineJoin` —
    // so wobble does not conjure Corners for it even though `wobbling` is true.
    expect(strokeInspectorRows('rect', stroke({
      style: 'shapes', shapes: seedShapeSpec(0.005), distance: 0, wobble: 'wave', wobbleAmount: 0.01, wobbleLength: 0.05,
    }))).not.toContain('join')
    // Text has no outline to wobble at all — the row never appears, so it cannot widen Corners.
    expect(strokeInspectorRows('text', stroke({ distance: 0, wobble: 'wave' as any, wobbleAmount: 0.01, wobbleLength: 0.05 })))
      .not.toContain('join')
  })

  // FINDING 5 (final review): the widened gates used to ask `strokeWobbleOf(stroke) !== 'off'`
  // — the SHAPE NAME alone — while the painter asks `wobbleSpecOf`, which also needs a
  // positive Amount and a positive Every. With Every scrubbed to 0 (its input is `min="0"`)
  // Corners came back on a distance-0 band that `strokeAligned` still draws, i.e. a dead
  // control returned. The two must agree.
  it('does not widen Corners for a wobble the painter reads as off (Amount 0 or Every 0)', () => {
    const zeroEvery = stroke({ distance: 0, wobble: 'wave', wobbleAmount: 0.01, wobbleLength: 0 })
    const zeroAmount = stroke({ distance: 0, wobble: 'zigzag', wobbleAmount: 0, wobbleLength: 0.05 })
    expect(strokeInspectorRows('rect', zeroEvery)).not.toContain('join')
    expect(strokeInspectorRows('rect', zeroAmount)).not.toContain('join')
    // But the three dials themselves STAY, or the zeroed one could never be raised again.
    for (const st of [zeroEvery, zeroAmount]) {
      expect(strokeInspectorRows('rect', st)).toEqual(
        expect.arrayContaining(['wobble', 'wobbleAmount', 'wobbleLength', 'wobblePhase']),
      )
    }
    expect(strokeWobbleIsLive(zeroEvery)).toBe(false)
    expect(strokeWobbleIsLive(zeroAmount)).toBe(false)
    expect(strokeWobbleIsLive(stroke({ wobble: 'wave', wobbleAmount: 0.01, wobbleLength: 0.05 }))).toBe(true)
  })

  // FINDING 6a (final review): the Dash row's distance-0 limit belongs to the DILATION band,
  // which has no offset curve to run a pattern along. `paintWobbledBand` builds that curve as
  // a real Path2D and calls `ctx.setLineDash` at any distance — a live capability with the
  // control hidden.
  it('shows Dash on a wobbled band at a distance, where the wobbled route really does dash', () => {
    expect(strokeInspectorRows('rect', stroke({
      distance: 0.02, wobble: 'wave', wobbleAmount: 0.01, wobbleLength: 0.05,
    }))).toContain('dash')
    // Off, or a wobble the painter reads as off, is back to the dilation route: no dash.
    expect(strokeInspectorRows('rect', stroke({ distance: 0.02 }))).not.toContain('dash')
    expect(strokeInspectorRows('rect', stroke({
      distance: 0.02, wobble: 'wave', wobbleAmount: 0.01, wobbleLength: 0,
    }))).not.toContain('dash')
    // Text has no outline to wobble, so nothing widens there.
    expect(strokeInspectorRows('text', stroke({
      distance: 0.02, wobble: 'wave' as never, wobbleAmount: 0.01, wobbleLength: 0.05,
    }))).not.toContain('dash')
  })

  it('hides Wobble-dependent rows until a shape is picked, on any shapeable kind', () => {
    for (const kind of SHAPEABLE) {
      expect(strokeInspectorRows(kind, stroke())).toContain('wobble')
      expect(strokeInspectorRows(kind, stroke())).not.toContain('wobbleAmount')
      expect(strokeInspectorRows(kind, stroke())).not.toContain('wobbleLength')
      expect(strokeInspectorRows(kind, stroke())).not.toContain('wobblePhase')
      const on = stroke({ wobble: 'wave', wobbleAmount: 0.01, wobbleLength: 0.05 })
      expect(strokeInspectorRows(kind, on)).toEqual(
        expect.arrayContaining(['wobble', 'wobbleAmount', 'wobbleLength', 'wobblePhase']),
      )
    }
    // An unrecognised `wobble` value reads as off, matching `strokeStackOf`'s own rule.
    expect(strokeInspectorRows('rect', stroke({ wobble: 'spiral' as any }))).not.toContain('wobbleAmount')
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
  it('drops every band-only row for a shapes stroke, but keeps Wobble — it is a line property', () => {
    const rows = strokeInspectorRows('rect', stroke({ style: 'shapes', shapes: seedShapeSpec(0.005), distance: 0.01 }))
    expect(rows).toEqual(['paint', 'distance', 'wobble', 'style', 'shapes'])
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

describe('strokeWobblePatch — Wobble and its seed in ONE patch', () => {
  it('reads an absent or unrecognised wobble as off', () => {
    expect(strokeWobbleOf(stroke())).toBe('off')
    expect(strokeWobbleOf(stroke({ wobble: 'spiral' as any }))).toBe('off')
    expect(strokeWobbleOf(stroke({ wobble: 'wave' }))).toBe('wave')
  })

  // Turning it ON from Off must seed Amount and Every in the SAME patch — a half-applied
  // edit (wobble written, amount/length not yet) is the exact bug this family already shipped
  // once for Style, and the first render must show something rather than a flat line.
  it('seeds Amount and Every the moment Wobble leaves Off', () => {
    const patch = strokeWobblePatch(stroke(), 'wave')
    expect(patch.wobble).toBe('wave')
    expect(patch).toEqual({ wobble: 'wave', ...seedWobbleFields() })
    expect(patch.wobbleAmount).toBeGreaterThan(0)
    expect(patch.wobbleLength).toBeGreaterThan(0)
  })

  it('keeps the existing amount/length when switching Wave ↔ Zigzag', () => {
    const on = stroke({ wobble: 'wave', wobbleAmount: 0.03, wobbleLength: 0.08 })
    const patch = strokeWobblePatch(on, 'zigzag')
    expect(patch).toEqual({ wobble: 'zigzag' })
  })

  it('keeps the existing amount/length when switching back to an already-tuned Off stroke', () => {
    const on = stroke({ wobble: 'wave', wobbleAmount: 0.03, wobbleLength: 0.08 })
    // Off writes only `wobble: undefined` — the tuned amount/length are left in place, so
    // flipping Wobble back on restores exactly what the user had.
    expect(strokeWobblePatch(on, 'off')).toEqual({ wobble: undefined })
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
    expect(bare.find('[data-stroke-wobble]').exists()).toBe(false)
    expect(bare.find('[data-stroke-wobble-amount]').exists()).toBe(false)
    expect(bare.find('[data-stroke-wobble-length]').exists()).toBe(false)
    expect(bare.find('[data-stroke-wobble-phase]').exists()).toBe(false)
    // Dash defaults ON, so the six single-stroke call sites that predate the stack keep it.
    expect(bare.find('[data-stroke-dashed]').exists()).toBe(true)

    const full = mountRow({
      showJoin: true, showAlign: true, showStyle: true,
      showWobble: true, showWobbleAmount: true, showWobbleLength: true, showWobblePhase: true,
    })
    for (const sel of [
      '[data-stroke-join]', '[data-stroke-align]', '[data-stroke-dashed]', '[data-stroke-style]',
      '[data-stroke-wobble]', '[data-stroke-wobble-amount]', '[data-stroke-wobble-length]', '[data-stroke-wobble-phase]',
    ]) {
      expect(full.find(sel).exists()).toBe(true)
    }
    expect(mountRow({ showDash: false }).find('[data-stroke-dashed]').exists()).toBe(false)
  })

  // The four `show*` props for Wobble/Amount/Every/Phase are independent — Amount/Every/
  // Phase do NOT derive their visibility from `wobble` locally; each is wired to its own
  // prop from the host's `hasStrokeRow`, so a wiring mistake on any one of them is visible
  // here as well as in the live-DOM suite.
  it('shows Amount/Every/Phase only when told to, independent of the stored wobble value', () => {
    const w = mountRow({ wobble: 'wave', showWobble: true })
    expect(w.find('[data-stroke-wobble-amount]').exists()).toBe(false)
    expect(w.find('[data-stroke-wobble-length]').exists()).toBe(false)
    expect(w.find('[data-stroke-wobble-phase]').exists()).toBe(false)
  })

  // House rule: no internal identifier in UI copy. `sharp`, `band`, `shapes`, `wave` and
  // `zigzag` are stored values, never words a person should read.
  it('labels every option in sentence case, never with the stored slug', () => {
    const w = mountRow({ showJoin: true, showAlign: true, showStyle: true, showWobble: true })
    const joins = w.findAll('[data-stroke-join] option').map(o => o.text())
    const styles = w.findAll('[data-stroke-style] option').map(o => o.text())
    const wobbles = w.findAll('[data-stroke-wobble] option').map(o => o.text())
    expect(joins).toEqual(['Sharp', 'Rounded'])
    expect(styles).toEqual(['Band', 'Shapes'])
    expect(wobbles).toEqual(['Off', 'Wave', 'Zigzag'])
    // Values are still the stored slugs — that is the point of a label.
    expect(w.findAll('[data-stroke-join] option').map(o => o.attributes('value'))).toEqual(['sharp', 'round'])
    expect(w.findAll('[data-stroke-style] option').map(o => o.attributes('value'))).toEqual(['band', 'shapes'])
    expect(w.findAll('[data-stroke-wobble] option').map(o => o.attributes('value'))).toEqual(['off', 'wave', 'zigzag'])
    expect(STROKE_WOBBLE_OPTIONS.map(o => o.label)).toEqual(['Off', 'Wave', 'Zigzag'])

    const visible = w.text()
    for (const slug of ['sharp', 'round', 'band', 'shapes', 'center', 'inside', 'outside', 'wave', 'zigzag']) {
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

  // The row itself emits only the raw choice — seeding Amount/Every in the same patch is
  // `strokeWobblePatch`'s job (asserted above), invoked by the host, not by this component.
  it('emits the picked wobble as a bare value', async () => {
    const w = mountRow({ showWobble: true })
    await w.get('[data-stroke-wobble]').setValue('zigzag')
    expect(w.emitted('update:wobble')!.at(-1)).toEqual(['zigzag'])
  })

  it('converts Amount/Every px edits back into stored (normalized) units, and Phase stays in degrees', async () => {
    const w = mountRow({ showWobbleAmount: true, showWobbleLength: true, showWobblePhase: true, wobbleAmount: 0.01, wobbleLength: 0.05, wobblePhase: 90 })
    expect((w.get('[data-stroke-wobble-amount]').element as HTMLInputElement).value).toBe('12')
    expect((w.get('[data-stroke-wobble-length]').element as HTMLInputElement).value).toBe('60')
    expect((w.get('[data-stroke-wobble-phase]').element as HTMLInputElement).value).toBe('90')
    await w.get('[data-stroke-wobble-amount]').setValue('24')
    await w.get('[data-stroke-wobble-length]').setValue('120')
    await w.get('[data-stroke-wobble-phase]').setValue('180')
    expect(w.emitted('update:wobbleAmount')!.at(-1)).toEqual([0.02])
    expect(w.emitted('update:wobbleLength')!.at(-1)).toEqual([0.1])
    expect(w.emitted('update:wobblePhase')!.at(-1)).toEqual([180])
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
