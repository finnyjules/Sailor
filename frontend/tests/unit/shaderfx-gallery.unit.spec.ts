import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SHADER_GALLERY_SECTIONS, sectionOfEffect, shaderGalleryFilters, shaderGalleryItems } from '~/lib/shaderfx/gallery'
import type { EffectDef } from '~/lib/shaderfx/types'
import { myEffectRecords, myEffectsLoaded, setMyEffectRecord } from '~/lib/myEffects/library'

const d = (id: string, category: string, over: Partial<EffectDef> = {}): EffectDef => ({ id, name: id.replace(/_/g, ' '), category, animated: false, passes: 1, centerParam: null, textures: [], params: [], source: '', ...over })
const effects = [
  d('glow_soft', 'glow'), d('water_ripple', 'distortion'),
  d('mine_aaaaaaaaaaaa', 'mine', { mine: true, name: 'Rain on glass', from: 'Water ripple' }),
  d('mine_aaaaaaaaaaaa~v1', 'mine', { mine: true, versionOf: 'mine_aaaaaaaaaaaa' }),
  d('draft_1_0', 'mine', { draft: true }),
]

describe('the shared shader gallery helper (spec §7.3, §7.4)', () => {
  const reset = () => { myEffectRecords.value = []; myEffectsLoaded.value = false }
  // The user's library holds the one My effect (a My effect is listed only while it does).
  beforeEach(() => { reset(); setMyEffectRecord({ id: 'mine_aaaaaaaaaaaa' } as any) })
  afterEach(reset)

  it('My effects first, then the built-in sections; drafts and old versions never listed', () => {
    expect(shaderGalleryItems(effects, { filter: 'all', query: '' }).map(e => e.id)).toEqual(['mine_aaaaaaaaaaaa', 'water_ripple', 'glow_soft'])
    expect(SHADER_GALLERY_SECTIONS[0]).toEqual({ id: 'mine', label: 'My effects' })
    expect(sectionOfEffect(effects[2]!)).toBe('mine')
    expect(sectionOfEffect(effects[0]!)).toBe('glow')
  })
  it('the My effects chip is always there, with its count; categories follow in section order', () => {
    const f = shaderGalleryFilters(effects)
    expect(f[0]).toEqual({ id: 'all', label: 'All', count: 3 })
    expect(f[1]).toEqual({ id: 'mine', label: 'My effects', count: 1 })
    expect(f.map(x => x.id)).toEqual(['all', 'mine', 'distortion', 'glow'])
    expect(shaderGalleryFilters([d('glow_soft', 'glow')])[1]).toEqual({ id: 'mine', label: 'My effects', count: 0 })
    expect(shaderGalleryFilters([d('x', 'color'), d('y', 'odd_one')]).map(x => x.label)).toEqual(['All', 'My effects', 'Color', 'Odd One'])
  })
  it('filters by chip, by search (name, category, origin), and by the host’s include', () => {
    expect(shaderGalleryItems(effects, { filter: 'mine', query: '' }).map(e => e.id)).toEqual(['mine_aaaaaaaaaaaa'])
    expect(shaderGalleryItems(effects, { filter: 'all', query: 'ripple' }).map(e => e.id)).toEqual(['mine_aaaaaaaaaaaa', 'water_ripple'])
    expect(shaderGalleryItems(effects, { filter: 'all', query: 'GLOW' }).map(e => e.id)).toEqual(['glow_soft'])
    expect(shaderGalleryItems(effects, { filter: 'all', query: '', include: e => e.id !== 'glow_soft' }).map(e => e.id)).toEqual(['mine_aaaaaaaaaaaa', 'water_ripple'])
    expect(shaderGalleryFilters(effects, e => e.id !== 'glow_soft').map(x => x.id)).toEqual(['all', 'mine', 'distortion'])
  })
  it('My effects list newest first, in library order', () => {
    const two = [d('mine_bbbbbbbbbbbb', 'mine', { mine: true }), d('mine_cccccccccccc', 'mine', { mine: true })]
    myEffectRecords.value = [{ id: 'mine_cccccccccccc' }, { id: 'mine_bbbbbbbbbbbb' }] as any
    expect(shaderGalleryItems(two, { filter: 'all', query: '' }).map(e => e.id)).toEqual(['mine_cccccccccccc', 'mine_bbbbbbbbbbbb'])
  })
  it('a removed My effect stays registered (projects render it) but is no longer listed once the library has loaded', () => {
    setMyEffectRecord({ id: 'mine_aaaaaaaaaaaa' } as any)
    myEffectsLoaded.value = true
    expect(shaderGalleryItems(effects, { filter: 'all', query: '' }).map(e => e.id)).toEqual(['mine_aaaaaaaaaaaa', 'water_ripple', 'glow_soft'])
    setMyEffectRecord(null, 'mine_aaaaaaaaaaaa')
    expect(shaderGalleryItems(effects, { filter: 'all', query: '' }).map(e => e.id)).toEqual(['water_ripple', 'glow_soft'])
    expect(shaderGalleryFilters(effects)[1]).toEqual({ id: 'mine', label: 'My effects', count: 0 })
  })
  it('a shared project’s copy that isn’t in the library is never listed, loaded or not (Task 10 ruling)', () => {
    const copy = [d('mine_dddddddddddd', 'mine', { mine: true, name: 'Their effect' }), d('water_ripple', 'distortion')]
    expect(shaderGalleryItems(copy, { filter: 'all', query: '' }).map(e => e.id)).toEqual(['water_ripple'])
    myEffectsLoaded.value = true
    expect(shaderGalleryItems(copy, { filter: 'all', query: '' }).map(e => e.id)).toEqual(['water_ripple'])
    setMyEffectRecord({ id: 'mine_dddddddddddd' } as any) // saved to the library: listed
    expect(shaderGalleryItems(copy, { filter: 'all', query: '' }).map(e => e.id)).toEqual(['mine_dddddddddddd', 'water_ripple'])
  })
})
