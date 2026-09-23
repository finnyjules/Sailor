import { describe, it, expect } from 'vitest'
import { fitRect } from '~/lib/embed/frame/fit'
import { buildEmbedHtml } from '~/lib/embed/bundle'
import type { EmbedSnapshot } from '~/lib/embed/contract'

const base: EmbedSnapshot = {
  kind: 'shader', config: {}, duration: 4, width: 200, height: 100,
  posterDataUrl: 'data:image/png;base64,AA', transparent: false,
}
const snapJson = (html: string) => JSON.parse(/window\.__SAILOR_SNAPSHOT__ = (.*);\n/.exec(html)![1]!)

describe('fitRect', () => {
  it('fit: contained and centred', () => {
    expect(fitRect({ w: 400, h: 100 }, { w: 200, h: 100 }, 'fit')).toEqual({ x: 100, y: 0, w: 200, h: 100, scale: 1 })
  })
  it('fill: covers and crops the overflow evenly', () => {
    expect(fitRect({ w: 400, h: 100 }, { w: 200, h: 100 }, 'fill')).toEqual({ x: 0, y: -50, w: 400, h: 200, scale: 2 })
  })
  it('same shape: identity at the box scale', () => {
    expect(fitRect({ w: 400, h: 200 }, { w: 200, h: 100 }, 'fit')).toEqual({ x: 0, y: 0, w: 400, h: 200, scale: 2 })
  })
})

describe('buildEmbedHtml options', () => {
  it('a snapshot without the new fields carries none of them', () => {
    const j = snapJson(buildEmbedHtml(base, 'globalThis.__SAILOR_SURFACE__={}'))
    for (const k of ['framing', 'posterFit', 'still', 'backdrop']) expect(k in j).toBe(false)
  })

  it('the runtime hands a box-framed adapter the whole box', () => {
    const html = buildEmbedHtml({ ...base, framing: 'box' }, '')
    expect(html).toContain("snap.framing === 'box'")
  })

  it('cover poster fit is applied, anything else is contain', () => {
    expect(buildEmbedHtml({ ...base, posterFit: 'cover' }, '')).toContain('object-fit:cover')
    expect(buildEmbedHtml({ ...base, posterFit: 'nonsense' as any }, '')).toContain('object-fit:contain')
  })

  it('a still renders once and never starts the clock', () => {
    expect(buildEmbedHtml({ ...base, still: true }, '')).toContain('snap.still')
  })

  it('a hex backdrop colours the page; anything else falls back to black', () => {
    expect(buildEmbedHtml({ ...base, backdrop: '#12ab34' }, '')).toContain('background:#12ab34')
    const evil = buildEmbedHtml({ ...base, backdrop: 'red}</style><script>' }, '')
    expect(evil).toContain('background:#000')
    expect(evil).not.toContain('red}</style>')
  })

  it('transparent still wins over a backdrop', () => {
    expect(buildEmbedHtml({ ...base, transparent: true, backdrop: '#fff' }, '')).toContain('background:transparent')
  })
})
