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
  it('card and capsule both carry Vue Flow selection as data-selected', () => {
    expect(s).toMatch(/selected\?: boolean/)
    expect(t).toMatch(/key="card"[\s\S]{0,1600}:data-selected="selected \|\| undefined"/)
    expect(t).toMatch(/<NodeCapsule[\s\S]{0,400}:data-selected="selected \|\| undefined"/)
  })
  it('card title is 13px, like the other nodes and the capsule', () => {
    expect(s).toMatch(/\.node-head__title \{[^}]*font-size: 13px/)
    expect(t).not.toMatch(/node-head__title text-xs/)
    expect(src('NodeCapsule.vue')).toMatch(/\.node-capsule__title \{[^}]*font-size: 13px/)
  })
  it('only one surface shows during the capsule swap', () => {
    // Expanding: the leaving capsule is hidden at once, the card never fades in.
    expect(s).toMatch(/\.node-capsule\.capsule-swap-leave-active \{ opacity: 0; transition-property: none; \}/)
    expect(s).not.toMatch(/\.capsule-swap-enter-from:not\(\.node-capsule\)/)
    // Collapsing: the entering capsule stays hidden while the leaving card is still there.
    expect(s).toMatch(/\.capsule-swap-leave-active:not\(\.node-capsule\) ~ \.node-capsule,[^{]*\{ opacity: 0; \}/)
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
  it('binds Vue Flow selection as data-selected on the shell', () => {
    expect(s).toMatch(/selected\?: boolean/)
    expect(t).toMatch(/class="[^"]*\bnode-shell\b[\s\S]{0,400}:data-selected="selected \|\| undefined"/)
  })
  it('no rounded-xl border card of its own', () => {
    expect(t).not.toMatch(/rounded-xl border/)
  })
})

describe('the collapsed capsule wears the same glass as the card', () => {
  const capsuleSrc = src('NodeCapsule.vue')
  const capsuleStyle = capsuleSrc.slice(capsuleSrc.indexOf('<style'), capsuleSrc.lastIndexOf('</style>'))
  const comfyNodeSrc = src('ComfyNode.vue')
  const comfyNodeTpl = tpl(comfyNodeSrc)

  it('the root rule has no opaque #1f1f1f background and no 13% border', () => {
    expect(capsuleStyle).not.toMatch(/#1f1f1f/)
    expect(capsuleStyle).not.toMatch(/rgba\(255,\s*255,\s*255,\s*0\.13\)/)
  })

  it('the root rule uses the shared glass tokens and a zoom-divided border', () => {
    const rootRule = capsuleStyle.slice(capsuleStyle.indexOf('.node-capsule {'), capsuleStyle.indexOf('.node-capsule {') + 2000)
    expect(rootRule).toMatch(/background:\s*var\(--node-glass-tint\)/)
    expect(rootRule).toMatch(/border:\s*calc\(1px \/ var\(--canvas-zoom,\s*1\)\)\s*solid\s*var\(--node-edge\)/)
    expect(rootRule).toMatch(/box-shadow:\s*var\(--node-shadow\)/)
  })

  it('the title is weight 600, matching the card header', () => {
    expect(capsuleStyle).toMatch(/\.node-capsule__title\s*\{[\s\S]{0,300}font-weight:\s*600/)
  })

  it('hover lightens the glass instead of switching to an opaque grey', () => {
    expect(capsuleStyle).not.toMatch(/\.node-capsule:hover\s*\{[\s\S]{0,200}background:\s*#262626/)
  })

  it('the capsule element in ComfyNode carries node-shell and the glass-blur binding', () => {
    expect(comfyNodeTpl).toMatch(/<NodeCapsule[\s\S]{0,400}class="comfy-node node-shell"/)
    expect(comfyNodeTpl).toMatch(/<NodeCapsule[\s\S]{0,600}:data-glass-blur="glass \|\| undefined"/)
  })
})

describe('ShaderEffectNode keeps its red edge when it fails', () => {
  const s = src('ShaderEffectNode.vue')
  it('marks the failed state and colours the edge in scoped CSS', () => {
    expect(s).toMatch(/:data-error="data\.error \|\| undefined"/)
    expect(s).toMatch(/\.shader-effect-node\[data-error\] \{ border-color: #ef4444; \}/)
  })
})
