import * as THREE from 'three'
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js'

// Self-contained seeded RNG (mulberry32 over an xmur3 string hash). Duplicated
// from shapefx/rng.ts on purpose: shapefx is retired in Phase 2, so scene3d must
// not depend on it. Deterministic in the numeric seed.
function rngFor(seed: number): () => number {
  const s = `gem|${seed}`
  let h = 1779033703 ^ s.length
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  let a = (h ^= h >>> 16) >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Seeded point cloud for a gem. Points fill a unit-ish ball, biased by `spread`
 * (tight → wide) and stretched along Z by `depth`. Their convex hull becomes the
 * faceted stone. Clamps the count at BOTH ends: a junk import (points: 1e8) would
 * otherwise hang ConvexGeometry.
 */
export function gemPoints(points: number, spread: number, depth: number, seed: number): THREE.Vector3[] {
  const count = Math.min(64, Math.max(4, Math.round(points)))
  const rnd = rngFor(seed)
  const out: THREE.Vector3[] = []
  for (let i = 0; i < count; i++) {
    const u = rnd() * 2 - 1
    const theta = rnd() * Math.PI * 2
    const r = Math.pow(rnd(), 1 - 0.6 * spread) // spread high → radii pushed outward
    const s = Math.sqrt(1 - u * u)
    const x = r * s * Math.cos(theta) * (0.6 + spread)
    const y = r * s * Math.sin(theta) * (0.6 + spread)
    const z = r * u * depth
    out.push(new THREE.Vector3(x, y, z))
  }
  return out
}

/** Planar (front-facing XY, normalized to the shape's own bounds) UV backfill —
 *  ConvexGeometry sets only position + normal, so a surface fill would otherwise
 *  read UV (0,0) everywhere and render one flat texel. */
function ensureUV(geo: THREE.BufferGeometry): void {
  if (geo.getAttribute('uv')) return
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const n = pos.count
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i), y = pos.getY(i)
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
  }
  const spanX = maxX - minX || 1, spanY = maxY - minY || 1
  const uv = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    uv[i * 2] = (pos.getX(i) - minX) / spanX
    uv[i * 2 + 1] = (pos.getY(i) - minY) / spanY
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
}

// --- structured jewellery cuts ----------------------------------------------
// Each cut returns a point cloud whose CONVEX HULL is the faceted stone — the same
// hull path as the random `raw` gem, so flat-facet shading and UV backfill are
// unchanged. `density` (the gem's "Facets" param) drives ring segment counts, so a
// higher value literally adds facets. Cuts are convex by construction (a brilliant,
// step, cushion, marquise or cabochon is a convex solid), so the hull reproduces
// them faithfully. Coordinates are ~unit-radius at the girdle; gemGeometry's 0.4
// scale brings them into the studio footprint like the raw cloud.
export const GEM_CUTS = ['raw', 'brilliant', 'emerald', 'cushion', 'marquise', 'cabochon'] as const
export type GemCut = typeof GEM_CUTS[number]

function ringInto(out: THREE.Vector3[], y: number, r: number, n: number, phase = 0): void {
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * Math.PI * 2
    out.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r))
  }
}

/** Round brilliant: flat table, bezel/star crown, girdle, pavilion mains, culet. */
function brilliantCut(density: number, spread: number, depth: number): THREE.Vector3[] {
  const n = Math.max(6, Math.round(density))
  const table = 0.42 + 0.18 * spread
  const crownH = 0.42 * depth
  const pavH = 1.45 * depth
  const p: THREE.Vector3[] = []
  ringInto(p, crownH, table, n)                        // table (flat top)
  ringInto(p, crownH * 0.52, (table + 0.98) / 2, n, Math.PI / n) // bezel / star
  ringInto(p, crownH * 0.14, 0.98, n * 2)              // upper girdle
  ringInto(p, 0, 1.0, n * 2, Math.PI / (n * 2))        // girdle (widest)
  ringInto(p, -pavH * 0.42, 0.68, n * 2)               // upper pavilion
  ringInto(p, -pavH * 0.78, 0.30, n, Math.PI / n)      // lower pavilion
  p.push(new THREE.Vector3(0, -pavH, 0))               // culet (deep point)
  return p
}

/** Emerald step cut: octagonal outline, concentric stepped rings, shallow keel. */
function emeraldCut(_density: number, spread: number, depth: number): THREE.Vector3[] {
  const w = 0.78 + 0.18 * spread, d = 0.62, c = 0.26 // half-extents + cut-corner
  const corners: [number, number][] = [
    [w, d - c], [w, -(d - c)], [w - c, -d], [-(w - c), -d],
    [-w, -(d - c)], [-w, d - c], [-(w - c), d], [w - c, d],
  ]
  const H = 0.9 * depth
  const p: THREE.Vector3[] = []
  const oct = (y: number, s: number) => { for (const [x, z] of corners) p.push(new THREE.Vector3(x * s, y, z * s)) }
  oct(H * 0.5, 0.72)   // table
  oct(H * 0.32, 0.9)   // crown step
  oct(0, 1.0)          // girdle
  oct(-H * 0.5, 0.82)  // pavilion step
  oct(-H, 0.42)        // keel
  return p
}

/** Cushion: brilliant on a squircle (rounded-square) girdle. */
function cushionCut(density: number, spread: number, depth: number): THREE.Vector3[] {
  const n = Math.max(8, Math.round(density)) * 2
  const k = 0.72 // roundness of the squircle
  const sr = (a: number) => {
    const cx = Math.abs(Math.cos(a)), sz = Math.abs(Math.sin(a))
    return 1 / Math.pow(Math.pow(cx, 1 / k) + Math.pow(sz, 1 / k), k)
  }
  const ring = (y: number, scale: number, phase = 0) => {
    for (let i = 0; i < n; i++) {
      const a = phase + (i / n) * Math.PI * 2
      const r = sr(a) * scale
      p.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r))
    }
  }
  const table = 0.5 + 0.16 * spread
  const p: THREE.Vector3[] = []
  ring(0.4 * depth, table)
  ring(0.1 * depth, 0.97, Math.PI / n)
  ring(0, 1.0)
  ring(-0.62 * depth, 0.58)
  p.push(new THREE.Vector3(0, -1.35 * depth, 0))
  return p
}

/** Marquise: a brilliant stretched along X with two sharp girdle-plane tips. */
function marquiseCut(density: number, spread: number, depth: number): THREE.Vector3[] {
  const p = brilliantCut(density, spread, depth)
  for (const v of p) v.x *= 1.8
  p.push(new THREE.Vector3(1.85, 0, 0), new THREE.Vector3(-1.85, 0, 0)) // sharp tips
  return p
}

/** Cabochon: a smooth faceted dome on a flat base (no crown/pavilion). */
function cabochonCut(density: number, spread: number, depth: number): THREE.Vector3[] {
  const n = Math.max(8, Math.round(density))
  const rings = Math.max(4, Math.round(density / 2))
  const rad = 0.8 + 0.2 * spread
  const p: THREE.Vector3[] = []
  for (let j = 0; j <= rings; j++) {
    const phi = (j / rings) * (Math.PI / 2)
    ringInto(p, Math.sin(phi) * 0.95 * depth, Math.cos(phi) * rad, n, j % 2 ? Math.PI / n : 0)
  }
  ringInto(p, -0.06, rad, n)              // base rim
  p.push(new THREE.Vector3(0, -0.12, 0))  // flat underside
  return p
}

function cutPoints(cut: GemCut, points: number, spread: number, depth: number, seed: number): THREE.Vector3[] {
  switch (cut) {
    case 'brilliant': return brilliantCut(points, spread, depth)
    case 'emerald': return emeraldCut(points, spread, depth)
    case 'cushion': return cushionCut(points, spread, depth)
    case 'marquise': return marquiseCut(points, spread, depth)
    case 'cabochon': return cabochonCut(points, spread, depth)
    case 'raw': default: return gemPoints(points, spread, depth, seed)
  }
}

/** The gem's convex-hull geometry. Scaled to sit in the studio's ~unit-cube
 *  footprint like every other primitive, with a guaranteed-solid fallback.
 *  `cut` selects a jewellery cut (default `raw` = the original random hull, so
 *  callers that omit it — and every saved scene — are byte-identical). */
export function gemGeometry(points: number, spread: number, depth: number, seed: number, cut: GemCut = 'raw'): THREE.BufferGeometry {
  const raw = cutPoints(cut, points, spread, depth, seed)
  let geo: THREE.BufferGeometry
  try {
    geo = new ConvexGeometry(raw)
    if (geo.getAttribute('position').count < 12) throw new Error('degenerate hull')
  } catch {
    geo = new THREE.TetrahedronGeometry(0.55, 0)
  }
  geo.scale(0.4, 0.4, 0.4) // bring the ~1.6-wide cloud into the unit-cube footprint
  ensureUV(geo)
  return geo
}
