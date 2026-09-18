import { Engine, Bodies, Composite, type Body } from 'matter-js'
import type { Params } from '../effect'
import type { PileTokenSpec } from './tokens'
import { mulberry32, hashSeed } from '../rng'

// Mirrors engine.ts ORTHO_HALF_H: half-height the camera frames at z=14, FOV 45°.
export const FRAME_HALF_H = Math.tan((45 / 2) * Math.PI / 180) * 14
export const PILE_SAMPLES = 160

export interface Pose { x: number; y: number; angle: number }
export type PileTrajectory = Pose[][]

const num = (p: Params, k: string, d = 0): number => { const v = Number(p[k]); return Number.isFinite(v) ? v : d }

// Static barriers are THICK slabs, not thin lines: Matter has no continuous
// collision detection, so a fast-falling body would tunnel a thin floor in one
// step. A deep slab catches it inside its volume and resolves it back out.
const SLAB = 200            // slab depth (world units) — deeper than any per-step travel
const STEPS_PER_SAMPLE = 6  // physics sub-steps recorded per trajectory sample
const DT = 1000 / 60        // fixed timestep (ms) — determinism

/**
 * Drop the token rectangles into a Matter.js world and record a FIXED-length
 * trajectory: fall over `settleTime` of the loop, then hold the settled pose.
 * World is y-UP (gravity negative-y), floor at y = -FRAME_HALF_H, so poses map
 * to scene coordinates with no sign flips. Pure & deterministic in (specs, params).
 */
export function bakePile(specs: PileTokenSpec[], params: Params, frame: { width: number; height: number }): PileTrajectory {
  const rng = mulberry32(hashSeed(`${num(params, 'seed')}|bake|${specs.length}`))
  const aspect = Math.max(0.1, frame.width / Math.max(1, frame.height))
  const halfW = Math.max(0.2, num(params, 'container', 0.8)) * FRAME_HALF_H * aspect
  const floorY = -FRAME_HALF_H
  const spread = Math.min(1, Math.max(0, num(params, 'dropSpread', 0.5)))

  const engine = Engine.create()
  engine.gravity.y = -Math.max(0.05, num(params, 'gravity', 1))

  // Floor top surface sits at floorY; slab extends downward. Walls are slabs whose
  // inner faces sit at ±halfW and extend outward, tall enough to bound the drop.
  const floor = Bodies.rectangle(0, floorY - SLAB / 2, halfW * 2 + SLAB * 2, SLAB, { isStatic: true, friction: 0.6 })
  const left = Bodies.rectangle(-halfW - SLAB / 2, 0, SLAB, SLAB, { isStatic: true, friction: 0.4 })
  const right = Bodies.rectangle(halfW + SLAB / 2, 0, SLAB, SLAB, { isStatic: true, friction: 0.4 })
  Composite.add(engine.world, [floor, left, right])

  const restitution = Math.min(0.9, Math.max(0, num(params, 'bounciness', 0.1)))
  const bodies: Body[] = specs.map((s, i) => {
    // Seeded x within the container; stacked upward so higher tokens arrive later.
    const x = (rng() * 2 - 1) * halfW * (0.2 + 0.8 * spread)
    const y = FRAME_HALF_H + 1 + i * (Math.max(s.h, 0.4) * (1.1 + spread))
    const angle = (rng() * 2 - 1) * spread * 0.6
    return Bodies.rectangle(x, y, Math.max(0.05, s.w), Math.max(0.05, s.h), { restitution, friction: 0.5, angle })
  })
  Composite.add(engine.world, bodies)

  const fallSamples = Math.max(1, Math.round((PILE_SAMPLES - 1) * Math.min(1, Math.max(0.05, num(params, 'settleTime', 0.6)))))
  const traj: PileTrajectory = []
  for (let i = 0; i < fallSamples; i++) {
    for (let s = 0; s < STEPS_PER_SAMPLE; s++) Engine.update(engine, DT)
    traj.push(bodies.map(b => ({ x: b.position.x, y: b.position.y, angle: b.angle })))
  }
  // Hold the settled pose for the remainder of the loop.
  const settled = traj[traj.length - 1] ?? specs.map(() => ({ x: 0, y: floorY, angle: 0 }))
  while (traj.length < PILE_SAMPLES) traj.push(settled.map(p => ({ ...p })))
  return traj
}
