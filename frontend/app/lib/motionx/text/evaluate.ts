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
}
const REGISTRY = new Map<string, TextBehaviourDef>()
export function registerTextBehaviour(kind: string, def: TextBehaviourDef): void { REGISTRY.set(kind, def) }
export const isTextBehaviour = (b: { kind: string }) => typeof b?.kind === 'string' && b.kind.startsWith('text.')

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

interface ComposedCell { x: number; y: number; rotation: number; scale: number; opacity: number; clip?: CellDraw['clip'] }

/** Composes one behaviour's piece state onto one cell: the cell's offset from its piece's
 *  centre is rotated/scaled by the behaviour, then the behaviour's own dx/dy is added (rotated
 *  into the layer frame first when it was stated in the piece's own frame). Rotation adds,
 *  scale multiplies, opacity multiplies; a set clip always wins (last behaviour to set one). */
function applyStateToCell(cell: ComposedCell, piece: Piece, state: PieceState): void {
  const offX = cell.x - piece.cx, offY = cell.y - piece.cy
  const cosR = Math.cos(state.rotation), sinR = Math.sin(state.rotation)
  const rx = (offX * cosR - offY * sinR) * state.scale
  const ry = (offX * sinR + offY * cosR) * state.scale
  let dx = state.dx, dy = state.dy
  if (state.frame === 'piece') {
    const cosA = Math.cos(piece.angle), sinA = Math.sin(piece.angle)
    const rdx = dx * cosA - dy * sinA
    const rdy = dx * sinA + dy * cosA
    dx = rdx; dy = rdy
  }
  cell.x = piece.cx + rx + dx
  cell.y = piece.cy + ry + dy
  cell.rotation += state.rotation
  cell.scale *= state.scale
  cell.opacity *= state.opacity
  if (state.clip) cell.clip = { x: piece.cx, y: piece.cy, w: piece.w, h: piece.h, angle: piece.angle }
}

export function evaluateTextBehaviours(behaviours: StoredBehaviour[], t: number, cells: TextCell[], frame: FrameBox): TextFrame {
  const active = behaviours.filter((b) => isTextBehaviour(b) && REGISTRY.has(b.kind))
  if (active.length === 0 || cells.length === 0) return { atRest: true, cells: [] }

  const composed: ComposedCell[] = cells.map((c) => ({ x: c.x, y: c.y, rotation: c.angle, scale: 1, opacity: 1 }))
  let allRest = true
  let cursor: CursorDraw | undefined

  for (const b of active) {
    const def = REGISTRY.get(b.kind)!
    const params: Record<string, unknown> = { by: 'letters', stagger: 0.04, order: 'ltr', seed: 1, ease: 'easeOut', ...(b.params ?? {}) }
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
    const spring = isSpringEase(ease)
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
          if (isSpringEase(ease) && rawP >= springSettle(ease.bounce)) isRest = true
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
