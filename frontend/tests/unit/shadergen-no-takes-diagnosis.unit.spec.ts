// @vitest-environment happy-dom
// Julien, 2026-09-25: a Remix of "Prism drift" ("loop the effect") came back "Didn't come back" ×3
// with nothing to say why, and a blank "Current" tile. See
// .superpowers/sdd/2026-09-25-ai-in-sailor-stage5-shader-gen/debug-no-takes-report.md
import { describe, it, expect, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { generateTakes, type EngineFailure, type TakeRenderer } from '~/lib/shadergen/engine'
import { buildGenPrompt, TAKE_ANGLES } from '~/lib/shadergen/prompt'
import { takeFailureReason } from '~/lib/shadergen/failureReason'
import { useEffectTakes, type EffectTarget } from '~/composables/useEffectTakes'
import { failedTileText } from '~/lib/prompt/takesSession'
import PromptTakes from '~/components/prompt/PromptTakes.vue'
import { assembleSource, SHADERGEN_HELPERS } from '~~/shared/shadergen/contract'
import { takeSourceSize, TAKE_SOURCE_EDGE } from '~/lib/shadergen/browserRenderer'
import { SPIKE_TAKES } from '~/lib/shadergen/__eval__/spikeTakes'

;(globalThis as any).useLocalSettings = () => ({ getLocalSetting: () => 'k' })
const slotOf = (p: string) => TAKE_ANGLES.findIndex(a => p.includes(a))
const loopFails: TakeRenderer = { compile: () => null, judge: () => ({ pass: false, flags: ['does not loop'], thumbnail: '' }), sheet: () => '' }
const reply = async (p: string) => ({ text: JSON.stringify(SPIKE_TAKES.rain![slotOf(p)]) })

describe('why a take did not come back', () => {
  it('the engine hands each failed slot its failure, log included', async () => {
    const got: [number, EngineFailure][] = []
    await generateTakes({ request: 'loop the effect', count: 3 }, { callModel: reply, renderer: loopFails, onFailure: (s, f) => got.push([s, f]) })
    expect(got.map(([s]) => s).sort()).toEqual([0, 1, 2])
    expect(got[0]![1].log).toEqual(['checks: does not loop', 'checks: does not loop'])
  })

  it('the last log line names the reason, in the tile’s own words', () => {
    expect(takeFailureReason(['checks: does not loop', 'checks: heavy, does not loop'])).toBe('loop')
    expect(takeFailureReason(['checks: heavy'])).toBe('slow')
    expect(takeFailureReason(['checks: no visible change'])).toBe('unchanged')
    expect(takeFailureReason(['checks: blown out'])).toBe('looks')
    expect(takeFailureReason(['model error: 402 not enough credits'])).toBe('credits')
    expect(takeFailureReason(['compile: body line 3: syntax error'])).toBeUndefined()
    expect(failedTileText('loop')).toBe('Didn’t loop cleanly')
    expect(failedTileText('slow')).toBe('Too slow to draw')
    expect(failedTileText(undefined)).toBe('Didn’t come back')
  })

  it('useEffectTakes warns in the console with the log and puts the reason on the tile', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let api!: ReturnType<typeof useEffectTakes>
    mount(defineComponent({ setup() {
      api = useEffectTakes({ generate: generateTakes, callModel: reply, renderer: () => loopFails, input: async o => ({ request: o.request, count: 3 }), register: vi.fn(), unregister: vi.fn(), onContextChange: () => () => {} })
      return () => h('div')
    } }))
    await api.start('loop the effect', { key: 'k', label: 'Prism drift', base: null, image: () => null, preview: vi.fn(), apply: vi.fn() })
    expect(api.session.value!.tiles.map(t => [t.state, t.reason])).toEqual([['failed', 'loop'], ['failed', 'loop'], ['failed', 'loop']])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('didn’t come back'), expect.stringContaining('checks: does not loop'))
    warn.mockRestore()
    const w = mount(PromptTakes, { props: { session: api.session.value! } })
    expect(w.findAll('[data-testid="prompt-take-tile"]').map(t => t.text())).toEqual(Array(3).fill(expect.stringContaining('Didn’t loop cleanly')))
  })
})

describe('the Current tile shows the target as it is now', () => {
  it('a target’s current picture becomes the strip’s Current thumbnail', async () => {
    const pic = document.createElement('canvas'); pic.width = 40; pic.height = 30
    ;(pic as any).toDataURL = () => 'data:image/jpeg;base64,NOW'
    const current = vi.fn(() => pic as CanvasImageSource)
    let api!: ReturnType<typeof useEffectTakes>
    mount(defineComponent({ setup() {
      api = useEffectTakes({ generate: generateTakes, callModel: reply, renderer: () => loopFails, input: async o => ({ request: o.request, count: 3 }), register: vi.fn(), unregister: vi.fn(), onContextChange: () => () => {}, thumbnail: () => 'data:image/jpeg;base64,NOW' })
      return () => h('div')
    } }))
    const t: EffectTarget = { key: 'k', label: 'Prism drift', base: null, image: () => null, current, preview: vi.fn(), apply: vi.fn() }
    const run = api.start('loop the effect', t)
    expect(api.session.value!.currentThumb).toBe('data:image/jpeg;base64,NOW')
    expect(current).toHaveBeenCalledTimes(1)
    await run
  })
})

describe('a remix base is sent as its own code', () => {
  const body = 'uniform float u_amount;\nvoid main(){ float t=u_time*0.1; fragColor0=vec4(tex(v_texCoord)+t*u_amount,1.0); }'
  it('a My effect’s source (preamble + Sailor’s helpers + body) goes without the helpers', () => {
    const p = buildGenPrompt({ request: 'loop the effect', takeIndex: 0, base: { name: 'Prism drift', source: assembleSource(body), params: [] } })
    expect(p).toContain('void main(){ float t=u_time*0.1;')
    expect(p).not.toContain(SHADERGEN_HELPERS.trim().split('\n')[0]!)
    expect(p).not.toContain('float LOOP(){')
  })
  it('a base whose motion runs on raw u_time is told how to rebuild it on the loop', () => {
    const p = buildGenPrompt({ request: 'loop the effect', takeIndex: 0, base: { name: 'Prism drift', source: assembleSource(body), params: [] } })
    expect(p).toContain('motion runs on raw u_time')
    expect(p).toContain('whole number')
    const still = buildGenPrompt({ request: 'x', takeIndex: 0, base: { name: 'Still', source: assembleSource('void main(){ fragColor0=vec4(tex(v_texCoord),1.0); }'), params: [] } })
    expect(still).not.toContain('motion runs on raw u_time')
  })
})

describe('takes are judged on a small copy of the picture', () => {
  it('long edge at most TAKE_SOURCE_EDGE, aspect kept, small pictures untouched', () => {
    expect(takeSourceSize(4096, 3072)).toEqual({ w: TAKE_SOURCE_EDGE, h: 384 })
    expect(takeSourceSize(288, 384)).toEqual({ w: 288, h: 384 })
  })
})
