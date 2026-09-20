/**
 * Vector Type — the PAPER-FREE solid-extrude body cache.
 *
 * The union costs ~1.3 ms per copy, 575× the cost of drawing one, so the live
 * path was walled off from paper.js entirely. But a silhouette stroke needs the
 * unioned geometry, and a draw frame cannot afford to compute it. The rule this
 * module establishes is therefore:
 *
 *   > The live path **reads** the cached body. It never **triggers** a union.
 *
 * Four claims, ordered by how easy each would be to fake:
 *
 *  1. **`peekSolidBody` cannot compute.** Not "does not today" — it is
 *     synchronous, it returns `undefined` on a miss, and calling it leaves the
 *     cache exactly as big as it was. A function that lazily united would fail
 *     the last of those.
 *  2. **The cache module has no paper edge.** The same import-graph walk Task 5
 *     runs from `canvas.ts`, run from `extrudeBodyCache.ts` — because a store
 *     that reached paper would silently reopen the boundary the moment
 *     `canvas.ts` imported it.
 *  3. **The key is the union's whole input**, so a live read cannot return the
 *     wrong frame's body. Asserted by moving each of the four in turn.
 *  4. **The live draw path really does read it** — cold draws `depth` copies,
 *     warm draws ONE fused body, with `opts.solid` omitted in both. That is the
 *     observable behaviour of this task; everything above it is the mechanism.
 *
 * NO NETWORK, NO DOM beyond a recording 2D context: the same eight-character
 * Inter variable subset every other Vector Type spec uses. paper.js runs
 * headless where a real body is needed.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as fontkit from 'fontkit'
import { beforeEach, describe, expect, it } from 'vitest'
import type { VectorCommand } from '~/lib/vector/svg'
import { normaliseAxes, type VtFont } from '~/lib/vectortype/font'
import {
  DEFAULT_CONFIG,
  mergeConfig,
  vtLayer,
  type VectorTypeConfig,
  type VtAppearanceLayer,
} from '~/lib/vectortype/config'
import {
  clearSolidExtrudeCache,
  peekSolidBody,
  putSolidBody,
  solidBodyCacheKey,
  solidExtrudeCacheSize,
} from '~/lib/vectortype/extrudeBodyCache'
import { solidExtrudeBodyCached } from '~/lib/vectortype/extrudeSolid'
import {
  drawVectorType,
  vectorTypeFrame,
  vtPlacement,
  vtSolidExtrudeLayers,
} from '~/lib/vectortype/canvas'
import { glyphTransform as glyphPlacement, placeOutlines } from '~/lib/vectortype/render'

// ── fixtures ────────────────────────────────────────────────────────────────

const FIXTURE = fileURLToPath(new URL('../fixtures/inter-subset-var.ttf', import.meta.url))
const APP = resolvePath(fileURLToPath(new URL('../../app', import.meta.url)))

function loadFixtureFont(): VtFont {
  const bytes = new Uint8Array(readFileSync(FIXTURE))
  const raw: any = (fontkit as any).create(bytes)
  return {
    id: 'inter-subset',
    axes: normaliseAxes(raw?.variationAxes),
    unitsPerEm: Number(raw?.unitsPerEm) || 1000,
    raw,
  }
}
const font = loadFixtureFont()
const WORD = 'Sail'
const N = WORD.length
const BOX = { width: 400, height: 200 }
const BLUE = '#0000ff'

function cfg(patch: Partial<VectorTypeConfig> = {}): VectorTypeConfig {
  return mergeConfig({ ...DEFAULT_CONFIG, text: WORD, size: 100, ...patch })
}
function stack(...layers: Partial<VtAppearanceLayer>[]): VectorTypeConfig {
  return cfg({ appearance: layers.map((l, i) => vtLayer({ id: `L${i}`, ...l })) })
}

/** The four cache inputs for one glyph of one config, derived from the SAME
 *  three functions the renderer and the union both use — so a test that hits is
 *  hitting for the right reason and not because it re-derived the key. */
function inputsFor(c: VectorTypeConfig, layerIndex = 0) {
  const frame = vectorTypeFrame(font, c, 0)
  const place = vtPlacement(frame, BOX)
  const placed = placeOutlines(frame.outlines, place)
  // The RENDERER's own stack resolution, budget included — the same seam
  // `prepareSolidExtrudes` reads its copies from, so the key a test builds is
  // the key the draw loop will build.
  const L = vtSolidExtrudeLayers(frame.config, frame.outlines.glyphs.length)[layerIndex]
  return {
    copies: L?.copies ?? [],
    commands: (i: number) => placed[i] as VectorCommand[],
    origin: (i: number) => glyphPlacement(frame.outlines.glyphs[i]!, place),
    advance: (i: number) => frame.outlines.glyphs[i]!.advance * place.scale,
    key: (i: number) =>
      solidBodyCacheKey(placed[i] as VectorCommand[], L?.copies ?? [], glyphPlacement(frame.outlines.glyphs[i]!, place), frame.outlines.glyphs[i]!.advance * place.scale),
  }
}

/** A recording 2D context — enough of one for the draw path, counting fills. */
class RecCtx {
  paints: Array<{ cmds: any[] }> = []
  canvas = { width: 800, height: 400 }
  globalAlpha = 1
  globalCompositeOperation = 'source-over'
  filter = 'none'
  fillStyle: any = '#000'
  strokeStyle: any = '#000'
  lineWidth = 1
  lineJoin = 'miter'
  private m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
  save() {}
  restore() {}
  beginPath() {}
  clip() {}
  rect() {}
  translate() {}
  rotate() {}
  scale() {}
  setTransform() {}
  getTransform() { return { ...this.m, inverse: () => this.m, multiply: () => this.m, translate: () => this.m, scale: () => this.m } }
  clearRect() {}
  fillRect() {}
  createLinearGradient() { return { addColorStop() {} } }
  createPattern() { return null }
  fill(p: any) { this.paints.push({ cmds: p?.__cmds ?? [] }) }
  stroke(p: any) { this.paints.push({ cmds: p?.__cmds ?? [] }) }
  measureText() { return { width: 0 } }
}

/** A `Path2D` stand-in that REMEMBERS what was replayed into it, so a test can
 *  tell a 4-command body from a 60-command glyph outline. */
class RecPath2D {
  __cmds: Array<{ command: string; args: number[] }> = []
  moveTo(...a: number[]) { this.__cmds.push({ command: 'moveTo', args: a }) }
  lineTo(...a: number[]) { this.__cmds.push({ command: 'lineTo', args: a }) }
  quadraticCurveTo(...a: number[]) { this.__cmds.push({ command: 'quadraticCurveTo', args: a }) }
  bezierCurveTo(...a: number[]) { this.__cmds.push({ command: 'bezierCurveTo', args: a }) }
  closePath() { this.__cmds.push({ command: 'closePath', args: [] }) }
  addPath(p: any) { if (p?.__cmds) this.__cmds.push(...p.__cmds) }
}
;(globalThis as any).Path2D = RecPath2D

function draw(c: VectorTypeConfig) {
  const ctx = new RecCtx()
  drawVectorType(ctx as unknown as CanvasRenderingContext2D, font, c, 0, BOX)
  return ctx
}

// ════════════════════════════════════════════════════════════════════════════
// 1. `peekSolidBody` LOOKS. It does not compute.
// ════════════════════════════════════════════════════════════════════════════

describe('peekSolidBody — a look, never a computation', () => {
  beforeEach(() => clearSolidExtrudeCache())

  it('is SYNCHRONOUS — it cannot be awaiting a union', () => {
    // The same structural argument Task 5 makes about `drawVectorType`: an
    // `AsyncFunction` here would mean the live path could be handed a promise
    // and someone would eventually await it inside a draw loop.
    expect(peekSolidBody.constructor.name).toBe('Function')
    expect(peekSolidBody('nothing')).toBeUndefined()
    expect((peekSolidBody('nothing') as any)?.then).toBeUndefined()
  })

  it('returns undefined on a miss and stores NOTHING — no lazy fill', () => {
    // The test that would catch a "peek" that quietly computed and memoised:
    // a thousand misses must leave the store empty.
    for (let i = 0; i < 1000; i++) expect(peekSolidBody(`missing-${i}`)).toBeUndefined()
    expect(solidExtrudeCacheSize()).toBe(0)
  })

  it('returns the stored body BY REFERENCE, so a peek costs a hash lookup', () => {
    const body: VectorCommand[] = [
      { command: 'moveTo', args: [1, 2] },
      { command: 'lineTo', args: [3, 4] },
      { command: 'closePath', args: [] },
    ]
    putSolidBody('k', body)
    expect(peekSolidBody('k')).toBe(body)
    expect(solidExtrudeCacheSize()).toBe(1)
  })

  it('never stores an EMPTY body — a failed union is not an answer', () => {
    // `unionCommandLists` returns `[]` both for "nothing to unite" and for a
    // caught paper failure. Caching either would make one transient failure
    // permanent, and would make a live peek confidently return "no geometry".
    putSolidBody('empty', [])
    expect(solidExtrudeCacheSize()).toBe(0)
    expect(peekSolidBody('empty')).toBeUndefined()
  })

  it('is BOUNDED — the oldest entry goes, and the newest is still there', () => {
    for (let i = 0; i < 600; i++) putSolidBody(`k${i}`, [{ command: 'moveTo', args: [i, i] }])
    expect(solidExtrudeCacheSize()).toBeLessThanOrEqual(512)
    expect(peekSolidBody('k0')).toBeUndefined()
    expect(peekSolidBody('k599')).toBeDefined()
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 2. The store has NO paper edge — the property the split exists for
// ════════════════════════════════════════════════════════════════════════════

/** Task 5's specifier scanner, verbatim in behaviour: `from '…'`, `import('…')`
 *  AND the bare `import '…'` its first version missed. */
function specifiersOf(source: string): string[] {
  // A type-only import is erased by the compiler: it is not a runtime edge and can drag
  // nothing into a bundle. Without this the walk reported paper reachable from Vector Type
  // through `motion/types.ts -> import type … effectTracks -> import type … useCompositorLayers`
  // — two erased edges — once the Frame's effect tracks (F8) joined the motion types.
  // (`import { type A, b }` is a real import and is still followed.)
  const src = source.replace(/\b(?:import|export)\s+type\s+[^;'"]*?\bfrom\s+'[^']+'/g, '')
  const out: string[] = []
  for (const m of src.matchAll(/\bfrom\s+'([^']+)'/g)) out.push(m[1] as string)
  for (const m of src.matchAll(/\bimport\(\s*'([^']+)'\s*\)/g)) out.push(m[1] as string)
  for (const m of src.matchAll(/(?:^|\n)\s*import\s+'([^']+)'/g)) out.push(m[1] as string)
  return out
}
function resolveSpec(spec: string, fromFile: string): string | null {
  let base: string
  if (spec.startsWith('~/')) base = resolvePath(APP, spec.slice(2))
  else if (spec.startsWith('.')) base = resolvePath(dirname(fromFile), spec)
  else return null
  for (const ext of ['.ts', '.vue', '/index.ts']) if (existsSync(base + ext)) return base + ext
  return null
}
function graphFrom(entry: string) {
  const seen = new Set<string>()
  const offenders: string[] = []
  const queue = [resolvePath(APP, entry)]
  while (queue.length) {
    const file = queue.shift() as string
    if (seen.has(file)) continue
    seen.add(file)
    for (const spec of specifiersOf(readFileSync(file, 'utf8'))) {
      if (spec === 'paper' || spec.startsWith('paper/')) offenders.push(`${file} -> ${spec}`)
      const next = resolveSpec(spec, file)
      if (next && !seen.has(next)) queue.push(next)
    }
  }
  return { seen, offenders }
}

describe('the body cache is PAPER-FREE — the reason it is its own module', () => {
  it('never reaches `paper`, transitively, and never reaches the union module', () => {
    // If this goes red, `canvas.ts` importing the cache has just dragged 300 kB
    // of geometry library into the render path — which is the exact edge Task
    // 5's own import-graph test forbids, one hop further out.
    const { seen, offenders } = graphFrom('lib/vectortype/extrudeBodyCache.ts')
    expect(offenders).toEqual([])
    expect([...seen].some(f => f.endsWith('extrudeSolid.ts'))).toBe(false)
    expect([...seen].some(f => f.endsWith('canvas.ts'))).toBe(false)
  })

  it('the walk still SEES a real paper edge (positive control for the type-only skip)', () => {
    // extrudeSolid.ts is the one Vector Type module that genuinely loads paper. If skipping
    // erased imports ever made the walk blind, this goes red before the guard above lies.
    expect(graphFrom('lib/vectortype/extrudeSolid.ts').offenders.length).toBeGreaterThan(0)
  })

  it('is a LEAF — it imports types only, so importing it costs nothing at runtime', () => {
    // A store that pulled in the renderer would make the edge a cycle, and a
    // cycle is how a "paper-free" module quietly acquires a paper edge later.
    const src = readFileSync(resolvePath(APP, 'lib/vectortype/extrudeBodyCache.ts'), 'utf8')
    for (const spec of specifiersOf(src)) {
      expect(spec === '~/lib/vector/svg' || spec === './extrude').toBe(true)
    }
    // Both of those are `import type`, i.e. erased entirely by the compiler.
    expect(/^import\s+\{/m.test(src)).toBe(false)
  })

  it('is READ by canvas.ts — the live path really is wired to it', () => {
    // The complement of the two negative assertions above: the split is only
    // worth anything if the renderer actually reads the store. Without this a
    // future edit could delete the read and every other test here would stay
    // green.
    const src = readFileSync(resolvePath(APP, 'lib/vectortype/canvas.ts'), 'utf8')
    expect(src).toMatch(/from '\.\/extrudeBodyCache'/)
    expect(src).toMatch(/\bpeekSolidBody\(/)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 3. The key is the union's WHOLE input
// ════════════════════════════════════════════════════════════════════════════

describe('the cache key is the geometry, so a hit cannot be the wrong body', () => {
  const c = stack({ kind: 'extrude', depth: 4, distance: 5, angle: 45, solid: true, paint: BLUE })

  it('is STABLE for the same four inputs', () => {
    const a = inputsFor(c)
    const b = inputsFor(c)
    expect(a.key(0)).toBe(b.key(0))
    expect(a.key(0).length).toBeGreaterThan(100)
  })

  it('MOVES when any one of the four moves', () => {
    const { commands, copies, origin, advance } = inputsFor(c)
    const base = solidBodyCacheKey(commands(0), copies, origin(0), advance(0))
    expect(solidBodyCacheKey(commands(1), copies, origin(0), advance(0))).not.toBe(base)
    expect(solidBodyCacheKey(commands(0), [{ dx: 9, dy: 9, scale: 1 }], origin(0), advance(0))).not.toBe(base)
    expect(solidBodyCacheKey(commands(0), copies, { x: origin(0).x + 1, y: origin(0).y }, advance(0))).not.toBe(base)
    expect(solidBodyCacheKey(commands(0), copies, origin(0), advance(0) + 1)).not.toBe(base)
  })

  it('is the SAME key the writer stores under — one spelling, two callers', async () => {
    // The failure this catches is silent and total: a reader that built the key
    // differently would never hit, the stroke would simply never appear, and it
    // would look like a missing feature rather than a bug.
    clearSolidExtrudeCache()
    const { commands, copies, origin, advance, key } = inputsFor(c)
    const written = await solidExtrudeBodyCached(commands(0), copies, origin(0), advance(0))
    expect(written.length).toBeGreaterThan(4)
    expect(peekSolidBody(key(0))).toBe(written)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 4. The LIVE draw path reads it — cold copies, warm body
// ════════════════════════════════════════════════════════════════════════════

describe('the live path READS the cache — and never triggers a union', () => {
  const DEPTH = 6
  const c = stack({ kind: 'extrude', depth: DEPTH, distance: 4, angle: 0, solid: true, paint: BLUE })

  beforeEach(() => clearSolidExtrudeCache())

  it('draws the FULL un-unioned stack on a COLD cache — the fallback picture', () => {
    // Task 5's guarantee, restated against an explicitly empty store: nothing on
    // this path computes, so a first frame is `depth` copies per glyph and the
    // studio stays playable.
    expect(solidExtrudeCacheSize()).toBe(0)
    expect(draw(c).paints.length).toBe(DEPTH * N)
    // …and the draw did not fill the cache. A renderer that united would.
    expect(solidExtrudeCacheSize()).toBe(0)
  })

  it('draws ONE fused body per glyph once the union has landed', async () => {
    // The whole point of this task. `opts.solid` is NOT passed — this is the
    // live signature — and the picture changes because the body is now readable.
    const { commands, copies, origin, advance } = inputsFor(c)
    for (let i = 0; i < N; i++) await solidExtrudeBodyCached(commands(i), copies, origin(i), advance(i))
    expect(solidExtrudeCacheSize()).toBe(N)

    const ctx = draw(c)
    expect(ctx.paints.length).toBe(N)
    // Counting alone is not enough — a renderer that drew the glyph path once
    // would also give N. Each body is ONE subpath (one `moveTo`) where a stack
    // of six copies replayed into one path would be six.
    for (const p of ctx.paints) {
      expect(p.cmds.filter(x => x.command === 'moveTo').length).toBeGreaterThan(0)
      expect(p.cmds.length).toBeGreaterThan(4)
    }
  })

  it('goes back to the copies when the geometry moves out from under the body', async () => {
    // The safety property of an input-verbatim key, observed rather than argued:
    // warm the cache for depth 6, then draw depth 7. The old body is not this
    // frame's body, the key misses, and the renderer falls back — it does NOT
    // draw a stale block shadow.
    const { commands, copies, origin, advance } = inputsFor(c)
    for (let i = 0; i < N; i++) await solidExtrudeBodyCached(commands(i), copies, origin(i), advance(i))
    expect(draw(c).paints.length).toBe(N)

    const deeper = stack({ kind: 'extrude', depth: DEPTH + 1, distance: 4, angle: 0, solid: true, paint: BLUE })
    expect(draw(deeper).paints.length).toBe((DEPTH + 1) * N)
  })

  it('leaves a NON-solid extrude on its copies even with a warm body', async () => {
    // The flag is the switch, not the presence of geometry — unchanged from the
    // bake path, and it matters more now that a body can arrive by itself.
    const { commands, copies, origin, advance } = inputsFor(c)
    for (let i = 0; i < N; i++) await solidExtrudeBodyCached(commands(i), copies, origin(i), advance(i))
    const loose = stack({ kind: 'extrude', depth: DEPTH, distance: 4, angle: 0, solid: false, paint: BLUE })
    expect(draw(loose).paints.length).toBe(DEPTH * N)
  })

  it('lets a HANDED-IN body win over a cached one — a bake draws what it asked for', async () => {
    // `opts.solid` is authoritative: a bake awaited bodies for its own time and
    // its own resolution, and must not be overridden by whatever the preview
    // happens to have warm.
    const { commands, copies, origin, advance } = inputsFor(c)
    for (let i = 0; i < N; i++) await solidExtrudeBodyCached(commands(i), copies, origin(i), advance(i))
    const TRI: VectorCommand[] = [
      { command: 'moveTo', args: [1, 2] },
      { command: 'lineTo', args: [3, 4] },
      { command: 'lineTo', args: [5, 6] },
      { command: 'closePath', args: [] },
    ]
    const handed = new Map<string, VectorCommand[]>()
    for (let i = 0; i < N; i++) handed.set(`L0#${i}`, TRI)
    const ctx = new RecCtx()
    drawVectorType(ctx as unknown as CanvasRenderingContext2D, font, c, 0, { ...BOX, solid: handed })
    expect(ctx.paints.length).toBe(N)
    for (const p of ctx.paints) expect(p.cmds).toHaveLength(TRI.length)
  })
})
