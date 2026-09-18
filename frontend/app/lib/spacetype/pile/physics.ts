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
// Stop the raw sim when the pile is VISUALLY settled — by per-step position change, not
// velocity: micro-jitter can keep speed nonzero long after motion is imperceptible, and
// that invisible tail would inflate the trajectory so the resample crams the real fall
// into the first frames (looks too fast). POS_EPS is in WORLD units.
const POS_EPS = 0.02
const REST_STREAK = 6

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
    return Bodies.rectangle(x, y, hw, hh, { restitution, friction: 0.5, angle })
  })
  Composite.add(engine.world, bodies)

  // Simulate to rest, recording a raw pose per step.
  const scaled = (b: Body): Pose => ({ x: b.position.x / SCALE, y: b.position.y / SCALE, angle: b.angle })
  const raw: Pose[][] = []
  let restStreak = 0
  let prev: Pose[] | null = null
  for (let step = 0; step < MAX_STEPS; step++) {
    Engine.update(engine, DT_MS)
    const cur = bodies.map(scaled)
    raw.push(cur)
    // Max per-step centre displacement (world units) across all tokens.
    let moved = 0
    if (prev) for (let k = 0; k < cur.length; k++) moved = Math.max(moved, Math.hypot(cur[k]!.x - prev[k]!.x, cur[k]!.y - prev[k]!.y))
    prev = cur
    if (bodies.length === 0 || (step > 0 && moved < POS_EPS)) { if (++restStreak >= REST_STREAK) break } else restStreak = 0
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
