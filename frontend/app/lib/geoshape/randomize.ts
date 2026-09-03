/**
 * geologo re-roll — regenerates each UNLOCKED control section with a fresh,
 * deterministic seed; locked sections carry their values over unchanged.
 *
 * Mirrors shapefx/randomize.ts's shape, but the RNG here is self-contained
 * (xmur3 hash -> mulberry32, the same construction shapefx/rng.ts and this
 * studio's own shapes.ts already use) rather than imported from a sibling
 * studio — `shapes.ts` already set that precedent for this module, keeping
 * geoshape a leaf with no cross-studio dependency.
 *
 * Unlike shapefx's `reroll`, which pulls a genuinely fresh seed from
 * `Math.random()` (real novelty on every click), this `reroll` derives its
 * next seed purely from `cfg.seed` — no `Math.random` anywhere in the path —
 * so `reroll(cfg, locks)` is a pure function: the same input always produces
 * the same output. That determinism is load-bearing for the surface's undo
 * stack and for this module's own test.
 */
import type { GeoShapeConfig } from './config'
import { SHAPES, LAYOUTS, FILLMODES, OVERLAPMODES, SYMMETRY_AXES, CLIP_MASKS } from './controls'
import { SHAPES as LIBRARY_SHAPES } from '~/lib/shapes/catalog'

const LIBRARY_IDS = LIBRARY_SHAPES.map(s => s.id)

interface Rng {
  /** Uniform float in [0,1). */
  next(): number
  /** Uniform float in [lo, hi). */
  range(lo: number, hi: number): number
  /** Integer in [lo, hi] inclusive. */
  int(lo: number, hi: number): number
  /** Random element of `arr`. */
  pick<T>(arr: readonly T[]): T
  /** True with probability `p`. */
  chance(p: number): boolean
}

/** xmur3 string hash -> 32-bit seed. */
function xmur3(str: string): number {
  let h = 1779033703 ^ str.length
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  return (h ^= h >>> 16) >>> 0
}

/** mulberry32 PRNG — fast, good enough for visual randomness. */
function mulberry32(a: number): () => number {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makeRng(seed: string, salt = ''): Rng {
  const fn = mulberry32(xmur3(seed + '|' + salt))
  return {
    next: fn,
    range: (lo, hi) => lo + (hi - lo) * fn(),
    int: (lo, hi) => lo + Math.floor((hi - lo + 1) * fn()),
    pick: (arr) => arr[Math.floor(fn() * arr.length) % arr.length]!,
    chance: (p) => fn() < p,
  }
}

/** Deterministic "next seed" derived from the current one. */
function nextSeed(prevSeed: number): number {
  const r = makeRng(String(prevSeed), 'reroll-seed')
  return 1 + Math.floor(r.next() * 999998)
}

// SHAPES/LAYOUTS/FILLMODES/OVERLAPMODES/SYMMETRY_AXES/CLIP_MASKS come from
// controls.ts (the one shared copy — see that file's note on config.ts).

// One roll group per GEO_SECTIONS entry (controls.ts), minus 'Paint' — colour
// is curated by the user, never randomized, matching shapefx/randomize.ts's
// own posture of leaving `fill`/`style.background` untouched by reroll.
type ShapeGroup = Pick<GeoShapeConfig, 'shape' | 'sides' | 'starInner' | 'irregularSeed' | 'size' | 'roundCorners' | 'roundRadius' | 'libraryShape'>
type LayoutGroup = Pick<GeoShapeConfig, 'layout' | 'count' | 'gridCols' | 'gridRows' | 'radius' | 'spacing' | 'angleStep'>
type TransformGroup = Pick<GeoShapeConfig, 'rotateBase' | 'rotateStep' | 'scaleStart' | 'scaleEnd' | 'skew' | 'spin'>
type CompositeGroup = Pick<GeoShapeConfig, 'fillMode' | 'overlapMode'>
type SymmetryGroup = Pick<GeoShapeConfig, 'symmetry' | 'symmetryAxis' | 'symmetrySpacing'>
type ClipGroup = Pick<GeoShapeConfig, 'clipMask' | 'clipMaskSize' | 'invert'>
type StyleGroup = Pick<GeoShapeConfig, 'padding' | 'strokeWidth'>

function rollShape(seed: string): ShapeGroup {
  const r = makeRng(seed, 'shape')
  // Draw in the SAME order as before and blank afterwards, rather than branching
  // inside the literal: every draw here shares one stream, so skipping one would
  // shift every value after it for one shape family and not another (same seed,
  // different mark). Corner rounding does not apply to a library shape, so a
  // rolled `roundCorners` left in the config would make two visually identical
  // library marks differ in stored state — and would spring back into effect the
  // moment the user switched shape family. `roundRadius` stays as rolled: it is
  // gated behind roundCorners > 0 anyway, so it is inert.
  const g: ShapeGroup = {
    shape: r.pick(SHAPES),
    sides: r.int(3, 24),
    starInner: +r.range(0.01, 0.99).toFixed(2),
    irregularSeed: r.int(1, 9999),
    size: r.int(80, 320),
    roundCorners: r.chance(0.4) ? r.int(10, 100) : 0,
    roundRadius: r.int(0, 100),
    libraryShape: r.pick(LIBRARY_IDS),
  }
  if (g.shape === 'library') g.roundCorners = 0
  return g
}

function rollLayout(seed: string): LayoutGroup {
  const r = makeRng(seed, 'layout')
  return {
    layout: r.pick(LAYOUTS),
    count: r.int(3, 24),
    gridCols: r.int(2, 8),
    gridRows: r.int(2, 8),
    radius: r.int(60, 400),
    spacing: r.int(80, 400),
    angleStep: r.int(10, 90),
  }
}

function rollTransform(seed: string): TransformGroup {
  const r = makeRng(seed, 'transform')
  return {
    rotateBase: r.int(-180, 180),
    rotateStep: r.int(-45, 45),
    scaleStart: +r.range(0.5, 1.5).toFixed(2),
    scaleEnd: +r.range(0.5, 1.5).toFixed(2),
    skew: r.int(-30, 30),
    spin: r.int(0, 360),
  }
}

function rollComposite(seed: string): CompositeGroup {
  const r = makeRng(seed, 'composite')
  return {
    fillMode: r.pick(FILLMODES),
    overlapMode: r.pick(OVERLAPMODES),
  }
}

function rollSymmetry(seed: string): SymmetryGroup {
  const r = makeRng(seed, 'symmetry')
  return {
    symmetry: r.chance(0.5),
    symmetryAxis: r.pick(SYMMETRY_AXES),
    symmetrySpacing: r.int(0, 200),
  }
}

function rollClip(seed: string): ClipGroup {
  const r = makeRng(seed, 'clip')
  return {
    clipMask: r.pick(CLIP_MASKS),
    clipMaskSize: r.int(40, 200),
    invert: r.chance(0.3),
  }
}

function rollStyle(seed: string): StyleGroup {
  const r = makeRng(seed, 'style')
  return {
    padding: r.int(0, 100),
    strokeWidth: r.int(0, 30),
  }
}

/**
 * Fresh (deterministic) seed + regenerate each UNLOCKED section; locked
 * sections carry over unchanged from `cfg`.
 *
 * `locks` keys are the lowercased `GEO_SECTIONS` names — 'shape', 'layout',
 * 'transform', 'composite', 'symmetry', 'clip', 'style' — a truthy value
 * locks that section. 'paint' is not a lock key: fill/stroke/overlapFill are
 * never touched by reroll regardless of locks.
 */
export function reroll(cfg: GeoShapeConfig, locks: Record<string, boolean>): GeoShapeConfig {
  const seed = nextSeed(cfg.seed)
  const s = String(seed)

  const shapeGroup: ShapeGroup = locks.shape
    ? { shape: cfg.shape, sides: cfg.sides, starInner: cfg.starInner, irregularSeed: cfg.irregularSeed, size: cfg.size, roundCorners: cfg.roundCorners, roundRadius: cfg.roundRadius, libraryShape: cfg.libraryShape }
    : rollShape(s)
  const layoutGroup: LayoutGroup = locks.layout
    ? { layout: cfg.layout, count: cfg.count, gridCols: cfg.gridCols, gridRows: cfg.gridRows, radius: cfg.radius, spacing: cfg.spacing, angleStep: cfg.angleStep }
    : rollLayout(s)
  const transformGroup: TransformGroup = locks.transform
    ? { rotateBase: cfg.rotateBase, rotateStep: cfg.rotateStep, scaleStart: cfg.scaleStart, scaleEnd: cfg.scaleEnd, skew: cfg.skew, spin: cfg.spin }
    : rollTransform(s)
  const compositeGroup: CompositeGroup = locks.composite
    ? { fillMode: cfg.fillMode, overlapMode: cfg.overlapMode }
    : rollComposite(s)
  const symmetryGroup: SymmetryGroup = locks.symmetry
    ? { symmetry: cfg.symmetry, symmetryAxis: cfg.symmetryAxis, symmetrySpacing: cfg.symmetrySpacing }
    : rollSymmetry(s)
  const clipGroup: ClipGroup = locks.clip
    ? { clipMask: cfg.clipMask, clipMaskSize: cfg.clipMaskSize, invert: cfg.invert }
    : rollClip(s)
  const styleGroup: StyleGroup = locks.style
    ? { padding: cfg.padding, strokeWidth: cfg.strokeWidth }
    : rollStyle(s)

  return {
    ...cfg,
    ...shapeGroup,
    ...layoutGroup,
    ...transformGroup,
    ...compositeGroup,
    ...symmetryGroup,
    ...clipGroup,
    ...styleGroup,
    // Paint is curated, never rolled — same posture as shapefx/randomize.ts
    // leaving `fill`/`style.background` alone.
    fill: cfg.fill,
    stroke: cfg.stroke,
    overlapFill: cfg.overlapFill,
    seed,
    locks: { ...locks },
  }
}
