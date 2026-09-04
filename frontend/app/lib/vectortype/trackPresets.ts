/**
 * Vector Type Studio — APPEARANCE-STACK motion presets, as motion TRACKS. PURE.
 *
 * ## Why this is a second table, and why that is not a mistake
 *
 * `./axisPresets.ts` is the first table and it says so in its own header: the
 * *frame* is frozen (`VtAxisPreset.axis`, one OpenType tag) and everything else
 * is derived from the loaded font. This module follows exactly that pattern —
 * declared frame, derived contents, disabled-with-a-reason — and deliberately
 * does NOT extend that table, because that table structurally cannot hold these.
 *
 * A gallery preset in this studio is **an id stored in a slot** (`motion.in`,
 * `motion.out`, `motion.loop`) that `presetMotion.ts` evaluates to a
 * `UnitState` / a set of axis deltas. Three walls, each independently fatal:
 *
 *  1. **A preset cannot write a config leaf.** `UnitState` is `dx / dy / scale /
 *     rotation / opacity / blur / clip / copies`, and `VtAxisPreset.fn` returns
 *     an axis coordinate. Neither has a channel to `appearance.<id>.angle`. The
 *     block shadow's direction is a leaf on a LAYER, not a per-unit transform.
 *  2. **A preset does not know the stack.** `vtAxisDelta(preset, e, i, n, axes,
 *     resting)` is handed glyph index, glyph count and the font's axes — never
 *     the config. It could not name a layer to aim at even if it had somewhere
 *     to write.
 *  3. **A slot holds exactly one id.** Misregistration drives TWO layers in
 *     opposition; there is nowhere in `LayerAnimSpec` to say which two.
 *
 * The mechanism that *can* express both is the one already shipped: a
 * `VtMotionTrack`, a dotted path into the config, evaluated by `applyMotion`.
 * That is the studio's own guarantee — `f(cfg, t) → paths`, so **every declared
 * slider is animatable for free** — and it was measured true here rather than
 * assumed (see `tests/unit/vectortype-track-presets.unit.spec.ts`).
 *
 * So what is missing is not capability, it is DISCOVERABILITY: a user has to
 * know that an extrude has an angle, that the angle is animatable, and that a
 * full turn of it is a light sweeping around the word. This table turns each of
 * those from a possibility into a tile.
 *
 * ## What is declared and what is derived
 *
 * DECLARED (frozen): the layer `kind` a preset cannot run without, how many it
 * needs, and the extra per-layer condition that makes a layer *usable* (a
 * `depth: 0` extrude paints nothing, so animating its angle animates nothing).
 *
 * DERIVED from the live config: which layers it will actually drive, whether the
 * tile is offered, the sentence shown when it cannot run, and the track values
 * themselves — a sweep starts from the angle the user already set, and a drift
 * reaches the plate offset they already chose.
 */
import {
  VT_HEIGHT_MAX,
  VT_STACK_PREFIX,
  VT_STRETCH_MAX,
  type VectorTypeConfig,
  type VtAppearanceLayer,
  type VtLayerKind,
  type VtMotionTrack,
  type VtMove,
} from './config'
import { isFill } from '~/lib/compositor/paint'
import type { ColorMixSpace } from '~/lib/color/mix'
import { hexToOklch, oklchToHexInGamut, parseHexA } from '~/lib/color/convert'
// A track preset now builds a `VtMove` (kind 'tracks'), not a bare track
// array — the move owns the ease/play a track used to carry as its own
// `easing`/`loops`. `moveTracks` reads the moves array back into a flat,
// tagged list where `vtMatchLegacyTrackPreset` (below) still needs one.
import type { MoveEase, MovePlay } from '~/lib/studio/moves/types'
import { moveTracks } from '~/lib/studio/moves/tracks'

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** One motion track. `easing`/`loops` are GONE from `VtMotionTrack` — the
 *  owning move's `ease`/`play` (declared per preset below) replace them. */
function track(path: string, from: number, to: number, over: Partial<VtMotionTrack> = {}): VtMotionTrack {
  return { path, from, to, hold: 0, cycleOffset: 0, delay: 0, ...over }
}

/**
 * One COLOUR track. `from`/`to` are the 0..1 progress domain — see
 * `VtMotionTrack.from` — so every timing knob still reads the same.
 *
 * The space is passed in rather than defaulted, because the default is right for
 * a mix between two chosen colours and WRONG for a hue rotation: a straight line
 * in OKLab from a colour to its own opposite hue passes through the middle of the
 * a/b plane, which is GREY. Measured on `#ff0000` → its opposite: OKLab's midpoint
 * is `#b78087` at chroma 0.069 (a dusty pink), OKLCH's is `#b468eb` at 0.197. So
 * a cycle asks for `oklch` explicitly.
 */
function colorTrack(
  path: string, fromColor: string, toColor: string, space: ColorMixSpace, over: Partial<VtMotionTrack> = {},
): VtMotionTrack {
  return { ...track(path, 0, 1), fromColor, toColor, space, ...over }
}

/** What a preset is handed: the layers it matched, back to front, and the clip. */
export interface VtTrackPresetContext {
  layers: readonly VtAppearanceLayer[]
  /** Clip length in seconds. Present for a preset whose values depend on it;
   *  none of the three shipped presets does, and that is a property worth
   *  keeping — a track's own `loops` already expresses "twice per clip". */
  duration: number
}

/**
 * One dial a later Move card can point at a track this preset produced —
 * `trackIndex`/`field` name WHICH number the dial edits (`build()`'s output
 * order; a per-layer preset like Light Sweep produces one track per matched
 * layer, so `trackIndex: 0` is a representative first row rather than an
 * exhaustive per-layer expansion, which is card-UI work for a later task).
 */
export interface VtTrackPresetDial {
  label: string
  trackIndex: number
  field: 'from' | 'to'
  min: number
  max: number
  step: number
}

export interface VtTrackPreset {
  id: string
  label: string
  /** One line for the tile, in the picker's voice. */
  pitch: string
  /** THE DECLARATION — the layer kind this preset cannot run without, or
   *  'run' for a preset on a RUN-LEVEL dial (stretch, height) that needs no
   *  layer at all and is always offered. */
  kind: VtLayerKind | 'run'
  /** How many such layers it needs. Two means two, and the reason says so. */
  minLayers: number
  /** The extra condition that makes a layer of that kind actually usable. A
   *  `depth: 0` extrude draws no copies, so a track on its angle is a row in the
   *  timeline that moves nothing — the dead-control failure this studio's
   *  schema exists to prevent, one level out. */
  usable: (l: VtAppearanceLayer) => boolean
  /** What an unusable layer is missing, spliced into the reason sentence. */
  requirement: string
  /** Which phase the move this preset builds plays in — an entrance (Stretch
   *  In, Spring Up) settles once and stays; the rest run for the whole loop. */
  phase: 'in' | 'loop' | 'out'
  /** The owning move's fixed ease/play — the SAME mapping a migrated legacy
   *  track's `easing`/`loops` collapse to (`~/lib/studio/moves/merge`'s
   *  `legacyTrackEasePlay`): a settle is `none`/`once`, a ping-pong drift is
   *  `none`/`backAndForth`, a multi-cycle wave adds `times`. Kept in step with
   *  that mapping on purpose — a preset and a hand-converted legacy document
   *  that produced the "same" motion should end up with the same timing. */
  ease: MoveEase
  play: MovePlay
  /** The tracks, derived from the layers it matched. */
  build: (ctx: VtTrackPresetContext) => VtMotionTrack[]
  /** Dials a later card can edit the produced tracks with. */
  dials: VtTrackPresetDial[]
}

const EASE_NONE: MoveEase = { kind: 'named', name: 'none' }
const EASE_NATURAL: MoveEase = { kind: 'named', name: 'natural' }
const PLAY_ONCE: MovePlay = { mode: 'once', times: 1 }
const PLAY_REPEAT_1: MovePlay = { mode: 'repeat', times: 1 }
const playBackAndForth = (times: number): MovePlay => ({ mode: 'backAndForth', times })

/**
 * The offset a misregistration drifts to when the plate is sitting at zero.
 *
 * In OUTPUT PIXELS, like `distance` itself. Small: a misprint is a few points
 * out of register, not a block shadow — at the measured 2× separation this is
 * 16 px of plate-to-plate drift, which reads as a bad print run rather than as
 * two words.
 */
export const VT_MISREGISTRATION_DRIFT = 8

const usableExtrude = (l: VtAppearanceLayer): boolean =>
  l?.kind === 'extrude' && isNum(l.depth) && l.depth >= 1

/**
 * A fill layer whose `paint.a` is a colour a track can drive.
 *
 * Mirrors `controls.ts`'s `fillIsFill` gate — a SHADER fill's own `a` is never
 * read (`effectiveTilePaint` unwraps to `shader.input` and paints that), so
 * animating it would store a value, survive the merge and change not one pixel.
 * That is the dead-control failure, one level out, exactly as `usableExtrude`
 * guards a `depth: 0` extrude.
 */
const usableColorFill = (l: VtAppearanceLayer): boolean =>
  l?.kind === 'fill' && isFill(l.paint) && l.paint.type !== 'shader'

/** The layer's own fill colour, as an opaque long-form hex, or `null`. */
const fillColorOf = (l: VtAppearanceLayer): string | null => {
  const a = isFill(l?.paint) ? l.paint.a : null
  return typeof a === 'string' && a.trim() !== '' ? parseHexA(a).hex : null
}

/**
 * The OPPOSITE HUE of a colour, at the same lightness and as much of its chroma
 * as sRGB can hold.
 *
 * Derived from what the user already picked rather than invented: the design
 * decides where the cycle goes, this only decides how far round. 180° is the
 * whole point — it is the farthest a hue can travel, so a pingpong across it and
 * back covers the wheel in two halves and reads as a cycle rather than a nudge.
 *
 * OKLCH, not HSV: a hue rotation there keeps perceived LIGHTNESS, so the word
 * does not brighten and dim as it cycles (HSV's yellow is far lighter than its
 * blue at the same nominal value).
 *
 * ## `oklchToHexInGamut`, and it is not a detail — it was MEASURED
 *
 * Most saturated sRGB colours have no equally-saturated opposite: the gamut is
 * lopsided. With the ordinary per-channel clamp, `#0000ff` rotated 180° came back
 * **129° away** — a third of the rotation silently eaten — and `#ff0000` came
 * back 199° away and 9 % lighter. Reducing chroma to fit instead keeps the hue
 * exact, which is the one property this function is named for.
 *
 * A near-grey has no hue to oppose and is refused by the preset's `usable`.
 */
export function vtOppositeHue(hex: string): string {
  const [L, C, H] = hexToOklch(hex)
  return oklchToHexInGamut(L, C, (H + 180) % 360)
}

/** Below this there is no hue to rotate — the opposite of grey is grey, and a
 *  preset that visibly did nothing would be worse than one that is greyed out
 *  with a reason. */
const CYCLE_MIN_CHROMA = 0.02

/** Shared shape for every RUN-LEVEL preset: no layer to find, so always on. */
const RUN = { kind: 'run' as const, minLayers: 0, usable: () => true, requirement: '' }

const PRESETS: VtTrackPreset[] = [
  {
    id: 'extrude-sweep',
    label: 'Light Sweep',
    pitch: 'The block shadow orbits the word — the light source moving',
    kind: 'extrude',
    minLayers: 1,
    usable: usableExtrude,
    requirement: 'a depth of at least 1',
    // A continuous turn, once per cycle — `none`/`repeat ×1`, the same timing
    // `convertLegacyTracks` gives a matched run-level loop.
    phase: 'loop',
    ease: EASE_NONE,
    play: PLAY_REPEAT_1,
    // ONE FULL TURN, starting where the user parked the slider. Starting at 0
    // instead would snap the design on the first frame; `angle + 360` is the
    // same direction as `angle`, so frame 0 and the last frame are identical and
    // an exported loop does not hard-cut.
    //
    // Every usable extrude sweeps, and they sweep TOGETHER: a two-plate stack
    // whose plates sit 180° apart keeps that separation all the way round, which
    // is what a single moving light does to two shadows.
    build: ({ layers }) => layers.map((l) => {
      const from = isNum(l.angle) ? l.angle : 0
      return track(`${VT_STACK_PREFIX}${l.id}.angle`, from, from + 360)
    }),
    dials: [{ label: 'Turns', trackIndex: 0, field: 'to', min: 90, max: 1440, step: 90 }],
  },
  {
    id: 'misregistration',
    label: 'Misregistration',
    pitch: 'Ink plates drift out of register and back, like a bad print run',
    kind: 'extrude',
    minLayers: 1,
    usable: usableExtrude,
    requirement: 'a depth of at least 1',
    // Ping-pong: `none`/`backAndForth ×1` — the mapping `legacyTrackEasePlay`
    // gives a track whose old `easing` was `'pingpong'`.
    phase: 'loop',
    ease: EASE_NONE,
    play: playBackAndForth(1),
    // PING-PONG from ZERO, so the word starts perfectly registered and drifts —
    // that is the whole read of the effect, and it also makes frame 0 the
    // in-register frame a still bake will capture.
    //
    // Each plate drifts along its OWN angle, so two plates set 180° apart move
    // in opposition and the separation is twice the distance (measured: 0 → 28 px
    // at distance 14). The preset does not impose the angles; the stack owns
    // them, and one plate alone slides out from under the face and back.
    //
    // The reach is the plate offset the user ALREADY set, when they set one — a
    // preset that overwrote it would throw away the design it was applied to.
    build: ({ layers }) => layers.map(l =>
      track(`${VT_STACK_PREFIX}${l.id}.distance`, 0,
        isNum(l.distance) && l.distance > 0 ? l.distance : VT_MISREGISTRATION_DRIFT)),
    dials: [{ label: 'Drift', trackIndex: 0, field: 'to', min: 1, max: 64, step: 1 }],
  },
  {
    id: 'colour-cycle',
    label: 'Colour Cycle',
    pitch: 'The fill travels round to the opposite hue and back',
    kind: 'fill',
    minLayers: 1,
    // Not merely "is a fill": a shader fill's `a` is never painted, and a
    // near-grey has no hue to rotate. Both would be a tile that lands a row in
    // the timeline and changes nothing.
    usable: l => usableColorFill(l) && (() => {
      const hex = fillColorOf(l)
      return !!hex && hexToOklch(hex)[1] >= CYCLE_MIN_CHROMA
    })(),
    requirement: 'a solid or gradient paint in a colour with some saturation',
    phase: 'loop',
    ease: EASE_NONE,
    play: playBackAndForth(1),
    // PING-PONG from the colour the user already chose, so frame 0 is their own
    // design and a still bake captures it — the same rule Misregistration
    // follows, for the same reason. The far end is that colour's opposite hue at
    // the SAME lightness and chroma, which is why this reads as the word
    // travelling round the wheel rather than as it getting brighter and dimmer.
    //
    // OKLCH — a hue ROTATION, so the colour keeps its chroma all the way round.
    // The track default (OKLab, a straight line) is the wrong space for THIS
    // pair specifically and goes grey in the middle; `colorTrack`'s own note
    // carries the measured numbers.
    build: ({ layers }) => layers.flatMap((l) => {
      const hex = fillColorOf(l)
      if (!hex) return []
      return [colorTrack(`${VT_STACK_PREFIX}${l.id}.paint.a`, hex, vtOppositeHue(hex), 'oklch')]
    }),
    // No numeric dial: the two endpoints are colours, and a later card edits
    // those with swatches, not a `VtTrackPresetDial`'s From/To numbers.
    dials: [],
  },

  // ── Smart stretch — run-level, no layer needed ─────────────────────────────
  // All three stay inside the proven SINGLE-AXIS regime (Phase B range
  // policy): each moves one dial and leaves the other at 1.
  {
    id: 'stretch-in', label: 'Stretch In', pitch: 'Lands wide and settles to its drawn width', ...RUN,
    // An entrance settles once: `natural`/`once` — the mapping
    // `legacyTrackEasePlay` gives a track whose old `easing` was `'easeinout'`.
    phase: 'in',
    ease: EASE_NATURAL,
    play: PLAY_ONCE,
    // An ENTRANCE ends still: `to` is 1, the drawn width — an ABSOLUTE value,
    // like every track in this table, not a delta on the dial. A user who set
    // the dial to 1.4 gets a word that lands at 1.0; the dial is the resting
    // value only while no track claims that path. Starts at 1.6 — an extended
    // cut, not a smear.
    build: () => [track('stretch', 1.6, 1)],
    // Cap at the width dial's own ceiling — a tuning dial must not promise
    // headroom the frame's clampStretch silently caps at render.
    dials: [{ label: 'Start width', trackIndex: 0, field: 'from', min: 1, max: VT_STRETCH_MAX, step: 0.05 }],
  },
  {
    id: 'stretch-wave', label: 'Stretch Wave', pitch: 'A crest of width travels through the word', ...RUN,
    // A LOOP: ping-pong ×2 — the mapping a legacy `{easing:'pingpong',
    // loops:2}` track collapses to.
    phase: 'loop',
    ease: EASE_NONE,
    play: playBackAndForth(2),
    // About 1, −12% to +15%: wide enough to read, inside the range the engine
    // holds, and absolute like the rest of this table. The travel comes from
    // the stagger — with delay 0 the whole word breathes together, which is
    // the honest fallback, not a bug.
    build: () => [track('stretch', 0.88, 1.15)],
    dials: [{ label: 'Amount', trackIndex: 0, field: 'to', min: 1, max: 1.5, step: 0.01 }],
  },
  {
    id: 'spring-up', label: 'Spring Up', pitch: 'Letters land tall off the baseline and settle', ...RUN,
    phase: 'in',
    ease: EASE_NATURAL,
    play: PLAY_ONCE,
    // Height only — the baseline is the fixed point of the vertical remap, so
    // this reads as letters springing UP, not smearing about their centres.
    // `to` is 1, the drawn height: absolute, like every track in this table, so
    // a user who set the height dial to 1.4 gets letters that land at 1.0.
    build: () => [track('stretchY', 1.8, 1)],
    // Cap at the height dial's own ceiling (higher than width) — same reason as
    // Stretch In: no headroom the frame's clampHeight would silently cap.
    dials: [{ label: 'Start height', trackIndex: 0, field: 'from', min: 1, max: VT_HEIGHT_MAX, step: 0.05 }],
  },
]

/** Every track preset, in gallery order. */
export const VT_TRACK_PRESETS: readonly VtTrackPreset[] = Object.freeze(PRESETS)

/** The preset with that id, or null. */
export function vtTrackPreset(presetId: unknown): VtTrackPreset | null {
  if (typeof presetId !== 'string') return null
  return PRESETS.find(p => p.id === presetId.trim()) ?? null
}

// ── Availability, derived from the live stack ───────────────────────────────

export interface VtTrackPresetOffer {
  preset: VtTrackPreset
  /** The layers it would drive, back to front. Empty when unavailable. */
  layers: VtAppearanceLayer[]
  available: boolean
  /** Present IFF unavailable. Names what to add, because the user owns the
   *  stack and can act on it in the same panel — the same rule
   *  `vtAxisAvailability` follows for a missing axis. */
  reason?: string
}

/** A layer this preset could address: right kind, usable, and with an id that
 *  can be written as a stack path at all. An id that is all digits would be read
 *  as an array INDEX by `lib/studio/path.ts` (`mergeConfig` never mints one, so
 *  this is the raw-blob case) and a dot would split the path. */
const addressable = (p: VtTrackPreset, l: VtAppearanceLayer): boolean =>
  !!l && l.kind === p.kind && p.usable(l)
  && typeof l.id === 'string' && l.id !== '' && !l.id.includes('.') && !/^\d+$/.test(l.id)

/**
 * Can this preset run on this config's stack, and if not, WHY.
 *
 * Three ways to fail, and they are different sentences because they have
 * different fixes: no layer of the kind at all (add one), one that is there but
 * inert (raise its depth), and not enough of them (add another).
 *
 * DISABLED LAYERS COUNT AS ABSENT. A track pointing at a layer that is switched
 * off animates a layer that does not paint, which is the same dead row as a
 * `depth: 0` one.
 */
export function vtTrackPresetOffer(
  preset: VtTrackPreset,
  cfg: VectorTypeConfig | null | undefined,
): VtTrackPresetOffer {
  const stack = Array.isArray(cfg?.appearance) ? cfg.appearance : []
  const enabled = stack.filter(l => l && l.enabled !== false)
  const layers = enabled.filter(l => addressable(preset, l))
  if (layers.length >= preset.minLayers) return { preset, layers, available: true }

  const ofKind = enabled.filter(l => l?.kind === preset.kind)
  const noun = `${preset.kind} layer`
  // "an extrude layer", "a fill layer" — the article is derived rather than
  // hard-coded, because this sentence grew a second kind the moment a fill preset
  // existed and "Add an fill layer" is the kind of thing that ships.
  const article = /^[aeiou]/.test(noun) ? 'an' : 'a'
  const reason = !ofKind.length
    ? `Add ${article} ${noun} — this needs ${preset.minLayers === 1 ? 'one' : preset.minLayers} to drive.`
    : layers.length < ofKind.length
      ? `This ${noun} needs ${preset.requirement} before there is anything to animate.`
      : `Add ${preset.minLayers - layers.length} more ${noun}${preset.minLayers - layers.length === 1 ? '' : 's'}.`
  return { preset, layers: [], available: false, reason }
}

/** Every track preset, each marked available or not — the shape a gallery
 *  renders directly: available ones live, the rest greyed with their reason. */
export function vtTrackPresetOffers(cfg: VectorTypeConfig | null | undefined): VtTrackPresetOffer[] {
  return PRESETS.map(p => vtTrackPresetOffer(p, cfg))
}

// ── Application ─────────────────────────────────────────────────────────────

/**
 * The end of the latest zero-anchored, one-shot move already in `cfg` —
 * duplicated from `~/lib/vectortype/movesAdapter.ts`'s OWN `longestEntranceEnd`
 * rather than imported: that module imports `VT_TRACK_PRESETS`/`vtTrackPreset`
 * FROM this one, so the reverse import would be circular. Kept in step with it
 * on purpose — a track preset applied here and a preset move added fresh from
 * the gallery there both place a Loop where the current entrance(s) end.
 */
function longestEntranceEnd(cfg: VectorTypeConfig | null | undefined): number {
  let longest = 0
  const moves = Array.isArray(cfg?.motion?.moves) ? cfg!.motion.moves : []
  for (const mv of moves) {
    if (mv && mv.loop === false && mv.at === 0 && isNum(mv.duration) && mv.duration > longest) longest = mv.duration
  }
  return longest
}

/**
 * Where a track preset's own `phase` lands on the at-anchored timeline —
 * the `vtApplyTrackPreset` counterpart to `movesAdapter.ts`'s `placementFor`
 * (same duplication reasoning as `longestEntranceEnd` above): `in` -> `at:
 * 0`; `loop` -> `at: longestEntranceEnd(cfg)`, open-ended; `out` -> `at:
 * max(longestEntranceEnd(cfg), clip - duration)`, with `duration` compressed
 * to fit the clip.
 */
function placementForPhase(
  phase: 'in' | 'loop' | 'out',
  cfg: VectorTypeConfig,
  duration: number,
  loop: boolean,
  bounce: boolean,
): { at: number; duration: number; loop: boolean; bounce?: boolean } {
  const extra = bounce ? { bounce: true as const } : {}
  if (phase === 'in') return { at: 0, duration, loop, ...extra }
  if (phase === 'loop') return { at: longestEntranceEnd(cfg), duration, loop, ...extra }
  const clip = isNum(cfg?.motion?.duration) ? cfg.motion.duration : 4
  const at = Math.max(longestEntranceEnd(cfg), clip - duration)
  return { at, duration: Math.max(0.05, clip - at), loop, ...extra }
}

/**
 * The moves list this config should have after applying `preset` — the
 * CURRENT moves with the preset's own paths replaced (across every
 * `'tracks'`-kind move, not just one of this preset's own making — see
 * below), plus ONE new move carrying the preset's tracks.
 *
 * REPLACE, not append, and only on the paths the preset itself writes.
 * Applying a preset twice must not stack two tracks on one path
 * (`applyMoveTracks` is a plain write per track, so the last one silently
 * wins and the first is a dead row in the timeline — measured: two opposed
 * `glyph.dx` tracks compose to the second one alone, not to their sum).
 * Everything else the user authored is untouched, because these presets
 * compose with tracks and with preset moves alike. A move that is left with
 * NO tracks once its claimed paths are removed is dropped entirely — same
 * rule `pruneStackTracks` (`./motion.ts`) follows for a move a stack edit
 * emptied out.
 *
 * Returns the SAME array when the preset cannot run, so a caller can skip the
 * write and the deep watcher it would trigger.
 */
export function vtApplyTrackPreset(
  cfg: VectorTypeConfig,
  presetId: unknown,
): VtMove[] {
  const existing = Array.isArray(cfg?.motion?.moves) ? cfg.motion.moves : []
  const preset = vtTrackPreset(presetId)
  if (!preset) return existing
  const offer = vtTrackPresetOffer(preset, cfg)
  if (!offer.available) return existing
  const added = preset.build({
    layers: offer.layers,
    duration: isNum(cfg?.motion?.duration) ? cfg.motion.duration : 4,
  })
  const claimed = new Set(added.map(t => t.path))
  const kept: VtMove[] = []
  for (const mv of existing) {
    if (mv.kind !== 'tracks' || !Array.isArray(mv.tracks)) { kept.push(mv); continue }
    const remaining = mv.tracks.filter(t => !claimed.has(typeof t?.path === 'string' ? t.path.trim() : ''))
    if (!remaining.length) continue
    kept.push(remaining.length === mv.tracks.length ? mv : { ...mv, tracks: remaining })
  }
  // `preset.phase`/`preset.play` are the table's own DECLARATIVE fields —
  // translated into the `at`/`loop`/`bounce` a real Move needs, the same
  // `resolvePlacement` rule `movesAdapter.ts`'s `defaultTiming` applies to a
  // freshly-added preset move (see `placementForPhase` above): `loop = phase
  // === 'loop' || play.mode === 'repeat'`, `bounce = play.mode ===
  // 'backAndForth'`.
  const rawDuration = isNum(cfg?.motion?.duration) ? cfg.motion.duration : 4
  const loop = preset.phase === 'loop' || preset.play.mode === 'repeat'
  const bounce = preset.play.mode === 'backAndForth'
  const newMove: VtMove = {
    id: `move-preset-${preset.id}`,
    kind: 'tracks',
    presetId: preset.id,
    ease: preset.ease,
    ...placementForPhase(preset.phase, cfg, rawDuration, loop, bounce),
    tracks: added,
  }
  return [...kept, newMove]
}

/**
 * True when every track this preset would write is already present with the
 * values it would write — i.e. the tile should read as the ACTIVE one.
 *
 * Compared on the values rather than on a stored preset id, because these are
 * ordinary tracks the moment they land: the user may drag any of them, and a
 * tile that kept claiming to be active would be describing a design that is no
 * longer what it applied.
 */
export function vtTrackPresetActive(cfg: VectorTypeConfig, presetId: unknown): boolean {
  const preset = vtTrackPreset(presetId)
  if (!preset) return false
  const offer = vtTrackPresetOffer(preset, cfg)
  if (!offer.available) return false
  const wanted = preset.build({
    layers: offer.layers,
    duration: isNum(cfg?.motion?.duration) ? cfg.motion.duration : 4,
  })
  // The `.space` cast: see `motion.ts`'s `usableTracks` note — every track
  // this studio stores was built by ITS OWN `mergeTrack`, which always writes
  // `.space`, never the shared `MoveTrack.mix` the inherited type declares.
  const have = ((Array.isArray(cfg?.motion?.moves) ? cfg.motion.moves : [])
    .filter(m => m.kind === 'tracks')
    .flatMap(m => m.tracks ?? [])) as unknown as VtMotionTrack[]
  // A COLOUR track's `from`/`to` are 0 and 1 on EVERY colour track, so comparing
  // only those would make one colour preset read as active whenever any other
  // had been applied to the same leaf. The endpoints that identify it are the two
  // colours and the space they are mixed in.
  return wanted.length > 0 && wanted.every(w => have.some(h =>
    h?.path === w.path && h.from === w.from && h.to === w.to
    && h.fromColor === w.fromColor && h.toColor === w.toColor && h.space === w.space))
}

// ── Legacy-track → preset matching, for the moves migration ────────────────

/**
 * Which paths each RUN-LEVEL preset's `build()` writes, verified against the
 * `PRESETS` table above rather than assumed — `stretch-in` and `stretch-wave`
 * both write a single `stretch` track (they cannot be told apart by path
 * alone: this is an AMBIGUOUS signature and `vtMatchLegacyTrackPreset` returns
 * `null` for it rather than picking one), `spring-up` writes `stretchY`.
 * Layer-addressed presets (Light Sweep,
 * Misregistration, Colour Cycle) are NOT here — their paths are per-layer id
 * paths (`appearance.<id>.angle`), which can never equal a fixed signature,
 * so a legacy document can only ever match one of the three RUN presets.
 */
const PRESET_SIGNATURE_PATHS: Record<string, string[]> = {
  'stretch-in': ['stretch'],
  'stretch-wave': ['stretch'],
  'spring-up': ['stretchY'],
}

/**
 * Does this legacy tracks list match a known preset's signature — same SET of
 * paths, nothing more and nothing fewer? Used once, at `mergeMotion`'s
 * old-shape conversion (`~/lib/studio/moves/merge`'s `convertLegacyTracks`),
 * to collapse a matched legacy track back into one preset move instead of a
 * pile of Custom ones.
 *
 * `null` when nothing matches, OR when more than one preset matches — and
 * `stretch-in`/`stretch-wave` DO share a signature (`['stretch']`), so this is
 * not a hypothetical: a real "Stretch Wave" loop (`pingpong`/`loops: 2`) and a
 * one-shot "Stretch In" (`easeinout`/`loops: 1`) are indistinguishable by path
 * alone. The matched-preset branch in `convertLegacyTracks` throws the track's
 * own `easing`/`loops` away in favour of the PRESET's fixed timing (`ease:
 * none`, `play: repeat ×1`) — correct only when the preset that wins really is
 * the one that made the track. Picking `stretch-in` by table order here would
 * silently relabel a saved oscillating loop as a flat one-shot AND discard its
 * real timing, which is worse than not collapsing it at all. So an ambiguous
 * signature returns `null` and falls through to the per-track Custom branch,
 * which keeps the track's own `easing`/`loops` — the design survives, just
 * without the gallery tile lighting up as active.
 */
export function vtMatchLegacyTrackPreset(tracks: readonly { path: string }[]): string | null {
  const paths = new Set(tracks.map(t => t.path))
  const matches = VT_TRACK_PRESETS.filter((preset) => {
    const sig = PRESET_SIGNATURE_PATHS[preset.id]
    return sig && sig.length === paths.size && sig.every(p => paths.has(p))
  })
  return matches.length === 1 ? matches[0]!.id : null
}
