// tests/unit/cleanup-nudge.unit.spec.ts
// Clean up (pen stage 5, final review): a nudge (Rounded to N) is solved in
// its small window only — when the window can't take it, it is dropped, never
// re-solved over the whole connected part (that cost ~80 s on a grid of
// mirrored shapes). Other fixes still fall back to the whole part.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SketchDoc, EntityId } from '~/lib/sketch/model'
import { addPoint, addPath } from '~/lib/sketch/edit'

const spy = vi.hoisted(() => ({ windowOk: true, solves: 0 }))
vi.mock('~/lib/sketch/cleanup/guards', async (importOriginal) => {
  const real = await importOriginal<typeof import('~/lib/sketch/cleanup/guards')>()
  return {
    ...real,
    solveWindow: (...a: Parameters<typeof real.solveWindow>) => { spy.solves++; return spy.windowOk ? real.solveWindow(...a) : false },
  }
})
const { runCleanup } = await import('~/lib/sketch/cleanup/run')

// an open path of seven straight pieces, each at its own angle and a whole
// length except one 5.05 long — the only fix is "Rounded to 5", and the path
// reaches further than the fix's window
function crooked(): SketchDoc {
  const d: SketchDoc = { entities: [], constraints: [] }
  const legs: [number, number][] = [[3, 20], [5.05, -28], [7, 55], [4, -10], [6, 70], [2, -45], [8, 35]]
  let x = 0, y = 0
  const ids: EntityId[] = [addPoint(d, x, y)]
  for (const [L, deg] of legs) {
    x += L * Math.cos(deg * Math.PI / 180); y += L * Math.sin(deg * Math.PI / 180)
    ids.push(addPoint(d, x, y))
  }
  addPath(d, ids, legs.map(() => ({ kind: 'line' as const })))
  return d
}
const opts = { unitsPerPx: 1 / 34, strength: 'normal' as const, budgetMs: Infinity }

describe('a nudge never falls back to the whole part', () => {
  beforeEach(() => { spy.windowOk = true; spy.solves = 0 })
  it('control: the window takes it', () => {
    const r = runCleanup(crooked(), opts)
    expect(r.fixes.map(f => f.label)).toEqual(['Rounded to 5'])
    expect(r.fixes[0]!.on).toBe(true)
  })
  it('a window that can’t take it drops it, with no whole-part solve', () => {
    spy.windowOk = false
    const r = runCleanup(crooked(), opts)
    expect(r.fixes).toEqual([])
    expect(spy.solves).toBe(1)   // the window only — no second, whole-part solve
  })
})
