// frontend/tests/unit/my-effect-recipe.unit.spec.ts
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { recordFromTake, withValuesVersion, valuesForVersion } from '~/lib/myEffects/defs'
import { myEffectRecords, setMyEffectRecord } from '~/lib/myEffects/library'
import { SPIKE_TAKES } from '~/lib/shadergen/__eval__/spikeTakes'

const rename = vi.fn(async () => ({})), remove = vi.fn(async () => {})
vi.mock('~/composables/useMyEffects', () => ({ useMyEffects: () => ({ rename, remove }) }))
import MyEffectRecipe from '~/components/vue-canvas/MyEffectRecipe.vue'

const t = SPIKE_TAKES.rain![2]!
const u = t.params[0]!.uniform
const rec = withValuesVersion(recordFromTake(t, { id: 'mine_aaaaaaaaaaaa', request: 'rain on a window', from: 'Water ripple', now: 'x' }), { [u]: 0.123 }, { request: 'softer', now: 'x' })!

describe('MyEffectRecipe (spec §7.4)', () => {
  beforeEach(() => { myEffectRecords.value = []; setMyEffectRecord(rec); rename.mockClear(); remove.mockClear() })

  it('shows the name, where it came from, the first request and one chip per version', () => {
    const w = mount(MyEffectRecipe, { props: { effectId: 'mine_aaaaaaaaaaaa', values: valuesForVersion(rec, 1) } })
    expect((w.get('[data-testid="my-effect-name"]').element as HTMLInputElement).value).toBe(t.name)
    expect(w.get('[data-testid="my-effect-from"]').text()).toBe('My effect · from Water ripple')
    expect(w.get('[data-testid="my-effect-note"]').text()).toBe('“rain on a window”')
    const chips = w.findAll('[data-testid="my-effect-version"]')
    expect(chips.map(c => c.text())).toEqual(['v1', 'v2'])
    expect(chips.map(c => c.attributes('aria-pressed'))).toEqual(['false', 'true'])
  })
  it('a chip switches the target to that version', async () => {
    const w = mount(MyEffectRecipe, { props: { effectId: 'mine_aaaaaaaaaaaa', values: valuesForVersion(rec, 1) } })
    await w.findAll('[data-testid="my-effect-version"]')[0]!.trigger('click')
    expect(w.emitted('pick-version')![0]![0]).toEqual({ effectId: 'mine_aaaaaaaaaaaa', values: valuesForVersion(rec, 0) })
  })
  it('renames on change (trimmed), never to empty', async () => {
    const w = mount(MyEffectRecipe, { props: { effectId: 'mine_aaaaaaaaaaaa', values: {} } })
    const input = w.get('[data-testid="my-effect-name"]')
    await input.setValue('  Wet glass '); await input.trigger('change')
    expect(rename).toHaveBeenCalledWith('mine_aaaaaaaaaaaa', 'Wet glass')
    await input.setValue('   '); await input.trigger('change')
    expect(rename).toHaveBeenCalledTimes(1)
  })
  it('remove asks first', async () => {
    const w = mount(MyEffectRecipe, { props: { effectId: 'mine_aaaaaaaaaaaa', values: {} } })
    await w.get('[data-testid="my-effect-remove"]').trigger('click')
    expect(remove).not.toHaveBeenCalled()
    expect(w.get('[data-testid="my-effect-remove-confirm"]').text()).toContain(`Remove “${t.name}” from My effects?`)
    await w.get('[data-testid="my-effect-remove-confirm"] button').trigger('click')
    expect(remove).toHaveBeenCalledWith('mine_aaaaaaaaaaaa')
  })
  it('a built-in effect has no recipe', () => {
    expect(mount(MyEffectRecipe, { props: { effectId: 'water_ripple', values: {} } }).html()).toBe('<!--v-if-->')
  })
})
