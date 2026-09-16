import { describe, it, expect } from 'vitest'
import { defaultDoc, createPrimitive, createLight, createGroup, createGlbObject, serializeDoc, parseDoc, MATCAP_IDS } from '~/lib/scene3d/config'
import {
  TREATMENT_KINDS, TREATMENT_LABELS, TREATED_OBJECT_CAP, createTreatment, parseTreatment, parseTreatments,
  cloneTreatments, maskedTreatmentPlan, unrenderedTreatmentIds, findTreatment, edgeTreatmentsOf, isMaskedKind, isEdgeKind, isBufferKind, BLUR_AMOUNT_MAX,
  DASHED_OUTLINE_LEN_MAX, docHasGBufferTreatment, bufferTreatmentPlan, BUFFER_TREATMENT_KINDS,
  CROSS_HATCH_SPACING_MIN, CROSS_HATCH_SPACING_MAX,
  FINISH_TREATMENT_KINDS, isFinishKind, canTakeFinish, finishPlan, TREATMENT_DEFAULTS,
  MASKED_TREATMENT_KINDS, EDGE_TREATMENT_KINDS,
  MOTION_TREATMENT_KINDS, isMotionKind, motionTreatmentPlan, docHasMotionTreatment,
  VELOCITY_BLUR_AMOUNT_MAX, GHOST_COUNT_MAX, GHOST_SPACING_MAX,
  RESTYLE_TREATMENT_KINDS, isRestyleKind, restyleTreatmentPlan, docHasRestyleTreatment, RESTYLE_STRENGTH_MAX,
} from '~/lib/scene3d/treatments'
import type { AiRestyleTreatment } from '~/lib/scene3d/treatments'
import { RESTYLE_MODELS } from '~/data/scene3d-restyle-models'
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
  it('TREATMENT_KINDS includes dropShadow as a masked kind, not a G-buffer reader', () => {
    expect(TREATMENT_KINDS).toContain('dropShadow')
    expect(isMaskedKind('dropShadow')).toBe(true)
    expect(TREATMENT_LABELS.dropShadow).toBe('Flat drop shadow')
  })
  it('TREATMENT_KINDS includes dashedOutline as an EDGE kind (a shell, not masked, not a G-buffer reader)', () => {
    expect(TREATMENT_KINDS).toContain('dashedOutline')
    expect(isEdgeKind('dashedOutline')).toBe(true)
    expect(isMaskedKind('dashedOutline')).toBe(false)
    expect(TREATMENT_LABELS.dashedOutline).toBe('Dashed outline')
  })
  it('TREATMENT_KINDS includes silhouetteCutout as an EDGE kind (a shell, not masked, not a G-buffer reader)', () => {
    expect(TREATMENT_KINDS).toContain('silhouetteCutout')
    expect(isEdgeKind('silhouetteCutout')).toBe(true)
    expect(isMaskedKind('silhouetteCutout')).toBe(false)
    expect(TREATMENT_LABELS.silhouetteCutout).toBe('Silhouette cutout')
  })
})

describe('treatments: dashed outline', () => {
  it('createTreatment seeds defaults, enabled and not inverted, with a fresh id', () => {
    expect(createTreatment('dashedOutline')).toMatchObject({
      kind: 'dashedOutline', enabled: true, invert: false, color: '#000000', width: 0.5, dash: 8, gap: 6,
    })
  })
  it('is NOT a ramped kind — no progressive/ramp fields', () => {
    expect(createTreatment('dashedOutline')).not.toHaveProperty('progressive')
    expect(parseTreatment({ id: 'do', kind: 'dashedOutline' })).not.toHaveProperty('rampSpace')
  })
  it('clamps width to 0..1, dash to 1..64, gap to 0..64, keeps/backfills colour', () => {
    expect(parseTreatment({ id: 'do1', kind: 'dashedOutline', width: 9, dash: 999, gap: 999, color: '#abcdef' }))
      .toMatchObject({ width: 1, dash: DASHED_OUTLINE_LEN_MAX, gap: DASHED_OUTLINE_LEN_MAX, color: '#abcdef' })
    expect(parseTreatment({ id: 'do2', kind: 'dashedOutline', width: -3, dash: -5, gap: -5, color: 42 }))
      .toMatchObject({ width: 0, dash: 1, gap: 0, color: '#000000' })
    expect(parseTreatment({ id: 'do3', kind: 'dashedOutline' }))
      .toMatchObject({ color: '#000000', width: 0.5, dash: 8, gap: 6 })
  })
})

describe('treatments: silhouette cutout', () => {
  it('createTreatment seeds defaults, enabled and not inverted, with a fresh id', () => {
    expect(createTreatment('silhouetteCutout')).toMatchObject({
      kind: 'silhouetteCutout', enabled: true, invert: false, color: '#ffffff', border: 0, borderColor: '#000000',
    })
  })
  it('is NOT a ramped kind — no progressive/ramp fields', () => {
    expect(createTreatment('silhouetteCutout')).not.toHaveProperty('progressive')
    expect(parseTreatment({ id: 'sc', kind: 'silhouetteCutout' })).not.toHaveProperty('rampSpace')
  })
  it('clamps border to 0..1, keeps/backfills both colours', () => {
    expect(parseTreatment({ id: 'sc1', kind: 'silhouetteCutout', border: 9, color: '#111111', borderColor: '#222222' }))
      .toMatchObject({ border: 1, color: '#111111', borderColor: '#222222' })
    expect(parseTreatment({ id: 'sc2', kind: 'silhouetteCutout', border: -3, color: 42, borderColor: {} }))
      .toMatchObject({ border: 0, color: '#ffffff', borderColor: '#000000' })
    expect(parseTreatment({ id: 'sc3', kind: 'silhouetteCutout' }))
      .toMatchObject({ color: '#ffffff', border: 0, borderColor: '#000000' })
  })
})

describe('treatments: drop shadow', () => {
  it('createTreatment seeds defaults, enabled and not inverted, with a fresh id', () => {
    expect(createTreatment('dropShadow')).toMatchObject({
      kind: 'dropShadow', enabled: true, invert: false, angle: 45, distance: 16, color: '#000000', softness: 0.2, opacity: 0.5,
    })
  })
  it('is NOT a ramped kind — no progressive/ramp fields', () => {
    expect(createTreatment('dropShadow')).not.toHaveProperty('progressive')
    expect(parseTreatment({ id: 'ds', kind: 'dropShadow' })).not.toHaveProperty('rampSpace')
  })
  it('wraps angle into 0..360, clamps distance to 0..128, softness/opacity to 0..1, backfilling', () => {
    expect(parseTreatment({ id: 'ds1', kind: 'dropShadow', angle: 405, distance: 999, softness: 5, opacity: 5 }))
      .toMatchObject({ angle: 45, distance: 128, softness: 1, opacity: 1 })
    expect(parseTreatment({ id: 'ds2', kind: 'dropShadow', angle: -90, distance: -5, softness: -3, opacity: -3 }))
      .toMatchObject({ angle: 270, distance: 0, softness: 0, opacity: 0 })
    expect(parseTreatment({ id: 'ds3', kind: 'dropShadow' }))
      .toMatchObject({ angle: 45, distance: 16, color: '#000000', softness: 0.2, opacity: 0.5 })
  })
  it('keeps a valid colour and backfills a non-string one', () => {
    expect(parseTreatment({ id: 'ds4', kind: 'dropShadow', color: '#123456' })).toMatchObject({ color: '#123456' })
    expect(parseTreatment({ id: 'ds5', kind: 'dropShadow', color: 42 })).toMatchObject({ color: '#000000' })
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
  it('the gate is true iff a visible host carries an ENABLED buffer treatment (any of them)', () => {
    const bufferKinds = ['edgeLines', 'depthFog', 'curvatureWear', 'crossHatch'] as const
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
  it('createTreatment seeds cross-hatch from its defaults; it is a G-buffer reader, not masked', () => {
    expect(createTreatment('crossHatch')).toMatchObject({ kind: 'crossHatch', enabled: true, invert: false, color: '#000000', spacing: 6, angle: 45, threshold: 0.6 })
    expect(isMaskedKind('crossHatch')).toBe(false)
    expect(isBufferKind('crossHatch')).toBe(true)
    expect(BUFFER_TREATMENT_KINDS).toContain('crossHatch')
  })
  it('parses cross-hatch, clamping spacing to its bounds, angle to 0..360 and threshold to 0..1', () => {
    expect(parseTreatment({ id: 't-h', kind: 'crossHatch', color: '#abcdef', spacing: 999, angle: 400, threshold: 5 }))
      .toMatchObject({ id: 't-h', kind: 'crossHatch', color: '#abcdef', spacing: CROSS_HATCH_SPACING_MAX, angle: 40, threshold: 1 })
    expect(parseTreatment({ id: 't-h2', kind: 'crossHatch', spacing: 0, threshold: -3 }))
      .toMatchObject({ color: '#000000', spacing: CROSS_HATCH_SPACING_MIN, angle: 45, threshold: 0 })
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
    for (const kind of ['rimLight', 'outline', 'xray', 'wireframe', 'dashedOutline', 'silhouetteCutout'] as const) {
      expect(parseTreatment({ id: `t-${kind}`, kind }), kind).not.toHaveProperty('progressive')
    }
  })
})

describe('treatments: opalescence (S5 finish family)', () => {
  it('TREATMENT_KINDS includes opalescence as a FINISH kind — not masked, not edge, not buffer', () => {
    expect(TREATMENT_KINDS).toContain('opalescence')
    expect(FINISH_TREATMENT_KINDS).toContain('opalescence')
    expect(isFinishKind('opalescence')).toBe(true)
    expect(isMaskedKind('opalescence')).toBe(false)
    expect(isEdgeKind('opalescence')).toBe(false)
    expect(isBufferKind('opalescence')).toBe(false)
    expect(TREATMENT_LABELS.opalescence).toBe('Opalescence')
  })

  it('createTreatment seeds defaults, enabled and not inverted, with a fresh id', () => {
    expect(createTreatment('opalescence')).toMatchObject({
      kind: 'opalescence', enabled: true, invert: false, strength: 1, frequency: 1.5, hueShift: 0, angleMix: 0.6,
    })
    expect(createTreatment('opalescence').id).toMatch(/^trt_/)
  })

  it('is NOT a ramped kind — no progressive/ramp fields', () => {
    expect(createTreatment('opalescence')).not.toHaveProperty('progressive')
    expect(parseTreatment({ id: 'op', kind: 'opalescence' })).not.toHaveProperty('rampSpace')
  })

  it('clamps strength/angleMix to 0..1, frequency to 0.5..5, wraps hueShift into 0..360, backfilling', () => {
    expect(parseTreatment({ id: 'op1', kind: 'opalescence', strength: 9, frequency: 99, hueShift: 405, angleMix: -3 }))
      .toMatchObject({ strength: 1, frequency: 5, hueShift: 45, angleMix: 0 })
    expect(parseTreatment({ id: 'op2', kind: 'opalescence', strength: -3, frequency: 0.01, hueShift: -30, angleMix: 9 }))
      .toMatchObject({ strength: 0, frequency: 0.5, hueShift: 330, angleMix: 1 })
    expect(parseTreatment({ id: 'op3', kind: 'opalescence' }))
      .toMatchObject({ strength: 1, frequency: 1.5, hueShift: 0, angleMix: 0.6 })
  })

  it('round-trips through parseTreatments/serialize the same as every other kind', () => {
    const t = createTreatment('opalescence')
    expect(parseTreatments([t])).toEqual([t])
  })

  it('canTakeFinish: primitives only this slice — not GLB, light or group', () => {
    const prim = createPrimitive('box', [])
    const light = createLight('point', [])
    const group = createGroup([])
    expect(canTakeFinish(prim)).toBe(true)
    expect(canTakeFinish(light)).toBe(false)
    expect(canTakeFinish(group)).toBe(false)
  })

  it('finishPlan: enabled finish treatments only, in stack order; empty when none', () => {
    const prim = createPrimitive('box', [])
    expect(finishPlan(prim)).toEqual([])
    expect(finishPlan(null)).toEqual([])
    const opal = createTreatment('opalescence')
    const glow = createTreatment('glow') // masked — must be excluded
    const disabledOpal = { ...createTreatment('opalescence'), enabled: false }
    prim.treatments = [glow, opal, disabledOpal]
    expect(finishPlan(prim)).toEqual([opal])
  })
})

describe('treatments: foil shimmer (S5 finish family, task 2)', () => {
  it('TREATMENT_KINDS includes foilShimmer as a FINISH kind — not masked, not edge, not buffer', () => {
    expect(TREATMENT_KINDS).toContain('foilShimmer')
    expect(FINISH_TREATMENT_KINDS).toContain('foilShimmer')
    expect(isFinishKind('foilShimmer')).toBe(true)
    expect(isMaskedKind('foilShimmer')).toBe(false)
    expect(isEdgeKind('foilShimmer')).toBe(false)
    expect(isBufferKind('foilShimmer')).toBe(false)
    expect(TREATMENT_LABELS.foilShimmer).toBe('Foil shimmer')
  })

  it('TREATMENT_DEFAULTS.foilShimmer is present with the five dials', () => {
    expect(TREATMENT_DEFAULTS.foilShimmer).toEqual({ strength: 1, bands: 3, angle: 0, hueShift: 0, gloss: 0.5 })
  })

  it('createTreatment seeds defaults, enabled and not inverted, with a fresh id', () => {
    expect(createTreatment('foilShimmer')).toMatchObject({
      kind: 'foilShimmer', enabled: true, invert: false, strength: 1, bands: 3, angle: 0, hueShift: 0, gloss: 0.5,
    })
    expect(createTreatment('foilShimmer').id).toMatch(/^trt_/)
  })

  it('is NOT a ramped kind — no progressive/ramp fields', () => {
    expect(createTreatment('foilShimmer')).not.toHaveProperty('progressive')
    expect(parseTreatment({ id: 'fo', kind: 'foilShimmer' })).not.toHaveProperty('rampSpace')
  })

  it('clamps strength to 0..2, bands to 0.5..8, gloss to 0..1, wraps angle/hueShift into 0..360, backfilling', () => {
    expect(parseTreatment({ id: 'fo1', kind: 'foilShimmer', strength: 9, bands: 99, angle: 405, hueShift: 720, gloss: 9 }))
      .toMatchObject({ strength: 2, bands: 8, angle: 45, hueShift: 0, gloss: 1 })
    expect(parseTreatment({ id: 'fo2', kind: 'foilShimmer', strength: -3, bands: 0.01, angle: -30, hueShift: -30, gloss: -3 }))
      .toMatchObject({ strength: 0, bands: 0.5, angle: 330, hueShift: 330, gloss: 0 })
    expect(parseTreatment({ id: 'fo3', kind: 'foilShimmer' }))
      .toMatchObject({ strength: 1, bands: 3, angle: 0, hueShift: 0, gloss: 0.5 })
  })

  it('round-trips through parseTreatments/serialize the same as every other kind', () => {
    const t = createTreatment('foilShimmer')
    expect(parseTreatments([t])).toEqual([t])
  })

  it('a document with only a foilShimmer finish parses/round-trips through serializeDoc/parseDoc', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects)
    box.treatments = [createTreatment('foilShimmer')]
    doc.objects.push(box)
    const back = parseDoc(serializeDoc(doc))
    expect(back.objects.at(-1)!.treatments!.map((t) => t.kind)).toEqual(['foilShimmer'])
    expect(back).toEqual(doc)
  })

  it('canTakeFinish: primitives only this slice — not GLB, light or group', () => {
    const prim = createPrimitive('box', [])
    const light = createLight('point', [])
    const group = createGroup([])
    expect(canTakeFinish(prim)).toBe(true)
    expect(canTakeFinish(light)).toBe(false)
    expect(canTakeFinish(group)).toBe(false)
  })

  it('finishPlan: a foilShimmer treatment is included alongside opalescence, in stack order', () => {
    const prim = createPrimitive('box', [])
    const opal = createTreatment('opalescence')
    const foilShimmer = createTreatment('foilShimmer')
    const glow = createTreatment('glow') // masked — must be excluded
    prim.treatments = [glow, foilShimmer, opal]
    expect(finishPlan(prim)).toEqual([foilShimmer, opal])
  })

  it('has a control row for every dial, group-titled by the human label', () => {
    const rows = treatmentControls('foilShimmer')
    const fields = rows.map((r) => r.key)
    expect(fields).toEqual([
      'treatment.strength', 'treatment.bands', 'treatment.angle', 'treatment.hueShift', 'treatment.gloss',
    ])
    for (const r of rows) expect(r.group).toBe('Foil shimmer')
    // Not masked — no trailing "Everything else" invert toggle.
    expect(fields).not.toContain('treatment.invert')
  })
})

describe('treatments: matcap coat (S5 finish family, task 3)', () => {
  it('TREATMENT_KINDS includes matcapCoat as a FINISH kind — not masked, not edge, not buffer', () => {
    expect(TREATMENT_KINDS).toContain('matcapCoat')
    expect(FINISH_TREATMENT_KINDS).toContain('matcapCoat')
    expect(isFinishKind('matcapCoat')).toBe(true)
    expect(isMaskedKind('matcapCoat')).toBe(false)
    expect(isEdgeKind('matcapCoat')).toBe(false)
    expect(isBufferKind('matcapCoat')).toBe(false)
    expect(TREATMENT_LABELS.matcapCoat).toBe('Matcap coat')
  })

  it('TREATMENT_DEFAULTS.matcapCoat defaults to the first matcap id at full strength', () => {
    expect(TREATMENT_DEFAULTS.matcapCoat).toEqual({ matcap: MATCAP_IDS[0], strength: 1 })
  })

  it('createTreatment seeds defaults, enabled and not inverted, with a fresh id', () => {
    expect(createTreatment('matcapCoat')).toMatchObject({
      kind: 'matcapCoat', enabled: true, invert: false, matcap: MATCAP_IDS[0], strength: 1,
    })
    expect(createTreatment('matcapCoat').id).toMatch(/^trt_/)
  })

  it('is NOT a ramped kind — no progressive/ramp fields', () => {
    expect(createTreatment('matcapCoat')).not.toHaveProperty('progressive')
    expect(parseTreatment({ id: 'mc', kind: 'matcapCoat' })).not.toHaveProperty('rampSpace')
  })

  it('validates matcap against MATCAP_IDS, backfilling an unknown id to the default; clamps strength to 0..1', () => {
    expect(parseTreatment({ id: 'mc1', kind: 'matcapCoat', matcap: 'gold', strength: 9 }))
      .toMatchObject({ matcap: 'gold', strength: 1 })
    expect(parseTreatment({ id: 'mc2', kind: 'matcapCoat', matcap: 'not-a-real-matcap', strength: -3 }))
      .toMatchObject({ matcap: MATCAP_IDS[0], strength: 0 })
    expect(parseTreatment({ id: 'mc3', kind: 'matcapCoat' }))
      .toMatchObject({ matcap: MATCAP_IDS[0], strength: 1 })
    // Every id in the runtime-generated set round-trips unchanged.
    for (const id of MATCAP_IDS) {
      expect(parseTreatment({ id: `mc-${id}`, kind: 'matcapCoat', matcap: id })).toMatchObject({ matcap: id })
    }
  })

  it('round-trips through parseTreatments/serialize the same as every other kind', () => {
    const t = createTreatment('matcapCoat')
    expect(parseTreatments([t])).toEqual([t])
  })

  it('a document with only a matcapCoat finish parses/round-trips through serializeDoc/parseDoc', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects)
    box.treatments = [createTreatment('matcapCoat')]
    doc.objects.push(box)
    const back = parseDoc(serializeDoc(doc))
    expect(back.objects.at(-1)!.treatments!.map((t) => t.kind)).toEqual(['matcapCoat'])
    expect(back).toEqual(doc)
  })

  it('canTakeFinish: primitives only this slice — not GLB, light or group', () => {
    const prim = createPrimitive('box', [])
    const light = createLight('point', [])
    const group = createGroup([])
    expect(canTakeFinish(prim)).toBe(true)
    expect(canTakeFinish(light)).toBe(false)
    expect(canTakeFinish(group)).toBe(false)
  })

  it('finishPlan: a matcapCoat treatment is included alongside opalescence/foilShimmer, in stack order', () => {
    const prim = createPrimitive('box', [])
    const opal = createTreatment('opalescence')
    const matcap = createTreatment('matcapCoat')
    const glow = createTreatment('glow') // masked — must be excluded
    prim.treatments = [glow, matcap, opal]
    expect(finishPlan(prim)).toEqual([matcap, opal])
  })

  it('has a control row for every dial, group-titled by the human label — a select over MATCAP_IDS plus a strength slider', () => {
    const rows = treatmentControls('matcapCoat')
    const fields = rows.map((r) => r.key)
    expect(fields).toEqual(['treatment.matcap', 'treatment.strength'])
    for (const r of rows) expect(r.group).toBe('Matcap coat')
    // Not masked — no trailing "Everything else" invert toggle.
    expect(fields).not.toContain('treatment.invert')
    const matcapRow = rows[0]!
    expect(matcapRow.kind).toBe('select')
    expect((matcapRow as { options?: string[] }).options).toEqual(MATCAP_IDS)
    // optionLabels is mandatory on every select in this file (no raw internal values in copy).
    const optionLabels = (matcapRow as { optionLabels?: string[] }).optionLabels
    expect(optionLabels).toBeDefined()
    expect(optionLabels).toHaveLength(MATCAP_IDS.length)
    for (const label of optionLabels!) expect(label).toMatch(/^[A-Z]/)
  })
})

describe('treatments: finish add-menu is never a dead control on a non-primitive host (S5 task 4)', () => {
  // The three earlier finish describe blocks already prove canTakeFinish is false for a light
  // and a group; this fills the gap the plan calls out specifically — a GLB host, which (unlike
  // light/group) IS a general treatment host (isTreatmentHost) and so DOES reach the add-menu,
  // just not for finishes (materialFor/updateMaterial — the only build path a finish is wired
  // through this slice — is the primitive path; syncGlbMaterials has no finish path yet).
  it('canTakeFinish is false for a GLB host, true for a primitive', () => {
    const prim = createPrimitive('box', [])
    const glb = createGlbObject('https://example.com/model.glb', [])
    expect(glb.kind).toBe('glb')
    expect(canTakeFinish(prim)).toBe(true)
    expect(canTakeFinish(glb)).toBe(false)
  })

  // Mirrors Scene3DObjectRow.vue's `finishDisabled = (kind) => isFinishKind(kind) && !canTakeFinish(obj)`
  // verbatim, so a change to either half of that predicate breaks this test rather than a live
  // Playwright interaction test (the plan accepts a unit here). A wrong `canTakeFinish` that
  // always returned true would make every assertion in the first loop fail (nothing would be
  // disabled), and a wrong `isFinishKind` that matched too broadly would make the second loop's
  // masked/edge/buffer assertions fail — the test cannot pass by accident either way.
  it('the add-menu disable predicate disables exactly the three finish kinds on a GLB, and none of masked/edge/buffer', () => {
    const glb = createGlbObject('https://example.com/model.glb', [])
    const finishDisabled = (kind: string): boolean => isFinishKind(kind) && !canTakeFinish(glb)
    for (const kind of FINISH_TREATMENT_KINDS) expect(finishDisabled(kind)).toBe(true)
    for (const kind of [...MASKED_TREATMENT_KINDS, ...EDGE_TREATMENT_KINDS, ...BUFFER_TREATMENT_KINDS]) {
      expect(finishDisabled(kind)).toBe(false)
    }
    // Every TREATMENT_KINDS entry is accounted for by exactly one of the two groups above.
    expect(TREATMENT_KINDS.filter((k) => finishDisabled(k))).toEqual([...FINISH_TREATMENT_KINDS])
  })

  it('the same predicate does NOT disable any finish kind on a primitive host', () => {
    const prim = createPrimitive('box', [])
    const finishDisabled = (kind: string): boolean => isFinishKind(kind) && !canTakeFinish(prim)
    for (const kind of FINISH_TREATMENT_KINDS) expect(finishDisabled(kind)).toBe(false)
  })
})

describe('treatments: motion family (S6 velocity blur / ghost trails)', () => {
  it('TREATMENT_KINDS includes both motion kinds — not masked, edge, buffer or finish', () => {
    for (const kind of ['velocityBlur', 'ghostTrails'] as const) {
      expect(TREATMENT_KINDS).toContain(kind)
      expect(MOTION_TREATMENT_KINDS).toContain(kind)
      expect(isMotionKind(kind)).toBe(true)
      expect(isMaskedKind(kind)).toBe(false)
      expect(isEdgeKind(kind)).toBe(false)
      expect(isBufferKind(kind)).toBe(false)
      expect(isFinishKind(kind)).toBe(false)
    }
    expect(TREATMENT_LABELS.velocityBlur).toBe('Velocity blur')
    expect(TREATMENT_LABELS.ghostTrails).toBe('Ghost trails')
  })

  it('createTreatment seeds both kinds from TREATMENT_DEFAULTS, enabled and not inverted', () => {
    expect(createTreatment('velocityBlur')).toMatchObject({ kind: 'velocityBlur', enabled: true, invert: false, amount: 1, shutter: 0.5 })
    expect(createTreatment('ghostTrails')).toMatchObject({ kind: 'ghostTrails', enabled: true, invert: false, count: 3, spacing: 2, fade: 0.5 })
    expect(createTreatment('velocityBlur').id).toMatch(/^trt_/)
  })

  it('neither kind is ramped — no progressive/ramp fields', () => {
    expect(createTreatment('velocityBlur')).not.toHaveProperty('progressive')
    expect(parseTreatment({ id: 'vb', kind: 'velocityBlur' })).not.toHaveProperty('rampSpace')
    expect(createTreatment('ghostTrails')).not.toHaveProperty('progressive')
    expect(parseTreatment({ id: 'gt', kind: 'ghostTrails' })).not.toHaveProperty('rampSpace')
  })

  it('parses velocityBlur, clamping amount to 0..VELOCITY_BLUR_AMOUNT_MAX and shutter to 0..1', () => {
    expect(parseTreatment({ id: 'vb1', kind: 'velocityBlur', amount: 99, shutter: 9 }))
      .toMatchObject({ amount: VELOCITY_BLUR_AMOUNT_MAX, shutter: 1 })
    expect(parseTreatment({ id: 'vb2', kind: 'velocityBlur', amount: -5, shutter: -5 }))
      .toMatchObject({ amount: 0, shutter: 0 })
    expect(parseTreatment({ id: 'vb3', kind: 'velocityBlur' }))
      .toMatchObject({ amount: 1, shutter: 0.5 })
  })

  it('parses ghostTrails, rounding/clamping count to 1..GHOST_COUNT_MAX, spacing to 1..GHOST_SPACING_MAX, fade to 0..1', () => {
    expect(parseTreatment({ id: 'gt1', kind: 'ghostTrails', count: 99, spacing: 99, fade: 9 }))
      .toMatchObject({ count: GHOST_COUNT_MAX, spacing: GHOST_SPACING_MAX, fade: 1 })
    expect(parseTreatment({ id: 'gt2', kind: 'ghostTrails', count: 0, spacing: 0, fade: -5 }))
      .toMatchObject({ count: 1, spacing: 1, fade: 0 })
    expect(parseTreatment({ id: 'gt3', kind: 'ghostTrails', count: 4.6 }))
      .toMatchObject({ count: 5, spacing: 2, fade: 0.5 })
    expect(parseTreatment({ id: 'gt4', kind: 'ghostTrails' }))
      .toMatchObject({ count: 3, spacing: 2, fade: 0.5 })
  })

  it('round-trips both kinds through parseTreatments the same as every other kind', () => {
    for (const kind of ['velocityBlur', 'ghostTrails'] as const) {
      const t = createTreatment(kind)
      expect(parseTreatments([t])).toEqual([t])
    }
  })

  it('a document with only a motion treatment round-trips through serializeDoc/parseDoc', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects)
    box.treatments = [createTreatment('velocityBlur'), createTreatment('ghostTrails')]
    doc.objects.push(box)
    const back = parseDoc(serializeDoc(doc))
    expect(back.objects.at(-1)!.treatments!.map((t) => t.kind)).toEqual(['velocityBlur', 'ghostTrails'])
    expect(back).toEqual(doc)
  })

  it('motionTreatmentPlan / docHasMotionTreatment: the byte-identity gate', () => {
    // No motion treatment ⇒ empty plan, gate off (a masked treatment must not trip it).
    const bare = defaultDoc()
    const b0 = createPrimitive('box', bare.objects); b0.treatments = [createTreatment('blur')]; bare.objects.push(b0)
    expect(docHasMotionTreatment(bare)).toBe(false)
    expect(motionTreatmentPlan(bare)).toEqual([])

    for (const kind of ['velocityBlur', 'ghostTrails'] as const) {
      const doc = defaultDoc()
      const box = createPrimitive('box', doc.objects); box.treatments = [createTreatment(kind)]; doc.objects.push(box)
      expect(docHasMotionTreatment(doc), kind).toBe(true)
      expect(motionTreatmentPlan(doc).map((g) => g.objectId), kind).toEqual([box.id])
      // Disabled ⇒ no plan, no gate — the byte-identity guarantee.
      box.treatments = [{ ...createTreatment(kind), enabled: false }]
      expect(docHasMotionTreatment(doc), `${kind} disabled`).toBe(false)
      // Hidden host ⇒ excluded even when enabled.
      box.treatments = [createTreatment(kind)]; box.visible = false
      expect(docHasMotionTreatment(doc), `${kind} hidden`).toBe(false)
    }
  })

  it('caps the motion plan at TREATED_OBJECT_CAP groups', () => {
    const doc = defaultDoc()
    for (let i = 0; i < TREATED_OBJECT_CAP + 2; i++) {
      const o = createPrimitive('sphere', doc.objects)
      o.treatments = [createTreatment('velocityBlur')]
      doc.objects.push(o)
    }
    expect(motionTreatmentPlan(doc)).toHaveLength(TREATED_OBJECT_CAP)
  })

  it('has a control row for each dial, group-titled by the human label, with no invert row', () => {
    expect(treatmentControls('velocityBlur').map((r) => r.key)).toEqual(['treatment.amount', 'treatment.shutter'])
    expect(treatmentControls('ghostTrails').map((r) => r.key)).toEqual(['treatment.count', 'treatment.spacing', 'treatment.fade'])
    for (const r of treatmentControls('velocityBlur')) expect(r.group).toBe('Velocity blur')
    for (const r of treatmentControls('ghostTrails')) expect(r.group).toBe('Ghost trails')
    expect(treatmentControls('velocityBlur').map((r) => r.key)).not.toContain('treatment.invert')
    expect(treatmentControls('ghostTrails').map((r) => r.key)).not.toContain('treatment.invert')
  })
})

describe('treatments: AI restyle family (S7)', () => {
  it('TREATMENT_KINDS includes aiRestyle — its own family, not masked/edge/buffer/finish/motion', () => {
    expect(TREATMENT_KINDS).toContain('aiRestyle')
    expect(RESTYLE_TREATMENT_KINDS).toContain('aiRestyle')
    expect(isRestyleKind('aiRestyle')).toBe(true)
    expect(isMaskedKind('aiRestyle')).toBe(false)
    expect(isEdgeKind('aiRestyle')).toBe(false)
    expect(isBufferKind('aiRestyle')).toBe(false)
    expect(isFinishKind('aiRestyle')).toBe(false)
    expect(isMotionKind('aiRestyle')).toBe(false)
    expect(TREATMENT_LABELS.aiRestyle).toBe('AI restyle')
  })

  it('createTreatment seeds aiRestyle from TREATMENT_DEFAULTS; model defaults to RESTYLE_MODELS[0]', () => {
    const t = createTreatment('aiRestyle')
    expect(t).toMatchObject({ kind: 'aiRestyle', enabled: true, invert: false, prompt: '', strength: 0.6, mix: 1, resultRef: '', inputHash: '' })
    expect((t as any).model).toBe(RESTYLE_MODELS[0]!.id)
    expect(t.id).toMatch(/^trt_/)
  })

  it('TREATMENT_DEFAULTS.aiRestyle.model matches RESTYLE_MODELS[0].id (no literal drift)', () => {
    expect((TREATMENT_DEFAULTS.aiRestyle as { model: string }).model).toBe(RESTYLE_MODELS[0]!.id)
  })

  it('not ramped — no progressive/ramp fields', () => {
    expect(createTreatment('aiRestyle')).not.toHaveProperty('progressive')
    expect(parseTreatment({ id: 'ar', kind: 'aiRestyle' })).not.toHaveProperty('rampSpace')
  })

  it('parses aiRestyle: allows empty prompt, clamps strength/mix to 0..1, validates model against RESTYLE_MODELS', () => {
    expect(parseTreatment({ id: 'ar1', kind: 'aiRestyle', prompt: 'a bronze statue', strength: 9, mix: 9, model: RESTYLE_MODELS[1]!.id }))
      .toMatchObject({ prompt: 'a bronze statue', strength: RESTYLE_STRENGTH_MAX, mix: 1, model: RESTYLE_MODELS[1]!.id })
    expect(parseTreatment({ id: 'ar2', kind: 'aiRestyle', strength: -5, mix: -5, model: 'not-a-real-model' }))
      .toMatchObject({ strength: 0, mix: 0, model: RESTYLE_MODELS[0]!.id })
    expect(parseTreatment({ id: 'ar3', kind: 'aiRestyle' }))
      .toMatchObject({ prompt: '', strength: 0.6, mix: 1, model: RESTYLE_MODELS[0]!.id })
  })

  it('PRESERVES resultRef/inputHash through parse; a non-string backfills to empty', () => {
    expect(parseTreatment({ id: 'ar4', kind: 'aiRestyle', resultRef: 'restyle-abc.png', inputHash: 'h123' }))
      .toMatchObject({ resultRef: 'restyle-abc.png', inputHash: 'h123' })
    expect(parseTreatment({ id: 'ar5', kind: 'aiRestyle', resultRef: 42, inputHash: {} }))
      .toMatchObject({ resultRef: '', inputHash: '' })
  })

  it('aiRestyle defaults styleId to "" and round-trips a stored id; coerces a non-string to ""', () => {
    expect(createTreatment('aiRestyle')).toMatchObject({ styleId: '' })
    expect(parseTreatment({ id: 'r0', kind: 'aiRestyle' })).toMatchObject({ styleId: '' })
    expect(parseTreatment({ id: 'r1', kind: 'aiRestyle', styleId: 'warm-editorial' })).toMatchObject({ styleId: 'warm-editorial' })
    expect(parseTreatment({ id: 'r2', kind: 'aiRestyle', styleId: 42 })).toMatchObject({ styleId: '' })
  })

  it('parses the S7.1 projector metadata: round-trips valid arrays, collapses bad ones to []', () => {
    const vp = Array.from({ length: 16 }, (_, i) => i * 0.5)
    const good = parseTreatment({
      id: 'arp1', kind: 'aiRestyle',
      projViewProj: vp, projRect: [10, 20, 100, 120], projSize: [512, 512], projForward: [0, 0, -1],
    }) as AiRestyleTreatment
    expect(good.projViewProj).toEqual(vp)
    expect(good.projRect).toEqual([10, 20, 100, 120])
    expect(good.projSize).toEqual([512, 512])
    expect(good.projForward).toEqual([0, 0, -1])

    // absent => []
    expect(parseTreatment({ id: 'arp2', kind: 'aiRestyle' }) as AiRestyleTreatment)
      .toMatchObject({ projViewProj: [], projRect: [], projSize: [], projForward: [] })

    // wrong length => []
    expect(parseTreatment({ id: 'arp3', kind: 'aiRestyle', projViewProj: vp.slice(0, 15), projRect: [1, 2, 3], projSize: [1], projForward: [1, 2] }) as AiRestyleTreatment)
      .toMatchObject({ projViewProj: [], projRect: [], projSize: [], projForward: [] })

    // NaN / Infinity / non-number element => []
    expect(parseTreatment({
      id: 'arp4', kind: 'aiRestyle',
      projViewProj: vp.map((_, i) => (i === 0 ? NaN : 1)),
      projRect: [1, 2, Infinity, 4],
      projSize: ['a', 2] as unknown as number[],
      projForward: [1, 2, '3'] as unknown as number[],
    }) as AiRestyleTreatment)
      .toMatchObject({ projViewProj: [], projRect: [], projSize: [], projForward: [] })
  })

  it('serializeDoc/parseDoc preserves the S7.1 projector metadata', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects)
    const vp = Array.from({ length: 16 }, (_, i) => i + 1)
    box.treatments = [{
      ...createTreatment('aiRestyle'), resultRef: 'r.png', inputHash: 'h',
      projViewProj: vp, projRect: [1, 2, 3, 4], projSize: [640, 480], projForward: [0, 1, 0],
    }]
    doc.objects.push(box)
    const back = parseDoc(serializeDoc(doc))
    expect((back.objects.at(-1)!.treatments![0] as AiRestyleTreatment).projViewProj).toEqual(vp)
    expect(back).toEqual(doc)
  })

  it('round-trips through parseTreatments incl. resultRef/inputHash', () => {
    const t = { ...createTreatment('aiRestyle'), prompt: 'chrome', strength: 0.4, mix: 0.8, resultRef: 'r.png', inputHash: 'h' }
    expect(parseTreatments([t])).toEqual([t])
  })

  it('a document with only an aiRestyle treatment round-trips through serializeDoc/parseDoc', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects)
    box.treatments = [{ ...createTreatment('aiRestyle'), resultRef: 'r.png', inputHash: 'h' }]
    doc.objects.push(box)
    const back = parseDoc(serializeDoc(doc))
    expect(back.objects.at(-1)!.treatments!.map((t) => t.kind)).toEqual(['aiRestyle'])
    expect(back).toEqual(doc)
  })

  it('restyleTreatmentPlan / docHasRestyleTreatment: the byte-identity gate', () => {
    // A masked treatment must not trip the restyle gate.
    const bare = defaultDoc()
    const b0 = createPrimitive('box', bare.objects); b0.treatments = [createTreatment('blur')]; bare.objects.push(b0)
    expect(docHasRestyleTreatment(bare)).toBe(false)
    expect(restyleTreatmentPlan(bare)).toEqual([])

    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects); box.treatments = [createTreatment('aiRestyle')]; doc.objects.push(box)
    expect(docHasRestyleTreatment(doc)).toBe(true)
    expect(restyleTreatmentPlan(doc).map((g) => g.objectId)).toEqual([box.id])
    // Disabled ⇒ not in plan (byte-identity).
    box.treatments = [{ ...createTreatment('aiRestyle'), enabled: false }]
    expect(docHasRestyleTreatment(doc)).toBe(false)
    // Hidden host ⇒ excluded even when enabled.
    box.treatments = [createTreatment('aiRestyle')]; box.visible = false
    expect(docHasRestyleTreatment(doc)).toBe(false)
  })

  it('caps the restyle plan at TREATED_OBJECT_CAP groups', () => {
    const doc = defaultDoc()
    for (let i = 0; i < TREATED_OBJECT_CAP + 2; i++) {
      const o = createPrimitive('sphere', doc.objects)
      o.treatments = [createTreatment('aiRestyle')]
      doc.objects.push(o)
    }
    expect(restyleTreatmentPlan(doc)).toHaveLength(TREATED_OBJECT_CAP)
  })

  it('has control rows: prompt (text), model (select), strength + mix sliders; no invert row', () => {
    const rows = treatmentControls('aiRestyle')
    expect(rows.map((r) => r.key)).toEqual(['treatment.prompt', 'treatment.model', 'treatment.strength', 'treatment.mix'])
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]))
    expect(byKey['treatment.prompt']!.kind).toBe('text')
    expect(byKey['treatment.model']!.kind).toBe('select')
    // Only user-selectable models reach the dropdown; the route-internal depth+style model
    // (fal-ai/flux-general, selectable:false) is chosen by the route, never offered as a pick.
    const selectableModels = RESTYLE_MODELS.filter((m) => m.selectable !== false)
    expect((byKey['treatment.model'] as { options: string[] }).options).toEqual(selectableModels.map((m) => m.id))
    expect((byKey['treatment.model'] as { optionLabels: string[] }).optionLabels).toEqual(selectableModels.map((m) => m.label))
    expect(byKey['treatment.strength']!.kind).toBe('slider')
    expect(byKey['treatment.mix']!.kind).toBe('slider')
    for (const r of rows) expect(r.group).toBe('AI restyle')
    expect(rows.map((r) => r.key)).not.toContain('treatment.invert')
  })
})
