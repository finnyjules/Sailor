/**
 * Vector Type Studio's `MovesAdapter<VectorTypeConfig>` — what the shared
 * moves panel (`components/vue-canvas/motion/moves/`, not yet built) will
 * drive this studio through. See `~/lib/studio/moves/adapter.ts` for the
 * contract this implements, and the design docs it is built from:
 * `docs/superpowers/specs/2026-09-03-vector-type-motion-moves-design.md` §4
 * (the gallery) and `2026-09-03-motion-moves-shared-core-design.md` §3.
 *
 * ## Why `kinds.preset`/`kinds.blink`/`kinds.scatter` have no `evaluate`
 *
 * `MoveKindDef.evaluate` applies ONE move to the WHOLE config at its own
 * local progress, `(cfg, move, localProgress) => cfg`. Blink and Scatter are
 * markers by design (spec §1: "their settings stay where they are —
 * `motion.blink`, `motion.scatter` — because their evaluators read them
 * there... the move record is a marker that puts a card in the list"), so
 * they have nothing a config-level `evaluate` would write — `./blink.ts` and
 * `./scatter.ts` already read `cfg.motion.blink`/`cfg.motion.scatter`
 * directly, unconditioned on whether a marker move exists.
 *
 * `preset` is the one that looks like it should have one, and it
 * structurally cannot: a preset's whole effect is PER-GLYPH (an axis delta or
 * a `UnitState`, keyed by glyph index and count), and `evaluate`'s signature
 * has no glyph to be per. The real evaluator for a preset move is
 * `presetTransform` (`./presetMotion.ts`) — folding every live `kind:
 * 'preset'` move via `movePhase`, exactly as this file's header describes —
 * and it is called directly by every renderer, never through this adapter.
 * `evaluate` staying absent here is the honest statement of that: a preset
 * move's motion is not expressible as one `cfg → cfg` step.
 *
 * ## `clipExtras` and the card bodies (Task 9)
 *
 * `clipExtras` is `VtStaggerClipExtras.vue` — Letter-by-letter (stagger),
 * the one Motion control that stays outside the move list (design spec
 * §4: "the Motion group keeps only the stagger controls (they draw in the
 * clip block)"). `KINDS.preset/blink/scatter` each carry a real `cardBody`
 * now too (`components/vue-canvas/motion/moves/bodies/`) — `preset`'s
 * renders the picked preset's tunable `params`; `blink`/`scatter`'s each
 * read/write `cfg.motion.blink`/`.scatter` directly via `patch-cfg` (they
 * are markers — see the `derivedMoves` doc below — so there is nothing on
 * the MOVE itself worth a `patch` for). All four are real `.vue` imports,
 * `markRaw`'d below: the shared panel this file drives
 * (`components/vue-canvas/motion/moves/`) now exists (Task 8), so mounting
 * them here is no longer dead code with no consumer, unlike when this
 * module was first written.
 */
import { markRaw } from 'vue'
import type {
  AnimatableGroup,
  GalleryGroup,
  MoveKindDef,
  MoveOffer,
  MovePhase,
  MovesAdapter,
} from '~/lib/studio/moves/adapter'
import type { Move, MoveEase, MoveEaseName } from '~/lib/studio/moves/types'
import { buildPairs } from '~/lib/studio/moves/direction'
import { presetIdsFor, nativeEaseFor } from '~/lib/motion/evaluate'
import { KINETIC_GROUP_LABELS, KINETIC_PRESETS_BY_ID, type KineticGroup } from '~/data/kinetic-presets'
import type { VtAxis } from './font'
import type { VectorTypeConfig, VtMove } from './config'
import { VT_PRESET_CAPABILITIES, vtPresetSlotOf } from './presetMotion'
import { animatableTargets } from './motion'
import {
  vtAxisAvailability,
  vtAxisOffersFor,
  vtAxisPreset,
  type VtAxisPreset,
} from './axisPresets'
import {
  VT_TRACK_PRESETS,
  vtTrackPreset,
  vtTrackPresetOffer,
  type VtTrackPreset,
} from './trackPresets'
import VtPresetCardBody from '~/components/vue-canvas/motion/moves/bodies/VtPresetCardBody.vue'
import VtBlinkCardBody from '~/components/vue-canvas/motion/moves/bodies/VtBlinkCardBody.vue'
import VtScatterCardBody from '~/components/vue-canvas/motion/moves/bodies/VtScatterCardBody.vue'
import VtStaggerClipExtras from '~/components/vue-canvas/motion/VtStaggerClipExtras.vue'

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

// ── Kinds ────────────────────────────────────────────────────────────────

const KINDS: Record<string, MoveKindDef<VectorTypeConfig>> = {
  preset: { label: 'Preset', cardBody: markRaw(VtPresetCardBody) },
  // noTiming: true — Blink/Scatter have no ease and no play (design spec §1).
  blink: { label: 'Blink', cardBody: markRaw(VtBlinkCardBody), noTiming: true },
  scatter: { label: 'Scatter', cardBody: markRaw(VtScatterCardBody), noTiming: true },
}

// ── In/Out pairs, for the panel's In/Out toggle ─────────────────────────────

/**
 * Every kinetic-engine preset id that has a genuine In AND Out counterpart,
 * `{ inId: outId }` — the one-directional source map `buildPairs`
 * (`~/lib/studio/moves/direction`) needs to build a real `direction`/`flip`
 * pair (its own doc: the `-in`/`In`-suffix heuristic gets real Vector Type
 * pairs backwards — `slide-up`/`slide-out-up` and `grow-in`/`shrink-out`
 * both break it — so a studio with the one-directional source MUST use this
 * rather than guess from id text).
 *
 * Read straight off `~/lib/motion/evaluate.ts`'s own `IN_EVAL`/`OUT_EVAL`
 * tables (mirrored here rather than derived, since neither table is
 * exported — `SUPPORTED_IN_IDS`/`SUPPORTED_OUT_IDS` are, but the PAIRING
 * between one In id and one Out id is a judgement call about which two read
 * as "the same move, reversed", not something the tables themselves declare)
 * — every id below is checked against that catalog by this module's own
 * test suite, so a preset added or renamed there cannot silently drift out
 * of step. `blur-slide-up` has no Out counterpart in the catalog (no
 * `blur-slide-out-down` exists) and is deliberately left unpaired, per the
 * brief: do not invent a pair that is not really there.
 */
const VT_PRESET_IN_TO_OUT: Record<string, string> = {
  'appear': 'disappear',
  'fade-in': 'fade-out',
  'slide-up': 'slide-out-up',
  'slide-down': 'slide-out-down',
  'slide-left': 'slide-out-left',
  'slide-right': 'slide-out-right',
  'mask-up': 'mask-out-up',
  'mask-down': 'mask-out-down',
  'grow-in': 'shrink-out',
  'shrink-in': 'grow-out',
  'blur-in': 'blur-out',
  'spin-in': 'spin-out',
  'elastic-drop': 'elastic-launch',
  'typewriter': 'typewriter-out',
  'glitch-in': 'glitch-out',
  'card-flip-h': 'card-flip-h-out',
  'card-flip-v': 'card-flip-v-out',
}

const VT_PRESET_PAIRING = buildPairs(VT_PRESET_IN_TO_OUT)

/** The symmetric `{ id: itsPair }` map — every id above AND its reverse. */
export const VT_PRESET_PAIRS = VT_PRESET_PAIRING.pairs
/** `'in' | 'out' | null` for a preset id in `VT_PRESET_PAIRS` — reads the
 *  authoritative `VT_PRESET_IN_TO_OUT` map, not the `-in`/`In`-suffix guess
 *  `~/lib/studio/moves/direction`'s bare `moveDirection` falls back to. What
 *  the panel's In/Out toggle asks to decide which side a picked tile is on. */
export const vtPresetDirection = VT_PRESET_PAIRING.direction
/** `presetId`'s opposite-direction id (e.g. `fade-in` -> `fade-out`), or
 *  `presetId` itself when it has no pair. What the toggle asks for when the
 *  user flips a picked tile's direction. */
export const vtPresetFlip = VT_PRESET_PAIRING.flip

// ── Ease: engine name → the ten-name `MoveEase` vocabulary ─────────────────

/**
 * `VtAxisPreset.ease` is an engine-shaped string (`resolveEase`'s
 * vocabulary — `'power2.out'`, `'back.out(1.7)'`, …), the SAME thing
 * `easeToEngineName` produces going the other way. A gallery tile needs the
 * reverse for its default `MoveEase`, so this is that map, restated rather
 * than derived (there are ten names and a handful of axis presets — the
 * asymmetry does not justify a shared bidirectional table for one caller).
 * Falls back to `'smooth'`, `resolveEase`'s own default, for anything not in
 * the ten-name set (a bare `power2.out` with no matching name, a preset added
 * later that doesn't map cleanly) — the tile still gets a real, usable ease.
 *
 * Also fed the shared kinetic engine's OWN native eases now (`engineOffer`
 * below, via `nativeEaseFor` — this is FIX 2 for the render-parity bug: a
 * freshly-added "grow-in" tile must overshoot like the preset always did, not
 * default to `smooth`), so the table carries every exact ease string
 * `lib/motion/evaluate.ts`'s `IN_EVAL`/`OUT_EVAL` use, not only the axis
 * presets' handful. `power2.in`/`back.in(1.7)`/`back.in(2)`/`back.out(1.4)`
 * are the four that axis presets never needed — added here on the SAME family
 * rule `lib/vectortype/config.ts`'s `legacyPresetEaseName` uses for the
 * migration path (`power*.in` → `accelerate`, any `back.*` → `overshoot`), so
 * the two mapping tables agree rather than diverging on presets that happen
 * to use a `.in`/non-`(1.7)` variant.
 */
const ENGINE_TO_MOVE_EASE: Record<string, MoveEaseName> = {
  none: 'none',
  'power2.out': 'smooth',
  'power2.in': 'accelerate',
  'sine.inOut': 'natural',
  'power3.out': 'slowDown',
  'power3.in': 'accelerate',
  'back.out(1.7)': 'overshoot',
  'back.out(1.4)': 'overshoot',
  'back.out': 'overshoot',
  'back.in(1.7)': 'overshoot',
  'back.in(2)': 'overshoot',
  'elastic.out(1, 0.3)': 'elastic',
  'elastic.out': 'elastic',
  'bounce.out': 'bounce',
  'back.inOut': 'swing',
  'steps(6)': 'steps',
}

function easeFromEngineName(name: string | undefined): MoveEase {
  const found = name ? ENGINE_TO_MOVE_EASE[name] : undefined
  return { kind: 'named', name: found ?? 'smooth' }
}

// ── Offer builders ───────────────────────────────────────────────────────

/**
 * The end of the latest zero-anchored, one-shot move already in `cfg` — this
 * studio's own definition of "where the entrance(s) finish" under the
 * at/loop model, which no longer stores a `phase` to ask "which move is the
 * In". Structural rather than table-driven on purpose: it has to answer for
 * a `'tracks'` move (a Custom In) exactly as it does for a `kind: 'preset'`
 * one, and neither carries a preset id a table lookup could key on.
 *
 * A freshly-placed Loop or Out reads this so it starts where the current
 * entrance(s) end — the SAME ordering `~/lib/studio/moves/merge`'s
 * `resolvePlacement` gives an old-shape document's `phase: 'loop'`/`'out'`
 * slot (`at: longestIn` / `at: max(longestIn, clip - duration)`), restated
 * here for a move built FRESH from the gallery rather than migrated.
 */
function longestEntranceEnd(cfg: VectorTypeConfig | null | undefined): number {
  let longest = 0
  const moves = Array.isArray(cfg?.motion?.moves) ? (cfg!.motion.moves as VtMove[]) : []
  for (const mv of moves) {
    if (mv && mv.loop === false && mv.at === 0 && isNum(mv.duration) && mv.duration > longest) longest = mv.duration
  }
  return longest
}

/**
 * Where a freshly-picked tile of phase `phase` lands on the at-anchored
 * timeline, and what `loop`/`bounce` it gets — the gallery's OWN "which
 * window" decision, the fresh-add counterpart to `resolvePlacement`'s
 * migration-time one (see `longestEntranceEnd`'s doc): `in` -> `at: 0`;
 * `loop` -> `at: longestEntranceEnd(cfg)`, open-ended; `out` -> `at:
 * max(longestEntranceEnd(cfg), clip - duration)`, with `duration` compressed
 * to fit the clip exactly as an old-shape `out` slot's was.
 */
function placementFor(
  phase: MovePhase,
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

/** The default duration/ease/placement a freshly-added preset move gets. Loop
 *  presets are periodic on their own — `ease: none`, an open-ended cycle —
 *  per the design spec §1; In/Out get the preset's OWN native ease (axis
 *  presets carry one on `preset.ease`; engine presets' lives in the shared
 *  engine's IN/OUT tables, passed in by `engineOffer` via `nativeEaseFor` —
 *  see its call below) and a one-shot window, so a freshly-added "grow-in"
 *  tile overshoots the same way a pre-moves document's `in` slot always did,
 *  rather than going smooth. */
function defaultTiming(cfg: VectorTypeConfig, phase: MovePhase, engineEase?: string): { duration: number; ease: MoveEase; at: number; loop: boolean; bounce?: boolean } {
  if (phase === 'loop') {
    return { ease: { kind: 'named', name: 'none' }, ...placementFor(phase, cfg, 1.5, true, false) }
  }
  return { ease: easeFromEngineName(engineEase), ...placementFor(phase, cfg, 0.8, false, false) }
}

function axisOffer(preset: VtAxisPreset, phase: MovePhase, cfg: VectorTypeConfig): MoveOffer {
  return {
    id: `axis:${preset.id}`,
    label: preset.label,
    pitch: preset.pitch,
    kind: 'preset',
    presetId: preset.id,
    phase,
    build: () => ({
      kind: 'preset',
      presetId: preset.id,
      ...defaultTiming(cfg, phase, preset.ease),
    }),
  }
}

function engineOffer(id: string, phase: MovePhase, cfg: VectorTypeConfig): MoveOffer {
  const meta = KINETIC_PRESETS_BY_ID[id]
  // `nativeEaseFor` only knows `'in' | 'out'` (a loop preset has no ease of
  // its own — see its doc) — `defaultTiming` ignores the ease arg for
  // `phase === 'loop'` anyway, so passing `undefined` there is harmless.
  const engineEase = phase === 'loop' ? undefined : nativeEaseFor(phase, id)
  return {
    id: `preset:${id}`,
    label: meta?.label ?? id,
    pitch: meta?.pitch ?? '',
    kind: 'preset',
    presetId: id,
    phase,
    build: () => ({
      kind: 'preset',
      presetId: id,
      ...defaultTiming(cfg, phase, engineEase),
    }),
  }
}

/** A track-preset tile. `cfg` is the CALLER's (the `gallery(cfg, phase)` that
 *  built this offer, always fresh — see the module header on why the
 *  adapter's own `cfg` parameter is never read here), so `build()` can bind
 *  the preset to the layers it would actually drive on THIS config. */
function trackOffer(preset: VtTrackPreset, cfg: VectorTypeConfig): MoveOffer {
  return {
    id: `tracks:${preset.id}`,
    label: preset.label,
    pitch: preset.pitch,
    kind: 'tracks',
    presetId: preset.id,
    phase: preset.phase,
    build: () => {
      const offer = vtTrackPresetOffer(preset, cfg)
      const duration = isNum(cfg?.motion?.duration) ? cfg.motion.duration : 4
      // `preset.phase`/`preset.play` are the table's own DECLARATIVE fields
      // (`trackPresets.ts` — unchanged by this task, out of its file list);
      // translated here into the at/loop/bounce a real Move needs, the same
      // `resolvePlacement` rule `defaultTiming` above applies to an engine
      // preset: `loop = phase === 'loop' || play.mode === 'repeat'`, `bounce
      // = play.mode === 'backAndForth'`.
      const loop = preset.phase === 'loop' || preset.play.mode === 'repeat'
      const bounce = preset.play.mode === 'backAndForth'
      return {
        kind: 'tracks',
        presetId: preset.id,
        ease: preset.ease,
        ...placementFor(preset.phase, cfg, duration, loop, bounce),
        tracks: preset.build({ layers: offer.layers, duration }),
      }
    },
  }
}

/** Section label for a track preset NOT in the curated Letterform set (spec
 *  §4: Layer for the two extrude presets, Colour for the fill one). */
function trackGroupLabel(preset: VtTrackPreset): string {
  if (preset.kind === 'fill') return 'Colour'
  if (preset.kind === 'run') return 'Letterform'
  return 'Layer'
}

/**
 * Blink and Scatter as gallery tiles — spec §4 lists them first in the
 * Loop tab's "Play" group, alongside the kinetic engine's own oscillating
 * loop presets. `build()` returns only `{ kind, at: 0, loop: true }`:
 * neither is a stored move (see `derivedMoves` below), so there is no
 * duration/ease/tracks worth seeding beyond a well-formed placement —
 * `VectorTypeSurface.vue`'s `onAddMove` reads `move.kind` off the picked
 * candidate and turns the marker on by writing
 * `cfg.motion.blink.amount`/`cfg.motion.scatter.spread` directly (spec §1:
 * "Adding the Blink move sets `blink.amount` to 0.3 … Same for Scatter with
 * `spread` 0.4"), rather than pushing anything into `clip.moves`.
 */
function blinkOffer(): MoveOffer {
  return {
    id: 'blink', label: 'Blink', kind: 'blink', phase: 'loop',
    pitch: 'Letters or words drop out and come back in a seeded flicker.',
    build: () => ({ kind: 'blink', at: 0, loop: true }),
  }
}
function scatterOffer(): MoveOffer {
  return {
    id: 'scatter', label: 'Scatter', kind: 'scatter', phase: 'loop',
    pitch: 'Every letter sits at its own random position on one variable axis.',
    build: () => ({ kind: 'scatter', at: 0, loop: true }),
  }
}

// ── Letterform: the curated ids that lead In and Loop (spec §4) ────────────

const LETTERFORM_AXIS_IDS: Partial<Record<MovePhase, readonly string[]>> = {
  in: ['weight-in'],
  loop: ['weight-wave', 'width-breathe', 'grade-pulse', 'grade-flicker', 'optical-drift'],
}
const LETTERFORM_TRACK_IDS: Partial<Record<MovePhase, readonly string[]>> = {
  in: ['stretch-in', 'spring-up'],
  loop: ['stretch-wave'],
}

// ── The adapter ──────────────────────────────────────────────────────────

/**
 * Build the adapter. `axes` and `fontLabel` describe the LOADED FONT — the
 * same two things `vtAxisOffersFor`/`vtAxisAvailability` need to say whether
 * an axis preset can run — and are closed over by `gallery`/`availability`
 * so a caller does not have to re-pass them on every call. The `cfg` param
 * exists for constructor-signature parity with those two (a studio's other
 * factories all take `cfg` first) but is not read: every adapter method
 * receives its OWN fresh `cfg` already, which is the one that must be used
 * (the config mutates live as the user edits; this factory is not called on
 * every keystroke).
 */
export function vtMovesAdapter(
  _cfg: VectorTypeConfig,
  axes: readonly VtAxis[],
  fontLabel?: string,
): MovesAdapter<VectorTypeConfig> {
  return {
    kinds: KINDS,
    clipExtras: markRaw(VtStaggerClipExtras),

    gallery(cfg: VectorTypeConfig, phase: MovePhase): GalleryGroup[] {
      const groups = new Map<string, MoveOffer[]>()
      const push = (label: string, offer: MoveOffer) => {
        if (!groups.has(label)) groups.set(label, [])
        groups.get(label)!.push(offer)
      }

      // Letterform FIRST — curated axis + track-preset ids, in table order.
      // Listed regardless of availability (a font without GRAD still shows
      // the tile, greyed — `availability` below is what greys it).
      for (const id of LETTERFORM_AXIS_IDS[phase] ?? []) {
        const preset = vtAxisPreset(phase, id)
        if (preset) push('Letterform', axisOffer(preset, phase, cfg))
      }
      for (const id of LETTERFORM_TRACK_IDS[phase] ?? []) {
        const preset = vtTrackPreset(id)
        if (preset && preset.phase === phase) push('Letterform', trackOffer(preset, cfg))
      }

      // Every other axis preset for this phase.
      const letterformAxis = new Set(LETTERFORM_AXIS_IDS[phase] ?? [])
      for (const offer of vtAxisOffersFor(phase, axes, fontLabel)) {
        if (letterformAxis.has(offer.preset.id)) continue
        push('Axis', axisOffer(offer.preset, phase, cfg))
      }

      // Every other track preset for this phase (Layer / Colour groups).
      const letterformTracks = new Set(LETTERFORM_TRACK_IDS[phase] ?? [])
      for (const preset of VT_TRACK_PRESETS) {
        if (preset.phase !== phase || letterformTracks.has(preset.id)) continue
        push(trackGroupLabel(preset), trackOffer(preset, cfg))
      }

      // The shared kinetic engine's own presets, grouped by its catalog.
      for (const id of presetIdsFor(phase, VT_PRESET_CAPABILITIES)) {
        const meta = KINETIC_PRESETS_BY_ID[id]
        const label = meta ? (KINETIC_GROUP_LABELS[meta.group as KineticGroup] ?? meta.group) : 'More'
        push(label, engineOffer(id, phase, cfg))
      }

      // Blink and Scatter lead the Loop tab's "Play" group (spec §4).
      if (phase === 'loop') {
        push('Play', blinkOffer())
        push('Play', scatterOffer())
      }

      return [...groups.entries()].map(([label, offers]) => ({ label, offers }))
    },

    animatable(cfg: VectorTypeConfig): AnimatableGroup[] {
      const groups = new Map<string, AnimatableGroup['dials']>()
      for (const t of animatableTargets(cfg, axes as VtAxis[])) {
        if (!groups.has(t.group)) groups.set(t.group, [])
        groups.get(t.group)!.push({ path: t.path, label: t.label, min: t.min, max: t.max })
      }
      return [...groups.entries()].map(([label, dials]) => ({ label, dials }))
    },

    availability(cfg: VectorTypeConfig, candidate: Move): string | null {
      if (candidate.kind === 'tracks') {
        // Already driven: any path this candidate's tracks would write that
        // an EXISTING 'tracks' move already writes (spec §2, "Same dial
        // twice").
        const claimed = new Set((candidate.tracks ?? []).map(t => t.path))
        const moves = Array.isArray(cfg?.motion?.moves) ? (cfg.motion.moves as VtMove[]) : []
        for (const mv of moves) {
          if (mv.kind !== 'tracks' || !mv.tracks) continue
          for (const t of mv.tracks) {
            if (!claimed.has(t.path)) continue
            const label = animatableTargets(cfg, axes as VtAxis[]).find(a => a.path === t.path)?.label ?? t.path
            return `${label} is already driven by another move.`
          }
        }
        // The preset's own stack requirement (an extrude layer, a colour fill…).
        if (candidate.presetId && candidate.presetId !== 'custom') {
          const preset = vtTrackPreset(candidate.presetId)
          if (preset) {
            const offer = vtTrackPresetOffer(preset, cfg)
            if (!offer.available) return offer.reason ?? 'Not available.'
          }
        }
        return null
      }
      if (candidate.kind === 'preset') {
        // Which table (`in`/`out`/`loop`) this candidate's preset id belongs
        // to is no longer carried on the move itself (`Move` dropped
        // `phase`) — resolved from the id, the same lookup `presetTransform`
        // folds moves through.
        const slot = vtPresetSlotOf(candidate.presetId)
        const axisPreset = slot ? vtAxisPreset(slot, candidate.presetId) : null
        if (!axisPreset) return null // an engine preset is already capability-gated at gallery build time
        const offer = vtAxisAvailability(axisPreset, axes, fontLabel)
        return offer.available ? null : (offer.reason ?? 'Not available.')
      }
      // Blink/Scatter are markers, never entries in `cfg.motion.moves` (see
      // `derivedMoves` below) — "already added" means the CONFIG leaf that
      // turns each on is already non-zero, not that a move record exists.
      if (candidate.kind === 'blink') {
        return isNum(cfg?.motion?.blink?.amount) && cfg.motion.blink.amount > 0 ? 'Blink is already added.' : null
      }
      if (candidate.kind === 'scatter') {
        return isNum(cfg?.motion?.scatter?.spread) && cfg.motion.scatter.spread > 0 ? 'Scatter is already added.' : null
      }
      return null
    },

    // Blink/Scatter are markers (see the `KINDS` comment above): their
    // settings live at `cfg.motion.blink`/`cfg.motion.scatter`, not in
    // `clip.moves`, so the panel would show no card for either without this.
    // `adapter.ts`'s `derivedMoves` doc: the panel renders these ALONGSIDE
    // `clip.moves`, and a remove/patch on one flows up for the SURFACE (not
    // this module) to translate back into the config it actually lives in —
    // spec `2026-09-03-vector-type-motion-moves-design.md` §1: "Adding the
    // Blink move sets `blink.amount` to 0.3; removing it sets 0."
    //
    // `duration`/`ease`/`at`/`loop` on these markers are cosmetic defaults
    // for the shared MoveCard's rows — Blink and Scatter's own evaluators
    // (`./blink.ts`, `./scatter.ts`) never read a Move's timing, only
    // `cfg.motion.blink`/`.scatter` directly, so these fields going stale or
    // unedited changes nothing about how either effect plays. `duration` is
    // picked to mean something anyway rather than being an arbitrary
    // constant: Blink's `rate` (blinks/sec) becomes one blink's period;
    // Scatter's `settle` (spec: "seconds from fully scattered to the base
    // value") already IS a duration. `at: 0, loop: true` on both — they run
    // continuously as full-clip loop bands, not a one-shot transition, which
    // is what `at`/`loop` (not the retired `phase`/`play`) say now.
    derivedMoves(cfg: VectorTypeConfig): Move[] {
      const out: Move[] = []
      const blink = cfg?.motion?.blink
      if (blink && isNum(blink.amount) && blink.amount > 0) {
        const rate = isNum(blink.rate) && blink.rate > 0 ? blink.rate : 6
        out.push({
          id: '__blink',
          kind: 'blink',
          at: 0,
          duration: Math.max(0.05, Math.min(60, 1 / rate)),
          loop: true,
          ease: { kind: 'named', name: 'none' },
        })
      }
      const scatter = cfg?.motion?.scatter
      if (scatter && isNum(scatter.spread) && scatter.spread > 0) {
        const settle = isNum(scatter.settle) && scatter.settle > 0 ? scatter.settle : 0.8
        out.push({
          id: '__scatter',
          kind: 'scatter',
          at: 0,
          duration: Math.max(0.05, Math.min(60, settle)),
          loop: true,
          ease: { kind: 'named', name: 'none' },
        })
      }
      return out
    },
  }
}
