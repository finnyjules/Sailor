import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { currentShaderEffects, putShaderFxEffects, setShaderFxCatalog } from '~/lib/shaderfx/catalogStore'
import { expandMyEffect, recordFromTake } from '~/lib/myEffects/defs'
import { planFrameExport } from '~/lib/embed/frame/plan'
import { SPIKE_TAKES } from '~/lib/shadergen/__eval__/spikeTakes'

const A = 'mine_aaaaaaaaaaaa'
const register = () => {
  setShaderFxCatalog({ version: 1, effects: [] })
  putShaderFxEffects(expandMyEffect(recordFromTake(SPIKE_TAKES.rain![2]!, { id: A, request: 'r', from: null, now: 'x' })))
}

describe('exports inline My effects like built-ins (spec §7.4)', () => {
  it('the live effect list carries a registered My effect with its full source', () => {
    register()
    const d = currentShaderEffects().find(e => e.id === A)!
    expect(d.source).toContain('void main')
  })
  it('a Frame whose background uses a My effect ships it when the ids come from the live list', () => {
    register()
    const plan = planFrameExport({
      variant: { width: 100, height: 100, layers: [], stackOrder: [], groups: [], post: [], motion: null, wiredTreatments: {},
        background: { kind: 'shader', shader: { effectId: A, params: {} } } } as any,
      fit: 'fit', wiredSlots: [], hasMotion: false, animatedFill: false,
      catalogIds: new Set(currentShaderEffects().map(e => e.id)),
    })
    expect(plan.shaderIds).toContain(A)
  })
  it('Frame’s web export reads the live list, not a stale fetch', () => {
    const s = readFileSync(fileURLToPath(new URL('../../app/components/vue-canvas/CompositorModal.vue', import.meta.url)), 'utf8')
    const block = s.slice(s.indexOf('catalogIds:') - 400, s.indexOf('createAppFrameExportIO({') + 400)
    expect(block).toMatch(/catalogIds: new Set\(currentShaderEffects\(\)/)
    expect(block).toMatch(/catalog: currentShaderEffects\(\)/)
    expect(block).not.toMatch(/cat\.effects/)
  })
})
