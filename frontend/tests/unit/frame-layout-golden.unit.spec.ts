// Stage 3, Task 1: the planner's output per layout, pinned before the kit moves onto the Frame's
// layout grid. Tasks 2–7 refactor the kit's own sheet and must leave every hash unchanged. Task 8
// (the planner on the grid) deletes the hash check; the counts stay as the ratchet's yardstick.
// Regenerate (only in Task 1): GOLDEN_WRITE=1 npx vitest run tests/unit/frame-layout-golden.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { writeFileSync } from 'node:fs'
import { GOLDEN_PATH, goldenCombos, goldenOf, readGolden } from './helpers/frameLayoutGolden'

const combos = goldenCombos()
const ids = [...new Set(combos.map(c => c.layoutId))]
const WRITE = process.env.GOLDEN_WRITE === '1'
const got: Record<string, { sig: string; count: number }> = {}

describe('stage 3 baseline — every layout, as the planner made it before the grid', () => {
  const golden = WRITE ? {} : readGolden()
  it.each(ids)('%s', (id) => {
    got[id] = goldenOf(combos.filter(c => c.layoutId === id))
    if (!WRITE) expect(got[id]).toEqual(golden[id])
  }, 120_000)

  it('covers every layout of every style', () => {
    if (WRITE) { writeFileSync(GOLDEN_PATH, JSON.stringify(got, null, 1) + '\n'); return }
    expect(Object.keys(golden).sort()).toEqual([...ids].sort())
  })
})
