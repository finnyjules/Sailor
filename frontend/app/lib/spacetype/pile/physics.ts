import { Engine, Bodies, Composite, Vertices, type Body } from 'matter-js'
import type { Params } from '../effect'
import type { PileTokenSpec } from './tokens'
import { mulberry32, hashSeed } from '../rng'
import { shapeById } from '~/lib/shapes/catalog'
import { parseShapePolygon } from './shapeCollider'

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
const G_BASE = 9           // gravity multiplier: default slider (1) gives a grounded, earth-like drop
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
 * plays at REAL TIME over the loop (real gravity), then holds the settled pose.
 * World is y-UP (gravity negative-y), floor at y = -FRAME_HALF_H; poses map to scene
 * coordinates with no sign flips. Pure & deterministic in (specs, params).
 */
export function bakePile(specs: PileTokenSpec[], params: Params, frame: { width: number; height: number }, loopDuration = 6): PileTrajectory {
  const rng = mulberry32(hashSeed(`${num(params, 'seed')}|bake|${specs.length}`))
  const aspect = Math.max(0.1, frame.width / Math.max(1, frame.height))
  // The camera zoom (Transform → Scale) shrinks the visible frame to ±FRAME_HALF_H/scale, so the
  // floor/walls must track it or the pile settles below the canvas bottom. Mirrors tokens.ts.
  const halfH = FRAME_HALF_H / Math.max(0.1, num(params, 'scale', 1))
  const halfW = Math.max(0.2, num(params, 'container', 0.8)) * halfH * aspect * SCALE
  const floorY = -halfH * SCALE
  const topY = halfH * SCALE
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
  // `offsets[i]` is the vector from a body's physics centroid to the token-plane centre (the
  // shape ink-box centre), so the mesh (centred on the plane) tracks the collider exactly.
  // Polygon colliders re-centre on their centroid, which is NOT the box centre for asymmetric
  // shapes; rectangles/circles are symmetric so their offset is zero.
  const bodies: Body[] = []
  const offsets: { x: number; y: number }[] = []
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i]!
    const hw = Math.max(0.05, s.w) * SCALE
    const hh = Math.max(0.05, s.h) * SCALE
    const x = (rng() * 2 - 1) * halfW * (0.15 + 0.8 * spread)
    const y = topY + hh * 0.7 + i * hh * (0.9 + spread)
    const angle = (rng() * 2 - 1) * spread * 0.6
    let body: Body | null = null
    let offset = { x: 0, y: 0 }
    if (s.kind === 'shape') {
      // Trace the shape's real outline (convex hull) so it collides on its true edges.
      const shape = s.shapeId ? shapeById(s.shapeId) : undefined
      const poly = shape ? parseShapePolygon(shape.d, shape.box, hw, hh) : null
      if (poly && poly.length >= 3) {
        // Matter's Vertices.hull types the input as Vertex[] (index/body/isInternal), but only
        // reads x/y — our {x,y} points are fine at runtime; cast to the declared param type.
        const hull = Vertices.hull(poly as unknown as Parameters<typeof Vertices.hull>[0])
        if (hull.length >= 3) {
          const b = Bodies.fromVertices(x, y, [hull], { restitution, friction: 0.5, angle })
          if (b) { body = b; const c = Vertices.centre(hull); offset = { x: c.x, y: c.y } }
        }
      }
      // Fallback: broadly-round shapes (or a failed parse) get a circle.
      if (!body) body = Bodies.circle(x, y, Math.max(0.05, Math.min(hw, hh) / 2), { restitution, friction: 0.5, angle })
    } else {
      body = Bodies.rectangle(x, y, hw, hh, { restitution, friction: 0.5, angle })
    }
    bodies.push(body)
    offsets.push(offset)
  }
  Composite.add(engine.world, bodies)

  // Simulate to rest, recording a raw pose per step. The recorded pose is the token-plane
  // centre (box centre = position − R(angle)·centroidOffset), so the mesh tracks the collider.
  const scaled = (b: Body, k: number): Pose => {
    const off = offsets[k]!, a = b.angle, cos = Math.cos(a), sin = Math.sin(a)
    return { x: (b.position.x - (off.x * cos - off.y * sin)) / SCALE, y: (b.position.y - (off.x * sin + off.y * cos)) / SCALE, angle: a }
  }
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
  const fallback = specs.map(() => ({ x: 0, y: floorY / SCALE, angle: 0 }))
  if (!raw.length) raw.push(fallback)

  // Index the trajectory by REAL TIME so the drop plays at real gravity (not stretched to fill
  // the loop): sample j maps to loop-time (j/(N-1))·loopDuration seconds, shown as the physics
  // state recorded at that real time, clamped to the settled pose after it comes to rest. This is
  // what makes the Gravity control — and the earth-like feel — behave like real acceleration.
  const dtSec = DT_MS / 1000
  const lastRaw = raw.length - 1
  const traj: PileTrajectory = []
  for (let j = 0; j < PILE_SAMPLES; j++) {
    const tSec = (j / Math.max(1, PILE_SAMPLES - 1)) * loopDuration
    const idx = Math.min(lastRaw, Math.max(0, Math.round(tSec / dtSec)))
    traj.push(raw[idx]!.map(p => ({ ...p })))
  }
  return traj
}
