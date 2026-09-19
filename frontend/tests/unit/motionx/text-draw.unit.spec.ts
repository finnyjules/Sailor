/**
 * LETTER BEHAVIOURS — THE DRAW SEAM.
 *
 * Task 3 puts a per-glyph branch inside the two innermost text emitters (`drawText` for
 * flat/wrapped text, `drawTextOnPath` for type on a curve). The whole design rests on two
 * promises that only a recorded call sequence can hold us to:
 *
 *  1. A text layer with NO `textMotion` draws exactly what it drew before — one whole-run
 *     `fillText` per run, kerning and ligatures intact.
 *  2. A layer WITH `textMotion` whose behaviours are all outside their bars evaluates to
 *     `atRest` and takes that same static path, byte for byte.
 *
 * Only when a behaviour is actually inside its bar does the draw fan out to one `fillText`
 * per glyph, each under its own transform.
 *
 * The context is a recording Proxy (the idiom `motion-text-stroke-stack.unit.spec.ts` uses)
 * with two additions this file needs: property READS return real values (the per-glyph branch
 * multiplies into `ctx.globalAlpha`), and `save`/`restore` push and pop that state, so a
 * per-glyph alpha does not compound across glyphs the way it would against a dumb stub.
 *
 * Every advance is predictable: the stub measures a string at 10px per character, so a
 * 5-character run is 50px wide and every prefix-measured glyph centre is an integer.
 */
import { describe, it, expect } from 'vitest'
import '~/lib/motionx/text'            // registers text.cascade / maskSlide / typewriter / scramble
import type { StoredBehaviour } from '~/lib/motionx'
import { createTextLayer, __drawTextForTest } from '~/composables/useCompositorLayers'
import {
  drawTextCells,
  lineAtRest,
  movingTextFrame,
  pathGlyphCells,
  textRunCells,
} from '~/lib/motionx/text/draw'

const W = 1000
const CH = 10          // stub width per character
const FONT_PX = 100    // fontSize 0.1 × W

// ── harness ─────────────────────────────────────────────────────────────────

interface Rec { log: string[]; state: Record<string, unknown> }

function recorder(): { ctx: CanvasRenderingContext2D; rec: Rec } {
  const log: string[] = []
  const state: Record<string, unknown> = {
    globalAlpha: 1, textAlign: 'left', textBaseline: 'alphabetic',
    font: '', lineJoin: 'miter', lineWidth: 1, fillStyle: '#000', strokeStyle: '#000',
  }
  const stack: Record<string, unknown>[] = []
  const ctx = new Proxy({} as Record<string, unknown>, {
    // `applyFont` feature-detects `letterSpacing` / `fontVariationSettings` with `in`;
    // this ctx has neither, so the layer's own spacing is used (and never set).
    has: () => false,
    get(_t, key: string) {
      if (key === 'measureText') return (s: string) => ({ width: Array.from(s).length * CH })
      if (key === 'save') return () => { stack.push({ ...state }); log.push('save()') }
      if (key === 'restore') return () => { const s = stack.pop(); if (s) Object.assign(state, s); log.push('restore()') }
      if (key === 'canvas') return undefined
      if (key in state) return state[key]
      return (...args: unknown[]) => { log.push(`${key}(${args.map(a => String(a)).join(',')})`) }
    },
    set(_t, key: string, value: unknown) { state[key] = value; log.push(`${key}=${String(value)}`); return true },
  }) as unknown as CanvasRenderingContext2D
  return { ctx, rec: { log, state } }
}

/** Record the exact call sequence `drawText` issues for `layer`. */
function record(layer: unknown): string[] {
  const { ctx, rec } = recorder()
  __drawTextForTest(ctx, layer as never, W)
  return rec.log
}

const textLayer = (over: Record<string, unknown> = {}) => ({
  ...(createTextLayer({
    text: 'AB CD', x: 0.5, y: 0.5, fontSize: 0.1, lineHeight: 1.2, align: 'center', color: '#ffffff',
  }) as unknown as Record<string, unknown>),
  id: 'L1',
  // A layer that stores a stroke STACK has the legacy pair cleared; clear them here so no
  // outline pass muddies the recorded sequence.
  strokeColor: undefined, strokeWidth: undefined,
  ...over,
})

/** A fade cascade over the whole run with NO stagger: every letter is at the same
 *  progress, so a mid-bar sample is exactly opacity 0.5 under a linear ease. */
const fade = (over: Partial<StoredBehaviour> = {}): StoredBehaviour => ({
  id: 'b1', layerId: 'L1', kind: 'text.cascade',
  timing: { start: 0, duration: 1 },
  params: { style: 'fade', by: 'letters', stagger: 0, ease: 'linear' },
  ...over,
})

const withMotion = (layer: Record<string, unknown>, t: number, behaviours: StoredBehaviour[] = [fade()]) =>
  ({ ...layer, textMotion: { behaviours, t } })

const calls = (log: string[], name: string) => log.filter(l => l.startsWith(`${name}(`))
const fills = (log: string[]) => calls(log, 'fillText')

// ── 1. identity: no textMotion draws exactly what it drew before ─────────────

describe('a text layer with no textMotion is untouched', () => {
  it('draws one whole-run fillText per run', () => {
    const log = record(textLayer())
    expect(fills(log)).toEqual(['fillText(AB CD,0,0)'])
    // Not one per glyph, and no per-glyph transform.
    expect(calls(log, 'translate')).toHaveLength(0)
  })

  it('a two-line layer draws one fillText per LINE', () => {
    const log = record(textLayer({ text: 'AB\nCD' }))
    expect(fills(log)).toHaveLength(2)
    expect(fills(log)[0]).toContain('AB')
    expect(fills(log)[1]).toContain('CD')
  })

  it('justified words are still whole-run fillTexts', () => {
    const log = record(textLayer({ text: 'AB CD', align: 'justify', boxW: 0.2 }))
    // One run per word, each the whole word — never a glyph.
    expect(fills(log)).toEqual(['fillText(AB,-100,0)', 'fillText(CD,80,0)'])
  })
})

// ── 2. at rest: present but outside every bar ⇒ the static path, unchanged ───

describe('textMotion outside its bar falls through to the static draw', () => {
  it('after the bar the sequence equals the no-textMotion sequence', () => {
    const plain = record(textLayer())
    const rested = record(withMotion(textLayer(), 5))     // bar is 0..1
    expect(rested).toEqual(plain)
  })

  it('an empty behaviour list is also at rest', () => {
    expect(record(withMotion(textLayer(), 0.5, []))).toEqual(record(textLayer()))
  })
})

// ── 3. active: one fillText per non-space glyph, at its prefix-measured centre ─

describe('a behaviour inside its bar draws glyph by glyph', () => {
  it('one fillText per non-space glyph, each preceded by a translate to its centre', () => {
    const log = record(withMotion(textLayer(), 0.5))
    expect(fills(log)).toEqual([
      'fillText(A,0,0)', 'fillText(B,0,0)', 'fillText(C,0,0)', 'fillText(D,0,0)',
    ])
    // "AB CD" is 50px wide, centre-anchored ⇒ left edge -25. Prefix centres:
    // A 5, B 15, C 35, D 45 past the left edge.
    expect(calls(log, 'translate')).toEqual([
      'translate(-20,0)', 'translate(-10,0)', 'translate(10,0)', 'translate(20,0)',
    ])
  })

  it('per-glyph opacity MULTIPLIES the alpha already on the context (layer / group / cloner alpha)', () => {
    // Base alpha 0.5 × glyph opacity 0.5 = 0.25. With a base of 1 an overwrite and a multiply
    // look the same, which would let `ctx.globalAlpha = d.opacity` slip through unnoticed.
    const { ctx, rec } = recorder()
    ctx.globalAlpha = 0.5
    rec.log.length = 0
    __drawTextForTest(ctx, withMotion(textLayer(), 0.5) as never, W)
    expect(rec.log.filter(l => l.startsWith('globalAlpha='))).toEqual(
      ['globalAlpha=0.25', 'globalAlpha=0.25', 'globalAlpha=0.25', 'globalAlpha=0.25'],
    )
  })

  it('each glyph is drawn centred, whatever the block alignment', () => {
    // Left-aligned block: the run loop sets textAlign=left, the per-glyph branch must then
    // switch to center (each glyph is anchored on its own prefix-measured centre).
    const log = record(withMotion(textLayer({ align: 'left' }), 0.5))
    expect(log.filter(l => l.startsWith('textAlign=')).at(-1)).toBe('textAlign=center')
    // Left edge is the anchor itself (-25 for a 50px block centred on origin... no box, so
    // blockW is the widest line and anchorX = -blockW/2).
    expect(calls(log, 'translate')[0]).toBe('translate(-20,0)')
  })

  it('save/restore is balanced, one pair per drawn glyph', () => {
    const log = record(withMotion(textLayer(), 0.5))
    expect(calls(log, 'save')).toHaveLength(4)
    expect(calls(log, 'restore')).toHaveLength(4)
  })
})

// ── 4. hidden glyphs are not drawn at all ───────────────────────────────────

describe('glyphs at zero opacity are skipped', () => {
  it('before the bar nothing is inked', () => {
    const log = record(withMotion(textLayer(), -0.5))
    expect(fills(log)).toHaveLength(0)
  })
})

// ── 5. path text: the same three checks through drawTextOnPath ──────────────

const ring = { follow: 'curve' as const, bend: 1, runLength: 3 }

describe('text on a path', () => {
  it('without textMotion draws one fillText per placed glyph, whole run untouched', () => {
    const log = record(textLayer({ path: ring }))
    expect(fills(log)).toEqual(['fillText(A,0,0)', 'fillText(B,0,0)', 'fillText(C,0,0)', 'fillText(D,0,0)'])
  })

  it('at rest the sequence equals the no-textMotion sequence', () => {
    const plain = record(textLayer({ path: ring }))
    expect(record(withMotion(textLayer({ path: ring }), 5))).toEqual(plain)
  })

  it('inside the bar every glyph carries its own alpha', () => {
    const log = record(withMotion(textLayer({ path: ring }), 0.5))
    expect(fills(log)).toHaveLength(4)
    expect(log.filter(l => l.startsWith('globalAlpha='))).toEqual(
      ['globalAlpha=0.5', 'globalAlpha=0.5', 'globalAlpha=0.5', 'globalAlpha=0.5'],
    )
  })

  it('before the bar nothing is inked', () => {
    expect(fills(record(withMotion(textLayer({ path: ring }), -0.5)))).toHaveLength(0)
  })
})

// ── 6. the pure cell builders ───────────────────────────────────────────────

const measuring = () => recorder().ctx

describe('textRunCells', () => {
  it('measures by PREFIX inside the run, so a kern lands in the centre', () => {
    // "AV" measures 3px narrower than A + V — the kern has to move V's centre left.
    const { ctx } = recorder()
    const kerned = new Proxy(ctx as unknown as object, {
      get(t, k: string) {
        if (k === 'measureText') return (s: string) => {
          let w = Array.from(s).length * CH
          for (let i = 1; i < s.length; i++) if (s[i - 1] === 'A' && s[i] === 'V') w -= 3
          return { width: w }
        }
        return (t as Record<string, unknown>)[k]
      },
    }) as unknown as CanvasRenderingContext2D
    const cells = textRunCells(kerned, [{ text: 'AV', x: 0, y: 0, line: 0 }], FONT_PX, 'left')
    expect(cells).toHaveLength(2)
    expect(cells[0]!.x).toBeCloseTo(5, 6)        // A: 0 → 10
    expect(cells[1]!.x).toBeCloseTo(13.5, 6)     // V: 10 → 17, centre 13.5
    expect(cells[1]!.w).toBeCloseTo(7, 6)
  })

  it('skips whitespace but lets it bump the word index', () => {
    const cells = textRunCells(measuring(), [{ text: 'AB CD', x: 0, y: 0, line: 0 }], FONT_PX, 'left')
    expect(cells.map(c => c.char)).toEqual(['A', 'B', 'C', 'D'])
    expect(cells.map(c => c.word)).toEqual([0, 0, 1, 1])
  })

  it('honours the run textAlign', () => {
    const run = [{ text: 'AB CD', x: 0, y: 0, line: 0 }]
    expect(textRunCells(measuring(), run, FONT_PX, 'left')[0]!.x).toBeCloseTo(5, 6)
    expect(textRunCells(measuring(), run, FONT_PX, 'center')[0]!.x).toBeCloseTo(-20, 6)
    expect(textRunCells(measuring(), run, FONT_PX, 'right')[0]!.x).toBeCloseTo(-45, 6)
  })

  it('keeps a surrogate pair whole', () => {
    const cells = textRunCells(measuring(), [{ text: 'A😀B', x: 0, y: 0, line: 0 }], FONT_PX, 'left')
    expect(cells.map(c => c.char)).toEqual(['A', '😀', 'B'])
  })

  it('a run boundary is a word boundary, and carries the run line index', () => {
    const cells = textRunCells(measuring(), [
      { text: 'AB', x: 0, y: 0, line: 0 },
      { text: 'CD', x: 0, y: 120, line: 1 },
    ], FONT_PX, 'left')
    expect(cells.map(c => c.word)).toEqual([0, 0, 1, 1])
    expect(cells.map(c => c.line)).toEqual([0, 0, 1, 1])
  })
})

describe('pathGlyphCells', () => {
  it('derives word indices from the ORIGINAL run (placeGlyphs drops the spaces)', () => {
    const placed = [
      { ch: 'A', x: 0, y: 0, angle: 0, advance: 10 },
      { ch: 'B', x: 10, y: 0, angle: 0.1, advance: 10 },
      { ch: 'C', x: 30, y: 0, angle: 0.2, advance: 10 },
      { ch: 'D', x: 40, y: 0, angle: 0.3, advance: 10 },
    ]
    const cells = pathGlyphCells(placed, 'AB CD', FONT_PX)
    expect(cells.map(c => c.word)).toEqual([0, 0, 1, 1])
    expect(cells.map(c => c.line)).toEqual([0, 0, 0, 0])
    expect(cells.map(c => c.angle)).toEqual([0, 0.1, 0.2, 0.3])
    expect(cells[0]!.h).toBe(FONT_PX)
    expect(cells[0]!.w).toBe(10)
  })
})

// ── 7. the emitter ──────────────────────────────────────────────────────────

const cellsOf = (text: string) =>
  textRunCells(measuring(), [{ text, x: 0, y: 0, line: 0 }], FONT_PX, 'left')

describe('drawTextCells', () => {
  it('clips to the piece box, padded 15% vertically', () => {
    const { ctx, rec } = recorder()
    const cells = cellsOf('AB')
    const frame = {
      atRest: false,
      cells: [
        { x: 5, y: 0, rotation: 0, scale: 1, opacity: 1, clip: { x: 5, y: 0, w: 10, h: 100, angle: 0 } },
        { x: 15, y: 0, rotation: 0, scale: 1, opacity: 1 },
      ],
    }
    drawTextCells(ctx, cells, frame, ch => { rec.log.push(`ink(${ch})`) })
    expect(rec.log).toContain('rect(-5,-65,10,130)')
    expect(calls(rec.log, 'clip')).toHaveLength(1)
  })

  it('draws a bar cursor as a thin full-height rect', () => {
    const { ctx, rec } = recorder()
    drawTextCells(ctx, cellsOf('A'), {
      atRest: false,
      cells: [{ x: 5, y: 0, rotation: 0, scale: 1, opacity: 1 }],
      cursor: { x: 20, y: 0, h: 100, angle: 0, style: 'bar' },
    }, () => {})
    expect(rec.log).toContain('translate(20,0)')
    expect(calls(rec.log, 'fillRect')).toEqual(['fillRect(-3,-50,6,100)'])
  })

  it('draws an underscore cursor at the baseline', () => {
    const { ctx, rec } = recorder()
    drawTextCells(ctx, cellsOf('A'), {
      atRest: false,
      cells: [{ x: 5, y: 0, rotation: 0, scale: 1, opacity: 1 }],
      cursor: { x: 20, y: 0, h: 100, angle: 0, style: 'underscore' },
    }, () => {})
    expect(calls(rec.log, 'fillRect')).toEqual(['fillRect(-25,35,50,6)'])
  })
})

describe('movingTextFrame', () => {
  it('returns null at rest so the caller keeps the static path', () => {
    expect(movingTextFrame(cellsOf('AB'), [fade()], 5, { w: W, h: W })).toBeNull()
  })
  it('returns the evaluated frame while a bar is live', () => {
    const out = movingTextFrame(cellsOf('AB'), [fade()], 0.5, { w: W, h: W })
    expect(out).not.toBeNull()
    expect(out!.frame.cells.every(c => Math.abs(c.opacity - 0.5) < 1e-9)).toBe(true)
  })
  it('returns null for no cells', () => {
    expect(movingTextFrame([], [fade()], 0.5, { w: W, h: W })).toBeNull()
  })
})

describe('lineAtRest', () => {
  const cells = cellsOf('AB')
  const rest = cells.map(c => ({ x: c.x, y: c.y, rotation: c.angle, scale: 1, opacity: 1 }))
  it('true when every cell on the line sits where it rests', () => {
    expect(lineAtRest(cells, rest, 0)).toBe(true)
  })
  it('false when a cell is faded', () => {
    expect(lineAtRest(cells, [rest[0]!, { ...rest[1]!, opacity: 0.5 }], 0)).toBe(false)
  })
  it('false when a cell has moved more than half a pixel', () => {
    expect(lineAtRest(cells, [rest[0]!, { ...rest[1]!, y: rest[1]!.y + 2 }], 0)).toBe(false)
  })
  it('sub-half-pixel drift still counts as rest', () => {
    expect(lineAtRest(cells, [rest[0]!, { ...rest[1]!, y: rest[1]!.y + 0.2 }], 0)).toBe(true)
  })
})

// ── 8. underline / strikethrough while letters move ─────────────────────────

describe('decorations while letters move', () => {
  it('an underline is skipped on a line whose letters are moving', () => {
    const log = record(withMotion(textLayer({ underline: true }), 0.5))
    expect(calls(log, 'fillRect')).toHaveLength(0)
  })
  it('the same layer at rest still underlines', () => {
    const log = record(withMotion(textLayer({ underline: true }), 5))
    expect(calls(log, 'fillRect')).toHaveLength(1)
  })
})
