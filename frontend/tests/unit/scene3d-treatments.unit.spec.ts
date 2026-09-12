import { describe, it, expect } from 'vitest'
import { defaultDoc, createPrimitive, createLight, serializeDoc, parseDoc } from '~/lib/scene3d/config'
import {
  TREATMENT_KINDS, TREATMENT_LABELS, TREATED_OBJECT_CAP, createTreatment, parseTreatment, parseTreatments,
  cloneTreatments, maskedTreatmentPlan, unrenderedTreatmentIds, findTreatment, edgeTreatmentsOf, isMaskedKind, BLUR_AMOUNT_MAX,
  docHasGBufferTreatment, bufferTreatmentPlan,
} from '~/lib/scene3d/treatments'
import { treatmentControls } from '~/lib/scene3d/treatmentControls'
import { blurPasses } from '~/lib/scene3d/treatmentStage'

describe('treatments: model', () => {
  it('createTreatment fills every dial from TREATMENT_DEFAULTS with a fresh trt_ id, enabled and not inverted', () => {
    const t = createTreatment('glow')
    expect(t.id).toMatch(/^trt_/)
    expect(t).toMatchObject({ kind: 'glow', enabled: true, invert: false, strength: 1, threshold: 0.6, tint: '#ffffff' })
    expect(createTreatment('blur').id).not.toBe(createTreatment('blur').id)
  })
  it('every kind has a sentence-case human label', () => {
    // Starts-with-capital only (not /^[A-Z][a-z]/): "X-ray" is the mandated copy
    // (constraints.md) and its second character is a hyphen, not a lowercase letter.
    for (const k of TREATMENT_KINDS) expect(TREATMENT_LABELS[k]).toMatch(/^[A-Z]/)
  })
  it('TREATMENT_KINDS includes colorGrade as a masked kind with a British label', () => {
    expect(TREATMENT_KINDS).toContain('colorGrade')
    expect(isMaskedKind('colorGrade')).toBe(true)
    expect(TREATMENT_LABELS.colorGrade).toBe('Colour grade')
  })
  it('TREATMENT_KINDS includes dissolve as a masked kind, not a G-buffer reader', () => {
    expect(TREATMENT_KINDS).toContain('dissolve')
    expect(isMaskedKind('dissolve')).toBe(true)
    expect(TREATMENT_LABELS.dissolve).toBe('Dissolve')
  })
  it('TREATMENT_KINDS includes halftone as a masked kind, not a G-buffer reader', () => {
    expect(TREATMENT_KINDS).toContain('halftone')
    expect(isMaskedKind('halftone')).toBe(true)
    expect(TREATMENT_LABELS.halftone).toBe('Halftone')
  })
  it('TREATMENT_KINDS includes chromaticSplit as a masked kind, not a G-buffer reader', () => {
    expect(TREATMENT_KINDS).toContain('chromaticSplit')
    expect(isMaskedKind('chromaticSplit')).toBe(true)
    expect(TREATMENT_LABELS.chromaticSplit).toBe('Chromatic split')
  })
  it('TREATMENT_KINDS includes glitch as a masked kind, not a G-buffer reader', () => {
    expect(TREATMENT_KINDS).toContain('glitch')
    expect(isMaskedKind('glitch')).toBe(true)
    expect(TREATMENT_LABELS.glitch).toBe('Glitch')
  })
})

describe('treatments: glitch', () => {
  it('createTreatment seeds defaults, enabled and not inverted, with a fresh id', () => {
    expect(createTreatment('glitch')).toMatchObject({
      kind: 'glitch', enabled: true, invert: false, amount: 24, bands: 12, scanlines: 0.5, seed: 1,
    })
  })
  it('is NOT a ramped kind — no progressive/ramp fields', () => {
    expect(createTreatment('glitch')).not.toHaveProperty('progressive')
    expect(parseTreatment({ id: 'gl', kind: 'glitch' })).not.toHaveProperty('rampSpace')
  })
  it('clamps amount to 0..64, bands to 2..64 (rounded), scanlines to 0..1, seed to a non-negative int', () => {
    expect(parseTreatment({ id: 'gl1', kind: 'glitch', amount: 999, bands: 999, scanlines: 5, seed: 7.6 }))
      .toMatchObject({ amount: 64, bands: 64, scanlines: 1, seed: 8 })
    expect(parseTreatment({ id: 'gl2', kind: 'glitch', amount: -5, bands: 0, scanlines: -3, seed: -4 }))
      .toMatchObject({ amount: 0, bands: 2, scanlines: 0, seed: 0 })
    expect(parseTreatment({ id: 'gl3', kind: 'glitch', bands: 8.6 }))
      .toMatchObject({ amount: 24, bands: 9, scanlines: 0.5, seed: 1 })
    expect(parseTreatment({ id: 'gl4', kind: 'glitch' }))
      .toMatchObject({ amount: 24, bands: 12, scanlines: 0.5, seed: 1 })
  })
})

describe('treatments: chromatic split', () => {
  it('createTreatment seeds defaults, enabled and not inverted, with a fresh id', () => {
    expect(createTreatment('chromaticSplit')).toMatchObject({
      kind: 'chromaticSplit', enabled: true, invert: false, amount: 8, angle: 0,
    })
  })
  it('is NOT a ramped kind — no progressive/ramp fields', () => {
    expect(createTreatment('chromaticSplit')).not.toHaveProperty('progressive')
    expect(parseTreatment({ id: 'cs', kind: 'chromaticSplit' })).not.toHaveProperty('rampSpace')
  })
  it('clamps amount to 0..64 and wraps angle into 0..360, backfilling missing dials', () => {
    expect(parseTreatment({ id: 'cs1', kind: 'chromaticSplit', amount: 999, angle: 405 }))
      .toMatchObject({ amount: 64, angle: 45 })
    expect(parseTreatment({ id: 'cs2', kind: 'chromaticSplit', amount: -5, angle: -90 }))
      .toMatchObject({ amount: 0, angle: 270 })
    expect(parseTreatment({ id: 'cs3', kind: 'chromaticSplit' }))
      .toMatchObject({ amount: 8, angle: 0 })
  })
})

describe('treatments: halftone', () => {
  it('createTreatment seeds defaults, enabled and not inverted, with a fresh id', () => {
    expect(createTreatment('halftone')).toMatchObject({
      kind: 'halftone', enabled: true, invert: false, cell: 6, angle: 45, contrast: 1, color: '#000000',
    })
  })
  it('is NOT a ramped kind — no progressive/ramp fields', () => {
    expect(createTreatment('halftone')).not.toHaveProperty('progressive')
    expect(parseTreatment({ id: 'ht', kind: 'halftone' })).not.toHaveProperty('rampSpace')
  })
  it('clamps cell to 2..64 and contrast to 0.25..4, wraps angle into 0..360 and backfills the ink', () => {
    expect(parseTreatment({ id: 'ht1', kind: 'halftone', cell: 999, contrast: 99, angle: 405, color: '#ff0000' }))
      .toMatchObject({ cell: 64, contrast: 4, angle: 45, color: '#ff0000' })
    expect(parseTreatment({ id: 'ht2', kind: 'halftone', cell: 0, contrast: 0, angle: -90 }))
      .toMatchObject({ cell: 2, contrast: 0.25, angle: 270 })
    expect(parseTreatment({ id: 'ht3', kind: 'halftone' }))
      .toMatchObject({ cell: 6, angle: 45, contrast: 1, color: '#000000' })
  })
})

describe('treatments: dissolve', () => {
  it('createTreatment seeds defaults, enabled and not inverted, with a fresh id', () => {
    expect(createTreatment('dissolve')).toMatchObject({
      kind: 'dissolve', enabled: true, invert: false, amount: 0.5, scale: 24, softness: 0.1, seed: 1,
    })
  })
  it('is NOT a ramped kind — no progressive/ramp fields', () => {
    expect(createTreatment('dissolve')).not.toHaveProperty('progressive')
    expect(parseTreatment({ id: 'dv', kind: 'dissolve' })).not.toHaveProperty('rampSpace')
  })
  it('clamps amount/softness to 0..1, scale to 2..64, and rounds seed to a non-negative int', () => {
    expect(parseTreatment({ id: 'dv1', kind: 'dissolve', amount: 5, scale: 999, softness: -3, seed: 7.6 }))
      .toMatchObject({ amount: 1, scale: 64, softness: 0, seed: 8 })
    expect(parseTreatment({ id: 'dv2', kind: 'dissolve', amount: -1, scale: 0, seed: -4 }))
      .toMatchObject({ amount: 0, scale: 2, seed: 0 })
    expect(parseTreatment({ id: 'dv3', kind: 'dissolve' }))
      .toMatchObject({ amount: 0.5, scale: 24, softness: 0.1, seed: 1 })
  })
})

describe('treatments: colour grade', () => {
  it('createTreatment seeds neutral defaults, enabled and not inverted, with a fresh id', () => {
    expect(createTreatment('colorGrade')).toMatchObject({
      kind: 'colorGrade', enabled: true, invert: false, brightness: 1, contrast: 1, saturation: 1, hue: 0,
    })
  })
  it('is NOT a ramped kind — no progressive/ramp fields', () => {
    expect(createTreatment('colorGrade')).not.toHaveProperty('progressive')
    expect(parseTreatment({ id: 'cg', kind: 'colorGrade' })).not.toHaveProperty('rampSpace')
  })
  it('clamps the three factor dials to 0..2 and hue to -180..180, backfilling from defaults', () => {
    expect(parseTreatment({ id: 'cg1', kind: 'colorGrade', brightness: 5, contrast: -3, saturation: 9, hue: 400 }))
      .toMatchObject({ brightness: 2, contrast: 0, saturation: 2, hue: 180 })
    expect(parseTreatment({ id: 'cg2', kind: 'colorGrade', hue: -400 })).toMatchObject({ hue: -180 })
    expect(parseTreatment({ id: 'cg3', kind: 'colorGrade' }))
      .toMatchObject({ brightness: 1, contrast: 1, saturation: 1, hue: 0 })
  })
})

describe('treatments: parse', () => {
  it('a document without the field round-trips byte-identical', () => {
    const doc = defaultDoc()
    doc.objects.push(createPrimitive('box', doc.objects))
    const json = serializeDoc(doc)
    // Deep-equal, not a raw string `toBe(json)`: parseDoc's `common` object (id, name,
    // visible, position...) and createPrimitive's literal (kind, primitive, id, name...)
    // already order keys differently pre-existing this task, so JSON.stringify key order
    // isn't byte-stable across a round trip even without treatments. What must hold —
    // and does — is that the parsed doc is deep-equal and gained no treatments key.
    expect(parseDoc(json)).toEqual(doc)
    expect(parseDoc(json).objects[0]!.treatments).toBeUndefined()
  })
  it('round-trips a treatment list in stack order', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects)
    box.treatments = [createTreatment('blur'), createTreatment('rimLight'), createTreatment('fade')]
    doc.objects.push(box)
    const back = parseDoc(serializeDoc(doc))
    expect(back.objects[0]!.treatments!.map((t) => t.kind)).toEqual(['blur', 'rimLight', 'fade'])
    expect(back).toEqual(doc)
  })
  it('drops an invalid entry but keeps the object and the valid entries', () => {
    const list = parseTreatments([
      { id: 'a', kind: 'blur', amount: 0.3 },
      { id: 'b', kind: 'nope' },
      { kind: 'fade' },
      { id: 'c.d', kind: 'fade' },
      { id: '12', kind: 'fade' },
      'junk',
      { id: 'e', kind: 'pixelate', cellSize: 9.6 },
    ])
    expect(list!.map((t) => t.id)).toEqual(['a', 'e'])
    expect(list![1]).toMatchObject({ kind: 'pixelate', cellSize: 10 })
  })
  it('backfills missing dials, clamps ranges and treats absent flags as enabled / not inverted', () => {
    const t = parseTreatment({ id: 'x', kind: 'blur', amount: 4 })!
    expect(t).toMatchObject({ kind: 'blur', amount: BLUR_AMOUNT_MAX, enabled: true, invert: false })
    const mid = parseTreatment({ id: 'x2', kind: 'blur', amount: 2.5 })!
    expect(mid).toMatchObject({ kind: 'blur', amount: 2.5 })
    const neg = parseTreatment({ id: 'x3', kind: 'blur', amount: -1 })!
    expect(neg).toMatchObject({ kind: 'blur', amount: 0 })
    const w = parseTreatment({ id: 'y', kind: 'wireframe', enabled: false, showSurface: false })!
    expect(w).toMatchObject({ kind: 'wireframe', enabled: false, showSurface: false, color: '#ffffff', lineOpacity: 0.8 })
  })
  it('keeps the first of two entries sharing an id', () => {
    const list = parseTreatments([{ id: 'a', kind: 'blur', amount: 0.1 }, { id: 'a', kind: 'fade' }])!
    expect(list).toHaveLength(1)
    expect(list[0]!.kind).toBe('blur')
  })
  it('an absent or empty list parses to undefined, never []', () => {
    expect(parseTreatments(undefined)).toBeUndefined()
    expect(parseTreatments([])).toBeUndefined()
    expect(parseTreatments(['junk'])).toBeUndefined()
  })
})

describe('treatments: clone / find', () => {
  it('cloneTreatments keeps dials and order but mints fresh ids', () => {
    const src = [createTreatment('blur'), createTreatment('outline')]
    const copy = cloneTreatments(src)!
    expect(copy.map((t) => t.kind)).toEqual(['blur', 'outline'])
    expect(copy[0]!.id).not.toBe(src[0]!.id)
    expect(cloneTreatments(undefined)).toBeUndefined()
    expect(cloneTreatments([])).toBeUndefined()
  })
  it('findTreatment resolves by object id + treatment id and returns the index', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects)
    box.treatments = [createTreatment('blur'), createTreatment('glow')]
    doc.objects.push(box)
    expect(findTreatment(doc, box.id, box.treatments[1]!.id)).toMatchObject({ index: 1, treatment: { kind: 'glow' } })
    expect(findTreatment(doc, box.id, 'nope')).toBeNull()
    expect(findTreatment(doc, 'nope', box.treatments[0]!.id)).toBeNull()
  })
  it('edgeTreatmentsOf returns enabled edge-family entries only, in order', () => {
    const box = createPrimitive('box')
    const off = createTreatment('outline'); off.enabled = false
    box.treatments = [createTreatment('blur'), createTreatment('rimLight'), off, createTreatment('wireframe')]
    expect(edgeTreatmentsOf(box).map((t) => t.kind)).toEqual(['rimLight', 'wireframe'])
    expect(isMaskedKind('fade')).toBe(true)
    expect(isMaskedKind('xray')).toBe(false)
  })
})

describe('treatments: masked plan', () => {
  it('groups one object\'s masked treatments into one group, in stack order, skipping edge kinds and disabled entries', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects)
    const off = createTreatment('pixelate'); off.enabled = false
    box.treatments = [createTreatment('blur'), createTreatment('rimLight'), off, createTreatment('fade')]
    doc.objects.push(box)
    const plan = maskedTreatmentPlan(doc)
    expect(plan).toHaveLength(1)
    expect(plan[0]).toMatchObject({ objectId: box.id, invert: false, rendered: true })
    expect(plan[0]!.treatments.map((t) => t.kind)).toEqual(['blur', 'fade'])
  })
  it('splits normal and inverted treatments of one object into two groups', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects)
    const inv = createTreatment('blur'); inv.invert = true
    box.treatments = [createTreatment('fade'), inv]
    doc.objects.push(box)
    expect(maskedTreatmentPlan(doc).map((g) => g.invert)).toEqual([false, true])
  })
  it('renders only the first inverted group per frame', () => {
    const doc = defaultDoc()
    for (let i = 0; i < 2; i++) {
      const o = createPrimitive('box', doc.objects)
      const inv = createTreatment('blur'); inv.invert = true
      o.treatments = [inv]
      doc.objects.push(o)
    }
    const plan = maskedTreatmentPlan(doc)
    expect(plan[0]!.rendered).toBe(true)
    expect(plan[1]).toMatchObject({ rendered: false, skipped: 'invert' })
  })
  it('caps at TREATED_OBJECT_CAP groups and reports the rest as skipped by cap', () => {
    const doc = defaultDoc()
    for (let i = 0; i < TREATED_OBJECT_CAP + 2; i++) {
      const o = createPrimitive('sphere', doc.objects)
      o.treatments = [createTreatment('blur')]
      doc.objects.push(o)
    }
    const plan = maskedTreatmentPlan(doc)
    expect(plan.filter((g) => g.rendered)).toHaveLength(TREATED_OBJECT_CAP)
    expect(plan.slice(TREATED_OBJECT_CAP).every((g) => g.skipped === 'cap')).toBe(true)
    const ids = unrenderedTreatmentIds(plan)
    expect(ids.size).toBe(2)
    expect(ids.has(plan[TREATED_OBJECT_CAP]!.treatments[0]!.id)).toBe(true)
  })
  it('ignores hidden objects and non-host kinds', () => {
    const doc = defaultDoc()
    const hidden = createPrimitive('box', doc.objects); hidden.visible = false; hidden.treatments = [createTreatment('blur')]
    const light = createLight('point', doc.objects); (light as any).treatments = [createTreatment('blur')]
    doc.objects.push(hidden, light)
    expect(maskedTreatmentPlan(doc)).toEqual([])
  })
})

describe('treatments: G-buffer family (edge lines, depth fog, curvature wear)', () => {
  it('createTreatment seeds depth fog and curvature wear from their defaults', () => {
    expect(createTreatment('depthFog')).toMatchObject({ kind: 'depthFog', enabled: true, invert: false, color: '#8fa6bf', start: 0.3, end: 1 })
    expect(createTreatment('curvatureWear')).toMatchObject({ kind: 'curvatureWear', enabled: true, invert: false, amount: 0.5, width: 0.5 })
  })
  it('parses depth fog, clamping start/end to 0..1 and backfilling from defaults', () => {
    const t = parseTreatment({ id: 't-fog', kind: 'depthFog', color: '#123456', start: -1, end: 5 })
    expect(t).toMatchObject({ id: 't-fog', kind: 'depthFog', color: '#123456', start: 0, end: 1 })
    const partial = parseTreatment({ id: 't-fog2', kind: 'depthFog' })
    expect(partial).toMatchObject({ color: '#8fa6bf', start: 0.3, end: 1 })
  })
  it('parses curvature wear, clamping amount to -1..1 and width to 0..1', () => {
    expect(parseTreatment({ id: 't-w', kind: 'curvatureWear', amount: 4, width: 9 })).toMatchObject({ amount: 1, width: 1 })
    expect(parseTreatment({ id: 't-w2', kind: 'curvatureWear', amount: -4 })).toMatchObject({ amount: -1, width: 0.5 })
  })
  it('a stored fog/wear entry round-trips through the document', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects)
    box.treatments = [createTreatment('depthFog'), createTreatment('curvatureWear')]
    doc.objects.push(box)
    const back = parseDoc(serializeDoc(doc))
    expect(back.objects.at(-1)!.treatments!.map((t) => t.kind)).toEqual(['depthFog', 'curvatureWear'])
    expect(back).toEqual(doc)
  })
  it('the gate is true iff a visible host carries an ENABLED buffer treatment (any of the three)', () => {
    const bufferKinds = ['edgeLines', 'depthFog', 'curvatureWear'] as const
    // No buffer treatment ⇒ gated off (a masked treatment must not trip it).
    const bare = defaultDoc()
    const b0 = createPrimitive('box', bare.objects); b0.treatments = [createTreatment('blur')]; bare.objects.push(b0)
    expect(docHasGBufferTreatment(bare)).toBe(false)
    expect(bufferTreatmentPlan(bare)).toEqual([])
    for (const kind of bufferKinds) {
      const doc = defaultDoc()
      const box = createPrimitive('box', doc.objects); box.treatments = [createTreatment(kind)]; doc.objects.push(box)
      expect(docHasGBufferTreatment(doc), kind).toBe(true)
      expect(bufferTreatmentPlan(doc).map((g) => g.objectId), kind).toEqual([box.id])
      // Disabled ⇒ no plan, no gate — the byte-identity guarantee.
      box.treatments = [{ ...createTreatment(kind), enabled: false }]
      expect(docHasGBufferTreatment(doc), `${kind} disabled`).toBe(false)
      // Hidden host ⇒ excluded even when enabled.
      box.treatments = [createTreatment(kind)]; box.visible = false
      expect(docHasGBufferTreatment(doc), `${kind} hidden`).toBe(false)
    }
  })
})

describe('treatments: blur Amount control', () => {
  it('blur Amount control row has max === BLUR_AMOUNT_MAX', () => {
    const rows = treatmentControls('blur')
    const amountRow = rows.find((r) => r.key === 'treatment.amount')
    expect(amountRow).toBeDefined()
    expect(amountRow?.max).toBe(BLUR_AMOUNT_MAX)
  })
  it('blurPasses(3, 1000) yields radiusPx 180 and passes capped at 4', () => {
    const { passes, radiusPx } = blurPasses(3, 1000)
    expect(radiusPx).toBe(180)
    expect(passes).toBe(4)
  })
})

describe('blur ramp fields', () => {
  it('backfills every ramp field on a blur with none of them', () => {
    const t = parseTreatment({ id: 'b1', kind: 'blur', amount: 0.4 })
    expect(t).toMatchObject({
      kind: 'blur', amount: 0.4,
      progressive: false, rampSpace: 'object', rampAngle: 90, rampStart: 0, rampEnd: 1,
    })
  })

  it('keeps stored ramp values', () => {
    const t = parseTreatment({
      id: 'b2', kind: 'blur', amount: 1,
      progressive: true, rampSpace: 'frame', rampAngle: 30, rampStart: 0.2, rampEnd: 0.8,
    })
    expect(t).toMatchObject({
      progressive: true, rampSpace: 'frame', rampAngle: 30, rampStart: 0.2, rampEnd: 0.8,
    })
  })

  it('wraps the angle into 0-360 and clamps the stops', () => {
    const t = parseTreatment({
      id: 'b3', kind: 'blur', rampAngle: -90, rampStart: -2, rampEnd: 5,
    }) as { rampAngle: number; rampStart: number; rampEnd: number }
    expect(t.rampAngle).toBe(270)
    expect(t.rampStart).toBe(0)
    expect(t.rampEnd).toBe(1)
  })

  it('falls back to object space on an unknown ramp space', () => {
    const t = parseTreatment({ id: 'b4', kind: 'blur', rampSpace: 'sideways' })
    expect(t).toMatchObject({ rampSpace: 'object' })
  })

  it('treats a non-boolean progressive as off', () => {
    const t = parseTreatment({ id: 'b5', kind: 'blur', progressive: 'yes' })
    expect(t).toMatchObject({ progressive: false })
  })

  it('createTreatment seeds a blur with the ramp defaults', () => {
    expect(createTreatment('blur')).toMatchObject({
      kind: 'blur', progressive: false, rampSpace: 'object', rampAngle: 90, rampStart: 0, rampEnd: 1,
    })
  })
})

describe('the shared ramp', () => {
  const KINDS = ['blur', 'glow', 'pixelate', 'fade'] as const

  it('every masked kind backfills all five ramp fields', () => {
    for (const kind of KINDS) {
      expect(parseTreatment({ id: `t-${kind}`, kind }), kind).toMatchObject({
        progressive: false, rampSpace: 'object', rampAngle: 90, rampStart: 0, rampEnd: 1,
      })
    }
  })

  it('every masked kind keeps stored ramp values', () => {
    for (const kind of KINDS) {
      expect(parseTreatment({
        id: `t-${kind}`, kind,
        progressive: true, rampSpace: 'frame', rampAngle: 30, rampStart: 0.2, rampEnd: 0.8,
      }), kind).toMatchObject({
        progressive: true, rampSpace: 'frame', rampAngle: 30, rampStart: 0.2, rampEnd: 0.8,
      })
    }
  })

  it('validates the ramp the same way for every kind', () => {
    for (const kind of KINDS) {
      const t = parseTreatment({
        id: `t-${kind}`, kind, rampAngle: -90, rampStart: -2, rampEnd: 5,
        rampSpace: 'sideways', progressive: 'yes',
      }) as unknown as Record<string, unknown>
      expect(t.rampAngle, kind).toBe(270)
      expect(t.rampStart, kind).toBe(0)
      expect(t.rampEnd, kind).toBe(1)
      expect(t.rampSpace, kind).toBe('object')
      expect(t.progressive, kind).toBe(false)
    }
  })

  it('createTreatment seeds every masked kind with the ramp defaults', () => {
    for (const kind of KINDS) {
      expect(createTreatment(kind), kind).toMatchObject({
        progressive: false, rampSpace: 'object', rampAngle: 90, rampStart: 0, rampEnd: 1,
      })
    }
  })

  it('leaves the edge kinds alone', () => {
    for (const kind of ['rimLight', 'outline', 'xray', 'wireframe'] as const) {
      expect(parseTreatment({ id: `t-${kind}`, kind }), kind).not.toHaveProperty('progressive')
    }
  })
})
