import { describe, it, expect } from 'vitest'
import { buildSvgObjects, SVG_SPLIT_THRESHOLD } from '~/lib/scene3d/svgImport'
import type { SvgLeafPath } from '~/composables/useVectorSvg'
import type { PrimitiveObject } from '~/lib/scene3d/config'
import { shapeById } from '~/lib/shapes/catalog'

function leaf(d: string, fill = '#ff0000', cx = 0, cy = 0): SvgLeafPath {
  return { d, fill, stroke: 'none', strokeWidth: 0, fillRule: 'nonzero', cx, cy }
}

describe('scene3d svg import', () => {
  it('returns a group followed by one svgPath per path', () => {
    const objs = buildSvgObjects([leaf('M0 0 L1 0 Z'), leaf('M2 0 L3 0 Z')], [], { name: 'Logo' })
    expect(objs).toHaveLength(3)
    const group = objs.find((o) => o.kind === 'group')!
    expect(group.name).toBe('Logo')
    const kids = objs.filter((o) => o.id !== group.id)
    expect(kids).toHaveLength(2)
    for (const k of kids) {
      expect(k.parentId).toBe(group.id)
      expect((k as PrimitiveObject).primitive).toBe('svgPath')
    }
    // Same-batch accumulation: if every child were numbered against the same
    // pre-batch snapshot instead of the growing scope, both would land 'Path'.
    expect(new Set(kids.map((k) => k.name)).size).toBe(kids.length)
  })

  it('seeds each object colour from its fill', () => {
    const objs = buildSvgObjects([leaf('M0 0 L1 0 Z', '#00ff00')], [], { name: 'X' })
    const kid = objs.find((o) => o.kind === 'primitive') as PrimitiveObject
    expect(kid.material.color).toBe('#00ff00')
  })

  it('leaves the default colour alone when a path has no fill', () => {
    const p: SvgLeafPath = { d: 'M0 0 L1 0 Z', fill: 'none', stroke: 'none', strokeWidth: 0, fillRule: 'nonzero', cx: 0, cy: 0 }
    const objs = buildSvgObjects([p], [], { name: 'X' })
    const kid = objs.find((o) => o.kind === 'primitive') as PrimitiveObject
    expect(kid.material.color).toBeTruthy()
  })

  // ── arrangement ──────────────────────────────────────────────────────────
  // This is the bug: extrudeShapes recentres every geometry on its own bbox
  // (correct, shared with text/shape), so unless each child carries its OWN
  // centre as its position, every path stacks on the origin and a multi-path
  // logo imports as a pile. See svgImport.ts's buildSvgObjects doc.

  it('positions each split child at its own cx (negated cy) instead of the origin', () => {
    const objs = buildSvgObjects([leaf('M0 0 L1 0 Z', '#ff0000', -6, 0), leaf('M2 0 L3 0 Z', '#00ff00', 6, 0)], [], { name: 'Logo' })
    const kids = objs.filter((o) => o.kind === 'primitive') as PrimitiveObject[]
    expect(kids).toHaveLength(2)
    const xs = kids.map((k) => k.position[0]).sort((a, b) => a - b)
    // Authored 12 units apart in cx; world/local separation must match exactly.
    expect(xs[1]! - xs[0]!).toBeCloseTo(12, 6)
  })

  it('negates cy: a leaf with positive cy gets NEGATIVE position[1] (SVG Y-down -> scene Y-up)', () => {
    const objs = buildSvgObjects([leaf('M0 0 L1 0 Z', '#ff0000', 0, 4)], [], { name: 'Logo' })
    const kid = objs.find((o) => o.kind === 'primitive') as PrimitiveObject
    expect(kid.position[1]).toBeCloseTo(-4, 6)
  })

  it('merged mode still yields one object at the origin', () => {
    const objs = buildSvgObjects([leaf('M0 0 L1 0 Z', '#ff0000', -6, 3), leaf('M2 0 L3 0 Z', '#00ff00', 6, -3)], [], { name: 'Logo', merged: true })
    const kid = objs.find((o) => o.kind === 'primitive') as PrimitiveObject
    expect(kid.position).toEqual([0, 0, 0])
  })

  it('merged mode yields exactly one object whose d holds every subpath', () => {
    const objs = buildSvgObjects([leaf('M0 0 L1 0 Z'), leaf('M2 0 L3 0 Z')], [], { name: 'X', merged: true })
    const kids = objs.filter((o) => o.kind === 'primitive') as PrimitiveObject[]
    expect(kids).toHaveLength(1)
    expect(kids[0]!.content?.path).toContain('M0 0 L1 0 Z')
    expect(kids[0]!.content?.path).toContain('M2 0 L3 0 Z')
  })

  it('merged mode still produces a group, so the import is one movable unit', () => {
    const objs = buildSvgObjects([leaf('M0 0 L1 0 Z')], [], { name: 'X', merged: true })
    expect(objs.some((o) => o.kind === 'group')).toBe(true)
  })

  it('parents the group under an existing parent when asked', () => {
    const objs = buildSvgObjects([leaf('M0 0 L1 0 Z')], [], { name: 'X', parentId: 'outer' })
    expect(objs.find((o) => o.kind === 'group')!.parentId).toBe('outer')
  })

  it('names children uniquely against the existing scene', () => {
    const first = buildSvgObjects([leaf('M0 0 L1 0 Z')], [], { name: 'Logo' })
    const second = buildSvgObjects([leaf('M0 0 L1 0 Z')], first, { name: 'Logo' })
    const names = [...first, ...second].map((o) => o.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('exports a split threshold', () => {
    expect(SVG_SPLIT_THRESHOLD).toBe(40)
  })

  it('a library shape imports as a group named after the shape with one svgPath child in its colour', () => {
    const s = shapeById('sparkle')!
    const objs = buildSvgObjects([leaf(s.d, s.sourceColor)], [], { name: s.name })
    expect(objs).toHaveLength(2)
    const group = objs.find((o) => o.kind === 'group')!
    expect(group.name).toBe('Sparkle')
    const child = objs.find((o) => o.id !== group.id) as PrimitiveObject
    expect(child.primitive).toBe('svgPath')
    expect(child.content?.path).toBe(s.d)
    expect(String(child.material?.color ?? (child as any).color ?? '').toLowerCase()).toBe(s.sourceColor.toLowerCase())
  })
})
