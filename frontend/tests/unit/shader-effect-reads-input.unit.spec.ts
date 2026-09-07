import { describe, it, expect, beforeAll } from 'vitest'
import { setShaderFxCatalog, effectReadsInput } from '~/lib/shaderfx/catalogStore'

const CATALOG = {
  effects: [
    { id: 'plasma', name: 'Plasma', source: 'void main(){ gl_FragColor = vec4(1.0); }', generative: true },
    { id: 'liquify', name: 'Liquify', source: 'void main(){ gl_FragColor = texture(u_image0, v_texCoord + off); }' },
    { id: 'blinds', name: 'Textured Glass', source: 'vec4 c = texture(u_image0, uv);' },
  ],
} as any

describe('effectReadsInput', () => {
  beforeAll(() => setShaderFxCatalog(CATALOG))
  it('is false for purely generative effects', () => {
    expect(effectReadsInput('plasma')).toBe(false)
  })
  it('is true for input-sampling distortion effects', () => {
    expect(effectReadsInput('liquify')).toBe(true)
    expect(effectReadsInput('blinds')).toBe(true)
  })
  it('is false for unknown ids', () => {
    expect(effectReadsInput('nope')).toBe(false)
  })
})
