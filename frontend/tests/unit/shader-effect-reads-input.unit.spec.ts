import { describe, it, expect, beforeAll } from 'vitest'
import { setShaderFxCatalog, effectReadsInput } from '~/lib/shaderfx/catalogStore'

const CATALOG = {
  effects: [
    // Realistic generative fixture: like the real generative shaders (aurora,
    // plasma, starfield, ...) this DECLARES `uniform sampler2D u_image0;` as
    // GLSL boilerplate but never actually samples it. A bare-mention regex
    // (`/\bu_image0\b/`) matches this declaration and wrongly reports `true` —
    // this fixture is the control that would catch a regression back to that.
    { id: 'plasma', name: 'Plasma', source: 'uniform sampler2D u_image0;\nvoid main(){ gl_FragColor = vec4(0.2,0.4,0.9,1.0); }', generative: true },
    { id: 'liquify', name: 'Liquify', source: 'uniform sampler2D u_image0;\nvoid main(){ gl_FragColor = texture(u_image0, v_texCoord + off); }' },
    { id: 'blinds', name: 'Textured Glass', source: 'uniform sampler2D u_image0;\nvec4 c = texture(u_image0, uv);' },
  ],
} as any

describe('effectReadsInput', () => {
  beforeAll(() => setShaderFxCatalog(CATALOG))
  it('is false for a generative effect that only declares u_image0 without sampling it', () => {
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
