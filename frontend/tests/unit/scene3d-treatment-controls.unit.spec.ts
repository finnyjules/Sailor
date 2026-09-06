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
