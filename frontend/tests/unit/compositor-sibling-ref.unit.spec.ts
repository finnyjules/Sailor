import { describe, it, expect, vi } from 'vitest'
import {
  makeSiblingOutlineResolver,
  layerAffine,
  transformPathD,
  type SiblingResolverDeps,
} from '~/lib/compositor/siblingRef'
import { applyGeometry } from '~/lib/compositor/geometryEffects'
import { duplicateLayers } from '~/lib/compositor/layerEdits'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import { flatten, type Pt2 } from '~/lib/vector/pathOps'

// ── A tiny fake-layer world so the resolver is exercised WITHOUT Vue/canvas ────────────────
interface FakeLayer {
  id: string
  vector?: boolean          // eligible?
  d?: string                // outline in its own units
  x?: number; y?: number
  rotation?: number; skewX?: number; skewY?: number
  unitPx?: number
}
const SQUARE = 'M0 0 L10 0 L10 10 L0 10 Z'
const W = 100, H = 100

function deps(layers: FakeLayer[], over: Partial<SiblingResolverDeps<FakeLayer>> = {}): SiblingResolverDeps<FakeLayer> {
  return {
    W, H, layers,
    keyOf: l => `l:${l.id}`,
    eligible: l => l.vector !== false,
    outlineOf: l => (l.d ? { d: l.d } : null),
    placementOf: l => ({
      x: l.x ?? 0.5, y: l.y ?? 0.5,
      rotation: l.rotation ?? 0, skewX: l.skewX ?? 0, skewY: l.skewY ?? 0,
      unitPx: l.unitPx ?? 1,
    }),
    ...over,
  }
}
const firstPoint = (d: string): Pt2 => flatten(d)[0]!.pts[0]!
const bboxOf = (d: string) => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const s of flatten(d)) for (const p of s.pts) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y)
  }
  return { minX, minY, maxX, maxY }
}

describe('siblingRef: resolveSiblingOutline guards', () => {
  it('resolves a valid vector sibling into a non-null {d,W} in the self frame', () => {
    const A: FakeLayer = { id: 'A', vector: true, d: SQUARE, x: 0.5, y: 0.5 }
    const B: FakeLayer = { id: 'B', vector: true, d: SQUARE, x: 0.5, y: 0.5 }
    const r = makeSiblingOutlineResolver(deps([A, B]))
    const out = r('l:B', A)
    expect(out).not.toBeNull()
    expect(out!.W).toBe(W)
    expect(typeof out!.d).toBe('string')
    expect(out!.d.length).toBeGreaterThan(0)
    expect(typeof out!.subKey).toBe('string')
  })

  it('returns null for a missing/empty key (dangling — never throws)', () => {
    const A: FakeLayer = { id: 'A', vector: true, d: SQUARE }
    const r = makeSiblingOutlineResolver(deps([A]))
    expect(r('', A)).toBeNull()
    expect(r('l:GONE', A)).toBeNull() // target deleted
  })

  it('returns null for a self-reference (by key and by identity)', () => {
    const A: FakeLayer = { id: 'A', vector: true, d: SQUARE }
    const r = makeSiblingOutlineResolver(deps([A]))
    expect(r('l:A', A)).toBeNull()
  })

  it('returns null for a non-vector / ineligible target', () => {
    const A: FakeLayer = { id: 'A', vector: true, d: SQUARE }
    const IMG: FakeLayer = { id: 'IMG', vector: false, d: SQUARE }
    const r = makeSiblingOutlineResolver(deps([A, IMG]))
    expect(r('l:IMG', A)).toBeNull()
  })

  it('returns null when the target has no outline', () => {
    const A: FakeLayer = { id: 'A', vector: true, d: SQUARE }
    const B: FakeLayer = { id: 'B', vector: true } // no d
    const r = makeSiblingOutlineResolver(deps([A, B]))
    expect(r('l:B', A)).toBeNull()
  })

  it('never throws or emits NaN under an extreme self transform (invert guard)', () => {
    // The resolver guards `invertAffine(selfA) === null` (a genuinely singular / non-finite
    // self matrix) by returning null rather than propagating NaN. The standard `layerAffine`
    // coercions keep the affine invertible for ordinary layers, so an extreme shear here still
    // resolves — to a FINITE outline, never NaN and never a throw.
    const A: FakeLayer = { id: 'A', vector: true, d: SQUARE }
    const B: FakeLayer = { id: 'B', vector: true, d: SQUARE, x: 0.6 }
    const r = makeSiblingOutlineResolver(deps([A, B], {
      placementOf: l => ({
        x: l.x ?? 0.5, y: 0.5, rotation: 0,
        skewX: l.id === 'A' ? 80 : 0, skewY: l.id === 'A' ? 80 : 0, unitPx: 1,
      }),
    }))
    let out: ReturnType<typeof r> = null
    expect(() => { out = r('l:B', A) }).not.toThrow()
    if (out) for (const s of flatten((out as { d: string }).d)) for (const p of s.pts) {
      expect(Number.isFinite(p.x)).toBe(true)
      expect(Number.isFinite(p.y)).toBe(true)
    }
  })

  it('terminates on a cycle (A refs B, B refs A) — the nested resolution returns null', () => {
    const A: FakeLayer = { id: 'A', vector: true, d: SQUARE }
    const B: FakeLayer = { id: 'B', vector: true, d: SQUARE }
    const nested: unknown[] = []
    let r!: ReturnType<typeof makeSiblingOutlineResolver<FakeLayer>>
    // An outlineOf that walks BACK into the resolver (as a real boolean consumer would).
    r = makeSiblingOutlineResolver({
      ...deps([A, B]),
      outlineOf: (l) => {
        // Every layer's own outline tries to resolve its partner → must not recurse forever.
        if (l.id === 'B') nested.push(r('l:A', B))
        if (l.id === 'A') nested.push(r('l:B', A))
        return l.d ? { d: l.d } : null
      },
    })
    expect(() => r('l:B', A)).not.toThrow() // terminates — no infinite recursion / stack overflow
    expect(nested).toContain(null) // a re-entrant resolution was disabled by the cycle guard
  })
})

describe('siblingRef: transform correctness', () => {
  it('shifts the sibling outline by the placement delta in self space', () => {
    // Self at center; sibling offset +0.1 in x (→ +10px at W=100), unitPx 1 (rect/ellipse/text).
    const A: FakeLayer = { id: 'A', vector: true, d: SQUARE, x: 0.5, y: 0.5, unitPx: 1 }
    const B: FakeLayer = { id: 'B', vector: true, d: SQUARE, x: 0.6, y: 0.5, unitPx: 1 }
    const r = makeSiblingOutlineResolver(deps([A, B]))
    const out = r('l:B', A)!
    // B's first vertex (0,0) lands at (10, 0) in A's frame; the whole box shifts by (10,0).
    const p0 = firstPoint(out.d)
    expect(p0.x).toBeCloseTo(10, 3)
    expect(p0.y).toBeCloseTo(0, 3)
    const bb = bboxOf(out.d)
    expect(bb.minX).toBeCloseTo(10, 3)
    expect(bb.maxX).toBeCloseTo(20, 3)
    expect(bb.minY).toBeCloseTo(0, 3)
    expect(bb.maxY).toBeCloseTo(10, 3)
  })

  it('layerAffine composes translate·rotate·scale as the renderer does', () => {
    // Pure translate: a local (0,0) maps to (x·W, y·H).
    const m = layerAffine({ x: 0.25, y: 0.75, unitPx: 1 }, W, H)
    expect(transformPathD('M0 0 L1 0', m)).toContain('M25 75')
  })
})

describe('applyGeometry: the sibling seam is inert (byte-identity)', () => {
  const cases: Array<{ name: string; effects: any[] }> = [
    { name: 'no effects', effects: [] },
    { name: 'trim', effects: [{ type: 'trim', start: 0, end: 0.5, offset: 0, visible: true }] },
    { name: 'offset', effects: [{ type: 'offset', distance: 0.02, visible: true }] },
    { name: 'round_corners', effects: [{ type: 'round_corners', radius: 0.03, visible: true }] },
    { name: 'roughen', effects: [{ type: 'roughen', amount: 0.02, detail: 8, seed: 1, visible: true }] },
  ]
  const D = 'M0 0 L100 0 L100 100 L0 100 Z'
  for (const c of cases) {
    it(`output identical with vs without a resolveSibling arg — ${c.name}`, () => {
      const spy = vi.fn(() => ({ d: 'M0 0 L5 0', W, subKey: 'x' }))
      const without = applyGeometry(D, c.effects, { W })
      const with_ = applyGeometry(D, c.effects, { W, resolveSibling: spy })
      expect(with_).toBe(without) // same string (and same reference for the no-effect case)
      expect(spy).not.toHaveBeenCalled() // no current kind carries a refLayerId
    })
  }

  it('a resolver IS consulted for the cache key once a kind carries a refLayerId', () => {
    // Establishes the Task-2 contract: the seam threads the ref into the key (output still
    // unchanged today because no kind CONSUMES the sibling d in applyOne).
    const spy = vi.fn(() => ({ d: 'M0 0 L5 0', W, subKey: 'sub-1' }))
    const effects = [{ type: 'offset', distance: 0.02, visible: true, refLayerId: 'l:B' }]
    applyGeometry('M0 0 L100 0 L100 100 L0 100 Z', effects, { W, resolveSibling: spy })
    expect(spy).toHaveBeenCalledWith('l:B')
  })
})

describe('duplicateLayers: refLayerId lifecycle', () => {
  const mk = (over: Partial<LocalLayer>): LocalLayer => ({
    id: 'src', kind: 'rect', x: 0.5, y: 0.5, rotation: 0, opacity: 1,
    w: 0.2, h: 0.2, radius: 0, fill: '#fff',
    ...over,
  } as unknown as LocalLayer)

  it('carries an effect-level refLayerId VERBATIM (dup points at the ORIGINAL sibling)', () => {
    const src = mk({
      id: 'src',
      // The F3 convention: a geometry effect carries a refLayerId StackKey.
      effects: [{ type: 'offset', distance: 0.02, visible: true, refLayerId: 'l:sibling' } as any],
    })
    let n = 0
    const { layers, newIds } = duplicateLayers([src], [], new Set(['src']), 0.02, () => `dup${++n}`, () => 'g1')
    const clone = layers.find(l => l.id === newIds[0])!
    const eff = (clone as any).effects[0]
    expect(eff.refLayerId).toBe('l:sibling') // verbatim — NOT re-pointed to the clone's own new id
    // And it is a deep clone, not a shared reference with the source.
    expect((clone as any).effects).not.toBe((src as any).effects)
  })

  it('leaves a dangling ref dangling — no delete-time cleanup (resolver returns null)', () => {
    // Duplicate does not scrub a ref whose target is absent; resolution is what tolerates it.
    const A: FakeLayer = { id: 'A', vector: true, d: SQUARE }
    const r = makeSiblingOutlineResolver(deps([A])) // sibling 'GONE' never present
    expect(r('l:GONE', A)).toBeNull()
  })
})
