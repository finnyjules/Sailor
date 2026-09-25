// frontend/tests/unit/studio-effect-targets.unit.spec.ts
// Source-level wiring guard: the two studio targets are wired where the studio
// owns its state. Behaviour is proven by Playwright (Task 13).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const src = (p: string) => readFileSync(fileURLToPath(new URL(`../../app/${p}`, import.meta.url)), 'utf8')

describe('studio effect targets', () => {
  it('the Shader studio passes a target and records Tune versions on My effects', () => {
    const s = src('components/vue-canvas/ShaderStudioSurface.vue')
    expect(s).toContain(':effect-target=')
    expect(s).toContain(':after-take-keep=')
    expect(s).toMatch(/addValuesVersion\(/)
  })
  it('Frame passes a background target to its own prompt', () => {
    const s = src('components/vue-canvas/CompositorModal.vue')
    expect(s).toMatch(/function frameBackgroundTarget\(/)
    // Preflight C13: the option itself is wired to the background target, not just any `effectTarget:`.
    expect(s).toMatch(/effectTarget:\s*\(m\)\s*=>\s*frameBackgroundTarget\(/)
    // Preflight C2: Keep writes My-effect values into ShaderSpec.params without the `u_` prefix.
    expect(s).toMatch(/unprefixedKey\(/)
  })
  it('Frame ends an open effect set before it closes (preflight C9)', () => {
    const s = src('components/vue-canvas/CompositorModal.vue')
    expect(s).toMatch(/framePrompt\.endEffects\(\)\s*emitRaw\(e\)/)
  })
  it('the shell forwards both and exposes its prompt', () => {
    const s = src('components/vue-canvas/StudioModalShell.vue')
    expect(s).toMatch(/effectTarget/)
    expect(s).toMatch(/afterTakeKeep/)
    expect(s).toMatch(/defineExpose\(\{[^}]*prompt/)
  })
})
