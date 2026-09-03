import { describe, it, expect } from 'vitest'
import {
  slug, displayName, parsePath, serializePath, parseTransform, applyMatrix, pathBounds,
  elementToPath, parseShapeSvg,
} from '../../scripts/shapeLibrary.mjs'

describe('slug / displayName', () => {
  it('lowercases, collapses runs, strips .svg', () => {
    expect(slug('Sun Rays.svg')).toBe('sun-rays')
    expect(slug('triangle-double .svg')).toBe('triangle-double')
    expect(displayName('sun-rays')).toBe('Sun rays')
  })
})

describe('parsePath', () => {
  it('normalises relative h/v/l/c/s to absolute M L C Z', () => {
    const cmds = parsePath('M10,10h20v20h-20Z')
    expect(cmds).toEqual([
      { c: 'M', p: [10, 10] }, { c: 'L', p: [30, 10] }, { c: 'L', p: [30, 30] }, { c: 'L', p: [10, 30] }, { c: 'Z', p: [] },
    ])
  })
  it('treats numbers after M as implicit L', () => {
    expect(parsePath('M0,0 10,0 10,10Z').map(c => c.c)).toEqual(['M', 'L', 'L', 'Z'])
  })
  it('reflects the control point for S after C', () => {
    const cmds = parsePath('M0,0C0,10,10,10,10,0S20,-10,20,0')
    expect(cmds[2]).toEqual({ c: 'C', p: [10, -10, 20, -10, 20, 0] })
  })
  it('rejects arcs and quadratics', () => {
    expect(() => parsePath('M0,0A5,5 0 0 1 10,10')).toThrow(/unsupported path command "A"/)
    expect(() => parsePath('M0,0Q5,5 10,10')).toThrow(/unsupported path command "Q"/)
  })
  it('serialises with 2-decimal numbers and no separators between commands', () => {
    expect(serializePath(parsePath('M1.23456,2.5l1,1Z'))).toBe('M1.23,2.5L2.23,3.5Z')
  })
})

describe('transforms', () => {
  it('composes translate then rotate in SVG order', () => {
    const m = parseTransform('translate(10 0) rotate(90)')
    const [{ p }] = applyMatrix([{ c: 'M', p: [1, 0] }], m)
    expect(p[0]).toBeCloseTo(10, 6)
    expect(p[1]).toBeCloseTo(1, 6)
  })
  it('identity for an empty transform', () => {
    expect(parseTransform('')).toEqual([1, 0, 0, 1, 0, 0])
  })
})

describe('pathBounds', () => {
  it('bounds a rectangle exactly', () => {
    expect(pathBounds(parsePath('M8,8h80v80h-80Z'))).toEqual([8, 8, 80, 80])
  })
  it('bounds a cubic by sampling (circle of r=44 at 48,48)', () => {
    const d = elementToPath('circle', { cx: '48', cy: '48', r: '44' })
    const [x, y, w, h] = pathBounds(parsePath(d))
    expect(x).toBeCloseTo(4, 1); expect(y).toBeCloseTo(4, 1)
    expect(w).toBeCloseTo(88, 1); expect(h).toBeCloseTo(88, 1)
  })
})

describe('elementToPath', () => {
  it('polygon → closed polyline', () => {
    expect(elementToPath('polygon', { points: '48 4 14 28 48 92' })).toBe('M48,4L14,28L48,92Z')
  })
  it('rect → four sides', () => {
    expect(elementToPath('rect', { x: '8', y: '8', width: '80', height: '80' })).toBe('M8,8h80v80h-80Z')
  })
  it('rejects unknown elements and rounded rects', () => {
    expect(() => elementToPath('g', {})).toThrow(/unsupported element <g>/)
    expect(() => elementToPath('rect', { x: '0', y: '0', width: '1', height: '1', rx: '2' })).toThrow(/rx/)
  })
})

describe('parseShapeSvg', () => {
  const svg = (inner: string) =>
    `<?xml version="1.0" encoding="UTF-8"?><svg id="a" xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">${inner}</svg>`
  it('parses a single filled path', () => {
    const s = parseShapeSvg(svg('<path d="M8,8h80v80h-80Z" fill="#9b86bd" stroke-width="0"/>'), 'square.svg')
    expect(s).toEqual({ d: 'M8,8L88,8L88,88L8,88Z', fillRule: 'nonzero', box: [8, 8, 80, 80], sourceColor: '#9b86bd' })
  })
  it('applies an element transform (the rhombus rect)', () => {
    const s = parseShapeSvg(svg('<rect x="16.8873" y="16.8873" width="62.2254" height="62.2254" transform="translate(-19.8822 48) rotate(-45)" fill="#ff7f3e"/>'), 'rhombus.svg')
    const [x, y, w, h] = s.box
    expect(x).toBeCloseTo(4, 0); expect(y).toBeCloseTo(4, 0)
    expect(w).toBeCloseTo(88, 0); expect(h).toBeCloseTo(88, 0)
  })
  it('concatenates multiple elements and keeps the first fill', () => {
    const s = parseShapeSvg(svg('<path d="M0,0h10v10Z" fill="#111"/><polygon points="20 20 30 20 30 30" fill="#222"/>'), 'two.svg')
    expect(s.d).toBe('M0,0L10,0L10,10ZM20,20L30,20L30,30Z')
    expect(s.sourceColor).toBe('#111')
  })
  it('requires the 96 box', () => {
    expect(() => parseShapeSvg('<svg viewBox="0 0 24 24"><path d="M0,0Z"/></svg>', 'x.svg')).toThrow(/viewBox/)
  })
})
