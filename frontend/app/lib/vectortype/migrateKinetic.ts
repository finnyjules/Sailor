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
 * both studios. The MOTION PRESET mostly does not. Kinetic presets were GSAP
 * timelines over DOM properties (blur filters, clip-paths, 3-D flips, scrambled
 * text content, seeded jitter); Vector Type animates a config over time plus a
 * five-field per-glyph transform (`glyph.dx/dy/scale/rotate/opacity`).
 *
 * So `PRESET_MOTION` maps ONLY the presets whose identity is fully expressible
 * in those five fields — plus, since colour tracks landed, the one whose identity
 * is a COLOUR (`color-cycle`; see `colorCycleTracks`, and note that its sibling
 * `color-wave` is still dropped for a different reason entirely — a layer's
 * colour is resolved once per frame, not per glyph). Everything else is dropped,
 * and the text arrives with no motion at all. That is the deliberate trade: a missing animation is visible
 * and re-addable, a subtly wrong one is neither. `presetFidelity()` reports
 * which of the three a preset got, and it is the thing to read before claiming
 * coverage.
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
} from './config'
import { isFill } from '~/lib/compositor/paint'
import { hexToOklch, parseHexA } from '~/lib/color/convert'
// The 180° hue rotation, shared with the studio's own Colour Cycle tile so a
// migrated node and a freshly-applied preset produce the SAME pair of colours.
import { vtOppositeHue } from './trackPresets'

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

interface PresetMotion {
  /** Tracks in the `glyph.` namespace, minus the timing fields that come from
   *  the saved clip (`delay` is always 0; `duration` is the clip's). */
  tracks: { path: string; from: number; to: number; easing: VtEasing; loops?: number }[]
  fidelity: Exclude<PresetFidelity, 'dropped'>
  /** The preset's own multiplier on `opts.stagger` (several loop presets used
   *  `i * opts.stagger * 2`), so the wave travels at the speed it used to. */
  staggerScale?: number
  /** Why it is only `partial`. Present exactly when fidelity is 'partial'. */
  note?: string
  /**
   * This preset animates the FILL COLOUR, so its track is built after the merge.
   *
   * It cannot be declared in `tracks` above like every other one, and the reason
   * is mechanical: a colour track addresses `appearance.<layerId>.paint.a`, and
   * the layer id is MINTED BY `mergeConfig` (this migration hands it the legacy
   * flat `fill` string and lets the stack migration build the layer — see the
   * comment at the `fill:` line below). So the path does not exist until the
   * config does. `colorCycleTrack` builds it from the merged stack.
   */
  colorCycle?: boolean
}

const T = (path: string, from: number, to: number, easing: VtEasing = 'easeinout', loops?: number) =>
  ({ path, from, to, easing, ...(loops ? { loops } : {}) })

/** What a `color-cycle` gives up on the way across. Declared BEFORE
 *  `PRESET_MOTION` because that table is a module-level const that reads it. */
const COLOR_CYCLE_NOTE =
  'the full hue wheel becomes a ping-pong to the OPPOSITE hue and back — half the wheel each way, from the '
  + 'colour that was saved; the mix runs in OKLCH, so the chroma survives the crossing instead of going grey halfway'

/**
 * Kinetic preset id → Vector Type glyph tracks.
 *
 * A preset is in this table only if `{dx, dy, scale, rotate, opacity}` and the
 * three easing curves can express what it DID. Presets left out are listed in
 * `DROPPED_REASONS` with the reason, so "unknown" and "known-impossible" stay
 * distinguishable.
 *
 * Offsets are the presets' own pixel values, unscaled. Kinetic ran them against
 * a preview font-size of `min(72, size/2)`; Vector Type runs them against `size`
 * itself, so the motion reads slightly smaller relative to the type. Rescaling
 * them by an invented factor would be a guess, so they are left literal.
 *
 * TIMING IS RE-SPREAD. A Kinetic "in" preset finished in 40–70% of the clip and
 * held; a Vector Type track spans the whole clip (`hold` pins both ends
 * symmetrically, so "finish early and stay" is not expressible). Start and end
 * states are exact; the reveal is slower. Every in/out entry carries that.
 */
const PRESET_MOTION: Record<string, PresetMotion> = {
  // ── IN ────────────────────────────────────────────────────────────────────
  'fade-in':    { fidelity: 'honest', tracks: [T('glyph.opacity', 0, 1)] },
  'slide-up':   { fidelity: 'honest', tracks: [T('glyph.dy', 40, 0), T('glyph.opacity', 0, 1)] },
  'slide-down': { fidelity: 'honest', tracks: [T('glyph.dy', -40, 0), T('glyph.opacity', 0, 1)] },
  'slide-left': { fidelity: 'honest', tracks: [T('glyph.dx', 40, 0), T('glyph.opacity', 0, 1)] },
  'slide-right': { fidelity: 'honest', tracks: [T('glyph.dx', -40, 0), T('glyph.opacity', 0, 1)] },
  'shrink-in':  { fidelity: 'honest', tracks: [T('glyph.scale', 2.5, 1), T('glyph.opacity', 0, 1)] },
  'grow-in': {
    fidelity: 'partial', note: 'back.out(1.7) overshoot lost — it settles instead of overshooting',
    tracks: [T('glyph.scale', 0, 1), T('glyph.opacity', 0, 1)],
  },
  'spin-in': {
    fidelity: 'partial', note: 'back.out(1.4) overshoot lost',
    tracks: [T('glyph.rotate', 180, 0), T('glyph.scale', 0, 1), T('glyph.opacity', 0, 1)],
  },
  'swing-in': {
    fidelity: 'partial', note: 'elastic.out swing lost, and the pivot is the glyph origin, not its top edge',
    tracks: [T('glyph.rotate', -90, 0), T('glyph.opacity', 0, 1)],
  },
  'roll-in': {
    fidelity: 'partial', note: 'back.out overshoot lost, and the pivot is the glyph origin, not bottom-center',
    tracks: [T('glyph.dx', -40, 0), T('glyph.rotate', -120, 0), T('glyph.opacity', 0, 1)],
  },

  // ── OUT ───────────────────────────────────────────────────────────────────
  'fade-out':        { fidelity: 'honest', tracks: [T('glyph.opacity', 1, 0)] },
  'slide-out-up':    { fidelity: 'honest', tracks: [T('glyph.dy', 0, -40), T('glyph.opacity', 1, 0)] },
  'slide-out-down':  { fidelity: 'honest', tracks: [T('glyph.dy', 0, 40), T('glyph.opacity', 1, 0)] },
  'slide-out-left':  { fidelity: 'honest', tracks: [T('glyph.dx', 0, -40), T('glyph.opacity', 1, 0)] },
  'slide-out-right': { fidelity: 'honest', tracks: [T('glyph.dx', 0, 40), T('glyph.opacity', 1, 0)] },
  'grow-out':        { fidelity: 'honest', tracks: [T('glyph.scale', 1, 2.5), T('glyph.opacity', 1, 0)] },
  'shrink-out': {
    fidelity: 'partial', note: 'back.in(1.7) anticipation lost',
    tracks: [T('glyph.scale', 1, 0), T('glyph.opacity', 1, 0)],
  },
  'spin-out': {
    fidelity: 'honest',
    tracks: [T('glyph.rotate', 0, 180), T('glyph.scale', 1, 0), T('glyph.opacity', 1, 0)],
  },
  'swing-out': {
    fidelity: 'partial', note: 'the pivot is the glyph origin, not its top edge',
    tracks: [T('glyph.rotate', 0, 90), T('glyph.opacity', 1, 0)],
  },
  'roll-out': {
    fidelity: 'partial', note: 'the pivot is the glyph origin, not bottom-center',
    tracks: [T('glyph.dx', 0, 40), T('glyph.rotate', 0, 120), T('glyph.opacity', 1, 0)],
  },

  // ── LOOP ──────────────────────────────────────────────────────────────────
  // A yoyo repeat is `pingpong` with `loops` = clip / (2 × half-cycle). Kinetic's
  // half-cycles were fractions of the clip, so the loop count is rounded to the
  // nearest whole cycle — the oscillation is the same shape, its rate is within
  // a cycle of the original.
  'wave':  { fidelity: 'honest', tracks: [T('glyph.dy', 0, -20, 'pingpong', 2)] },
  'float': { fidelity: 'honest', staggerScale: 2, tracks: [T('glyph.dy', 0, -8, 'pingpong'), T('glyph.dx', 0, 3, 'pingpong')] },
  'sway':  { fidelity: 'partial', note: 'the pivot is the glyph origin, not top-center', tracks: [T('glyph.rotate', 0, 8, 'pingpong', 2)] },
  'throb': { fidelity: 'honest', staggerScale: 2, tracks: [T('glyph.scale', 1, 1.2, 'pingpong', 2)] },
  'rock':  { fidelity: 'partial', note: 'the pivot is the glyph origin, not bottom-center', tracks: [T('glyph.rotate', 0, 12, 'pingpong', 2)] },
  'spin-loop': { fidelity: 'honest', staggerScale: 2, tracks: [T('glyph.rotate', 0, 360, 'linear')] },

  // ── COLOUR ────────────────────────────────────────────────────────────────
  // Dropped until Task 6, with the reason "tracks carry numbers, not colours".
  // They do now, so this crosses — as `partial`, and the note says exactly what
  // was lost rather than implying a full revival.
  'color-cycle': { fidelity: 'partial', note: COLOR_CYCLE_NOTE, tracks: [], colorCycle: true },
}

/**
 * Why each unmapped preset is unmapped. Not consumed by the migration — it is
 * the audit trail for "we looked at this one and it cannot cross", so a future
 * reader does not have to re-derive it from GSAP builders that no longer exist.
 */
export const DROPPED_REASONS: Record<string, string> = {
  'appear': 'instant per-glyph cut — no step easing',
  'disappear': 'instant per-glyph cut — no step easing',
  'typewriter': 'instant per-glyph cut — no step easing',
  'typewriter-out': 'instant per-glyph cut — no step easing',
  'mask-up': 'clip-path reveal — no per-glyph clipping',
  'mask-down': 'clip-path reveal — no per-glyph clipping',
  'mask-out-up': 'clip-path reveal — no per-glyph clipping',
  'mask-out-down': 'clip-path reveal — no per-glyph clipping',
  'blur-in': 'CSS blur filter — not a vector operation',
  'blur-out': 'CSS blur filter — not a vector operation',
  'blur-slide-up': 'blur is not a glyph track field (and no legacy slate ever saved this id)',
  'zoom-blur-in': 'CSS blur filter — not a vector operation',
  'zoom-blur-out': 'CSS blur filter — not a vector operation',
  'focus-pull': 'CSS blur filter — not a vector operation',
  'flip-in': '3-D rotationY with perspective — the transform is 2-D',
  'flip-out': '3-D rotationY with perspective — the transform is 2-D',
  'card-flip-h': '3-D card flip (canvas-native utility preset)',
  'card-flip-v': '3-D card flip (canvas-native utility preset)',
  'card-flip-h-out': '3-D card flip (canvas-native utility preset)',
  'card-flip-v-out': '3-D card flip (canvas-native utility preset)',
  'elastic-drop': 'the elastic bounce IS the preset — without it, it is just a slide',
  'elastic-launch': 'the elastic anticipation IS the preset',
  'rubber-band': 'non-uniform scaleX/scaleY — glyph.scale is uniform',
  'rubber-band-out': 'non-uniform scaleX/scaleY — glyph.scale is uniform',
  'rubber-loop': 'non-uniform scaleX/scaleY — glyph.scale is uniform',
  'jello': 'skewX/skewY — not in the glyph transform',
  'curtain': 'per-glyph direction and distance from the middle — a track is uniform across glyphs',
  'curtain-close': 'per-glyph direction and distance from the middle — a track is uniform across glyphs',
  'shuffle': 'alternating per-glyph direction — a track is uniform across glyphs',
  'glitch-in': 'seeded random offsets with step easing',
  'glitch-out': 'seeded random offsets with step easing',
  'glitch-loop': 'seeded random offsets with step easing',
  'tremble': 'random micro-jitter with step easing',
  'wiggle': 'random positional jitter (canvas-native utility preset)',
  'scan-line': 'step-eased sweep with per-glyph phase',
  'neon-flicker': 'a scripted multi-step opacity sequence, not a curve',
  'heartbeat': 'a double-beat envelope, not a single curve — and it scales the whole word',
  'scramble-in': 'rewrites the glyphs themselves',
  'scramble-out': 'rewrites the glyphs themselves',
  // `color-cycle` is NO LONGER HERE — tracks carry colours as of Task 6, and it
  // crosses as a `partial` (see COLOR_CYCLE_NOTE). This entry stays only as the
  // record that it was once impossible.
  'color-wave': 'per-glyph hue offset — a layer\'s colour is resolved once per FRAME, not per glyph (see motion.ts)',
  'bounce': 'animates whole WORDS — Vector Type motion is per-glyph',
  'breathe': 'scales the whole container — Vector Type motion is per-glyph',
  'marquee': 'scrolls the whole container across the frame',
  'pop-loop': 'back.out(3) pop with a repeat delay — no repeat-delay in a track',
  'inward-echoes': 'draws multiple echo copies of the run',
  'grid-scroll-x': 'tiles the run across the frame',
  'grid-scroll-y': 'tiles the run across the frame',
  'noise-tile': 'tiles the run across the frame',
}

/** What happened to a preset. `dropped` covers both "known impossible" and
 *  "never heard of it" — in both cases the text arrives without motion. */
export function presetFidelity(presetId: string): PresetFidelity {
  return PRESET_MOTION[presetId]?.fidelity ?? 'dropped'
}

/** Every preset id this migration can carry across, for tests and reporting. */
export function mappedPresetIds(): string[] {
  return Object.keys(PRESET_MOTION).sort()
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

/** A finished track: the preset's shape plus the timing every track needs. */
function fullTrack(t: { path: string; from: number; to: number; easing: VtEasing; loops?: number }): VtMotionTrack {
  return { path: t.path, from: t.from, to: t.to, easing: t.easing, loops: t.loops ?? 1, hold: 0, cycleOffset: 0, delay: 0 }
}

/**
 * The `color-cycle` track, built against the MERGED config.
 *
 * Has to run after the merge, for the reason `PresetMotion.colorCycle` gives: the
 * fill layer's stable id does not exist until `mergeConfig` has minted it. So this
 * is not a track the table can declare — it is one this function derives from the
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
function axisTracks(raw: unknown, duration: number): VtMotionTrack[] {
  if (!Array.isArray(raw) || raw.length !== 2) return []
  const sorted = [...raw].sort((a: any, b: any) => num(a?.t, 0) - num(b?.t, 0))
  const [a, b] = sorted as any[]
  const from = (a?.axes && typeof a.axes === 'object') ? a.axes as Record<string, unknown> : {}
  const to = (b?.axes && typeof b.axes === 'object') ? b.axes as Record<string, unknown> : {}
  // The FROM-keyframe's ease shapes the segment (see lib/motion/axes.ts). GSAP
  // names collapse to the two curves a track can draw.
  const easeName = typeof a?.ease === 'string' ? a.ease : ''
  const easing: VtEasing = (easeName === '' || easeName === 'none' || easeName === 'linear') ? 'linear' : 'easeinout'
  const out: VtMotionTrack[] = []
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
  const mapped = PRESET_MOTION[presetId]
  const duration = clamp(num(o.duration, KINETIC_DEFAULTS.duration), 0.1, 60)

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

  const staggerScale = mapped?.staggerScale ?? 1
  const tracks: VtMotionTrack[] = [
    ...(mapped?.tracks ?? []).map(fullTrack),
    ...axisTracks(o.axisKeyframes, duration),
  ]

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
    motion: {
      tracks,
      duration,
      fps: clamp(Math.round(num(o.fps, KINETIC_DEFAULTS.fps)), 1, 60),
      size: 1080,
      stagger: {
        delay: clamp(num(o.stagger, KINETIC_DEFAULTS.stagger) * staggerScale, 0, 1),
        order: 'forward',
        seed: 0,
      },
    },
  })

  // The COLOUR track, appended after the merge because it needs the layer id the
  // merge minted. Pushed rather than re-merged: it is already in `mergeTrack`'s
  // output shape (every field present, colours long-form lower-case), which its
  // own round-trip test pins — so a save/load cycle returns it unchanged.
  //
  // CARRY-FORWARD (motion moves, Task 5): `motion.tracks` no longer exists —
  // a track lives inside a `kind: 'tracks'` MOVE now. Wrapped in one here with
  // the exact ease/play the studio's own Colour Cycle track preset uses
  // (`./trackPresets.ts`'s `colour-cycle`: ping-pong, i.e. `ease: none`,
  // `play: backAndForth ×1`), so a migrated node's cycle plays identically to
  // one a user added from the gallery.
  if (mapped?.colorCycle) {
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
