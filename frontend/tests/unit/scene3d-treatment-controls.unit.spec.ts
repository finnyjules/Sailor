import { describe, it, expect } from 'vitest'
import { TREATMENT_KINDS, TREATMENT_LABELS, TREATMENT_DEFAULTS, createTreatment, isMaskedKind } from '~/lib/scene3d/treatments'
import { treatmentControls, treatmentField, TREATMENT_KEY_PREFIX } from '~/lib/scene3d/treatmentControls'

describe('treatmentControls', () => {
  it('every kind yields at least one row, all in ONE group named with the kind\'s human label', () => {
    for (const kind of TREATMENT_KINDS) {
      const rows = treatmentControls(kind)
      expect(rows.length, kind).toBeGreaterThan(0)
      expect(new Set(rows.map((r) => r.group)), kind).toEqual(new Set([TREATMENT_LABELS[kind]]))
    }
  })
  it('every row key is treatment.<field> for a field that exists on a fresh treatment of that kind, with the same default', () => {
    for (const kind of TREATMENT_KINDS) {
      const fresh = createTreatment(kind) as unknown as Record<string, unknown>
      for (const row of treatmentControls(kind)) {
        expect(row.key.startsWith(TREATMENT_KEY_PREFIX), row.key).toBe(true)
        const field = treatmentField(row.key)
        expect(field in fresh, `${kind}.${field}`).toBe(true)
        expect(row.default, `${kind}.${field}`).toEqual(fresh[field])
      }
    }
  })
  it('masked kinds end with the "Everything else" switch; edge kinds never offer it', () => {
    for (const kind of TREATMENT_KINDS) {
      const rows = treatmentControls(kind)
      const invert = rows.find((r) => r.key === 'treatment.invert')
      if (isMaskedKind(kind)) {
        expect(invert, kind).toMatchObject({ kind: 'switch', label: 'Everything else', default: false })
        expect(rows[rows.length - 1]!.key).toBe('treatment.invert')
      } else {
        expect(invert, kind).toBeUndefined()
      }
    }
  })
  it('labels are sentence case and colour rows are colour kind', () => {
    for (const kind of TREATMENT_KINDS) for (const row of treatmentControls(kind)) {
      expect(row.label, row.key).toMatch(/^[A-Z]/)
      if (/color|tint/i.test(row.key)) expect(row.kind, row.key).toBe('color')
    }
    expect(treatmentControls('wireframe').find((r) => r.key === 'treatment.showSurface')).toMatchObject({ kind: 'switch', default: TREATMENT_DEFAULTS.wireframe.showSurface })
  })
  it('rows are never Collection-bindable (the panel would draw a dead variable glyph)', () => {
    for (const kind of TREATMENT_KINDS) for (const row of treatmentControls(kind)) expect((row as any).bindable, row.key).toBe(false)
  })
})

describe('progressive blur rows', () => {
  const rows = () => treatmentControls('blur')

  it('offers the ramp controls after Amount', () => {
    const keys = rows().map((r) => r.key)
    expect(keys).toEqual([
      'treatment.amount', 'treatment.progressive', 'treatment.rampSpace',
      'treatment.rampAngle', 'treatment.rampStart', 'treatment.rampEnd', 'treatment.invert',
    ])
  })

  it('hides every ramp row behind the Progressive switch', () => {
    const gated = rows().filter((r) => r.showIf?.key === 'treatment.progressive')
    expect(gated.map((r) => r.key)).toEqual([
      'treatment.rampSpace', 'treatment.rampAngle', 'treatment.rampStart', 'treatment.rampEnd',
    ])
    for (const r of gated) expect(r.showIf).toMatchObject({ equals: true })
  })

  it('labels the ramp space options instead of showing the stored values', () => {
    const row = rows().find((r) => r.key === 'treatment.rampSpace')
    expect(row).toMatchObject({ kind: 'select', options: ['object', 'frame'] })
    expect((row as { optionLabels?: string[] }).optionLabels).toEqual(['The object', 'The whole frame'])
  })

  it('sweeps the angle over a full turn', () => {
    expect(rows().find((r) => r.key === 'treatment.rampAngle')).toMatchObject({
      kind: 'slider', min: 0, max: 360, default: 90,
    })
  })
})

describe('the shared ramp rows', () => {
  const RAMP_KEYS = [
    'treatment.progressive', 'treatment.rampSpace',
    'treatment.rampAngle', 'treatment.rampStart', 'treatment.rampEnd',
  ]

  it('every masked kind offers the ramp rows, in the same order', () => {
    for (const kind of ['blur', 'glow', 'pixelate', 'fade'] as const) {
      const keys = treatmentControls(kind).map((r) => r.key)
      const ramp = keys.filter((k) => RAMP_KEYS.includes(k))
      expect(ramp, kind).toEqual(RAMP_KEYS)
      // the ramp sits after the effect's own dials and before "Everything else"
      expect(keys.indexOf('treatment.invert'), kind).toBeGreaterThan(keys.indexOf('treatment.rampEnd'))
    }
  })

  it('gates the four ramp rows behind Progressive on every kind', () => {
    for (const kind of ['blur', 'glow', 'pixelate', 'fade'] as const) {
      const gated = treatmentControls(kind).filter((r) => r.showIf?.key === 'treatment.progressive')
      expect(gated.map((r) => r.key), kind).toEqual(RAMP_KEYS.slice(1))
      for (const r of gated) expect(r.showIf, kind).toMatchObject({ equals: true })
    }
  })

  it('labels the ramp space options on every kind', () => {
    for (const kind of ['blur', 'glow', 'pixelate', 'fade'] as const) {
      const row = treatmentControls(kind).find((r) => r.key === 'treatment.rampSpace')
      expect(row, kind).toMatchObject({ kind: 'select', options: ['object', 'frame'] })
      expect((row as { optionLabels?: string[] }).optionLabels, kind).toEqual(['The object', 'The whole frame'])
    }
  })

  it('the edge kinds have no ramp rows', () => {
    for (const kind of ['rimLight', 'outline', 'xray', 'wireframe'] as const) {
      const keys = treatmentControls(kind).map((r) => r.key)
      expect(keys.filter((k) => RAMP_KEYS.includes(k)), kind).toEqual([])
    }
  })
})
