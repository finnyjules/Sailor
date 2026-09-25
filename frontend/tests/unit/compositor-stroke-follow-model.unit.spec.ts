import { describe, it, expect } from 'vitest'
import {
  strokeFollowsOf, strokeFadeOf, strokeFadeRepeatsOf, DEFAULT_FADE_REPEATS, strokeStackOf,
  type StrokeInstance,
} from '~/lib/compositor/strokeStack'
import { paintCanFollow } from '~/lib/compositor/strokeFollow'
import {
  strokeInspectorRows, STROKE_ROW_ORDER, STROKE_FOLLOW_OPTIONS, STROKE_FADE_OPTIONS, strokeFollowPatch,
} from '~/lib/compositor/strokeInspector'

const grid = { type: 'grid', a: '#fff', b: '#000', textColor: '#fff', angle: 0, density: 8 }
const ombre = { ...grid, type: 'ombre' }
const stroke = (o: Partial<StrokeInstance> = {}): StrokeInstance =>
  ({ id: 's1', paint: grid as any, width: 0.02, ...o })

describe('stroke follow — readers', () => {
  it('follow is on only for a literal true', () => {
    expect(strokeFollowsOf({})).toBe(false)
    expect(strokeFollowsOf({ follow: true })).toBe(true)
    expect(strokeFollowsOf({ follow: 'yes' as any })).toBe(false)
  })
  it('fade defaults to inner-to-outer (across)', () => {
    expect(strokeFadeOf({})).toBe('across')
    expect(strokeFadeOf({ fade: 'along' })).toBe('along')
    expect(strokeFadeOf({ fade: 'sideways' as any })).toBe('across')
  })
  it('repeats are a whole number from 1 to 50, default 4', () => {
    expect(DEFAULT_FADE_REPEATS).toBe(4)
    expect(strokeFadeRepeatsOf({})).toBe(4)
    expect(strokeFadeRepeatsOf({ fadeRepeats: 2.6 })).toBe(3)
    expect(strokeFadeRepeatsOf({ fadeRepeats: 0 })).toBe(1)
    expect(strokeFadeRepeatsOf({ fadeRepeats: 999 })).toBe(50)
    expect(strokeFadeRepeatsOf({ fadeRepeats: NaN })).toBe(4)
  })
  it('the new fields survive a stack read', () => {
    const layer = { kind: 'rect', strokes: [stroke({ follow: true, fade: 'along', fadeRepeats: 6 })] }
    const [st] = strokeStackOf(layer as any)
    expect(st!.follow).toBe(true)
    expect(st!.fade).toBe('along')
    expect(st!.fadeRepeats).toBe(6)
  })
})

describe('paintCanFollow', () => {
  it('patterns and gradients can follow; flat colours, foil, shader and images cannot', () => {
    expect(paintCanFollow(grid as any)).toBe(true)
    expect(paintCanFollow(ombre as any)).toBe(true)
    expect(paintCanFollow({ ...grid, type: 'stripes' } as any)).toBe(true)
    expect(paintCanFollow({ type: 'linear', angle: 0, stops: [{ offset: 0, color: '#f00' }] })).toBe(true)
    expect(paintCanFollow({ type: 'linear', angle: 0, stops: [] })).toBe(false)
    expect(paintCanFollow('#ff0000')).toBe(false)
    expect(paintCanFollow({ ...grid, type: 'solid' } as any)).toBe(false)
    expect(paintCanFollow({ ...grid, type: 'shader' } as any)).toBe(false)
    expect(paintCanFollow({ type: 'foil', metal: 'gold', brushed: 0.5, pressed: 0.5, grain: 0.4 } as any)).toBe(false)
    expect(paintCanFollow(undefined)).toBe(false)
  })
})

describe('inspector rows', () => {
  it('the three rows sit straight after Colour', () => {
    expect(STROKE_ROW_ORDER.slice(0, 4)).toEqual(['paint', 'follow', 'fade', 'fadeRepeats'])
  })
  it('Fill row: band stroke, real outline, followable paint', () => {
    expect(strokeInspectorRows('rect', stroke())).toContain('follow')
    expect(strokeInspectorRows('path', stroke())).toContain('follow')
    expect(strokeInspectorRows('text', stroke())).not.toContain('follow')
    expect(strokeInspectorRows('rect', stroke({ paint: '#f00' }))).not.toContain('follow')
    expect(strokeInspectorRows('rect', stroke({ style: 'shapes' }))).not.toContain('follow')
  })
  it('Ombre fades: only when following with an ombre fill', () => {
    expect(strokeInspectorRows('ellipse', stroke({ paint: ombre as any }))).not.toContain('fade')
    expect(strokeInspectorRows('ellipse', stroke({ paint: ombre as any, follow: true }))).toContain('fade')
    expect(strokeInspectorRows('ellipse', stroke({ follow: true }))).not.toContain('fade')
  })
  it('Repeats: only for an along-the-line fade', () => {
    const rows = (o: Partial<StrokeInstance>) => strokeInspectorRows('ellipse', stroke({ paint: ombre as any, follow: true, ...o }))
    expect(rows({})).not.toContain('fadeRepeats')
    expect(rows({ fade: 'along' })).toContain('fadeRepeats')
  })
  it('labels are sentence case and never identifiers', () => {
    expect(STROKE_FOLLOW_OPTIONS).toEqual([
      { value: 'still', label: 'Stays put' },
      { value: 'follow', label: 'Follows the line' },
    ])
    expect(STROKE_FADE_OPTIONS).toEqual([
      { value: 'across', label: 'Inner to outer edge' },
      { value: 'along', label: 'Along the line' },
    ])
  })
  it('turning follow off removes the field rather than storing false', () => {
    expect(strokeFollowPatch(true)).toEqual({ follow: true })
    expect(strokeFollowPatch(false)).toEqual({ follow: undefined })
  })
})
