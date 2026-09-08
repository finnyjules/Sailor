/**
 * A TEXT LAYER'S OUTLINE IN A MOTION CLIP.
 *
 * `drawAnimatedTextLayer` is the per-character renderer behind every motion clip preview and
 * the baked video (`lib/motion/paint.ts`, `lib/engine/motionClipRenderer.ts`). It used to read
 * `layer.strokeColor` / `layer.strokeWidth` directly — the two fields a layer that stores a
 * stroke STACK has CLEARED — so such a layer's outline disappeared from motion entirely while
 * the still frame kept drawing it.
 *
 * The canvas is a recording Proxy (the same stub the sibling motion spec uses), so what these
 * assert is the exact call sequence: which `strokeText` calls happen, at which `lineWidth`,
 * in which `strokeStyle`.
 */
import { describe, it, expect } from 'vitest'
import type { UnitState } from '~/lib/motion/evaluate'
import { IDENTITY_UNIT } from '~/lib/motion/evaluate'
import { drawAnimatedTextLayer } from '~/lib/motion/animatedText'
import { createTextLayer } from '~/composables/useCompositorLayers'
import type { StrokeInstance } from '~/lib/compositor/strokeStack'

const W = 1000, H = 800

function record(layer: Record<string, unknown>): string[] {
  const log: string[] = []
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(_t, key: string) {
      if (key === 'measureText') return (s: string) => ({ width: s.length * 10 })
      if (key === 'canvas') return undefined
      return (...args: unknown[]) => { log.push(`${key}(${args.join(',')})`) }
    },
    set(_t, key: string, value: unknown) { log.push(`${key}=${String(value)}`); return true },
  }) as unknown as CanvasRenderingContext2D
  const units: UnitState[] = [{ ...IDENTITY_UNIT }, { ...IDENTITY_UNIT }]
  drawAnimatedTextLayer(ctx, layer as never, W, H, units)
  return log
}

const textLayer = (extra: Record<string, unknown>) => ({
  ...(createTextLayer({ text: 'AB', x: 0.5, y: 0.5, fontSize: 0.1, lineHeight: 1.2, align: 'center' }) as unknown as Record<string, unknown>),
  // `createTextLayer` seeds the legacy pair; a layer that STORES a stack has them cleared in
  // the very same patch (`writeStrokeStackToLayer`), so clear them here too or the fold would
  // paper over the bug this file is about.
  strokeColor: undefined, strokeWidth: undefined,
  ...extra,
})

const band = (id: string, width: number, paint = '#ff0000', extra: Partial<StrokeInstance> = {}): StrokeInstance =>
  ({ id, paint, width, distance: 0, align: 'center', style: 'band', ...extra })

const strokes = (log: string[]) => log.filter(l => l.startsWith('strokeText('))
const lastBefore = (log: string[], prefix: string) =>
  log.filter(l => l.startsWith(prefix)).at(-1)

describe('drawAnimatedTextLayer reads the stroke STACK', () => {
  it('a stacked text layer still outlines every character', () => {
    const log = record(textLayer({ strokes: [band('a', 0.01)] }))
    expect(strokes(log)).toHaveLength(2)                    // one per character
    expect(lastBefore(log, 'lineWidth=')).toBe(`lineWidth=${0.01 * W}`)
    expect(lastBefore(log, 'strokeStyle=')).toBe('strokeStyle=#ff0000')
  })

  it('the FIRST row wins — the stack\'s own "first row lands on top" convention', () => {
    const log = record(textLayer({ strokes: [band('top', 0.02, '#00ff00'), band('under', 0.05, '#0000ff')] }))
    expect(strokes(log)).toHaveLength(2)
    expect(lastBefore(log, 'lineWidth=')).toBe(`lineWidth=${0.02 * W}`)
    expect(lastBefore(log, 'strokeStyle=')).toBe('strokeStyle=#00ff00')
  })

  it('a DISTANT band is skipped, not drawn on the edge — the documented limitation', () => {
    // `strokeText` has no way to offset ink from the glyph; drawing this one anyway would put
    // a band the still frame paints 20 px out right on the edge instead.
    const log = record(textLayer({ strokes: [band('far', 0.02, '#00ff00', { distance: 0.02 }), band('edge', 0.01)] }))
    expect(strokes(log)).toHaveLength(2)
    expect(lastBefore(log, 'lineWidth=')).toBe(`lineWidth=${0.01 * W}`)
    expect(lastBefore(log, 'strokeStyle=')).toBe('strokeStyle=#ff0000')
  })

  it('a stack of only distant bands draws no outline at all', () => {
    expect(strokes(record(textLayer({ strokes: [band('far', 0.02, '#f00', { distance: 0.03 })] })))).toHaveLength(0)
  })

  it('hidden and inkless entries are skipped, the next row is taken', () => {
    const log = record(textLayer({
      strokes: [
        band('hidden', 0.03, '#00ff00', { visible: false }),
        band('inkless', 0.04, 'none'),
        band('real', 0.01, '#ff0000'),
      ],
    }))
    expect(strokes(log)).toHaveLength(2)
    expect(lastBefore(log, 'lineWidth=')).toBe(`lineWidth=${0.01 * W}`)
  })

  it('a zero-width entry is skipped (it paints nothing on the still frame either)', () => {
    expect(strokes(record(textLayer({ strokes: [band('z', 0)] })))).toHaveLength(0)
  })

  it('a LEGACY layer is byte-for-byte what it was — same calls, same order', () => {
    const legacy = textLayer({ strokeColor: '#123456', strokeWidth: 0.008 })
    const log = record(legacy)
    expect(strokes(log)).toHaveLength(2)
    expect(lastBefore(log, 'lineWidth=')).toBe(`lineWidth=${0.008 * W}`)
    expect(lastBefore(log, 'strokeStyle=')).toBe('strokeStyle=#123456')
    // …and the two shapes agree, so a document that migrates renders identically.
    expect(log).toEqual(record(textLayer({ strokes: [band('a', 0.008, '#123456')] })))
  })

  it("a legacy 'transparent' outline still paints nothing", () => {
    expect(strokes(record(textLayer({ strokeColor: 'transparent', strokeWidth: 0.01 })))).toHaveLength(0)
  })

  it('no outline at all: no strokeText, and no lineWidth/strokeStyle writes', () => {
    const log = record(textLayer({}))
    expect(strokes(log)).toHaveLength(0)
    expect(log.some(l => l.startsWith('lineWidth='))).toBe(false)
    expect(log.filter(l => l.startsWith('fillText('))).toHaveLength(2)   // not a vacuous pass
  })

  /**
   * A MALFORMED `distance` must read as 0 here exactly as it does on the still frame's
   * `strokeDistancePx` (useCompositorLayers.ts) — on-edge, not "distant". Before this fix,
   * `if (st.distance) continue` treated `NaN` and `Infinity` as truthy and silently dropped
   * the stroke, so a text layer with a malformed distance showed its outline on the still
   * frame and NO outline in a motion clip or baked video — the two renderers disagreeing
   * about a value neither of them can call "distant".
   */
  it('a non-finite distance draws on the edge, agreeing with the still frame', () => {
    for (const distance of [NaN, Infinity, undefined]) {
      const log = record(textLayer({ strokes: [band('a', 0.01, '#ff0000', { distance })] }))
      expect(strokes(log)).toHaveLength(2)
      expect(lastBefore(log, 'lineWidth=')).toBe(`lineWidth=${0.01 * W}`)
      expect(lastBefore(log, 'strokeStyle=')).toBe('strokeStyle=#ff0000')
    }
  })
})
