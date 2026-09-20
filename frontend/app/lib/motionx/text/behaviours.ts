// Registers the letter behaviour kinds. One small definition per kind — the shared timing
// (stagger, order, seed, easing, entrance/exit clamping) lives in evaluate.ts; this file only
// says what EACH kind does to one piece at progress `e`, what it does to one GLYPH (a
// substitute character, a reel), and (typewriter) where the cursor sits.
import { applyEase, type Ease } from '~/lib/motionx'
import { hash01 } from './rng'
import { REST, HIDDEN, registerTextBehaviour, oneOf, type CursorDraw, type PieceCtx } from './evaluate'
import { framePool, pickFrom, TEXT_CHARSETS } from './charsets'
import type { Piece } from './units'

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n)
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)

const CASCADE_DIRS = ['in', 'out'] as const
const CASCADE_STYLES = ['fade', 'rise', 'drop', 'grow', 'spin'] as const
const MASK_DIRS = ['reveal', 'hide'] as const
const MASK_FROM = ['up', 'down', 'left', 'right'] as const
const TYPE_DIRS = ['type', 'delete'] as const
const CURSOR_STYLES = ['bar', 'underscore', 'none'] as const
const SCRAMBLE_MODES = ['settle', 'scatter', 'loop'] as const
const SCRAMBLE_MOVES = ['snap', 'glide'] as const
const DECODE_DIRS = ['resolve', 'dissolve'] as const
const SLOT_DIRS = ['in', 'out'] as const
const SLOT_ROLLS = ['up', 'down'] as const
// A reel can also roll its OWN letter past — `same` — which no other substituting behaviour
// wants (a Decode that flickers a letter into itself is no Decode), so it lives here and not
// in the shared charsets.
const SLOT_FILLERS = ['same', ...TEXT_CHARSETS] as const

// ---------------------------------------------------------------------------
// Cascade — fade / rise / drop / grow / spin, in or out.
// ---------------------------------------------------------------------------
registerTextBehaviour('text.cascade', {
  phase: (params) => (oneOf(params.dir, CASCADE_DIRS, 'in') === 'out' ? 'out' : 'in'),
  springTail: true,      // interpolates towards rest — a spring may overshoot and settle
  piece: (c) => {
    const dir = oneOf(c.params.dir, CASCADE_DIRS, 'in')
    const style = oneOf(c.params.style, CASCADE_STYLES, 'rise')
    // k = how far from rest, 1 → 0 on the way in (mirrored on the way out). A spring entrance
    // can push e past 1, so k can go negative — that is the overshoot past rest.
    const k = dir === 'out' ? c.e : 1 - c.e
    switch (style) {
      case 'fade':
        return { dx: 0, dy: 0, frame: 'piece', rotation: 0, scale: 1, opacity: clamp01(1 - k) }
      case 'rise': {
        const amount = num(c.params.amount, 0.6)
        return { dx: 0, dy: k * amount * c.piece.h, frame: 'piece', rotation: 0, scale: 1, opacity: clamp01(1 - k) }
      }
      case 'drop': {
        const amount = num(c.params.amount, 0.6)
        return { dx: 0, dy: -k * amount * c.piece.h, frame: 'piece', rotation: 0, scale: 1, opacity: clamp01(1 - k) }
      }
      case 'grow': {
        const amount = num(c.params.amount, 0)
        const scale = amount + (1 - amount) * (1 - k)
        return { dx: 0, dy: 0, frame: 'piece', rotation: 0, scale: Math.max(0.001, scale), opacity: clamp01((1 - k) * 2) }
      }
      case 'spin': {
        const amount = num(c.params.amount, 90)
        return { dx: 0, dy: 0, frame: 'piece', rotation: (-k * amount * Math.PI) / 180, scale: 1, opacity: clamp01(1 - k) }
      }
      default:
        return REST
    }
  },
})

// ---------------------------------------------------------------------------
// Mask slide — the piece travels in from (or out to) one side, clipped to its own resting box.
// ---------------------------------------------------------------------------
registerTextBehaviour('text.maskSlide', {
  phase: (params) => (oneOf(params.dir, MASK_DIRS, 'reveal') === 'hide' ? 'out' : 'in'),
  springTail: true,      // travels towards rest behind its window — same overshoot
  piece: (c) => {
    const dir = oneOf(c.params.dir, MASK_DIRS, 'reveal')
    const from = oneOf(c.params.from, MASK_FROM, 'up')
    const k = dir === 'hide' ? c.e : 1 - c.e
    let dx = 0, dy = 0
    if (from === 'up') dy = k * c.piece.h
    else if (from === 'down') dy = -k * c.piece.h
    else if (from === 'left') dx = k * c.piece.w
    else if (from === 'right') dx = -k * c.piece.w
    return { dx, dy, frame: 'piece', rotation: 0, scale: 1, opacity: 1, clip: true }
  },
})

// ---------------------------------------------------------------------------
// Typewriter — hard cut in (or against) reading order, plus a blinking cursor.
// ---------------------------------------------------------------------------
registerTextBehaviour('text.typewriter', {
  phase: (params) => (oneOf(params.dir, TYPE_DIRS, 'type') === 'delete' ? 'out' : 'in'),
  reverseOrder: (params) => oneOf(params.dir, TYPE_DIRS, 'type') === 'delete',
  // Only called while 0 < p < 1 (already past HIDDEN/REST at the edges): typing shows the
  // letter in full the instant its turn starts; deleting hides it the instant its turn starts.
  piece: (c) => (oneOf(c.params.dir, TYPE_DIRS, 'type') === 'delete' ? HIDDEN : REST),
  usesEase: () => false,        // a hard cut has no curve to run under

  cursor: ({ pieces, visible, params }) => {
    const style = oneOf(params.cursor, CURSOR_STYLES, 'bar')
    if (style === 'none') return undefined
    let lastVisible = -1
    for (let i = 0; i < visible.length; i++) if (visible[i]) lastVisible = i
    const piece: Piece | undefined = lastVisible >= 0 ? pieces[lastVisible] : pieces[0]
    if (!piece) return undefined
    // After the last visible piece's right edge in reading order; before anything is visible,
    // the first piece's left edge (the cursor waits there, ready to type).
    const sign = lastVisible >= 0 ? 1 : -1
    const cosA = Math.cos(piece.angle), sinA = Math.sin(piece.angle)
    const draw: CursorDraw = {
      x: piece.cx + sign * cosA * (piece.w / 2),
      y: piece.cy + sign * sinA * (piece.w / 2),
      h: piece.h,
      angle: piece.angle,
      style,
    }
    return draw
  },
})

// ---------------------------------------------------------------------------
// Scramble — settle (in) / scatter (out) / loop (span). Jumps to a hashed spot on an interval.
// ---------------------------------------------------------------------------
interface Spot { sx: number; sy: number; rotation: number }

function scrambleSpot(
  seed: number, pieceIndex: number, j: number, areaW: number, areaH: number, spinRad: number,
  frameW: number, frameH: number, rest: { cx: number; cy: number }, isRestSlot: boolean,
): Spot {
  if (isRestSlot) return { sx: rest.cx, sy: rest.cy, rotation: 0 }
  const sx = (hash01(seed, pieceIndex, j, 1) - 0.5) * areaW * frameW
  const sy = (hash01(seed, pieceIndex, j, 2) - 0.5) * areaH * frameH
  const rotation = (hash01(seed, pieceIndex, j, 3) - 0.5) * 2 * spinRad
  return { sx, sy, rotation }
}

registerTextBehaviour('text.scramble', {
  phase: (params) => {
    const mode = oneOf(params.mode, SCRAMBLE_MODES, 'settle')
    return mode === 'scatter' ? 'out' : mode === 'loop' ? 'span' : 'in'
  },
  // Every letter is on screen from the scramble's first frame: nothing is revealed through it.
  hidesBefore: () => false,
  // A snap CUTS between hashed spots — only a glide interpolates, and only it reads the curve.
  usesEase: (params) => oneOf(params.move, SCRAMBLE_MOVES, 'snap') === 'glide',
  // Settling is LANDING, not arriving: the whole word jumps about from the bar's first frame
  // and the stagger says only which piece stops first. Hiding each piece until its own turn
  // would materialise a long word left to right like a cascade, and would not mirror scatter
  // (where every piece is visible from the start and leaves on its own turn); with this flag
  // scatter mirrors it exactly — every piece keeps hopping until the BAR ends, then all go.
  // A loop is a span bar, which ignores this.
  wholeBar: true,
  piece: (c) => {
    const mode = oneOf(c.params.mode, SCRAMBLE_MODES, 'settle')
    const areaW = num(c.params.areaW, 0.6)
    const areaH = num(c.params.areaH, 0.6)
    const interval = Math.max(0.001, num(c.params.interval, 0.18))
    const move = oneOf(c.params.move, SCRAMBLE_MOVES, 'snap')
    const spinRad = (num(c.params.spin, 0) * Math.PI) / 180
    const ease = c.params.ease as Ease

    // settle/loop share one clock from the BAR's start; scatter uses each piece's own start.
    let elapsed: number
    let lastHopIndex = -Infinity
    if (mode === 'settle') {
      elapsed = Math.max(0, c.barElapsed)
      const landAt = c.delay + c.pieceDur
      lastHopIndex = Math.ceil(landAt / interval) - 1
    } else if (mode === 'loop') {
      elapsed = Math.max(0, c.barElapsed)
    } else {
      elapsed = Math.max(0, c.elapsed)
    }

    // settle's final hop targets REST exactly (so it lands in place); scatter/loop treat the
    // slot BEFORE the first hop (index -1) as REST, so they ease smoothly out of / into place.
    const isRestSlot = (idx: number) => (mode === 'settle' ? idx === lastHopIndex : idx === -1)
    const rest = { cx: c.piece.cx, cy: c.piece.cy }
    const spotAt = (idx: number) => scrambleSpot(c.seed, c.piece.index, idx, areaW, areaH, spinRad, c.frame.w, c.frame.h, rest, isRestSlot(idx))

    const j = Math.floor(elapsed / interval)
    let sx: number, sy: number, rotation: number
    if (move === 'glide') {
      const frac = clamp01((elapsed - j * interval) / interval)
      const eased = applyEase(frac, ease)
      const a = spotAt(j - 1), b = spotAt(j)
      sx = a.sx + (b.sx - a.sx) * eased
      sy = a.sy + (b.sy - a.sy) * eased
      rotation = a.rotation + (b.rotation - a.rotation) * eased
    } else {
      const s = spotAt(j)
      sx = s.sx; sy = s.sy; rotation = s.rotation
    }

    return { dx: sx - c.piece.cx, dy: sy - c.piece.cy, frame: 'layer', rotation, scale: 1, opacity: 1 }
  },
})

// ---------------------------------------------------------------------------
// The loops — wave / bounce / jitter. Span bars: they run for as long as the bar is long and
// leave the text exactly where they found it.
// ---------------------------------------------------------------------------
const smoothstep = (x: number) => { const c = clamp01(x); return c * c * (3 - 2 * c) }

/** 0 at both edges of the bar, 1 across the middle.
 *
 *  A loop that simply started would POP: at the bar's first frame the letters would already be
 *  a quarter of a letter-height off their place. The ramp is a quarter of the bar at each end,
 *  capped at 0.3s so a long loop does not spend ten seconds fading in. */
function loopEnvelope(barElapsed: number, barDur: number): number {
  const r = Math.min(0.3, barDur * 0.25)
  if (!(r > 0)) return 0
  return smoothstep(barElapsed / r) * smoothstep((barDur - barElapsed) / r)
}

/** Where this piece is in the cycle. One shared clock from the BAR's start (a loop has no
 *  stagger to ride — every piece is live the whole time), lagged by the piece's RANK so the
 *  wave travels along the word in the chosen order. */
const loopPhase = (c: PieceCtx, speed: number, offset: number) => c.barElapsed * speed - c.rank * offset

registerTextBehaviour('text.wave', {
  phase: () => 'span',
  usesEase: () => false,        // rides its own sine, not the curve
  piece: (c) => {
    const amount = num(c.params.amount, 0.25)
    const env = loopEnvelope(c.barElapsed, c.barDur)
    const phi = loopPhase(c, num(c.params.speed, 1), num(c.params.offset, 0.12))
    return { dx: 0, dy: -env * amount * c.piece.h * Math.sin(2 * Math.PI * phi), frame: 'piece', rotation: 0, scale: 1, opacity: 1 }
  },
})

registerTextBehaviour('text.bounce', {
  phase: () => 'span',
  usesEase: () => false,
  piece: (c) => {
    const amount = num(c.params.amount, 0.35)
    const env = loopEnvelope(c.barElapsed, c.barDur)
    const phi = loopPhase(c, num(c.params.speed, 1.4), num(c.params.offset, 0.12))
    // The ABSOLUTE half-sine: every hop goes up and comes back down to the baseline, and the
    // letter never sinks below the line it is written on.
    return { dx: 0, dy: -env * amount * c.piece.h * Math.abs(Math.sin(Math.PI * phi)), frame: 'piece', rotation: 0, scale: 1, opacity: 1 }
  },
})

/** A jitter's turn, at full envelope: ±6°. */
const JITTER_SPIN = (6 * Math.PI) / 180

registerTextBehaviour('text.jitter', {
  phase: () => 'span',
  usesEase: () => false,
  piece: (c) => {
    const amount = num(c.params.amount, 0.08)
    const speed = num(c.params.speed, 12)          // TICKS per second here, not cycles
    const env = loopEnvelope(c.barElapsed, c.barDur)
    // A shake is a CUT to a new hashed offset, held for a whole tick — interpolating between
    // them would read as a wobble, not a shake. Every piece ticks on the same clock, so
    // `offset` has nothing to lag.
    const k = Math.floor(c.barElapsed * speed)
    const reach = env * amount * c.piece.h
    return {
      dx: reach * (hash01(c.seed, c.piece.index, k, 1) - 0.5) * 2,
      dy: reach * (hash01(c.seed, c.piece.index, k, 2) - 0.5) * 2,
      frame: 'piece',
      rotation: env * (hash01(c.seed, c.piece.index, k, 3) - 0.5) * 2 * JITTER_SPIN,
      scale: 1,
      opacity: 1,
    }
  },
})

// ---------------------------------------------------------------------------
// Decode — every letter churns through random characters and locks onto the real one.
// ---------------------------------------------------------------------------
registerTextBehaviour('text.decode', {
  phase: (params) => (oneOf(params.dir, DECODE_DIRS, 'resolve') === 'dissolve' ? 'out' : 'in'),
  // The churn is the point: the whole word is already flickering on the bar's first frame, and
  // the stagger says only when each letter LOCKS (or, dissolving, when it starts to go).
  wholeBar: true,
  hidesBefore: () => false,     // same reason as scramble: the whole word shows from frame one
  usesEase: () => false,        // a flicker ticks on a hashed clock; there is nothing to curve
  piece: () => REST,            // the letters do not move — only what they SAY changes
  cell: (c) => {
    const set = oneOf(c.params.charset, TEXT_CHARSETS, 'text')
    const rate = Math.max(1, num(c.params.rate, 14))
    const pool = framePool(c.store, set, c.cell.char, c.cells)
    // One shared clock for the whole layer, so the churn reads as one machine working, not as
    // each letter running its own timer.
    const tick = Math.floor(Math.max(0, c.barElapsed) * rate)
    return { char: pickFrom(pool, hash01(c.seed, c.cellIndex, tick)) }
  },
})

// ---------------------------------------------------------------------------
// Slot slide — each letter is a reel of characters that rolls to a stop on the real one.
// ---------------------------------------------------------------------------
registerTextBehaviour('text.slot', {
  phase: (params) => (oneOf(params.dir, SLOT_DIRS, 'in') === 'out' ? 'out' : 'in'),
  springTail: true,             // a spring rolls past the landing and comes back — the point
  piece: () => REST,            // the letter holds its place; the REEL does the travelling
  cell: (c) => {
    const dir = oneOf(c.params.dir, SLOT_DIRS, 'in')
    const roll: 1 | -1 = oneOf(c.params.roll, SLOT_ROLLS, 'up') === 'down' ? -1 : 1
    // How many characters roll past before it lands.
    const steps = Math.min(40, Math.max(1, Math.round(num(c.params.steps, 8))))
    const filler = oneOf(c.params.filler, SLOT_FILLERS, 'letters')
    const real = c.cell.char
    const pool = filler === 'same' ? [real] : framePool(c.store, filler, real, c.cells)
    const out = dir === 'out'
    // Leaving, the reel rolls one step FURTHER than it has fillers, onto the empty landing.
    const last = out ? steps + 1 : steps
    // Steps is a LOOK control — how many characters flick past — and must not scale the
    // BOUNCE: a spring's overshoot is a fixed fraction of `e`, so `e × steps` would carry the
    // reel `(e − 1) × steps` windows past the landing (a blank slot at 40 steps) before it
    // came back. Past the landing the overshoot is counted in WINDOWS instead.
    const pos = c.e <= 1 ? c.e * last : last + (c.e - 1)
    // Only the characters the painter can reach are built — it inks `floor(pos) − 1` through
    // `ceil(pos) + 1` and nothing else, so a 40-step reel would otherwise build 41 strings per
    // live glyph per frame to show four. The list keeps its full length and its indices; the
    // entries outside the window are empty, which the painter already skips.
    const chars: string[] = new Array(last + 1).fill('')
    const from = Math.max(0, Math.floor(pos) - 1)
    const to = Math.min(last, Math.ceil(pos) + 1)
    for (let k = from; k <= to; k++) {
      // Rolling in, the fillers lead and the real character lands last; rolling out, the real
      // character leads and the reel runs off onto an empty landing.
      chars[k] = out
        ? (k === 0 ? real : k > steps ? '' : pickFrom(pool, hash01(c.seed, c.cellIndex, k)))
        : (k === steps ? real : pickFrom(pool, hash01(c.seed, c.cellIndex, k + 1)))
    }
    return { reel: { chars, pos, roll }, clipToCell: true, clipPad: 0.15 }
  },
})
