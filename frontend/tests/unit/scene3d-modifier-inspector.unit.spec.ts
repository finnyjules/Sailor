import { describe, it, expect } from 'vitest'
import {
  modifierStackOf, writeModifierStack,
  addModifier as addModifierOp,
  type ModifierInstance,
} from '~/lib/scene3d/modifierStack'
import { modifierField } from '~/lib/scene3d/modifierControls'
import { MODIFIER_SPECS, totalClones } from '~/lib/scene3d/primParams'

// These mirror EXACTLY the per-modifier inspector read/write the Scene3DStudioSurface runs against
// the SELECTED modifier instance (S1 Task 6): read/write the field off the instance in
// modifierStackOf(o), coercing an index-valued select label↔index, then persist through
// writeModifierStack (which keeps the legacy `modifiers` bag alive for the Cloner Vary uniform).
// The point of the spec is the coercion boundary and the write path, without mounting the SFC.
type Host = { kind: 'primitive'; modifiers?: Record<string, number>; modifierStack?: ModifierInstance[] }

const addModifier = (o: Host, kind: Parameters<typeof addModifierOp>[1]) => {
  const before = modifierStackOf(o)
  Object.assign(o, writeModifierStack(addModifierOp(before, kind)))
  return modifierStackOf(o).find((m) => !before.some((b) => b.id === m.id))!.id
}

function readModifierControl(o: Host, modId: string, key: string): string | number | boolean {
  const inst = modifierStackOf(o).find((m) => m.id === modId)
  if (!inst) return ''
  const field = modifierField(key)
  const spec = MODIFIER_SPECS.find((s) => s.key === field)
  const raw = (inst as unknown as Record<string, number>)[field]
  const v = raw === undefined ? (spec?.default ?? 0) : raw
  if (spec?.control === 'options') return (spec.options ?? [])[Math.round(v)] ?? (spec.options ?? [])[0] ?? ''
  if (spec?.control === 'toggle') return Math.round(v) === 1
  return v
}

function setModifierControl(o: Host, modId: string, key: string, value: string | number | boolean): void {
  const field = modifierField(key)
  const spec = MODIFIER_SPECS.find((s) => s.key === field)
  if (!spec) return
  let stored: number
  if (spec.control === 'options') {
    const i = (spec.options ?? []).indexOf(String(value))
    if (i < 0) return
    stored = i
  } else if (spec.control === 'toggle') {
    stored = value ? 1 : 0
  } else {
    stored = Number(value)
  }
  const next = modifierStackOf(o).map((m) => (m.id === modId ? { ...m, [field]: stored } as ModifierInstance : m))
  Object.assign(o, writeModifierStack(next))
}

/** The cost readout's clone count, sourced from the STACK's enabled cloner — not the legacy bag. */
function stackCloneCount(o: Host): number {
  const cloner = modifierStackOf(o).find((m) => m.kind === 'cloner' && m.enabled !== false)
  return cloner ? totalClones(cloner as unknown as Record<string, number>) : 0
}

/** The raw stored value on the instance (proves what a select actually persists). */
const rawField = (o: Host, modId: string, field: string): number =>
  (modifierStackOf(o).find((m) => m.id === modId) as unknown as Record<string, number>)[field]

describe('per-modifier inspector reads and writes the SELECTED instance', () => {
  it('a slider edit lands on the instance, persists via writeModifierStack, and keeps the Vary bag', () => {
    const o: Host = { kind: 'primitive', modifiers: { varyColorStrength: 0.5, varySeed: 7 } }
    const id = addModifier(o, 'twist')
    setModifierControl(o, id, 'modifier.twist', 120)
    expect(readModifierControl(o, id, 'modifier.twist')).toBe(120)
    // Persisted as a stored stack, not a raw write, and the legacy Vary bag is untouched.
    expect(Array.isArray(o.modifierStack)).toBe(true)
    expect(o.modifiers).toEqual({ varyColorStrength: 0.5, varySeed: 7 })
  })

  it('an axis SELECT stores the INDEX and reads back the option word', () => {
    const o: Host = { kind: 'primitive' }
    const id = addModifier(o, 'twist')
    // The select emits the option value ('z'); the write must coerce it to the stored index (2).
    setModifierControl(o, id, 'modifier.twistAxis', 'z')
    expect(rawField(o, id, 'twistAxis'), 'stored as a numeric index, never the label string').toBe(2)
    expect(readModifierControl(o, id, 'modifier.twistAxis'), 'reads back the option word').toBe('z')
    // A stray label that is not an option is refused rather than corrupting the index.
    setModifierControl(o, id, 'modifier.twistAxis', 'Z')
    expect(rawField(o, id, 'twistAxis')).toBe(2)
  })

  it('the clone-mode SELECT round-trips through the index the same way', () => {
    const o: Host = { kind: 'primitive' }
    const id = addModifier(o, 'cloner')
    setModifierControl(o, id, 'modifier.cloneMode', 'grid')
    expect(rawField(o, id, 'cloneMode')).toBe(2)
    expect(readModifierControl(o, id, 'modifier.cloneMode')).toBe('grid')
  })

  it('the cost readout counts clones from the STACK, not the stale legacy bag', () => {
    // A legacy object whose bag says two copies. Editing the cloner via the inspector writes the
    // stack; the bag is deliberately left stale — the count must follow the stack.
    const o: Host = { kind: 'primitive', modifiers: { cloneCount: 2 } }
    expect(stackCloneCount(o)).toBe(2)
    const clonerId = modifierStackOf(o).find((m) => m.kind === 'cloner')!.id
    setModifierControl(o, clonerId, 'modifier.cloneCount', 5)
    expect(stackCloneCount(o), 'reads the edited stack').toBe(5)
    expect(o.modifiers!.cloneCount, 'the legacy bag stays stale — proving the count is not read from it').toBe(2)
  })

  it('a disabled cloner contributes no clones to the cost', () => {
    const o: Host = { kind: 'primitive' }
    const id = addModifier(o, 'cloner')
    setModifierControl(o, id, 'modifier.cloneCount', 6)
    expect(stackCloneCount(o)).toBe(6)
    Object.assign(o, writeModifierStack(modifierStackOf(o).map((m) => (m.id === id ? { ...m, enabled: false } : m))))
    expect(stackCloneCount(o)).toBe(0)
  })
})
