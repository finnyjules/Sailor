import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { currentShaderEffects, putShaderFxEffects, setShaderFxCatalog } from '~/lib/shaderfx/catalogStore'
import { expandMyEffect, recordFromTake, withCodeVersion } from '~/lib/myEffects/defs'
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
  it('an older code version of a My effect (`~vN`) inlines too, with its own source', () => {
    setShaderFxCatalog({ version: 1, effects: [] })
    const first = recordFromTake(SPIKE_TAKES.rain![2]!, { id: A, request: 'r', from: null, now: 'x' })
    putShaderFxEffects(expandMyEffect(withCodeVersion(first, SPIKE_TAKES.rain![0]!, { request: 'r2', now: 'y' })))
    const old = `${A}~v1`
    const plan = planFrameExport({
      variant: { width: 100, height: 100, layers: [], stackOrder: [], groups: [], post: [], motion: null, wiredTreatments: {},
        background: { kind: 'shader', shader: { effectId: old, params: {} } } } as any,
      fit: 'fit', wiredSlots: [], hasMotion: false, animatedFill: false,
      catalogIds: new Set(currentShaderEffects().map(e => e.id)),
    })
    expect(plan.shaderIds).toEqual([old])
    // What createAppFrameExportIO's shaderDefs hands the gatherer (appIO.ts: filter by exact id).
    const shipped = currentShaderEffects().filter(d => plan.shaderIds.includes(d.id))
    expect(shipped.map(d => d.id)).toEqual([old])
    expect(shipped[0]!.source).toContain(SPIKE_TAKES.rain![2]!.body.slice(0, 40))
  })
  it('Frame’s web export reads the live list, not a stale fetch', () => {
    const s = readFileSync(fileURLToPath(new URL('../../app/components/vue-canvas/CompositorModal.vue', import.meta.url)), 'utf8')
    const block = s.slice(s.indexOf('catalogIds:') - 400, s.indexOf('createAppFrameExportIO({') + 400)
    expect(block).toMatch(/catalogIds: new Set\(currentShaderEffects\(\)/)
    expect(block).toMatch(/catalog: currentShaderEffects\(\)/)
    expect(block).not.toMatch(/cat\.effects/)
  })
})
