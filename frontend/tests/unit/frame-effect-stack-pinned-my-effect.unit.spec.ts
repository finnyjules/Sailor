// @vitest-environment happy-dom
// Ruling #2 follow-up: Frame's effect stack (CompositorModal's shader-pass inspector) stores a
// pinned `mine_x~vN` like every other target. Its picker button names the effect from that id
// (`activeShaderEffectDef`, an exact-id catalog lookup) and its gallery gets the stored id, which
// ShaderEffectGallery maps to the effect's one card for Current. CompositorModal is too large to
// mount here, so the wiring is pinned from its source and the behaviour through the same pieces.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount, type VueWrapper } from '@vue/test-utils'
import ShaderEffectGallery from '~/components/vue-canvas/ShaderEffectGallery.vue'
import { expandMyEffect, recordFromTake, withCodeVersion } from '~/lib/myEffects/defs'
import { myEffectRecords, myEffectsLoaded, setMyEffectRecord } from '~/lib/myEffects/library'
import { resolveEffectId } from '~/lib/shaderfx/catalogStore'
import { SPIKE_TAKES } from '~/lib/shadergen/__eval__/spikeTakes'

const src = readFileSync(resolve(__dirname, '../../app/components/vue-canvas/CompositorModal.vue'), 'utf8')
const t = SPIKE_TAKES.rain![2]!
const two = withCodeVersion(recordFromTake(t, { id: 'mine_aaaaaaaaaaaa', request: 'r', from: null, now: 'x' }), SPIKE_TAKES.rain![0]!, { request: 'r2', now: 'y' })
const effects = expandMyEffect(two)
/** CompositorModal's `activeShaderEffectDef`, as written there. */
const defFor = (id: string) => effects.find(e => e.id === resolveEffectId(id)) ?? null

let w: VueWrapper<any> | null = null
beforeEach(() => { myEffectRecords.value = []; setMyEffectRecord(two); myEffectsLoaded.value = true })
afterEach(() => { w?.unmount(); w = null; myEffectRecords.value = []; myEffectsLoaded.value = false })

describe('Frame effect stack: a layer pinned to a My effect version', () => {
  it('wiring: the button reads the def found by the stored id, and the gallery gets the stored id', () => {
    expect(src).toMatch(/const activeShaderEffectDef = computed<EffectDef \| null>\(\(\) => \{[\s\S]{0,200}e\.id === resolveEffectId\(activeShaderEffectId\.value\)/)
    expect(src).toMatch(/data-testid="shader-fx-effect-name">\{\{ activeShaderEffectDef\?\.name \?\? activeShaderEffectId \}\}/)
    expect(src).toMatch(/:effects="shaderFxCatalog\?\.effects \?\? \[\]"[\s\S]{0,300}:selected-id="resolveEffectId\(activeShaderEffectId\)"/)
  })
  it('names the effect: its own name on the newest version, “· v1” on an older one', () => {
    expect(defFor('mine_aaaaaaaaaaaa~v2')?.name).toBe(t.name)
    expect(defFor('mine_aaaaaaaaaaaa~v1')?.name).toBe(`${t.name} · v1`)
  })
  it('shows Current on the effect’s one card whichever version the layer is pinned to', () => {
    for (const stored of ['mine_aaaaaaaaaaaa~v2', 'mine_aaaaaaaaaaaa~v1', 'mine_aaaaaaaaaaaa']) {
      w = mount(ShaderEffectGallery, { props: { open: true, effects, selectedId: resolveEffectId(stored), thumbs: {} }, attachTo: document.body })
      const current = [...document.body.querySelectorAll('[data-effect-id]')].find(e => e.closest('button')?.textContent?.includes('Current'))
      expect(current?.getAttribute('data-effect-id'), stored).toBe('mine_aaaaaaaaaaaa~v2')
      w.unmount(); w = null
    }
  })
})
