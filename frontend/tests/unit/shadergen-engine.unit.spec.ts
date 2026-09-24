import { describe, expect, it } from 'vitest'
import { SHADERGEN_HELPERS, SHADERGEN_PREAMBLE, type GenTake } from '~~/shared/shadergen/contract'
import { ContextLostError, generateTakes, type TakeRenderer } from '~/lib/shadergen/engine'

const P = (u: string) => ({ uniform: u, label: 'Amount', type: 'float', min: 0, max: 1, step: 0.01, default: 0.5 })
const body = (marker = '') => `uniform float u_a; uniform float u_b; uniform float u_c;
void main(){ /*${marker}*/ fragColor0 = vec4(tex(v_texCoord)*u_a*u_b*u_c, 1.0); }`
const reply = (marker = '', name = 'Take') =>
  JSON.stringify({ name, animated: false, generative: false, params: [P('u_a'), P('u_b'), P('u_c')], body: body(marker) })

/** Scripted model: replies per take index, consumed in order; the last reply repeats. */
function scripted(byTake: Record<number, string[]>) {
  const prompts: string[][] = [[], [], [], []]
  const used: number[] = [0, 0, 0, 0]
  return {
    prompts,
    callModel: async (prompt: string) => {
      const i = Number(/Take (\d) of 4/.exec(prompt)![1]) - 1
      prompts[i]!.push(prompt)
      const list = byTake[i] ?? [reply('', `Take ${i + 1}`)]
      const text = list[Math.min(used[i]!, list.length - 1)]!
      used[i]!++
      return { text, usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: 'end_turn' }
    },
  }
}

/** Fake renderer: BROKEN doesn't compile, BLACK fails the checks. */
const renderer: TakeRenderer = {
  compile: (t: GenTake) => (t.body.includes('BROKEN') ? "ERROR: 0:9: 'x' : undeclared identifier" : null),
  judge: (t: GenTake) => (t.body.includes('BLACK') ? { pass: false, flags: ['black'], thumbnail: '' } : { pass: true, flags: [], thumbnail: `thumb:${t.name}` }),
  sheet: (takes: GenTake[]) => `sheet:${takes.length}`,
}

describe('generateTakes', () => {
  it('returns four takes from four clean replies, one call each, with usage summed', async () => {
    const m = scripted({})
    const r = await generateTakes({ request: 'rain' }, { callModel: m.callModel, renderer, now: () => 0 })
    expect(r.takes.map(t => t.take.name)).toEqual(['Take 1', 'Take 2', 'Take 3', 'Take 4'])
    expect(r.takes.every(t => t.modelCalls === 1)).toBe(true)
    expect(r.failures).toEqual([])
    expect(r.usage).toEqual({ input_tokens: 40, output_tokens: 20 })
  })

  it('repairs a compile error by sending the error back', async () => {
    const m = scripted({ 0: [reply('BROKEN'), reply('fixed')] })
    const r = await generateTakes({ request: 'rain' }, { callModel: m.callModel, renderer })
    expect(r.takes.find(t => t.take.body.includes('fixed'))!.modelCalls).toBe(2)
    expect(m.prompts[0]![1]).toContain('was rejected: it did not compile')
    expect(m.prompts[0]![1]).toContain('undeclared identifier')
  })

  it('gives up on a take after two compile repairs', async () => {
    const m = scripted({ 1: [reply('BROKEN')] })
    const r = await generateTakes({ request: 'rain' }, { callModel: m.callModel, renderer })
    expect(r.takes).toHaveLength(3)
    expect(r.failures).toEqual([expect.objectContaining({ index: 1, modelCalls: 3 })])
  })

  it('sends a static-check failure back once, then ends the take', async () => {
    const twoDials = JSON.stringify({ name: 'X', animated: false, generative: false, params: [P('u_a'), P('u_b')], body: 'uniform float u_a; uniform float u_b; void main(){ fragColor0=vec4(u_a*u_b); }' })
    const m = scripted({ 2: [twoDials] })
    const r = await generateTakes({ request: 'rain' }, { callModel: m.callModel, renderer })
    expect(r.takes).toHaveLength(3)
    expect(r.failures).toEqual([expect.objectContaining({ index: 2, modelCalls: 2 })])
    expect(r.failures[0]!.log.filter(l => l.startsWith('static:'))).toHaveLength(2)
  })

  it('asks again once after an unreadable reply, then ends the take', async () => {
    const m = scripted({ 0: ['not json'] })
    const r = await generateTakes({ request: 'rain' }, { callModel: m.callModel, renderer })
    expect(r.failures).toEqual([expect.objectContaining({ index: 0, modelCalls: 2, log: ['reply could not be read', 'reply could not be read'] })])
  })

  it('says when an unreadable reply was cut off at the token limit', async () => {
    const r = await generateTakes({ request: 'rain', count: 1 }, {
      callModel: async () => ({ text: '{"name":"Half', stop_reason: 'max_tokens' }),
      renderer,
    })
    expect(r.failures[0]!.log).toEqual(['reply was cut off (max tokens)', 'reply was cut off (max tokens)'])
  })

  it('counts cached prompt tokens as input', async () => {
    const r = await generateTakes({ request: 'rain', count: 1 }, {
      callModel: async () => ({ text: reply(), usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 } }),
      renderer,
    })
    expect(r.usage).toEqual({ input_tokens: 117, output_tokens: 5 })
  })

  it('ends a take whose model call fails, without retrying, and keeps the others', async () => {
    const m = scripted({})
    let calls = 0
    const r = await generateTakes({ request: 'rain' }, {
      callModel: async (prompt) => {
        calls++
        if (prompt.includes('Take 2 of 4')) throw new Error('429 Too Many Requests: rate limited')
        return m.callModel(prompt)
      },
      renderer,
    })
    expect(calls).toBe(4)
    expect(r.takes).toHaveLength(3)
    expect(r.failures).toEqual([expect.objectContaining({ index: 1, modelCalls: 1 })])
    expect(r.failures[0]!.log).toEqual(['model error: 429 Too Many Requests: rate limited'])
  })

  it('keeps every take when the review call fails', async () => {
    const m = scripted({})
    const r = await generateTakes({ request: 'rain' }, { callModel: m.callModel, renderer, review: async () => { throw new Error('review down') } })
    expect(r.takes).toHaveLength(4)
    expect(r.dropped).toBe(0)
    expect(r.failures).toEqual([])
  })

  it('aborts the whole request when the graphics context is lost', async () => {
    const m = scripted({})
    const lost: TakeRenderer = { ...renderer, compile: () => { throw new ContextLostError('The graphics context was lost (a shader probably hung the GPU)') } }
    await expect(generateTakes({ request: 'rain' }, { callModel: m.callModel, renderer: lost })).rejects.toBeInstanceOf(ContextLostError)
    const lostOnSheet: TakeRenderer = { ...renderer, sheet: () => { throw new ContextLostError('lost') } }
    await expect(generateTakes({ request: 'rain' }, { callModel: m.callModel, renderer: lostOnSheet, review: async () => [true, true, true, true] })).rejects.toThrow(ContextLostError)
  })

  it('sends the compile error back in body line numbers', async () => {
    const offset = `${SHADERGEN_PREAMBLE}${SHADERGEN_HELPERS}\n`.split('\n').length - 1
    const m = scripted({ 0: [reply('BROKEN'), reply('fixed')] })
    const numbered: TakeRenderer = { ...renderer, compile: t => (t.body.includes('BROKEN') ? `shaderfx compile (shadergen_1): ERROR: 0:${offset + 2}: 'x' : undeclared identifier` : null) }
    const r = await generateTakes({ request: 'rain' }, { callModel: m.callModel, renderer: numbered })
    expect(m.prompts[0]![1]).toContain("ERROR: body line 2: 'x' : undeclared identifier")
    expect(m.prompts[0]![1]).not.toContain('shaderfx compile')
    expect(r.takes).toHaveLength(4)
  })

  it('sends a static-check failure back as the reason', async () => {
    const twoDials = JSON.stringify({ name: 'X', animated: false, generative: false, params: [P('u_a'), P('u_b')], body: 'uniform float u_a; uniform float u_b; void main(){ fragColor0=vec4(u_a*u_b); }' })
    const m = scripted({ 2: [twoDials, reply('ok')] })
    await generateTakes({ request: 'rain' }, { callModel: m.callModel, renderer })
    expect(m.prompts[2]![1]).toContain('It has 2 dials; it needs 3 to 5')
  })

  it('regenerates once when the render checks fail, naming what went wrong', async () => {
    const m = scripted({ 3: [reply('BLACK'), reply('lit')] })
    const r = await generateTakes({ request: 'rain' }, { callModel: m.callModel, renderer })
    expect(m.prompts[3]![1]).toContain('A previous attempt failed: the render was black')
    expect(r.takes).toHaveLength(4)
  })

  it('drops takes the visual review rejects and replaces them', async () => {
    const m = scripted({ 1: [reply('first', 'Muddy'), reply('second', 'Better')] })
    const seen: string[] = []
    const r = await generateTakes({ request: 'rain' }, {
      callModel: m.callModel,
      renderer,
      review: async (sheet, request, count) => { seen.push(`${sheet}|${request}|${count}`); return [true, false, true, true] },
    })
    expect(seen).toEqual(['sheet:4|rain|4'])
    expect(r.dropped).toBe(1)
    expect(r.takes.map(t => t.take.name)).toEqual(['Take 1', 'Take 3', 'Take 4', 'Better'])
    expect(m.prompts[1]![1]).toContain('a reviewer judged the previous attempt a miss')
  })
})
