import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { meshDataFromGeometry, type MeshData } from '~/lib/scene3d/mesh'
import { mergeMeshes } from '~/lib/scene3d/voxel/merge'

const RES = 56
/** Two unit spheres overlapping by half a radius along X. */
const ball = (x: number) =>
  meshDataFromGeometry(new THREE.SphereGeometry(0.5, 48, 32).translate(x, 0, 0))

const volumeOf = (d: MeshData): number => {
  let v = 0
  const p = d.positions, ix = d.indices
  for (let i = 0; i < ix.length; i += 3) {
    const a = ix[i]! * 3, b = ix[i + 1]! * 3, c = ix[i + 2]! * 3
    v += (
      p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!)
      - p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!)
      + p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)
    ) / 6
  }
  return Math.abs(v)
}

/** Number of connected components over the triangle adjacency. */
const components = (d: MeshData): number => {
  const n = d.positions.length / 3
  const parent = new Int32Array(n)
  for (let i = 0; i < n; i++) parent[i] = i
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]!]!; x = parent[x]! } return x }
  const join = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb }
  for (let i = 0; i < d.indices.length; i += 3) {
    join(d.indices[i]!, d.indices[i + 1]!)
    join(d.indices[i + 1]!, d.indices[i + 2]!)
  }
  const roots = new Set<number>()
  for (let i = 0; i < n; i++) roots.add(find(i))
  return roots.size
}

const SPHERE_VOL = (4 / 3) * Math.PI * 0.5 ** 3

// Every merge at RES 56 costs seconds of lattice + SDF work, and the ladder test walks
// ~8 shrink steps — all well past the 5s default once the machine is under any load.
// The suite passes in ~26s run alone; it only ever fails in a full parallel run. One
// suite-level ceiling instead of per-test ones.
describe('merge', { timeout: 20_000 }, () => {
  it('union of two overlapping spheres is ONE connected body', () => {
    // Two components would mean the fields were never combined — the single
    // most likely way to get a merge that "looks fine" but did nothing.
    const { data, open } = mergeMeshes([ball(-0.25), ball(0.25)], 'union', 0, RES)
    expect(open).toBe(false)
    expect(components(data)).toBe(1)
  })

  it('union volume exceeds either input but is less than their sum', () => {
    // Less than the sum, because they overlap — a naive concatenation of the
    // two meshes would pass "greater than either" and fail this.
    const { data } = mergeMeshes([ball(-0.25), ball(0.25)], 'union', 0, RES)
    const v = volumeOf(data)
    expect(v).toBeGreaterThan(SPHERE_VOL * 1.1)
    expect(v).toBeLessThan(SPHERE_VOL * 2)
  })

  it('subtract removes material from the base', () => {
    const { data } = mergeMeshes([ball(-0.25), ball(0.25)], 'subtract', 0, RES)
    expect(volumeOf(data)).toBeLessThan(SPHERE_VOL * 0.95)
  })

  it('intersect keeps only the overlap', () => {
    const { data } = mergeMeshes([ball(-0.25), ball(0.25)], 'intersect', 0, RES)
    const v = volumeOf(data)
    expect(v).toBeGreaterThan(0)
    expect(v).toBeLessThan(SPHERE_VOL * 0.75)
  })

  it('blend adds material at the join', () => {
    const sharp = volumeOf(mergeMeshes([ball(-0.3), ball(0.3)], 'union', 0, RES).data)
    const filleted = volumeOf(mergeMeshes([ball(-0.3), ball(0.3)], 'union', 0.15, RES).data)
    expect(filleted).toBeGreaterThan(sharp)
  })

  it('refuses when any input is open', () => {
    const plane = meshDataFromGeometry(new THREE.PlaneGeometry(1, 1))
    const out = mergeMeshes([ball(0), plane], 'union', 0, RES)
    expect(out.open).toBe(true)
  })

  it('reports failure instead of silently substituting the base input when the retry ladder exhausts', () => {
    // A vertex cap of 1 can never be met at any resolution, including the
    // floor — forcing the exact path the real 40k cap only reaches after the
    // resolution slider (128) and ~10 shrink steps. Before this fix, running
    // the ladder out just swapped in `remesh(inputs[0])` alone and reported
    // success (`open: false`, no failure signal): that is REGARDLESS of `op`
    // or the second input, so the "merge" was really just the base object
    // reshaped. Confirm the real fix stays a real merge — data combining BOTH
    // spheres into one connected body — while ALSO flagging failure.
    const out = mergeMeshes([ball(-0.25), ball(0.25)], 'union', 0, RES, 1)
    expect(out.failed).toBe(true)
    expect(out.open).toBe(false)
    expect(components(out.data)).toBe(1)
    const v = volumeOf(out.data)
    // A single remeshed sphere (the old silent-fallback shape) has volume
    // SPHERE_VOL; the actual union of two overlapping spheres is bigger.
    expect(v).toBeGreaterThan(SPHERE_VOL * 1.1)
  })

  it('subtract is order-sensitive — the first input is the base', () => {
    const a = volumeOf(mergeMeshes([ball(-0.25), ball(0.25)], 'subtract', 0, RES).data)
    const b = volumeOf(mergeMeshes([ball(0.25), ball(-0.25)], 'subtract', 0, RES).data)
    expect(a).toBeCloseTo(b, 1) // symmetric shapes, so volumes match...
    // ...but the results occupy different halves of space.
    const ca = mergeMeshes([ball(-0.25), ball(0.25)], 'subtract', 0, RES).data
    const cb = mergeMeshes([ball(0.25), ball(-0.25)], 'subtract', 0, RES).data
    const meanX = (d: MeshData) => {
      let s = 0
      for (let i = 0; i < d.positions.length; i += 3) s += d.positions[i]!
      return s / (d.positions.length / 3)
    }
    expect(meanX(ca)).toBeLessThan(meanX(cb))
  })
})
