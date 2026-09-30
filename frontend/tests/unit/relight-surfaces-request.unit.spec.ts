import { describe, it, expect } from 'vitest'
import { relightSurfaceRefs } from '~/lib/relight/relightSurfaceRefs'

const relightFx = (visible = true) => ([
  { type: 'relight', visible, lights: [], keep: 0.35, depth: 4, texture: 2, shine: 0, shadows: false },
])

describe('relightSurfaceRefs', () => {
  it('excludes a layer whose Relight effect is hidden', () => {
    const layers = [{ kind: 'image', filename: 'a.png', effects: relightFx(false) }]
    expect(relightSurfaceRefs(layers)).toEqual([])
  })

  it('excludes a text layer even with a visible Relight effect', () => {
    const layers = [{ kind: 'text', effects: relightFx(true) }]
    expect(relightSurfaceRefs(layers)).toEqual([])
  })

  it('dedupes two layers of the same photo to one ref', () => {
    const layers = [
      { kind: 'image', filename: 'a.png', effects: relightFx(true) },
      { kind: 'image', filename: 'a.png', effects: relightFx(true) },
    ]
    expect(relightSurfaceRefs(layers)).toEqual(['a.png'])
  })

  it('resolves a wired layer through depthSourceFromViewUrl', () => {
    const layers = [
      { kind: 'wired', depthKey: '/view?filename=out.png&subfolder=x&type=output', effects: relightFx(true) },
    ]
    expect(relightSurfaceRefs(layers)).toEqual([{ filename: 'out.png', subfolder: 'x', type: 'output' }])
  })

  it('excludes a layer with no depth source (e.g. a live wired slot)', () => {
    const layers = [{ kind: 'wired', depthKey: 'live:1', effects: relightFx(true) }]
    expect(relightSurfaceRefs(layers)).toEqual([])
  })

  it('excludes a layer with no Relight effect at all', () => {
    const layers = [{ kind: 'image', filename: 'a.png', effects: [] }]
    expect(relightSurfaceRefs(layers)).toEqual([])
  })

  it('excludes a hidden layer even with a visible Relight effect — no paint ever reads it', () => {
    const layers = [{ kind: 'image', filename: 'a.png', visible: false, effects: relightFx(true) }]
    expect(relightSurfaceRefs(layers)).toEqual([])
  })
})
