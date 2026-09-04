import { describe, it, expect, vi } from 'vitest'
import { composite } from '~/lib/geoshape/boolean'
import { DEFAULT_CONFIG } from '~/lib/geoshape/config'
import { commandsToPathData, shapesToSVG } from '~/lib/vector/svg'

// two overlapping squares as the base+placement stand-in
const SQUARE = 'M -50 -50 L 50 -50 L 50 50 L -50 50 Z'
// a regular hexagon (radius ~90), for the split-mode ring tests
const HEX = (() => {
  let d = ''
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 3
    d += (i === 0 ? 'M' : 'L') + ` ${90 * Math.cos(a)} ${90 * Math.sin(a)}`
  }
  return d + ' Z'
})()
const twoOverlap = [
  { x: -20, y: 0, scale: 1, rotate: 0, skew: 0 },
  { x: 20, y: 0, scale: 1, rotate: 0, skew: 0 },
]

// A local, detached PaperScope for test-side proofs (composite()'s own scope is
// module-private). Headless setup mirrors boolean.ts's own pattern.
let _paperMod: typeof paper | null = null
async function paperScope(): Promise<paper.PaperScope> {
  if (!_paperMod) _paperMod = ((await import('paper')) as unknown as { default: typeof paper }).default
  const scope = new _paperMod.PaperScope()
  scope.setup(new scope.Size(1024, 1024))
  scope.activate()
  return scope
}

describe('geoshape boolean composite', () => {
  it('evenodd hole: overlap becomes negative space (multiple subpaths, evenodd)', async () => {
    const shapes = await composite(SQUARE, twoOverlap, { ...DEFAULT_CONFIG, fillMode: 'evenodd', overlapMode: 'hole', symmetry: false, clipMask: 'none' })
    expect(shapes.length).toBeGreaterThanOrEqual(1)
    const svg = shapesToSVG(shapes)
    expect(svg).toContain('fill-rule="evenodd"')
    // an even-odd union of two overlapping squares has an interior hole → >1 subpath (M appears ≥2×)
    const ms = (shapes[0]!.commands.filter(c => c.command === 'moveTo')).length
    expect(ms).toBeGreaterThanOrEqual(2)
  })
  it('evenodd hole: the overlap centre is a real HOLE, not just extra subpaths', async () => {
    // placements offset the SQUARE (x∈[-50,50]) by ±20, so the left clone covers
    // x∈[-70,30] and the right clone covers x∈[-30,70]. Their shared overlap band
    // is x∈[-30,30], centred on the origin.
    const shapes = await composite(SQUARE, twoOverlap, { ...DEFAULT_CONFIG, fillMode: 'evenodd', overlapMode: 'hole', symmetry: false, clipMask: 'none' })
    const sc = await paperScope()
    try {
      const p = new sc.CompoundPath(commandsToPathData(shapes[0]!.commands))
      // paper.js's real style property is `fillRule` (Style.itemDefaults.fillRule);
      // `_contains` reads it via `getFillRule()`. Confirmed by reading paper's
      // source directly — the `windingRule` name useVectorSvg.ts:457 reads back
      // does not exist anywhere in paper.js; only `fillRule` does.
      p.fillRule = 'evenodd'
      // shared overlap centre: not contained -> it's a hole
      expect(p.contains(new sc.Point(0, 0))).toBe(false)
      // deep inside the left square only (x=-60, well outside the [-30,30] overlap
      // band and inside the left square's [-70,30] extent): must be solid fill
      expect(p.contains(new sc.Point(-60, 0))).toBe(true)
    } finally {
      sc.project.clear()
    }
  })
  it('overlapMode shape: the intersection is emitted as a separate filled shape', async () => {
    const shapes = await composite(SQUARE, twoOverlap, { ...DEFAULT_CONFIG, overlapMode: 'shape', overlapFill: '#ff0000', symmetry: false, clipMask: 'none' })
    // base + overlap = 2 shapes; the overlap shape carries overlapFill on
    // `.paint` (the authored Paint) — `.fill` is the solid-string fallback,
    // which for a solid overlapFill happens to be the same string.
    expect(shapes.length).toBe(2)
    expect(shapes[1]!.paint).toBe('#ff0000')
    expect(shapes[1]!.fill).toBe('#ff0000')
    // the overlap region is non-empty (has commands)
    expect(shapes[1]!.commands.length).toBeGreaterThan(0)
  })
  it('clip removes geometry outside the clip shape', async () => {
    const wide = [{ x: -200, y: 0, scale: 1, rotate: 0, skew: 0 }, { x: 200, y: 0, scale: 1, rotate: 0, skew: 0 }]
    const clipped = await composite(SQUARE, wide, { ...DEFAULT_CONFIG, overlapMode: 'hole', clipMask: 'circle', clipMaskSize: 60 })
    // clipping to a small circle drops the far-apart squares' outer extent
    const unclipped = await composite(SQUARE, wide, { ...DEFAULT_CONFIG, overlapMode: 'hole', clipMask: 'none' })
    const bbox = (s: any[]) => s.flatMap(x => x.commands).flatMap((c: any) => c.args).filter((_: any, i: number) => i % 2 === 0)
    expect(Math.max(...bbox(clipped).map(Math.abs))).toBeLessThan(Math.max(...bbox(unclipped).map(Math.abs)))
  })
  it('symmetry works in the default evenodd/hole mode (regression)', async () => {
    const shapes = await composite(SQUARE, twoOverlap, { ...DEFAULT_CONFIG, symmetry: true, clipMask: 'none' })
    expect(shapes.length).toBeGreaterThanOrEqual(1)
    // non-empty geometry survived the mirror (the bug produced 0 commands: uniting
    // the self-overlapping evenodd compound emptied the mark)
    expect(shapes[0]!.commands.length).toBeGreaterThan(0)
    // mirroring at the clone level doubles the subpath count (2 clones -> 4
    // subpaths, since evenodd keeps every clone as its own subpath)
    const ms = shapes[0]!.commands.filter(c => c.command === 'moveTo').length
    expect(ms).toBe(4)
    const svg = shapesToSVG(shapes)
    // the SVG actually carries real path data, not an empty mark
    expect(svg).toMatch(/<path d="M-?\d/)
  })
  it('the boolean fold is a balanced tree that matches the left-to-right chain for every op (exclude = even-odd compound)', async () => {
    // Seven squares stepping along a diagonal with partial overlaps — enough clones
    // for the tree to have an odd leftover and for exclude to keep several rings.
    // exclude no longer folds at all (it is the even-odd region), so for it this
    // checks the compound covers exactly what a resolved XOR chain covers.
    const placements = Array.from({ length: 7 }, (_, i) => ({ x: i * 40, y: i * 25, rotate: i * 9, scale: 1 }))
    const paperMod = ((await import('paper')) as unknown as { default: typeof import('paper') }).default
    const sc = new paperMod.PaperScope(); sc.setup(new sc.Size(1024, 1024))
    const clone = (pl: { x: number; y: number; rotate: number; scale: number }) => {
      const p = new sc.CompoundPath(SQUARE); const m = new sc.Matrix()
      m.translate(pl.x, pl.y); m.rotate(pl.rotate, new sc.Point(0, 0)); m.scale(pl.scale); p.transform(m); return p as any
    }
    // Compared by point containment on a grid, not by `.area`: paper's exclude
    // emits the same region with different child windings depending on the
    // fold order, so signed areas disagree while the covered region is identical.
    const covered = (items: any[]) => {
      const hit: boolean[] = []
      for (let x = -70; x <= 340; x += 4) for (let y = -70; y <= 240; y += 4) hit.push(items.some(it => it.contains(new sc.Point(x, y))))
      return hit
    }
    for (const fillMode of ['unite', 'subtract', 'intersect', 'exclude'] as const) {
      sc.activate()
      let chain: any = clone(placements[0]!)
      for (const pl of placements.slice(1)) chain = chain[fillMode](clone(pl))
      const chainHits = covered([chain])
      const shapes = await composite(SQUARE, placements, { ...DEFAULT_CONFIG, fillMode, clipMask: 'none', strokeWidth: 0 })
      sc.activate()
      const treeItems = shapes.map((s) => { const p = new sc.CompoundPath(commandsToPathData(s.commands)); p.fillRule = s.fillRule ?? 'nonzero'; return p })
      const treeHits = covered(treeItems)
      const disagree = chainHits.filter((h, i) => h !== treeHits[i]).length
      if (fillMode !== 'intersect') expect(chainHits.filter(Boolean).length, fillMode).toBeGreaterThan(50)
      // Samples right on an edge may land on either side depending on how the
      // fold placed that edge numerically: allow 0.5% of the grid to differ.
      expect(disagree, fillMode).toBeLessThanOrEqual(chainHits.length * 0.005)
      sc.project.clear()
    }
  })

  it('symmetry with subtract + an asymmetric placement folds first, then mirrors (regression: previously emptied)', async () => {
    // Clone-level mirror-append (correct for evenodd) is WRONG for subtract: running
    // mirrored clones through the same subtract fold as the originals is not the
    // same as mirroring the finished mark, and can empty the geometry entirely.
    const asymmetric = [
      { x: -20, y: 0, scale: 1, rotate: 0, skew: 0 },
      { x: 90, y: 30, scale: 1, rotate: 0, skew: 0 },
    ]
    const shapes = await composite(SQUARE, asymmetric, { ...DEFAULT_CONFIG, fillMode: 'subtract', symmetry: true, clipMask: 'none' })
    expect(shapes[0]!.commands.length).toBeGreaterThan(0)
    // shapesToSVG's default viewBox is "0 0 0 0" unless the caller supplies one
    // (it does not derive one from content) — so build a real viewBox from the
    // resolved mark's own bounds to confirm the geometry is truly non-degenerate,
    // not just non-empty-array.
    const sc = await paperScope()
    try {
      const p = new sc.CompoundPath(commandsToPathData(shapes[0]!.commands))
      const b = p.bounds
      expect(b.width).toBeGreaterThan(0)
      expect(b.height).toBeGreaterThan(0)
      const svg = shapesToSVG(shapes, { viewBox: [b.x, b.y, b.width, b.height] })
      expect(svg).not.toContain('viewBox="0 0 0 0"')
    } finally {
      sc.project.clear()
    }
  })
  it('fillStrategy perClone: one shape per clone, cycling fills', async () => {
    const placements = [
      { x: -60, y: 0, scale: 1, rotate: 0, skew: 0 },
      { x: 0, y: 0, scale: 1, rotate: 0, skew: 0 },
      { x: 60, y: 0, scale: 1, rotate: 0, skew: 0 },
    ]
    const shapes = await composite(SQUARE, placements, { ...DEFAULT_CONFIG, fillStrategy: 'perClone', fills: ['#ff0000', '#00ff00'], symmetry: false, clipMask: 'none' })
    expect(shapes).toHaveLength(3)
    expect(shapes.map(s => s.paint)).toEqual(['#ff0000', '#00ff00', '#ff0000']) // cycle
    for (const s of shapes) expect(s.fillRule).toBe('nonzero')
  })
  it('fillStrategy perClone symmetry mirrors clones AND inherits their paint', async () => {
    // Asymmetric on purpose: 2 clones + a 3-entry palette. Correct behaviour
    // (each mirror inherits its SOURCE clone's cycled paint) yields
    // [f0,f1, f0,f1]. The spec's #1-risk bug — computing the cycle index on the
    // concatenated (post-mirror) list, i.e. continuing the modulo past the
    // mirror boundary — would instead yield [f0,f1, f2,f0]. Those diverge only
    // when fills.length > clone count, so this case actually guards the risk
    // (a 2-clone/2-fill case produces the same sequence under both and proves
    // nothing).
    const placements = [{ x: -40, y: 0, scale: 1, rotate: 0, skew: 0 }, { x: 40, y: 0, scale: 1, rotate: 0, skew: 0 }]
    const shapes = await composite(SQUARE, placements, { ...DEFAULT_CONFIG, fillStrategy: 'perClone', fills: ['#f00', '#0f0', '#00f'], symmetry: true, clipMask: 'none' })
    expect(shapes).toHaveLength(4) // 2 originals + 2 mirrors
    expect(shapes.map(s => s.paint)).toEqual(['#f00', '#0f0', '#f00', '#0f0']) // mirror inherits source paint, NOT ['#f00','#0f0','#00f','#f00']
  })
  it('unified mode (fillStrategy single) is unchanged — evenodd hole still there', async () => {
    const shapes = await composite(SQUARE, [{ x: -20, y: 0, scale: 1, rotate: 0, skew: 0 }, { x: 20, y: 0, scale: 1, rotate: 0, skew: 0 }], { ...DEFAULT_CONFIG, fillStrategy: 'single' })
    expect(shapes[0]!.fillRule).toBe('evenodd')
  })

  const three = [
    { x: -40, y: -24, scale: 1, rotate: 45, skew: 0 },
    { x: 40, y: -24, scale: 1, rotate: 45, skew: 0 },
    { x: 0, y: 40, scale: 1, rotate: 45, skew: 0 },
  ]
  const pcfg = (over: Partial<any>) => ({ ...DEFAULT_CONFIG, fillStrategy: 'pieces', fills: ['#f00', '#0f0', '#00f'], overlapFills: ['#fff', '#000'], symmetry: false, clipMask: 'none', ...over })

  it('pieces: depth order → solo=fills[0], 2-deep=fills[1], 3-deep=fills[2]', async () => {
    const shapes = await composite(SQUARE, three, pcfg({ fillOrder: 'depth', overlapSeparate: false }))
    const paints = new Set(shapes.map((s) => s.paint))
    expect(paints.has('#f00')).toBe(true)   // solo
    expect(paints.has('#0f0')).toBe(true)   // 2-deep
    expect(paints.has('#00f')).toBe(true)   // 3-deep (triple center exists for this arrangement)
    for (const s of shapes) expect(s.fillRule).toBe('nonzero')
  })
  it('pieces: overlapSeparate uses overlapFills by depth', async () => {
    const shapes = await composite(SQUARE, three, pcfg({ fillOrder: 'depth', overlapSeparate: true }))
    const paints = new Set(shapes.map((s) => s.paint))
    expect(paints.has('#f00')).toBe(true)   // solo from fills[0]
    expect(paints.has('#fff')).toBe(true)   // 2-deep from overlapFills[0]
    expect(paints.has('#000')).toBe(true)   // 3-deep from overlapFills[1]
    expect(paints.has('#0f0')).toBe(false)  // shape fills 1/2 NOT used for overlaps
  })
  it('pieces: solo pieces follow fillOrder (leftRight)', async () => {
    // Three axis-aligned squares spaced along x with partial neighbour overlap
    // (each extent is 100 wide, spaced 60 apart → 40 of overlap with each
    // neighbour, no triple overlap), so each has an unambiguous solo region at
    // a distinct x. Creation order is deliberately NOT left-to-right (rightmost
    // first, then leftmost, then middle), so a fillOrder that silently fell back
    // to creation order would produce a DIFFERENT solo paint sequence than the
    // correct left-to-right one — this is what makes the test fail if fillOrder
    // were ignored.
    const placements = [
      { x: 60, y: 0, scale: 1, rotate: 0, skew: 0 }, // rightmost, created 1st
      { x: -60, y: 0, scale: 1, rotate: 0, skew: 0 }, // leftmost, created 2nd
      { x: 0, y: 0, scale: 1, rotate: 0, skew: 0 }, // middle, created 3rd
    ]
    const shapes = await composite(SQUARE, placements, pcfg({ fillOrder: 'leftRight', overlapSeparate: true, overlapFills: ['#fff'] }))
    const solo = shapes.filter((s) => s.paint !== '#fff')
    expect(solo.length).toBe(3)
    const sc = await paperScope()
    try {
      const withX = solo.map((s) => {
        const p = new sc.CompoundPath(commandsToPathData(s.commands))
        return { paint: s.paint, cx: p.bounds.center.x }
      })
      withX.sort((a, b) => a.cx - b.cx)
      // ascending-x solo pieces must follow fills[0], fills[1], fills[2] in order —
      // under a creation-order fallback the sequence would instead read
      // ['#f00', '#0f0', '#00f'] mapped to [rightmost, leftmost, middle], which
      // sorted by x comes out as ['#0f0', '#00f', '#f00'] — a different sequence.
      expect(withX.map((w) => w.paint)).toEqual(['#f00', '#0f0', '#00f'])
    } finally {
      sc.project.clear()
    }
  })
  it('pieces mode caps the clone count for performance (PIECES_MAX_CLONES)', async () => {
    // 80 overlapping squares in a tight line (spaced 12 apart, each 100 wide, so
    // every square overlaps many neighbours) — pieces mode's O(N²) solo/depth-band
    // folds would be minutes of main-thread work uncapped. The cap should bound
    // total returned shapes well under 80 and keep the test itself fast.
    const placements80 = Array.from({ length: 80 }, (_, i) => ({ x: i * 12 - 474, y: 0, scale: 1, rotate: 0, skew: 0 }))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const start = Date.now()
    const shapes = await composite(SQUARE, placements80, { ...DEFAULT_CONFIG, fillStrategy: 'pieces', fills: ['#f00', '#0f0', '#00f'], symmetry: false, clipMask: 'none' })
    const elapsed = Date.now() - start
    // solo pieces are bounded by PIECES_MAX_CLONES (48); a handful of overlap
    // depth bands add a small allowance on top — nowhere near the ~80+ shapes an
    // uncapped fold over this densely-overlapping line would produce.
    expect(shapes.length).toBeLessThanOrEqual(60)
    expect(elapsed).toBeLessThan(5000)
    // mockRestore() also clears recorded calls, so assert on the spy BEFORE
    // restoring it.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('geoshape pieces mode: capping'))
    warnSpy.mockRestore()
  })
  it('perClone honors fillOrder (around changes the cycle vs created)', async () => {
    const ring = Array.from({ length: 6 }, (_, i) => ({ x: Math.cos(i * Math.PI / 3) * 120, y: Math.sin(i * Math.PI / 3) * 120, scale: 1, rotate: 0, skew: 0 }))
    const made = await composite(SQUARE, ring, { ...DEFAULT_CONFIG, fillStrategy: 'perClone', fills: ['#f00', '#0f0', '#00f'], fillOrder: 'created', symmetry: false })
    const around = await composite(SQUARE, ring, { ...DEFAULT_CONFIG, fillStrategy: 'perClone', fills: ['#f00', '#0f0', '#00f'], fillOrder: 'around', symmetry: false })
    expect(made.map((s) => s.paint)).not.toEqual(around.map((s) => s.paint))
  })

  it('pieces are a DISJOINT partition even at deep overlap (solo + bands sum to the union area)', async () => {
    // A ring of squares whose bodies pile up at the centre → depth climbs to the
    // clone count. The returned pieces must PARTITION the covered area: sum of
    // piece areas == area of the clones' union (no overlaps, no gaps). The old
    // promote/demote band algorithm over-counted by 40–75% here (bands overlapped),
    // which is what made a many-clone mark's deep centre render wrong.
    const count = 9, radius = 40
    const placements = Array.from({ length: count }, (_, i) => {
      const a = (i / count) * Math.PI * 2
      return { x: Math.cos(a) * radius, y: Math.sin(a) * radius, scale: 1, rotate: (i * 360 / count) * 0.5, skew: 0 }
    })
    const shapes = await composite(SQUARE, placements, { ...DEFAULT_CONFIG, fillStrategy: 'pieces', fills: ['#f00', '#0f0', '#00f'], overlapFills: ['#fff', '#0ff', '#f0f'], overlapSeparate: true, fillOrder: 'depth', symmetry: false, clipMask: 'none' })
    const sc = await paperScope()
    try {
      let sumPieces = 0
      for (const s of shapes) { const p = new sc.CompoundPath(commandsToPathData(s.commands)); p.fillRule = 'nonzero'; sumPieces += Math.abs(p.area) }
      let uni: any = null
      for (const pl of placements) {
        const p = new sc.CompoundPath(SQUARE); const m = new sc.Matrix()
        m.translate(pl.x, pl.y); m.rotate(pl.rotate, new sc.Point(0, 0)); m.scale(pl.scale); p.transform(m)
        uni = uni ? uni.unite(p) : p
      }
      const unionArea = Math.abs(uni.area)
      // exact partition; allow a hair for boolean rounding
      expect(sumPieces / unionArea).toBeGreaterThan(0.97)
      expect(sumPieces / unionArea).toBeLessThan(1.03)
    } finally {
      sc.project.clear()
    }
  })

  it('crossingMode split makes each crossing its own piece (more pieces, ≥2 hues)', async () => {
    const count = 7, radius = 150
    const ring = Array.from({ length: count }, (_, i) => { const a = (i / count) * Math.PI * 2; return { x: Math.cos(a) * radius, y: Math.sin(a) * radius, scale: 1, rotate: 0, skew: 0 } })
    const base = { ...DEFAULT_CONFIG, shape: 'hexagon' as const, fillStrategy: 'pieces' as const, fills: ['#f00', '#0f0', '#00f'], overlapSeparate: false, fillOrder: 'rows' as const, symmetry: false, clipMask: 'none' as const }
    const depth = await composite(HEX, ring, { ...base, crossingMode: 'depth' })
    const split = await composite(HEX, ring, { ...base, crossingMode: 'split' })
    expect(split.length).toBeGreaterThan(depth.length)
    // crossings vary in split; in depth all same-depth crossings share one colour
    const splitPaints = new Set(split.map((s) => s.paint))
    expect(splitPaints.size).toBeGreaterThanOrEqual(3)
  })

  it('crossingMode split remains a DISJOINT partition (sum of piece areas ≈ union area)', async () => {
    const count = 9, radius = 40
    const placements = Array.from({ length: count }, (_, i) => {
      const a = (i / count) * Math.PI * 2
      return { x: Math.cos(a) * radius, y: Math.sin(a) * radius, scale: 1, rotate: (i * 360 / count) * 0.5, skew: 0 }
    })
    const shapes = await composite(SQUARE, placements, { ...DEFAULT_CONFIG, fillStrategy: 'pieces', fills: ['#f00', '#0f0', '#00f'], overlapFills: ['#fff', '#0ff', '#f0f'], overlapSeparate: true, fillOrder: 'depth', symmetry: false, clipMask: 'none', crossingMode: 'split' })
    const sc = await paperScope()
    try {
      let sumPieces = 0
      for (const s of shapes) { const p = new sc.CompoundPath(commandsToPathData(s.commands)); p.fillRule = 'nonzero'; sumPieces += Math.abs(p.area) }
      let uni: any = null
      for (const pl of placements) {
        const p = new sc.CompoundPath(SQUARE); const m = new sc.Matrix()
        m.translate(pl.x, pl.y); m.rotate(pl.rotate, new sc.Point(0, 0)); m.scale(pl.scale); p.transform(m)
        uni = uni ? uni.unite(p) : p
      }
      const unionArea = Math.abs(uni.area)
      expect(sumPieces / unionArea).toBeGreaterThan(0.97)
      expect(sumPieces / unionArea).toBeLessThan(1.03)
    } finally {
      sc.project.clear()
    }
  })

  it('split mode keeps an exact partition with ANNULAR crossings (dense ring)', async () => {
    // A tight ring: deep overlaps near the centre leave a depth-2 band that is a
    // RING around a deeper island (an annular face). Classifying faces by centroid
    // put that centroid in the ring's own hole → the ring was dropped and 3–7% of
    // the mark vanished (partition broken). Boundary-vertex classification fixes it.
    const count = 8, radius = 80
    const ring = Array.from({ length: count }, (_, i) => { const a = (i / count) * Math.PI * 2; return { x: Math.cos(a) * radius, y: Math.sin(a) * radius, scale: 1, rotate: 0, skew: 0 } })
    const shapes = await composite(HEX, ring, { ...DEFAULT_CONFIG, fillStrategy: 'pieces', crossingMode: 'split', fills: ['#f00', '#0f0', '#00f'], overlapSeparate: false, fillOrder: 'rows', symmetry: false, clipMask: 'none' })
    const sc = await paperScope()
    try {
      let sumPieces = 0
      for (const s of shapes) { const p = new sc.CompoundPath(commandsToPathData(s.commands)); p.fillRule = 'nonzero'; sumPieces += Math.abs(p.area) }
      let uni: any = null
      for (const pl of ring) { const p = new sc.CompoundPath(HEX); const m = new sc.Matrix(); m.translate(pl.x, pl.y); m.rotate(pl.rotate, new sc.Point(0, 0)); p.transform(m); uni = uni ? uni.unite(p) : p }
      const ratio = sumPieces / Math.abs(uni.area)
      expect(ratio).toBeGreaterThan(0.97)
      expect(ratio).toBeLessThan(1.03)
    } finally {
      sc.project.clear()
    }
  })

  it('split + separate overlap + spatial order colours crossings from overlapFills', async () => {
    // Exercises the split × overlapSeparate × spatial-order colour branch: solo from
    // `fills` (one colour here), crossings ranked through `overlapFills`.
    const count = 7, radius = 150
    const ring = Array.from({ length: count }, (_, i) => { const a = (i / count) * Math.PI * 2; return { x: Math.cos(a) * radius, y: Math.sin(a) * radius, scale: 1, rotate: 0, skew: 0 } })
    const shapes = await composite(HEX, ring, { ...DEFAULT_CONFIG, fillStrategy: 'pieces', crossingMode: 'split', fills: ['#111111'], overlapFills: ['#ff0000', '#00ff00', '#0000ff'], overlapSeparate: true, fillOrder: 'rows', symmetry: false, clipMask: 'none' })
    // solo pieces are all #111111 (single shape colour); crossings draw from the
    // overlapFills palette → at least two distinct overlap hues appear.
    const overlapHues = new Set(shapes.map((s) => s.paint).filter((p) => p !== '#111111'))
    expect(overlapHues.size).toBeGreaterThanOrEqual(2)
  })
})

describe('composite with a per-clone d list', () => {
  it('uses ds[i] for clone i in perClone mode', async () => {
    const TRI = 'M 0 -50 L 43 25 L -43 25 Z'
    const placements = [
      { x: -100, y: 0, scale: 1, rotate: 0, skew: 0 },
      { x: 100, y: 0, scale: 1, rotate: 0, skew: 0 },
    ]
    const cfg = { ...DEFAULT_CONFIG, fillStrategy: 'perClone' as const, fills: ['#ff0000', '#0000ff'], clipMask: 'none' as const, symmetry: false }
    const shapes = await composite([SQUARE, TRI], placements, cfg)
    expect(shapes).toHaveLength(2)
    // A square has 4 corners; a triangle 3 — count lineTo/bezier commands per shape.
    // (paperToCommands also emits a trailing closePath for a closed path — see
    // extrudeSolid.ts:141 — so that's excluded here alongside moveTo, which is
    // the one line this differs from the task-6 brief's verbatim test text.)
    const edgeCount = (i: number) => shapes[i]!.commands.filter(c => c.command !== 'moveTo' && c.command !== 'closePath').length
    expect(edgeCount(0)).toBe(4)
    expect(edgeCount(1)).toBe(3)
  })
})

describe('colour ramp + paint target', () => {
  const five = [
    { x: -200, y: 0, scale: 1, rotate: 0, skew: 0 },
    { x: -100, y: 0, scale: 1, rotate: 0, skew: 0 },
    { x: 0, y: 0, scale: 1, rotate: 0, skew: 0 },
    { x: 100, y: 0, scale: 1, rotate: 0, skew: 0 },
    { x: 200, y: 0, scale: 1, rotate: 0, skew: 0 },
  ]
  const base = { ...DEFAULT_CONFIG, fillStrategy: 'perClone' as const, fillOrder: 'created' as const, fills: ['#000000', '#ffffff'], clipMask: 'none' as const, symmetry: false }

  it('ramp: five clones over two fills give five distinct colours whose ends are the stops', async () => {
    const shapes = await composite(SQUARE, five, { ...base, fillCycle: 'ramp' })
    const cols = shapes.map(s => s.paint)
    expect(cols[0]).toBe('#000000')
    expect(cols[4]).toBe('#ffffff')
    expect(new Set(cols).size).toBe(5)
  })

  it('cycle (default) still alternates the two fills', async () => {
    const shapes = await composite(SQUARE, five, base)
    expect(shapes.map(s => s.paint)).toEqual(['#000000', '#ffffff', '#000000', '#ffffff', '#000000'])
  })

  it('outline: no fill, stroke takes the clone colour and the stroke width', async () => {
    const shapes = await composite(SQUARE, five, { ...base, paintTarget: 'outline', strokeWidth: 0.5 })
    for (const s of shapes) {
      expect(s.fill).toBeNull()
      expect(s.paint).toBeUndefined()
      expect(s.strokeWidth).toBe(0.5)
    }
    expect(shapes[0]!.stroke).toBe('#000000')
    expect(shapes[1]!.stroke).toBe('#ffffff')
  })

  it('both: fill and stroke both take the clone colour', async () => {
    const shapes = await composite(SQUARE, five, { ...base, paintTarget: 'both', strokeWidth: 2 })
    expect(shapes[1]!.fill).toBe('#ffffff')
    expect(shapes[1]!.stroke).toBe('#ffffff')
    expect(shapes[1]!.paint).toBe('#ffffff')
  })

  it('single mode outline: the fold is outlined in stroke ?? fill with no fill', async () => {
    const shapes = await composite(SQUARE, five.slice(0, 2), { ...DEFAULT_CONFIG, fillStrategy: 'single', fill: '#123456', stroke: null, paintTarget: 'outline', strokeWidth: 1, clipMask: 'none', symmetry: false })
    expect(shapes[0]!.fill).toBeNull()
    expect(shapes[0]!.stroke).toBe('#123456')
  })

  it('pieces mode ramps solo pieces by rank', async () => {
    const shapes = await composite(SQUARE, five.slice(0, 3), { ...base, fillStrategy: 'pieces', fillCycle: 'ramp', fills: ['#000000', '#ffffff'] })
    const solids = shapes.filter(s => typeof s.paint === 'string').map(s => s.paint as string)
    expect(solids).toContain('#000000')
    expect(solids).toContain('#ffffff')
  })

  it('single mode, default target: a user-set stroke outlines the fold but NOT the overlap piece (pre-task behaviour)', async () => {
    const two = [
      { x: -30, y: 0, scale: 1, rotate: 0, skew: 0 },
      { x: 30, y: 0, scale: 1, rotate: 0, skew: 0 },
    ]
    const shapes = await composite(SQUARE, two, { ...DEFAULT_CONFIG, fillStrategy: 'single', overlapMode: 'shape', stroke: '#ff0000', strokeWidth: 3, paintTarget: 'fill', clipMask: 'none', symmetry: false })
    expect(shapes).toHaveLength(2)
    expect(shapes[0]!.stroke).toBe('#ff0000')
    expect(shapes[1]!.stroke).toBeUndefined()
    expect(shapes[1]!.strokeWidth).toBeUndefined()
  })

  it('single mode, both target: the fold AND the overlap piece carry a fill and a stroke', async () => {
    const two = [
      { x: -30, y: 0, scale: 1, rotate: 0, skew: 0 },
      { x: 30, y: 0, scale: 1, rotate: 0, skew: 0 },
    ]
    const shapes = await composite(SQUARE, two, { ...DEFAULT_CONFIG, fillStrategy: 'single', overlapMode: 'shape', fill: '#123456', overlapFill: '#00ff00', stroke: null, strokeWidth: 2, paintTarget: 'both', clipMask: 'none', symmetry: false })
    expect(shapes).toHaveLength(2)
    // Fold: its own fill, outlined in the single-mode default stroke.
    expect(shapes[0]!.fill).toBe('#123456')
    expect(shapes[0]!.stroke).toBe('#000000')
    expect(shapes[0]!.strokeWidth).toBe(2)
    // Overlap piece: filled AND outlined in its own colour (no user stroke set).
    expect(shapes[1]!.fill).toBe('#00ff00')
    expect(shapes[1]!.stroke).toBe('#00ff00')
    expect(shapes[1]!.strokeWidth).toBe(2)
  })

  it('single mode, outline target: the overlap piece is outlined too, with no fill', async () => {
    const two = [
      { x: -30, y: 0, scale: 1, rotate: 0, skew: 0 },
      { x: 30, y: 0, scale: 1, rotate: 0, skew: 0 },
    ]
    const shapes = await composite(SQUARE, two, { ...DEFAULT_CONFIG, fillStrategy: 'single', overlapMode: 'shape', overlapFill: '#00ff00', stroke: null, strokeWidth: 2, paintTarget: 'outline', clipMask: 'none', symmetry: false })
    expect(shapes[1]!.fill).toBeNull()
    expect(shapes[1]!.stroke).toBe('#00ff00')
    expect(shapes[1]!.strokeWidth).toBe(2)
  })
})

describe('per-clone / pieces paint targets keep a GRADIENT clone colour on the outline', () => {
  const five = [-200, -100, 0, 100, 200].map((x) => ({ x, y: 0, scale: 1, rotate: 0, skew: 0 }))
  const G1 = { type: 'linear' as const, angle: 165, stops: [{ offset: 0, color: '#1a1a2e' }, { offset: 1, color: '#000000' }] }
  const G2 = { type: 'linear' as const, angle: 45, stops: [{ offset: 0, color: '#e5484d' }, { offset: 1, color: '#000000' }] }
  const base = { ...DEFAULT_CONFIG, fillStrategy: 'perClone' as const, fillOrder: 'created' as const, fills: [G1, G2], clipMask: 'none' as const, symmetry: false }

  it('outline: the stroke carries the clone gradient on strokePaint (the solid `stroke` is only a fallback)', async () => {
    const shapes = await composite(SQUARE, five, { ...base, paintTarget: 'outline', strokeWidth: 0.75 })
    expect(shapes[0]!.fill).toBeNull()
    expect(shapes[0]!.strokePaint).toEqual(G1)
    expect(shapes[1]!.strokePaint).toEqual(G2)
    expect(typeof shapes[0]!.stroke).toBe('string')
  })

  it('both: fill paint and stroke paint are the same clone gradient', async () => {
    const shapes = await composite(SQUARE, five, { ...base, paintTarget: 'both', strokeWidth: 2 })
    expect(shapes[1]!.paint).toEqual(G2)
    expect(shapes[1]!.strokePaint).toEqual(G2)
  })

  it('outline with a SOLID clone colour sets no strokePaint (solids ride `stroke` as before)', async () => {
    const shapes = await composite(SQUARE, five, { ...base, fills: ['#000000', '#ffffff'], paintTarget: 'outline' })
    expect(shapes[0]!.stroke).toBe('#000000')
    expect(shapes[0]!.strokePaint).toBeUndefined()
  })

  it('single mode outline with a gradient fill and no stroke outlines in that gradient', async () => {
    const shapes = await composite(SQUARE, five.slice(0, 2), { ...DEFAULT_CONFIG, fillStrategy: 'single', fill: G1, stroke: null, paintTarget: 'outline', strokeWidth: 1, clipMask: 'none', symmetry: false })
    expect(shapes[0]!.fill).toBeNull()
    expect(shapes[0]!.strokePaint).toEqual(G1)
  })
})
