/**
 * KineticType → Vector Type migration. PURE — no Vue, no DOM, no I/O.
 *
 * The Kinetic Typography node is retired. Its saved shape was a JSON string in a
 * single `params` widget (backend node `KineticType`, one STRING input); Vector
 * Type is a frontend-only config node whose state lives in
 * `properties.sailor_vectorType`. Nothing about those two shapes is compatible,
 * so a saved project has to be REWRITTEN on load rather than adapted at read
 * time — which is why this runs at `convertFromLiteGraph`, the one choke point
 * every workflow load crosses.
 *
 * ## What is carried, and what is deliberately not
 *
 * Text, font, size, spacing, colour, background, axis positions, clip duration,
 * fps and the per-glyph stagger all carry across: they are the same quantity in
 * both studios.
 *
 * ## The preset crosses through the SAME evaluator, not a hand-copied one
 *
 * A KineticType node's `presetId` was never a DOM-only idea for the presets that
 * had no GSAP `build()` — `~/data/kinetic-presets.ts` says so directly: every
 * "canvas-native" preset (which is most of them — everything except a handful of
 * GSAP-only physics/text tricks) was already evaluated by
 * `~/lib/motion/evaluate.ts`'s `IN_EVAL`/`OUT_EVAL`/`LOOP_EVAL` tables, because
 * that is what baked the `rendered[]` frames the node produced. Vector Type's own
 * preset gallery (`presetMotion.ts`) reads the exact same tables through
 * `evaluatePresetUnit`/`vtKnowsPreset` — so a Kinetic id that evaluator knows is
 * not approximated here, it IS the preset, one `kind: 'preset'` move carrying
 * the id straight across:
 *
 *   `vtKnowsPreset(category, presetId)` — where `category` is the id's own
 *   `KINETIC_PRESETS_BY_ID[id].category` (`'in' | 'out' | 'loop'`, the same
 *   partition Kinetic always used) — decides whether it crosses at all
 *   (`presetFidelity`). If it does, the migration hands `mergeConfig` the OLD
 *   `motion.{in,out,loop}` slot shape (`{ presetId, duration }`, no `ease` of its
 *   own) and lets `mergeMotion`'s existing legacy-slot conversion build the move:
 *   phase = the slot, `duration` = the node's own saved duration (Kinetic had
 *   exactly one — there was never a separate "how long is the reveal" field),
 *   ease = the preset's NATIVE ease if the evaluator names one (`legacyPresetNativeEase`),
 *   play = `repeat ×1` for a loop and `once ×1` for an in/out — reproducing
 *   exactly how the old engine ran that preset.
 *
 * What does NOT cross is a preset the shared evaluator never got: a handful of
 * GSAP-only DOM tricks (3-D `flip-*`, `jello`'s skew, `scramble-*`'s glyph
 * rewrites, …) and the four presets whose whole identity is DRAWING EXTRA COPIES
 * (`inward-echoes`, `grid-scroll-*`, `noise-tile`) — Vector Type renders one
 * outline per glyph, never copies (`presetMotion.ts`'s `VT_PRESET_CAPABILITIES`
 * deliberately excludes `'copies'`). `DROPPED_REASONS` names each one; the text
 * still arrives, with no motion. That is the deliberate trade: a missing
 * animation is visible and re-addable, a subtly wrong one is neither.
 *
 * `color-cycle` is its own case, unchanged by any of the above: it animates the
 * FILL COLOUR, which the shared per-glyph evaluator has no channel for at all
 * (`UnitState` is geometry/opacity, never a colour). It crosses as `partial`
 * via a hand-built colour TRACK (`colorCycleTracks`, appended as a `kind:'tracks'`
 * move after the merge, once the fill layer's id exists to aim at) — see that
 * function's own doc.
 *
 * An axis keyframe pair (`axisKeyframes`) is independent of the preset entirely
 * — a real from→to on `axes.<tag>` — and still crosses as a literal track
 * through the same old-shape `motion.tracks` mechanism (`axisTracks`).
 *
 * ## Baked frames are not thrown away
 *
 * A KineticType node could be wired into a Timeline, which played its baked
 * `rendered[]` PNG sequence and took the CLIP LENGTH from that array's length.
 * Those files still exist on disk, so they are carried to
 * `properties.sailor_kineticLegacy.frames` and the timeline surfaces read them
 * from there (`shared/timeline/resolveClipSource.ts`, `TimelineEditor.vue`).
 * Dropping them would silently reset every migrated clip to the default length
 * and blank its preview.
 */
import {
  DEFAULT_CONFIG,
  VT_STACK_PREFIX,
  mergeConfig,
  type VectorTypeConfig,
  type VtEasing,
  type VtMotionTrack,
  type VtPresetSlot,
} from './config'
import { isFill } from '~/lib/compositor/paint'
import { hexToOklch, parseHexA } from '~/lib/color/convert'
// The 180° hue rotation, shared with the studio's own Colour Cycle tile so a
// migrated node and a freshly-applied preset produce the SAME pair of colours.
import { vtOppositeHue } from './trackPresets'
// The SAME "does the shared evaluator know this preset id, for this slot"
// question the studio's own gallery/thumbnails ask (`presetMotion.ts`'s own
// header names this migration as its reason for existing) — reused rather than
// re-derived, so "what crosses" can never drift from "what the gallery offers".
import { vtKnowsPreset } from './presetMotion'
import { KINETIC_PRESETS_BY_ID } from '~/data/kinetic-presets'

/** What the retired node defaulted to when a field was absent — NOT what Vector
 *  Type defaults to. A params blob with no `text` rendered the word "Hello" on
 *  the user's canvas, so that is what the migration must preserve. */
const KINETIC_DEFAULTS = {
  text: 'Hello',
  size: 120,
  letterSpacing: 0,
  color: '#ffffff',
  bg: 'transparent',
  duration: 2.0,
  stagger: 0.04,
  fps: 30,
  presetId: 'slide-up',
} as const

/** The node type that no longer exists. Kept as a constant because the migration
 *  is the one place still allowed to recognise it. */
export const LEGACY_KINETIC_TYPE = 'KineticType'

// ── Preset mapping ──────────────────────────────────────────────────────────

/** How faithfully a preset survived the crossing. Reported, not guessed at. */
export type PresetFidelity = 'honest' | 'partial' | 'dropped'

/** This node's own presetId, migrated to `Colour Cycle`'s hand-built track —
 *  see the module doc's "color-cycle is its own case" section. */
const COLOR_CYCLE_ID = 'color-cycle'

/** Loop-category presets whose original stagger ran at TWICE the saved rate
 *  (`i * opts.stagger * 2`, in the retired GSAP/canvas engine) — preserved here
 *  so a migrated wave/pulse/spin travels across the word at the speed it used
 *  to, independent of which evaluator draws the motion itself. */
const STAGGER_DOUBLE_LOOP_IDS: ReadonlySet<string> = new Set(['float', 'throb', 'spin-loop'])

const NO_EVALUATOR = 'no canvas-native evaluator — a GSAP/DOM-only trick that was never ported to lib/motion/evaluate.ts'
const NEEDS_COPIES = "needs the 'copies' capability (extra per-glyph draws) — Vector Type renders one outline per "
  + "glyph, never copies (see presetMotion.ts's VT_PRESET_CAPABILITIES)"

/**
 * Why each unmapped preset is unmapped. Not consumed by the migration — it is
 * the audit trail for "we looked at this one and it cannot cross", so a future
 * reader does not have to re-derive it from GSAP builders that no longer exist.
 * Every key here is checked against the live Kinetic catalog and against
 * `presetFidelity` by this module's own test suite, so it cannot silently drift
 * out of date as `lib/motion/evaluate.ts` grows.
 */
export const DROPPED_REASONS: Record<string, string> = {
  'flip-in': `3-D rotationY with perspective — ${NO_EVALUATOR} (only the 2-D card-flip-h/v variants did)`,
  'flip-out': `3-D rotationY with perspective — ${NO_EVALUATOR} (only the 2-D card-flip-h/v variants did)`,
  'swing-in': `pendulum swing — ${NO_EVALUATOR}`,
  'swing-out': `pendulum swing — ${NO_EVALUATOR}`,
  'roll-in': `tumble roll — ${NO_EVALUATOR}`,
  'roll-out': `tumble roll — ${NO_EVALUATOR}`,
  'rubber-band': `non-uniform squash-and-stretch — ${NO_EVALUATOR}`,
  'rubber-band-out': `non-uniform squash-and-stretch — ${NO_EVALUATOR}`,
  'rubber-loop': `non-uniform squash-and-stretch — ${NO_EVALUATOR}`,
  'curtain': `per-glyph direction and distance from the middle — ${NO_EVALUATOR}`,
  'curtain-close': `per-glyph direction and distance from the middle — ${NO_EVALUATOR}`,
  'scramble-in': `rewrites the glyphs themselves — ${NO_EVALUATOR}`,
  'scramble-out': `rewrites the glyphs themselves — ${NO_EVALUATOR}`,
  'zoom-blur-in': `a blur+rush combination — ${NO_EVALUATOR} (blur-in/blur-out/blur-slide-up did get one)`,
  'zoom-blur-out': `a blur+rush combination — ${NO_EVALUATOR} (blur-in/blur-out/blur-slide-up did get one)`,
  'focus-pull': `a staggered blur in-and-out — ${NO_EVALUATOR}`,
  'bounce': `animates whole WORDS with a bounce curve — ${NO_EVALUATOR}`,
  'jello': `skewX/skewY wobble — ${NO_EVALUATOR}`,
  'tremble': `rapid micro-shake — ${NO_EVALUATOR}`,
  'heartbeat': `a scripted double-pulse envelope, not a single curve — ${NO_EVALUATOR}`,
  'neon-flicker': `a scripted multi-step opacity sequence — ${NO_EVALUATOR}`,
  'color-wave': "per-glyph hue offset — a layer's colour is resolved once per FRAME, not per glyph (see motion.ts); "
    + `also ${NO_EVALUATOR}`,
  'scan-line': `a step-eased sweep with per-glyph phase — ${NO_EVALUATOR}`,
  'pop-loop': `a staggered pop with a repeat delay — ${NO_EVALUATOR}`,
  'shuffle': `alternating per-glyph direction swaps — ${NO_EVALUATOR}`,
  'inward-echoes': NEEDS_COPIES,
  'grid-scroll-x': NEEDS_COPIES,
  'grid-scroll-y': NEEDS_COPIES,
  'noise-tile': NEEDS_COPIES,
}

/**
 * What happened to a preset. `honest` means it crosses as a `kind: 'preset'`
 * move running the exact same evaluator (`lib/motion/evaluate.ts`) the retired
 * node's own canvas bake ran — not an approximation of it. `color-cycle` is
 * `partial` — see the module doc. `dropped` covers both "known impossible"
 * (`DROPPED_REASONS`) and "never heard of it"; either way the text arrives
 * with no motion.
 */
export function presetFidelity(presetId: string): PresetFidelity {
  if (presetId === COLOR_CYCLE_ID) return 'partial'
  const category = KINETIC_PRESETS_BY_ID[presetId]?.category
  return category && vtKnowsPreset(category, presetId) ? 'honest' : 'dropped'
}

/** Every preset id this migration can carry across, for tests and reporting. */
export function mappedPresetIds(): string[] {
  return Object.keys(KINETIC_PRESETS_BY_ID).filter(id => presetFidelity(id) !== 'dropped').sort()
}

/** The slot a crossing preset lands in, and the (unmodified) id it lands under.
 *  `null` when the preset does not cross — see `presetFidelity`. */
function presetCrossing(presetId: string): { slot: VtPresetSlot; presetId: string } | null {
  const category = KINETIC_PRESETS_BY_ID[presetId]?.category
  if (!category || !vtKnowsPreset(category, presetId)) return null
  return { slot: category, presetId }
}

// ── Value coercion ──────────────────────────────────────────────────────────

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** `#abc` → `#aabbcc`; `#AABBCC` → `#aabbcc`; anything else → the fallback.
 *  Named colours and `rgba()` are NOT parsed — the colour inputs downstream are
 *  `<input type=color>`, which only speaks 6-digit hex. */
function hex6(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback
  const s = v.trim().toLowerCase()
  if (/^#[0-9a-f]{6}$/.test(s)) return s
  if (/^#[0-9a-f]{3}$/.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`
  return fallback
}

/**
 * A raw, pre-validated track handed to `mergeConfig`'s OLD-SHAPE `motion.tracks`
 * array — the same fields `mergeTrack` (`~/lib/vectortype/config.ts`) reads,
 * plus `easing`/`loops`, which `mergeMotion`'s old-shape branch reads directly
 * off the raw object (not through `mergeTrack`) to build the converted move's
 * own ease/play (`legacyTrackEasePlay`, `~/lib/studio/moves/merge.ts`).
 *
 * Deliberately NOT `VtMotionTrack`: that type dropped `easing`/`loops` when
 * ease/play moved onto the owning MOVE (see its own doc comment) — but the OLD,
 * pre-moves document shape this migration still speaks to `mergeConfig` still
 * carries both, so a literal of this shape is a type error against
 * `VtMotionTrack` even though it is exactly what the old-shape reader wants.
 */
interface RawLegacyTrack {
  path: string
  from: number
  to: number
  hold: number
  cycleOffset: number
  delay: number
  easing: VtEasing
  loops?: number
}

/**
 * The `color-cycle` track, built against the MERGED config.
 *
 * Has to run after the merge, for the reason the module doc gives: the fill
 * layer's stable id does not exist until `mergeConfig` has minted it. So this
 * is not a track a slot can declare — it is one this function derives from the
 * stack the merge produced, aimed at that layer BY ID exactly as every other
 * persisted reference to a layer is.
 *
 * Returns an empty list — and the preset therefore lands with no motion, which
 * `presetFidelity` still reports as `partial` — when the saved colour has no hue
 * to rotate (a white/black/grey KineticType node). A grey cycling to grey is a
 * row in the timeline that animates nothing, which is worse than nothing.
 *
 * `PING-PONG`, so frame 0 is the colour the node was saved with: a migrated
 * project must open looking like itself.
 */
function colorCycleTracks(config: VectorTypeConfig): VtMotionTrack[] {
  const layer = config.appearance.find(l => l?.kind === 'fill' && l.enabled !== false)
  const paint = layer?.paint
  const from = isFill(paint) && typeof paint.a === 'string' ? parseHexA(paint.a).hex : null
  if (!layer || !from) return []
  if (hexToOklch(from)[1] < 0.02) return []
  const to = vtOppositeHue(from)
  return [{
    path: `${VT_STACK_PREFIX}${layer.id}.paint.a`,
    // The 0..1 progress domain — see `VtMotionTrack.from`.
    from: 0, to: 1,
    fromColor: from, toColor: to,
    // OKLCH, matching the studio's own Colour Cycle tile: this pair is a HUE
    // ROTATION, and the default straight-line space would take it through grey.
    space: 'oklch',
    // `easing`/`loops` are GONE from `VtMotionTrack` — the ping-pong timing is
    // the owning move's now (`ease: none`, `play: backAndForth`, set at the
    // call site below), not the track's.
    hold: 0, cycleOffset: 0, delay: 0,
  }]
}

/**
 * Axis keyframes → axis tracks.
 *
 * A Vector Type track is a single from→to, so only a TWO-keyframe animation
 * crosses: three or more describe a path no one track can follow, and inventing
 * an approximation of it would be exactly the guess this migration avoids.
 * Only tags present in BOTH keyframes with different values become tracks.
 */
function axisTracks(raw: unknown, duration: number): RawLegacyTrack[] {
  if (!Array.isArray(raw) || raw.length !== 2) return []
  const sorted = [...raw].sort((a: any, b: any) => num(a?.t, 0) - num(b?.t, 0))
  const [a, b] = sorted as any[]
  const from = (a?.axes && typeof a.axes === 'object') ? a.axes as Record<string, unknown> : {}
  const to = (b?.axes && typeof b.axes === 'object') ? b.axes as Record<string, unknown> : {}
  // The FROM-keyframe's ease shapes the segment (see lib/motion/axes.ts). GSAP
  // names collapse to the two curves a track can draw.
  const easeName = typeof a?.ease === 'string' ? a.ease : ''
  const easing: VtEasing = (easeName === '' || easeName === 'none' || easeName === 'linear') ? 'linear' : 'easeinout'
  const out: RawLegacyTrack[] = []
  for (const [tag, v] of Object.entries(from)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    const end = to[tag]
    if (typeof end !== 'number' || !Number.isFinite(end) || end === v) continue
    // A keyframe pair that does not start at t=0 keeps its lead-in as a delay.
    const delay = clamp(num(a?.t, 0), 0, 1) * duration
    out.push({ path: `axes.${tag}`, from: v, to: end, easing, loops: 1, hold: 0, cycleOffset: 0, delay })
  }
  return out
}

// ── The migration ───────────────────────────────────────────────────────────

export interface KineticMigration {
  /** The rebuilt studio config — always valid, `mergeConfig`-normalised. */
  config: VectorTypeConfig
  canvasW: number
  canvasH: number
  aspectKey: string
  /** `null` means transparent, matching every other studio's wrapper. */
  background: string | null
  /** The baked PNG filenames the old node produced, in order. May be empty. */
  frames: string[]
  /** The preset that was in effect, kept for provenance — nothing reads it. */
  presetId: string
  fidelity: PresetFidelity
}

/**
 * A saved `params` blob → everything a Vector Type node needs.
 *
 * Total: a string, a parsed object, `null`, `undefined`, malformed JSON, an
 * array, a number — all produce a usable Vector Type node. A migration that
 * throws makes a project unopenable, which is strictly worse than a project
 * that opens with defaults.
 */
export function kineticParamsToVectorType(rawParams: unknown): KineticMigration {
  let o: Record<string, any> = {}
  if (typeof rawParams === 'string') {
    try {
      const parsed = JSON.parse(rawParams || '{}')
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) o = parsed
    } catch { o = {} }
  } else if (rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)) {
    o = rawParams as Record<string, any>
  }

  const presetId = typeof o.presetId === 'string' ? o.presetId : KINETIC_DEFAULTS.presetId
  const duration = clamp(num(o.duration, KINETIC_DEFAULTS.duration), 0.1, 60)
  const crossing = presetCrossing(presetId)

  // Google-hosted families cannot cross: Vector Type resolves `fontId` against
  // its own catalog of downloadable variable fonts, and a Google family has no
  // id in it. Those nodes land on the default font with their text intact.
  const fontId = (o.fontSource !== 'google' && typeof o.fontId === 'string') ? o.fontId : DEFAULT_CONFIG.fontId

  // `weight` was the wght axis under another name. Only fills a gap — an
  // explicit axes.wght always wins.
  const axes: Record<string, number> = (o.axes && typeof o.axes === 'object' && !Array.isArray(o.axes))
    ? { ...o.axes }
    : {}
  if (typeof axes.wght !== 'number' && typeof o.weight === 'number' && Number.isFinite(o.weight)) {
    axes.wght = o.weight
  }

  const staggerScale = STAGGER_DOUBLE_LOOP_IDS.has(presetId) ? 2 : 1
  const axisTr = axisTracks(o.axisKeyframes, duration)

  // The OLD document shape `mergeMotion` still reads (`~/lib/vectortype/config.ts`):
  // a preset lands in the slot named by its own phase (`in`/`out`/`loop`), a
  // literal track array lands in `tracks`. No `ease` is set on the slot — an
  // absent one means "use the preset's own NATIVE ease", exactly the render-
  // parity rule `legacyPresetNativeEase` documents, and exactly what "a
  // sensible ease — native if easily available, else default" means here.
  const motion: Record<string, unknown> = {
    duration,
    fps: clamp(Math.round(num(o.fps, KINETIC_DEFAULTS.fps)), 1, 60),
    size: 1080,
    stagger: {
      delay: clamp(num(o.stagger, KINETIC_DEFAULTS.stagger) * staggerScale, 0, 1),
      order: 'forward',
      seed: 0,
    },
  }
  if (crossing) {
    // The node's own saved `duration` IS the move's duration — Kinetic never
    // had a separate "how long is the reveal/cycle" field, so the one number
    // it did save is the honest answer for both.
    motion[crossing.slot] = { presetId: crossing.presetId, duration }
  }
  if (axisTr.length) motion.tracks = axisTr

  const config = mergeConfig({
    text: typeof o.text === 'string' ? o.text : KINETIC_DEFAULTS.text,
    fontId,
    axes,
    size: num(o.size, KINETIC_DEFAULTS.size),
    // Kinetic stored letter-spacing in em; Vector Type's tracking is 1/1000 em.
    tracking: Math.round(num(o.letterSpacing, KINETIC_DEFAULTS.letterSpacing) * 1000),
    align: 'center',
    // Handed to `mergeConfig` in the PRE-STACK spelling on purpose: KineticType
    // had exactly one colour and no outline, so the appearance stack this should
    // produce is precisely the one the legacy migration already builds — a single
    // fill layer and no stroke. Spelling it here in the stack's vocabulary would
    // be a second, hand-maintained copy of that migration.
    fill: hex6(o.color, KINETIC_DEFAULTS.color),
    strokeWidth: 0,
    motion,
  })

  // The COLOUR track, appended after the merge because it needs the layer id the
  // merge minted. Pushed rather than re-merged: it is already in `mergeTrack`'s
  // output shape (every field present, colours long-form lower-case), which its
  // own round-trip test pins — so a save/load cycle returns it unchanged. The
  // exact ease/play the studio's own Colour Cycle track preset uses
  // (`./trackPresets.ts`'s `colour-cycle`: ping-pong, i.e. `ease: none`,
  // `play: backAndForth ×1`), so a migrated node's cycle plays identically to
  // one a user added from the gallery.
  if (presetId === COLOR_CYCLE_ID) {
    const tracks = colorCycleTracks(config)
    if (tracks.length) {
      config.motion.moves.push({
        id: 'move-color-cycle',
        phase: 'loop',
        kind: 'tracks',
        presetId: 'colour-cycle',
        duration,
        ease: { kind: 'named', name: 'none' },
        play: { mode: 'backAndForth', times: 1 },
        tracks,
      })
    }
  }

  const bg = typeof o.bg === 'string' ? o.bg : KINETIC_DEFAULTS.bg
  const frames = Array.isArray(o.rendered)
    ? o.rendered.filter((f: unknown): f is string => typeof f === 'string' && f.length > 0)
    : []

  return {
    config,
    canvasW: 1280,
    canvasH: 720,
    aspectKey: '16:9',
    background: (bg === 'transparent' || bg === '') ? null : hex6(bg, '#0b0d12'),
    frames,
    presetId,
    fidelity: presetFidelity(presetId),
  }
}

/**
 * Rewrite one LiteGraph node in place, if it is a KineticType. Returns whether
 * it did.
 *
 * Ports are left exactly as saved. The old node had two outputs (frames, masks)
 * and Vector Type draws one handle, so a mask wire will not re-anchor — but
 * TRIMMING the port list would renumber nothing and lose the record, and the
 * image wire (the one that is actually used, into a Timeline or a preview) keeps
 * its index either way.
 */
export function migrateKineticNode(lgNode: any): boolean {
  if (!lgNode || typeof lgNode !== 'object' || lgNode.type !== LEGACY_KINETIC_TYPE) return false

  // The params widget was the node's only widget, so index 0 — but read it
  // defensively: a hand-edited or half-written save may carry an object, a
  // shorter array, or nothing at all.
  const wv = lgNode.widgets_values
  let raw: unknown
  if (Array.isArray(wv)) raw = wv.find((v: unknown) => typeof v === 'string')
  else if (wv && typeof wv === 'object') raw = (wv as any).params

  const m = kineticParamsToVectorType(raw)

  lgNode.type = 'VectorType'
  lgNode.widgets_values = []
  const props = (lgNode.properties && typeof lgNode.properties === 'object' && !Array.isArray(lgNode.properties))
    ? lgNode.properties
    : {}
  props.sailor_vectorType = {
    config: m.config,
    canvasW: m.canvasW,
    canvasH: m.canvasH,
    aspectKey: m.aspectKey,
    background: m.background,
  }
  // Provenance + the baked sequence the timeline surfaces still read. Written
  // even when empty so "this node was a KineticType" stays answerable.
  props.sailor_kineticLegacy = {
    presetId: m.presetId,
    fidelity: m.fidelity,
    frames: m.frames,
    fps: m.config.motion.fps,
  }
  // LiteGraph stamps the original type here for search-and-replace; leaving it
  // would make the node re-serialize under a type that no longer exists.
  if (props['Node name for S&R'] === LEGACY_KINETIC_TYPE) props['Node name for S&R'] = 'VectorType'
  lgNode.properties = props

  // A user-chosen title is theirs; the two stock titles are not.
  if (!lgNode.title || lgNode.title === 'Kinetic Typography' || lgNode.title === LEGACY_KINETIC_TYPE) {
    lgNode.title = 'Vector Type'
  }
  return true
}

/**
 * Migrate every KineticType node in a saved workflow, in place. Returns how many
 * were rewritten (0 for every graph that never had one, which is almost all of
 * them — this must be cheap on the common path).
 *
 * Idempotent: a second pass finds no KineticType nodes and changes nothing.
 */
export function migrateKineticWorkflow(workflow: any): number {
  const nodes = workflow?.nodes
  if (!Array.isArray(nodes)) return 0
  let n = 0
  for (const node of nodes) {
    try {
      if (migrateKineticNode(node)) n++
    } catch (e) {
      // One unmigratable node must not take the project down with it. The node
      // stays a KineticType, renders as an unknown type, and its data is intact.
      console.warn('[Sailor] KineticType migration failed for node', node?.id, e)
    }
  }
  return n
}
