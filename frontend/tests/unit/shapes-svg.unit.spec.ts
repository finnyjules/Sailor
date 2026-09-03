import { describe, it, expect } from 'vitest'
import { shapeToSvg } from '../../app/lib/shapes/svg'
import { shapeById } from '../../app/lib/shapes/catalog'
import type { LibraryShape } from '../../shared/shape-library'

const tall: LibraryShape = { id: 'tall', name: 'Tall', d: 'M10,10L30,10L30,50L10,50Z', fillRule: 'evenodd', box: [10, 10, 20, 40], sourceColor: '#123456' }

describe('shapeToSvg', () => {
  it('wraps the manifest path in a 96-box SVG with the source colour and fill rule', () => {
    const svg = shapeToSvg(tall)
    expect(svg).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96"><path d="M10,10L30,10L30,50L10,50Z" fill="#123456" fill-rule="evenodd"/></svg>')
  })
  it('takes a fill override', () => {
    expect(shapeToSvg(tall, { fill: '#ffffff' })).toContain('fill="#ffffff"')
    expect(shapeToSvg(tall, { fill: '#ffffff' })).not.toContain('#123456')
  })
  it('round-trips a real manifest shape', () => {
    const s = shapeById('sparkle')!
    const svg = shapeToSvg(s)
    expect(svg).toContain(`d="${s.d}"`)
    expect(svg).toContain(`fill="${s.sourceColor}"`)
    expect(svg.startsWith('<svg ')).toBe(true); expect(svg.endsWith('</svg>')).toBe(true)
  })
})
