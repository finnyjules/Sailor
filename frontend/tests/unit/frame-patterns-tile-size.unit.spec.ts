import { describe, it, expect } from 'vitest'
import { tileSize } from '~/lib/frame/patterns/tileSize'
describe('tileSize', () => {
  it('fits a portrait frame by height and a landscape frame by width', () => {
    expect(tileSize(800, 1000, 120, 120)).toEqual({ w: 96, h: 120 })
    expect(tileSize(1920, 1080, 120, 120)).toEqual({ w: 120, h: 68 })   // 120 * 1080/1920 = 67.5 → 68
  })
  it('never returns less than 1px and copes with a zero frame', () => {
    expect(tileSize(0, 0, 120, 120)).toEqual({ w: 1, h: 1 })
  })
})
