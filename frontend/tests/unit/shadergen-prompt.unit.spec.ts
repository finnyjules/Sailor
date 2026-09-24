import { describe, expect, it } from 'vitest'
import type { GenTake } from '~~/shared/shadergen/contract'
import { SHADERGEN_HELPERS, SHADERGEN_PREAMBLE } from '~~/shared/shadergen/contract'
import { buildGenPrompt, buildRepairPrompt, buildReviewPrompt, buildRevisePrompt, parseGenResponse, parseReview, rewriteCompileLog, TAKE_ANGLES } from '~/lib/shadergen/prompt'

const reply = (over: Record<string, unknown> = {}) => JSON.stringify({
  name: '  Fogged glass  ', animated: true, generative: false, body: 'void main(){}',
  params: [
    { uniform: 'u_fog', label: 'Fog', type: 'float', min: 0, max: 1, step: 0.01, default: 1.4 },
    { uniform: 'u_mode', label: 'Pattern', type: 'enum', default: 7, options: [{ label: 'Drops', value: 0 }, { label: 'Streaks', value: 1 }] },
    { uniform: 'u_tint', label: 'Tint', type: 'color', default: '#FF7A3D' },
  ],
  ...over,
})

describe('buildGenPrompt', () => {
  it('states the request and the take angle', () => {
    const p = buildGenPrompt({ request: 'rain on a window', takeIndex: 2 })
    expect(p).toContain('Request: "rain on a window"')
    expect(p).toContain(TAKE_ANGLES[2])
    expect(p).not.toContain('Start from this existing effect')
  })

  it('includes a base effect with its source and dials', () => {
    const p = buildGenPrompt({ request: 'rain', takeIndex: 0, base: { name: 'Water Ripple', source: 'void main(){ /*ripple*/ }', params: [] } })
    expect(p).toContain('Start from this existing effect, "Water Ripple"')
    expect(p).toContain('/*ripple*/')
  })

  it('includes references and what to avoid', () => {
    const p = buildGenPrompt({ request: 'rain', takeIndex: 1, references: [{ name: 'Fbm Warp', source: 'REF_SRC', params: [] }], avoid: 'the render was black' })
    expect(p).toContain('"Fbm Warp"')
    expect(p).toContain('REF_SRC')
    expect(p).toContain('A previous attempt failed: the render was black')
  })

  it('sends a base or reference source without the lines Sailor supplies, and warns about the helpers', () => {
    const src = `#version 300 es\nprecision highp float;\nuniform sampler2D  u_image0;\nuniform vec2 u_resolution;\nuniform float u_time;\nuniform float u_seed;\nin vec2 v_texCoord;\nlayout( location=0 ) out vec4 fragColor0;\nuniform float u_amount;\nvoid main(){ /*ripple*/ }`
    const p = buildGenPrompt({ request: 'rain', takeIndex: 0, base: { name: 'Water Ripple', source: src, params: [] }, references: [{ name: 'Fbm Warp', source: src.replace('ripple', 'warp'), params: [] }] })
    expect(p).not.toContain('#version 300 es')
    expect(p).not.toContain('uniform float u_time;')
    expect(p).not.toContain('precision highp float')
    expect(p).not.toContain('fragColor0;')
    expect(p).toContain('uniform float u_amount;')
    expect(p).toContain('/*ripple*/')
    expect(p).toContain('/*warp*/')
    const warning = 'Sailor already provides the preamble and the helpers h21, vnoise, fbm, tex, blur9, luma, ASP, hsv2rgb and thinfilm; if this source defines functions with those names, rename or drop them — redefining them will not compile.'
    expect(p.split(warning).length - 1).toBe(2)
  })

  it('repair prompts carry the reason and the rejected body', () => {
    const failed: GenTake = { name: 'X', animated: false, generative: false, params: [], body: 'BROKEN_BODY' }
    const p = buildRepairPrompt({ request: 'rain', takeIndex: 0 }, failed, "it did not compile:\nERROR: 0:12: 'foo' : undeclared")
    expect(p).toContain('was rejected: it did not compile')
    expect(p).toContain('BROKEN_BODY')
  })

  it('includes examples of other requests that met the quality bar, after base/references and before the take angle', () => {
    const example1: GenTake = { name: 'Suminagashi', animated: true, generative: true, params: [{ uniform: 'u_rings', label: 'Rings', type: 'float', min: 2, max: 30, step: 0.5, default: 12 }], body: 'EXAMPLE_ONE_BODY' }
    const example2: GenTake = { name: '70s lamp', animated: true, generative: true, params: [{ uniform: 'u_speed', label: 'Speed', type: 'float', min: 0, max: 2, step: 0.01, default: 0.6 }], body: 'EXAMPLE_TWO_BODY' }
    const p = buildGenPrompt({
      request: 'rain',
      takeIndex: 0,
      base: { name: 'Water Ripple', source: 'void main(){ /*ripple*/ }', params: [] },
      examples: [
        { name: 'ink', request: 'Ink bleeding into wet paper', take: example1 },
        { name: 'lava', request: 'Make it a slow lava lamp', take: example2 },
      ],
    })
    expect(p).toContain('Two effects that met the quality bar for other requests — match this level of craft (considered defaults, restraint, readable subject), not their look:')
    expect(p).toContain('Ink bleeding into wet paper')
    expect(p).toContain('(ink)')
    expect(p).toContain('Suminagashi')
    expect(p).toContain('EXAMPLE_ONE_BODY')
    expect(p).toContain(JSON.stringify(example1.params))
    expect(p).toContain('Make it a slow lava lamp')
    expect(p).toContain('70s lamp')
    expect(p).toContain('EXAMPLE_TWO_BODY')
    // ordering: after base, before the take angle
    expect(p.indexOf('Start from this existing effect')).toBeLessThan(p.indexOf('quality bar for other requests'))
    expect(p.indexOf('quality bar for other requests')).toBeLessThan(p.indexOf(TAKE_ANGLES[0]))
  })
})

describe('buildRevisePrompt', () => {
  it('shows the current take and asks for the whole improved JSON object', () => {
    const take: GenTake = {
      name: 'Droplets',
      animated: true,
      generative: false,
      params: [{ uniform: 'u_density', label: 'Drop count', type: 'float', min: 3, max: 20, step: 0.5, default: 8 }],
      body: 'CURRENT_BODY',
    }
    const p = buildRevisePrompt({ request: 'rain on a window', takeIndex: 0 }, take)
    expect(p).toContain('Request: "rain on a window"')
    expect(p).toContain('The attached image is a render of your effect below, on the test photo, with its default dials.')
    expect(p).toContain('Return the whole improved JSON object.')
    expect(p).toContain('CURRENT_BODY')
    expect(p).toContain(JSON.stringify(take.params))
  })
})

describe('rewriteCompileLog', () => {
  it('drops the renderer prefix and renumbers lines to the body', () => {
    const offset = `${SHADERGEN_PREAMBLE}${SHADERGEN_HELPERS}\n`.split('\n').length - 1
    const log = `shaderfx compile (shadergen_3): ERROR: 0:${offset + 4}: 'foo' : undeclared identifier\nWARNING: 0:${offset + 12}: something\nERROR: 0:3: 'u_time' : redefinition`
    expect(rewriteCompileLog(log)).toBe("ERROR: body line 4: 'foo' : undeclared identifier\nWARNING: body line 12: something\nERROR: in Sailor's preamble: 'u_time' : redefinition")
  })

  it('leaves a log without line numbers alone', () => {
    expect(rewriteCompileLog('link failed')).toBe('link failed')
  })
})

describe('parseGenResponse', () => {
  it('reads a valid reply, trimming the name and fixing out-of-range defaults', () => {
    const t = parseGenResponse(reply())!
    expect(t.name).toBe('Fogged glass')
    expect(t.params[0]).toEqual({ uniform: 'u_fog', label: 'Fog', type: 'float', min: 0, max: 1, step: 0.01, default: 1 })
    expect(t.params[1]!.default).toBe(0)
    expect(t.params[2]!.default).toBe('#ff7a3d')
  })

  it('rejects malformed replies', () => {
    expect(parseGenResponse('not json')).toBeNull()
    expect(parseGenResponse(reply({ body: 5 }))).toBeNull()
    expect(parseGenResponse(reply({ params: [{ uniform: 'u_a', label: 'A', type: 'float', min: 1, max: 1, default: 1 }] }))).toBeNull()
    expect(parseGenResponse(reply({ params: [{ uniform: 'u_a', label: 'A', type: 'color', default: 'red' }] }))).toBeNull()
    expect(parseGenResponse(reply({ params: [{ uniform: 'u_a', label: 'A', type: 'enum', default: 0, options: [{ label: 'One', value: 0 }] }] }))).toBeNull()
    expect(parseGenResponse(reply({ params: [{ uniform: 'u_a', label: '   ', type: 'float', min: 0, max: 1, default: 0.5 }] }))).toBeNull()
  })

  it('gives a float without a usable step a hundredth of its range', () => {
    const t = parseGenResponse(reply({ params: [{ uniform: 'u_a', label: 'A', type: 'float', min: 0, max: 2, default: 1 }] }))!
    expect(t.params[0]!.step).toBe(0.02)
  })
})

describe('visual review', () => {
  it('asks for one verdict per take, left to right', () => {
    expect(buildReviewPrompt('rain on a window', 4)).toContain('exactly 4 booleans in left-to-right order')
  })

  it('reads verdicts, and keeps everything when the reply is unusable', () => {
    expect(parseReview('{"keep":[true,false,true,true],"reasons":["a","b","c","d"]}', 4)).toEqual([true, false, true, true])
    expect(parseReview('{"keep":[true,false]}', 4)).toEqual([true, true, true, true])
    expect(parseReview('nope', 3)).toEqual([true, true, true])
  })
})
