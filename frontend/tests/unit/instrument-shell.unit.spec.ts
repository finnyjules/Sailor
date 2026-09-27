// frontend/tests/unit/instrument-shell.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const src = (f: string) => readFileSync(fileURLToPath(new URL(`../../app/components/vue-canvas/${f}`, import.meta.url)), 'utf8')
const tpl = (s: string) => s.slice(s.indexOf('<template>'), s.lastIndexOf('</template>'))

describe('ComfyNode wears the instrument shell', () => {
  const s = src('ComfyNode.vue'), t = tpl(s)
  it('the card root keeps comfy-node and gains node-shell', () => {
    expect(t).toMatch(/key="card"[\s\S]{0,200}class="comfy-node node-shell /)
  })
  it('asks the canvas for real blur', () => {
    expect(s).toMatch(/useNodeGlass\(/)
    expect(t).toMatch(/:data-glass-blur="glass \|\| undefined"/)
  })
  it('no flat opaque background and no gradient header', () => {
    expect(t).not.toMatch(/'#1a1a1c'/)
    expect(t).not.toMatch(/linear-gradient\(135deg, \$\{accentColor\}15/)
  })
  it('no price pill in the header: the price rides the Run button', () => {
    expect(t).toMatch(/variant="instrument"[\s\S]{0,300}:price="priceLabel"/)
    expect(s).toMatch(/costLabel: null/)
  })
  it('settings live in the hover-only actions', () => {
    expect(t).toMatch(/class="node-shell__actions[^"]*"[\s\S]{0,600}SlidersHorizontal/)
  })
  it('rows sit 5px apart', () => {
    expect(t).toMatch(/flex flex-col gap-\[5px\]/)
  })
})

describe.each(['ComfyGateNode.vue', 'ShaderEffectNode.vue', 'SubgraphIONode.vue'])('%s wears the shell', (f) => {
  const s = src(f), t = tpl(s)
  it('root carries node-shell and asks for glass', () => {
    expect(t).toMatch(/class="[^"]*\bnode-shell\b/)
    expect(s).toMatch(/useNodeGlass\(/)
  })
  it('no rounded-xl border card of its own', () => {
    expect(t).not.toMatch(/rounded-xl border/)
  })
})
