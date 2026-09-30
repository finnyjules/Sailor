import { describe, it, expect } from 'vitest'
import { uniformSetter, isFloatDepth, needsUpload } from '~/lib/compositor/gpuPost'

describe('uniformSetter', () => {
  it('keeps every existing DOF convention', () => {
    expect(uniformSetter('uOffsets', new Float32Array(96))).toBe('2fv')
    expect(uniformSetter('uTapCount', 48)).toBe('1i')
    expect(uniformSetter('uFocus', 0.5)).toBe('1f')
    expect(uniformSetter('uOther', 3)).toBe('1f')   // integers are floats unless named uTapCount
  })
  it('sends a { vec3 } wrapper as a vec3', () => {
    expect(uniformSetter('uM0', { vec3: [1, 0.5, 0] })).toBe('3f')
  })
})

describe('isFloatDepth', () => {
  it('tells a float field from an image', () => {
    expect(isFloatDepth({ kind: 'float', width: 1, height: 1, data: new Float32Array(1) })).toBe(true)
    expect(isFloatDepth({ width: 1, height: 1 })).toBe(false)
    expect(isFloatDepth(null)).toBe(false)
  })
})

describe('needsUpload', () => {
  it('same object → false, different → true, null last → true', () => {
    const a = {} as CanvasImageSource
    const b = {} as CanvasImageSource
    expect(needsUpload(a, a)).toBe(false)
    expect(needsUpload(a, b)).toBe(true)
    expect(needsUpload(null, a)).toBe(true)
  })
})
