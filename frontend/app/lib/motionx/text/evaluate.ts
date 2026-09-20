// Letter behaviours — pure evaluator. Turns a set of stored text behaviours + a time `t` into an
// absolute placement per glyph cell (`TextFrame`). No canvas, no Vue — a later task draws this.
import { applyEase, type Ease, type StoredBehaviour } from '~/lib/motionx'
import { isSpringEase, springSettle } from '~/lib/motionx/ease'
import { groupCells, type Piece, type PieceBy, type TextCell } from './units'
import { pieceRanks, pieceTiming, type Order } from './order'

/** A clip WINDOW in layer coordinates. `pad` is the share of `h` the painter adds above and
 *  below before clipping: a box measured from the font size shaves a descender or a tall
 *  ascender without it. Absent means the painter's own default (0.15); a reel, whose window is
 *  the cell's box and whose whole point is that the neighbouring characters stay hidden, asks
 *  for 0. */
export interface ClipBox { x: number; y: number; w: number; h: number; angle: number; pad?: number }
/** A strip of characters and where it is stopped. `pos` is an index INTO `chars` — fractional
 *  between two of them, and possibly past the last one when a spring overshoots, in which case
 *  the entries beyond the list are simply not drawn. `roll: 1` rolls UP (the next character
 *  arrives from below), `-1` rolls down. */
export interface ReelDraw { chars: string[]; pos: number; roll: 1 | -1 }
export interface CellDraw {
  x: number; y: number; rotation: number; scale: number; opacity: number; clip?: ClipBox
  /** A SUBSTITUTE character to ink instead of the cell's own (Decode's flicker). */
  char?: string
  /** A reel to ink instead of a single character (Slot). */
  reel?: ReelDraw
}
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
 *  - `barDur` the bar's total duration (`D`, i.e. `max(0.05, timing.duration)`).
 *  - `rank` this piece's place in the chosen order (0 = first) — what a LOOP lags by, since a
 *    loop has no stagger to ride (every piece is live for the whole bar) and takes its offset
 *    from the rank instead. */
export interface PieceCtx {
  piece: Piece; pieces: Piece[]; p: number; e: number; elapsed: number; pieceDur: number; t: number
  seed: number; frame: FrameBox; params: Record<string, unknown>; delay: number; barElapsed: number; barDur: number
  rank: number
}
/** Context for a `cell` callback: one PIECE's state plus which GLYPH of it is being asked
 *  about. `store` is a scratch bag shared by every cell of this behaviour in this frame — the
 *  place to build per-frame data (a charset pool) once instead of once per glyph. */
export interface CellCtx extends PieceCtx {
  cellIndex: number; cell: TextCell; cells: TextCell[]; store: Record<string, unknown>
}
/** What one behaviour does to one CELL. `clipToCell` asks for the cell's own resting box as
 *  the clip window (carried through whatever the bars before it did, exactly as a mask
 *  slide's is); `clipPad` overrides the painter's default padding for it. */
export interface CellResult { char?: string; reel?: ReelDraw; clipToCell?: boolean; clipPad?: number }
export interface TextBehaviourDef {
  phase: (params: Record<string, unknown>) => 'in' | 'out' | 'span'
  piece: (c: PieceCtx) => PieceState
  /** Per-GLYPH output — a substitute character, a reel, a window. Called only for a piece
   *  whose `piece` callback ran this frame (never at REST or HIDDEN), once per glyph of it. */
  cell?: (c: CellCtx) => CellResult | undefined
  /** Whether this kind's `ease` param does anything, so the inspector can hide a dead control.
   *  Absent means yes. */
  usesEase?: (params: Record<string, unknown>) => boolean
  /** Pieces are ACTIVE from the BAR's start rather than from their own staggered delay.
   *
   *  An entrance normally hides a piece until its own turn comes. A kind whose whole point is
   *  that the text CHURNS while it resolves (Decode) wants the opposite: every letter is
   *  already flickering on the bar's first frame, and the stagger says only when each one
   *  LOCKS. So with this flag the `piece`/`cell` callbacks run from `barElapsed >= 0` until
   *  the piece's own `p >= 1` (before the bar: HIDDEN; at/after its own end: REST), and an
   *  exit mirrors it — from the piece's own start until the BAR's end, HIDDEN after. */
  wholeBar?: boolean
  /** Does this ENTRANCE hide the text before its bar starts? Absent ⇒ true: a cascade, a
   *  typewriter, a mask reveal, a slot make the text APPEAR, so there must be nothing there
   *  beforehand. A scramble or a decode shows every letter from its first frame — nothing is
   *  revealed through it — so the text simply rests until the bar begins (otherwise a bar placed
   *  mid-timeline blanks everything before it, e.g. a Grow in that started at 0s). The shared
   *  `hideBefore` param overrides the default either way. Exits and loops never hide before. */
  hidesBefore?: (params: Record<string, unknown>) => boolean
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
function hidesBefore(def: TextBehaviourDef, params: Record<string, unknown>): boolean {
  if (def.phase(params) !== 'in') return false
  if (typeof params.hideBefore === 'boolean') return params.hideBefore
  return def.hidesBefore ? def.hidesBefore(params) : true
}
/** For the inspector: 'in' (an entrance), 'out' (an exit) or 'span' (a loop); null for an unknown kind. */
export function textBehaviourPhase(kind: string, params: Record<string, unknown> = {}): 'in' | 'out' | 'span' | null {
  const def = REGISTRY.get(kind)
  return def ? def.phase(params) : null
}
/** For the inspector: is the text hidden before this bar starts (default or overridden)? */
export function textBehaviourHidesBefore(kind: string, params: Record<string, unknown> = {}): boolean {
  const def = REGISTRY.get(kind)
  return def ? hidesBefore(def, params) : false
}
export function registerTextBehaviour(kind: string, def: TextBehaviourDef): void { REGISTRY.set(kind, def) }
export const isTextBehaviour = (b: { kind: string }) => typeof b?.kind === 'string' && b.kind.startsWith('text.')

/**
 * Does this kind, under these params, do anything with its easing curve?
 *
 * The inspector shows one Easing control for every letter bar, and for half the kinds it is
 * dead: a typewriter hard-cuts, Decode ticks on a hashed clock, a loop rides a sine of its own.
 * Read from the registry so the answer cannot drift from what the evaluator actually does with
 * `params.ease`. An unregistered kind draws nothing, so it uses nothing.
 */
export function textBehaviourUsesEase(kind: string, params?: Record<string, unknown>): boolean {
  const def = REGISTRY.get(kind)
  if (!def) return false
  if (!def.usesEase) return true
  return def.usesEase({ ...SHARED_DEFAULTS, ...(params ?? {}) })
}

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
  x: number; y: number; rotation: number; scale: number; opacity: number; clip?: ClipBox
  char?: string; reel?: ReelDraw
  accX: number; accY: number; accRot: number; accScale: number
}

/** A clip window stated in RESTING coordinates, before `applyStateToCell` carries it into the
 *  frame the earlier bars left the piece in. Either the PIECE's box (a mask slide) or one
 *  CELL's box (a reel). */
interface RestClipBox { cx: number; cy: number; w: number; h: number; angle: number; pad?: number }

/**
 * Two windows on one glyph, INTERSECTED. A reel's window and a mask slide's are both "the part
 * of the layer this letter may be seen through", so a letter wearing both is seen only through
 * the OVERLAP — a Slot added on top of a Mask slide must not quietly cancel the Mask slide (nor
 * the other way round). The padding of the overlap is the tighter of the two.
 *
 * Only two windows at the SAME angle have an axis-aligned overlap. At different angles — a
 * curved-text word or line piece is turned by the average of its letters' angles, while one
 * letter's own box is turned by its own — the overlap is not a rectangle, and the LAST window
 * wins, as it did before. An empty overlap becomes a zero-size box at the new window's centre:
 * nothing inks, which is the right answer, and where a box that crops everything away sits is
 * not observable (so the two orders of a missed pair agree on the nothing, not on the box).
 */
function intersectClips(a: ClipBox, b: ClipBox): ClipBox {
  if (!(Math.abs(a.angle - b.angle) < 1e-6)) return b
  const cos = Math.cos(b.angle), sin = Math.sin(b.angle)
  // Both centres in the frame the two windows share (turned back by their angle), where each is
  // an axis-aligned rect and the overlap is one interval per axis.
  const turn = (c: ClipBox): [number, number] => [c.x * cos + c.y * sin, -c.x * sin + c.y * cos]
  const [ax, ay] = turn(a), [bx, by] = turn(b)
  const x0 = Math.max(ax - a.w / 2, bx - b.w / 2), x1 = Math.min(ax + a.w / 2, bx + b.w / 2)
  const y0 = Math.max(ay - a.h / 2, by - b.h / 2), y1 = Math.min(ay + a.h / 2, by + b.h / 2)
  const pad = a.pad === undefined && b.pad === undefined ? undefined : Math.min(a.pad ?? 0.15, b.pad ?? 0.15)
  const empty = !(x1 > x0) || !(y1 > y0)
  const cx = empty ? 0 : (x0 + x1) / 2, cy = empty ? 0 : (y0 + y1) / 2
  const out: ClipBox = empty
    ? { x: b.x, y: b.y, w: 0, h: 0, angle: b.angle }
    : { x: cx * cos - cy * sin, y: cx * sin + cy * cos, w: x1 - x0, h: y1 - y0, angle: b.angle }
  if (pad !== undefined) out.pad = pad
  return out
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
 *  - any clip already on the cell is carried through this behaviour's own transform (centre,
 *    turn and size alike), whether or not this behaviour sets one of its own;
 *  - a cell that ends up wearing two windows is seen through their OVERLAP (`intersectClips`).
 *
 * That also makes the pair order-independent: a mask slide added before or after a scramble,
 * a cascade or a slot produces the same window in the same place.
 *
 * `restClip` is the same mechanism reached from a `cell` callback: a reel's window is ONE
 * cell's box rather than the whole piece's, and it takes precedence over `state.clip` because
 * it is the more specific of the two.
 */
function applyStateToCell(cell: ComposedCell, piece: Piece, state: PieceState, restClip?: RestClipBox): void {
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

  const box: RestClipBox | undefined =
    restClip ?? (state.clip ? { cx: piece.cx, cy: piece.cy, w: piece.w, h: piece.h, angle: piece.angle } : undefined)
  // Whatever window the cell already wears is carried through THIS behaviour's map — including
  // when this behaviour sets a window of its own, which is what makes the pair symmetric: each
  // window is placed by the bars BEFORE it and then carried by the bars AFTER it.
  let carried: ClipBox | undefined
  if (cell.clip) {
    const [cx, cy] = map(cell.clip.x, cell.clip.y)
    carried = {
      x: cx, y: cy,
      w: cell.clip.w * state.scale,
      h: cell.clip.h * state.scale,
      angle: cell.clip.angle + state.rotation,
    }
    if (cell.clip.pad !== undefined) carried.pad = cell.clip.pad
  }
  if (box) {
    // The resting box, carried into the frame the earlier bars left this piece in.
    const c = Math.cos(cell.accRot), s = Math.sin(cell.accRot)
    const next: ClipBox = {
      x: cell.accScale * (box.cx * c - box.cy * s) + cell.accX,
      y: cell.accScale * (box.cx * s + box.cy * c) + cell.accY,
      w: box.w * cell.accScale,
      h: box.h * cell.accScale,
      angle: box.angle + cell.accRot,
    }
    if (box.pad !== undefined) next.pad = box.pad
    cell.clip = carried ? intersectClips(carried, next) : next
  } else if (carried) {
    cell.clip = carried
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
      const reversed = Math.max(0, ...ranks)
      ranks = ranks.map((r) => reversed - r)
    }
    const { delays, pieceDur } = pieceTiming(ranks, stagger, D)
    const ease = params.ease as Ease
    // Only a kind that opted in (`springTail`) keeps running past its bar under a spring.
    const spring = isSpringEase(ease) && def.springTail === true
    const phase = def.phase(params)

    const visible: boolean[] = new Array(pieces.length)
    const states: PieceState[] = new Array(pieces.length)
    // The context of each piece whose callbacks RAN this frame — undefined for a piece sitting
    // at REST or HIDDEN, which is what keeps `cell` off the glyphs that have nothing to say.
    const live: Array<PieceCtx | undefined> = new Array(pieces.length)
    const wholeBar = def.wholeBar === true
    const hideBefore = hidesBefore(def, params)

    const makeCtx = (piece: Piece, delay: number, rawP: number, e: number, barElapsed: number): PieceCtx => ({
      piece, pieces, p: rawP, e, elapsed: t - start - delay, pieceDur, t,
      seed, frame, params, delay, barElapsed, barDur: D, rank: ranks[piece.index] ?? 0,
    })

    for (const piece of pieces) {
      const i = piece.index
      const delay = delays[i]!
      const rawP = (t - start - delay) / pieceDur
      const barElapsed = t - start
      let state: PieceState
      let isRest = false

      if (phase === 'in') {
        // Before the BAR: hidden only when this bar is what reveals the text (see `hidesBefore`).
        // From the bar's start on, a piece still waiting for its turn is always hidden.
        if (barElapsed < 0 && !hideBefore) { state = REST; isRest = true; visible[i] = true }
        // `wholeBar` moves the near edge from this piece's own turn to the BAR's start.
        else if (wholeBar ? !(barElapsed >= 0) : rawP <= 0) { state = HIDDEN; visible[i] = false }
        else if (rawP >= 1 && !spring) { state = REST; isRest = true; visible[i] = true }
        else {
          const p = spring ? Math.max(0, rawP) : clamp01(rawP)
          const ctx = makeCtx(piece, delay, rawP, applyEase(p, ease), barElapsed)
          live[i] = ctx
          state = def.piece(ctx)
          visible[i] = true
          // A spring keeps settling past p = 1 (never hit by the branch above); it is at REST
          // once p reaches springSettle(bounce), the point where springProgress starts returning
          // exactly 1 — otherwise atRest would never become true again for this piece.
          if (spring && isSpringEase(ease) && rawP >= springSettle(ease.bounce)) isRest = true
        }
      } else if (phase === 'out') {
        // The mirror: `wholeBar` moves the FAR edge from this piece's own end to the bar's.
        if (rawP <= 0) { state = REST; isRest = true; visible[i] = true }
        else if (wholeBar ? barElapsed >= D : rawP >= 1) { state = HIDDEN; visible[i] = false }
        else {
          const ctx = makeCtx(piece, delay, rawP, applyEase(clamp01(rawP), ease), barElapsed)
          live[i] = ctx
          state = def.piece(ctx)
          visible[i] = true
        }
      } else {
        if (barElapsed <= 0 || barElapsed >= D) { state = REST; isRest = true; visible[i] = true }
        else {
          const ctx = makeCtx(piece, delay, rawP, applyEase(clamp01(rawP), ease), barElapsed)
          live[i] = ctx
          state = def.piece(ctx)
          visible[i] = true
        }
      }

      states[i] = state
      if (!isRest) allRest = false
    }

    // `cell` runs for EVERY glyph of every frame, so the context object is built once and
    // refilled per glyph, and whatever the behaviour has to compute for the whole frame (a
    // charset pool) goes in `store` rather than being rebuilt per glyph.
    const store: Record<string, unknown> = {}
    let cellCtx: CellCtx | undefined

    for (let ci = 0; ci < cells.length; ci++) {
      const piece = cellPiece[ci]!
      const target = composed[ci]!
      let restClip: RestClipBox | undefined
      const ctx = def.cell ? live[piece.index] : undefined
      if (ctx) {
        if (!cellCtx) cellCtx = Object.assign({}, ctx, { cellIndex: ci, cell: cells[ci]!, cells, store })
        else { Object.assign(cellCtx, ctx); cellCtx.cellIndex = ci; cellCtx.cell = cells[ci]! }
        const out = def.cell!(cellCtx)
        if (out) {
          // The LAST behaviour that names one wins; a behaviour that names neither leaves
          // whatever an earlier one put there alone.
          if (out.char !== undefined) target.char = out.char
          if (out.reel !== undefined) target.reel = out.reel
          if (out.clipToCell) {
            const c = cells[ci]!
            // Wider than the advance, because a reel shows OTHER characters through the same
            // window and a narrow glyph's own box would shave them.
            restClip = { cx: c.x, cy: c.y, w: Math.max(c.w, c.h * 0.8) * 1.1, h: c.h, angle: c.angle, pad: num(out.clipPad, 0.15) }
          }
        }
      }
      applyStateToCell(target, piece, states[piece.index]!, restClip)
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
    if (c.char !== undefined) cd.char = c.char
    if (c.reel) cd.reel = c.reel
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
    // An entrance that does not hide the text beforehand has nothing to draw until it starts.
    if (phase === 'in' ? !(t > end) && (hidesBefore(def, params) || !(t < start)) : !(t < start || t > end)) return true
  }
  return false
}
