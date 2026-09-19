// Letter behaviours — the DRAW half: turning a text layer's own layout into `TextCell`s and
// painting the evaluated `TextFrame` glyph by glyph.
//
// Pure by the same rule as the rest of this folder: canvas primitives only, no compositor
// imports, no Vue. The compositor calls `textRunCells` / `pathGlyphCells` with the runs IT
// already laid out (so moving letters start exactly where static text sits), then
// `movingTextFrame` to evaluate, then `drawTextCells` with a painter closure that knows how to
// ink one glyph at the origin (stroke passes + fillText).
//
// The split matters: everything here is testable without a DOM, which is what lets the draw
// seam inside a ~6000-line shared file stay a two-line guarded branch.
import { evaluateTextBehaviours, type CellDraw, type FrameBox, type TextFrame } from './evaluate'
import type { TextCell } from './units'
import type { StoredBehaviour } from '~/lib/motionx'

/** One run exactly as the caller will draw it: the string, the anchor `fillText` is given,
 *  and the index of the LINE it belongs to. `align` is the run's `ctx.textAlign` and is the
 *  same for every run of one draw, so it is passed once. */
export interface TextRunSpec { text: string; x: number; y: number; line: number }

/** One placed glyph from an on-path layout (structurally `PlacedGlyph`, kept local so this
 *  module imports nothing from the compositor). */
export interface PlacedLike { ch: string; x: number; y: number; angle: number; advance: number }

export interface MovingText { cells: TextCell[]; frame: TextFrame }

const fin = (n: number, d = 0) => (Number.isFinite(n) ? n : d)
const isSpace = (ch: string) => /\s/u.test(ch)

/** Where a run's LEFT edge sits, given the anchor `fillText` is handed and the alignment it
 *  is drawn under. ('start'/'end' are the CSS spellings of left/right in an LTR context — the
 *  only one a Frame text layer has.) */
function runLeft(x: number, total: number, align: CanvasTextAlign): number {
  if (align === 'right' || align === 'end') return x - total
  if (align === 'center') return x - total / 2
  return x
}

/**
 * The cells of a flat/wrapped text draw, built from the draw's OWN runs.
 *
 * Advances come from PREFIX measurement inside each run — the advance of glyph k is
 * `width(run[0..k]) − width(run[0..k−1])` — so kerning pairs and `ctx.letterSpacing` both
 * survive: a glyph's centre is the midpoint of the two prefix widths either side of it,
 * which is exactly where whole-run `fillText` puts it. (Measuring characters one at a time
 * would lose the kern and drift the whole line.)
 *
 * `Array.from` keeps surrogate pairs whole. Whitespace yields no cell — there is nothing to
 * ink — but bumps the word index, as does every run boundary: the caller's runs are either
 * one per LINE (a line break is a word break) or one per justified WORD.
 *
 * PRECONDITION: the caller has already applied the font to `ctx` — this function only
 * measures, under exactly the state the glyphs will be drawn under.
 */
export function textRunCells(
  ctx: CanvasRenderingContext2D, runs: TextRunSpec[], fontPx: number, align: CanvasTextAlign,
): TextCell[] {
  const out: TextCell[] = []
  let word = 0
  for (let ri = 0; ri < runs.length; ri++) {
    const run = runs[ri]!
    if (ri > 0) word++
    const chars = Array.from(run.text)
    if (!chars.length) continue
    const widths = new Array<number>(chars.length)
    let prefix = ''
    let last = 0
    for (let k = 0; k < chars.length; k++) {
      prefix += chars[k]
      last = fin(ctx.measureText(prefix).width, last)
      widths[k] = last
    }
    const left = runLeft(run.x, last, align)
    let prev = 0
    let prevSpace = false
    for (let k = 0; k < chars.length; k++) {
      const ch = chars[k]!
      const w = widths[k]!
      if (isSpace(ch)) {
        if (!prevSpace) word++
        prevSpace = true
      } else {
        out.push({
          char: ch,
          x: left + (prev + w) / 2,      // the midpoint of this glyph's own advance
          y: run.y,
          w: Math.max(0, w - prev),
          h: fontPx,
          angle: 0,
          word,
          line: run.line,
        })
        prevSpace = false
      }
      prev = w
    }
  }
  return out
}

/**
 * The cells of an on-path draw, from the placements the path layout already produced.
 *
 * Position, turn and advance are taken verbatim, so a resting glyph sits exactly where the
 * static loop inks it. Word indices cannot be read off the placements — the path layout
 * ADVANCES over spaces but never emits one — so the original run is walked alongside,
 * matching each placed glyph to its source character and counting the gaps in between. A
 * character the layout dropped (an unplaceable glyph) is simply skipped over.
 */
export function pathGlyphCells(placed: PlacedLike[], run: string, fontPx: number): TextCell[] {
  const chars = Array.from(run)
  let ci = 0
  let word = 0
  const out: TextCell[] = []
  for (const g of placed) {
    while (ci < chars.length && chars[ci] !== g.ch) {
      if (isSpace(chars[ci]!)) word++
      ci++
    }
    if (ci < chars.length) ci++
    out.push({ char: g.ch, x: g.x, y: g.y, w: g.advance, h: fontPx, angle: g.angle, word, line: 0 })
  }
  return out
}

/**
 * PHASE-1 LIMITATION: text a per-codepoint split would mangle is not animated at all.
 *
 * Cells are cut with `Array.from`, one cell per codepoint. That is right for Latin and for a
 * lone emoji, and wrong for everything below: a combining mark would become its own "letter"
 * and fly off without the base it sits on; a ZWJ emoji would come apart into its people; and
 * an RTL run would animate in memory order, i.e. from the wrong end of the word. Until the
 * cell builders segment by GRAPHEME and order by bidi run, such text takes the static path
 * and simply does not animate — an honest nothing rather than a wrong something.
 */
export function hasComplexScript(text: string): boolean {
  return COMPLEX_SCRIPT.test(text)
}
const COMPLEX_SCRIPT = /[\p{M}‍️֐-׿؀-ۿݐ-ݿࢠ-ࣿיִ-﷿ﹰ-﻿]/u

/**
 * Evaluate `behaviours` over `cells` at `t` — or `null` when there is nothing to animate
 * this frame.
 *
 * `null` is the load-bearing return: it is what sends the caller down its UNTOUCHED static
 * path, so text whose behaviours are all outside their bars keeps the kerning and ligatures
 * of whole-run `fillText` instead of being redrawn glyph by glyph to look the same. It is
 * also how complex scripts (see `hasComplexScript`) opt out of the per-glyph path entirely —
 * one guard here covers both the flat draw and the on-path one.
 */
export function movingTextFrame(
  cells: TextCell[], behaviours: StoredBehaviour[], t: number, frame: FrameBox,
): MovingText | null {
  if (!cells.length) return null
  for (const c of cells) if (hasComplexScript(c.char)) return null
  const evaluated = evaluateTextBehaviours(behaviours, t, cells, frame)
  return evaluated.atRest ? null : { cells, frame: evaluated }
}

/**
 * Whether every cell on `line` is sitting where it rests — same place (within half a pixel),
 * same turn, same size, full opacity.
 *
 * Underline and strikethrough are rectangles spanning a whole line, and there is no sensible
 * reading of "the underline of a line whose letters are cascading in one at a time". So the
 * decoration is drawn only for a line that is wholly at rest, and skipped for the frames
 * where it is not.
 */
export function lineAtRest(cells: TextCell[], draws: CellDraw[], line: number): boolean {
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]!
    if (c.line !== line) continue
    const d = draws[i]
    if (!d) return false
    if (d.opacity < 1 || d.scale !== 1 || d.rotation !== c.angle) return false
    if (Math.abs(d.x - c.x) > 0.5 || Math.abs(d.y - c.y) > 0.5) return false
  }
  return true
}

/**
 * Paint an evaluated frame, one glyph at a time.
 *
 * `paint` inks ONE glyph at the origin — the caller's own stroke passes plus `fillText`, so
 * every style (the fill paint resolved once over the whole text box, the stroke stack, the
 * dash state) is set by the caller before this runs and is shared by every glyph: a gradient
 * fill stays anchored to the block rather than being re-resolved per letter.
 *
 * Per-glyph opacity MULTIPLIES the context's current `globalAlpha` rather than replacing it,
 * so the layer's own opacity, a group's cascade and a clone's alpha all still apply. The
 * save/restore pair around each glyph is what keeps that (and the clip) from leaking.
 *
 * A clip (mask slide) is applied in the PIECE's own turned frame and padded 15% of its height
 * top and bottom: the piece box is measured from the cells' `h`, which is the font size, and
 * a descender or a tall ascender reaches past it — without the pad a resting masked letter
 * would be shaved.
 */
export function drawTextCells(
  ctx: CanvasRenderingContext2D, cells: TextCell[], frame: TextFrame, paint: (ch: string) => void,
): void {
  for (let i = 0; i < cells.length; i++) {
    const d = frame.cells[i]
    if (!d || d.opacity <= 0) continue
    // A NaN in a transform matrix silently blanks the whole canvas, so an unplaceable
    // glyph is dropped rather than drawn (same last line of defence as the path layout).
    if (!Number.isFinite(d.x) || !Number.isFinite(d.y) || !Number.isFinite(d.rotation) || !Number.isFinite(d.scale)) continue
    ctx.save()
    const clip = d.clip
    if (clip) {
      const padY = clip.h * 0.15
      ctx.translate(clip.x, clip.y)
      ctx.rotate(clip.angle)
      ctx.beginPath()
      ctx.rect(-clip.w / 2, -clip.h / 2 - padY, clip.w, clip.h + padY * 2)
      ctx.clip()
      ctx.rotate(-clip.angle)
      ctx.translate(-clip.x, -clip.y)
    }
    ctx.globalAlpha = ctx.globalAlpha * d.opacity
    ctx.translate(d.x, d.y)
    if (d.rotation) ctx.rotate(d.rotation)
    if (d.scale !== 1) ctx.scale(d.scale, d.scale)
    paint(cells[i]!.char)
    ctx.restore()
  }
  const cursor = frame.cursor
  if (cursor && Number.isFinite(cursor.x) && Number.isFinite(cursor.y) && cursor.h > 0) {
    // In the current fill — a typewriter's caret is part of the type, not a separate colour.
    ctx.save()
    ctx.translate(cursor.x, cursor.y)
    if (cursor.angle) ctx.rotate(cursor.angle)
    if (cursor.style === 'underscore') {
      const w = cursor.h * 0.5, h = cursor.h * 0.06
      ctx.fillRect(-w / 2, cursor.h * 0.35, w, h)
    } else {
      const w = cursor.h * 0.06
      ctx.fillRect(-w / 2, -cursor.h / 2, w, cursor.h)
    }
    ctx.restore()
  }
}
