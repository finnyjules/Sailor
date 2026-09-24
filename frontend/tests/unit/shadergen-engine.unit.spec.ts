import { describe, expect, it } from 'vitest'
import type { GenTake } from '~~/shared/shadergen/contract'
import { generateTakes, type TakeRenderer } from '~/lib/shadergen/engine'

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
      return { text, usage: { input_tokens: 10, output_tokens: 5 } }
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
