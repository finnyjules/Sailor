// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { paintStill, ANIMATED_STILLS, stillRendererFor } from '../../app/lib/startModal/stills'

describe('start modal stills', () => {
  it('AI tiles have no renderer (they use shipped pictures)', () => {
    for (const id of ['gen', 'style', 'edit', 'upscale', 'video'] as const) expect(stillRendererFor(id)).toBeNull()
  })

  it('every studio tile has a renderer', () => {
    for (const id of ['expressive', 'gradient', 'shader', 'pattern', 'shape', 'vectortype', 'scene3d', 'moodboard'] as const) {
      expect(stillRendererFor(id), id).toBeTypeOf('function')
    }
  })

  it('only synchronous, time-driven studios animate on hover', () => {
    expect([...ANIMATED_STILLS].sort()).toEqual(['expressive', 'gradient', 'pattern', 'vectortype'])
  })

  it('a failed still reports false and logs the studio name — no fake picture', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const canvas = document.createElement('canvas')
    const ok = await paintStill('gradient', canvas, 0, { gradient: () => { throw new Error('no WebGL') } })
    expect(ok).toBe(false)
    expect(err.mock.calls[0]!.join(' ')).toMatch(/gradient/)
    err.mockRestore()
  })

  it('a working still reports true', async () => {
    const canvas = document.createElement('canvas')
    const draw = vi.fn()
    expect(await paintStill('shape', canvas, 0, { shape: draw })).toBe(true)
    expect(draw).toHaveBeenCalledWith(canvas, 0)
  })
})
