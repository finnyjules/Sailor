import { describe, it, expect } from 'vitest'
import { getLayout, SHOWCASE_LAYOUTS } from '~/lib/spacetype/layouts/index'
import { ringTransform } from '~/lib/spacetype/ringLayout'

const P = { radius: 5, ringTilt: -0.28, cardSize: 1.4, speed: 1, direction: 'cw' }

describe('showcase layouts registry', () => {
  it('ring is the first (default/fallback) layout', () => {
    expect(SHOWCASE_LAYOUTS[0]!.id).toBe('ring')
    expect(getLayout('nope').id).toBe('ring')       // unknown → ring fallback
    expect(getLayout('RING').id).toBe('ring')        // case-insensitive
  })
  it('ring layout place() equals ringTransform (parity)', () => {
    const layout = getLayout('ring')
    for (const i of [0, 1, 3]) for (const t of [0, 0.25, 1]) {
      const a = layout.place(i, 5, P as any, t)
      const b = ringTransform(i, 5, { radius: 5, ringTilt: -0.28, cardSize: 1.4, speed: 1, direction: 1 }, t)
      expect(a.x).toBeCloseTo(b.x, 9); expect(a.z).toBeCloseTo(b.z, 9)
      expect(a.rotY).toBeCloseTo(b.rotY, 9); expect(a.scale).toBeCloseTo(b.scale, 9)
    }
  })
  it('ring layout declares its own controls (radius/ringTilt/ringOpening), ungated — the entry is the layout', () => {
    const c = getLayout('ring').controls
    expect(c.map(x => x.key).sort()).toEqual(['radius', 'ringOpening', 'ringTilt'])
    expect(c.every(x => (x as any).showIf === undefined)).toBe(true)
  })
})
