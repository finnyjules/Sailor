import { describe, it, expect } from 'vitest'
import {
  MODIFIER_KINDS, MODIFIER_ORDER, PINNED_MODIFIERS, MODIFIER_KIND_PARAMS, MODIFIER_LABELS,
  isModifierKind, isPinnedModifier, newModifierId, createModifier,
  modifierStackOf, writeModifierStack,
  addModifier, removeModifier, duplicateModifier, reorderModifier, canReorderModifier,
  orderableModifiers, pinnedModifier, cloneModifierStack, sanitizeModifierStack,
  type ModifierInstance,
} from '~/lib/scene3d/modifierStack'
import { MODIFIER_SPECS } from '~/lib/scene3d/primParams'

describe('modifier stack: constants', () => {
  it('kinds and order are the fixed pipeline sequence, pinning subdivide first and cloner last', () => {
    expect([...MODIFIER_KINDS]).toEqual(['subdivide', 'taper', 'twist', 'bend', 'noise', 'jitter', 'shear', 'spherify', 'smooth', 'melt', 'lattice', 'array', 'shatter', 'mirror', 'decimate', 'voxelise', 'boolean', 'cloner'])
    expect([...MODIFIER_ORDER]).toEqual([...MODIFIER_KINDS])
    expect([...PINNED_MODIFIERS]).toEqual(['subdivide', 'cloner'])
  })

  it('every kind has a sentence-case human label', () => {
    for (const k of MODIFIER_KINDS) expect(MODIFIER_LABELS[k]).toMatch(/^[A-Z]/)
  })

  it('every param each kind owns is a real MODIFIER_SPECS key, and varyColorStrength belongs to no kind', () => {
    const specKeys = new Set(MODIFIER_SPECS.map((s) => s.key))
    const owned = new Set<string>()
    for (const k of MODIFIER_KINDS) {
      for (const key of MODIFIER_KIND_PARAMS[k]) {
        expect(specKeys.has(key)).toBe(true)
        expect(owned.has(key)).toBe(false) // no key owned by two kinds
        owned.add(key)
      }
    }
    // Vary settings are a material uniform, never a modifier row.
    for (const varyKey of ['varyColorStrength', 'varyMode', 'varyColor', 'varySeed']) {
      expect(owned.has(varyKey)).toBe(false)
    }
  })

  it('isModifierKind / isPinnedModifier', () => {
    expect(isModifierKind('twist')).toBe(true)
    expect(isModifierKind('varyColor')).toBe(false)
    expect(isModifierKind(3)).toBe(false)
    expect(isPinnedModifier('subdivide')).toBe(true)
    expect(isPinnedModifier('cloner')).toBe(true)
    expect(isPinnedModifier('twist')).toBe(false)
  })
})

describe('createModifier / ids', () => {
  it('fills every owned param from MODIFIER_SPECS defaults with a fresh id, enabled', () => {
    const t = createModifier('twist')
    expect(t.id).toMatch(/^mod_/)
    expect(t).toMatchObject({ kind: 'twist', enabled: true, twist: 0, twistAxis: 1 })
    // cloner starts at one copy (the legacy default), i.e. inert until the user raises the count.
    expect(createModifier('cloner')).toMatchObject({ kind: 'cloner', cloneCount: 1, cloneMode: 0 })
  })
  it('mints unique ids', () => {
    expect(newModifierId()).not.toBe(newModifierId())
    expect(createModifier('bend').id).not.toBe(createModifier('bend').id)
  })
})

describe('modifierStackOf: legacy bag fold', () => {
  it('folds a twist+bend bag into canonical order, each row carrying its axis', () => {
    const stack = modifierStackOf({ modifiers: { twist: 90, bend: 45 } })
    expect(stack.map((m) => m.kind)).toEqual(['twist', 'bend'])
    expect(stack[0]).toMatchObject({ kind: 'twist', enabled: true, twist: 90, twistAxis: 1 })
    expect(stack[1]).toMatchObject({ kind: 'bend', enabled: true, bend: 45, bendAxis: 2 })
  })

  it('keeps MODIFIER_ORDER regardless of bag key order', () => {
    // bend listed before twist in the bag, but twist sorts first.
    const stack = modifierStackOf({ modifiers: { bend: 10, twist: 20, taper: 0.5 } })
    expect(stack.map((m) => m.kind)).toEqual(['taper', 'twist', 'bend'])
  })

  it('gives deterministic ids stable across two reads', () => {
    const bag = { twist: 90, bend: 45 }
    const a = modifierStackOf({ modifiers: bag })
    const b = modifierStackOf({ modifiers: bag })
    expect(a.map((m) => m.id)).toEqual(['mod:twist:0', 'mod:bend:0'])
    expect(a.map((m) => m.id)).toEqual(b.map((m) => m.id))
  })

  it('absent, empty and all-zero bags fold to an empty stack', () => {
    expect(modifierStackOf(null)).toEqual([])
    expect(modifierStackOf({})).toEqual([])
    expect(modifierStackOf({ modifiers: {} })).toEqual([])
    expect(modifierStackOf({ modifiers: { twist: 0, bend: 0, taper: 0, noise: 0, jitter: 0 } })).toEqual([])
  })

  it('cloner is active only when it produces more than one copy', () => {
    expect(modifierStackOf({ modifiers: { cloneCount: 1 } })).toEqual([])
    const stack = modifierStackOf({ modifiers: { cloneCount: 4 } })
    expect(stack.map((m) => m.kind)).toEqual(['cloner'])
    expect(stack[0]).toMatchObject({ cloneCount: 4, cloneMode: 0, cloneStepScale: 1 })
    // grid mode switches the cloner on from its axis counts without touching cloneCount.
    const grid = modifierStackOf({ modifiers: { cloneMode: 2, cloneCountX: 2, cloneCountY: 1, cloneCountZ: 2 } })
    expect(grid.map((m) => m.kind)).toEqual(['cloner'])
  })

  it('a deform + cloner folds deform first, cloner last', () => {
    const stack = modifierStackOf({ modifiers: { twist: 30, cloneCount: 3 } })
    expect(stack.map((m) => m.kind)).toEqual(['twist', 'cloner'])
  })
})

describe('modifierStackOf: the subtle subdivide rule (mirrors applyModifiers)', () => {
  it('subdivide alone (no deform) folds to an empty stack — applyModifiers would no-op', () => {
    expect(modifierStackOf({ modifiers: { subdivide: 3 } })).toEqual([])
  })

  it('subdivide WITH a deform emits a subdivide row FIRST', () => {
    const stack = modifierStackOf({ modifiers: { subdivide: 2, noise: 0.2 } })
    expect(stack.map((m) => m.kind)).toEqual(['subdivide', 'noise'])
    expect(stack[0]).toMatchObject({ kind: 'subdivide', subdivide: 2 })
    expect(stack[1]).toMatchObject({ kind: 'noise', noise: 0.2, noiseScale: 2, noiseSeed: 0 })
  })

  it('subdivide rounds: 0.4 rounds to 0, so no subdivide row even with a deform', () => {
    const stack = modifierStackOf({ modifiers: { subdivide: 0.4, twist: 10 } })
    expect(stack.map((m) => m.kind)).toEqual(['twist'])
  })

  it('a cloner is NOT a deform: subdivide stays inactive with only a cloner', () => {
    const stack = modifierStackOf({ modifiers: { subdivide: 3, cloneCount: 4 } })
    expect(stack.map((m) => m.kind)).toEqual(['cloner'])
  })
})

describe('modifierStackOf: new-shape passthrough', () => {
  it('a valid modifierStack is returned unchanged and never re-sorted', () => {
    const stack: ModifierInstance[] = [
      { id: 'a', kind: 'bend', enabled: true, bend: 10, bendAxis: 2 },
      { id: 'b', kind: 'twist', enabled: false, twist: 20, twistAxis: 1 },
    ]
    const out = modifierStackOf({ modifierStack: stack })
    // bend-before-twist preserved even though twist sorts first in MODIFIER_ORDER.
    expect(out).toBe(stack)
    expect(out.map((m) => m.kind)).toEqual(['bend', 'twist'])
  })

  it('an empty modifierStack reads as no modifiers (does not fall back to a bag)', () => {
    expect(modifierStackOf({ modifierStack: [], modifiers: { twist: 90 } })).toEqual([])
  })

  it('a malformed stack (entry missing an id) falls through to the legacy bag fold', () => {
    const out = modifierStackOf({ modifierStack: [{ kind: 'twist', twist: 5 }], modifiers: { bend: 45 } })
    expect(out.map((m) => m.kind)).toEqual(['bend'])
    expect(out[0]!.id).toBe('mod:bend:0')
  })
})

describe('writeModifierStack', () => {
  it('stores the stack and KEEPS the legacy bag (Vary lives there)', () => {
    const stack = [createModifier('twist')]
    // The bag must NOT be cleared: varyMode/varySeed/…/varyColorStrength + the palette lookup
    // are read straight from `obj.modifiers` by varySettingsFor/materialFor, so clearing it
    // would strip Cloner Vary on the first stack edit.
    expect(writeModifierStack(stack)).toEqual({ modifierStack: stack })
    expect('modifiers' in writeModifierStack(stack)).toBe(false)
  })

  it('modifierStackOf a written object returns the stored stack, not the folded bag', () => {
    // The bag survives the write but is dead-but-harmless for geometry: modifierStackOf prefers
    // a present modifierStack, so the bag's geometry keys are never read once a stack is stored.
    const bagObj = { modifiers: { twist: 90, varyColor: 1 } }
    const stack = modifierStackOf(bagObj)
    const written = { ...bagObj, ...writeModifierStack(stack) }
    expect(written.modifiers).toEqual({ twist: 90, varyColor: 1 })
    expect(modifierStackOf(written)).toBe(stack)
  })
})

describe('list ops: pinned regions', () => {
  const build = (): ModifierInstance[] => [
    { id: 's', kind: 'subdivide', enabled: true, subdivide: 2 },
    { id: 't', kind: 'twist', enabled: true, twist: 20, twistAxis: 1 },
    { id: 'c', kind: 'cloner', enabled: true, cloneCount: 3 },
  ]

  it('addModifier inserts a deform at the end of the middle region, before the cloner', () => {
    const out = addModifier(build(), 'bend')
    expect(out.map((m) => m.kind)).toEqual(['subdivide', 'twist', 'bend', 'cloner'])
  })

  it('addModifier places subdivide first and refuses a second one', () => {
    const bare: ModifierInstance[] = [{ id: 't', kind: 'twist', enabled: true, twist: 20, twistAxis: 1 }]
    const out = addModifier(bare, 'subdivide')
    expect(out.map((m) => m.kind)).toEqual(['subdivide', 'twist'])
    expect(addModifier(out, 'subdivide')).toBe(out) // pinned singleton
  })

  it('addModifier places the cloner last and refuses a second one', () => {
    const bare: ModifierInstance[] = [{ id: 't', kind: 'twist', enabled: true, twist: 20, twistAxis: 1 }]
    const out = addModifier(bare, 'cloner')
    expect(out.map((m) => m.kind)).toEqual(['twist', 'cloner'])
    expect(addModifier(out, 'cloner')).toBe(out)
  })

  it('a deform added into a bare cloner-only stack still lands before the cloner', () => {
    const bare: ModifierInstance[] = [{ id: 'c', kind: 'cloner', enabled: true, cloneCount: 3 }]
    expect(addModifier(bare, 'twist').map((m) => m.kind)).toEqual(['twist', 'cloner'])
  })

  it('removeModifier drops by id and returns the same array when nothing matches', () => {
    const s = build()
    expect(removeModifier(s, 't').map((m) => m.kind)).toEqual(['subdivide', 'cloner'])
    expect(removeModifier(s, 'nope')).toBe(s)
  })

  it('duplicateModifier inserts a fresh-id copy right after a deform, but refuses pinned kinds', () => {
    const s = build()
    const out = duplicateModifier(s, 't')
    expect(out.map((m) => m.kind)).toEqual(['subdivide', 'twist', 'twist', 'cloner'])
    expect(out[2]!.id).not.toBe(out[1]!.id)
    expect(out[2]).toMatchObject({ twist: 20, twistAxis: 1 })
    expect(duplicateModifier(s, 's')).toBe(s) // pinned subdivide
    expect(duplicateModifier(s, 'c')).toBe(s) // pinned cloner
  })

  it('two deforms of the same kind both survive in stack order (duplicable)', () => {
    let s: ModifierInstance[] = []
    s = addModifier(s, 'twist')
    s = addModifier(s, 'twist')
    expect(s.map((m) => m.kind)).toEqual(['twist', 'twist'])
    expect(s[0]!.id).not.toBe(s[1]!.id)
  })
})

describe('list ops: reorder respects the pinned boundary', () => {
  const build = (): ModifierInstance[] => [
    { id: 's', kind: 'subdivide', enabled: true, subdivide: 2 },
    { id: 't', kind: 'twist', enabled: true, twist: 20, twistAxis: 1 },
    { id: 'b', kind: 'bend', enabled: true, bend: 10, bendAxis: 2 },
    { id: 'c', kind: 'cloner', enabled: true, cloneCount: 3 },
  ]

  it('canReorderModifier: two deforms yes; anything touching a pin, or self, no', () => {
    const s = build()
    expect(canReorderModifier(s, 't', 'b')).toBe(true)
    expect(canReorderModifier(s, 'b', 't')).toBe(true)
    expect(canReorderModifier(s, 't', 't')).toBe(false)
    expect(canReorderModifier(s, 's', 't')).toBe(false) // subdivide pinned
    expect(canReorderModifier(s, 't', 'c')).toBe(false) // cloner pinned
    expect(canReorderModifier(s, 't', 'missing')).toBe(false)
  })

  it('reorderModifier moves a deform onto another deform, keeping the pins put', () => {
    const out = reorderModifier(build(), 'b', 't') // drag bend before twist
    expect(out.map((m) => m.kind)).toEqual(['subdivide', 'bend', 'twist', 'cloner'])
  })

  it('reorderModifier handles a forward drag without the index-after-splice bug', () => {
    // twist onto bend: forward drag (from < to). The naive stale-index bug undoes this.
    const out = reorderModifier(build(), 't', 'b')
    expect(out.map((m) => m.id)).toEqual(['s', 'b', 't', 'c'])
  })

  it('reorderModifier is a no-op across a pinned boundary', () => {
    const s = build()
    expect(reorderModifier(s, 't', 'c')).toBe(s)
    expect(reorderModifier(s, 's', 'b')).toBe(s)
  })
})

describe('helpers', () => {
  const s: ModifierInstance[] = [
    { id: 's', kind: 'subdivide', enabled: true, subdivide: 2 },
    { id: 't', kind: 'twist', enabled: true, twist: 20, twistAxis: 1 },
    { id: 'c', kind: 'cloner', enabled: true, cloneCount: 3 },
  ]
  it('orderableModifiers returns only the middle deforms', () => {
    expect(orderableModifiers(s).map((m) => m.kind)).toEqual(['twist'])
  })
  it('pinnedModifier finds a pinned row by kind', () => {
    expect(pinnedModifier(s, 'subdivide')!.id).toBe('s')
    expect(pinnedModifier(s, 'cloner')!.id).toBe('c')
  })
  it('cloneModifierStack copies with fresh ids, or undefined for an empty stack', () => {
    const out = cloneModifierStack(s)!
    expect(out.map((m) => m.kind)).toEqual(['subdivide', 'twist', 'cloner'])
    for (let i = 0; i < out.length; i++) expect(out[i]!.id).not.toBe(s[i]!.id)
    expect(cloneModifierStack(undefined)).toBeUndefined()
    expect(cloneModifierStack([])).toBeUndefined()
  })
})

describe('boolean modifier: refObjectId (string field outside MODIFIER_KIND_PARAMS)', () => {
  it('createModifier makes a boolean at numeric defaults with NO refObjectId (a no-op until picked)', () => {
    const b = createModifier('boolean')
    expect(b.kind).toBe('boolean')
    expect(b.booleanOp).toBe(0)
    expect(b.booleanResolution).toBe(32)
    expect(b.refObjectId).toBeUndefined()
  })

  it('cloneModifierStack carries refObjectId to the duplicate (F: a duplicate keeps its sibling)', () => {
    const b = createModifier('boolean'); b.refObjectId = 'obj_sibling'
    const out = cloneModifierStack([b])!
    expect(out[0]!.refObjectId).toBe('obj_sibling')
    expect(out[0]!.id).not.toBe(b.id) // fresh id, same ref
  })

  it('sanitizeModifierStack preserves a boolean row refObjectId across the persistence round-trip', () => {
    const b = createModifier('boolean'); b.refObjectId = 'obj_sibling'; b.booleanBlend = 0.4
    const [round] = sanitizeModifierStack([b])!
    expect(round!.refObjectId).toBe('obj_sibling')
    expect(round!.booleanBlend).toBe(0.4)
  })

  it('sanitizeModifierStack drops an empty/non-string refObjectId and never carries it on other kinds', () => {
    const empty = { ...createModifier('boolean'), refObjectId: '' } as ModifierInstance
    expect(sanitizeModifierStack([empty])![0]!.refObjectId).toBeUndefined()
    const twist = { ...createModifier('twist'), refObjectId: 'obj_sibling' } as ModifierInstance
    expect(sanitizeModifierStack([twist])![0]!.refObjectId).toBeUndefined()
  })
})
