// Registers the four letter behaviour kinds. One small definition per kind — the shared timing
// (stagger, order, seed, easing, entrance/exit clamping) lives in evaluate.ts; this file only
// says what EACH kind does to one piece at progress `e`, and (typewriter) where the cursor sits.
import { applyEase, type Ease } from '~/lib/motionx'
import { hash01 } from './rng'
import { REST, HIDDEN, registerTextBehaviour, oneOf, type CursorDraw } from './evaluate'
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
