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
 * ## Why `clipExtras` is absent
 *
 * It would be the Letter-by-letter (stagger) rows — a Vue component reading
 * `cfg.motion.stagger`. No `components/vue-canvas/motion/moves/` panel
 * exists yet to mount it into (Task 5's brief explicitly allows leaving this
 * to the panel task), so wiring a real `.vue` file here would be dead code
 * with no consumer. `clipExtras` is optional on `MovesAdapter` for exactly
 * this reason.
 */
import type {
  AnimatableGroup,
  GalleryGroup,
  MoveKindDef,
  MoveOffer,
  MovePhase,
  MovesAdapter,
} from '~/lib/studio/moves/adapter'
import type { Move, MoveEase, MoveEaseName } from '~/lib/studio/moves/types'
import { presetIdsFor, nativeEaseFor } from '~/lib/motion/evaluate'
import { KINETIC_GROUP_LABELS, KINETIC_PRESETS_BY_ID, type KineticGroup } from '~/data/kinetic-presets'
import type { VtAxis } from './font'
import type { VectorTypeConfig, VtMove } from './config'
import { VT_PRESET_CAPABILITIES } from './presetMotion'
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

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

// ── Kinds ────────────────────────────────────────────────────────────────

/** No `cardBody` either: the card UI is the panel task's; a placeholder
 *  component here would be dead code with no consumer, same reasoning as
 *  `clipExtras` above. */
const KINDS: Record<string, MoveKindDef<VectorTypeConfig>> = {
  preset: { label: 'Preset' },
  blink: { label: 'Blink' },
  scatter: { label: 'Scatter' },
}

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

/** The default duration/ease/play a freshly-added preset move gets. Loop
 *  presets are periodic on their own — `ease: none`, `play: repeat ×1` — per
 *  the design spec §1; In/Out get the preset's OWN native ease (axis presets
 *  carry one on `preset.ease`; engine presets' lives in the shared engine's
 *  IN/OUT tables, passed in by `engineOffer` via `nativeEaseFor` — see its
 *  call below) and `play: once`, so a freshly-added "grow-in" tile overshoots
 *  the same way a pre-moves document's `in` slot always did, rather than
 *  going smooth. */
function defaultTiming(phase: MovePhase, engineEase?: string): { duration: number; ease: MoveEase; play: Move['play'] } {
  if (phase === 'loop') return { duration: 1.5, ease: { kind: 'named', name: 'none' }, play: { mode: 'repeat', times: 1 } }
  return { duration: 0.8, ease: easeFromEngineName(engineEase), play: { mode: 'once', times: 1 } }
}

function axisOffer(preset: VtAxisPreset, phase: MovePhase): MoveOffer {
  return {
    id: `axis:${preset.id}`,
    label: preset.label,
    pitch: preset.pitch,
    kind: 'preset',
    presetId: preset.id,
    phase,
    build: () => ({
      phase,
      kind: 'preset',
      presetId: preset.id,
      ...defaultTiming(phase, preset.ease),
    }),
  }
}

function engineOffer(id: string, phase: MovePhase): MoveOffer {
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
      phase,
      kind: 'preset',
      presetId: id,
      ...defaultTiming(phase, engineEase),
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
      return {
        phase: preset.phase,
        kind: 'tracks',
        presetId: preset.id,
        duration,
        ease: preset.ease,
        play: preset.play,
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
        if (preset) push('Letterform', axisOffer(preset, phase))
      }
      for (const id of LETTERFORM_TRACK_IDS[phase] ?? []) {
        const preset = vtTrackPreset(id)
        if (preset && preset.phase === phase) push('Letterform', trackOffer(preset, cfg))
      }

      // Every other axis preset for this phase.
      const letterformAxis = new Set(LETTERFORM_AXIS_IDS[phase] ?? [])
      for (const offer of vtAxisOffersFor(phase, axes, fontLabel)) {
        if (letterformAxis.has(offer.preset.id)) continue
        push('Axis', axisOffer(offer.preset, phase))
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
        push(label, engineOffer(id, phase))
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
        const axisPreset = vtAxisPreset(candidate.phase, candidate.presetId)
        if (!axisPreset) return null // an engine preset is already capability-gated at gallery build time
        const offer = vtAxisAvailability(axisPreset, axes, fontLabel)
        return offer.available ? null : (offer.reason ?? 'Not available.')
      }
      if (candidate.kind === 'blink') {
        const moves = Array.isArray(cfg?.motion?.moves) ? cfg.motion.moves : []
        return moves.some(m => m.kind === 'blink') ? 'Blink is already added.' : null
      }
      if (candidate.kind === 'scatter') {
        const moves = Array.isArray(cfg?.motion?.moves) ? cfg.motion.moves : []
        return moves.some(m => m.kind === 'scatter') ? 'Scatter is already added.' : null
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
    // `duration`/`ease`/`play` on these markers are cosmetic defaults for the
    // shared MoveCard's Length/Ease/Play rows — Blink and Scatter's own
    // evaluators (`./blink.ts`, `./scatter.ts`) never read a Move's timing,
    // only `cfg.motion.blink`/`.scatter` directly, so these three fields
    // going stale or unedited changes nothing about how either effect plays.
    // `duration` is picked to mean something anyway rather than being an
    // arbitrary constant: Blink's `rate` (blinks/sec) becomes one blink's
    // period; Scatter's `settle` (spec: "seconds from fully scattered to the
    // base value") already IS a duration.
    derivedMoves(cfg: VectorTypeConfig): Move[] {
      const out: Move[] = []
      const blink = cfg?.motion?.blink
      if (blink && isNum(blink.amount) && blink.amount > 0) {
        const rate = isNum(blink.rate) && blink.rate > 0 ? blink.rate : 6
        out.push({
          id: '__blink',
          phase: 'loop',
          kind: 'blink',
          duration: Math.max(0.05, Math.min(60, 1 / rate)),
          ease: { kind: 'named', name: 'none' },
          play: { mode: 'repeat', times: 1 },
        })
      }
      const scatter = cfg?.motion?.scatter
      if (scatter && isNum(scatter.spread) && scatter.spread > 0) {
        const settle = isNum(scatter.settle) && scatter.settle > 0 ? scatter.settle : 0.8
        out.push({
          id: '__scatter',
          phase: 'loop',
          kind: 'scatter',
          duration: Math.max(0.05, Math.min(60, settle)),
          ease: { kind: 'named', name: 'none' },
          play: { mode: 'once', times: 1 },
        })
      }
      return out
    },
  }
}
