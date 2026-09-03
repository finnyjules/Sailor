/**
 * Vector Type — how motion, Collection bindings and the agent ADDRESS a layer.
 *
 * The stack carries a stable `id` per layer for exactly one reason, and this
 * file is the proof of it:
 *
 *   **A positional path silently re-points when the array is spliced.** A track
 *   on `appearance.0.width` keeps animating slot 0, which after a reorder is a
 *   DIFFERENT layer. Nothing throws, nothing warns, and the user's work is now
 *   driving the wrong thing. It is the one failure in this design that destroys
 *   work rather than erroring.
 *
 * So every persisted reference is `appearance.<layerId>.<leaf>`, and the two
 * halves of the guarantee are asserted separately throughout:
 *
 *   1. **Reorder is a NO-OP** — the same layer still animates, checked by
 *      applying the motion and reading the VALUE off the layer, never by
 *      comparing path strings. Every reorder test below performs a real splice.
 *   2. **A deleted layer degrades to IGNORED** — never to the layer that slid
 *      into its slot. That asymmetry is why this matters more for the stack than
 *      for the font axes: a stale `axes.<tag>` is dropped by `clampCoords`
 *      because the tag genuinely does not exist, but a stale INDEX resolves to a
 *      real member and applies a real value to it.
 *
 * Every "it still works" claim here is paired with a NEGATIVE control — the same
 * scenario driven through a positional path, shown to break — because a test
 * that only ever sees the fixed code cannot tell whether it is testing anything.
 *
 * NO NETWORK, NO DOM.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as fontkit from 'fontkit'
import { describe, expect, it } from 'vitest'
import { normaliseAxes, type VtFont } from '~/lib/vectortype/font'
import {
  DEFAULT_CONFIG,
  VT_DEFAULT_STROKE_WIDTH,
  mergeConfig,
  migrateStackTrackPaths,
  vtLayer,
  type VectorTypeConfig,
  type VtAppearanceLayer,
  type VtMotionTrack,
  type VtMove,
} from '~/lib/vectortype/config'
import type { MoveEase, MovePlay } from '~/lib/studio/moves/types'
import { VT_CONTROLS, VT_LAYER_PREFIX, visibleVtControls } from '~/lib/vectortype/controls'
import { vtLayerLabels } from '~/lib/vectortype/layerLabel'
import {
  VT_APPEARANCE_REMAP,
  VT_STACK_PREFIX,
  animatableTargets,
  applyMotion,
  pruneStackTracks,
  trackLayerId,
} from '~/lib/vectortype/motion'
import { vtAgentControls, vtBindableControls, vtStackControls } from '~/lib/vectortype/agentControls'
import { paintPrimaryColor } from '~/lib/spacetype/fillTile'
import { vectorTypeSVG } from '~/lib/vectortype/canvas'
import { makeConfigParams } from '~/lib/agent/configParams'
import { getByIdPath, setByIdPath } from '~/lib/studio/idPath'
import { describeControls, validatePatch } from '~/lib/spacetype/controlDescriptor'
import { applyParamsPreview } from '~/composables/useStudioVarBindings'
import { mapControlSpecToDesc } from '~/lib/collection/studioControls'
import { listStudioBindables } from '~/lib/collection/studioBindables'

const FIXTURE = fileURLToPath(new URL('../fixtures/inter-subset-var.ttf', import.meta.url))
function loadFixtureFont(): VtFont {
  const bytes = new Uint8Array(readFileSync(FIXTURE))
  const raw: any = (fontkit as any).create(bytes)
  return { id: 'inter-subset', axes: normaliseAxes(raw?.variationAxes), unitsPerEm: Number(raw?.unitsPerEm) || 1000, raw }
}
const font = loadFixtureFont()
const BOX = { width: 400, height: 200 }

function cfg(patch: Partial<VectorTypeConfig> = {}): VectorTypeConfig {
  return mergeConfig({ ...DEFAULT_CONFIG, text: 'Sail', size: 100, ...patch })
}
/** Ids are given explicitly so every assertion below names a layer, never a slot. */
function stack(...layers: Partial<VtAppearanceLayer>[]): VectorTypeConfig {
  return cfg({ appearance: layers.map(l => vtLayer(l)) })
}
/** A track "spec" in the OLD shape (`easing`/`loops`) — used two ways below:
 *  as a raw literal inside an old-shape `motion.tracks` blob fed to
 *  `mergeConfig` (section 6, testing the LEGACY conversion itself, where the
 *  fields must still be there for `mergeTrack`/`convertLegacyTracks` to
 *  read), and as the input `withTracks` (below) wraps into a fresh MOVE. */
const track = (path: string, from = 0, to = 1): VtMotionTrack & { easing: string; loops: number } =>
  ({ path, from, to, easing: 'linear', loops: 1, hold: 0, cycleOffset: 0, delay: 0 })

/** `easing`/`loops` → the owning move's `ease`/`play` — see the identical
 *  helper in `vectortype-motion.unit.spec.ts`. Every `track()` call in this
 *  file uses the default `'linear'`/`1`, so this only ever produces
 *  `ease: none, play: once` here — restated in full for parity with the
 *  other specs that build this way. */
function easeAndPlay(easing: string, loops: number): { ease: MoveEase; play: MovePlay } {
  if (easing === 'pingpong') return { ease: { kind: 'named', name: 'none' }, play: { mode: 'backAndForth', times: loops } }
  if (easing === 'easeinout') return { ease: { kind: 'named', name: 'natural' }, play: { mode: 'once', times: loops } }
  return { ease: { kind: 'named', name: 'none' }, play: { mode: 'once', times: loops } }
}

let trackMoveSeq = 0
/** One `kind: 'tracks'` move per track spec — the fresh-config path (sections
 *  1–5). Bypasses `mergeConfig`: these tests build `c.motion` directly and
 *  call `applyMotion`/etc. straight on it, exactly as the original flat
 *  `motion.tracks` assignment did. */
function trackMoves(specs: ReturnType<typeof track>[]): VtMove[] {
  return specs.map((t) => {
    trackMoveSeq += 1
    const { ease, play } = easeAndPlay(t.easing, t.loops)
    const { path, from, to, hold, cycleOffset, delay } = t
    return {
      id: `move-t${trackMoveSeq}`, phase: 'loop', kind: 'tracks', presetId: 'custom',
      duration: 4, ease, play, tracks: [{ path, from, to, hold, cycleOffset, delay }],
    } as VtMove
  })
}

const withTracks = (c: VectorTypeConfig, ...tracks: ReturnType<typeof track>[]): VectorTypeConfig => {
  c.motion = { ...c.motion, duration: 4, moves: trackMoves(tracks) }
  return c
}

/** Every track any `'tracks'`-kind move owns, flattened — the direct
 *  replacement for reading the old flat `motion.tracks` array. */
const allTracks = (c: VectorTypeConfig): VtMotionTrack[] =>
  c.motion.moves.filter(m => m.kind === 'tracks').flatMap(m => (m.tracks ?? []) as VtMotionTrack[])
/** The first (and, in every section-6 fixture, only) track — the direct
 *  replacement for `c.motion.tracks[0]`. */
const firstTrack = (c: VectorTypeConfig): VtMotionTrack | undefined => allTracks(c)[0]
/** The move owning the first track, for tests that mutate the stored path in
 *  place (`firstTrack(c)!.path = ...` in the old shape). */
const firstTrackMove = (c: VectorTypeConfig): VtMove =>
  c.motion.moves.find(m => m.kind === 'tracks' && (m.tracks?.length ?? 0) > 0)!
/** A layer read back BY ID, so no assertion in this file can be satisfied by
 *  "whatever is at index N". */
const byId = (c: VectorTypeConfig, id: string): VtAppearanceLayer =>
  c.appearance.find(l => l.id === id)!

/** The surface's `reorderLayer`, minus the Vue: a real splice, both directions. */
function reorder(c: VectorTypeConfig, from: number, to: number): void {
  const [moved] = c.appearance.splice(from, 1)
  c.appearance.splice(to, 0, moved!)
}

// ── 1. the expansion ────────────────────────────────────────────────────────

describe('animatable targets expand per layer, addressed by the layer’s own id', () => {
  const three = () => stack(
    { id: 'Lfill', kind: 'fill' },
    { id: 'Lstroke', kind: 'stroke', width: 4 },
    { id: 'Lext', kind: 'extrude', depth: 6 },
  )

  it('emits one ABSOLUTE id path per layer for each relative `layer.` slider', () => {
    const paths = animatableTargets(three()).map(t => t.path)
    // The stroke width exists on the stroke and on NOTHING else — the `when`
    // predicate is asked about each layer in turn, not about layer 0.
    expect(paths).toContain('appearance.Lstroke.width')
    expect(paths).not.toContain('appearance.Lfill.width')
    expect(paths).not.toContain('appearance.Lext.width')
    // …and the extrude knobs likewise.
    expect(paths).toContain('appearance.Lext.depth')
    expect(paths).not.toContain('appearance.Lstroke.depth')
    // Opacity is ungated, so every layer offers it.
    for (const id of ['Lfill', 'Lstroke', 'Lext']) expect(paths).toContain(`appearance.${id}.opacity`)
    // Nothing relative survives — `applyMotion` has no `layer` key to resolve.
    expect(paths.some(p => p.startsWith(VT_LAYER_PREFIX))).toBe(false)
  })

  it('never emits a member segment that could be read as an index', () => {
    // `lib/studio/path.ts`'s `isIndex` is /^\d+$/, so an all-digit id would make
    // `appearance.<id>.width` resolve to a POSITION — a real but wrong layer.
    // `config.ts` rejects such an id; this is the consumer-side half of that.
    const c = mergeConfig({ ...DEFAULT_CONFIG, appearance: [{ kind: 'fill' }, { kind: 'stroke' }] })
    for (const t of animatableTargets(c)) {
      if (!t.path.startsWith(VT_STACK_PREFIX)) continue
      expect(t.path.split('.')[1], t.path).not.toMatch(/^\d+$/)
    }
  })

  it('labels each target with the layer’s NAME, from the same helper the aside uses', () => {
    const c = stack({ id: 'La', kind: 'fill' }, { id: 'Lb', kind: 'stroke' }, { id: 'Lc', kind: 'fill' })
    expect(vtLayerLabels(c.appearance)).toEqual(['Fill', 'Stroke', 'Fill 2'])
    const labelOf = (p: string) => animatableTargets(c).find(t => t.path === p)!.label
    expect(labelOf('appearance.La.opacity')).toBe('Fill · Layer opacity')
    expect(labelOf('appearance.Lb.opacity')).toBe('Stroke · Layer opacity')
    expect(labelOf('appearance.Lc.opacity')).toBe('Fill 2 · Layer opacity')
  })

  it('keeps every label UNIQUE — motion builds its dropdown from them', () => {
    // Three fills and two strokes: the shape where a kind-derived name without an
    // ordinal collapses to five entries a user cannot tell apart.
    const c = stack(
      { id: 'L1', kind: 'fill' }, { id: 'L2', kind: 'fill' }, { id: 'L3', kind: 'stroke' },
      { id: 'L4', kind: 'fill' }, { id: 'L5', kind: 'stroke' },
    )
    const labels = animatableTargets(c).map(t => t.label)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('RENAMES nothing on reorder — the labels move with their layers', () => {
    const c = three()
    const before = new Map(animatableTargets(c).map(t => [t.path, t.label]))
    reorder(c, 0, 2)
    expect(c.appearance.map(l => l.id)).toEqual(['Lstroke', 'Lext', 'Lfill'])
    const after = new Map(animatableTargets(c).map(t => [t.path, t.label]))
    // Same paths, same labels. A positional scheme would have renumbered both.
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort())
    for (const [path, label] of after) expect(label, path).toBe(before.get(path))
  })

  it('falls back to a positional path only for a layer with no usable id', () => {
    // `mergeConfig` always mints one, so this is the raw-blob path: a target that
    // resolves today beats no target at all, and it still animates the right
    // layer until something moves.
    const raw = { ...cfg(), appearance: [{ kind: 'fill', opacity: 1 } as any] } as VectorTypeConfig
    expect(animatableTargets(raw).map(t => t.path)).toContain('appearance.0.opacity')
  })
})

// ── 2. reorder is a no-op, proved by reordering ─────────────────────────────

describe('reorder is a NO-OP for a motion track — the SAME layer still animates', () => {
  /** Three layers, each with its own opacity, so "which layer moved" is readable
   *  off the values and not just off the ids. */
  const three = () => stack(
    { id: 'Lred', kind: 'fill', width: 1, opacity: 0.11 },
    { id: 'Lcyan', kind: 'stroke', width: 4, opacity: 0.22 },
    { id: 'Lgreen', kind: 'extrude', width: 2, depth: 6, opacity: 0.33 },
  )

  it('drives the same layer after a REAL splice, read back from the applied value', () => {
    const c = withTracks(three(), track('appearance.Lcyan.opacity', 0, 1))
    // Before: t=4/4 puts 1 on Lcyan and leaves the others at their stored values.
    const pre = applyMotion(c, 4)
    expect(byId(pre, 'Lcyan').opacity).toBe(1)
    expect(byId(pre, 'Lred').opacity).toBe(0.11)
    expect(byId(pre, 'Lgreen').opacity).toBe(0.33)

    // THE REORDER. Bottom layer to the top — Lcyan slides from index 1 to 0.
    reorder(c, 0, 2)
    expect(c.appearance.map(l => l.id)).toEqual(['Lcyan', 'Lgreen', 'Lred'])
    // Not one byte of the motion block was touched by the reorder.
    expect(allTracks(c).map(t => t.path)).toEqual(['appearance.Lcyan.opacity'])

    const post = applyMotion(c, 4)
    expect(byId(post, 'Lcyan').opacity).toBe(1)
    expect(byId(post, 'Lred').opacity).toBe(0.11)
    expect(byId(post, 'Lgreen').opacity).toBe(0.33)
  })

  it('NEGATIVE CONTROL — the same reorder re-aims a POSITIONAL track', () => {
    // Deliberately broken addressing, run through the same splice. Without this
    // the test above proves only that the config was not corrupted.
    const c = withTracks(three(), track('appearance.1.opacity', 0, 1))
    expect(byId(applyMotion(c, 4), 'Lcyan').opacity).toBe(1)
    reorder(c, 0, 2)
    const post = applyMotion(c, 4)
    // Slot 1 is now Lgreen. The track has quietly changed which layer it drives.
    expect(byId(post, 'Lgreen').opacity).toBe(1)
    expect(byId(post, 'Lcyan').opacity).toBe(0.22)
  })

  it('survives every ordering of a three-layer stack', () => {
    // Not one hand-picked move: all six permutations, each reached by a real
    // splice from the original order.
    const moves: [number, number][] = [[0, 1], [0, 2], [1, 0], [1, 2], [2, 0], [2, 1]]
    for (const [from, to] of moves) {
      const c = withTracks(three(), track('appearance.Lcyan.width', 0, 20))
      reorder(c, from, to)
      const out = applyMotion(c, 4)
      expect(byId(out, 'Lcyan').width, `${from}->${to}`).toBe(20)
      expect(byId(out, 'Lred').width, `${from}->${to}`).toBe(1)
      expect(byId(out, 'Lgreen').width, `${from}->${to}`).toBe(2)
    }
  })

  it('survives DUPLICATE — the copy takes a fresh id and is not animated', () => {
    const c = withTracks(three(), track('appearance.Lcyan.opacity', 0, 1))
    // The surface's `duplicateLayer`: same fields, brand new id, inserted above.
    c.appearance.splice(2, 0, vtLayer({ ...structuredClone(c.appearance[1]!), id: 'Lcopy' }))
    const out = applyMotion(c, 4)
    expect(byId(out, 'Lcyan').opacity).toBe(1)
    expect(byId(out, 'Lcopy').opacity).toBe(0.22)
  })

  it('survives APPEND, which is what add does', () => {
    const c = withTracks(three(), track('appearance.Lgreen.opacity', 0, 1))
    c.appearance.push(vtLayer({ id: 'Lnew', kind: 'fill' }))
    expect(byId(applyMotion(c, 4), 'Lgreen').opacity).toBe(1)
  })

  it('changes the PICTURE by the same reorder, so the config is not the only witness', () => {
    // A stroke over a fill exports N paths in one order and N in the other, but
    // in a different sequence — the paint order really moved while the track did
    // not. Read from the real SVG writer, not from the config.
    const c = withTracks(
      stack({ id: 'Lfill', kind: 'fill', paint: '#ff2200' }, { id: 'Lstroke', kind: 'stroke', width: 8, paint: '#00c8ff' }),
      track('appearance.Lstroke.width', 8, 24),
    )
    const svgAt = (x: VectorTypeConfig) => vectorTypeSVG(font, applyMotion(x, 4), 4, BOX).svg
    const before = svgAt(c)
    reorder(c, 0, 1)
    const after = svgAt(c)
    expect(after).not.toBe(before)
    // Both documents carry the animated width — the stroke is still the animated
    // layer, whichever end of the stack it is at.
    expect(before).toContain('stroke-width="24"')
    expect(after).toContain('stroke-width="24"')
  })

  it('`trackLayerId` answers the question every one of these tests is asking', () => {
    const c = three()
    expect(trackLayerId(c, 'appearance.Lcyan.opacity')).toBe('Lcyan')
    expect(trackLayerId(c, 'appearance.1.opacity')).toBe('Lcyan')
    reorder(c, 0, 2)
    expect(trackLayerId(c, 'appearance.Lcyan.opacity')).toBe('Lcyan')
    // The positional one now names a different layer. Same string, new meaning.
    expect(trackLayerId(c, 'appearance.1.opacity')).toBe('Lgreen')
    expect(trackLayerId(c, 'axes.wght')).toBeUndefined()
  })

  it('leaves an id path alone at the surface’s remap choke point', () => {
    // `VT_APPEARANCE_REMAP` is still wired for legacy positional tracks. If it
    // matched an id path it would rewrite it back into a position and undo this
    // whole file.
    const tracks = [track('appearance.Lcyan.width'), track('appearance.2.depth')]
    const moved = VT_APPEARANCE_REMAP.onReorder(tracks, 0, 2)
    expect(moved.map(t => t.path)).toEqual(['appearance.Lcyan.width', 'appearance.1.depth'])
  })
})

// ── 3. a deleted layer degrades to ignored, never to a wrong layer ──────────

describe('a binding or track to a DELETED layer is ignored, never re-aimed', () => {
  const three = () => stack(
    { id: 'Lred', kind: 'fill', width: 1, opacity: 0.11 },
    { id: 'Lcyan', kind: 'stroke', width: 4, opacity: 0.22 },
    { id: 'Lgreen', kind: 'extrude', width: 2, depth: 6, opacity: 0.33 },
  )

  it('applies NOTHING when the layer is gone — including to the layer that took its slot', () => {
    const c = withTracks(three(), track('appearance.Lcyan.opacity', 0, 1))
    c.appearance.splice(1, 1) // Lgreen slides into index 1
    expect(c.appearance.map(l => l.id)).toEqual(['Lred', 'Lgreen'])
    const out = applyMotion(c, 4)
    expect(byId(out, 'Lgreen').opacity).toBe(0.33)
    expect(byId(out, 'Lred').opacity).toBe(0.11)
    // Nothing was fabricated either — no `Lcyan` property grown on the array.
    expect(JSON.stringify(out.appearance)).toBe(JSON.stringify(c.appearance))
    expect(Object.keys(out.appearance as unknown as object)).toEqual(['0', '1'])
  })

  it('NEGATIVE CONTROL — the positional form hits the wrong layer instead', () => {
    const c = withTracks(three(), track('appearance.1.opacity', 0, 1))
    c.appearance.splice(1, 1)
    expect(byId(applyMotion(c, 4), 'Lgreen').opacity).toBe(1)
  })

  it('holds for EVERY layer, deleted from every position', () => {
    // Trying to make it hit a wrong layer: each of the three deleted in turn,
    // with the track aimed at the deleted one, and every survivor checked.
    for (const victim of ['Lred', 'Lcyan', 'Lgreen']) {
      const c = withTracks(three(), track(`appearance.${victim}.opacity`, 0, 1))
      const before = JSON.parse(JSON.stringify(c.appearance.filter(l => l.id !== victim)))
      c.appearance = c.appearance.filter(l => l.id !== victim)
      expect(applyMotion(c, 4).appearance, victim).toEqual(before)
    }
  })

  it('drops the dangling track rather than leaving a row that animates nothing', () => {
    const c = withTracks(three(),
      track('appearance.Lcyan.opacity'), track('appearance.Lred.opacity'), track('axes.wght'))
    c.appearance.splice(1, 1)
    const pruned = pruneStackTracks(c).filter(m => m.kind === 'tracks').flatMap(m => m.tracks ?? [])
    expect(pruned.map(t => t.path)).toEqual(['appearance.Lred.opacity', 'axes.wght'])
  })

  it('returns the SAME array when nothing is dangling, so no watcher fires', () => {
    const c = withTracks(three(), track('appearance.Lcyan.opacity'), track('size'))
    expect(pruneStackTracks(c)).toBe(c.motion.moves)
  })

  it('makes the params proxy refuse the unknown id — read undefined, write dropped', () => {
    const c = three()
    c.appearance.splice(1, 1)
    const params = makeConfigParams(() => c, () => 0, 'appearance')
    const before = JSON.stringify(c)
    expect(params['appearance.Lcyan.opacity']).toBeUndefined()
    params['appearance.Lcyan.opacity'] = 0.9
    expect(JSON.stringify(c)).toBe(before)
    // …and specifically the layer now at index 1 is untouched.
    expect(byId(c, 'Lgreen').opacity).toBe(0.33)
  })

  it('refuses an OUT-OF-RANGE positional index too, rather than growing the array', () => {
    // `write` creates missing containers by design, so `appearance.5.width` on a
    // three-layer stack would grow two empty objects the renderer reads as layers.
    const c = three()
    const params = makeConfigParams(() => c, () => 0, 'appearance')
    params['appearance.5.width'] = 12
    expect(c.appearance).toHaveLength(3)
    expect(params['appearance.5.width']).toBeUndefined()
  })

  it('takes the deleted layer’s keys OUT of the Collection bindable list', () => {
    // This is the first of two nets: `applyParamsPreview` only applies a key it
    // has a control for, so a binding whose layer is gone is skipped outright.
    const c = three()
    expect(vtBindableControls(c).map(k => k.key)).toContain('appearance.Lcyan.width')
    c.appearance.splice(1, 1)
    expect(vtBindableControls(c).map(k => k.key)).not.toContain('appearance.Lcyan.width')
  })

  it('applies a stale binding to NOTHING, end to end', () => {
    const c = three()
    c.appearance.splice(1, 1)
    const controls = vtBindableControls(c).map(mapControlSpecToDesc)
    const params = makeConfigParams(() => c, () => 0, 'appearance')
    const applied = applyParamsPreview(
      { params: { 'appearance.Lcyan.width': 30, 'appearance.Lred.opacity': 0.5 } },
      controls,
      (k, v) => { params[k] = v },
    )
    expect(applied).toEqual(['appearance.Lred.opacity'])
    expect(byId(c, 'Lred').opacity).toBe(0.5)
    expect(byId(c, 'Lgreen').opacity).toBe(0.33)
    expect(byId(c, 'Lgreen').width).toBe(2)
  })

  it('binds against a NAMED layer, never against the selection', () => {
    // The relative `layer.*` keys mean "whichever layer is active", which for a
    // PERSISTED binding means the same saved row paints a different layer
    // depending on where the user last clicked. They are withheld here.
    const bindables = listStudioBindables(vtBindableControls(three()).map(mapControlSpecToDesc))
    expect(bindables.some(b => b.path.startsWith(`params.${VT_LAYER_PREFIX}`))).toBe(false)
    expect(bindables.map(b => b.path)).toContain('params.appearance.Lcyan.width')
    // …while the agent still gets both (see the agent block below).
    expect(vtAgentControls(three()).map(c => c.key)).toContain('layer.paint.a')
  })

  it('sweeps a per-layer parameter into DISTINCT documents', () => {
    // The Collection sweep, reduced to what it actually does: write each row's
    // value at one bound path and render. Distinct values must give distinct
    // frames, and only on the layer named.
    const c = stack(
      { id: 'Lfill', kind: 'fill', paint: '#ff2200' },
      { id: 'Lstroke', kind: 'stroke', width: 4, paint: '#00c8ff' },
    )
    const params = makeConfigParams(() => c, () => 0, 'appearance')
    const frames = [2, 10, 24].map((v) => {
      params['appearance.Lstroke.width'] = v
      return vectorTypeSVG(font, c, 0, BOX).svg
    })
    expect(new Set(frames).size).toBe(3)
    for (const [i, w] of [2, 10, 24].entries()) expect(frames[i]).toContain(`stroke-width="${w}"`)
    // The fill layer was never touched by any of the three rows.
    expect(paintPrimaryColor(byId(c, 'Lfill').paint)).toBe('#ff2200')
  })
})

// ── 4. the agent can name a layer ───────────────────────────────────────────

describe('the agent addresses a layer by name — “make the outline thicker”', () => {
  /** The shape that broke it: a migrated node, fill at 0, stroke above it. */
  const migrated = () => stack(
    { id: 'Lfill', kind: 'fill' },
    { id: 'Lstroke', kind: 'stroke', width: 3 },
  )

  it('offers a stroke-width key even though the HEADLESS active layer is a fill', () => {
    const keys = vtAgentControls(migrated()).map(c => c.key)
    // The regression, restated as an assertion: the relative key is correctly
    // withheld — layer 0 is a fill and an outline width on a fill paints nothing.
    expect(visibleVtControls(migrated(), 0).map(c => c.key)).not.toContain('layer.width')
    expect(keys).not.toContain('layer.width')
    // …and the layer-named key is what the agent reaches for instead.
    expect(keys).toContain('appearance.Lstroke.width')
  })

  it('labels it so the model can tell WHICH layer it is thickening', () => {
    const c = vtAgentControls(migrated()).find(x => x.key === 'appearance.Lstroke.width')!
    expect(c.label).toBe('Stroke · Stroke width')
    expect(c).toMatchObject({ kind: 'slider', min: 0, max: 40 })
  })

  it('carries the patch all the way onto the stroke, and only the stroke', () => {
    // The whole round trip: describe → validate → apply. A key that survives
    // `validatePatch` but does not resolve is the silent failure this catches.
    const c = migrated()
    const params = makeConfigParams(() => c, () => 0, 'appearance')
    const described = describeControls(vtAgentControls(c), params)
    const patch = validatePatch({ 'appearance.Lstroke.width': 18 }, described)
    expect(patch).toEqual({ 'appearance.Lstroke.width': 18 })
    for (const [k, v] of Object.entries(patch)) params[k] = v
    expect(byId(c, 'Lstroke').width).toBe(18)
    // The fill's own (inert) width is untouched — the key named ONE layer.
    expect(byId(c, 'Lfill').width).toBe(VT_DEFAULT_STROKE_WIDTH)
  })

  it('really thickens the OUTLINE in the exported document', () => {
    // Not "a number changed": the stroke the user asked about is wider on the page.
    const c = migrated()
    const params = makeConfigParams(() => c, () => 0, 'appearance')
    expect(vectorTypeSVG(font, c, 0, BOX).svg).toContain('stroke-width="3"')
    params['appearance.Lstroke.width'] = 18
    expect(vectorTypeSVG(font, c, 0, BOX).svg).toContain('stroke-width="18"')
  })

  it('keeps the ACTIVE-layer vocabulary too — the two are not interchangeable', () => {
    // "Make this layer red" is about the selection; "make the outline thicker"
    // names a layer. Dropping the relative keys would lose the first.
    const keys = vtAgentControls(migrated(), [], 1).map(c => c.key)
    expect(keys).toContain('layer.width')       // active layer IS the stroke here
    expect(keys).toContain('appearance.Lstroke.width')
  })

  it('names each layer once per applicable control, and never twice', () => {
    const c = stack({ id: 'La', kind: 'fill' }, { id: 'Lb', kind: 'fill' }, { id: 'Lc', kind: 'stroke' })
    const keys = vtStackControls(c).map(k => k.key)
    expect(new Set(keys).size).toBe(keys.length)
    const labels = vtStackControls(c).map(k => k.label)
    expect(new Set(labels).size).toBe(labels.length)
    // Only ONE width key on a stack with one stroke, and it names the stroke.
    expect(keys.filter(k => k.endsWith('.width'))).toEqual(['appearance.Lc.width'])
  })

  it('every offered key resolves against a real leaf', () => {
    // A key the agent can write but the config cannot store is the dead-control
    // failure `controls.ts` exists to prevent, one addressing scheme out.
    const c = stack(
      { id: 'La', kind: 'fill' }, { id: 'Lb', kind: 'stroke', width: 2 }, { id: 'Lc', kind: 'extrude', depth: 3 },
    )
    const params = makeConfigParams(() => c, () => 0, 'appearance')
    const unresolved = vtStackControls(c).map(k => k.key).filter(k => params[k] === undefined)
    expect(unresolved).toEqual([])
  })

  it('skips a layer whose id could be mistaken for an index', () => {
    // An agent key is a promise about WHICH layer it edits. A positional one
    // cannot keep that promise, so no key is minted at all — the opposite trade
    // from motion, which resolves a track that already exists.
    const raw = { ...cfg(), appearance: [{ kind: 'stroke', width: 3, id: '2' } as any] } as VectorTypeConfig
    expect(vtStackControls(raw)).toEqual([])
  })

  it('offers nothing at all for an empty stack', () => {
    expect(vtStackControls(cfg({ appearance: [] }))).toEqual([])
    expect(vtStackControls({} as VectorTypeConfig)).toEqual([])
  })

  it('expands exactly the `layer.` declarations and no others', () => {
    // Derived, not hand-listed: a new `layer.*` control must show up here on the
    // day it is declared, and a top-level key must never be expanded per layer.
    const c = stack({ id: 'La', kind: 'stroke', width: 2 })
    const expanded = new Set(vtStackControls(c).map(k => k.key.replace(/^appearance\.La\./, VT_LAYER_PREFIX)))
    const declared = VT_CONTROLS.filter(x => x.key.startsWith(VT_LAYER_PREFIX) && (!x.when || x.when(c, c.appearance[0])))
    expect([...expanded].sort()).toEqual(declared.map(x => x.key).sort())
  })
})

// ── 5. nothing fabricates structure ─────────────────────────────────────────

describe('an unresolvable path grows NO junk into the config', () => {
  const two = () => stack({ id: 'Lfill', kind: 'fill' }, { id: 'Lstroke', kind: 'stroke', width: 3 })

  it('`setByIdPath` refuses an unknown id and leaves the config byte-identical', () => {
    const c = two()
    const before = JSON.stringify(c)
    expect(setByIdPath(c, 'appearance.Lnope.width', 9)).toBe(false)
    expect(JSON.stringify(c)).toBe(before)
    expect(getByIdPath(c, 'appearance.Lnope.width')).toBeUndefined()
  })

  it('`setByIdPath` guards on the PARENT, exactly as `applyMotion` does', () => {
    // `setByPath` creates missing containers, so a path that resolves partially
    // would grow a container the renderer then reads as real config — and it
    // gets SAVED. The leaf may legitimately be absent; the parent may not.
    const c = two()
    const before = JSON.stringify(c)
    expect(setByIdPath(c, 'appearance.Lstroke.nothere.deep', 9)).toBe(false)
    expect(JSON.stringify(c)).toBe(before)
    expect((c.appearance[1] as any).nothere).toBeUndefined()
    // …while an absent LEAF under a real parent is still writable.
    expect(setByIdPath(c, 'appearance.Lstroke.brandNew', 9)).toBe(true)
    expect((c.appearance[1] as any).brandNew).toBe(9)
  })

  it('`applyMotion` inherits that guard for stack paths', () => {
    const c = withTracks(two(),
      track('appearance.Lstroke.nothere.deep', 0, 1),
      track('appearance.Lgone.width', 0, 1),
      track('appearance.Lstroke.width', 0, 20))
    const out = applyMotion(c, 4)
    expect((out.appearance[1] as any).nothere).toBeUndefined()
    expect((out.appearance as any).Lgone).toBeUndefined()
    // The one good track still ran — the guard is not a blanket refusal.
    expect(byId(out, 'Lstroke').width).toBe(20)
  })

  it('leaves the ordinary config paths alone — `axes.<tag>` is not a member path', () => {
    // `axes.wght` is `<something>.<something>` too. Running it through an id
    // resolver would refuse it (there is no `axes` ARRAY) and silently stop every
    // variable axis animating, which is the studio's headline feature.
    const c = withTracks(cfg(), track('axes.wght', 100, 900), track('size', 40, 240))
    const out = applyMotion(c, 4)
    expect(out.axes.wght).toBeCloseTo(900, 6)
    expect(out.size).toBeCloseTo(240, 6)
  })
})

// ── 6. the migration: a POSITIONAL track saved mid-development ──────────────
//
// Two addressing schemes coexisted in one config until `mergeConfig` learned to
// lift the old one. A track written before ids landed says `appearance.1.width`;
// every Collection binding, every agent key and every track written after it
// says `appearance.Lstroke.width`. The positional form only stays correct while
// `VT_APPEARANCE_REMAP` is called at every mutation site, forever, by every
// future author — and Task 9's live negative control showed what it costs when
// one call is missed: the same picture at t=0 and t=4, no error, no warning.
//
// Every test below loads through `mergeConfig` (the real load path) and then
// proves the track by APPLYING it and reading the value off the layer found by
// id — never by comparing path strings, which is the failure mode itself.

describe('a POSITIONAL stack track is migrated onto its layer’s id at load', () => {
  /** What a project saved before Task 9 holds: real layer ids on the stack, a
   *  positional path on the track. `DEFAULT_CONFIG.motion` is deliberately
   *  NOT spread here — it carries today's `moves: []`, and `mergeMotion`
   *  takes the new-shape branch (ignoring `tracks` entirely) the moment
   *  `Array.isArray(o.moves)` is true, even on an empty array. A document
   *  saved before moves existed has no `moves` key at all, which is the
   *  scenario this whole describe block means to reproduce. */
  const saved = (path: string) => ({
    ...DEFAULT_CONFIG,
    text: 'Sail',
    size: 100,
    appearance: [
      vtLayer({ id: 'Lfill', kind: 'fill' }),
      vtLayer({ id: 'Lstroke', kind: 'stroke', width: 3 }),
      vtLayer({ id: 'Lyellow', kind: 'fill' }),
    ],
    motion: {
      duration: 4,
      fps: DEFAULT_CONFIG.motion.fps,
      size: DEFAULT_CONFIG.motion.size,
      stagger: DEFAULT_CONFIG.motion.stagger,
      blink: DEFAULT_CONFIG.motion.blink,
      scatter: DEFAULT_CONFIG.motion.scatter,
      tracks: [track(path, 0, 24)],
    },
  })

  it('rewrites `appearance.<index>.<leaf>` to `appearance.<id>.<leaf>`', () => {
    const c = mergeConfig(saved('appearance.1.width'))
    expect(firstTrack(c)!.path).toBe('appearance.Lstroke.width')
    // …and only the member segment: the leaf survives, and the timing
    // (`easing: 'linear'` → the owning move's `ease: none`/`play: once`)
    // landed on the move that now owns it.
    expect(firstTrack(c)).toMatchObject({ from: 0, to: 24 })
    expect(firstTrackMove(c)).toMatchObject({ ease: { kind: 'named', name: 'none' }, play: { mode: 'once' } })
  })

  it('drives the SAME layer it drove before the migration', () => {
    const before = applyMotion(mergeConfig(saved('appearance.1.width')), 4)
    expect(byId(before, 'Lstroke').width).toBe(24)
    // The other two keep their STORED width — the value landed on one layer.
    expect(byId(before, 'Lfill').width).toBe(VT_DEFAULT_STROKE_WIDTH)
  })

  it('SURVIVES a real reorder, which is the whole point', () => {
    const c = mergeConfig(saved('appearance.1.width'))
    // The stroke to the front — Task 9's live scenario, exactly.
    reorder(c, 1, 2)
    expect(c.appearance.map(l => l.id)).toEqual(['Lfill', 'Lyellow', 'Lstroke'])
    // NOTHING was called at the mutation site: no `VT_APPEARANCE_REMAP`, no
    // `pruneStackTracks`. That is the guarantee — an id path needs no promise
    // from a future author.
    const out = applyMotion(c, 4)
    expect(byId(out, 'Lstroke').width).toBe(24)
    expect(byId(out, 'Lyellow').width).toBe(VT_DEFAULT_STROKE_WIDTH)
    expect(byId(out, 'Lfill').width).toBe(VT_DEFAULT_STROKE_WIDTH)
  })

  it('NEGATIVE CONTROL — the un-migrated path lands on the wrong layer, silently', () => {
    // The identical scenario with the migration bypassed: build the merged
    // config, then put the positional path back. Slot 1 is now the yellow FILL,
    // which paints no outline — Task 9 measured this as 5,741 cyan px at both
    // t=0 and t=4.
    const c = mergeConfig(saved('appearance.1.width'))
    reorder(c, 1, 2)
    firstTrack(c)!.path = 'appearance.1.width'
    const out = applyMotion(c, 4)
    expect(byId(out, 'Lstroke').width).toBe(3)        // untouched: the animation is dead
    expect(byId(out, 'Lyellow').width).toBe(24)       // …and landed on a fill
  })

  it('changes the PICTURE, so the config is not the only witness', () => {
    const c = mergeConfig(saved('appearance.1.width'))
    reorder(c, 1, 2)
    const svg = (t: number) => vectorTypeSVG(font, applyMotion(c, t), t, BOX).svg
    // At t=0 the stroke is 0 wide, so it is dropped from the document entirely;
    // at t=4 it is there at 24. Two different pictures.
    expect(svg(0)).not.toContain('stroke-width=')
    expect(svg(4)).toContain('stroke-width="24"')
    // The un-migrated control emits the SAME document at both times.
    const dead = mergeConfig(saved('appearance.1.width'))
    reorder(dead, 1, 2)
    firstTrack(dead)!.path = 'appearance.1.width'
    const deadSvg = (t: number) => vectorTypeSVG(font, applyMotion(dead, t), t, BOX).svg
    expect(deadSvg(4)).toBe(deadSvg(0))
  })

  it('migrates the track `migrateLegacyAppearance` writes for a LEGACY node too', () => {
    // A pre-stack blob: flat `strokeWidth`, animated away from zero, no
    // `appearance` at all. `remapLegacyTrackPath` writes `appearance.<i>.width`
    // — positional — and this lifts that in the same pass.
    const c = mergeConfig({
      text: 'Sail', fill: '#ff0000', strokeWidth: 0, stroke: '#0000ff',
      motion: { duration: 4, tracks: [{ path: 'strokeWidth', from: 0, to: 18, easing: 'linear' }] },
    })
    const strokeId = c.appearance.find(l => l.kind === 'stroke')!.id
    expect(firstTrack(c)!.path).toBe(`appearance.${strokeId}.width`)
    expect(byId(applyMotion(c, 4), strokeId).width).toBe(18)
  })

  it('is IDEMPOTENT — a second load rewrites nothing', () => {
    const once = mergeConfig(saved('appearance.1.width'))
    const twice = mergeConfig(JSON.parse(JSON.stringify(once)))
    expect(firstTrack(twice)!.path).toBe('appearance.Lstroke.width')
    // DEEP equality, not a JSON-string comparison: the first merge builds its
    // move via the shared core's `convertLegacyTracks` (old-shape branch),
    // the second via `mergeMove` (new-shape branch, since `once` already
    // carries `moves`) — same fields, same values, but the two build the
    // object with a different KEY ORDER, which `JSON.stringify` would (and
    // did) treat as a difference despite the configs being identical.
    expect(twice).toEqual(once)
  })

  it('returns the SAME tracks array when nothing needs lifting, so no watcher fires', () => {
    // `migrateStackTrackPaths` itself is still exported and still pure — the
    // flat-array shape it has always taken, exercised directly against a
    // freshly-extracted list (its moves-shaped twin, `migrateMoveTrackPaths`,
    // is what `mergeConfig` actually calls now, per move — see config.ts).
    const c = mergeConfig(saved('appearance.Lstroke.width'))
    const tracks = allTracks(c)
    const again = migrateStackTrackPaths(tracks, c.appearance)
    expect(again).toBe(tracks)
  })

  it('leaves an OUT-OF-RANGE index alone rather than resurrecting it onto a real layer', () => {
    // The track is already dead — `resolveIdPath` refuses an index past the end.
    // Inventing an id for it would apply a real value to a real layer, which is
    // strictly worse than a row that animates nothing.
    const c = mergeConfig(saved('appearance.7.width'))
    expect(firstTrack(c)!.path).toBe('appearance.7.width')
    const out = applyMotion(c, 4)
    // Every layer keeps its stored width: the track applied to nothing at all.
    for (const l of out.appearance) expect(l.width).toBe(VT_DEFAULT_STROKE_WIDTH)
  })

  it('DROPS NOTHING — a load must never delete a row the user can see', () => {
    const c = mergeConfig(saved('appearance.7.width'))
    expect(allTracks(c)).toHaveLength(1)
  })

  it('leaves the ordinary config paths alone', () => {
    const raw = saved('appearance.1.width')
    raw.motion.tracks = [track('axes.wght', 100, 900), track('size', 40, 240), track('glyph.dy', 0, 30)]
    const c = mergeConfig(raw)
    expect(allTracks(c).map(t => t.path)).toEqual(['axes.wght', 'size', 'glyph.dy'])
  })

  it('rewrites against the MERGED indices, not the raw ones', () => {
    // `mergeAppearance` DROPS a non-object entry, so raw index 2 is merged index
    // 1. `applyMotion` has always resolved a positional path against the merged
    // array, so the migration must read the same one or it would change the
    // picture while claiming to preserve it.
    const c = mergeConfig({
      ...DEFAULT_CONFIG,
      appearance: [vtLayer({ id: 'Lfill', kind: 'fill' }), null, vtLayer({ id: 'Lstroke', kind: 'stroke', width: 3 })],
      // Old shape, `moves` deliberately absent — see `saved`'s note above.
      motion: { duration: 4, tracks: [track('appearance.1.width', 0, 24)] },
    })
    expect(c.appearance.map(l => l.id)).toEqual(['Lfill', 'Lstroke'])
    expect(firstTrack(c)!.path).toBe('appearance.Lstroke.width')
    expect(byId(applyMotion(c, 4), 'Lstroke').width).toBe(24)
  })

  it('survives hostile input without throwing', () => {
    for (const path of ['appearance', 'appearance.', 'appearance..width', 'appearance.-1.width',
      'appearance.1e2.width', 'appearance.01.width', 'appearance.1', 'appearanceX.1.width']) {
      expect(() => mergeConfig(saved(path))).not.toThrow()
    }
    // `appearance.1` — a member with no leaf — is a real positional path and is
    // lifted; nothing downstream writes through it, and refusing it would be a
    // second rule for no reason.
    expect(firstTrack(mergeConfig(saved('appearance.1')))!.path).toBe('appearance.Lstroke')
    // A leading zero is not an index this codebase mints, but /^\d+$/ matches it
    // and `Number('01')` is 1 — so it lifts to the same layer rather than being
    // left as a path that resolves differently in two places.
    expect(firstTrack(mergeConfig(saved('appearance.01.width')))!.path).toBe('appearance.Lstroke.width')
  })
})
