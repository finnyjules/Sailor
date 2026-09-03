// frontend/app/lib/motion/evaluate.ts
/**
 * Pure time-evaluation of layer animations. No DOM, no GSAP, no randomness —
 * same (animation, t) in, same state out, which is what makes preview, bake,
 * and golden tests agree.
 *
 * Spatial units: UnitState dx/dy are in UNIT-BOX HEIGHTS (1 = the height of
 * the animated unit's own box — a char cell for text units, the layer bbox
 * for whole-layer animation). The painter multiplies into px. This keeps
 * preset "distances" proportional at any canvas size, mirroring how the GSAP
 * presets' px offsets relate to their preview font size.
 */
import type { LayerAnimation, LayerAnimSpec, LayerKeyframe, FrameMotion } from './types'
import { resolveEase, easeInOutQuad, linear } from './easing'

/** One extra draw of the unit, composed with the base sample's transform.
 *  dx/dy in UNIT-BOX HEIGHTS like UnitState. Used for echo trails and tiling. */
export interface UnitCopy {
  dx: number
  dy: number
  scale: number       // multiplicative with the base sample's scale
  opacity: number     // multiplicative with the base sample's opacity
  rotation?: number   // degrees, additive
}

export interface UnitState {
  dx: number; dy: number          // unit-box heights
  scale: number                   // multiplicative
  /** Non-uniform scale (flip squash). Multiplied with `scale`; absent = 1. */
  scaleX?: number
  scaleY?: number
  rotation: number                // degrees, additive
  opacity: number                 // 0..1 multiplicative
  /** Clip the unit's box: fraction hidden from one side (mask presets). */
  clip?: { side: 'top' | 'bottom' | 'left' | 'right'; amount: number }
  /** Extra draws of this unit (echoes/tiles); painter draws base then copies. */
  copies?: UnitCopy[]
  /** Variable-font AXIS DELTAS by tag (e.g. `{ wght: -300 }`), added to the
   *  glyph's resting axis values. Vector Type consumes these; the Compositor
   *  ignores them (Canvas2D text has no axis control). Absent = no change. */
  axes?: Record<string, number>
  /** Blur radius in UNIT-BOX HEIGHTS, like dx/dy — the consumer multiplies by
   *  its own unit box so blur scales with type size. 0/absent = sharp.
   *  Consumed by Vector Type; the Compositor painters ignore it today
   *  (wiring blur into paint.ts is deliberately out of scope). */
  blur?: number
}

export interface LayerMotionState {
  visible: boolean
  /** Whole-layer transform from keyframes (canvas-normalized dx, dy). */
  layer: UnitState
  /** Per-unit states (chars for text; single entry for other kinds). */
  units?: UnitState[]
}

export const IDENTITY_UNIT: UnitState = Object.freeze({ dx: 0, dy: 0, scale: 1, rotation: 0, opacity: 1 })
const HIDDEN: LayerMotionState = Object.freeze({ visible: false, layer: IDENTITY_UNIT })

// Deterministic per-unit pseudo-random in [0,1) (replaces Math.random()).
function seeded(i: number, salt: number): number {
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453
  return x - Math.floor(x)
}

export function layerWindow(
  anim: Pick<LayerAnimation, 'offset' | 'duration'>,
  motion: FrameMotion,
): { start: number; end: number } {
  const start = Math.max(0, anim.offset)
  const end = anim.duration == null
    ? motion.duration
    : Math.min(motion.duration, start + Math.max(0, anim.duration))
  return { start, end }
}

// ── Per-preset unit evaluation ───────────────────────────────────────────────
// IN: e is the eased progress 0→1 (0 = fully out, 1 = at rest).
// OUT: e is the eased progress 0→1 (0 = at rest, 1 = fully gone).
// LOOP: fn(phase, i) with phase = ((tIn - i·stagger) / duration) mod 1.

type UnitEval = (e: number, i: number, n: number, params: Record<string, number>) => UnitState
const u = (p: Partial<UnitState>): UnitState => ({ ...IDENTITY_UNIT, ...p })

/** Per-preset param defaults — the single source of truth. The catalog's
 *  param schemas (data/kinetic-presets.ts) read their defaults from here. */
export const PRESET_PARAM_DEFAULTS: Record<string, Record<string, number>> = {
  'wiggle':          { amplitude: 0.15, cycles: 2 },
  'card-flip-h':     { overshoot: 1 },
  'card-flip-v':     { overshoot: 1 },
  'card-flip-h-out': { overshoot: 1 },
  'card-flip-v-out': { overshoot: 1 },
  'inward-echoes':   { copies: 3, scaleStep: 0.35, fade: 0.55 },
  'grid-scroll-x':   { tiles: 2, gap: 1.5 },
  'grid-scroll-y':   { tiles: 2, gap: 1.5 },
  'noise-tile':      { tiles: 1, flicker: 1 },
}

export function resolveParams(spec: LayerAnimSpec): Record<string, number> {
  return { ...(PRESET_PARAM_DEFAULTS[spec.presetId] ?? {}), ...(spec.params ?? {}) }
}

/** Peak blur for the blur presets, in UNIT-BOX HEIGHTS (see UnitState.blur):
 *  0.12 ≈ 12px at a 100px em box, which is what the legacy CSS-filter builders
 *  used at preview size — but proportional, so it holds at any type size. */
const BLUR_MAX = 0.12

const IN_EVAL: Record<string, { fn: UnitEval; ease: string }> = {
  'appear':       { ease: 'none',            fn: e => u({ opacity: e > 0 ? 1 : 0 }) },
  'fade-in':      { ease: 'power2.out',      fn: e => u({ opacity: e }) },
  'slide-up':     { ease: 'power2.out',      fn: e => u({ dy: (1 - e) * 0.5, opacity: e }) },
  'slide-down':   { ease: 'power2.out',      fn: e => u({ dy: -(1 - e) * 0.5, opacity: e }) },
  'slide-left':   { ease: 'power2.out',      fn: e => u({ dx: (1 - e) * 0.5, opacity: e }) },
  'slide-right':  { ease: 'power2.out',      fn: e => u({ dx: -(1 - e) * 0.5, opacity: e }) },
  'mask-up':      { ease: 'power3.out',      fn: e => u({ dy: (1 - e) * 0.25, clip: { side: 'top', amount: 1 - e } }) },
  'mask-down':    { ease: 'power3.out',      fn: e => u({ dy: -(1 - e) * 0.25, clip: { side: 'bottom', amount: 1 - e } }) },
  'grow-in':      { ease: 'back.out(1.7)',   fn: e => u({ scale: Math.max(0.001, e), opacity: Math.min(1, e * 2) }) },
  'shrink-in':    { ease: 'power3.out',      fn: e => u({ scale: 2.5 - 1.5 * e, opacity: e }) },
  // Blur decays to EXACTLY 0 at e === 1 — an entrance must end sharp.
  'blur-in':       { ease: 'power2.out',     fn: e => u({ blur: BLUR_MAX * (1 - e), opacity: e }) },
  'blur-slide-up': { ease: 'power2.out',     fn: e => u({ dy: (1 - e) * 0.5, blur: BLUR_MAX * (1 - e), opacity: e }) },
  'spin-in':      { ease: 'back.out(1.4)',   fn: e => u({ rotation: (1 - e) * 180, scale: Math.max(0.001, e), opacity: e }) },
  'elastic-drop': { ease: 'elastic.out(1, 0.3)', fn: e => u({ dy: -(1 - e) * 1.0, opacity: 1 }) },
  'typewriter':   { ease: 'none',            fn: e => u({ opacity: e > 0.01 ? 1 : 0 }) },
  'glitch-in':    { ease: 'steps(6)',        fn: (e, i) => u({
    dx: (seeded(i, 1) - 0.5) * 0.75 * (1 - e),
    dy: (seeded(i, 2) - 0.5) * 0.4 * (1 - e),
    opacity: e > 0 ? 1 : 0,
  }) },
  'card-flip-h': { ease: 'power2.out', fn: (e, _i, _n, p) => u({
    scaleX: Math.max(0.001, e + (p.overshoot ?? 1) * 0.2 * Math.sin(e * Math.PI)),
    opacity: Math.min(1, e * 3),
  }) },
  'card-flip-v': { ease: 'power2.out', fn: (e, _i, _n, p) => u({
    scaleY: Math.max(0.001, e + (p.overshoot ?? 1) * 0.2 * Math.sin(e * Math.PI)),
    opacity: Math.min(1, e * 3),
  }) },
}

const OUT_EVAL: Record<string, { fn: UnitEval; ease: string }> = {
  'disappear':       { ease: 'none',          fn: e => u({ opacity: e > 0 ? 0 : 1 }) },
  'fade-out':        { ease: 'power2.in',     fn: e => u({ opacity: 1 - e }) },
  'slide-out-up':    { ease: 'power2.in',     fn: e => u({ dy: -e * 0.5, opacity: 1 - e }) },
  'slide-out-down':  { ease: 'power2.in',     fn: e => u({ dy: e * 0.5, opacity: 1 - e }) },
  'slide-out-left':  { ease: 'power2.in',     fn: e => u({ dx: -e * 0.5, opacity: 1 - e }) },
  'slide-out-right': { ease: 'power2.in',     fn: e => u({ dx: e * 0.5, opacity: 1 - e }) },
  'mask-out-up':     { ease: 'power3.in',     fn: e => u({ dy: -e * 0.25, clip: { side: 'bottom', amount: e } }) },
  'mask-out-down':   { ease: 'power3.in',     fn: e => u({ dy: e * 0.25, clip: { side: 'top', amount: e } }) },
  'shrink-out':      { ease: 'back.in(1.7)',  fn: e => u({ scale: Math.max(0.001, 1 - e), opacity: 1 - e }) },
  'grow-out':        { ease: 'power3.in',     fn: e => u({ scale: 1 + 1.5 * e, opacity: 1 - e }) },
  // Mirror of blur-in: starts sharp, ends fully blurred as it fades out.
  'blur-out':        { ease: 'power2.in',     fn: e => u({ blur: BLUR_MAX * e, opacity: 1 - e }) },
  'spin-out':        { ease: 'power3.in',     fn: e => u({ rotation: e * 180, scale: Math.max(0.001, 1 - e), opacity: 1 - e }) },
  'elastic-launch':  { ease: 'back.in(2)',    fn: e => u({ dy: -e * 1.0, opacity: 1 - e }) },
  'typewriter-out':  { ease: 'none',          fn: (_e, _i, _n) => u({ opacity: _e > 0.01 ? 0 : 1 }) },
  'glitch-out':      { ease: 'steps(6)',      fn: (e, i) => u({
    dx: (seeded(i, 3) - 0.5) * 0.75 * e,
    dy: (seeded(i, 4) - 0.5) * 0.4 * e,
    opacity: 1 - e,
  }) },
  'card-flip-h-out': { ease: 'power2.in', fn: (e, _i, _n, p) => u({
    scaleX: Math.max(0.001, (1 - e) + (p.overshoot ?? 1) * 0.2 * Math.sin((1 - e) * Math.PI)),
    opacity: Math.min(1, (1 - e) * 3),
  }) },
  'card-flip-v-out': { ease: 'power2.in', fn: (e, _i, _n, p) => u({
    scaleY: Math.max(0.001, (1 - e) + (p.overshoot ?? 1) * 0.2 * Math.sin((1 - e) * Math.PI)),
    opacity: Math.min(1, (1 - e) * 3),
  }) },
}

// Loop: fn(phase 0..1, i) — periodic by construction (sin/cos of 2π·phase).
type LoopEval = (phase: number, i: number, n: number, params: Record<string, number>) => UnitState
const TWO_PI = Math.PI * 2
const LOOP_EVAL: Record<string, LoopEval> = {
  'wave':      (p) => u({ dy: -0.25 * Math.sin(p * TWO_PI) }),
  'float':     (p) => u({ dy: -0.1 * Math.sin(p * TWO_PI), dx: 0.04 * Math.sin(p * TWO_PI + 1) }),
  'sway':      (p) => u({ rotation: 8 * Math.sin(p * TWO_PI) }),
  'breathe':   (p) => u({ scale: 1 + 0.06 * Math.sin(p * TWO_PI) }),
  'throb':     (p) => u({ scale: 1 + 0.2 * Math.max(0, Math.sin(p * TWO_PI)) }),
  'spin-loop': (p) => u({ rotation: p * 360 }),
  'rock':      (p) => u({ rotation: 12 * Math.sin(p * TWO_PI) }),
  'glitch-loop': (p, i) => {
    const tick = Math.floor(p * 12)
    return u({ dx: (seeded(i * 131 + tick, 5) - 0.5) * 0.12, dy: (seeded(i * 131 + tick, 6) - 0.5) * 0.06 })
  },
  'marquee':   (p) => u({ dx: (1 - 2 * p) * 2 }), // +2 → −2 sweep in unit-box heights (the layer's own box drives the distance)
  'wiggle': (p, i, _n, prm) => {
    const amp = prm.amplitude ?? 0.15
    const k = Math.max(1, Math.round(prm.cycles ?? 2))
    const ph1 = seeded(i, 11) * TWO_PI, ph2 = seeded(i, 12) * TWO_PI, ph3 = seeded(i, 13) * TWO_PI
    const wob = (phase: number) => Math.sin(k * p * TWO_PI + phase) + 0.5 * Math.sin(2 * k * p * TWO_PI + phase * 1.7)
    return u({
      dx: amp * 0.35 * wob(ph1),
      dy: amp * 0.35 * wob(ph2),
      rotation: amp * 40 * wob(ph3) * 0.5,
    })
  },
  // Echo treadmill: copy j sits at cyclic depth q(p) = (j + 1 − p) mod count.
  // As p advances every copy drifts one depth-step inward per cycle; at the
  // wrap the innermost copy relabels to the outermost (which is nearly
  // invisible via fade^depth), so the SET of copies is identical at p=0 and
  // p→1 — seamless loop by relabeling, verified element-wise after the sort.
  'inward-echoes': (p, _i, _n, prm) => {
    const count = Math.max(1, Math.round(prm.copies ?? 3))
    const step = prm.scaleStep ?? 0.35
    const fade = prm.fade ?? 0.55
    const copies: UnitCopy[] = Array.from({ length: count }, (_, j) => {
      const q = ((j + 1 - p) % count + count) % count   // continuous cyclic depth
      return { dx: 0, dy: 0, scale: 1 + step * q, opacity: fade ** (q + 1) }
    }).sort((a, b) => b.scale - a.scale)                 // draw far echoes first
    return u({ copies })
  },
  // Marquee treadmill: base slides one gap per cycle; a static ring of ±tiles
  // copies hides the wrap jump.
  'grid-scroll-x': (p, _i, _n, prm) => {
    const tiles = Math.max(1, Math.round(prm.tiles ?? 2))
    const gap = prm.gap ?? 1.5
    const copies: UnitCopy[] = []
    for (let j = -tiles; j <= tiles; j++) {
      if (j !== 0) copies.push({ dx: j * gap, dy: 0, scale: 1, opacity: 1 })
    }
    return u({ dx: -p * gap, copies })
  },
  'grid-scroll-y': (p, _i, _n, prm) => {
    const tiles = Math.max(1, Math.round(prm.tiles ?? 2))
    const gap = prm.gap ?? 1.5
    const copies: UnitCopy[] = []
    for (let j = -tiles; j <= tiles; j++) {
      if (j !== 0) copies.push({ dx: 0, dy: j * gap, scale: 1, opacity: 1 })
    }
    return u({ dy: -p * gap, copies })
  },
  // Static (2t+1)² grid; each cell flickers on its own seeded phase.
  'noise-tile': (p, _i, _n, prm) => {
    const t = Math.max(1, Math.round(prm.tiles ?? 1))
    const flicker = prm.flicker ?? 1
    const gap = 1.3
    const copies: UnitCopy[] = []
    for (let gy = -t; gy <= t; gy++) {
      for (let gx = -t; gx <= t; gx++) {
        if (gx === 0 && gy === 0) continue
        const idx = (gy + t) * (2 * t + 1) + (gx + t)
        const tw = 0.5 + 0.5 * Math.sin(TWO_PI * (p + seeded(idx, 7)))
        copies.push({ dx: gx * gap, dy: gy * gap, scale: 1, opacity: Math.max(0.1, 1 - flicker * tw) })
      }
    }
    return u({ copies })
  },
}

export const SUPPORTED_IN_IDS = Object.keys(IN_EVAL)
export const SUPPORTED_OUT_IDS = Object.keys(OUT_EVAL)
export const SUPPORTED_LOOP_IDS = Object.keys(LOOP_EVAL)

/**
 * Evaluate ONE preset's `UnitState` directly from an ALREADY-RESOLVED
 * progress, bypassing `evaluateAnimation`'s own window/ease machinery.
 *
 * Added for the moves engines (Vector Type's `presetMotion.ts` first): once a
 * caller owns its own phase/window/ease computation over N stacked moves —
 * `lib/studio/moves/phase.ts`'s `movePhase`, which every move (however many
 * per phase) is evaluated against independently — `evaluateAnimation`'s
 * single-slot-per-phase windowing no longer applies, but the per-preset
 * VISUAL function (`IN_EVAL['slide-up'].fn`, etc.) still needs to run. This is
 * that function, exposed directly.
 *
 * `progress` means: for `slot: 'in' | 'out'`, the EASED 0→1 progress of that
 * pass (what `evalSpecUnits` would have computed as `ease(unitProgress(...))`
 * — do not ease it again here). For `slot: 'loop'`, the 0..1 CYCLE PHASE
 * (what `LOOP_EVAL`'s functions call `phase`).
 *
 * `evaluateAnimation` and this function are two independent readers of the
 * SAME private tables — deliberately: neither is built in terms of the other,
 * so `evaluateAnimation`'s own windowing (the Compositor's still path) is
 * untouched by this addition.
 */
export function evaluatePresetUnit(
  slot: 'in' | 'out' | 'loop',
  presetId: string,
  progress: number,
  i: number,
  n: number,
  params: Record<string, number> = {},
): UnitState {
  const p = Number.isFinite(progress) ? progress : 0
  const ii = Math.max(0, Math.floor(i))
  const nn = Math.max(1, Math.floor(n))
  if (slot === 'in') { const entry = IN_EVAL[presetId] ?? IN_EVAL['fade-in']!; return entry.fn(p, ii, nn, params) }
  if (slot === 'out') { const entry = OUT_EVAL[presetId] ?? OUT_EVAL['fade-out']!; return entry.fn(p, ii, nn, params) }
  const loopFn = LOOP_EVAL[presetId]
  if (!loopFn) return IDENTITY_UNIT
  const phase = ((p % 1) + 1) % 1
  return loopFn(phase, ii, nn, params)
}

/**
 * Presets whose ENTIRE effect is the per-unit stagger window.
 *
 * `typewriter` is `opacity: e > 0.01 ? 1 : 0` — a step, with no intermediate
 * state and no dependence on the unit index. Every letter it types is typed by
 * the STAGGER shifting each unit's window, not by the function. Drive it at
 * `stagger = 0` and all n units step together: the word is simply present, and
 * the tile does nothing it is named for.
 *
 * DECLARED, not derived, and that is the honest description. `appear` is the
 * *same function* (`e > 0` vs `e > 0.01`), so no probe over the engine's output
 * can separate them — the difference is the promise the label makes ("Chars
 * appear one by one" against "Instant … appear"), which lives in the catalog and
 * in nothing the evaluator returns. What IS derived, and asserted in
 * `vectortype-stagger-presets.unit.spec.ts`, is the surrounding measurement:
 * the full set of presets that are constant at `stagger = 0` is pinned, so a new
 * step preset cannot join the catalog without someone deciding whether it
 * belongs here.
 *
 * Consumers that supply their own per-unit clock instead of the engine's — Vector
 * Type drives `evaluateAnimation` at a per-glyph time with `spec.stagger` forced
 * to 0 — must read this and make sure THEIR stagger is non-zero, or offer the
 * preset knowing it will be inert. The Compositor needs nothing: the engine's own
 * `stagger` defaults to 0.04 there.
 */
export const STAGGER_DEPENDENT_IDS: ReadonlySet<string> = Object.freeze(
  new Set(['typewriter', 'typewriter-out']),
) as ReadonlySet<string>

/** True when a preset can only express itself through a non-zero per-unit
 *  stagger (see `STAGGER_DEPENDENT_IDS`). Tolerant of any input: it is called
 *  against ids straight out of stored JSON. */
export function presetNeedsStagger(presetId: unknown): boolean {
  return typeof presetId === 'string' && STAGGER_DEPENDENT_IDS.has(presetId.trim())
}

// ── Preset capabilities ─────────────────────────────────────────────────────
// One engine, several consumers, each able to render a different subset of
// UnitState. A preset that emits an OPTIONAL field its consumer ignores does
// not error — it silently does nothing it is named for (picking "Blur In" on a
// Compositor layer used to give a plain fade). So the catalog says what each
// preset REQUIRES, and each consumer says what it supports.
//
// The requirement list is DERIVED, not hand-written: every preset function is
// probed across its whole range at module load and we record which optional
// fields ever come back set. Adding a preset that emits `blur` therefore gates
// itself — there is no second list to keep in sync.

/** An optional UnitState field a consumer must implement to render a preset
 *  faithfully. Core fields (dx/dy/scale/rotation/opacity/clip) are assumed of
 *  every consumer and are not capabilities. */
export type PresetCapability = 'blur' | 'axes' | 'copies'

/** The probe set IS the capability list — add a row and it flows everywhere. */
const CAPABILITY_PROBES: ReadonlyArray<{ cap: PresetCapability; emits: (s: UnitState) => boolean }> = [
  // 0 blur is "sharp", i.e. indistinguishable from not emitting blur at all, so
  // a preset whose blur is 0 across its range needs nothing from the consumer.
  { cap: 'blur', emits: s => typeof s.blur === 'number' && s.blur !== 0 },
  { cap: 'axes', emits: s => !!s.axes && Object.keys(s.axes).length > 0 },
  // `copies` was originally filed under "core, assumed of every consumer", and
  // that was wrong twice over: per-char text animation cannot draw whole-unit
  // copies (the picker already hid these four by hand for text layers) and
  // neither can Vector Type, whose `VtGlyphMotion` has no such field. A private
  // list in one component is exactly the second source of truth this probe set
  // exists to avoid, so the requirement is derived here like the others and the
  // consumers declare.
  { cap: 'copies', emits: s => Array.isArray(s.copies) && s.copies.length > 0 },
]

/** Every capability the engine currently knows about — what a fully-featured
 *  consumer (Vector Type) passes. Derived from the probes, never re-typed. */
export const ALL_PRESET_CAPABILITIES: readonly PresetCapability[] =
  Object.freeze(CAPABILITY_PROBES.map(p => p.cap))

/** Probe one preset fn over e/phase 0→1 (inclusive, both endpoints) for a few
 *  unit indices, with the preset's own default params. Presets are pure and
 *  cheap, so this is ~2k calls once at module load. */
function deriveCapabilities(fn: UnitEval, presetId: string): PresetCapability[] {
  const params = PRESET_PARAM_DEFAULTS[presetId] ?? {}
  const found = new Set<PresetCapability>()
  const STEPS = 40
  for (const n of [1, 3]) {
    for (let i = 0; i < n; i++) {
      for (let k = 0; k <= STEPS; k++) {
        const s = fn(k / STEPS, i, n, params)
        for (const probe of CAPABILITY_PROBES) if (probe.emits(s)) found.add(probe.cap)
      }
    }
  }
  return CAPABILITY_PROBES.filter(p => found.has(p.cap)).map(p => p.cap)   // stable order
}

function collectCapabilities(): Record<string, readonly PresetCapability[]> {
  const out: Record<string, PresetCapability[]> = {}
  const add = (id: string, caps: PresetCapability[]) => {
    const prev = out[id] ?? []
    out[id] = [...new Set([...prev, ...caps])]   // union: same id in two tables
  }
  for (const [id, e] of Object.entries(IN_EVAL)) add(id, deriveCapabilities(e.fn, id))
  for (const [id, e] of Object.entries(OUT_EVAL)) add(id, deriveCapabilities(e.fn, id))
  for (const [id, fn] of Object.entries(LOOP_EVAL)) add(id, deriveCapabilities(fn, id))
  return Object.freeze(out)
}

/** presetId → the capabilities its output requires of a consumer. Derived. */
export const PRESET_CAPABILITIES: Readonly<Record<string, readonly PresetCapability[]>> = collectCapabilities()

/** The ids in a slot's table that a consumer supporting `caps` can render
 *  faithfully.
 *
 *  The default is the CONSERVATIVE set — a consumer that declares nothing gets
 *  only presets that need nothing. Defaulting to "supports everything" is what
 *  produced the original bug, and it fails silently; defaulting to nothing
 *  fails visibly (a missing tile) and is trivially fixed by declaring. */
export function presetIdsFor(
  slot: 'in' | 'out' | 'loop',
  caps: readonly PresetCapability[] = [],
): string[] {
  const have = new Set(caps)
  const ids = slot === 'in' ? SUPPORTED_IN_IDS : slot === 'out' ? SUPPORTED_OUT_IDS : SUPPORTED_LOOP_IDS
  return ids.filter(id => (PRESET_CAPABILITIES[id] ?? []).every(c => have.has(c)))
}

// ── Stagger window: unit i animates inside [i·stagger, i·stagger + unitDur] ──
const MIN_UNIT_DUR = 0.05

/** Stagger compressed so every unit completes within the phase duration:
 *  the last unit's window must start no later than duration - MIN_UNIT_DUR. */
function effectiveStagger(spec: LayerAnimSpec, n: number): number {
  const raw = Math.max(0, spec.stagger ?? 0.04)          // negative stagger unsupported (M2)
  if (n <= 1) return 0
  return Math.min(raw, Math.max(0, spec.duration - MIN_UNIT_DUR) / (n - 1))
}

function unitProgress(tPhase: number, spec: LayerAnimSpec, i: number, n: number): number {
  const stagger = effectiveStagger(spec, n)
  const span = (n - 1) * stagger
  const unitDur = Math.max(MIN_UNIT_DUR, spec.duration - span)
  const start = i * stagger
  return Math.max(0, Math.min(1, (tPhase - start) / unitDur))
}

function evalSpecUnits(
  spec: LayerAnimSpec,
  tPhase: number,
  n: number,
  table: Record<string, { fn: UnitEval; ease: string }>,
  fallback: { fn: UnitEval; ease: string },
): UnitState[] {
  const entry = table[spec.presetId] ?? fallback
  const ease = resolveEase(spec.ease ?? entry.ease)
  const params = resolveParams(spec)
  return Array.from({ length: n }, (_, i) => entry.fn(ease(unitProgress(tPhase, spec, i, n)), i, n, params))
}

export function evaluateKeyframes(kfs: LayerKeyframe[], t: number): UnitState {
  if (!kfs.length) return IDENTITY_UNIT
  const sorted = [...kfs].sort((a, b) => a.t - b.t)
  const fill = (k: LayerKeyframe): Required<Omit<LayerKeyframe, 'ease'>> => ({
    t: k.t, dx: k.dx ?? 0, dy: k.dy ?? 0, scale: k.scale ?? 1,
    rotation: k.rotation ?? 0, opacity: k.opacity ?? 1,
  })
  if (t <= sorted[0].t) { const k = fill(sorted[0]); return u({ dx: k.dx, dy: k.dy, scale: k.scale, rotation: k.rotation, opacity: k.opacity }) }
  const last = sorted[sorted.length - 1]
  if (t >= last.t) { const k = fill(last); return u({ dx: k.dx, dy: k.dy, scale: k.scale, rotation: k.rotation, opacity: k.opacity }) }
  let lo = sorted[0], hi = sorted[1]
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].t >= t) { lo = sorted[i - 1]; hi = sorted[i]; break }
  }
  const a = fill(lo), b = fill(hi)
  const span = Math.max(1e-6, b.t - a.t)
  const easeFn = (lo.ease ?? 'easeInOut') === 'linear' ? linear : easeInOutQuad
  const p = easeFn((t - a.t) / span)
  const lerp = (x: number, y: number) => x + (y - x) * p
  return u({
    dx: lerp(a.dx, b.dx), dy: lerp(a.dy, b.dy), scale: lerp(a.scale, b.scale),
    rotation: lerp(a.rotation, b.rotation), opacity: lerp(a.opacity, b.opacity),
  })
}

/**
 * Evaluate a layer's animation at absolute frame-time `t` (seconds).
 * `n` = number of animatable units (char count for text; 1 otherwise).
 */
export function evaluateAnimation(
  anim: LayerAnimation,
  t: number,
  motion: FrameMotion,
  n: number,
): LayerMotionState {
  const { start, end } = layerWindow(anim, motion)
  if (t < start || t >= end) return HIDDEN
  const tIn = t - start
  const layer = anim.keyframes?.length ? evaluateKeyframes(anim.keyframes, tIn) : IDENTITY_UNIT

  const W = end - start
  const inDur = anim.in ? Math.max(0.01, anim.in.duration) : 0
  const outDur = anim.out ? Math.max(0.01, anim.out.duration) : 0
  // Out is anchored to the window end but never overlaps in: when the two
  // would collide, out starts where in ends and compresses into what's left.
  const outStart = Math.max(inDur, W - outDur)

  let units: UnitState[] | undefined
  if (anim.in && tIn < inDur) {
    units = evalSpecUnits(anim.in, tIn, n, IN_EVAL, IN_EVAL['fade-in'])
  } else if (anim.out && tIn >= outStart && W > inDur) {
    const effOut = { ...anim.out, duration: Math.max(0.01, W - outStart) }
    units = evalSpecUnits(effOut, tIn - outStart, n, OUT_EVAL, OUT_EVAL['fade-out'])
  } else if (anim.loop) {
    const cycle = Math.max(0.1, anim.loop.duration)
    const stagger = Math.max(0, anim.loop.stagger ?? 0.04)
    const loopFn = LOOP_EVAL[anim.loop.presetId]
    if (loopFn) {
      const params = resolveParams(anim.loop)
      const loopT = tIn - inDur   // phase 0 at loop start ⇒ seamless in→loop handoff
      units = Array.from({ length: n }, (_, i) => {
        const phase = (((loopT - i * stagger) / cycle) % 1 + 1) % 1
        return loopFn(phase, i, n, params)
      })
    }
  }
  if (!units) units = Array.from({ length: n }, () => IDENTITY_UNIT)
  return { visible: true, layer, units }
}
