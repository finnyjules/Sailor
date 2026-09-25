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
  it('the Shader studio makes the previewed layer read-only while a set is open, derived from the prompt’s session', () => {
    const s = src('components/vue-canvas/ShaderStudioSurface.vue')
    expect(s).toMatch(/shellRef\.value\?\.prompt\.effectsOpen\.value/)
    expect(s).toMatch(/const lockedLayer = \([^)]*\) => takeLayerLocked\(/)
    expect(s).toMatch(/const layerReadOnly = computed\(\(\) => lockedLayer\(/)
    // the stack's on/off for the previewed layer is part of the lock
    expect(s).toMatch(/function toggleEffect[^{]*\{[^}]*if \(lockedLayer\(e\.layerId\)\) return/)
    // dials (the whole layer section), the centre handle and the effect picker
    expect(s).toMatch(/data-testid="shader-studio-layer-controls"[\s\S]{0,200}:inert="layerReadOnly/)
    expect(s).toMatch(/v-if="showMaskHandles && !layerReadOnly"/)
    expect(s).toMatch(/<StudioButton :disabled="layerReadOnly" @click="openPicker">/)
    for (const fn of ['setParam', 'setMask', 'openPicker', 'pickEffect', 'pickEffectLook', 'onMaskDown'])
      expect(s).toMatch(new RegExp(`function ${fn}[^{]*\\{[\\s\\S]{0,80}if \\(layerReadOnly\\.value\\) return`))
    for (const fn of ['addEffect', 'removeEffect', 'duplicateEffect', 'reorderEffect'])
      expect(s).toMatch(new RegExp(`function ${fn}[^{]*\\{\\s*if \\(stackLocked\\.value`))
  })
  it('Frame passes a background target to its own prompt', () => {
    const s = src('components/vue-canvas/CompositorModal.vue')
    expect(s).toMatch(/function frameBackgroundTarget\(/)
    // Preflight C13: the option itself is wired to the background target, not just any `effectTarget:`.
    expect(s).toMatch(/effectTarget:\s*\(m\)\s*=>\s*frameBackgroundTarget\(/)
    // Previews are a local overlay the artboard paints; the saved node is written only on Keep
    // (behaviour, and the C2 key mapping, are unit-tested in studio-targets.unit.spec.ts).
    expect(s).toMatch(/return makeBackgroundTarget\(\{/)
    expect(s).toMatch(/show: \(p\) => \{ backgroundPreview\.value = p \}/)
    expect(s).toMatch(/commit: p => setBackground\(p\)/)
    expect(s).toMatch(/paintLayers\(\)[\s\S]{0,400}shownBackground\.value, localGroups\.value, postEffects\.value, false/)
    expect(s).toMatch(/JSON\.stringify\(shownBackground\.value\)/)
    const target = s.slice(s.indexOf('function frameBackgroundTarget('), s.indexOf('function snapshotCanvas('))
    expect(target).not.toMatch(/writeBackground/)
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
