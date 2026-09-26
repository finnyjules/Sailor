// @vitest-environment happy-dom
/**
 * The brief each take is written from (2026-09-26): the taste guide distilled from the 09-23 spike's
 * verdicts, what the take is for (its place, its picture's shape, over the picture or standalone),
 * a remix's own origin, and a size budget — the prompt is paid per token, three times a set.
 */
import { describe, expect, it } from 'vitest'
import { SHADERGEN_SYSTEM } from '~~/shared/shadergen/system'
import { aspectWords, buildGenPrompt, targetNote, TAKE_ANGLES } from '~/lib/shadergen/prompt'
import { productEngineInput } from '~/lib/shadergen/productRequest'
import type { EffectDef } from '~/lib/shaderfx/types'

describe('system prompt: the taste guide', () => {
  it('names the spike’s lessons: one physical thing, restraint, calm physical motion, meaningful dials, colour that respects the picture, no gimmicks', () => {
    expect(SHADERGEN_SYSTEM).toContain('Taste')
    expect(SHADERGEN_SYSTEM).toMatch(/one concrete physical thing/)
    expect(SHADERGEN_SYSTEM).toMatch(/Restraint over clutter/)
    expect(SHADERGEN_SYSTEM).toMatch(/Motion feels physical and calm by default/)
    expect(SHADERGEN_SYSTEM).toMatch(/Every dial changes something you can see, and its default is the tasteful setting/)
    expect(SHADERGEN_SYSTEM).toMatch(/Colour respects the picture/)
    expect(SHADERGEN_SYSTEM).toMatch(/No gimmicks/)
  })
  it('the guide comes after the rules, so the contract stays first', () => {
    expect(SHADERGEN_SYSTEM.indexOf('Taste')).toBeGreaterThan(SHADERGEN_SYSTEM.indexOf('7. "name"'))
  })
})

describe('what the take is for', () => {
  it('aspect in words', () => {
    expect(aspectWords(1)).toBe('square')
    expect(aspectWords(16 / 9)).toBe('16:9 landscape')
    expect(aspectWords(1080 / 1350)).toBe('4:5 portrait')
    expect(aspectWords(9 / 16)).toBe('9:16 portrait')
    expect(aspectWords(1.43)).toBe('1.43:1 landscape')
  })
  it('the Shader studio, over the user’s picture: its place and shape, and to look at it', () => {
    const n = targetNote({ target: { place: 'shader-studio', aspect: 4 / 3 } })!
    expect(n).toBe('It is for a layer in Sailor’s Shader studio, running over the user’s own picture: the attached picture, 4:3 landscape. Look at it — its subject, palette and light — and choose defaults that suit it.')
  })
  it('Frame’s background: text and pictures sit on top; the picture is the Frame as it looks now', () => {
    const n = targetNote({ target: { place: 'frame-background', aspect: 9 / 16 } })!
    expect(n).toContain('the background of a Frame, a designed layout whose text and pictures sit on top of it')
    expect(n).toContain('running over the Frame as it looks now: the attached picture, 9:16 portrait')
  })
  it('a canvas node, standalone (no picture): it stands alone', () => {
    expect(targetNote({ target: { place: 'canvas-node' }, noSourcePicture: true })).toBe('It is for a shader effect node on Sailor’s canvas; it stands alone, with no picture under it.')
  })
  it('with a reference picture as picture 2, the picture it runs over is picture 1', () => {
    expect(targetNote({ target: { place: 'shader-studio', aspect: 1 }, referencePicture: 2 })).toContain('the user’s own picture: picture 1, square')
  })
  it('no target (the evaluation page): nothing is added', () => {
    expect(targetNote({})).toBeNull()
    expect(buildGenPrompt({ request: 'x', takeIndex: 0, target: null })).toBe(buildGenPrompt({ request: 'x', takeIndex: 0 }))
  })
  it('sits after the request and picture notes, before the base and the take angle', () => {
    const p = buildGenPrompt({ request: 'rain', takeIndex: 0, target: { place: 'shader-studio', aspect: 1 }, base: { name: 'Water ripple', source: 'void main(){}', params: [] } })
    expect(p.indexOf('It is for')).toBeGreaterThan(p.indexOf('Request: "rain"'))
    expect(p.indexOf('It is for')).toBeLessThan(p.indexOf('Start from this existing effect'))
    expect(p.indexOf('It is for')).toBeLessThan(p.indexOf(TAKE_ANGLES[0]))
  })
})

const myEffect = (): EffectDef => ({
  id: 'mine_abcdefabcdef~v2', name: 'Prism drift', category: 'mine', animated: true, passes: 1, centerParam: null, textures: [], mine: true, from: 'Prism',
  source: 'uniform float u_amount; uniform float u_width;\nvoid main(){ fragColor0 = vec4(tex(v_texCoord) * u_amount + u_width * 0.0 + 0.1 * sin(u_time), 1.0); }',
  params: [
    { uniform: 'u_amount', label: 'Amount', type: 'float', min: 0, max: 1, step: 0.01, default: 0.9 },
    { uniform: 'u_width', label: 'Beam width', type: 'float', min: 0.5, max: 4, step: 0.1, default: 1.5 },
  ] as any,
  versions: [
    { label: 'v1', note: 'thin prism light beams over the photo', effectId: 'mine_abcdefabcdef~v1', values: {} },
    { label: 'v2', note: 'slower', effectId: 'mine_abcdefabcdef~v2', values: {} },
  ],
})

describe('Remix / New version of a My effect: what to keep', () => {
  it('names the effect, the request that first made it (its Recipe’s quote), what it was made from, and its dials with defaults', async () => {
    const input = await productEngineInput({ request: 'make it loop', base: myEffect(), image: 'data:image/jpeg;base64,AAA', target: { place: 'shader-studio', aspect: 1 } })
    const p = buildGenPrompt({ request: input.request, base: input.base, takeIndex: 0, target: input.target })
    expect(p).toContain('Start from this existing effect, "Prism drift", first made for the request "thin prism light beams over the photo" from "Prism".')
    expect(p).toContain('Keep what serves the request — its idea, its dials’ names and tasteful defaults — and change whatever you need to.')
    expect(p).toContain('"label":"Amount"')
    expect(p).toContain('"default":0.9')
    expect(p).toContain('"label":"Beam width"')
    // Its raw-u_time motion is to be rebuilt on the loop.
    expect(p).toContain('rebuild that motion on the loop')
  })
  it('a built-in base: just its name', () => {
    const p = buildGenPrompt({ request: 'x', takeIndex: 0, base: { name: 'Water ripple', source: 'void main(){}', params: [] } })
    expect(p).toContain('Start from this existing effect, "Water ripple". Keep what serves')
  })
  it('a My effect with no recorded request still names what it was made from', () => {
    const p = buildGenPrompt({ request: 'x', takeIndex: 0, base: { name: 'Mine', source: 'void main(){}', params: [], from: 'Prism' } })
    expect(p).toContain('"Mine", made from "Prism". Keep')
  })
})

describe('size: paid per token, three takes a set', () => {
  /** Measured 2026-09-26 before this change: system 3,406 chars; a first take's user turn
   *  3,443 (over a photo), 3,647 (standalone), 4,725 (remix of a My effect). */
  it('the system prompt stays under 4,500 characters', () => {
    expect(SHADERGEN_SYSTEM.length).toBeLessThan(4500)
  })
  it('a first take’s user turn stays under 4,300 characters (over a photo or standalone) and 5,700 (a remix)', async () => {
    const turn = async (o: Parameters<typeof productEngineInput>[0]) => {
      const i = await productEngineInput(o)
      return buildGenPrompt({ request: i.request, base: i.base, takeIndex: 0, examples: i.examples, noSourcePicture: i.noSourcePicture, referencePicture: i.referencePicture ?? null, target: i.target }).length
    }
    expect(await turn({ request: 'Turn this into rain on a window', base: null, image: 'data:image/jpeg;base64,AAA', target: { place: 'frame-background', aspect: 0.8 } })).toBeLessThan(4300)
    expect(await turn({ request: 'prism light', base: null, image: null, target: { place: 'shader-studio' } })).toBeLessThan(4300)
    expect(await turn({ request: 'make it loop', base: myEffect(), image: 'data:image/jpeg;base64,AAA', target: { place: 'shader-studio', aspect: 1 } })).toBeLessThan(5700)
  })
})
