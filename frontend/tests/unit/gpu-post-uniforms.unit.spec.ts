import { describe, it, expect } from 'vitest'
import { uniformSetter } from '~/lib/compositor/gpuPost'

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
