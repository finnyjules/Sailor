// Every shader-effect consumer resolves defs from the LIVE catalog, so a My effect registered
// after the built-ins first landed (the library's load, a project's copies, a Keep) is found.
// The fetch promise's own value is the built-ins' first snapshot and never sees it (review of
// Task 12, findings 5–8). Each case fetches FIRST, registers after, then asks the consumer.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import catalogJson from '../../../shader_effects/manifest.json'
import { SPIKE_TAKES } from '~/lib/shadergen/__eval__/spikeTakes'

const vibe = vi.fn()
vi.mock('ofetch', () => ({ $fetch: (...args: unknown[]) => vibe(...args) }))
const composed = vi.fn()
vi.mock('~/lib/shaderstudio/passes', async (orig) => {
  const actual = await orig<typeof import('~/lib/shaderstudio/passes')>()
  return { ...actual, composePasses: (...a: Parameters<typeof actual.composePasses>) => { composed(a[0].effects.map(e => a[1](e.id)?.id ?? null)); return actual.composePasses(...a) } }
})
;(globalThis as any).$fetch = async (url: string) => {
  if (url === '/sailor/shader_effects') return catalogJson
  if (url === '/api/my-effects') return { effects: [] }
  throw new Error(`unexpected global $fetch: ${url}`)
}

const A = 'mine_aaaaaaaaaaaa'
const take = SPIKE_TAKES.rain![2]!
const layer = (id: string) => ({ layerId: 'L0', id, params: {}, enabled: true, customChars: '', blend: 'normal', opacity: 1 })

/** Built-ins loaded, THEN the My effect registered (the usual order after a reload). */
async function lateMyEffect() {
  const c = await import('~/lib/shaderfx/catalog')
  const first = await c.fetchShaderFxCatalog()
  const { expandMyEffect, recordFromTake } = await import('~/lib/myEffects/defs')
  c.registerEffects(expandMyEffect(recordFromTake(take, { id: A, request: 'rain', from: null, now: 'x' })))
  expect(first.effects.some(e => e.id === A)).toBe(false) // the trap these cases guard against
  return c
}

describe('consumers read the live catalog, so a late My effect is found', () => {
  beforeEach(() => { vi.resetModules(); vibe.mockReset(); composed.mockReset() })

  it('getEffect', async () => {
    const c = await lateMyEffect()
    expect((await c.getEffect(A))?.id).toBe(A)
    expect((await c.getEffect('water_ripple'))?.id).toBe('water_ripple')
  })

  it('the Shader studio tuner: the My effect’s dials, and it is a switch target (drafts and old versions are not)', async () => {
    const c = await lateMyEffect()
    const { expandMyEffect, recordFromTake, withCodeVersion } = await import('~/lib/myEffects/defs')
    const two = withCodeVersion(recordFromTake(take, { id: 'mine_bbbbbbbbbbbb', request: 'r', from: null, now: 'x' }), SPIKE_TAKES.rain![0]!, { request: 'r2', now: 'y' })
    c.registerEffects([...expandMyEffect(two), { ...expandMyEffect(two)[0]!, id: 'draft_1_0', draft: true }])
    const { tuneShaderNode } = await import('~/lib/agent/studioTune')
    vibe.mockResolvedValueOnce({ rationale: '', changes: [] })
    const n: any = { id: 'n1', data: { nodeType: 'ShaderStudio', properties: { sailor_shaderStudio: { version: 3, effects: [layer(A)] } } } }
    await tuneShaderNode(n, 'more', 'k')
    const body = vibe.mock.calls[0]![1].body as { controls: { path: string; options?: string[] }[]; guidance?: string }
    const paths = body.controls.map(x => x.path)
    for (const p of take.params) expect(paths).toContain(`effects.0.params.${p.uniform}`)
    const options = body.controls.find(x => x.path === 'effect')!.options!
    // Each My effect is offered once, as its newest version's own id (Ruling #2: targets pin a version).
    expect(options).toContain(`${A}~v1`)
    expect(options).toContain('mine_bbbbbbbbbbbb~v2')
    expect(options.filter(o => o.startsWith('mine_bbbbbbbbbbbb'))).toEqual(['mine_bbbbbbbbbbbb~v2'])
    expect(options.some(o => o.startsWith('draft_'))).toBe(false)
  })

  it('Tune/Vary take thumbnails for a Shader studio node', async () => {
    await lateMyEffect()
    const { takeThumbFor } = await import('~/lib/agent/takeThumbs')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await takeThumbFor('shader')({ version: 3, effects: [layer(A)] }, 32) // no WebGL here: the draw itself fails after composing
    warn.mockRestore()
    expect(composed).toHaveBeenCalledWith([A])
  })

  it('the Shader studio node renders from the live catalog and repaints when a def it uses lands (wiring guard)', () => {
    const s = readFileSync(fileURLToPath(new URL('../../app/components/vue-canvas/ShaderStudioNode.vue', import.meta.url)), 'utf8')
    expect(s).toMatch(/const catalog = useShaderCatalog\(\)/)
    expect(s).toMatch(/function effectDef\(id: string\): EffectDef \| null \{\s*return catalog\.value\?\.effects\.find/)
    expect(s).not.toMatch(/=\s*await fetchShaderFxCatalog\(\)/)
    expect(s).toMatch(/watch\(\(\) => config\.value\.effects\.map\(e => effectDef\(e\.id\)\)/)
    for (const call of ['composePasses(cfg, effectDef', 'composePasses(config.value, effectDef']) expect(s).toContain(call)
  })

  it('no consumer keeps the fetch promise’s own effect list (source guard)', () => {
    for (const f of ['lib/agent/studioTune.ts', 'lib/agent/takeThumbs.ts', 'lib/startModal/shaderStill.ts', 'lib/shaderfx/catalog.ts', 'components/vue-canvas/ShaderStudioNode.vue', 'components/vue-canvas/CompositorModal.vue']) {
      const s = readFileSync(fileURLToPath(new URL(`../../app/${f}`, import.meta.url)), 'utf8')
      expect(s, f).not.toMatch(/\(await fetchShaderFxCatalog\([^)]*\)\)\.effects|=\s*await fetchShaderFxCatalog\(/)
      expect(s, f).not.toMatch(/const \[[^\]]*catalog\] = await Promise\.all\(\[[^\]]*fetchShaderFxCatalog\(\)/)
      expect(s, f).not.toMatch(/const cat(alog)? = await fetchShaderFxCatalog\(\)/)
    }
  })
})
