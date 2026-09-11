import { describe, it, expect } from 'vitest'
import {
  EFFECT_ORDER, EFFECT_LABELS, PINNED_KINDS, ORDERABLE_KINDS, GEOMETRY_KINDS,
  effectStackOf, writeStackToLayer, createEffect, newEffectId, isPinnedKind, isGeometryKind,
  addEffect, removeEffect, duplicateEffect, reorderEffect, canReorder, regionOf,
  orderablePasses, pinnedEffect, splitTrailingBlurs, rasterablePasses, type EffectInstance,
  type EffectKind,
} from '~/lib/compositor/effectStack'
import { DEFAULT_TORN_EDGE } from '~/lib/compositor/tornEdge'
import { DEFAULT_FEATHER } from '~/lib/compositor/feather'
import { canTakeGeometry, canWarpRaster } from '~/composables/useCompositorLayers'

describe('effect kinds', () => {
  it('has 26 kinds, 3 pinned and 23 orderable, all labelled in sentence case', () => {
    expect(EFFECT_ORDER).toHaveLength(26)
    expect(PINNED_KINDS).toEqual(['background_blur', 'dof', 'drop_shadow'])
    expect(ORDERABLE_KINDS).toHaveLength(23)
    expect(new Set([...PINNED_KINDS, ...ORDERABLE_KINDS])).toEqual(new Set(EFFECT_ORDER))
    for (const k of EFFECT_ORDER) expect(EFFECT_LABELS[k], k).toMatch(/^[A-Z][a-z]/)
    expect(EFFECT_LABELS.gradientMap).toBe('Gradient map')
    expect(EFFECT_LABELS.dof).toBe('Depth of field')
    expect(EFFECT_LABELS.trim).toBe('Trim path')
    expect(EFFECT_LABELS.offset).toBe('Offset path')
    expect(EFFECT_LABELS.round_corners).toBe('Round corners')
    expect(EFFECT_LABELS.roughen).toBe('Roughen')
    expect(EFFECT_LABELS.boolean).toBe('Combine shapes')
    expect(EFFECT_LABELS.morph).toBe('Morph to shape')
    expect(EFFECT_LABELS.warp).toBe('Warp')
    expect(EFFECT_LABELS.shatter).toBe('Shatter')
    expect(EFFECT_LABELS.long_shadow).toBe('Long shadow')
    expect(EFFECT_LABELS.outer_glow).toBe('Outer glow')
    expect(EFFECT_LABELS.inner_glow).toBe('Inner glow')
    expect(EFFECT_LABELS.color_overlay).toBe('Colour overlay')
    expect(EFFECT_LABELS.gradient_overlay).toBe('Gradient overlay')
  })
  it('orders background blur first and drop shadow last', () => {
    expect(EFFECT_ORDER[0]).toBe('background_blur')
    expect(EFFECT_ORDER[EFFECT_ORDER.length - 1]).toBe('drop_shadow')
    expect(isPinnedKind('dof')).toBe(true)
    expect(isPinnedKind('bloom')).toBe(false)
  })
  it('the nine geometry kinds are contiguous in EFFECT_ORDER and precede every pixel kind', () => {
    expect(GEOMETRY_KINDS).toEqual(['trim', 'offset', 'round_corners', 'roughen', 'boolean', 'morph', 'warp', 'shatter', 'long_shadow'])
    const indices = GEOMETRY_KINDS.map(k => EFFECT_ORDER.indexOf(k))
    for (let i = 1; i < indices.length; i++) expect(indices[i]).toBe(indices[i - 1]! + 1)
    const lastGeometry = Math.max(...indices)
    for (const k of EFFECT_ORDER) {
      if (isGeometryKind(k) || k === 'background_blur' || k === 'dof') continue
      expect(EFFECT_ORDER.indexOf(k), k).toBeGreaterThan(lastGeometry)
    }
    for (const k of GEOMETRY_KINDS) expect(isGeometryKind(k)).toBe(true)
    expect(isGeometryKind('bloom')).toBe(false)
  })
  it('regionOf assigns every kind to the right region', () => {
    const expected: Record<EffectKind, string> = {
      background_blur: 'backdrop', dof: 'backdrop',
      trim: 'geometry', offset: 'geometry', round_corners: 'geometry', roughen: 'geometry',
      boolean: 'geometry', morph: 'geometry', warp: 'geometry', shatter: 'geometry', long_shadow: 'geometry',
      inner_shadow: 'pixel', inner_glow: 'pixel', adjust: 'pixel', duotone: 'pixel', gradientMap: 'pixel',
      bloom: 'pixel', vignette: 'pixel', grain: 'pixel', torn_edge: 'pixel',
      feather: 'pixel', layer_blur: 'pixel', outer_glow: 'pixel',
      color_overlay: 'pixel', gradient_overlay: 'pixel',
      drop_shadow: 'stamp',
    }
    for (const k of EFFECT_ORDER) expect(regionOf(k), k).toBe(expected[k])
  })
  it('createEffect fills the kind defaults, visible, with a fresh random id', () => {
    const a = createEffect('bloom'), b = createEffect('bloom')
    expect(a.type).toBe('bloom')
    expect(a.visible).toBe(true)
    expect(a.id).toMatch(/^fx_/)
    expect(a.id).not.toBe(b.id)
    expect(newEffectId()).not.toBe(newEffectId())
    expect(createEffect('torn_edge')).toMatchObject({ type: 'torn_edge', style: DEFAULT_TORN_EDGE.style })
    expect(createEffect('feather')).toMatchObject({ type: 'feather', curve: DEFAULT_FEATHER.curve })
  })
  it('createEffect fills each geometry kind default with a fresh id', () => {
    expect(createEffect('trim')).toMatchObject({ type: 'trim', start: 0, end: 1, offset: 0, visible: true })
    expect(createEffect('offset')).toMatchObject({ type: 'offset', distance: 0.01, visible: true })
    expect(createEffect('round_corners')).toMatchObject({ type: 'round_corners', radius: 0.02, visible: true })
    expect(createEffect('roughen')).toMatchObject({ type: 'roughen', amount: 0.02, detail: 8, seed: 1, visible: true })
    // boolean defaults to unite with no ref (a no-op until the picker sets a sibling).
    expect(createEffect('boolean')).toMatchObject({ type: 'boolean', op: 'unite', visible: true })
    expect((createEffect('boolean') as any).refLayerId).toBeUndefined()
    // morph defaults to amount 0.5 with no ref (a no-op until the picker sets a sibling).
    expect(createEffect('morph')).toMatchObject({ type: 'morph', amount: 0.5, visible: true })
    expect((createEffect('morph') as any).refLayerId).toBeUndefined()
    expect(createEffect('warp')).toMatchObject({ type: 'warp', field: 'bulge', amount: 0.3, frequency: 3, visible: true })
    const a = createEffect('trim'), b = createEffect('trim')
    expect(a.id).not.toBe(b.id)
  })
})

describe('effectStackOf: old shape', () => {
  it('stamps deterministic ids, folds tornEdge and feather in, and sorts into canonical order', () => {
    const layer = {
      effects: [
        { type: 'grain', amount: 0.2, size: 2, visible: true },
        { type: 'drop_shadow', color: '#000', x: 0, y: 0, blur: 0.01, visible: true },
        { type: 'adjust', brightness: 1.2, contrast: 1, saturation: 1, hue: 0, visible: true },
      ],
      tornEdge: { ...DEFAULT_TORN_EDGE, amount: 12 },
      feather: { ...DEFAULT_FEATHER, amount: 0.2 },
    }
    const stack = effectStackOf(layer)
    expect(stack.map(e => e.type)).toEqual(['adjust', 'grain', 'torn_edge', 'feather', 'drop_shadow'])
    expect(stack.every(e => typeof e.id === 'string' && e.id.length > 0)).toBe(true)
    // deterministic: two reads of the same layer agree, so a selection survives a re-read
    expect(effectStackOf(layer).map(e => e.id)).toEqual(stack.map(e => e.id))
    expect(stack.find(e => e.type === 'torn_edge')).toMatchObject({ amount: 12, visible: true })
    expect(stack.find(e => e.type === 'feather')).toMatchObject({ amount: 0.2, visible: true })
  })
  it('gives same-type duplicates distinct deterministic ids and keeps their relative order', () => {
    const layer = { effects: [
      { type: 'bloom', threshold: 0.1, radius: 0.01, intensity: 1, visible: true },
      { type: 'bloom', threshold: 0.9, radius: 0.02, intensity: 2, visible: true },
    ] }
    const stack = effectStackOf(layer)
    expect(stack).toHaveLength(2)
    expect(stack[0]!.id).not.toBe(stack[1]!.id)
    expect((stack[0] as any).threshold).toBe(0.1)
  })
  it('skips an inactive tornEdge or feather, and unknown kinds', () => {
    const layer = {
      effects: [{ type: 'nope', visible: true }, { type: 'grain', amount: 0.1, size: 2, visible: true }],
      tornEdge: { ...DEFAULT_TORN_EDGE, amount: 0, grain: 0, lipWidth: 0 },
      feather: { ...DEFAULT_FEATHER, amount: 0 },
    }
    expect(effectStackOf(layer).map(e => e.type)).toEqual(['grain'])
  })
  it('a layer with nothing yields an empty stack', () => {
    expect(effectStackOf({})).toEqual([])
    expect(effectStackOf({ effects: [] })).toEqual([])
  })
})

describe('effectStackOf: new shape', () => {
  it('returns the stored order untouched when every entry already has an id', () => {
    const stored: EffectInstance[] = [
      { id: 'a', type: 'grain', amount: 0.2, size: 2, visible: true } as any,
      { id: 'b', type: 'adjust', brightness: 1.2, contrast: 1, saturation: 1, hue: 0, visible: true } as any,
    ]
    const stack = effectStackOf({ effects: stored })
    expect(stack.map(e => e.type)).toEqual(['grain', 'adjust'])
    expect(stack.map(e => e.id)).toEqual(['a', 'b'])
  })
  it('treats a partially id-stamped list as old shape and re-sorts it', () => {
    const stack = effectStackOf({ effects: [
      { id: 'a', type: 'grain', amount: 0.2, size: 2, visible: true },
      { type: 'adjust', brightness: 1, contrast: 1, saturation: 1, hue: 0, visible: true },
    ] })
    expect(stack.map(e => e.type)).toEqual(['adjust', 'grain'])
    // Every id is MINTED here, including the one that arrived already stamped: keeping 'a'
    // would let it collide with a minted `fx:<type>:<ordinal>` elsewhere in the same list.
    expect(stack.map(e => e.id)).toEqual(['fx:adjust:0', 'fx:grain:0'])
  })
  it('reads a missing `visible` as visible in BOTH shapes', () => {
    const newShape = effectStackOf({ effects: [{ id: 'a', type: 'grain', amount: 0.2, size: 2 }] })
    const oldShape = effectStackOf({ effects: [{ type: 'grain', amount: 0.2, size: 2 }] })
    expect(newShape[0]!.visible).toBe(true)
    expect(oldShape[0]!.visible).toBe(true)
  })
})

describe('nested defaults are never shared between instances', () => {
  it('two gradient maps get their own stops array, and so does a duplicate', () => {
    const a = createEffect('gradientMap') as any
    const b = createEffect('gradientMap') as any
    expect(a.stops).not.toBe(b.stops)
    a.stops[0].color = '#ff0000'
    expect(b.stops[0].color).not.toBe('#ff0000')

    const stack = [a as EffectInstance]
    const dup = duplicateEffect(stack, a.id)
    expect((dup[1] as any).stops).not.toBe(a.stops)
    ;(dup[1] as any).stops[1].color = '#00ff00'
    expect(a.stops[1].color).not.toBe('#00ff00')
  })
})

describe('writeStackToLayer', () => {
  it('returns a patch that stores the stack and clears the legacy fields', () => {
    const stack = effectStackOf({ tornEdge: { ...DEFAULT_TORN_EDGE, amount: 8 } })
    expect(writeStackToLayer(stack)).toEqual({ effects: stack, tornEdge: undefined, feather: undefined })
  })
})

describe('list operations', () => {
  const base = (): EffectInstance[] => effectStackOf({ effects: [
    { type: 'background_blur', radius: 0.01, visible: true },
    { type: 'adjust', brightness: 1, contrast: 1, saturation: 1, hue: 0, visible: true },
    { type: 'drop_shadow', color: '#000', x: 0, y: 0, blur: 0.01, visible: true },
  ] })

  it('adds an orderable kind at the end of the orderable region, before drop shadow', () => {
    const next = addEffect(base(), 'bloom')
    expect(next.map(e => e.type)).toEqual(['background_blur', 'adjust', 'bloom', 'drop_shadow'])
  })
  it('adds background blur first, dof after it, drop shadow last', () => {
    const s0 = effectStackOf({ effects: [{ type: 'adjust', brightness: 1, contrast: 1, saturation: 1, hue: 0, visible: true }] })
    expect(addEffect(s0, 'background_blur').map(e => e.type)).toEqual(['background_blur', 'adjust'])
    expect(addEffect(addEffect(s0, 'background_blur'), 'dof').map(e => e.type))
      .toEqual(['background_blur', 'dof', 'adjust'])
    expect(addEffect(s0, 'drop_shadow').map(e => e.type)).toEqual(['adjust', 'drop_shadow'])
  })
  it('refuses to add a second instance of a pinned kind, and allows a second orderable one', () => {
    const s = base()
    expect(addEffect(s, 'background_blur')).toEqual(s)
    expect(addEffect(s, 'drop_shadow')).toEqual(s)
    expect(addEffect(s, 'adjust').filter(e => e.type === 'adjust')).toHaveLength(2)
  })
  it('removes by id and leaves the rest in order', () => {
    const s = base()
    const id = s.find(e => e.type === 'adjust')!.id
    expect(removeEffect(s, id).map(e => e.type)).toEqual(['background_blur', 'drop_shadow'])
    expect(removeEffect(s, 'missing')).toEqual(s)
  })
  it('duplicates after the original with a fresh id', () => {
    const s = base()
    const id = s.find(e => e.type === 'adjust')!.id
    const next = duplicateEffect(s, id)
    expect(next.map(e => e.type)).toEqual(['background_blur', 'adjust', 'adjust', 'drop_shadow'])
    expect(next[2]!.id).not.toBe(next[1]!.id)
    expect(duplicateEffect(s, s.find(e => e.type === 'background_blur')!.id)).toEqual(s)
  })
  it('reorders within the orderable region and refuses anything touching a pinned row', () => {
    const s = addEffect(base(), 'bloom')            // bg, adjust, bloom, shadow
    const adjust = s.find(e => e.type === 'adjust')!.id
    const bloom = s.find(e => e.type === 'bloom')!.id
    const bg = s.find(e => e.type === 'background_blur')!.id
    expect(canReorder(s, adjust, bloom)).toBe(true)
    expect(reorderEffect(s, adjust, bloom).map(e => e.type))
      .toEqual(['background_blur', 'bloom', 'adjust', 'drop_shadow'])
    expect(canReorder(s, bg, adjust)).toBe(false)
    expect(canReorder(s, adjust, bg)).toBe(false)
    expect(reorderEffect(s, adjust, bg)).toEqual(s)
    expect(canReorder(s, adjust, adjust)).toBe(false)
  })
  it('orderablePasses and pinnedEffect split the stack', () => {
    const s = addEffect(base(), 'bloom')
    expect(orderablePasses(s).map(e => e.type)).toEqual(['adjust', 'bloom'])
    expect(pinnedEffect(s, 'background_blur')?.type).toBe('background_blur')
    expect(pinnedEffect(s, 'dof')).toBeUndefined()
  })
})

describe('geometry region', () => {
  const base = (): EffectInstance[] => effectStackOf({ effects: [
    { type: 'background_blur', radius: 0.01, visible: true },
    { type: 'adjust', brightness: 1, contrast: 1, saturation: 1, hue: 0, visible: true },
    { type: 'drop_shadow', color: '#000', x: 0, y: 0, blur: 0.01, visible: true },
  ] })

  it('adding a geometry kind lands it BEFORE every pixel kind, never after one', () => {
    const s = addEffect(base(), 'bloom')                        // bg, adjust, bloom, shadow
    const next = addEffect(s, 'trim')
    expect(next.map(e => e.type)).toEqual(['background_blur', 'trim', 'adjust', 'bloom', 'drop_shadow'])
  })
  it('a second geometry kind lands at the end of the geometry region, not after a pixel kind', () => {
    const s = addEffect(addEffect(base(), 'bloom'), 'trim')      // bg, trim, adjust, bloom, shadow
    const next = addEffect(s, 'roughen')
    expect(next.map(e => e.type)).toEqual(['background_blur', 'trim', 'roughen', 'adjust', 'bloom', 'drop_shadow'])
  })
  it('a geometry kind on an otherwise-empty stack still sits after the backdrop pins and before drop shadow', () => {
    const s0 = effectStackOf({ effects: [{ type: 'background_blur', radius: 0.01, visible: true }] })
    expect(addEffect(s0, 'trim').map(e => e.type)).toEqual(['background_blur', 'trim'])
    const s1 = effectStackOf({ effects: [
      { type: 'background_blur', radius: 0.01, visible: true },
      { type: 'drop_shadow', color: '#000', x: 0, y: 0, blur: 0.01, visible: true },
    ] })
    expect(addEffect(s1, 'trim').map(e => e.type)).toEqual(['background_blur', 'trim', 'drop_shadow'])
  })
  it('canReorder allows two geometry kinds to swap and refuses a geometry <-> pixel swap', () => {
    const s = addEffect(addEffect(base(), 'bloom'), 'trim')      // bg, trim, adjust, bloom, shadow
    const withRoughen = addEffect(s, 'roughen')                  // bg, trim, roughen, adjust, bloom, shadow
    const trim = withRoughen.find(e => e.type === 'trim')!.id
    const roughen = withRoughen.find(e => e.type === 'roughen')!.id
    const adjust = withRoughen.find(e => e.type === 'adjust')!.id
    const bloom = withRoughen.find(e => e.type === 'bloom')!.id
    expect(canReorder(withRoughen, trim, roughen)).toBe(true)
    expect(reorderEffect(withRoughen, trim, roughen).map(e => e.type))
      .toEqual(['background_blur', 'roughen', 'trim', 'adjust', 'bloom', 'drop_shadow'])
    expect(canReorder(withRoughen, trim, adjust)).toBe(false)
    expect(canReorder(withRoughen, bloom, trim)).toBe(false)
    expect(reorderEffect(withRoughen, trim, adjust)).toEqual(withRoughen)
    // a pixel <-> pixel swap is unaffected by the region check
    expect(canReorder(withRoughen, adjust, bloom)).toBe(true)
  })
  it('orderablePasses excludes geometry kinds, feeding a pixel-only pass list to paintLayer', () => {
    const s = addEffect(addEffect(base(), 'bloom'), 'trim')      // bg, trim, adjust, bloom, shadow
    const passes = orderablePasses(s)
    expect(passes.map(e => e.type)).toEqual(['adjust', 'bloom'])
    expect(passes.some(e => isGeometryKind(e.type))).toBe(false)
  })
})

describe('splitTrailingBlurs', () => {
  const t = (types: string[]) => types.map(type => ({ type }))
  it('splits nothing out of an empty list', () => {
    expect(splitTrailingBlurs([])).toEqual({ body: [], trailing: [] })
  })
  it('treats a lone blur as trailing — it belongs on the stamp filter', () => {
    const passes = t(['layer_blur'])
    expect(splitTrailingBlurs(passes)).toEqual({ body: [], trailing: passes })
  })
  it('keeps a blur followed by another pass in the body — the stamp filter runs last', () => {
    const passes = t(['layer_blur', 'grain'])
    expect(splitTrailingBlurs(passes)).toEqual({ body: passes, trailing: [] })
  })
  it('takes the maximal trailing run of blurs, in order', () => {
    const passes = t(['grain', 'layer_blur', 'layer_blur'])
    const { body, trailing } = splitTrailingBlurs(passes)
    expect(body).toEqual([passes[0]])
    expect(trailing).toEqual([passes[1], passes[2]])
  })
})

describe('rasterablePasses', () => {
  const t = (types: string[]) => types.map(type => ({ type }))
  it('refuses an empty list — there is no edge to bake', () => {
    expect(rasterablePasses([])).toBe(false)
  })
  it('accepts a lone torn edge', () => {
    expect(rasterablePasses(t(['torn_edge']))).toBe(true)
  })
  it('accepts blurs that come after every edge pass — the legacy order', () => {
    expect(rasterablePasses(t(['torn_edge', 'feather', 'layer_blur']))).toBe(true)
  })
  it('refuses a blur BEFORE an edge pass — the raster would apply them the wrong way round', () => {
    expect(rasterablePasses(t(['layer_blur', 'torn_edge']))).toBe(false)
  })
  it('refuses any pass the raster does not know', () => {
    expect(rasterablePasses(t(['torn_edge', 'grain']))).toBe(false)
  })
  it('refuses a blur with no edge pass at all', () => {
    expect(rasterablePasses(t(['layer_blur']))).toBe(false)
  })
})

describe('canTakeGeometry (add-menu gating predicate)', () => {
  // Imported from the composable, not the pure stack, because the decorated-text branch
  // reads a text layer's stroke stack (textHasDecoration). It is the vector half of
  // needsComputedOutline — the same answer the renderer uses — so the menu greys geometry on
  // exactly the layers the renderer would silently drop it on.
  const vec = (kind: string, extra: Record<string, unknown> = {}) =>
    ({ id: 'l', kind, ...extra }) as unknown as Parameters<typeof canTakeGeometry>[0]

  it('accepts every vector kind that can produce an outline', () => {
    for (const k of ['rect', 'ellipse', 'path', 'polygon', 'star', 'text']) {
      expect(canTakeGeometry(vec(k)), k).toBe(true)
    }
  })
  it('rejects kinds with no outline to transform', () => {
    for (const k of ['image', 'wired', 'brush', 'line', 'deal', 'scatter', 'mosaic']) {
      expect(canTakeGeometry(vec(k)), k).toBe(false)
    }
  })
  it('rejects underlined or struck-through text (it inks with fillText)', () => {
    expect(canTakeGeometry(vec('text', { underline: true }))).toBe(false)
    expect(canTakeGeometry(vec('text', { strikethrough: true }))).toBe(false)
  })
  it('accepts plain text with no decoration', () => {
    expect(canTakeGeometry(vec('text', { text: 'hi' }))).toBe(true)
  })
  it('rejects text carrying a painting distance-band stroke, accepts an inert one', () => {
    // A band that actually paints (has paint + width + distance) is a dilation with no outline.
    const painting = vec('text', {
      strokes: [{ id: 's1', paint: '#000', width: 0.01, distance: 0.02, visible: true }],
    })
    expect(canTakeGeometry(painting)).toBe(false)
    // An inert band (zero width) must NOT suppress geometry (Minor 2 tightening).
    const inert = vec('text', {
      strokes: [{ id: 's1', paint: '#000', width: 0, distance: 0.02, visible: true }],
    })
    expect(canTakeGeometry(inert)).toBe(true)
    // A band with distance but no paint must not suppress it either.
    const unpainted = vec('text', {
      strokes: [{ id: 's1', paint: 'none', width: 0.01, distance: 0.02, visible: true }],
    })
    expect(canTakeGeometry(unpainted)).toBe(true)
  })
})

describe('canWarpRaster (raster warp eligibility, F3 4b)', () => {
  // The SEPARATE per-kind predicate for the ONE geometry kind (warp) that also runs on raster
  // layers — a pixel-domain mesh warp of the content, not an outline transform. Deliberately
  // NOT canTakeGeometry (vector-only). Image / wired / brush qualify; nothing else does.
  const vec = (kind: string, extra: Record<string, unknown> = {}) =>
    ({ id: 'l', kind, ...extra }) as unknown as Parameters<typeof canWarpRaster>[0]

  it('accepts the three raster content kinds', () => {
    for (const k of ['image', 'wired', 'brush']) {
      expect(canWarpRaster(vec(k)), k).toBe(true)
    }
  })
  it('rejects every vector kind (they take the 4a outline warp instead)', () => {
    for (const k of ['rect', 'ellipse', 'path', 'polygon', 'star', 'text']) {
      expect(canWarpRaster(vec(k)), k).toBe(false)
    }
  })
  it('rejects the generative / line kinds that paint outside their box', () => {
    for (const k of ['line', 'deal', 'scatter', 'mosaic']) {
      expect(canWarpRaster(vec(k)), k).toBe(false)
    }
  })
  it('is disjoint from canTakeGeometry — no kind is both raster- and vector-warpable', () => {
    for (const k of ['rect', 'ellipse', 'path', 'polygon', 'star', 'text',
      'image', 'wired', 'brush', 'line', 'deal', 'scatter', 'mosaic']) {
      expect(canWarpRaster(vec(k)) && canTakeGeometry(vec(k)), k).toBe(false)
    }
  })
})
