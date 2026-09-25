import { describe, expect, it } from 'vitest'
import {
  assembleSource,
  LIMITS,
  PREAMBLE_UNIFORMS,
  SHADERGEN_HELPERS,
  SHADERGEN_PREAMBLE,
  SHADERGEN_TAKE_SCHEMA,
} from '~~/shared/shadergen/contract'
import { SHADERGEN_SYSTEM } from '~~/shared/shadergen/system'
import { SPIKE_PREFIX, SPIKE_TAKES } from '~/lib/shadergen/__eval__/spikeTakes'
import { EVAL_REQUESTS } from '~/lib/shadergen/__eval__/requests'

describe('shadergen contract', () => {
  it('preamble + helpers are byte-identical to what the spike takes were rendered with', () => {
    expect(SHADERGEN_PREAMBLE + SHADERGEN_HELPERS).toBe(SPIKE_PREFIX)
  })

  it('assembleSource wraps a body in the preamble and helpers exactly once', () => {
    const src = assembleSource('\n  void main(){ fragColor0 = vec4(1.0); }\n')
    expect(src.startsWith('#version 300 es\n')).toBe(true)
    expect(src.split('#version').length - 1).toBe(1)
    expect(src.split('float h21(').length - 1).toBe(1)
    expect(src.endsWith('void main(){ fragColor0 = vec4(1.0); }\n')).toBe(true)
  })

  it('the take schema requires every field the engine reads', () => {
    expect(SHADERGEN_TAKE_SCHEMA.required).toEqual(['name', 'animated', 'generative', 'params', 'body'])
    expect(SHADERGEN_TAKE_SCHEMA.properties.params.items.properties.type.enum).toEqual(['float', 'enum', 'color'])
  })

  it('the system prompt states the same limits the checks enforce', () => {
    expect(SHADERGEN_SYSTEM).toContain(`${LIMITS.minParams} to ${LIMITS.maxParams} dials`)
    expect(SHADERGEN_SYSTEM).toContain(`at most ${LIMITS.maxLoopIterations} iterations`)
    expect(SHADERGEN_SYSTEM).toContain(`At most ${LIMITS.maxLoopTextureReads} image reads`)
  })

  it('the preamble hands every effect its loop length, and helpers to loop over it seamlessly', () => {
    expect(SHADERGEN_PREAMBLE).toContain('uniform float u_loop;')
    expect(PREAMBLE_UNIFORMS).toContain('u_loop')
    expect(SHADERGEN_HELPERS).toContain('float LOOP(){ return u_loop > 0.0 ? u_loop : 4.0; }')
    expect(SHADERGEN_HELPERS).toContain('float loopPhase(){ return fract(u_time / LOOP()); }')
    expect(SHADERGEN_HELPERS).toMatch(/vec2 loopCircle\(float radius\)\{[^}]*6\.28318[^}]*loopPhase\(\)[^}]*\}/)
    // The spike's own helpers are all still there, unchanged.
    for (const name of ['h21', 'vnoise', 'fbm', 'tex', 'blur9', 'luma', 'ASP', 'hsv2rgb', 'thinfilm']) expect(SHADERGEN_HELPERS).toMatch(new RegExp(`\\b${name}\\(`))
  })

  it('the system prompt asks for motion that repeats seamlessly over LOOP()', () => {
    expect(SHADERGEN_SYSTEM).toContain('uniform float u_loop;')
    expect(SHADERGEN_SYSTEM).toContain('float LOOP()')
    expect(SHADERGEN_SYSTEM).toContain('float loopPhase()')
    expect(SHADERGEN_SYSTEM).toContain('vec2 loopCircle(float radius)')
    expect(SHADERGEN_SYSTEM).toMatch(/repeat seamlessly/)
    expect(SHADERGEN_SYSTEM).toMatch(/whole cycles/)
    expect(SHADERGEN_SYSTEM).toMatch(/never .*raw u_time/i)
  })

  it('the fixture holds 4 spike takes for each of the 6 requests', () => {
    expect(EVAL_REQUESTS.map(r => r.key)).toEqual(Object.keys(SPIKE_TAKES))
    for (const r of EVAL_REQUESTS) expect(SPIKE_TAKES[r.key]).toHaveLength(4)
  })
})
