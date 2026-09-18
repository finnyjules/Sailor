import { Engine, Bodies, Composite, type Body } from 'matter-js'
import type { Params } from '../effect'
import type { PileTokenSpec } from './tokens'
import { mulberry32, hashSeed } from '../rng'

// Mirrors engine.ts ORTHO_HALF_H: half-height the camera frames at z=14, FOV 45°.
export const FRAME_HALF_H = Math.tan((45 / 2) * Math.PI / 180) * 14
export const PILE_SAMPLES = 160
// Matter is tuned for pixel-scale worlds; the scene's world units are tiny (~12 tall),
// so we simulate in a scaled space and divide back on the way out.
const SCALE = 100

export interface Pose { x: number; y: number; angle: number }
export type PileTrajectory = Pose[][]

const num = (p: Params, k: string, d = 0): number => { const v = Number(p[k]); return Number.isFinite(v) ? v : d }

const SLAB = 500            // static barrier thickness in px — deep enough to catch per-step travel
const DT_MS = 1000 / 120    // fixed physics step (stability)
const G_BASE = 3.2          // gravity multiplier so the default slider (1) falls briskly
const MAX_STEPS = 900       // hard cap on the raw settle sim (~7.5s physics)
// Stop the raw sim when the pile is VISUALLY settled — by position change over a WINDOW
// of steps, not a single step. Per-step change falsely reads as "rest" during the slow
// start of free-fall (velocity from zero moves < a per-step epsilon for several steps),
// which froze text-only piles at their spawn point above the frame. Measuring drift over
// REST_WINDOW steps can't be fooled by the slow start, and still ignores micro-jitter
// (which would otherwise inflate the trajectory and make the resampled fall look fast).
// WINDOW_EPS is total WORLD-unit drift over the window.
const REST_WINDOW = 12
const WINDOW_EPS = 0.05
const MIN_STEPS = 8

/**
 * Drop the token rectangles into a Matter.js world, simulate to FULL REST, then
 * RESAMPLE that settle into the fall window and hold the settled pose after. So the
 * pile ALWAYS fully settles regardless of token count/drop height, and the fall
 * plays over exactly `settleTime` of the loop (never instant, never unfinished).
 * World is y-UP (gravity negative-y), floor at y = -FRAME_HALF_H; poses map to scene
 * coordinates with no sign flips. Pure & deterministic in (specs, params).
 */
export function bakePile(specs: PileTokenSpec[], params: Params, frame: { width: number; height: number }): PileTrajectory {
  const rng = mulberry32(hashSeed(`${num(params, 'seed')}|bake|${specs.length}`))
  const aspect = Math.max(0.1, frame.width / Math.max(1, frame.height))
  const halfW = Math.max(0.2, num(params, 'container', 0.8)) * FRAME_HALF_H * aspect * SCALE
  const floorY = -FRAME_HALF_H * SCALE
  const topY = FRAME_HALF_H * SCALE
  const spread = Math.min(1, Math.max(0, num(params, 'dropSpread', 0.5)))

  const engine = Engine.create()
  engine.gravity.scale = 0.001
  engine.gravity.y = -Math.max(0.05, num(params, 'gravity', 1)) * G_BASE

  const floor = Bodies.rectangle(0, floorY - SLAB / 2, halfW * 2 + SLAB * 2, SLAB, { isStatic: true, friction: 0.6 })
  const left = Bodies.rectangle(-halfW - SLAB / 2, 0, SLAB, topY * 8, { isStatic: true, friction: 0.4 })
  const right = Bodies.rectangle(halfW + SLAB / 2, 0, SLAB, topY * 8, { isStatic: true, friction: 0.4 })
  Composite.add(engine.world, [floor, left, right])

  const restitution = Math.min(0.9, Math.max(0, num(params, 'bounciness', 0.1)))
  // Tokens stacked in a loose column ABOVE the frame (higher = arrives later → the pile
  // rains in). Drop distance no longer needs to fit the window: we sim to rest, then resample.
  const bodies: Body[] = specs.map((s, i) => {
    const hw = Math.max(0.05, s.w) * SCALE
    const hh = Math.max(0.05, s.h) * SCALE
    const x = (rng() * 2 - 1) * halfW * (0.15 + 0.8 * spread)
    const y = topY + hh * 0.7 + i * hh * (0.9 + spread)
    const angle = (rng() * 2 - 1) * spread * 0.6
    // Shapes get a CIRCLE collider (they're broadly round) so they nest and roll instead
    // of stacking on invisible box corners; text boxes stay rectangles.
    return s.kind === 'shape'
      ? Bodies.circle(x, y, Math.max(0.05, Math.min(hw, hh) / 2), { restitution, friction: 0.5, angle })
      : Bodies.rectangle(x, y, hw, hh, { restitution, friction: 0.5, angle })
  })
  Composite.add(engine.world, bodies)

  // Simulate to rest, recording a raw pose per step.
  const scaled = (b: Body): Pose => ({ x: b.position.x / SCALE, y: b.position.y / SCALE, angle: b.angle })
  const raw: Pose[][] = []
  for (let step = 0; step < MAX_STEPS; step++) {
    Engine.update(engine, DT_MS)
    raw.push(bodies.map(scaled))
    if (bodies.length === 0) break
    // Rest = the pile has barely drifted over the last REST_WINDOW steps.
    if (raw.length > REST_WINDOW && step >= MIN_STEPS) {
      const cur = raw[raw.length - 1]!, past = raw[raw.length - 1 - REST_WINDOW]!
      let drift = 0
      for (let k = 0; k < cur.length; k++) drift = Math.max(drift, Math.hypot(cur[k]!.x - past[k]!.x, cur[k]!.y - past[k]!.y))
      if (drift < WINDOW_EPS) break
    }
  }
  const settled = raw[raw.length - 1] ?? specs.map(() => ({ x: 0, y: floorY / SCALE, angle: 0 }))

  // Resample the raw settle into the fall window, then hold the settled pose.
  const fallSamples = Math.max(1, Math.round((PILE_SAMPLES - 1) * Math.min(1, Math.max(0.05, num(params, 'settleTime', 0.6)))))
  const lastRaw = raw.length - 1
  const traj: PileTrajectory = []
  for (let j = 0; j < fallSamples; j++) {
    const idx = fallSamples <= 1 ? lastRaw : Math.round((j / (fallSamples - 1)) * lastRaw)
    traj.push(raw[idx]!.map(p => ({ ...p })))
  }
  while (traj.length < PILE_SAMPLES) traj.push(settled.map(p => ({ ...p })))
  return traj
}
