/**
 * Vector Type — motion.
 *
 * Three failures these tests exist to prevent, all of them silent:
 *
 * 1. `applyMotion` MUTATING its input. The surface holds one config ref; a
 *    mutating evaluator would write frame 37's values into it and the next save
 *    would persist them as the user's settings.
 * 2. A track path FABRICATING structure. `setByPath` creates missing containers
 *    by design, so a typo'd or stale path would grow junk into the config —
 *    which then gets saved, and never errors.
 * 3. `applyMotion` assuming something normalised the config first. Gradient
 *    nearly shipped exactly that: only its editor surface called
 *    `ensureConfigDefaults`, while the node card, the bake and the frame source
 *    all rendered the raw saved blob. Every entry point here is therefore
 *    exercised against a config that has never seen `mergeConfig`.
 *
 * Plus the one the studio is FOR: a weight wave that travels across a word.
 *
 * ## The move shape, since Task 4/5
 *
 * A track is no longer a flat entry in `motion.tracks`; it lives inside a
 * `kind: 'tracks'` MOVE (`motion.moves`), which owns the track's old
 * `easing`/`loops` as its own `ease`/`play` — `applyMotion` is now
 * `applyMoveTracks` (`~/lib/studio/moves/tracks`) plus Vector Type's own
 * colour write. `track()` below stays a convenient "track intent" DSL
 * (path/from/to/easing/loops), and `trackMoves()` is what turns a list of
 * them into the moves a real config stores — one move per track, so each can
 * carry its own timing exactly as a flat array of independently-eased tracks
 * used to.
 */
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_CONFIG,
  VT_STAGGER_ORDERS,
  cloneConfig,
  mergeConfig,
  vtLayer,
  type VectorTypeConfig,
  type VtMotionTrack,
  type VtMove,
  type VtStaggerOrder,
} from '~/lib/vectortype/config'
import type { MoveEase } from '~/lib/studio/moves/types'
import { VT_CONTROLS, visibleVtControls } from '~/lib/vectortype/controls'
import { DEFAULT_FILL } from '~/lib/spacetype/fillTile'
import type { VtAxis } from '~/lib/vectortype/font'
import {
  IDENTITY_GLYPH_TRANSFORM,
  VT_GLYPH_TARGETS,
  animatableTargets,
  applyMotion,
  glyphConfig,
  glyphTime,
  glyphTransform,
  resolveStagger,
  staggerRank,
} from '~/lib/vectortype/motion'
import { makeConfigParams } from '~/lib/agent/configParams'

const RICH_AXES: VtAxis[] = [
  { tag: 'wght', name: 'Weight', min: 100, max: 1000, default: 400 },
  { tag: 'wdth', name: 'Width', min: 25, max: 151, default: 100 },
  { tag: 'GRAD', name: 'Grade', min: -200, max: 150, default: 0 },
]

/** A track "intent" — path/from/to plus the OLD easing/loops vocabulary. Not
 *  what a real config stores any more (see `trackMoves` below); a convenient
 *  DSL this file's tests keep, since it names the same timing this suite has
 *  always tested. */
const track = (over: Partial<VtMotionTrack> & { easing?: 'linear' | 'pingpong' | 'easeinout'; loops?: number } = {}) => ({
  path: 'axes.wght', from: 100, to: 900, easing: 'linear' as const,
  loops: 1, hold: 0, cycleOffset: 0, delay: 0, ...over,
})

/** `easing` → the owning move's `ease`/`loop`/`bounce` — the exact mapping
 *  `~/lib/studio/moves/merge`'s `legacyTrackEase`/`legacyTrackPlacement` use
 *  for a legacy (flat-`tracks`-array) document, restated here as the
 *  corresponding test-side DSL: `pingpong` -> an open-ended ping-pong cycle
 *  (`loop: true, bounce: true`); anything else -> a ONE-SHOT transition
 *  (`loop: false`) that reaches `to` and holds — which is what every
 *  non-pingpong test in this file actually exercises (a track landing on its
 *  end value by the clip's own end), not a repeating wave. `loops` (this
 *  file never varies it past the default 1) is accepted but unused — the
 *  at/loop model has no "N cycles across the clip" of its own; see
 *  `legacyTrackPlacement`'s own doc for why that is an accepted, deliberate
 *  loss for the >1 case, which this file's fixtures never exercise. */
function easeAndLoop(easing: 'linear' | 'pingpong' | 'easeinout'): { ease: MoveEase; loop: boolean; bounce?: true } {
  if (easing === 'pingpong') return { ease: { kind: 'named', name: 'none' }, loop: true, bounce: true }
  if (easing === 'easeinout') return { ease: { kind: 'named', name: 'natural' }, loop: false }
  return { ease: { kind: 'named', name: 'none' }, loop: false }
}

let moveSeq = 0
/** One `kind: 'tracks'` move per track. `clip` (default 4, matching every
 *  clip in this file except the one that overrides it) is used for the
 *  move's own `duration` — under the at/loop model a `'tracks'` move's own
 *  `duration` IS the window/cycle length `~/lib/studio/moves/tracks.ts`
 *  reads (`__duration`), so a caller whose config's `motion.duration` is not
 *  4 MUST pass its real clip length here, or the window ends (or the cycle
 *  wraps) at the wrong instant. */
function trackMoves(tracks: ReturnType<typeof track>[], clip = 4): VtMove[] {
  return tracks.map((t) => {
    moveSeq += 1
    const { ease, loop, bounce } = easeAndLoop(t.easing)
    const { path, from, to, hold, cycleOffset, delay } = t
    const extra = t as Record<string, unknown>
    return {
      id: `move-legacy-${moveSeq}`,
      kind: 'tracks',
      presetId: 'custom',
      at: 0,
      duration: clip,
      loop,
      ...(bounce ? { bounce: true } : {}),
      ease,
      tracks: [{
        path, from, to, hold, cycleOffset, delay,
        ...(typeof extra.fromColor === 'string' ? { fromColor: extra.fromColor } : {}),
        ...(typeof extra.toColor === 'string' ? { toColor: extra.toColor } : {}),
        ...(extra.space ? { space: extra.space } : {}),
      }],
    } as VtMove
  })
}

const cfg = (over: Partial<VectorTypeConfig> = {}): VectorTypeConfig =>
  mergeConfig({ ...cloneConfig(DEFAULT_CONFIG), ...over })

const withTracks = (tracks: ReturnType<typeof track>[], over: Partial<VectorTypeConfig> = {}): VectorTypeConfig =>
  cfg({ ...over, motion: { ...DEFAULT_CONFIG.motion, duration: 4, moves: trackMoves(tracks) } })

/** A config with a stroke layer above its fill, so the stroke vocabulary is
 *  reachable. `cfg({ strokeWidth })` no longer means anything: the stack is
 *  already present on a `DEFAULT_CONFIG` spread. */
const strokedCfg = (over: Partial<VectorTypeConfig> = {}) =>
  cfg({ ...over, appearance: [vtLayer({ id: 'Lfill' }), vtLayer({ id: 'Lstroke', kind: 'stroke', width: 3 })] })

const staggered = (delay: number, order: VtStaggerOrder = 'forward', seed = 0, tracks: ReturnType<typeof track>[] = []) =>
  cfg({ motion: { ...DEFAULT_CONFIG.motion, duration: 4, moves: trackMoves(tracks), stagger: { delay, order, seed } } })

/** A config as it comes off the wire: JSON, partial, never through mergeConfig.
 *  No `axes` record, no `stagger` block, no `align`/`fill`/`fps`/`size`. */
function storageBlob(motion: Record<string, unknown>): VectorTypeConfig {
  return JSON.parse(JSON.stringify({ text: 'Wave', fontId: 'inter', size: 120, motion })) as VectorTypeConfig
}

/** `storageBlob` helper for the common case: one plain `moves` array, raw. */
function storageBlobMoves(moves: unknown[], rest: Record<string, unknown> = {}): VectorTypeConfig {
  return storageBlob({ duration: 4, moves, ...rest })
}

describe('animatableTargets — derived from the one declaration', () => {
  it('offers every slider the schema does not opt out of', () => {
    const paths = animatableTargets(cfg()).map(t => t.path)
    expect(paths).toContain('size')
    expect(paths).toContain('tracking')
  })

  it('EXPANDS the relative `layer.` prefix to one absolute path per layer', () => {
    // The whole point of the relative prefix: one declaration, N targets. A
    // target still addressing `layer.paint.angle` would animate nothing —
    // `applyMotion` resolves against the config, where there is no `layer` key.
    const two = cfg({
      appearance: [
        vtLayer({ id: 'La', paint: { ...DEFAULT_FILL, type: 'gradient' } }),
        vtLayer({ id: 'Lb', kind: 'stroke' }),
      ],
    })
    const paths = animatableTargets(two).map(t => t.path)
    // …addressed by the layer's own stable ID, not its position. See
    // `vectortype-stack-addressing.unit.spec.ts` for why that is the point.
    expect(paths).toContain('appearance.La.paint.angle')
    expect(paths).toContain('appearance.Lb.width')
    expect(paths.some(p => p.startsWith('layer.'))).toBe(false)
    // Labelled per layer, so a timeline dropdown can tell two of them apart.
    const labels = animatableTargets(two).filter(t => t.path.startsWith('appearance.')).map(t => t.label)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('offers NOTHING from the stack when the stack is empty', () => {
    const bare = cfg({ appearance: [] })
    expect(animatableTargets(bare).some(t => t.path.startsWith('appearance.'))).toBe(false)
  })

  it('offers nothing that is not a slider', () => {
    const paths = new Set(animatableTargets(strokedCfg(), RICH_AXES).map(t => t.path))
    for (const c of VT_CONTROLS) {
      if (c.kind === 'slider') continue
      expect(paths.has(c.key), `${c.key} (${c.kind}) is animatable`).toBe(false)
    }
    // Named explicitly, because these are the ones a hand-written list gets wrong.
    expect(paths.has('fontId')).toBe(false)
    expect(paths.has('text')).toBe(false)
    expect(paths.has('fill')).toBe(false)
    expect(paths.has('layer.anchor')).toBe(false)
  })

  it('honours animatable: false — the stagger block is not itself a track target', () => {
    // A track pointing at the stagger block would ask the timeline to rewrite
    // its own reader mid-frame.
    const paths = animatableTargets(cfg({ motion: { ...DEFAULT_CONFIG.motion, stagger: { delay: 0, order: 'random', seed: 3 } } }))
      .map(t => t.path)
    expect(paths).not.toContain('motion.stagger.delay')
    expect(paths).not.toContain('motion.stagger.seed')
    expect(paths).not.toContain('motion.stagger.order')
  })

  it('grows one target per axis of the LOADED font — the headline', () => {
    const withFont = animatableTargets(cfg(), RICH_AXES).map(t => t.path)
    const without = animatableTargets(cfg()).map(t => t.path)
    for (const a of RICH_AXES) expect(withFont).toContain(`axes.${a.tag}`)
    expect(without.some(p => p.startsWith('axes.'))).toBe(false)
    expect(withFont.length).toBe(without.length + RICH_AXES.length)
  })

  it('takes each axis range from the font, not from a hand-written list', () => {
    const grad = animatableTargets(cfg(), RICH_AXES).find(t => t.path === 'axes.GRAD')!
    expect(grad).toMatchObject({ min: -200, max: 150, label: 'Grade', group: 'Axes' })
  })

  it('includes the per-glyph transform namespace', () => {
    const paths = animatableTargets(cfg()).map(t => t.path)
    for (const g of VT_GLYPH_TARGETS) expect(paths).toContain(g.path)
  })

  it('emits unique paths with a usable range on every one', () => {
    const targets = animatableTargets(strokedCfg(), RICH_AXES)
    expect(new Set(targets.map(t => t.path)).size).toBe(targets.length)
    for (const t of targets) {
      expect(t.max, t.path).toBeGreaterThan(t.min)
      expect(t.label, t.path).toBeTruthy()
      expect(t.group, t.path).toBeTruthy()
    }
  })

  it('every non-glyph target addresses a real config leaf', () => {
    // The glyph namespace is deliberately NOT a config leaf (a per-glyph offset
    // is an output, not stored state); everything else must resolve, or it is a
    // track the renderer will never read.
    const c = strokedCfg({ axes: Object.fromEntries(RICH_AXES.map(a => [a.tag, a.default])) })
    const params = makeConfigParams(() => c, () => 0, 'appearance')
    const unresolved = animatableTargets(c, RICH_AXES)
      .map(t => t.path)
      .filter(p => !p.startsWith('glyph.') && params[p] === undefined)
    expect(unresolved).toEqual([])
  })

  it('does not hand back the frozen glyph targets for a caller to mutate', () => {
    const a = animatableTargets(cfg())
    const b = animatableTargets(cfg())
    const dx = a.find(t => t.path === 'glyph.dx')!
    dx.max = 1
    expect(b.find(t => t.path === 'glyph.dx')!.max).toBe(400)
  })
})

describe('applyMotion', () => {
  it('writes an axis value at the given time', () => {
    const c = withTracks([track()])
    expect(applyMotion(c, 0).axes.wght).toBeCloseTo(100, 6)
    expect(applyMotion(c, 2).axes.wght).toBeCloseTo(500, 6)
    expect(applyMotion(c, 4).axes.wght).toBeCloseTo(900, 6)
  })

  it('animates a plain top-level slider too', () => {
    const c = withTracks([track({ path: 'size', from: 40, to: 240 })])
    expect(applyMotion(c, 2).size).toBeCloseTo(140, 6)
  })

  it('DOES NOT MUTATE the config it was given', () => {
    const c = withTracks([track(), track({ path: 'size', from: 40, to: 240 })], { axes: { wght: 700 } })
    const before = structuredClone(c)
    for (const t of [0, 0.7, 2, 3.9, 4]) applyMotion(c, t)
    // Deep structural comparison, not an eyeball of the code.
    expect(c).toEqual(before)
    expect(c.axes.wght).toBe(700)
    expect(c.size).toBe(DEFAULT_CONFIG.size)
  })

  it('returns a config that shares no mutable structure with its source', () => {
    const c = withTracks([track()])
    const out = applyMotion(c, 2)
    expect(out).not.toBe(c)
    expect(out.axes).not.toBe(c.axes)
    expect(out.motion).not.toBe(c.motion)
    const outTrackMove = out.motion.moves.find(m => m.kind === 'tracks')!
    const cTrackMove = c.motion.moves.find(m => m.kind === 'tracks')!
    expect(outTrackMove.tracks![0]).not.toBe(cTrackMove.tracks![0])
    outTrackMove.tracks![0]!.to = -1
    expect(cTrackMove.tracks![0]!.to).toBe(900)
  })

  it('returns the SAME config when nothing animates', () => {
    const c = cfg()
    expect(applyMotion(c, 1)).toBe(c)
  })

  it('skips an unresolvable path WITHOUT fabricating structure', () => {
    // setByPath creates missing containers by design. A typo'd or stale path
    // must not grow junk that then gets saved.
    const c = withTracks([
      track({ path: 'nope.deeper.leaf' }),
      track({ path: 'layers.3.shape.count' }),
      // Was `fill.r` — `fill` became a `Paint` OBJECT in Task 2, so it is now a
      // real container and `fill.r` is the sparse-leaf case below, not this one.
      // `stroke` is still a flat colour string, so it is the string-parent case.
      track({ path: 'stroke.r' }),
    ])
    const out = applyMotion(c, 2)
    expect(out).toEqual(c)
    expect((out as any).nope).toBeUndefined()
    expect((out as any).layers).toBeUndefined()
    expect(out.stroke).toBe(DEFAULT_CONFIG.stroke)
    expect(Object.keys(out).sort()).toEqual(Object.keys(c).sort())
  })

  it('animating a layer paint leaves the SOURCE layer — and DEFAULT_CONFIG — untouched', () => {
    // A layer's `paint` is a mutable object and `paint.angle` is an animatable
    // slider, so a shallow clone would have let `applyMotion` write frame 37's
    // angle into the config the surface holds. Worse: every config built from
    // `DEFAULT_CONFIG` shares ONE layer object unless the clone is deep, so the
    // module-level default itself would drift.
    const before = { ...(DEFAULT_CONFIG.appearance[0]!.paint as Record<string, unknown>) }
    const c = withTracks([track({ path: 'appearance.0.paint.angle', from: 0, to: 300 })])
    const out = applyMotion(c, 2)
    expect((out.appearance[0]!.paint as any).angle).toBeCloseTo(150, 6)
    expect((c.appearance[0]!.paint as any).angle).toBe(45)
    expect(out.appearance[0]!.paint).not.toBe(c.appearance[0]!.paint)
    expect(out.appearance[0]).not.toBe(c.appearance[0])
    expect(DEFAULT_CONFIG.appearance[0]!.paint).toEqual(before)
  })

  it('still fills a SPARSE leaf whose parent exists', () => {
    // `axes` is sparse by design — an absent tag means the font's own default —
    // so a valid axis target genuinely has no leaf until motion writes one.
    const c = withTracks([track({ path: 'axes.GRAD', from: -200, to: 150 })])
    expect(c.axes.GRAD).toBeUndefined()
    expect(applyMotion(c, 4).axes.GRAD).toBeCloseTo(150, 6)
  })

  it('leaves the per-glyph namespace alone — that is glyphTransform\'s', () => {
    const c = withTracks([track({ path: 'glyph.dy', from: 0, to: 120 })])
    const out = applyMotion(c, 4)
    expect((out as any).glyph).toBeUndefined()
    expect(out).toEqual(c)
  })

  it('skips a track whose numbers are not numbers rather than writing NaN', () => {
    // Un-merged on purpose: mergeConfig would repair these (and a test above
    // pins that it does). This is the un-normalised path, where it cannot.
    const raw = storageBlobMoves([
      ...trackMoves([{ ...track(), from: undefined as any }]),
      ...trackMoves([{ ...track({ path: 'size' }), to: 'big' as any }]),
      ...trackMoves([{ ...track({ path: 'tracking', from: 0, to: 100 }), from: null as any }]),
      ...trackMoves([track({ path: 'strokeWidth', from: 0, to: 10 })]), // one good one, so the loop runs
    ])
    const out = applyMotion(raw, 2)
    expect(out).not.toBe(raw)
    expect(out.strokeWidth).toBeCloseTo(5, 6)
    expect(out.axes.wght).toBeUndefined()
    expect(out.size).toBe(120)
    expect(out.tracking).toBeUndefined()
  })

  describe('a config straight out of storage, never normalised', () => {
    it('animates from a raw blob with no axes record and no stagger block', () => {
      const raw = storageBlobMoves(trackMoves([track()], 2), { duration: 2 })
      expect(raw.axes).toBeUndefined()
      const out = applyMotion(raw, 1)
      expect(out.axes.wght).toBeCloseTo(500, 6)
      expect(raw.axes).toBeUndefined() // and the blob is still untouched
    })

    it('falls back to the default clip length when duration is missing', () => {
      const raw = storageBlob({ moves: trackMoves([track()]) })
      // Default duration is 4, so t=2 is the midpoint.
      expect(applyMotion(raw, 2).axes.wght).toBeCloseTo(500, 6)
    })

    it('survives a motion block that is missing, junk, or has non-array moves', () => {
      for (const motion of [undefined, null, 'later', 42, { moves: { 0: trackMoves([track()])[0] } }, {}] as any[]) {
        const raw = storageBlob(motion)
        expect(() => applyMotion(raw, 1)).not.toThrow()
        expect(applyMotion(raw, 1)).toBe(raw)
      }
    })
  })
})

describe('per-glyph stagger', () => {
  it('resolveStagger defaults field by field from a raw blob', () => {
    expect(resolveStagger(storageBlob({ moves: [] }))).toEqual({ delay: 0, order: 'forward', seed: 0 })
    expect(resolveStagger(storageBlob({ stagger: { delay: 0.2, order: 'edges', seed: 7 } })))
      .toEqual({ delay: 0.2, order: 'edges', seed: 7 })
    expect(resolveStagger(storageBlob({ stagger: { delay: 'soon', order: 'sideways', seed: null } })))
      .toEqual({ delay: 0, order: 'forward', seed: 0 })
    expect(resolveStagger(storageBlob({ stagger: { delay: -3 } })).delay).toBe(0)
  })

  it('delay 0 leaves every glyph on the same clock', () => {
    for (const order of VT_STAGGER_ORDERS) {
      const c = staggered(0, order)
      const times = [0, 1, 2, 3, 4].map(i => glyphTime(c, 1.75, i, 5))
      expect(new Set(times), order).toEqual(new Set([1.75]))
    }
  })

  it('a single glyph never staggers, whatever the delay', () => {
    expect(glyphTime(staggered(0.5), 2, 0, 1)).toBe(2)
    expect(glyphTime(staggered(0.5), 2, 0, 0)).toBe(2)
  })

  it('glyph n lags glyph 0 by exactly n × delay', () => {
    const c = staggered(0.25, 'forward')
    for (let i = 0; i < 6; i++) {
      expect(glyphTime(c, 3, i, 6), `glyph ${i}`).toBeCloseTo(3 - i * 0.25, 10)
    }
  })

  it('reverse is forward read backwards', () => {
    const c = staggered(0.25, 'reverse')
    for (let i = 0; i < 6; i++) expect(glyphTime(c, 3, i, 6)).toBeCloseTo(3 - (5 - i) * 0.25, 10)
  })

  describe('rank', () => {
    it('center and edges are symmetric about the middle, odd and even', () => {
      for (const order of ['center', 'edges'] as const) {
        for (const n of [2, 3, 4, 5, 6, 7]) {
          for (let i = 0; i < n; i++) {
            expect(staggerRank(order, i, n), `${order} n=${n} i=${i}`)
              .toBe(staggerRank(order, n - 1 - i, n))
          }
        }
      }
    })

    it('center leads in the middle, edges leads at the ends', () => {
      expect([0, 1, 2, 3, 4].map(i => staggerRank('center', i, 5))).toEqual([4, 2, 0, 2, 4])
      expect([0, 1, 2, 3, 4].map(i => staggerRank('edges', i, 5))).toEqual([0, 2, 4, 2, 0])
      // Even counts have no single middle; the pair shares the lead at 0.
      expect([0, 1, 2, 3].map(i => staggerRank('center', i, 4))).toEqual([2, 0, 0, 2])
      expect([0, 1, 2, 3].map(i => staggerRank('edges', i, 4))).toEqual([0, 2, 2, 0])
    })

    it('every order leads at 0 and returns whole numbers', () => {
      for (const order of VT_STAGGER_ORDERS) {
        for (const n of [1, 2, 3, 4, 5, 8, 13]) {
          const ranks = Array.from({ length: n }, (_, i) => staggerRank(order, i, n, 42))
          expect(Math.min(...ranks), `${order} n=${n}`).toBe(0)
          for (const r of ranks) expect(Number.isInteger(r), `${order} n=${n} rank ${r}`).toBe(true)
        }
      }
    })

    it('clamps an out-of-range index rather than returning NaN', () => {
      for (const order of VT_STAGGER_ORDERS) {
        for (const i of [-4, 99, 1.7]) {
          expect(Number.isFinite(staggerRank(order, i, 5, 9)), `${order} ${i}`).toBe(true)
        }
      }
    })
  })

  describe('random order is seeded, not rolled', () => {
    it('returns the same ranks on a second call with the same inputs', () => {
      const once = Array.from({ length: 9 }, (_, i) => staggerRank('random', i, 9, 12))
      const twice = Array.from({ length: 9 }, (_, i) => staggerRank('random', i, 9, 12))
      expect(twice).toEqual(once)
      // And after the memo has been evicted by a different (count, seed).
      staggerRank('random', 0, 4, 99)
      expect(Array.from({ length: 9 }, (_, i) => staggerRank('random', i, 9, 12))).toEqual(once)
    })

    it('is a true permutation — every glyph gets a distinct slot', () => {
      for (const n of [2, 5, 9, 20]) {
        const ranks = Array.from({ length: n }, (_, i) => staggerRank('random', i, n, 7))
        expect([...ranks].sort((a, b) => a - b), `n=${n}`).toEqual(Array.from({ length: n }, (_, i) => i))
      }
    })

    it('is actually shuffled, and the seed re-rolls it', () => {
      const forSeed = (s: number) => Array.from({ length: 10 }, (_, i) => staggerRank('random', i, 10, s))
      const identity = Array.from({ length: 10 }, (_, i) => i)
      expect(forSeed(0)).not.toEqual(identity)
      expect(forSeed(1)).not.toEqual(forSeed(0))
      expect(forSeed(2)).not.toEqual(forSeed(0))
    })

    it('gives the same glyph times on a repeat pass — a bake must not flicker', () => {
      const c = staggered(0.1, 'random', 5)
      const pass = () => Array.from({ length: 7 }, (_, i) => glyphTime(c, 1.3, i, 7))
      expect(pass()).toEqual(pass())
    })
  })
})

describe('the travelling wave — the point of the studio', () => {
  const wave = staggered(0.5, 'forward', 0, [track({ path: 'axes.wght', from: 100, to: 900 })])

  it('gives each glyph a DIFFERENT axis value at the same instant', () => {
    const weights = [0, 1, 2, 3].map(i => glyphConfig(wave, 2, i, 4).axes.wght!)
    expect(weights.map(w => Math.round(w))).toEqual([500, 400, 300, 200])
    // Strictly decreasing: the crest has passed glyph 0 and is heading down the word.
    for (let i = 1; i < weights.length; i++) expect(weights[i]!).toBeLessThan(weights[i - 1]!)
  })

  it('is the same wave, shifted — glyph i at t equals glyph 0 at t − i·delay', () => {
    for (let i = 0; i < 4; i++) {
      expect(glyphConfig(wave, 2, i, 4).axes.wght!)
        .toBeCloseTo(glyphConfig(wave, 2 - i * 0.5, 0, 4).axes.wght!, 10)
    }
  })

  it('the crest moves along the word as time advances', () => {
    // Whichever glyph is heaviest at t is not the heaviest one a moment later
    // in a pingpong cycle — the peak travels rather than the word pulsing.
    const c = staggered(0.6, 'forward', 0, [track({ path: 'axes.wght', from: 100, to: 900, easing: 'pingpong' })])
    const heaviest = (t: number) => {
      const w = [0, 1, 2, 3, 4].map(i => glyphConfig(c, t, i, 5).axes.wght!)
      return w.indexOf(Math.max(...w))
    }
    expect(heaviest(2)).not.toBe(heaviest(3.2))
  })

  it('collapses to one shared config when stagger is off', () => {
    const flat = staggered(0, 'forward', 0, [track({ path: 'axes.wght', from: 100, to: 900 })])
    const weights = [0, 1, 2, 3].map(i => glyphConfig(flat, 2, i, 4).axes.wght)
    expect(new Set(weights).size).toBe(1)
  })

  it('never mutates the config while walking a whole clip', () => {
    const before = structuredClone(wave)
    for (let f = 0; f <= 24; f++) {
      for (let i = 0; i < 4; i++) glyphConfig(wave, f / 6, i, 4)
    }
    expect(wave).toEqual(before)
  })
})

describe('glyphTransform', () => {
  it('is the identity when nothing targets the glyph namespace', () => {
    expect(glyphTransform(withTracks([track()]), 2, 0, 4)).toEqual(IDENTITY_GLYPH_TRANSFORM)
    expect(glyphTransform(cfg(), 2, 0, 4)).toEqual(IDENTITY_GLYPH_TRANSFORM)
  })

  it('reads every declared glyph field', () => {
    const c = withTracks([
      track({ path: 'glyph.dx', from: 0, to: 100 }),
      track({ path: 'glyph.dy', from: 0, to: -200 }),
      track({ path: 'glyph.scale', from: 0, to: 1 }),
      track({ path: 'glyph.rotate', from: -90, to: 90 }),
      track({ path: 'glyph.opacity', from: 0, to: 1 }),
    ])
    expect(glyphTransform(c, 4, 0, 1)).toEqual({ dx: 100, dy: -200, scale: 1, rotate: 90, opacity: 1 })
  })

  it('evaluates on the glyph\'s own clock', () => {
    const c = staggered(0.5, 'forward', 0, [track({ path: 'glyph.opacity', from: 0, to: 1 })])
    const o = [0, 1, 2, 3].map(i => glyphTransform(c, 2, i, 4).opacity)
    expect(o.map(v => Number(v.toFixed(4)))).toEqual([0.5, 0.375, 0.25, 0.125])
  })

  it('does not leak a glyph track into the config', () => {
    const c = withTracks([track({ path: 'glyph.dy', from: 0, to: 120 })])
    const before = structuredClone(c)
    glyphTransform(c, 2, 1, 4)
    expect(c).toEqual(before)
  })

  it('works on a raw storage blob', () => {
    const raw = storageBlob({
      duration: 4,
      stagger: { delay: 0.5, order: 'reverse' },
      moves: trackMoves([track({ path: 'glyph.opacity', from: 0, to: 1 })]),
    })
    expect(glyphTransform(raw, 2, 3, 4).opacity).toBeCloseTo(0.5, 10)
    expect(glyphTransform(raw, 2, 0, 4).opacity).toBeCloseTo(0.125, 10)
  })
})

describe('the stagger controls are declared, gated, and rebuilt', () => {
  it('lands in the Motion section with keys that resolve', () => {
    const c = cfg()
    const params = makeConfigParams(() => c)
    for (const key of ['motion.stagger.delay', 'motion.stagger.order', 'motion.stagger.seed']) {
      const spec = VT_CONTROLS.find(s => s.key === key)
      expect(spec, key).toBeTruthy()
      expect(spec!.group).toBe('Motion')
      expect(params[key], key).toBeDefined()
    }
  })

  it('withholds the shuffle seed until the order is actually shuffled', () => {
    const keys = (order: VtStaggerOrder) =>
      visibleVtControls(cfg({ motion: { ...DEFAULT_CONFIG.motion, stagger: { delay: 0, order, seed: 0 } } }))
        .map(c => c.key)
    expect(keys('forward')).not.toContain('motion.stagger.seed')
    expect(keys('random')).toContain('motion.stagger.seed')
    expect(keys('forward')).toContain('motion.stagger.delay')
  })

  it('mergeConfig rebuilds the stagger block strictly', () => {
    expect(mergeConfig({}).motion.stagger).toEqual({ delay: 0, order: 'forward', seed: 0 })
    expect(mergeConfig({ motion: { stagger: { delay: 0.3, order: 'edges', seed: 12 } } }).motion.stagger)
      .toEqual({ delay: 0.3, order: 'edges', seed: 12 })
    expect(mergeConfig({ motion: { stagger: { delay: -1, order: 'sideways', seed: 1e9 } } }).motion.stagger)
      .toEqual({ delay: 0, order: 'forward', seed: 999 })
    expect(mergeConfig({ motion: { stagger: 'none' } }).motion.stagger)
      .toEqual({ delay: 0, order: 'forward', seed: 0 })
    for (const order of VT_STAGGER_ORDERS) {
      expect(mergeConfig({ motion: { stagger: { order } } }).motion.stagger.order).toBe(order)
    }
  })

  it('cloneConfig gives the stagger block its own object', () => {
    const a = cfg({ motion: { ...DEFAULT_CONFIG.motion, stagger: { delay: 0.2, order: 'center', seed: 3 } } })
    const b = cloneConfig(a)
    b.motion.stagger.delay = 9
    expect(a.motion.stagger.delay).toBe(0.2)
  })

  it('DEFAULT_CONFIG does not share its stagger with DEFAULT_MOTION', () => {
    expect(DEFAULT_CONFIG.motion.stagger).not.toBe(mergeConfig({}).motion.stagger)
    expect(DEFAULT_CONFIG.motion.stagger).toEqual({ delay: 0, order: 'forward', seed: 0 })
  })
})
