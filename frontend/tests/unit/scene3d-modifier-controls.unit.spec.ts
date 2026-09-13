import { describe, it, expect } from 'vitest'
import { modifierControls, modifierField, MODIFIER_KEY_PREFIX } from '~/lib/scene3d/modifierControls'
import {
  MODIFIER_KINDS, MODIFIER_KIND_PARAMS, MODIFIER_LABELS, createModifier, type ModifierKind,
} from '~/lib/scene3d/modifierStack'
import { MODIFIER_SPECS } from '~/lib/scene3d/primParams'

const specOf = (key: string) => MODIFIER_SPECS.find((s) => s.key === key)!

describe('modifierControls', () => {
  it('every kind yields one row per owned param, in the SAME order, all under the kind label', () => {
    for (const kind of MODIFIER_KINDS) {
      const rows = modifierControls(kind)
      expect(rows.map((r) => modifierField(r.key)), kind).toEqual(MODIFIER_KIND_PARAMS[kind])
      expect(new Set(rows.map((r) => r.group)), kind).toEqual(new Set([MODIFIER_LABELS[kind]]))
    }
  })

  it('every row key is modifier.<field> for a field a fresh instance of that kind carries', () => {
    for (const kind of MODIFIER_KINDS) {
      const fresh = createModifier(kind) as unknown as Record<string, unknown>
      for (const row of modifierControls(kind)) {
        expect(row.key.startsWith(MODIFIER_KEY_PREFIX), row.key).toBe(true)
        expect(modifierField(row.key) in fresh, `${kind}.${modifierField(row.key)}`).toBe(true)
      }
    }
  })

  it('numeric params become sliders carrying the spec range and default', () => {
    for (const kind of MODIFIER_KINDS) for (const row of modifierControls(kind)) {
      const spec = specOf(modifierField(row.key))
      if (spec.control === 'options' || spec.control === 'toggle') continue
      expect(row.kind, row.key).toBe('slider')
      expect(row).toMatchObject({ min: spec.min, max: spec.max, step: spec.step, default: spec.default })
    }
  })

  it('axis/mode params become selects with optionLabels, defaulting to the option at the spec index', () => {
    const selects = MODIFIER_KINDS.flatMap((k) => modifierControls(k)).filter((r) => r.kind === 'select')
    // Exactly the index-valued modifier pickers, no more (shear + melt + lattice + radial array add
    // axis selects; boolean adds the operation select — its sibling picker is a dynamic scene-
    // sourced select in the surface, NOT a MODIFIER_SPECS control, so it is not counted here).
    expect(new Set(selects.map((r) => modifierField(r.key)))).toEqual(
      new Set(['taperAxis', 'twistAxis', 'bendAxis', 'cloneAxis', 'jitterMode', 'cloneMode', 'mirrorAxis', 'shearAxis', 'meltAxis', 'latticeAxis', 'radialAxis', 'booleanOp']),
    )
    for (const row of selects) {
      const spec = specOf(modifierField(row.key))
      expect((row as any).options, row.key).toEqual(spec.options)
      // optionLabels present, paired positionally, sentence case.
      expect((row as any).optionLabels, row.key).toHaveLength(spec.options!.length)
      for (const lbl of (row as any).optionLabels) expect(lbl, row.key).toMatch(/^[A-Z]/)
      // The select value is the option STRING at the spec's default INDEX.
      expect(row.default, row.key).toBe(spec.options![Math.round(spec.default)])
    }
  })

  it('varyColorStrength (and the rest of the Vary bag) is never a modifier control', () => {
    const allFields = new Set(MODIFIER_KINDS.flatMap((k) => modifierControls(k)).map((r) => modifierField(r.key)))
    for (const varyKey of ['varyColorStrength', 'varyMode', 'varyColor', 'varySeed', 'varyColorSpread']) {
      expect(allFields.has(varyKey), varyKey).toBe(false)
    }
  })

  it('labels are sentence case and rows are never Collection-bindable', () => {
    for (const kind of MODIFIER_KINDS) for (const row of modifierControls(kind)) {
      expect(row.label, row.key).toMatch(/^[A-Z]/)
      expect((row as any).bindable, row.key).toBe(false)
    }
  })

  it('the twist card offers Twist (the main dial) and a Twist axis select', () => {
    const rows = modifierControls('twist' as ModifierKind)
    expect(rows.map((r) => r.key)).toEqual(['modifier.twist', 'modifier.twistAxis'])
    expect(rows[0]).toMatchObject({ kind: 'slider', label: 'Twist' })
    expect(rows[1]).toMatchObject({ kind: 'select', label: 'Twist axis', options: ['x', 'y', 'z'], default: 'y' })
  })
})
