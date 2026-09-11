import { describe, expect, it } from 'vitest'
import { falImageSize } from '../../server/utils/falImageSize'

describe('falImageSize', () => {
  it('maps the common ratios to fal presets at the default size', () => {
    expect(falImageSize('1:1')).toBe('square_hd')
    expect(falImageSize('16:9')).toBe('landscape_16_9')
    expect(falImageSize('9:16')).toBe('portrait_16_9')
    expect(falImageSize('4:3')).toBe('landscape_4_3')
    expect(falImageSize('3:4')).toBe('portrait_4_3')
    expect(falImageSize(undefined)).toBe('square_hd')
  })
  it('builds a 16-aligned box for other ratios, long side first', () => {
    expect(falImageSize('3:2')).toEqual({ width: 1024, height: 688 })
    expect(falImageSize('2:3')).toEqual({ width: 688, height: 1024 })
    expect(falImageSize('21:9')).toEqual({ width: 1024, height: 432 })
  })
  it('uses an explicit box for every ratio once the long side is not the default', () => {
    expect(falImageSize('1:1', 3200)).toEqual({ width: 3200, height: 3200 })
    expect(falImageSize('16:9', 3200)).toEqual({ width: 3200, height: 1808 })
    expect(falImageSize('21:9', 3200)).toEqual({ width: 3200, height: 1376 })
  })
  it('treats garbage as square', () => {
    expect(falImageSize('wide')).toBe('square_hd')
    expect(falImageSize('0:5', 2048)).toEqual({ width: 2048, height: 2048 })
  })
})
