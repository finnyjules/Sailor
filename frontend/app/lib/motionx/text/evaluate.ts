// Letter behaviours — pure evaluator. Turns a set of stored text behaviours + a time `t` into an
// absolute placement per glyph cell (`TextFrame`). No canvas, no Vue — a later task draws this.
import { applyEase, type Ease, type StoredBehaviour } from '~/lib/motionx'
import { isSpringEase, springSettle } from '~/lib/motionx/ease'
import { groupCells, type Piece, type PieceBy, type TextCell } from './units'
import { pieceRanks, pieceTiming, type Order } from './order'

export interface CellDraw { x: number; y: number; rotation: number; scale: number; opacity: number; clip?: { x: number; y: number; w: number; h: number; angle: number } }
export interface CursorDraw { x: number; y: number; h: number; angle: number; style: 'bar' | 'underscore' }
export interface TextFrame { atRest: boolean; cells: CellDraw[]; cursor?: CursorDraw }
export interface FrameBox { w: number; h: number }

/** What one behaviour does to one piece. dx/dy px; `frame` says whether they are in the PIECE's
 *  own rotated frame (rise/drop/mask travel) or already in the LAYER frame (scramble). */
export interface PieceState { dx: number; dy: number; frame: 'piece' | 'layer'; rotation: number; scale: number; opacity: number; clip?: boolean }
export const REST: PieceState = Object.freeze({ dx: 0, dy: 0, frame: 'piece', rotation: 0, scale: 1, opacity: 1 }) as PieceState
export const HIDDEN: PieceState = Object.freeze({ ...REST, opacity: 0 }) as PieceState

/** Context handed to a behaviour's `piece` callback for one piece at one instant.
 *  - `p` raw progress (unclamped): `(t - start - delays[i]) / pieceDur`.
 *  - `e` eased progress: `applyEase(p, ease)`, clamped 0..1 except on a spring entrance.
 *  - `elapsed` seconds since THIS piece's own scheduled start (`t - start - delay`) — what
 *    scramble's scatter mode (an EXIT, each piece starts on its own) uses.
 *  - `delay` this piece's stagger delay in seconds (bar-relative).
 *  - `barElapsed` seconds since the BAR's start (`t - start`, ignoring stagger) — what
 *    scramble's settle/loop modes use, since all pieces jump on one shared clock.
 *  - `barDur` the bar's total duration (`D`, i.e. `max(0.05, timing.duration)`). */
export interface PieceCtx {
  piece: Piece; pieces: Piece[]; p: number; e: number; elapsed: number; pieceDur: number; t: number
  seed: number; frame: FrameBox; params: Record<string, unknown>; delay: number; barElapsed: number; barDur: number
}
export interface TextBehaviourDef {
  phase: (params: Record<string, unknown>) => 'in' | 'out' | 'span'
  piece: (c: PieceCtx) => PieceState
  cursor?: (c: { pieces: Piece[]; visible: boolean[]; t: number; params: Record<string, unknown> }) => CursorDraw | undefined
  /** Delete-style behaviours (typewriter delete) run the chosen order BACKWARDS: whichever
   *  piece would start last under the normal order starts first. Applied to ranks before
   *  `pieceTiming` runs. */
  reverseOrder?: (params: Record<string, unknown>) => boolean
  /** OPT IN to the spring tail: with a spring easing this kind's entrance keeps being
   *  evaluated past the end of its bar, until the spring settles, so it can overshoot its
   *  resting place and come back. Only a kind that INTERPOLATES towards rest (cascade, mask
   *  slide) has anything to settle into. For every other kind — scramble hops to a hashed
   *  spot, typewriter hard-cuts — a spring is just another curve, and the bar's edges still
   *  mean REST / HIDDEN exactly; without that, scramble would keep hopping past the end of
   *  its bar and then snap into place when the spring finally settled. */
  springTail?: boolean
}
const REGISTRY = new Map<string, TextBehaviourDef>()
export function registerTextBehaviour(kind: string, def: TextBehaviourDef): void { REGISTRY.set(kind, def) }
export const isTextBehaviour = (b: { kind: string }) => typeof b?.kind === 'string' && b.kind.startsWith('text.')

/**
 * Whether a layer can run letter behaviours at all — THE predicate, shared by the gallery
 * (which Letters tiles to offer) and the add path (which bars to accept), so the two cannot
 * drift apart and offer something that would do nothing.
 *
 * A text layer whose older `animation` preset is still on it is drawn by the previous motion
 * engine, which knows nothing about `textMotion`: a letter bar added there would be stored,
 * shown on the timeline and silently ignored by the painter. Removing the "Older animation"
 * bar first is what makes the layer eligible.
 */
export function canAnimateLetters(layer: { kind?: string; animation?: unknown } | null | undefined): boolean {
  return !!layer && layer.kind === 'text' && !layer.animation
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n)
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)

/** Reads an enum-like param, falling back to `fallback` for anything not in `allowed` — so a
 *  garbage/unknown string can never land in an accidental code branch. Shared by `by`/`order`
 *  here and by every behaviour-specific enum param in behaviours.ts, so `phase()` and `piece()`
 *  can never disagree about which mode is active. */
export function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

const PIECE_BY: readonly PieceBy[] = ['letters', 'words', 'lines']
const ORDERS: readonly Order[] = ['ltr', 'rtl', 'center', 'edges', 'random']

/** The curve a letter bar runs under when it carries no `ease` of its own. Exported because
 *  the inspector has to SHOW this one: a text bar compiles to no track, so there is no
 *  keyframe to read the curve back off. */
export const DEFAULT_TEXT_EASE: Ease = 'easeOut'
/** The shared params every letter behaviour gets, whatever its kind. */
const SHARED_DEFAULTS: Record<string, unknown> = { by: 'letters', stagger: 0.04, order: 'ltr', seed: 1, ease: DEFAULT_TEXT_EASE }

/** A cell mid-composition. `acc*` is the similarity (uniform scale + rotation + translation)
 *  that maps this cell's REST frame to where the behaviours applied so far have put it:
 *  `p ↦ accScale · R(accRot) · p + (accX, accY)`. It exists for one reason — a mask slide's
 *  clip is the piece's resting box, and it has to be placed in whatever frame the bars BEFORE
 *  it have already moved the piece into. */
interface ComposedCell {
  x: number; y: number; rotation: number; scale: number; opacity: number; clip?: CellDraw['clip']
  accX: number; accY: number; accRot: number; accScale: number
}

/**
 * Composes one behaviour's piece state onto one cell: the cell's offset from its piece's
 * centre is rotated/scaled by the behaviour, then the behaviour's own dx/dy is added (rotated
 * into the layer frame first when it was stated in the piece's own frame). Rotation adds,
 * scale multiplies, opacity multiplies.
 *
 * THE CLIP TRAVELS. A mask slide's clip is the WINDOW its letter slides through, so any other
 * bar on the same layer has to move the window and the letter together:
 *
 *  - a behaviour that SETS a clip places it at the piece's resting box seen through the
 *    accumulated transform of the bars before it (its own dx/dy is excluded — that offset is
 *    precisely the letter's travel INSIDE its window);
 *  - a behaviour that sets none carries any clip already on the cell through its own
 *    transform (centre, turn and size alike).
 *
 * That also makes the pair order-independent: a mask slide added before or after a scramble
 * or a cascade produces the same window in the same place.
 */
function applyStateToCell(cell: ComposedCell, piece: Piece, state: PieceState): void {
  const cosR = Math.cos(state.rotation), sinR = Math.sin(state.rotation)
  let dx = state.dx, dy = state.dy
  if (state.frame === 'piece') {
    const cosA = Math.cos(piece.angle), sinA = Math.sin(piece.angle)
    const rdx = dx * cosA - dy * sinA
    const rdy = dx * sinA + dy * cosA
    dx = rdx; dy = rdy
  }
  // The behaviour as a map on layer coordinates: p ↦ s·R·p + t. `pure` is the same map when
  // it is only a translation — written as a plain add so composing two translations is exact
  // (the round trip through the piece centre is not, and two bars in the other order would
  // then land an ULP apart).
  const pure = state.rotation === 0 && state.scale === 1
  const map = (px: number, py: number): [number, number] => {
    if (pure) return [px + dx, py + dy]
    const ox = px - piece.cx, oy = py - piece.cy
    return [
      piece.cx + (ox * cosR - oy * sinR) * state.scale + dx,
      piece.cy + (ox * sinR + oy * cosR) * state.scale + dy,
    ]
  }

  if (state.clip) {
    // The resting box, carried into the frame the earlier bars left this piece in.
    const c = Math.cos(cell.accRot), s = Math.sin(cell.accRot)
    cell.clip = {
      x: cell.accScale * (piece.cx * c - piece.cy * s) + cell.accX,
      y: cell.accScale * (piece.cx * s + piece.cy * c) + cell.accY,
      w: piece.w * cell.accScale,
      h: piece.h * cell.accScale,
      angle: piece.angle + cell.accRot,
    }
  } else if (cell.clip) {
    const [cx, cy] = map(cell.clip.x, cell.clip.y)
    cell.clip = {
      x: cx, y: cy,
      w: cell.clip.w * state.scale,
      h: cell.clip.h * state.scale,
      angle: cell.clip.angle + state.rotation,
    }
  }

  const [nx, ny] = map(cell.x, cell.y)
  cell.x = nx
  cell.y = ny
  cell.rotation += state.rotation
  cell.scale *= state.scale
  cell.opacity *= state.opacity
  // acc ← thisBehaviour ∘ acc. The linear parts multiply; the translation is the old one
  // carried THROUGH this behaviour's map, which is exactly `map` applied to it as a point.
  const [ax, ay] = map(cell.accX, cell.accY)
  cell.accX = ax
  cell.accY = ay
  cell.accRot += state.rotation
  cell.accScale *= state.scale
}

export function evaluateTextBehaviours(behaviours: StoredBehaviour[], t: number, cells: TextCell[], frame: FrameBox): TextFrame {
  const active = behaviours.filter((b) => isTextBehaviour(b) && REGISTRY.has(b.kind))
  if (active.length === 0 || cells.length === 0) return { atRest: true, cells: [] }

  const composed: ComposedCell[] = cells.map((c) => ({
    x: c.x, y: c.y, rotation: c.angle, scale: 1, opacity: 1,
    accX: 0, accY: 0, accRot: 0, accScale: 1,
  }))
  let allRest = true
  let cursor: CursorDraw | undefined

  for (const b of active) {
    const def = REGISTRY.get(b.kind)!
    const params: Record<string, unknown> = { ...SHARED_DEFAULTS, ...(b.params ?? {}) }
    const by = oneOf(params.by, PIECE_BY, 'letters')
    const order = oneOf(params.order, ORDERS, 'ltr')
    const seed = num(params.seed, 1)
    const stagger = num(params.stagger, 0.04)
    const pieces = groupCells(cells, by)
    const cellPiece: Piece[] = new Array(cells.length)
    pieces.forEach((pc) => pc.cells.forEach((ci) => { cellPiece[ci] = pc }))

    const start = b.timing.start + (b.timing.delay ?? 0)
    const D = Math.max(0.05, b.timing.duration)
    let ranks = pieceRanks(pieces.length, order, seed)
    if (def.reverseOrder?.(params)) {
      const maxRank = Math.max(0, ...ranks)
      ranks = ranks.map((r) => maxRank - r)
    }
    const { delays, pieceDur } = pieceTiming(ranks, stagger, D)
    const ease = params.ease as Ease
    // Only a kind that opted in (`springTail`) keeps running past its bar under a spring.
    const spring = isSpringEase(ease) && def.springTail === true
    const phase = def.phase(params)

    const visible: boolean[] = new Array(pieces.length)
    const states: PieceState[] = new Array(pieces.length)

    const makeCtx = (piece: Piece, delay: number, rawP: number, e: number, barElapsed: number): PieceCtx => ({
      piece, pieces, p: rawP, e, elapsed: t - start - delay, pieceDur, t,
      seed, frame, params, delay, barElapsed, barDur: D,
    })

    for (const piece of pieces) {
      const i = piece.index
      const delay = delays[i]!
      const rawP = (t - start - delay) / pieceDur
      const barElapsed = t - start
      let state: PieceState
      let isRest = false

      if (phase === 'in') {
        if (rawP <= 0) { state = HIDDEN; visible[i] = false }
        else if (rawP >= 1 && !spring) { state = REST; isRest = true; visible[i] = true }
        else {
          const p = spring ? Math.max(0, rawP) : clamp01(rawP)
          state = def.piece(makeCtx(piece, delay, rawP, applyEase(p, ease), barElapsed))
          visible[i] = true
          // A spring keeps settling past p = 1 (never hit by the branch above); it is at REST
          // once p reaches springSettle(bounce), the point where springProgress starts returning
          // exactly 1 — otherwise atRest would never become true again for this piece.
          if (spring && isSpringEase(ease) && rawP >= springSettle(ease.bounce)) isRest = true
        }
      } else if (phase === 'out') {
        if (rawP <= 0) { state = REST; isRest = true; visible[i] = true }
        else if (rawP >= 1) { state = HIDDEN; visible[i] = false }
        else {
          state = def.piece(makeCtx(piece, delay, rawP, applyEase(clamp01(rawP), ease), barElapsed))
          visible[i] = true
        }
      } else {
        if (barElapsed <= 0 || barElapsed >= D) { state = REST; isRest = true; visible[i] = true }
        else {
          state = def.piece(makeCtx(piece, delay, rawP, applyEase(clamp01(rawP), ease), barElapsed))
          visible[i] = true
        }
      }

      states[i] = state
      if (!isRest) allRest = false
    }

    for (let ci = 0; ci < cells.length; ci++) {
      const piece = cellPiece[ci]!
      applyStateToCell(composed[ci]!, piece, states[piece.index]!)
    }

    if (def.cursor) {
      const inBar = t >= start && t <= start + D
      if (inBar) {
        const blink = (params.blink as number) ?? 0
        const blinkHidden = blink > 0 && Math.floor((t - start) * blink * 2) % 2 === 1
        if (!blinkHidden) {
          const result = def.cursor({ pieces, visible, t, params })
          if (result) { cursor = result; allRest = false }
        }
      }
    }
  }

  const outCells: CellDraw[] = composed.map((c) => {
    const cd: CellDraw = { x: c.x, y: c.y, rotation: c.rotation, scale: Math.max(0.001, c.scale), opacity: clamp01(c.opacity) }
    if (c.clip) cd.clip = c.clip
    return cd
  })
  const result: TextFrame = { atRest: allRest, cells: outCells }
  if (cursor) result.cursor = cursor
  return result
}

/**
 * Could ANY of these bars move a letter at `t`? The same phase rules as
 * `evaluateTextBehaviours`, decided from the bars alone — no cells, no layout, no measuring.
 *
 * This is what keeps an idle text layer idle. `applyTextBehaviours` attaches its per-frame
 * `textMotion` only when this says yes, so a layer whose 0.8s entrance finished at t = 0.8 is
 * an ordinary text layer for the rest of the clip: whole-run `fillText`, and eligible for the
 * silhouette raster cache again (which skips any layer carrying `textMotion`, since moving
 * letters are never twice the same raster).
 *
 * The rules, per bar:
 *  - entrance (`in`): inert once `t` is past the bar's end — before and during it the pieces
 *    are hidden or travelling. A `springTail` kind under a spring easing keeps settling past
 *    that end; the true end is `lastDelay + pieceDur × springSettle`, and the piece count is
 *    unknown here, so the CONSERVATIVE bound `start + D × springSettle` is used instead. It is
 *    never early: `D ≥ pieceDur` and `springSettle > 1`, so `D×S ≥ lastDelay + pieceDur×S`.
 *  - exit (`out`): inert only BEFORE the bar. A finished exit is not inert — its pieces are
 *    hidden, which is a thing to draw (nothing), not a thing to skip.
 *  - span (`loop`): inert on both sides of the bar.
 *  - an unknown or unregistered kind does nothing, so it is inert.
 *
 * The bounds are STRICT on purpose: a typewriter paints its cursor at both closed edges of
 * its bar, so only the open interval is honestly inert. Erring live costs one frame of
 * glyph-by-glyph drawing; erring inert would drop that cursor.
 */
export function textCanMove(behaviours: StoredBehaviour[], t: number): boolean {
  for (const b of behaviours) {
    if (!isTextBehaviour(b) || !REGISTRY.has(b.kind)) continue
    const def = REGISTRY.get(b.kind)!
    const params: Record<string, unknown> = { ...SHARED_DEFAULTS, ...(b.params ?? {}) }
    const start = b.timing.start + (b.timing.delay ?? 0)
    const D = Math.max(0.05, b.timing.duration)
    const phase = def.phase(params)
    if (phase === 'out') {
      if (!(t < start)) return true
      continue
    }
    const ease = params.ease as Ease
    const tail = phase === 'in' && def.springTail === true && isSpringEase(ease) ? springSettle(ease.bounce) : 1
    const end = start + D * tail
    // NaN timings compare false everywhere, which lands on "live" — the safe side.
    if (phase === 'in' ? !(t > end) : !(t < start || t > end)) return true
  }
  return false
}
