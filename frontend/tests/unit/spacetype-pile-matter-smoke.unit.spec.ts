import { describe, it, expect } from 'vitest'
import { Engine, Bodies, Composite } from 'matter-js'

// A body dropped from rest onto a static floor lands, and does so IDENTICALLY
// across two runs with a fixed timestep — the determinism the bake relies on.
function dropOnce(): { y: number; angle: number } {
  const engine = Engine.create()
  engine.gravity.y = -1 // world is y-UP; gravity pulls toward -y
  const floor = Bodies.rectangle(0, -50, 400, 10, { isStatic: true })
  const box = Bodies.rectangle(0, 40, 20, 20, { restitution: 0.1, friction: 0.3 })
  Composite.add(engine.world, [floor, box])
  for (let i = 0; i < 600; i++) Engine.update(engine, 1000 / 60)
  return { y: box.position.y, angle: box.angle }
}

describe('matter-js smoke', () => {
  it('a dropped box settles above the floor', () => {
    const { y } = dropOnce()
    expect(y).toBeGreaterThan(-50) // came to rest on top of the floor, not through it
    expect(y).toBeLessThan(40)     // and it actually fell
  })

  it('is deterministic across runs with a fixed timestep', () => {
    const a = dropOnce()
    const b = dropOnce()
    expect(b.y).toBe(a.y)
    expect(b.angle).toBe(a.angle)
  })
})
