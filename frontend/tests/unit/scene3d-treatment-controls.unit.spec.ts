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

// S6 · the motion family (velocityBlur, ghostTrails). These are NOT masked and NOT ramped,
// so treatmentControls(kind) must yield ONLY their own dials — no "Everything else" invert row
// (the copy-sweep guard: an invert row here would read as a dead, meaningless control) and no
// ramp rows. Every dial maps to a real field the stage reads (Tasks 2/3), which the generic
// "row key is treatment.<field> … with the same default" test above already proves for all kinds;
// this pins the exact row set, ranges and human hints so a copy or control-shape regression fails.
describe('motion-family treatment rows (velocityBlur, ghostTrails)', () => {
  it('velocityBlur offers exactly Amount + Shutter — no invert, no ramp', () => {
    const rows = treatmentControls('velocityBlur')
    expect(rows.map((r) => r.key)).toEqual(['treatment.amount', 'treatment.shutter'])
    expect(rows.every((r) => r.group === 'Velocity blur')).toBe(true)
    expect(rows.find((r) => r.key === 'treatment.amount')).toMatchObject({
      kind: 'slider', label: 'Amount', min: 0, max: 3, default: TREATMENT_DEFAULTS.velocityBlur.amount,
      hint: 'How strong the motion smear is',
    })
    expect(rows.find((r) => r.key === 'treatment.shutter')).toMatchObject({
      kind: 'slider', label: 'Shutter', min: 0, max: 1, default: TREATMENT_DEFAULTS.velocityBlur.shutter,
      hint: 'How much of the movement each frame captures',
    })
  })

  it('ghostTrails offers exactly Trails + Spacing + Fade — no invert, no ramp', () => {
    const rows = treatmentControls('ghostTrails')
    expect(rows.map((r) => r.key)).toEqual(['treatment.count', 'treatment.spacing', 'treatment.fade'])
    expect(rows.every((r) => r.group === 'Ghost trails')).toBe(true)
    expect(rows.find((r) => r.key === 'treatment.count')).toMatchObject({
      kind: 'slider', label: 'Copies', min: 1, max: 8, default: TREATMENT_DEFAULTS.ghostTrails.count,
      hint: 'How many faded copies trail behind',
    })
    expect(rows.find((r) => r.key === 'treatment.spacing')).toMatchObject({
      kind: 'slider', label: 'Spacing', min: 1, max: 12, default: TREATMENT_DEFAULTS.ghostTrails.spacing,
      hint: 'How far apart the copies are, in frames',
    })
    expect(rows.find((r) => r.key === 'treatment.fade')).toMatchObject({
      kind: 'slider', label: 'Fade', min: 0, max: 1, default: TREATMENT_DEFAULTS.ghostTrails.fade,
      hint: 'How quickly the copies fade out',
    })
  })

  it('neither motion kind is masked, so neither renders the "Everything else" row', () => {
    for (const kind of ['velocityBlur', 'ghostTrails'] as const) {
      expect(isMaskedKind(kind), kind).toBe(false)
      expect(treatmentControls(kind).some((r) => r.key === 'treatment.invert'), kind).toBe(false)
    }
  })

  it('every motion-family label is sentence case and carries a human hint', () => {
    for (const kind of ['velocityBlur', 'ghostTrails'] as const) {
      for (const row of treatmentControls(kind)) {
        expect(row.label, row.key).toMatch(/^[A-Z]/)
        // No raw identifier leaked as a label, and every numeric dial explains itself.
        expect(row.label, row.key).not.toMatch(/[._]/)
        expect(typeof (row as { hint?: string }).hint, `${kind}.${row.key} hint`).toBe('string')
      }
    }
  })
})

// S7 · the restyle family (aiRestyle). NOT masked and NOT ramped, so treatmentControls('aiRestyle')
// must yield ONLY its own rows — prompt (text), model (select), strength + mix (sliders) — with no
// "Everything else" invert row (a dead control here) and no ramp rows. resultRef/inputHash are not
// rows at all (they hold the cached result, not a user dial). The generic "row key is
// treatment.<field> … with the same default" test above already proves every row maps to a real
// field; this pins the exact row set, kinds, ranges and human hints so a copy or control-shape
// regression fails, exactly like the S6 ghostTrails block.
describe('restyle-family treatment rows (aiRestyle)', () => {
  it('offers exactly Prompt + Model + Strength + Mix — no invert, no ramp', () => {
    const rows = treatmentControls('aiRestyle')
    expect(rows.map((r) => r.key)).toEqual([
      'treatment.prompt', 'treatment.model', 'treatment.strength', 'treatment.mix',
    ])
    expect(rows.every((r) => r.group === 'AI restyle')).toBe(true)
  })

  it('prompt is a text row, model a labelled select, strength + mix sliders with human hints', () => {
    const rows = treatmentControls('aiRestyle')
    expect(rows.find((r) => r.key === 'treatment.prompt')).toMatchObject({
      kind: 'text', label: 'Prompt', default: TREATMENT_DEFAULTS.aiRestyle.prompt,
      hint: 'Describe the new look, then use the restyle button',
    })
    const model = rows.find((r) => r.key === 'treatment.model') as any
    expect(model.kind).toBe('select')
    expect(model.label).toBe('Model')
    expect(model.default).toBe(TREATMENT_DEFAULTS.aiRestyle.model)
    // A select never shows its stored ids raw — every option carries a human label.
    expect(Array.isArray(model.options)).toBe(true)
    expect(model.options.length).toBeGreaterThan(0)
    expect(model.optionLabels).toHaveLength(model.options.length)
    expect(model.options).toContain(TREATMENT_DEFAULTS.aiRestyle.model)
    expect(rows.find((r) => r.key === 'treatment.strength')).toMatchObject({
      kind: 'slider', label: 'Strength', min: 0, max: 1, default: TREATMENT_DEFAULTS.aiRestyle.strength,
      hint: 'How far the restyle departs from the original',
    })
    expect(rows.find((r) => r.key === 'treatment.mix')).toMatchObject({
      kind: 'slider', label: 'Mix', min: 0, max: 1, default: TREATMENT_DEFAULTS.aiRestyle.mix,
      hint: 'Blend the result over the original — changing this is free',
    })
  })

  it('is not masked, so it never renders the "Everything else" row', () => {
    expect(isMaskedKind('aiRestyle')).toBe(false)
    expect(treatmentControls('aiRestyle').some((r) => r.key === 'treatment.invert')).toBe(false)
  })

  it('every label is sentence case, leaks no raw identifier, and carries a human hint on the dials', () => {
    for (const row of treatmentControls('aiRestyle')) {
      expect(row.label, row.key).toMatch(/^[A-Z]/)
      expect(row.label, row.key).not.toMatch(/[._]/)
    }
    // The prompt/strength/mix rows each explain themselves; the select's options are self-describing.
    for (const key of ['treatment.prompt', 'treatment.strength', 'treatment.mix']) {
      const row = treatmentControls('aiRestyle').find((r) => r.key === key)!
      expect(typeof (row as { hint?: string }).hint, `${key} hint`).toBe('string')
    }
  })

  it('the Model select lists only selectable models (not the route-internal depth+style)', () => {
    const rows = treatmentControls('aiRestyle')
    const model = rows.find((r) => r.key.endsWith('model')) as any
    expect(model.options).toEqual(['fal-ai/flux-control-lora-depth', 'fal-ai/flux/dev/image-to-image'])
    expect(model.options).not.toContain('fal-ai/flux-general')
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
    for (const kind of ['rimLight', 'outline', 'xray', 'wireframe', 'dashedOutline', 'silhouetteCutout'] as const) {
      const keys = treatmentControls(kind).map((r) => r.key)
      expect(keys.filter((k) => RAMP_KEYS.includes(k)), kind).toEqual([])
    }
  })
})
