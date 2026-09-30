import { describe, it, expect } from 'vitest'
import { EFFECT_ORDER, EFFECT_MENU_GROUPS } from '~/lib/compositor/effectStack'
import { TREATMENT_KINDS, TREATMENT_MENU_GROUPS } from '~/lib/scene3d/treatments'

// The add menus list kinds by group, so a kind missing from the groups would silently vanish
// from the menu. Every kind must sit in exactly one group.
function expectPartition(all: readonly string[], groups: readonly { label: string; kinds: readonly string[] }[]) {
  const listed = groups.flatMap(g => g.kinds)
  expect(new Set(listed).size, 'no kind listed twice').toBe(listed.length)
  expect([...listed].sort()).toEqual([...all].sort())
  for (const g of groups) expect(g.kinds.length, g.label).toBeGreaterThan(0)
}

describe('add-menu groups', () => {
  it('Frame: every effect kind is in exactly one group', () => expectPartition(EFFECT_ORDER, EFFECT_MENU_GROUPS))
  it('3D: every treatment kind is in exactly one group', () => expectPartition(TREATMENT_KINDS, TREATMENT_MENU_GROUPS))
})
