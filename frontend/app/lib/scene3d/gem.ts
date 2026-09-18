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

/** The gem's convex-hull geometry. Scaled to sit in the studio's ~unit-cube
 *  footprint like every other primitive, with a guaranteed-solid fallback. */
export function gemGeometry(points: number, spread: number, depth: number, seed: number): THREE.BufferGeometry {
  const raw = gemPoints(points, spread, depth, seed)
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
