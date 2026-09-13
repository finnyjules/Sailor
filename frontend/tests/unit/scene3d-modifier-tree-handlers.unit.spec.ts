import { describe, it, expect } from 'vitest'
import {
  modifierStackOf, writeModifierStack, canReorderModifier,
  addModifier as addModifierOp, removeModifier as removeModifierOp,
  duplicateModifier as duplicateModifierOp, reorderModifier as reorderModifierOp,
  type ModifierKind,
} from '~/lib/scene3d/modifierStack'

// These mirror EXACTLY the composition the Scene3DStudioSurface tree handlers run for a
// primitive object: read the stack through modifierStackOf, apply one pure list op, then
// Object.assign(o, writeModifierStack(next)). The point of the test is the wiring — that
// every mutation routes through writeModifierStack and therefore KEEPS the legacy `modifiers`
// bag (which still holds the Cloner Vary uniform), rather than a raw write to o.modifierStack.
type Host = { kind: 'primitive'; modifiers?: Record<string, number>; modifierStack?: unknown }

const addModifier = (o: Host, kind: ModifierKind) => Object.assign(o, writeModifierStack(addModifierOp(modifierStackOf(o), kind)))
const removeModifier = (o: Host, id: string) => Object.assign(o, writeModifierStack(removeModifierOp(modifierStackOf(o), id)))
const duplicateModifier = (o: Host, id: string) => Object.assign(o, writeModifierStack(duplicateModifierOp(modifierStackOf(o), id)))
const toggleModifier = (o: Host, id: string) =>
  Object.assign(o, writeModifierStack(modifierStackOf(o).map((m) => (m.id === id ? { ...m, enabled: !m.enabled } : m))))
const reorderModifier = (o: Host, fromId: string, toId: string) => {
  const stack = modifierStackOf(o)
  if (!canReorderModifier(stack, fromId, toId)) return o
  return Object.assign(o, writeModifierStack(reorderModifierOp(stack, fromId, toId)))
}

describe('modifier tree surface handlers route through writeModifierStack', () => {
  it('add stores a stack and keeps the legacy Vary bag alive', () => {
    // A legacy object carrying a Vary uniform in its `modifiers` bag but no geometry modifiers.
    const o: Host = { kind: 'primitive', modifiers: { varyColorStrength: 0.5, varySeed: 7 } }
    expect(modifierStackOf(o)).toHaveLength(0)
    addModifier(o, 'twist')
    const stack = modifierStackOf(o)
    expect(stack.map((m) => m.kind)).toEqual(['twist'])
    // writeModifierStack must NOT clear the bag — Vary would vanish on the first edit.
    expect(o.modifiers).toEqual({ varyColorStrength: 0.5, varySeed: 7 })
    expect(Array.isArray(o.modifierStack)).toBe(true)
  })

  it('remove drops the row', () => {
    const o: Host = { kind: 'primitive' }
    addModifier(o, 'bend')
    const id = modifierStackOf(o)[0]!.id
    removeModifier(o, id)
    expect(modifierStackOf(o)).toHaveLength(0)
  })

  it('duplicate yields two rows with fresh ids', () => {
    const o: Host = { kind: 'primitive' }
    addModifier(o, 'twist')
    const id = modifierStackOf(o)[0]!.id
    duplicateModifier(o, id)
    const stack = modifierStackOf(o)
    expect(stack.map((m) => m.kind)).toEqual(['twist', 'twist'])
    expect(stack[0]!.id).not.toBe(stack[1]!.id)
  })

  it('toggle flips enabled', () => {
    const o: Host = { kind: 'primitive' }
    addModifier(o, 'noise')
    const id = modifierStackOf(o)[0]!.id
    expect(modifierStackOf(o)[0]!.enabled).toBe(true)
    toggleModifier(o, id)
    expect(modifierStackOf(o)[0]!.enabled).toBe(false)
  })

  it('reorder within the orderable middle works, but a move touching a pin is refused', () => {
    const o: Host = { kind: 'primitive' }
    addModifier(o, 'subdivide') // pinned first
    addModifier(o, 'twist')
    addModifier(o, 'bend')
    addModifier(o, 'cloner') // pinned last
    let stack = modifierStackOf(o)
    expect(stack.map((m) => m.kind)).toEqual(['subdivide', 'twist', 'bend', 'cloner'])
    const twistId = stack.find((m) => m.kind === 'twist')!.id
    const bendId = stack.find((m) => m.kind === 'bend')!.id
    const subId = stack.find((m) => m.kind === 'subdivide')!.id

    // Middle reorder: drop twist onto bend.
    reorderModifier(o, twistId, bendId)
    expect(modifierStackOf(o).map((m) => m.kind)).toEqual(['subdivide', 'bend', 'twist', 'cloner'])

    // Across a pin: dropping the (now second) deform onto subdivide is refused — order unchanged.
    stack = modifierStackOf(o)
    const firstDeform = stack.find((m) => m.kind === 'bend')!.id
    reorderModifier(o, firstDeform, subId)
    expect(modifierStackOf(o).map((m) => m.kind)).toEqual(['subdivide', 'bend', 'twist', 'cloner'])
  })

  it('a second pinned kind is refused by addModifier (one subdivide, one cloner)', () => {
    const o: Host = { kind: 'primitive' }
    addModifier(o, 'subdivide')
    addModifier(o, 'subdivide')
    expect(modifierStackOf(o).filter((m) => m.kind === 'subdivide')).toHaveLength(1)
  })
})
