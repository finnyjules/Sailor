import { describe, it, expect } from 'vitest'
import { defaultDoc, createPrimitive, createLight, serializeDoc, parseDoc } from '~/lib/scene3d/config'
import {
  TREATMENT_KINDS, TREATMENT_LABELS, TREATED_OBJECT_CAP, createTreatment, parseTreatment, parseTreatments,
  cloneTreatments, maskedTreatmentPlan, unrenderedTreatmentIds, findTreatment, edgeTreatmentsOf, isMaskedKind, BLUR_AMOUNT_MAX,
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
