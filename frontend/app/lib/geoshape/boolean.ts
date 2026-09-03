/**
 * geoshape boolean composite — the CORE of the 2D-vector geologo generator.
 *
 * Folds the arranged clones (Task 3's `ClonePlacement[]`) of one base shape
 * (Task 1's `d`) into the final mark via paper.js booleans, then applies the
 * user's key feature — overlapping clones read as either a HOLE (even-odd
 * negative space) or a NEW filled SHAPE — followed by symmetry mirroring and
 * a clip mask.
 *
 * paper.js hygiene follows `useVectorSvg.ts`'s `pathLayerBoolean` /
 * `extrudeSolid.ts`'s pattern exactly: lazy `import('paper')` (it touches
 * browser globals at import time, so it must not load during SSR), ONE
 * cached detached `PaperScope` (not the global `paper`, so its mutable state
 * stays out of the app), `setup(Size)` with no canvas element, and
 * `project.clear()` in a `finally` so a long session does not grow an
 * unbounded item tree.
 */
import { paperToCommands } from '~/lib/vectortype/extrudeSolid'
import { commandsToPathData, type VectorShape } from '~/lib/vector/svg'
import { rankOrder } from './order'
import { rampColour } from '~/lib/color/ramp'
import type { GeoShapeConfig } from './config'
import type { GeoOverlap } from './studio'
import type { ClonePlacement } from './arrange'
import type { Paint } from '~/lib/compositor/paint'
// Type-only: `render.ts` also imports `composite` from this module, so a
// value-level import back would be a cycle. `GeoVectorShape` is a type alias
// (erased at compile time), so this direction is safe.
import type { GeoVectorShape } from './render'

/** `Paint`'s solid-string arm passes straight through; a gradient/pattern/
 *  image/shader has no single representative colour, so `VectorShape.fill`
 *  (a reader that only understands solids) gets a plain fallback instead —
 *  the real paint travels on `.paint` (see `GeoVectorShape` in `render.ts`). */
const solidOf = (p: Paint): string => (typeof p === 'string' ? p : '#808080')

/** The colour clone/piece `rank` of `total` gets from `fills`: cycled (today) or
 *  read as a smooth ramp when `fillCycle` is 'ramp'. */
function cloneColour(fills: Paint[], rank: number, total: number, cfg: GeoShapeConfig): Paint {
  if (cfg.fillCycle === 'ramp') return rampColour(fills, total > 1 ? rank / (total - 1) : 0)
  return fills[rank % fills.length]!
}

/** Where a shape's colour lands, per `paintTarget`. `strokeColour` is the colour
 *  an outline takes — the clone's own colour in per-clone/pieces mode, the
 *  single stroke (or fill) in single mode. `fill: null` is an explicit
 *  fill="none": drawToCanvas reads `paint ?? fill` and skips a falsy value,
 *  toSvg writes none — so outline mode needs no renderer change. */
function styled(paint: Paint, cfg: GeoShapeConfig, strokeColour: string): Pick<GeoVectorShape, 'paint' | 'fill' | 'stroke' | 'strokeWidth'> {
  switch (cfg.paintTarget) {
    case 'outline':
      return { paint: undefined, fill: null, stroke: strokeColour, strokeWidth: cfg.strokeWidth || 1 }
    case 'both':
      return { paint, fill: solidOf(paint), stroke: strokeColour, strokeWidth: cfg.strokeWidth || 1 }
    default:
      return { paint, fill: solidOf(paint), stroke: cfg.stroke, strokeWidth: cfg.strokeWidth || undefined }
  }
}

// Pieces mode runs O(N²) paper.js boolean unions on the main thread (solo-piece
// subtraction + incremental depth-band folding, both nested loops over the clone
// set). Left uncapped, a high `count` (up to 200) freezes the tab for tens of
// seconds to minutes, so the post-symmetry clone set is capped here to keep the
// render interactive.
const PIECES_MAX_CLONES = 48

let _paperMod: typeof paper | null = null
let _scope: paper.PaperScope | null = null
async function paperScope(): Promise<paper.PaperScope> {
  if (!_paperMod) _paperMod = ((await import('paper')) as unknown as { default: typeof paper }).default
  if (!_scope) {
    _scope = new _paperMod.PaperScope()
    // Headless: a project needs a size; we never attach a real canvas.
    _scope.setup(new _scope.Size(1024, 1024))
  }
  _scope.activate()
  return _scope
}

const OP: Record<Exclude<GeoShapeConfig['fillMode'], 'evenodd'>, 'unite' | 'subtract' | 'intersect' | 'exclude'> = {
  unite: 'unite', subtract: 'subtract', intersect: 'intersect', exclude: 'exclude',
}

function hexClipD(r: number): string {
  let d = ''
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 3
    const x = r * Math.cos(a)
    const y = r * Math.sin(a)
    d += (i === 0 ? 'M' : 'L') + ` ${x} ${y}`
  }
  return d + ' Z'
}

/** Split one exact-depth band into connected FACES, each an outer contour with its
 *  holes re-attached (a hole is a deeper region subtracted out — it belongs to the
 *  deeper piece, so it must stay a hole here or the pieces stop being disjoint).
 *  A child is a hole iff a point on ITS OWN BOUNDARY sits inside an ODD number of
 *  sibling contours (crossings are one level deep; nested holes-in-holes are out of
 *  scope). We test a boundary VERTEX, not the centroid/interiorPoint: an annular
 *  outer (a ring around a deeper island) has its centroid in its OWN hole, so a
 *  centroid test would count the hole contour as containing it and wrongly drop the
 *  ring. Sibling contours never cross (they only nest), so any boundary vertex of a
 *  contour is unambiguously strictly inside or outside each sibling. */
function splitFaces(sc: paper.PaperScope, band: paper.PathItem): paper.PathItem[] {
  const anyBand = band as any
  if (band.className !== 'CompoundPath' || !anyBand.children || anyBand.children.length <= 1) return [band]
  const kids: paper.Path[] = anyBand.children.slice()
  const pt = (k: any): paper.Point => (k.segments && k.segments.length ? k.segments[0].point : k.bounds.center)
  const isHole = (i: number) => {
    let inside = 0
    for (let j = 0; j < kids.length; j++) { if (j !== i && (kids[j] as any).contains(pt(kids[i]))) inside++ }
    return inside % 2 === 1
  }
  const holeFlags = kids.map((_, i) => isHole(i))
  const faces: paper.PathItem[] = []
  kids.forEach((outer, i) => {
    if (holeFlags[i]) return
    const face = new sc.CompoundPath({ children: [outer.clone()] })
    kids.forEach((h, j) => { if (holeFlags[j] && (outer as any).contains(pt(h))) (face as any).addChild(h.clone()) })
    ;(face as any).fillRule = anyBand.fillRule ?? 'nonzero'
    faces.push(face as any)
  })
  return faces.length ? faces : [band]
}

/**
 * Fold `placements` clones of `baseD` into the final geologo mark.
 *
 * `evenodd` is a FILL RULE, not a paper.js boolean op: paper's `unite`
 * returns a nonzero-wound union, which for two clones sharing only a partial
 * overlap collapses to a single outer contour and loses the interior hole
 * the geologo's even-odd look depends on. So the `evenodd` branch skips the
 * boolean fold entirely — it assembles the raw (untouched, still-overlapping)
 * transformed clones as subpaths of ONE `CompoundPath` and lets the SVG/canvas
 * even-odd winding rule carve the overlap into negative space itself. Every
 * other `fillMode` maps straight onto a paper.js op and folds normally.
 *
 * `baseD` is ONE path for every clone (every layout but Blend) or ONE PATH PER
 * CLONE (Blend: `render.ts` hands in the morphed steps). The three fill
 * strategies below never look at `baseD` again — they work on `clones`.
 */
export async function composite(baseD: string | string[], placements: ClonePlacement[], cfg: GeoShapeConfig): Promise<GeoVectorShape[]> {
  const sc = await paperScope()
  const dFor = (i: number): string => typeof baseD === 'string' ? baseD : (baseD[i] ?? baseD[baseD.length - 1] ?? '')
  try {
    // 1. build a transformed paper path per placement
    const clones = placements.map((pl, i) => {
      const p = new sc.CompoundPath(dFor(i))
      const m = new sc.Matrix()
      m.translate(pl.x, pl.y)
      m.rotate(pl.rotate, new sc.Point(0, 0))
      if (pl.skew) m.shear(Math.tan((pl.skew * Math.PI) / 180), 0)
      m.scale(pl.scale)
      p.transform(m)
      return p
    })
    if (!clones.length) return []

    // PER-SHAPE FILL: each clone is its own filled shape cycling through cfg.fills.
    // No boolean fold and no even-odd holes (those need the unified single-path
    // fold); clones simply layer. Symmetry mirrors each clone inheriting its paint;
    // clip intersects each clone.
    if (cfg.fillStrategy === 'perClone') {
      const fills = cfg.fills.length ? cfg.fills : [cfg.fill]
      const band = Math.max(1, cfg.size)
      const ranks = rankOrder(placements.map((pl, i) => ({ cx: pl.x, cy: pl.y, i })), cfg.fillOrder, band)
      const total = placements.length
      let items: { path: paper.PathItem; paint: Paint }[] = clones.map((c, i) => ({ path: c as paper.PathItem, paint: cloneColour(fills, ranks[i]!, total, cfg) }))
      if (cfg.symmetry) {
        const sm = new sc.Matrix()
        if (cfg.symmetryAxis === 'vertical') sm.scale(-1, 1); else sm.scale(1, -1)
        sm.translate(cfg.symmetryAxis === 'vertical' ? cfg.symmetrySpacing : 0, cfg.symmetryAxis === 'horizontal' ? cfg.symmetrySpacing : 0)
        const mirrored = items.map(({ path, paint }) => { const mc = path.clone(); mc.transform(sm); return { path: mc as paper.PathItem, paint } })
        items = items.concat(mirrored)
      }
      if (cfg.clipMask !== 'none') {
        const r = cfg.clipMaskSize
        const clip = cfg.clipMask === 'circle'
          ? new sc.Path.Circle(new sc.Point(0, 0), r)
          : cfg.clipMask === 'square'
            ? new sc.Path.Rectangle(new sc.Rectangle(-r, -r, 2 * r, 2 * r))
            : new sc.CompoundPath(hexClipD(r))
        items = items.map(({ path, paint }) => ({ path: (path as any).intersect(clip) as paper.PathItem, paint }))
        clip.remove()
      }
      return items
        .filter(({ path }) => path && path.bounds && path.bounds.width > 1e-6 && path.bounds.height > 1e-6)
        .map(({ path, paint }) => ({
          commands: paperToCommands(path),
          ...styled(paint, cfg, solidOf(paint)),
          fillRule: 'nonzero' as const,
        }))
    }

    if (cfg.fillStrategy === 'pieces') {
      const fills = cfg.fills.length ? cfg.fills : [cfg.fill]
      const nonEmpty = (p: any): boolean => !!(p && p.bounds && p.bounds.width > 1e-6 && p.bounds.height > 1e-6)

      // Symmetry: mirror the clones BEFORE splitting so the split sees the full set.
      let cl = clones as paper.PathItem[]
      if (cfg.symmetry) {
        const sm = new sc.Matrix()
        if (cfg.symmetryAxis === 'vertical') sm.scale(-1, 1); else sm.scale(1, -1)
        sm.translate(cfg.symmetryAxis === 'vertical' ? cfg.symmetrySpacing : 0, cfg.symmetryAxis === 'horizontal' ? cfg.symmetrySpacing : 0)
        const mir = clones.map((c) => { const mc = c.clone(); mc.transform(sm); return mc as paper.PathItem })
        cl = (clones as paper.PathItem[]).concat(mir)
      }
      // Soft cap AFTER the (possibly mirror-doubled) clone set is finalized: pieces
      // mode's solo + depth-band loops below are both O(N²), so bound N before either
      // runs rather than silently dropping clones without a trace.
      if (cl.length > PIECES_MAX_CLONES) {
        console.warn(`geoshape pieces mode: capping ${cl.length} clones to ${PIECES_MAX_CLONES} for performance`)
        cl = cl.slice(0, PIECES_MAX_CLONES)
      }
      const N = cl.length

      type Piece = { path: paper.PathItem; cx: number; cy: number; depth: number }

      // 1. solo pieces: clone_i − union(others)
      const solo: Piece[] = []
      for (let i = 0; i < N; i++) {
        let others: any = null
        for (let j = 0; j < N; j++) {
          if (j === i) continue
          others = others ? others.unite(cl[j]) : (cl[j] as any).clone()
        }
        const s = others ? (cl[i] as any).subtract(others) : (cl[i] as any).clone()
        if (nonEmpty(s)) solo.push({ path: s, cx: s.bounds.center.x, cy: s.bounds.center.y, depth: 1 })
      }

      // 2. overlap depth bands (depth ≥ 2). Build NESTED "covered by ≥ k clones"
      // sets, then subtract adjacent levels: exact-depth-d = atLeast[d] − atLeast[d+1].
      // Subtracting nested sets is numerically stable. The old promote/demote chain
      // (subtract + intersect + unite per clone per depth) let paper.js booleans drift
      // into heavily OVERLAPPING, non-disjoint bands as overlap depth grew — measured
      // 40–75% area over-count — so a many-clone mark's deep centre rendered as a
      // pile of wrong-coloured, mutually-occluding pieces.
      //
      // atLeast[k-1] = region covered by ≥ k clones. Adding clone c promotes the
      // region already at ≥(k-1) that c also covers up to ≥k: atLeast[k] ∪= (≥(k-1)) ∩ c
      // (≥0 is everywhere, so k=1 folds to c itself). Descend k so each level reads the
      // pre-clone value of the shallower level it depends on.
      const atLeast: (paper.PathItem | null)[] = []
      for (const c of cl) {
        for (let k = atLeast.length + 1; k >= 1; k--) {
          const lower = k >= 2 ? atLeast[k - 2] : null
          if (k >= 2 && !nonEmpty(lower)) continue
          const add = lower ? (lower as any).intersect(c) : (c as any).clone()
          if (!nonEmpty(add)) continue
          atLeast[k - 1] = atLeast[k - 1] ? (atLeast[k - 1] as any).unite(add) : add
        }
      }
      // exact-depth bands (depth ≥ 2) from the nested atLeast sets — as today.
      const depthBands: { path: paper.PathItem; depth: number }[] = []
      for (let d = 2; d <= atLeast.length; d++) {
        const cur = atLeast[d - 1]; if (!nonEmpty(cur)) continue
        const deeper = atLeast[d]
        const band = nonEmpty(deeper) ? (cur as any).subtract(deeper) : (cur as any)
        if (nonEmpty(band)) depthBands.push({ path: band as paper.PathItem, depth: d })
      }
      // crossings: one Piece per depth band (depth mode) or per connected face (split mode)
      const overlaps: Piece[] = []
      for (const { path, depth } of depthBands) {
        const parts = cfg.crossingMode === 'split' ? splitFaces(sc, path) : [path]
        for (const p of parts) {
          if (!nonEmpty(p)) continue
          overlaps.push({ path: p, cx: (p as any).bounds.center.x, cy: (p as any).bounds.center.y, depth })
        }
      }

      // 3. colouring
      const bandSize = solo.length
        ? [...solo].map((p) => Math.max(p.path.bounds.width, p.path.bounds.height)).sort((a, b) => a - b)[Math.floor(solo.length / 2)]!
        : Math.max(1, cfg.size)
      const soloRanks = cfg.fillOrder === 'depth'
        ? solo.map(() => 0)
        : rankOrder(solo.map((p, i) => ({ cx: p.cx, cy: p.cy, i })), cfg.fillOrder, bandSize)
      const colored: { path: paper.PathItem; paint: Paint }[] = []
      const ov = cfg.overlapSeparate ? (cfg.overlapFills.length ? cfg.overlapFills : fills) : null
      const spatial = cfg.fillOrder !== 'depth' && cfg.fillOrder !== 'created'
      if (cfg.crossingMode === 'split' && !cfg.overlapSeparate && spatial) {
        // ALL pieces (solo + crossings) flow through `fills` as one ordered sequence.
        const all = [...solo, ...overlaps]
        const ranks = rankOrder(all.map((p, i) => ({ cx: p.cx, cy: p.cy, i })), cfg.fillOrder, bandSize)
        all.forEach((p, i) => colored.push({ path: p.path, paint: cloneColour(fills, ranks[i]!, all.length, cfg) }))
      } else {
        // solo coloured by order (as today)
        solo.forEach((p, i) => colored.push({ path: p.path, paint: cloneColour(fills, soloRanks[i]!, solo.length, cfg) }))
        if (cfg.crossingMode === 'split' && cfg.overlapSeparate && spatial) {
          const ranks = rankOrder(overlaps.map((p, i) => ({ cx: p.cx, cy: p.cy, i })), cfg.fillOrder, bandSize)
          overlaps.forEach((p, i) => colored.push({ path: p.path, paint: ov![ranks[i]! % ov!.length]! }))
        } else {
          // depth-indexed (depth mode, or split with depth/created order)
          overlaps.forEach((p) => {
            const paint = cfg.overlapSeparate ? ov![(p.depth - 2) % ov!.length]! : fills[(p.depth - 1) % fills.length]!
            colored.push({ path: p.path, paint })
          })
        }
      }

      // 4. clip mask
      let clipped = colored
      if (cfg.clipMask !== 'none') {
        const r = cfg.clipMaskSize
        const clip = cfg.clipMask === 'circle'
          ? new sc.Path.Circle(new sc.Point(0, 0), r)
          : cfg.clipMask === 'square'
            ? new sc.Path.Rectangle(new sc.Rectangle(-r, -r, 2 * r, 2 * r))
            : new sc.CompoundPath(hexClipD(r))
        clipped = colored.map(({ path, paint }) => ({ path: (path as any).intersect(clip) as paper.PathItem, paint }))
        clip.remove()
      }

      return clipped
        .filter(({ path }) => nonEmpty(path))
        .map(({ path, paint }) => ({
          commands: paperToCommands(path),
          ...styled(paint, cfg, solidOf(paint)),
          fillRule: 'nonzero' as const,
        }))
    }

    const isEvenOdd = cfg.fillMode === 'evenodd'

    // Symmetry for evenodd is applied at the clone level (mirror every clone and
    // add the copies) rather than uniting the composited result: uniting a
    // self-overlapping evenodd compound is undefined in paper's boolean resolver
    // (it ignores fillRule) and empties the mark. mirror(A∪B) = mirror(A)∪mirror(B),
    // so this is equivalent for evenodd and safe.
    //
    // For subtract/exclude/intersect this clone-level approach is WRONG: running
    // mirrored clones through the same fold chain is not the same as mirroring the
    // finished mark (e.g. subtract is order-dependent and non-distributive over
    // mirroring), and it can yield empty geometry. Those modes instead fold the
    // originals first, then mirror-and-union the resolved result below (step 3.5).
    if (cfg.symmetry && isEvenOdd) {
      const sm = new sc.Matrix()
      if (cfg.symmetryAxis === 'vertical') sm.scale(-1, 1); else sm.scale(1, -1)
      sm.translate(
        cfg.symmetryAxis === 'vertical' ? cfg.symmetrySpacing : 0,
        cfg.symmetryAxis === 'horizontal' ? cfg.symmetrySpacing : 0,
      )
      const mirrored = clones.map((c) => { const mc = c.clone(); mc.transform(sm); return mc })
      clones.push(...mirrored)
    }

    // 2. overlap-as-shape: the region covered by >=2 clones = union of
    // pairwise intersections, computed off the RAW clones BEFORE the fold
    // below — `intersect` does not consume its operands, but the evenodd
    // branch of the fold reparents each clone's children (see step 3), which
    // would leave nothing here to intersect if this ran after it.
    let overlap: paper.PathItem | null = null
    if (cfg.overlapMode === 'shape' && clones.length >= 2) {
      for (let i = 0; i < clones.length; i++) {
        for (let j = i + 1; j < clones.length; j++) {
          const inter = (clones[i] as any).intersect(clones[j])
          if (inter && inter.bounds && inter.bounds.width > 1e-6 && inter.bounds.height > 1e-6) {
            overlap = overlap ? (overlap as any).unite(inter) : inter
          } else {
            inter?.remove?.()
          }
        }
      }
    }

    // 3. fold geometry: evenodd keeps every clone as its own subpath (no
    // boolean fold, so overlaps stay as overlaps for the winding rule to
    // carve); every other fillMode folds via the matching paper.js op.
    let acc: paper.PathItem
    if (isEvenOdd) {
      const cp = new sc.CompoundPath({ children: [] })
      for (const c of clones) {
        // Reparent each clone's own children (a CompoundPath's subpaths, or
        // a lone Path) onto one CompoundPath so they become subpaths of a
        // single item — required for one fill-rule to govern all of them.
        const kids = c.className === 'CompoundPath' ? [...(c.children ?? [])] : [c]
        for (const k of kids) cp.addChild(k)
      }
      cp.fillRule = 'evenodd'
      acc = cp
    } else {
      const op = OP[cfg.fillMode as Exclude<GeoShapeConfig['fillMode'], 'evenodd'>]
      acc = clones[0] as paper.PathItem
      for (let i = 1; i < clones.length; i++) {
        const next = clones[i] as paper.PathItem
        const combined = (acc as any)[op](next)
        acc = combined
      }
    }

    // 3.5. symmetry for subtract/exclude/intersect: fold the originals into the
    // mark first (step 3, above), THEN union the resolved mark with its mirror.
    // Mirroring the finished mark is the correct "symmetry" for these ops —
    // mirroring the inputs and re-running them through the same fold chain (as
    // evenodd does) is not equivalent for subtract/exclude/intersect and can
    // empty the geometry.
    if (cfg.symmetry && !isEvenOdd) {
      const mirrorItem = (item: any) => {
        const sm = new sc.Matrix()
        if (cfg.symmetryAxis === 'vertical') sm.scale(-1, 1); else sm.scale(1, -1)
        sm.translate(cfg.symmetryAxis === 'vertical' ? cfg.symmetrySpacing : 0, cfg.symmetryAxis === 'horizontal' ? cfg.symmetrySpacing : 0)
        const mi = item.clone(); mi.transform(sm); return item.unite(mi)
      }
      acc = mirrorItem(acc)
      if (overlap) overlap = mirrorItem(overlap)
    }

    // 4. clip mask: intersect the accumulated geometry (and overlap, if any)
    // with a centered circle/square/hexagon.
    if (cfg.clipMask !== 'none') {
      const r = cfg.clipMaskSize
      const clip = cfg.clipMask === 'circle'
        ? new sc.Path.Circle(new sc.Point(0, 0), r)
        : cfg.clipMask === 'square'
          ? new sc.Path.Rectangle(new sc.Rectangle(-r, -r, 2 * r, 2 * r))
          : new sc.CompoundPath(hexClipD(r))
      acc = (acc as any).intersect(clip)
      if (overlap) overlap = (overlap as any).intersect(clip)
      clip.remove()
    }

    // 5. paper → VectorShape[]. evenodd sets the fill-rule; shape mode adds
    // the overlap as a second shape painted with `overlapFill`.
    const fillRule: 'evenodd' | 'nonzero' = cfg.fillMode === 'evenodd' ? 'evenodd' : 'nonzero'
    const singleStroke = cfg.paintTarget === 'outline' ? (cfg.stroke ?? solidOf(cfg.fill)) : (cfg.stroke ?? '#000000')
    const out: GeoVectorShape[] = [{
      commands: paperToCommands(acc),
      ...styled(cfg.fill, cfg, singleStroke),
      fillRule,
    }]
    if (overlap) {
      // Default target: the overlap piece was never outlined before paintTarget
      // existed, so it keeps carrying no stroke — a user-set `stroke` outlines
      // the fold, not the crossing. Outline/both target the crossing too.
      const ov = cfg.paintTarget === 'fill'
        ? { paint: cfg.overlapFill, fill: solidOf(cfg.overlapFill) }
        : styled(cfg.overlapFill, cfg, cfg.stroke ?? solidOf(cfg.overlapFill))
      out.push({ commands: paperToCommands(overlap), ...ov, fillRule: 'nonzero' })
    }
    return out
  } finally {
    sc.project.clear()
  }
}

// ── Cross-layer intersection faces (Shape Studio layers) ─────────────────────────
const nonEmptyItem = (p: any): boolean => !!(p && p.bounds && p.bounds.width > 1e-6 && p.bounds.height > 1e-6)

/**
 * The regions where STACKED LAYERS cross, coloured by the stack-level overlap
 * palette — the layered-studio counterpart of a single mark's `pieces` overlap
 * colouring (this reuses the exact same numerically-stable nested-`atLeast` depth
 * bands + `rankOrder` logic, just fed one silhouette PER LAYER instead of per clone).
 *
 * `layerShapes` is each ENABLED layer's already-composed, already-offset shapes; a
 * layer's silhouette is the union of its shapes (internal evenodd holes are folded
 * in — cross-layer overlap reads the layer's outer painted area, a deliberate v1
 * simplification). Returns paintable faces to CONCATENATE AFTER the layers so they
 * overpaint the intersections. Empty unless ≥2 layers actually overlap.
 */
export async function overlapFaces(layerShapes: VectorShape[][], overlap: GeoOverlap): Promise<GeoVectorShape[]> {
  const withShapes = layerShapes.filter((s) => s.length > 0)
  if (withShapes.length < 2 || overlap.fills.length === 0) return []
  const sc = await paperScope()
  try {
    // 1. one silhouette per layer = union of that layer's shapes.
    const sils: paper.PathItem[] = []
    for (const shapes of withShapes) {
      let sil: any = null
      for (const s of shapes) {
        const d = commandsToPathData(s.commands)
        if (!d) continue
        const p = new sc.CompoundPath(d)
        sil = sil ? sil.unite(p) : p
      }
      if (nonEmptyItem(sil)) sils.push(sil as paper.PathItem)
    }
    if (sils.length < 2) return []

    // 2. exact-depth bands (depth ≥ 2) from nested "covered by ≥ k layers" sets —
    //    the same stable construction the in-mark pieces path uses.
    const atLeast: (paper.PathItem | null)[] = []
    for (const c of sils) {
      for (let k = atLeast.length + 1; k >= 1; k--) {
        const lower = k >= 2 ? atLeast[k - 2] : null
        if (k >= 2 && !nonEmptyItem(lower)) continue
        const add = lower ? (lower as any).intersect(c) : (c as any).clone()
        if (!nonEmptyItem(add)) continue
        atLeast[k - 1] = atLeast[k - 1] ? (atLeast[k - 1] as any).unite(add) : add
      }
    }
    const bands: { path: paper.PathItem; depth: number }[] = []
    for (let d = 2; d <= atLeast.length; d++) {
      const cur = atLeast[d - 1]; if (!nonEmptyItem(cur)) continue
      const deeper = atLeast[d]
      const band = nonEmptyItem(deeper) ? (cur as any).subtract(deeper) : cur
      if (nonEmptyItem(band)) bands.push({ path: band as paper.PathItem, depth: d })
    }
    if (!bands.length) return []

    // 3. faces: one per band (depth mode) or per connected component (split mode).
    const faces: { path: paper.PathItem; depth: number }[] = []
    for (const { path, depth } of bands) {
      const parts = overlap.crossingMode === 'split' ? splitFaces(sc, path) : [path]
      for (const p of parts) if (nonEmptyItem(p)) faces.push({ path: p, depth })
    }

    // 4. colour by the overlap palette + order-logic. depth = by overlap depth
    //    (2-deep → fills[0]); created = sequential; anything spatial → rankOrder.
    const fills = overlap.fills
    let ranks: number[]
    if (overlap.order === 'depth') {
      ranks = faces.map((f) => f.depth - 2)
    } else if (overlap.order === 'created') {
      ranks = faces.map((_, i) => i)
    } else {
      const band = Math.max(1, ...faces.map((f) => Math.max((f.path as any).bounds.width, (f.path as any).bounds.height)))
      ranks = rankOrder(
        faces.map((f, i) => ({ cx: (f.path as any).bounds.center.x, cy: (f.path as any).bounds.center.y, i })),
        overlap.order, band,
      )
    }
    const pick = (r: number): Paint => fills[((r % fills.length) + fills.length) % fills.length]!

    return faces
      .filter((f) => nonEmptyItem(f.path))
      .map((f, i) => {
        const paint = pick(ranks[i] ?? 0)
        return {
          commands: paperToCommands(f.path),
          paint,
          fill: solidOf(paint),
          stroke: null,
          fillRule: 'nonzero' as const,
        }
      })
  } finally {
    sc.project.clear()
  }
}
