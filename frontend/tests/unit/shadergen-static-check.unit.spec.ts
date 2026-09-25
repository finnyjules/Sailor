import { describe, expect, it } from 'vitest'
import type { GenParam, GenTake } from '~~/shared/shadergen/contract'
import { checkLoops, staticCheck } from '~/lib/shadergen/staticCheck'
import { SPIKE_TAKES } from '~/lib/shadergen/__eval__/spikeTakes'

const f = (uniform: string): GenParam => ({ uniform, label: 'Amount', type: 'float', min: 0, max: 1, step: 0.01, default: 0.5 })
const GOOD = `uniform float u_a; uniform float u_b; uniform float u_c;
void main(){
  vec3 c = tex(v_texCoord);
  for(int i=0;i<4;i++){ c += tex(v_texCoord + float(i)*0.01) * u_a; }
  fragColor0 = vec4(c*u_b*u_c, 1.0);
}`
const take = (over: Partial<GenTake> = {}): GenTake => ({
  name: 'Test', animated: false, generative: false, params: [f('u_a'), f('u_b'), f('u_c')], body: GOOD, ...over,
})
const reasonOf = (r: ReturnType<typeof staticCheck>) => (r.ok ? '' : r.reason)

describe('staticCheck', () => {
  it('accepts a well-formed take', () => {
    expect(staticCheck(take())).toEqual({ ok: true })
  })

  it('accepts all 24 spike takes (they compiled and rendered)', () => {
    for (const [key, takes] of Object.entries(SPIKE_TAKES)) {
      for (const t of takes) expect({ key, name: t.name, r: staticCheck(t) }).toEqual({ key, name: t.name, r: { ok: true } })
    }
  })

  it('needs 3 to 5 dials', () => {
    const two = take({ params: [f('u_a'), f('u_b')], body: GOOD.replace('uniform float u_c;', '').replace('*u_c', '') })
    expect(reasonOf(staticCheck(two))).toContain('It has 2 dials; it needs 3 to 5')
    const six = take({ params: ['u_a', 'u_b', 'u_c', 'u_d', 'u_e', 'u_f'].map(f) })
    expect(reasonOf(staticCheck(six))).toContain('It has 6 dials')
  })

  it('rejects a dial that is never declared, and a uniform with no dial', () => {
    expect(reasonOf(staticCheck(take({ params: [f('u_a'), f('u_b'), f('u_z')] })))).toContain('declares uniform u_c, but there is no dial for it')
    expect(reasonOf(staticCheck(take({ body: GOOD.replace('uniform float u_c;', '').replace('*u_c', '') })))).toContain('(u_c) is never declared')
  })

  it('rejects a colour dial declared as float, and an unused dial', () => {
    const col: GenParam = { uniform: 'u_c', label: 'Tint', type: 'color', default: '#ff0000' }
    expect(reasonOf(staticCheck(take({ params: [f('u_a'), f('u_b'), col] })))).toContain('u_c is declared as float; a color dial needs vec3')
    expect(reasonOf(staticCheck(take({ body: GOOD.replace('*u_c', '') })))).toContain('(u_c) is declared but never used')
  })

  it('rejects preamble content in the body', () => {
    expect(reasonOf(staticCheck(take({ body: `#version 300 es\n${GOOD}` })))).toContain('must not include #version')
    expect(reasonOf(staticCheck(take({ body: `uniform float u_time;\n${GOOD}` })))).toContain('redeclares the built-in uniform u_time')
    expect(reasonOf(staticCheck(take({ body: `uniform float u_loop;\n${GOOD}` })))).toContain('redeclares the built-in uniform u_loop')
    expect(reasonOf(staticCheck(take({ body: GOOD.replace('void main()', 'void mainly()') })))).toContain('no void main()')
  })
})

describe('staticCheck: bypasses closed (final review I3)', () => {
  const withMain = (pre: string, main: string) => `uniform float u_a; uniform float u_b; uniform float u_c;
${pre}
void main(){
  vec3 c = tex(v_texCoord) * u_a * u_b * u_c;
${main}
  fragColor0 = vec4(c, 1.0);
}`
  const thirtyReads = Array.from({ length: 30 }, (_, k) => `tex(p + ${k}.0 * 0.001)`).join(' + ')

  it('counts a helper function\'s image reads at each call inside a loop', () => {
    const r = staticCheck(take({ body: withMain(`vec3 H(vec2 p){ return ${thirtyReads}; }`, '  for(int i=0;i<4;i++){ c += H(v_texCoord + float(i)*0.01); }') }))
    expect(reasonOf(r)).toContain('read the image 120 times')
  })

  it('counts a helper function\'s loop at each call inside a loop', () => {
    const r = staticCheck(take({ body: withMain('float H(vec2 p){ float s=0.0; for(int j=0;j<8;j++){ s+=vnoise(p+float(j)); } return s; }', '  for(int i=0;i<16;i++){ c += H(v_texCoord + float(i)); }') }))
    expect(reasonOf(r)).toContain('runs 128 times per pixel')
  })

  it('does not count helper calls made outside loops against the loop budgets', () => {
    const r = staticCheck(take({ body: withMain(`vec3 H(vec2 p){ return ${thirtyReads}; }`, '  c += H(v_texCoord) + H(v_texCoord + 0.1) + H(v_texCoord - 0.1);') }))
    expect(r).toEqual({ ok: true })
  })

  it('rejects changing a loop counter inside the loop', () => {
    const r = staticCheck(take({ body: withMain('', '  for(int i=0;i<8;i++){ c += tex(v_texCoord); if (c.r > 2.0) i = 0; }') }))
    expect(reasonOf(r)).toContain('Loop counter i must not be changed inside the loop.')
    const dec = staticCheck(take({ body: withMain('', '  for(int i=0;i<8;i++){ c += tex(v_texCoord); --i; }') }))
    expect(reasonOf(dec)).toContain('Loop counter i must not be changed inside the loop.')
    expect(staticCheck(take({ body: withMain('', '  for(int i=0;i<8;i++){ if (i == 3) c += tex(v_texCoord); c *= (i <= 2 ? 1.0 : 0.9); }') }))).toEqual({ ok: true })
  })

  it('rejects preprocessor lines', () => {
    const r = staticCheck(take({ body: `#define W while\n${GOOD}` }))
    expect(reasonOf(r)).toBe('The body must not use preprocessor lines (#define, #if…); write the code out.')
  })

  it('ignores code inside comments', () => {
    expect(staticCheck(take({ body: `${GOOD}\n// for (i = 0; i < n; i++) while (true)\n/* for (int k = 0; k < 999; k++) { tex(a); } */` }))).toEqual({ ok: true })
    const onlyInComment = take({ body: GOOD.replace('*u_c', '') + '\n// u_c scales everything' })
    expect(reasonOf(staticCheck(onlyInComment))).toContain('(u_c) is declared but never used')
  })

  it('needs one simple uniform declaration per line', () => {
    const list = take({ body: GOOD.replace('uniform float u_a; uniform float u_b; uniform float u_c;', 'uniform float u_a, u_b; uniform float u_c;') })
    expect(reasonOf(staticCheck(list))).toBe('Declare one uniform per line, like uniform float u_amount;')
    const arr = take({ body: `uniform float u_arr[4];\n${GOOD}` })
    expect(reasonOf(staticCheck(arr))).toBe('Declare one uniform per line, like uniform float u_amount;')
  })
})

describe('checkLoops', () => {
  it('rejects loops whose bounds are not whole-number literals', () => {
    const r = checkLoops('void main(){ for(int i=0;i<n;i++){ } }')
    expect(r.ok ? '' : r.reason).toContain('whole-number literals')
  })

  it('counts nested iterations', () => {
    const r = checkLoops('void main(){ for(int i=0;i<8;i++){ for(int j=0;j<10;j++){ } } }')
    expect(r.ok ? '' : r.reason).toContain('runs 80 times per pixel')
    expect(checkLoops('void main(){ for(int i=0;i<8;i++){ for(int j=0;j<8;j++){ } } }')).toEqual({ ok: true })
  })

  it('counts <= bounds inclusively and accepts single-statement bodies', () => {
    expect(checkLoops('void main(){ for(int i=-2;i<=2;i++) for(int j=-2;j<=2;j++) x+=1.0; }')).toEqual({ ok: true })
    const r = checkLoops('void main(){ for(int i=0;i<=64;i++) x+=1.0; }')
    expect(r.ok ? '' : r.reason).toContain('runs 65 times')
  })

  it('rejects while loops', () => {
    const r = checkLoops('void main(){ while(true){ } }')
    expect(r.ok ? '' : r.reason).toContain('While loops are not allowed')
  })

  it('limits image reads inside loops, with blur9 counting 25', () => {
    const many = checkLoops('void main(){ for(int i=0;i<16;i++){ c+=tex(a)+tex(b)+texture(u_image0,c); } }')
    expect(many.ok ? '' : many.reason).toContain('read the image 48 times')
    const blur = checkLoops('void main(){ for(int i=0;i<2;i++){ c+=blur9(a, 0.01); } }')
    expect(blur.ok ? '' : blur.reason).toContain('read the image 50 times')
    expect(checkLoops('void main(){ c = blur9(a, 0.01); for(int i=0;i<8;i++){ c+=tex(a); } }')).toEqual({ ok: true })
  })
})
