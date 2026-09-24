/**
 * Frame Morph — the "Morph into" picker (final review #3, #4). Source-level guards in the
 * `settle-ui.unit.spec.ts` idiom (no rendering): the modal hands over EVERY eligible element, not
 * a list relative to the canvas selection; the inspector leaves out the bar's own layer; and a
 * set target that is no longer a candidate gets its own one-line note.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const INSPECTOR = readFileSync(fileURLToPath(new URL('../../../app/components/vue-canvas/compositor/MotionInspector.vue', import.meta.url)), 'utf8')
const MODAL = readFileSync(fileURLToPath(new URL('../../../app/components/vue-canvas/CompositorModal.vue', import.meta.url)), 'utf8')

describe('the Morph into picker', () => {
  const modalBlock = MODAL.slice(MODAL.indexOf('const morphTargets = computed'), MODAL.indexOf('function geometrySiblingRefResolvable'))

  it('the modal lists every eligible element, independent of the canvas selection', () => {
    expect(modalBlock).toMatch(/canTakeGeometry\(l\)/)
    expect(modalBlock).toMatch(/cornerPinActive/)
    expect(modalBlock).toMatch(/cloner/)
    expect(modalBlock).not.toMatch(/selectedLocal/)
    expect(modalBlock).not.toMatch(/l\.id !== self/)
  })

  it('the inspector leaves out the bar\'s own layer and builds the options from what is left', () => {
    expect(INSPECTOR).toMatch(/const morphCandidates = computed[\s\S]*?behaviour\.value\?\.layerId[\s\S]*?filter\(t => t\.key !== self\)/)
    expect(INSPECTOR).toMatch(/const morphTargetOptions = computed\(\(\) => \['', \.\.\.morphCandidates\.value/)
    expect(INSPECTOR).toMatch(/const morphTargetLabels = computed\(\(\) => \['Choose an element', \.\.\.morphCandidates\.value/)
  })

  it('a target that is set but no longer a candidate shows its own note, after the no-target one', () => {
    expect(INSPECTOR).toMatch(/const morphTargetGone = computed[\s\S]*?!morphCandidates\.value\.some\(t => t\.key === target\)/)
    const noTarget = INSPECTOR.indexOf('data-testid="morph-no-target"')
    const gone = INSPECTOR.indexOf('data-testid="morph-target-gone"')
    expect(noTarget).toBeGreaterThan(0)
    expect(gone).toBeGreaterThan(noTarget)
    expect(INSPECTOR).toMatch(/v-else-if="morphTargetGone" data-testid="morph-target-gone"/)
    expect(INSPECTOR).toContain("The element this morphs into is gone or can't morph. Pick another.")
  })
})
