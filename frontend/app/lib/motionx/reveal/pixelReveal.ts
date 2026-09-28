// Pixel reveal (Addendum — see docs/superpowers/plans/2026-09-28-frame-pixel-reveal.md): the
// layer arrives as coarse, hot blocks that halve toward sharp pixels as a front sweeps across
// it. Nine gallery looks (Materialize, Signal, Typewriter, Dissolve, Rain, Radiate, Bitmap,
// Glitch, Flow) each pin a full set of the prototype's dials; a bar overrides only a handful of
// them (`pieces`, `pattern`, `direction`, `pixel`, `levels`, `spread`, `heat`). This file is the
// maths only — no Vue, no DOM, no WebGL: the vocabulary, the ONE reader, the grid-size and
// piece-order pickers, the scaled timeline, and CPU mirrors of the shader's when-field and level
// thresholds (used by the tile preview and by this file's own tests). Same discipline as
// `settle.ts` / `params.ts`, which is why it lives beside them. Every number here is pinned
// against the approved prototype, `docs/superpowers/specs/assets/2026-09-28-pixel-reveal-prototype.html`.

/** A piece's shape: `words`/`letters`/`lines` split text into its own cells (grouped by
 *  `groupCells` downstream); `whole` is one piece for the entire layer — the only option for a
 *  non-text layer. Stored/API name; the prototype's own field is `split` ('words'|'chars'|
 *  'lines'|'none') and lives only inside a look's `settings`. */
export type PixelRevealPieces = 'words' | 'letters' | 'lines' | 'whole'

/** The prototype's internal split vocabulary, kept as `PixelRevealSettings.split` so a look's
 *  settings read exactly like the prototype's `DEFAULTS`/`PRESETS`. */
export type PixelRevealSplit = 'words' | 'chars' | 'lines' | 'none'

export type PixelRevealSweep = 'each' | 'whole'
export type PixelRevealFrom = 'start' | 'end' | 'center' | 'edges' | 'random'
export type PixelRevealEase = 'none' | 'power1.inOut' | 'power1.out' | 'power2.out' | 'sine.inOut' | 'expo.out'
export type PixelRevealPattern = 'random' | 'clusters' | 'scanlines' | 'rain' | 'typewriter' | 'zigzag' | 'cascade' | 'bayer' | 'flow' | 'none'
export type PixelRevealDirection = 'up' | 'down' | 'left' | 'right' | 'center' | 'edges' | 'diagonal' | 'none'

/** The colour(s) a fresh block glows before it cools into the layer's own ink. `colours: null` =
 *  no heat at all (Dissolve, Bitmap); one colour = every fresh block glows the same; two colours
 *  (Glitch) blend per-block by `mix` (the shader's `uHotMix`, a per-block coin flip). */
export interface PixelRevealHeat {
  colours: [string] | [string, string] | null
  mix: number
}

/** A look's full dial set, in the prototype's own units — everything `DEFAULTS`/a `PRESETS` row
 *  can hold, minus `accent`/`accent2`/`accentMix` (folded into `heat`). `pixel` is frame px at
 *  1080 px wide (decision 6); the device-px conversion happens at paint time, not here. */
export interface PixelRevealSettings {
  split: PixelRevealSplit
  sweep: PixelRevealSweep
  from: PixelRevealFrom
  stagger: number
  duration: number
  ease: PixelRevealEase
  revealDelay: number
  rise: number
  riseDuration: number
  riseEase: PixelRevealEase
  direction: PixelRevealDirection
  pattern: PixelRevealPattern
  noise: number
  scatter: number
  spread: number
  pixel: number
  levels: number
  solid: number
  heat: PixelRevealHeat
  accentStrength: number
  accentWidth: number
  colorNoise: number
  sparkle: number
  flicker: number
  glitch: number
}

export interface PixelRevealLook {
  id: string
  label: string
  blurb: string
  settings: PixelRevealSettings
}

/** Sentence-case labels only (Julien's UI-copy rule) — verbatim from the prototype's
 *  `PATTERN_LABELS`. `value` is the prototype's own pattern id, used as the stored/resolved
 *  `pattern` string. */
export const PIXEL_REVEAL_PATTERNS: readonly { value: PixelRevealPattern; label: string }[] = [
  { value: 'random', label: 'Random' },
  { value: 'clusters', label: 'Clusters' },
  { value: 'scanlines', label: 'Scanlines' },
  { value: 'rain', label: 'Rain' },
  { value: 'typewriter', label: 'Typewriter' },
  { value: 'zigzag', label: 'Zigzag' },
  { value: 'cascade', label: 'Cascade' },
  { value: 'bayer', label: 'Ordered dither' },
  { value: 'flow', label: 'Flow' },
  { value: 'none', label: 'None' },
]

/** Verbatim from the prototype's `DIR_LABELS`. */
export const PIXEL_REVEAL_DIRECTIONS: readonly { value: PixelRevealDirection; label: string }[] = [
  { value: 'up', label: 'Up' },
  { value: 'down', label: 'Down' },
  { value: 'left', label: 'Left' },
  { value: 'right', label: 'Right' },
  { value: 'center', label: 'Centre out' },
  { value: 'edges', label: 'Edges in' },
  { value: 'diagonal', label: 'Diagonal' },
  { value: 'none', label: 'None' },
]

const ULTRAMARINE = '#1700c7'

/** `DEFAULTS` from the prototype, minus the three accent fields (folded into each look's
 *  `heat` below). Every look starts here and overrides only what its `PRESETS` row overrides —
 *  exactly the prototype's `opts()` merge (`{ ...DEFAULTS, ...preset, ...over }`, `over` being
 *  what a bar stores, handled by `pixelRevealParams`). */
const BASE: Omit<PixelRevealSettings, 'heat'> = {
  split: 'words', sweep: 'each', from: 'start', stagger: 0.06, duration: 1.5, ease: 'power1.inOut',
  revealDelay: 0.05, rise: 0.45, riseDuration: 1.1, riseEase: 'expo.out', direction: 'up',
  pattern: 'clusters', noise: 0.5, scatter: 0.08, spread: 0.8, pixel: 24, levels: 3, solid: 0.9,
  accentStrength: 1, accentWidth: 0.45, colorNoise: 0.03, sparkle: 0.03, flicker: 0.08, glitch: 0,
}

const heat = (colours: [string] | [string, string] | null, mix = 0.35): PixelRevealHeat => ({ colours, mix })

const settings = (over: Partial<Omit<PixelRevealSettings, 'heat'>>, look: PixelRevealHeat): PixelRevealSettings =>
  ({ ...BASE, ...over, heat: look })

/** The 9 gallery looks, in the prototype's `PRESETS` order. Each `settings` object is the
 *  prototype's `DEFAULTS` merged with that preset's row — pinned numbers, not re-derived. */
export const PIXEL_REVEAL_LOOKS: readonly PixelRevealLook[] = [
  {
    id: 'materialize', label: 'Materialize',
    blurb: 'Words lift out of their line as hot, coarse blocks, then cool into sharp type.',
    settings: settings({}, heat([ULTRAMARINE])),
  },
  {
    id: 'signal', label: 'Signal',
    blurb: 'Scanlines tear and flicker into focus, left to right.',
    settings: settings({
      rise: 0, stagger: 0.07, duration: 1.25, ease: 'power2.out', direction: 'right',
      pattern: 'scanlines', noise: 0.6, scatter: 0.04, spread: 0.5, pixel: 16, levels: 3,
      solid: 0.9, accentWidth: 0.6, colorNoise: 0.04, sparkle: 0.18, flicker: 0.3, glitch: 0.35,
    }, heat([ULTRAMARINE])),
  },
  {
    id: 'typewriter', label: 'Typewriter',
    blurb: 'Letters print one after another, a hot block at the cursor.',
    settings: settings({
      split: 'chars', stagger: 0.024, duration: 0.45, ease: 'power1.out', revealDelay: 0, rise: 0,
      direction: 'right', pattern: 'none', spread: 0.35, pixel: 12, levels: 2, solid: 1,
      accentWidth: 0.7, sparkle: 0, flicker: 0.2,
    }, heat([ULTRAMARINE])),
  },
  {
    id: 'dissolve', label: 'Dissolve',
    blurb: 'A quiet grey mosaic that resolves. No colour, no motion.',
    settings: settings({
      split: 'lines', sweep: 'whole', duration: 1.8, ease: 'sine.inOut', rise: 0, direction: 'none',
      pattern: 'random', spread: 0.6, pixel: 12, levels: 2, solid: 0, colorNoise: 0, sparkle: 0, flicker: 0,
    }, heat(null, 0)),
  },
  {
    id: 'rain', label: 'Rain',
    blurb: 'Letters drop in, in random order, while columns of blocks rain down.',
    settings: settings({
      split: 'chars', from: 'random', stagger: 0.018, duration: 0.95, rise: -0.6, riseDuration: 1.1,
      direction: 'down', pattern: 'rain', noise: 0.55, spread: 0.5, pixel: 16, levels: 3, sparkle: 0.2,
    }, heat([ULTRAMARINE])),
  },
  {
    id: 'radiate', label: 'Radiate',
    blurb: 'One dithered front blooms out from the centre.',
    settings: settings({
      split: 'lines', sweep: 'whole', duration: 2.2, ease: 'sine.inOut', rise: 0, direction: 'center',
      pattern: 'bayer', noise: 0.35, spread: 0.4, pixel: 32, levels: 4, solid: 0.85, accentWidth: 0.5,
    }, heat([ULTRAMARINE])),
  },
  {
    id: 'bitmap', label: 'Bitmap',
    blurb: 'Ordered dither and hard blocks, one bit per pixel.',
    settings: settings({
      split: 'lines', sweep: 'whole', stagger: 0.1, duration: 1.6, ease: 'power1.out', rise: 0.35,
      riseDuration: 1.4, direction: 'up', pattern: 'bayer', noise: 0.5, spread: 0.35, pixel: 8,
      levels: 2, solid: 1, colorNoise: 0, sparkle: 0, flicker: 0,
    }, heat(null, 0)),
  },
  {
    id: 'glitch', label: 'Glitch',
    blurb: 'Torn rows, two-tone blocks, heavy flicker.',
    settings: settings({
      rise: 0, stagger: 0.04, duration: 1, ease: 'power2.out', direction: 'none', pattern: 'scanlines',
      noise: 1, pixel: 24, levels: 3, solid: 0.9, accentWidth: 0.7, colorNoise: 0.2, sparkle: 0.25,
      flicker: 0.45, glitch: 0.85,
    }, heat(['#ff3d00', '#00d1ff'], 0.5)),
  },
  {
    id: 'flow', label: 'Flow',
    blurb: 'A liquid, warped front drifting diagonally across.',
    settings: settings({
      sweep: 'whole', duration: 2.4, ease: 'none', rise: 0.6, direction: 'diagonal', pattern: 'flow',
      noise: 0.55, spread: 0.5, pixel: 24, levels: 4,
    }, heat([ULTRAMARINE])),
  },
]

const DEFAULT_LOOK_ID = 'materialize'
const LOOK_BY_ID = new Map(PIXEL_REVEAL_LOOKS.map((l) => [l.id, l] as const))

/** An unknown or missing look id falls back to Materialize, the table's first row — same rule as
 *  `settleEffectOf` / `revealParams`'s style/look/pattern. */
export function pixelRevealLookOf(id: unknown): PixelRevealLook {
  const hit = typeof id === 'string' ? LOOK_BY_ID.get(id) : undefined
  return hit ?? LOOK_BY_ID.get(DEFAULT_LOOK_ID)!
}

const SPLIT_TO_PIECES: Record<PixelRevealSplit, PixelRevealPieces> = { words: 'words', chars: 'letters', lines: 'lines', none: 'whole' }
const PIECES_VALUES: readonly PixelRevealPieces[] = ['words', 'letters', 'lines', 'whole']
const PATTERN_VALUES = new Set(PIXEL_REVEAL_PATTERNS.map((p) => p.value))
const DIRECTION_VALUES = new Set(PIXEL_REVEAL_DIRECTIONS.map((d) => d.value))

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)
const num = (v: unknown, d: number, lo: number, hi: number) =>
  (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d)

/** A strict 6-digit hex colour, `#` + exactly 6 hex digits — the prototype's own colour literals
 *  (`#1700c7`, `#ff3d00`, `#00d1ff`) all take this shape. No 3-digit shorthand, no alpha. */
const HEX_RE = /^#[0-9a-f]{6}$/i

/** `heat` resolution (decision 2 / task-1 clarifications): absent (`undefined`) → the look's own
 *  colours; `null` → no heat; a valid hex → that colour as the FIRST colour, a two-colour look
 *  (Glitch) keeping its second; an invalid hex (wrong shape, or not a string) → the look's own
 *  colours, same "unknown enum falls back to default" rule as everywhere else in this reader. */
function resolveHeat(v: unknown, own: PixelRevealHeat): PixelRevealHeat {
  if (v === null) return { colours: null, mix: 0 }
  if (typeof v === 'string' && HEX_RE.test(v)) {
    const second = own.colours && own.colours.length > 1 ? own.colours[1] : undefined
    return { colours: second ? [v, second] : [v], mix: own.mix }
  }
  return own
}

/** The resolved shape a bar's timing/painter code reads: the look's full timing carried through
 *  untouched (`stagger`, `duration`, `ease`, …), and the six fields a bar may override
 *  (`pieces`, `pattern`, `direction`, `pixel`, `levels`, `spread`, `heat`) resolved and clamped. */
export interface PixelRevealResolvedParams extends
  Omit<PixelRevealSettings, 'split' | 'pixel' | 'levels' | 'spread' | 'direction' | 'pattern' | 'heat'> {
  look: PixelRevealLook
  out: boolean
  pieces: PixelRevealPieces
  pattern: PixelRevealPattern
  direction: PixelRevealDirection
  pixel: number
  levels: number
  spread: number
  heat: PixelRevealHeat
}

/** The ONE reader of a pixel-reveal bar's stored params (decision 1/2). Unknown enum / non-finite
 *  number → the look's own default; out-of-range number → clamped — same contract as
 *  `revealParams` / `settleParams`. */
export function pixelRevealParams(params: Record<string, unknown> | undefined): PixelRevealResolvedParams {
  const p = params ?? {}
  const look = pixelRevealLookOf(p.look)
  const s = look.settings
  const { split, pixel: _pixel, levels: _levels, spread: _spread, direction: _direction, pattern: _pattern, heat: _heat, ...timing } = s

  const pieces = (PIECES_VALUES as readonly unknown[]).includes(p.pieces) ? (p.pieces as PixelRevealPieces) : SPLIT_TO_PIECES[split]
  const pattern = typeof p.pattern === 'string' && PATTERN_VALUES.has(p.pattern as PixelRevealPattern) ? (p.pattern as PixelRevealPattern) : s.pattern
  const direction = typeof p.direction === 'string' && DIRECTION_VALUES.has(p.direction as PixelRevealDirection) ? (p.direction as PixelRevealDirection) : s.direction

  return {
    ...timing,
    look,
    out: p.dir === 'out',
    pieces,
    pattern,
    direction,
    pixel: num(p.pixel, s.pixel, 4, 64),
    levels: Math.round(num(p.levels, s.levels, 0, 5)),
    spread: num(p.spread, s.spread, 0.05, 1),
    heat: resolveHeat(p.heat, s.heat),
  }
}

/** The ids of every layer a Pixel reveal bar splits into pieces (words, letters or lines — any
 *  resolved `pieces` but `whole`). A text layer's pieces come from its glyph outlines, so these
 *  are the layers whose outline font an export must carry and a bake must have loaded before its
 *  first frame. Muted bars count too; a layer that is not text is the caller's to skip. */
export function pixelRevealSplitLayerIds(
  behaviours: ReadonlyArray<{ kind?: unknown; layerId?: unknown; params?: Record<string, unknown> }> | null | undefined,
): Set<string> {
  const out = new Set<string>()
  for (const b of behaviours ?? []) {
    if (b?.kind !== 'pixelreveal' || typeof b.layerId !== 'string' || !b.layerId) continue
    if (pixelRevealParams(b.params).pieces !== 'whole') out.add(b.layerId)
  }
  return out
}

// ── grid size ────────────────────────────────────────────────────────────────────────────────

export interface PixelRevealGrid { s: number; m: number; k: number; levels: number }

/** The prototype's `pickGrid`: the block-size ladder is `m × 2^k` for `m ∈ {1, 3}`, `k` 0..8 — a
 *  power of two, or three times one — and it picks whichever rung sits closest to `targetDevicePx`
 *  on a log2 scale. `targetDevicePx` is already in DEVICE px (the DPR multiply happens in the
 *  painter, decision 6) — this function does no unit conversion. `levels` is capped at what the
 *  chosen block can actually halve down to before hitting a single device pixel: `k` rungs for
 *  `m = 1`, `k + 1` for `m = 3` (its extra factor of 3 buys one more halving before `m = 1` would). */
export function pickGrid(targetDevicePx: number, levels: number): PixelRevealGrid {
  const target = Math.max(2, targetDevicePx)
  let best: { s: number; m: number; k: number; err: number } | null = null
  for (let k = 0; k <= 8; k++) {
    for (const m of [1, 3]) {
      const s = m * 2 ** k
      if (s < 2) continue
      const err = Math.abs(Math.log2(s / target))
      if (!best || err < best.err - 1e-9) best = { s, m, k, err }
    }
  }
  const b = best!
  return { s: b.s, m: b.m, k: b.k, levels: Math.min(levels, b.m === 3 ? b.k + 1 : b.k) }
}

// ── piece order ──────────────────────────────────────────────────────────────────────────────

/** A tiny seeded PRNG (mulberry32, the prototype's own `rng`) — deterministic per seed, so a
 *  `from: 'random'` look's piece order is reproducible for preview/bake/export parity. */
function mulberry32(seed: number): () => number {
  let s = seed | 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The prototype's `orderOf`: for each of `n` pieces, the RANK (0 = reveals first) it plays in,
 *  indexed by piece position — `order[i] * stagger` is piece `i`'s start time. `start` is
 *  identity; `end` reverses it; `center`/`edges` rank by distance from the middle piece (nearest
 *  first / last); `random` shuffles with a seeded PRNG (the prototype's fixed seed is 7). */
export function pieceOrder(n: number, from: PixelRevealFrom, seed = 7): number[] {
  const idx = Array.from({ length: n }, (_, i) => i)
  if (from === 'end') return idx.map((i) => n - 1 - i)
  if (from === 'center' || from === 'edges') {
    const byDist = idx.slice().sort((a, b) => Math.abs(a - (n - 1) / 2) - Math.abs(b - (n - 1) / 2))
    const rank: number[] = []
    byDist.forEach((p, r) => { rank[p] = from === 'center' ? r : n - 1 - r })
    return rank
  }
  if (from === 'random') {
    const r = mulberry32(seed)
    const shuffled = idx.slice()
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1))
      const a = shuffled[i]!
      const b = shuffled[j]!
      shuffled[i] = b
      shuffled[j] = a
    }
    const rank: number[] = []
    shuffled.forEach((p, k) => { rank[p] = k })
    return rank
  }
  return idx // 'start'
}

// ── timeline ─────────────────────────────────────────────────────────────────────────────────

/** Ease functions, verbatim from the prototype's `EASE` table — the only six a look ever names. */
export const PIXEL_REVEAL_EASE: Record<PixelRevealEase, (t: number) => number> = {
  none: (t) => t,
  'power1.inOut': (t) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)),
  'power1.out': (t) => 1 - (1 - t) * (1 - t),
  'power2.out': (t) => 1 - (1 - t) ** 3,
  'sine.inOut': (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  'expo.out': (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)),
}

/** The prototype's `timeline().total`, generalised to any resolved params and piece count
 *  (decision 3): how long, in seconds, this look's own choreography takes to finish for `n`
 *  pieces before a bar's duration scales it. A bar's local time is `amount × lookTotal(p, n)`. */
export function lookTotal(p: PixelRevealSettings, n: number): number {
  const whole = p.sweep === 'whole'
  const last = (Math.max(n, 1) - 1) * p.stagger
  const total = whole
    ? Math.max(p.duration, last + (p.rise ? p.riseDuration : 0))
    : last + Math.max(p.rise ? p.riseDuration : 0, p.revealDelay + p.duration)
  return Math.max(total, 0.05)
}

export interface PixelRevealPieceState {
  /** 0 → 1, this piece's own reveal progress (eased) at this amount — the value the painter
   *  passes as `uProgress`. For `sweep: 'whole'` every piece shares the same value. */
  progress: number
  /** 1 → 0, how much of the piece's rise offset remains: 1 = still fully offset below its rest
   *  position, 0 = at rest. The painter multiplies this by `rise × lineHeight` to get the pixel
   *  offset (decision 3) — that multiply needs the piece's own line height, which this file does
   *  not know. */
  riseFrac: number
}

/** Per-piece reveal state at a bar's `amount` (0..1), decision 3: local time is
 *  `amount × lookTotal(p, n)`; each piece starts at `pieceOrder(n, p.from)[i] * p.stagger` into
 *  that local time. `sweep: 'whole'` shares one progress across every piece (still computed over
 *  `p.duration`, not the scaled total) while rises keep staggering — exactly the prototype's
 *  `draw()`, which computes `wholeP` once and `rise` per piece regardless of `tl.whole`. */
export function pieceStates(p: PixelRevealSettings, n: number, amount: number): PixelRevealPieceState[] {
  const count = Math.max(n, 1)
  const total = lookTotal(p, count)
  const t = clamp01(amount) * total
  const order = pieceOrder(count, p.from)
  const whole = p.sweep === 'whole'
  const ease = PIXEL_REVEAL_EASE[p.ease]
  const riseEase = PIXEL_REVEAL_EASE[p.riseEase]
  const wholeProgress = ease(clamp01(t / p.duration))

  const states: PixelRevealPieceState[] = []
  for (let i = 0; i < n; i++) {
    const start = (order[i] ?? i) * p.stagger
    const progress = whole ? wholeProgress : ease(clamp01((t - start - p.revealDelay) / p.duration))
    const rt = p.rise ? clamp01((t - start) / p.riseDuration) : 1
    const riseFrac = 1 - riseEase(rt)
    states.push({ progress, riseFrac })
  }
  return states
}

// ── CPU mirrors of the shader's when-field / level thresholds ──────────────────────────────────
// Used by the tile preview (Task 4) and by this file's own tests. The GPU shader's hash (`rnd` /
// `scramble`) is ported as closely as a JS `Uint32`-ish hash reasonably can be — these mirrors are
// NOT expected to match the shader's exact bytes, only its shape: 0..1 range, determinism, and
// monotonicity in the inputs that matter (see the prototype's `when()`/level loop in its FS).

function scramble(x: number): number {
  x = (x ^ (x >>> 16)) >>> 0
  x = Math.imul(x, 0x7feb352d) >>> 0
  x = (x ^ (x >>> 15)) >>> 0
  x = Math.imul(x, 0x846ca68b) >>> 0
  x = (x ^ (x >>> 16)) >>> 0
  return x >>> 0
}

/** The shader's `rnd(cell, salt)`: a deterministic 0..1 hash of an integer cell coordinate plus a
 *  salt, ported from its `scramble`-based mix (own hash bytes, same idea). */
function hashRnd(cx: number, cy: number, salt: number): number {
  const ix = (Math.floor(cx) + 100000) >>> 0
  const iy = (Math.floor(cy) + 100000) >>> 0
  const s = scramble((Math.floor(salt * 131) + 977) >>> 0)
  const h = (Math.imul(ix, 1664525) ^ scramble((iy + s) >>> 0)) >>> 0
  return h / 4294967295
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const smoothstep = (lo: number, hi: number, x: number) => {
  const t = clamp01((x - lo) / Math.max(hi - lo, 1e-9))
  return t * t * (3 - 2 * t)
}

/** The shader's `smoothNoise`: bilinear-interpolated value noise over `hashRnd`'s lattice. */
function smoothNoise(px: number, py: number, salt: number): number {
  const ix = Math.floor(px)
  const iy = Math.floor(py)
  let fx = px - ix
  let fy = py - iy
  fx = fx * fx * (3 - 2 * fx)
  fy = fy * fy * (3 - 2 * fy)
  const a = hashRnd(ix, iy, salt)
  const b = hashRnd(ix + 1, iy, salt)
  const c = hashRnd(ix, iy + 1, salt)
  const d = hashRnd(ix + 1, iy + 1, salt)
  return lerp(lerp(a, b, fx), lerp(c, d, fx), fy)
}

/** The shader's `ordered()`: an 8×8 Bayer ordered-dither threshold for a cell coordinate. */
function ordered(cx: number, cy: number): number {
  const px = ((Math.floor(cx) % 8) + 8) % 8
  const py = ((Math.floor(cy) % 8) + 8) % 8
  let v = 0
  for (let b = 0; b < 3; b++) {
    const xb = (px >> b) & 1
    const yb = (py >> b) & 1
    v |= ((xb ^ yb) << (5 - 2 * b)) | (yb << (4 - 2 * b))
  }
  return (v + 0.5) / 64
}

function sweepValue(direction: PixelRevealDirection, nx: number, ny: number, w: number, h: number): number {
  switch (direction) {
    case 'up': return 1 - ny
    case 'down': return ny
    case 'left': return 1 - nx
    case 'right': return nx
    case 'center':
    case 'edges': {
      const size = Math.max(0.5 * Math.hypot(w, h), 1)
      const r = Math.hypot((nx - 0.5) * w, (ny - 0.5) * h) / size
      return direction === 'center' ? r : 1 - r
    }
    case 'diagonal': return 0.5 * (nx + 1 - ny)
    default: return 0.5 // 'none'
  }
}

export interface PixelRevealWhenLine { idx: number; lines: number; x0: number; w: number; whole: boolean }

export interface PixelRevealWhenOpts {
  /** Cell centre, in the same local px space as `rect`. */
  at: { x: number; y: number }
  /** The piece's box, local px — the `when()` field is normalised against this. */
  rect: { x: number; y: number; w: number; h: number }
  pattern: PixelRevealPattern
  direction: PixelRevealDirection
  noise: number
  scatter: number
  /** Only read by the `typewriter` pattern; every other pattern ignores it. */
  line?: PixelRevealWhenLine
}

function textureValue(cell: { x: number; y: number }, opts: PixelRevealWhenOpts, n: { x: number; y: number }): number {
  const { pattern, at, rect, line } = opts
  switch (pattern) {
    case 'random': return hashRnd(cell.x, cell.y, 1)
    case 'clusters': {
      const a = smoothNoise(cell.x * 0.34, cell.y * 0.34, 2)
      const b = smoothNoise(cell.x * 0.83 + 7, cell.y * 0.83 + 7, 3)
      return smoothstep(0.2, 0.8, 0.65 * a + 0.35 * b)
    }
    case 'scanlines': return 0.84 * hashRnd(0, cell.y, 4) + 0.16 * hashRnd(cell.x, cell.y, 5)
    case 'rain': return 0.84 * hashRnd(cell.x, 0, 6) + 0.16 * hashRnd(cell.x, cell.y, 7)
    case 'typewriter': {
      if (line?.whole) return (line.idx + clamp01((at.x - line.x0) / Math.max(line.w, 1))) / Math.max(line.lines, 1)
      return n.x
    }
    case 'zigzag': {
      // The prototype indexes this pattern by grid ROW (cell.y is already in grid units here);
      // without the piece's own row count we treat every row as its own band, alternating sweep.
      const row = cell.y
      return (Math.abs(row) % 2 < 1 ? n.x : 1 - n.x)
    }
    case 'cascade': return ((cell.x + cell.y) * 0.2) % 1
    case 'bayer': return ordered(cell.x, cell.y)
    case 'flow': {
      const p = { x: cell.x * 0.16, y: cell.y * 0.16 }
      const wx = smoothNoise(p.x + 3.7, p.y + 3.7, 8)
      const wy = smoothNoise(p.x + 11.3, p.y + 11.3, 9)
      const a = smoothNoise(p.x * 1.3 + wx * 2.4, p.y * 1.3 + wy * 2.4, 10)
      const b = smoothNoise(p.x * 2.7 + wx, p.y * 2.7 + wy, 11)
      return smoothstep(0.22, 0.78, 0.7 * a + 0.3 * b)
    }
    default: return 0.5 // 'none' — never reached: uPat === 9 short-circuits to sweep() in the shader
  }
}

/** CPU mirror of the fragment shader's `when(cell, at)`: 0 = first cell to reveal, 1 = last,
 *  before per-piece progress/spread turns it into a life. `direction: 'none'` (the shader's
 *  `uDir == 7`) hands the whole field to the pattern texture; `pattern: 'none'` hands it to the
 *  directional sweep; otherwise the two blend by `noise`. A small per-cell jitter (`scatter`)
 *  is added last, same as the shader's `rnd(cell, 12.0)` term. Hash bytes differ from the GPU's
 *  (documented at the top of this section) — callers should only rely on range and monotonicity. */
export function revealWhen(cell: { x: number; y: number }, opts: PixelRevealWhenOpts): number {
  const { at, rect, direction, noise, scatter } = opts
  const nx = clamp01((at.x - rect.x) / Math.max(rect.w, 1))
  const ny = clamp01((at.y - rect.y) / Math.max(rect.h, 1))
  const n = { x: nx, y: ny }
  let f: number
  if (direction === 'none') f = textureValue(cell, opts, n)
  else if (opts.pattern === 'none') f = sweepValue(direction, nx, ny, rect.w, rect.h)
  else f = lerp(sweepValue(direction, nx, ny, rect.w, rect.h), textureValue(cell, opts, n), noise)
  return clamp01(f + (hashRnd(cell.x, cell.y, 12) - 0.5) * scatter)
}

/** CPU mirror of the fragment shader's per-block level loop: how many times (0..`levels`) the
 *  block at `blk` has halved by the time its local `life` (0..1, i.e. `when()` already turned
 *  into a life via progress/spread) reaches it. Each level's threshold is jittered per block —
 *  `blk` is a fixed grid coordinate here (this mirror does not recompute a finer `blk` at each
 *  halving, unlike the shader's `T`-driven loop; tests pin monotonicity/range, not exact levels
 *  — see the section banner above). */
export function levelAt(life: number, blk: { x: number; y: number }, levels: number): number {
  let lvl = 0
  for (let L = 1; L <= 6; L++) {
    if (L > levels) break
    const th = lerp(0.12, 0.84, (L - 0.5 + (hashRnd(blk.x, blk.y, 20 + L) - 0.5) * 0.9) / levels)
    if (life < th) break
    lvl = L
  }
  return lvl
}
