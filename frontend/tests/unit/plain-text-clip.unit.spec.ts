import { describe, it, expect } from 'vitest'
import { wrapPlainText, layoutPlainText } from '../../app/lib/engine/plainTextClip'

const measure = (s: string) => s.length * 10   // 10 px per character

describe('wrapPlainText (Python _wrap)', () => {
  it('wraps greedily at spaces, never breaks a single long word', () => {
    expect(wrapPlainText('aa bb cc', 50, measure)).toEqual(['aa bb', 'cc'])
    expect(wrapPlainText('abcdefghij xy', 50, measure)).toEqual(['abcdefghij', 'xy'])
  })
  it('keeps explicit line breaks; a trailing newline adds no line; empty text is one empty line', () => {
    expect(wrapPlainText('a\nb', 999, measure)).toEqual(['a', 'b'])
    expect(wrapPlainText('a\n', 999, measure)).toEqual(['a'])
    expect(wrapPlainText('', 999, measure)).toEqual([''])
  })
})

describe('layoutPlainText (Python render_text_to_pil)', () => {
  const spec = { text: 'ab cd', font_size: 40, color: '#ff0000', bg_color: '#000000', align: 'center', v_align: 'middle', padding: 0.1, line_spacing: 1.5 } as const

  it('insets by W×padding and H×padding (truncated), wraps within them', () => {
    // W 100 → inset 10, maxW 80: 'ab cd' is 50 px, one line
    const l = layoutPlainText(spec, 100, 60, measure, 20)
    expect(l.lines.map(x => x.text)).toEqual(['ab cd'])
    expect(l.lineHeight).toBe(30)                      // 20 × 1.5
  })

  it('middle: block centred; center: line centred', () => {
    const l = layoutPlainText(spec, 100, 60, measure, 20)
    expect(l.lines[0]).toEqual({ text: 'ab cd', x: 25, y: 15 })   // (100-50)/2, (60-30)/2
  })

  it('top / bottom / left / right', () => {
    expect(layoutPlainText({ ...spec, v_align: 'top', align: 'left' }, 100, 60, measure, 20).lines[0]).toEqual({ text: 'ab cd', x: 10, y: 6 })
    expect(layoutPlainText({ ...spec, v_align: 'bottom', align: 'right' }, 100, 60, measure, 20).lines[0]).toEqual({ text: 'ab cd', x: 40, y: 24 })
  })

  it('font string, colours, and Python defaults for missing fields', () => {
    const l = layoutPlainText({ text: 'x' }, 200, 100, measure, 10)
    expect(l.font).toMatch(/^72px /)
    expect([l.color, l.bg]).toEqual(['#ffffff', '#000000'])
    expect(l.lineHeight).toBeCloseTo(12, 10)            // 10 × 1.2
  })
})
