import { describe, it, expect } from 'vitest'
import { rampColour } from '~/lib/color/ramp'
import { mixHex } from '~/lib/color/mix'
import type { Paint } from '~/lib/compositor/paint'

describe('rampColour', () => {
  it('returns the stops exactly at t = 0 and t = 1', () => {
    expect(rampColour(['#ff00aa', '#00ffaa'], 0)).toBe('#ff00aa')
    expect(rampColour(['#ff00aa', '#00ffaa'], 1)).toBe('#00ffaa')
  })
  it('two stops: t = 0.5 is the perceptual midpoint the shared mixer gives', () => {
    expect(rampColour(['#ff00aa', '#00ffaa'], 0.5)).toBe(mixHex('#ff00aa', '#00ffaa', 0.5))
  })
  it('three stops: t = 0.5 is exactly the middle stop, t = 0.25 mixes the first pair', () => {
    expect(rampColour(['#000000', '#ff0000', '#ffffff'], 0.5)).toBe('#ff0000')
    expect(rampColour(['#000000', '#ff0000', '#ffffff'], 0.25)).toBe(mixHex('#000000', '#ff0000', 0.5))
  })
  it('a non-solid stop is used as-is at its nearest position, never interpolated', () => {
    const grad = { type: 'linear', angle: 0, stops: [] } as unknown as Paint
    expect(rampColour(['#000000', grad], 0.2)).toBe('#000000')
    expect(rampColour(['#000000', grad], 0.8)).toBe(grad)
  })
  it('clamps t and tolerates a single stop', () => {
    expect(rampColour(['#123456'], 0.7)).toBe('#123456')
    expect(rampColour(['#000000', '#ffffff'], 2)).toBe('#ffffff')
    expect(rampColour(['#000000', '#ffffff'], -1)).toBe('#000000')
  })
  it('returns a neutral grey for an empty list', () => {
    expect(rampColour([], 0.5)).toBe('#808080')
  })
})
