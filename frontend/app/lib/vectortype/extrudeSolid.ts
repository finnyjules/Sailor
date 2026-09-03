/**
 * Vector Type — the SOLID extrude: the offset copies fused into ONE body.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS MODULE MUST NEVER BE CALLED FROM A DRAW LOOP.  (plan trap 5)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A boolean union is orders of magnitude more expensive than drawing. Task 4
 * measured one offset copy at **2.25 µs** to fill — 800 copies is 3.1 ms, a
 * playable frame. Uniting those same 800 copies is not a frame; it is not close
 * to a frame. So:
 *
 *   - **live preview draws the un-unioned stack.** `canvas.ts` gets `solid`
 *     handed to it as already-computed geometry and simply has none on any live
 *     path, so it falls through to the copies. Nothing degrades, nothing waits.
 *   - **the union runs on BAKE and EXPORT.** One frame, once, awaited.
 *
 * That boundary is not just a comment — it is three structural facts, each of
 * which alone would stop this being reachable from a draw loop:
 *
 *  1. **`canvas.ts` does not import this module.** The import edge runs the other
 *     way: this file imports `canvas.ts`. Adding a call to the renderer would
 *     mean adding an import that creates a cycle, which is a thing a reviewer
 *     sees. A unit test asserts the render path's import graph never reaches
 *     `paper`.
 *  2. **Everything here is `async`** (paper.js is lazily imported, so it cannot
 *     be otherwise), and `drawVectorType` is **synchronous**. A sync function
 *     cannot await a promise. The only way in is a caller that already has one.
 *  3. **The renderer's input is a `ReadonlyMap` of plain commands**
 *     (`VtSolidBodies`, declared in the pure `./extrude.ts`), not a callback.
 *     There is no function for a draw loop to call even by accident.
 *
 * The precedent is `resolveField`: a cache-owned canvas that must not be copied
 * per frame, where the one legitimate copy — the SVG export — is gated and
 * commented for exactly this reason.
 *
 * ## paper.js hygiene — `useVectorSvg.ts`'s pattern, followed exactly
 *
 * Lazy `await import('paper')` (it touches browser globals at import time, so it
 * must not load during SSR, and its ~300kb must stay out of the initial bundle),
 * ONE cached detached `PaperScope` rather than the global `paper` (so paper's
 * mutable state stays out of the app), `setup(Size)` with **no canvas element at
 * all**, and `project.clear()` after every operation so a long bake does not grow
 * an unbounded item tree.
 *
 * ## What the union is taken OVER: one (layer, glyph) at a time
 *
 * The unit is a GLYPH's copies, not the whole run's, and that is a decision:
 * every per-glyph thing the renderer does — the motion transform, the cell clip,
 * the blur, the glyph paint anchor — attaches to a glyph, so a run-wide body
 * would have to throw all four away the moment any motion was on. The copies of
 * one letter overlap each other heavily (that is what an extrude IS); copies of
 * ADJACENT letters overlap only when `depth × distance` exceeds the letter
 * spacing. So the per-glyph union removes the overwhelming majority of the
 * overlap and is correct under motion, where a run-wide one is neither.
 * `unionCommandLists` below is grouping-agnostic, so a run-wide union for a
 * static export is one call away if it is ever wanted.
 */
import type { VectorCommand } from '~/lib/vector/svg'
import { commandsToPathData } from '~/lib/vector/svg'
import { vtSolidKey, extrudeCopyCommands, type VtExtrudeCopy, type VtSolidBodies } from './extrude'
import { peekSolidBody, putSolidBody, solidBodyCacheKey } from './extrudeBodyCache'
import type { VectorTypeConfig } from './config'
import type { VtFont } from './font'
import { glyphTransform as glyphPlacement, placeOutlines } from './render'
import { vectorTypeFrame, vtPlacement, vtSolidExtrudeLayers, type VtBoxOptions } from './canvas'

// ── paper, headless ─────────────────────────────────────────────────────────
// Byte-for-byte the arrangement `useVectorSvg.ts` documents: lazy import, one
// detached scope, a project sized so paper has somewhere to put items, and no
// canvas element is ever created or attached.
// The GLOBAL `paper` namespace is the type source, not the default import's
// alias: paper's own `.d.ts` declares `declare namespace paper { … }` for the
// types and `declare module 'paper' { export = paperFull }` for the value, so
// `typeof <alias>` is a PaperScope INSTANCE and cannot be used as a namespace.
// (`useVectorSvg.ts` does exactly that, which is why `vue-tsc` prints thirteen
// "Cannot find namespace 'Paper'" errors against it. Same runtime, correct types.)
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

const isZeroHandle = (h: paper.Point | null | undefined): boolean =>
  !h || (h.x === 0 && h.y === 0)

/**
 * A paper `Path`/`CompoundPath` → our command list.
 *
 * Read from `segments` rather than by parsing `getPathData()`: paper's own
 * writer emits relative commands and arcs we would then have to re-parse, and
 * every round trip through a formatted string is a quantisation the canvas and
 * the SVG would disagree about. A segment pair is exactly one cubic — or a
 * `lineTo` when both handles are zero, which keeps a block shadow's straight
 * flanks straight instead of turning every edge into a degenerate bezier.
 *
 * A CompoundPath's children become successive subpaths of ONE command list, so
 * holes survive as holes under `nonzero` — a solid extrude of an 'A' still has
 * whatever is left of its counter.
 */
export function paperToCommands(item: paper.PathItem | null | undefined): VectorCommand[] {
  if (!item) return []
  const parts: paper.Path[] = item.className === 'CompoundPath'
    ? ((item.children ?? []) as paper.Path[])
    : [item as paper.Path]

  const out: VectorCommand[] = []
  for (const p of parts) {
    const segs = p?.segments
    if (!segs || segs.length < 2) continue
    const n = segs.length
    const first = segs[0] as paper.Segment
    out.push({ command: 'moveTo', args: [first.point.x, first.point.y] })
    // A closed path also emits the segment that returns to the start; an open
    // one stops one short. `unite` always returns closed contours, but reading
    // `closed` rather than assuming it keeps this honest if it ever does not.
    const last = p.closed ? n : n - 1
    for (let i = 0; i < last; i++) {
      const a = segs[i] as paper.Segment
      const b = segs[(i + 1) % n] as paper.Segment
      if (isZeroHandle(a.handleOut) && isZeroHandle(b.handleIn)) {
        out.push({ command: 'lineTo', args: [b.point.x, b.point.y] })
      } else {
        out.push({
          command: 'bezierCurveTo',
          args: [
            a.point.x + a.handleOut.x, a.point.y + a.handleOut.y,
            b.point.x + b.handleIn.x, b.point.y + b.handleIn.y,
            b.point.x, b.point.y,
          ],
        })
      }
    }
    if (p.closed) out.push({ command: 'closePath', args: [] })
  }
  return out
}

/**
 * How many SUBPATHS a command list has — one per `moveTo`.
 *
 * The number that says "this is one body": N un-unioned copies of an 'S' have N
 * subpaths, and their union has 1. It is exported because that is the whole
 * observable claim of this feature and a caller (or a test) should be able to
 * assert it rather than take it on trust.
 */
export function subpathCount(commands: readonly VectorCommand[]): number {
  let n = 0
  for (const c of commands) if (c?.command === 'moveTo') n++
  return n
}

/**
 * Union a group of command lists into ONE.
 *
 * Grouping-agnostic on purpose: hand it one glyph's offset copies and it returns
 * that glyph's solid body; hand it a whole run's and it returns the run's. The
 * accumulation is linear (`a ∪ b ∪ c …`) rather than pairwise-balanced because
 * offset copies overlap in a chain — each new copy meets the accumulated mass at
 * one end — so a balanced tree buys nothing and costs the same total work.
 *
 * Returns `[]` when there is nothing to unite, and — deliberately — the SINGLE
 * input unchanged when there is only one, rather than paying paper for a
 * round trip that cannot change the geometry.
 *
 * Never throws: a paper failure logs and returns `[]`, and the caller's map then
 * has no body for that glyph, so the renderer falls back to the un-unioned
 * copies. A solid extrude that silently renders as a translucent stack is a
 * visible, recoverable wrong; a bake that throws loses the user's render.
 */
export async function unionCommandLists(
  lists: ReadonlyArray<readonly VectorCommand[]>,
): Promise<VectorCommand[]> {
  const usable = lists.filter(l => l && l.length > 1)
  if (!usable.length) return []
  if (usable.length === 1) return usable[0]!.map(c => ({ command: c.command, args: [...c.args] }))

  const sc = await paperScope()
  const made: paper.PathItem[] = []
  try {
    // 6 decimals on a coordinate that is already OUTPUT PIXELS — a millionth of
    // a pixel, far below anything the union's own tolerance can distinguish, and
    // enough that two copies which should coincide exactly still do.
    const toPaper = (cmds: readonly VectorCommand[]) => {
      const p = new sc.CompoundPath(commandsToPathData(cmds, 6))
      // NOTE: no `fillRule` is set on the operands, and that is a finding rather
      // than an omission. paper 0.12's boolean resolver computes its own winding
      // from contour orientation and ignores the operands' `fillRule` entirely —
      // probed both ways here, and the unioned commands, the subpath counts and
      // a counter-bearing 'a''s hole are byte-identical under `nonzero` and
      // `evenodd`. Setting it would be a line whose comment claimed a behaviour
      // it does not have. The RESULT is consumed as nonzero (that is what both
      // renderers fill glyph counters with), and the counter test pins it.
      made.push(p)
      return p
    }
    let acc: paper.PathItem = toPaper(usable[0]!)
    for (let i = 1; i < usable.length; i++) {
      const next = toPaper(usable[i]!)
      const combined = acc.unite(next) as paper.PathItem
      made.push(combined)
      acc = combined
    }
    const out = paperToCommands(acc)
    return out
  } catch (err) {
    console.error('[vectortype] solid extrude union failed:', err)
    return []
  } finally {
    // Remove what we made, then clear the project: a bake sweeping 300 frames
    // must not grow paper's item tree by 300 × depth × glyphs.
    for (const p of made) { try { p.remove() } catch { /* already gone */ } }
    sc.project.clear()
  }
}

/**
 * ONE glyph's offset copies, unioned into one body.
 *
 * `commands` is the glyph's PLACED path (what `placeOutlines` returns — output
 * space, y already flipped, motion NOT applied), and the copies are stepped with
 * the SAME `extrudeCopyTransform` the canvas draws them with, so the body cannot
 * drift from the preview it replaces.
 *
 * There is no copy at offset zero, exactly as in the un-unioned stack: the face
 * is whatever fill layer sits above the extrude, and including it here would
 * make a solid extrude quietly bigger than the stack it fuses.
 */
export async function solidExtrudeBody(
  commands: readonly VectorCommand[],
  copies: ReadonlyArray<VtExtrudeCopy>,
  origin: { x: number; y: number; rotate?: number },
  advance: number,
): Promise<VectorCommand[]> {
  if (!commands.length || !copies.length) return []
  // The copy list is built by `extrudeCopyCommands` — the SAME function the SVG
  // export flatMaps a glyph with — so the body and the exported copies cannot be
  // two different sets of copies.
  return unionCommandLists(extrudeCopyCommands(commands, copies, origin, advance))
}

// ── The frame cache: what makes a VIDEO bake affordable — AND what the live
//    path reads ───────────────────────────────────────────────────────────────
//
// A union costs ~1.3 ms PER COPY in the browser. Task 4's worst realistic case
// is 800 copies — 1,123 ms — and a video bake would pay that on EVERY FRAME:
// over two minutes for 120 frames, five for 300. That is the one door plan
// trap 5 could come back through, and Task 5 flagged it as undecided.
//
// It is decided, and the decision is: **cache, because extrude geometry is
// time-invariant unless something feeding it is animated.** The union's inputs
// are exactly four — the glyph's placed commands, the copy list, the glyph's
// origin and its advance — so a frame whose four are unchanged has, by
// construction, the same body. Nothing about `t` enters the computation except
// through those four. The key IS those four, verbatim.
//
// **The store itself lives in `./extrudeBodyCache.ts`, which imports no paper.**
// That split is what lets `canvas.ts` READ a body — to stroke its silhouette —
// without its import graph ever reaching the geometry library. This module is
// the only WRITER, because it is the only module that can produce one. See that
// file for the full reasoning; what stays here is the `await`.

/**
 * `solidExtrudeBody`, memoised on its inputs — the form a SEQUENCE bake calls,
 * and the only thing that ever fills the cache the live path peeks at.
 *
 * Identical geometry to the uncached call, always: the key is the whole input,
 * so a hit is a frame that would have produced this exact body anyway. Returns
 * the cached array BY REFERENCE (the writer and the renderer both only read it);
 * a caller that intends to mutate a body must copy it.
 */
export async function solidExtrudeBodyCached(
  commands: readonly VectorCommand[],
  copies: readonly VtExtrudeCopy[],
  origin: { x: number; y: number; rotate?: number },
  advance: number,
): Promise<VectorCommand[]> {
  if (!commands.length || !copies.length) return []
  const key = solidBodyCacheKey(commands, copies, origin, advance)
  const hit = peekSolidBody(key)
  if (hit) return hit
  const body = await solidExtrudeBody(commands, copies, origin, advance)
  // A FAILED union (`[]`, see `unionCommandLists`'s catch) is not stored — that
  // rule is `putSolidBody`'s, so the writer cannot forget it.
  putSolidBody(key, body)
  return body
}

// Re-exported so the cache's lifecycle is reachable from the module that owns
// the union, which is where a caller looks for it. The implementations are in
// the paper-free store.
export {
  clearSolidExtrudeCache,
  peekSolidBody,
  solidBodyCacheKey,
  solidExtrudeCacheSize,
} from './extrudeBodyCache'

/**
 * Every solid extrude in `cfg`, unioned for the frame at time `t`.
 *
 * **The one entry point a bake or an export calls, and the ONLY place the
 * union is reached from.** `await` it, then hand the result to
 * `drawVectorType`/`drawVectorTypeToCanvas` as `opts.solid`. Omit that option —
 * as every live path does — and the same config draws the un-unioned stack.
 *
 * It re-derives the frame from `(font, cfg, t)` rather than taking a `VtFrame`,
 * for the same reason `vectorTypeSVG` does: those three inputs are what the
 * caller has, `vectorTypeFrame` is deterministic in them, and a caller passing a
 * frame built at a DIFFERENT time is a class of bug this signature cannot
 * express. The copies themselves come from `vtSolidExtrudeLayers`, i.e. from the
 * renderer's own stack resolution with the renderer's own frame budget already
 * spent — not from a second walk of the config.
 *
 * Returns an EMPTY map when nothing in the stack is a solid extrude, which is
 * the common case and costs one stack walk and no paper at all.
 *
 * **A SEQUENCE bake is affordable because this memoises** — see
 * `solidExtrudeBodyCached`. Nothing here asks whether time moved; the cache key
 * is the union's whole input, so a frame that changed the outline, the copies or
 * the placement misses and re-unites, and a frame that changed none of them (the
 * overwhelmingly common case, since extrude geometry is time-INVARIANT unless an
 * extrude parameter or an axis is itself animated) costs a map lookup.
 */
export async function prepareSolidExtrudes(
  font: VtFont,
  cfg: VectorTypeConfig,
  t: number,
  opts: VtBoxOptions,
): Promise<VtSolidBodies> {
  const out = new Map<string, VectorCommand[]>()
  // The SAME box `vtPlacement` is given below, so `fit: 'width'` solves against
  // it here exactly as it does in `drawVectorType`. Without it this frame is a
  // different run — the union fuses around geometry the preview never drew, and
  // the body cache, keyed on the placed commands, can never hit the drawn glyph.
  const frame = vectorTypeFrame(font, cfg, t, {
    fitBoxWidth: Math.max(0, opts.width - 2 * (opts.padding ?? 0)),
  })
  const solids = vtSolidExtrudeLayers(frame.config, frame.outlines.glyphs.length)
  if (!solids.length) return out

  const place = vtPlacement(frame, opts)
  const placed = placeOutlines(frame.outlines, place)
  for (const layer of solids) {
    for (let i = 0; i < placed.length; i++) {
      const glyph = frame.outlines.glyphs[i]
      const commands = placed[i]
      if (!glyph || !commands?.length) continue
      const body = await solidExtrudeBodyCached(
        commands,
        layer.copies,
        glyphPlacement(glyph, place),
        glyph.advance * place.scale,
      )
      if (body.length) out.set(vtSolidKey(layer.id, i), body)
    }
  }
  return out
}
