import { describe, expect, it } from 'vitest'
import { assembleSource } from '~~/shared/shadergen/contract'
import { hasSeamBlend, needsSeamBlend, seamBlendSource, withoutSeamBlend, withSeamBlend } from '~/lib/shadergen/seamBlend'
import { getEffectSync, putShaderFxEffects, setShaderFxCatalog, addShaderFxEffects } from '~/lib/shaderfx/catalogStore'
import { baseCode } from '~/lib/shadergen/prompt'
import type { EffectDef } from '~/lib/shaderfx/types'

const BODY = `uniform float u_amount;
void main(){
  vec3 c = tex(v_texCoord);
  float x = 0.3 + 0.1 * u_time; // raw time: jumps at the wrap
  fragColor0 = vec4(c + step(abs(v_texCoord.x - fract(x)), 0.004) * u_amount, 1.0);
}`
const def = (o: Partial<EffectDef> & { draft?: boolean }): EffectDef => ({
  id: 'x', name: 'X', category: 'mine', animated: true, passes: 1, centerParam: null, textures: [], params: [],
  source: assembleSource(BODY), ...o,
})

describe('seam blend (a generated effect’s loop safety net)', () => {
  it('decides in one place: animated My effects and drafts only', () => {
    expect(needsSeamBlend(def({ id: 'mine_abcdefabcdef~v2', mine: true }))).toBe(true)
    expect(needsSeamBlend(def({ id: 'draft_3_1', draft: true }))).toBe(true)
    expect(needsSeamBlend(def({ id: 'mine_abcdefabcdef' }))).toBe(true) // a legacy bare id, flag or not
    expect(needsSeamBlend(def({ id: 'mine_abcdefabcdef', mine: true, animated: false }))).toBe(false)
    expect(needsSeamBlend(def({ id: 'water_ripple', category: 'distortion' }))).toBe(false)
    expect(needsSeamBlend(def({ id: 'shadergen_4' }))).toBe(false) // a take being judged: its raw body is what's checked
  })

  it('built-ins and still effects are the very same object — byte-identical', () => {
    const builtIn = def({ id: 'slice_shift', category: 'glitch', source: '#version 300 es\nvoid main(){}' })
    expect(withSeamBlend(builtIn)).toBe(builtIn)
    const still = def({ id: 'mine_abcdefabcdef~v1', mine: true, animated: false })
    expect(withSeamBlend(still)).toBe(still)
  })

  it('wraps the body: u_time redirected, main renamed, a blending main after it; the body text itself untouched', () => {
    const d = withSeamBlend(def({ id: 'mine_abcdefabcdef~v1', mine: true }))
    expect(hasSeamBlend(d.source)).toBe(true)
    expect(d.source.startsWith('#version 300 es\n')).toBe(true)
    expect(d.source).toContain('#define u_time _sl_t')
    expect(d.source).toContain('void _sl_body()')
    expect(d.source.match(/void main\(\)/g)).toHaveLength(1)
    expect(d.source).toContain('float x = 0.3 + 0.1 * u_time;')
    expect(d.source).toContain('smoothstep(L - W, L, p)')
    // loopPhase() is not wrapped inside: t − LOOP() must run on smoothly into 0 for a phase-driven drift too.
    expect(d.source).toContain('float loopPhase(){ return u_time / LOOP(); }')
    expect(d.source).not.toContain('fract(u_time / LOOP())')
    // Idempotent: the store may see a def twice.
    expect(withSeamBlend(d)).toBe(d)
    expect(seamBlendSource(d.source)).toBe(d.source)
  })

  it('leaves a source it cannot safely wrap alone (no Sailor preamble, or not exactly one main)', () => {
    expect(seamBlendSource('#version 300 es\nvoid main(){}')).toBe('#version 300 es\nvoid main(){}')
    const two = assembleSource(`${BODY}\nvoid main(){}`)
    expect(seamBlendSource(two)).toBe(two)
  })

  it('comes back out exactly, so a remix base shows the effect as written', () => {
    const src = assembleSource(BODY)
    expect(withoutSeamBlend(seamBlendSource(src))).toBe(src)
    expect(baseCode(seamBlendSource(src))).toBe(baseCode(src))
    expect(baseCode(seamBlendSource(src))).not.toMatch(/_sl_|seam blend/)
  })

  it('the catalog store applies it to every My effect and draft that comes in, never to a built-in', () => {
    const builtIn = def({ id: 'water_ripple', category: 'distortion', source: 'builtin' })
    setShaderFxCatalog({ version: 1, effects: [builtIn] })
    putShaderFxEffects([def({ id: 'mine_abcdefabcdef~v1', mine: true }), def({ id: 'draft_9_0', draft: true }), def({ id: 'mine_abcdefabcdef~v2', mine: true, animated: false })])
    addShaderFxEffects([def({ id: 'mine_bbbbbbbbbbbb~v1', mine: true })])
    expect(getEffectSync('water_ripple')).toBe(builtIn)
    expect(hasSeamBlend(getEffectSync('mine_abcdefabcdef~v1')!.source)).toBe(true)
    expect(hasSeamBlend(getEffectSync('draft_9_0')!.source)).toBe(true)
    expect(hasSeamBlend(getEffectSync('mine_bbbbbbbbbbbb~v1')!.source)).toBe(true)
    expect(getEffectSync('mine_abcdefabcdef~v2')!.source).toBe(assembleSource(BODY))
    setShaderFxCatalog(null)
  })
})
