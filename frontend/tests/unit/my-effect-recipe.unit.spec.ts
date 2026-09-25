// frontend/tests/unit/my-effect-recipe.unit.spec.ts
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { recordFromTake, withValuesVersion, valuesForVersion } from '~/lib/myEffects/defs'
import { myEffectRecords, setMyEffectRecord } from '~/lib/myEffects/library'
import { SPIKE_TAKES } from '~/lib/shadergen/__eval__/spikeTakes'

const rename = vi.fn(async () => ({})), remove = vi.fn(async () => {})
vi.mock('~/composables/useMyEffects', () => ({ useMyEffects: () => ({ rename, remove }) }))
import MyEffectRecipe from '~/components/vue-canvas/MyEffectRecipe.vue'

const t = SPIKE_TAKES.rain![2]!
const u = t.params[0]!.uniform
const rec = withValuesVersion(recordFromTake(t, { id: 'mine_aaaaaaaaaaaa', request: 'rain on a window', from: 'Water ripple', now: 'x' }), { [u]: 0.123 }, { request: 'softer', now: 'x' })!

// A second, independent record for the lastSent-resync case (fix round 1, #4).
const t2 = SPIKE_TAKES.rain![0]!
const rec2 = recordFromTake(t2, { id: 'mine_bbbbbbbbbbbb', request: 'droplets', from: null, now: 'x' })

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
    expect(w.emitted('pick-version')![0]![0]).toEqual({ effectId: 'mine_aaaaaaaaaaaa~v1', values: valuesForVersion(rec, 0) })
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

  // Fix round 1, #1: version chips (and rename/remove, for consistency) must respect the
  // same read-only lock every other target mutator in the host respects while a take set
  // is open — a disabled Recipe must not emit or call through on a click.
  it('disabled: chips, rename and remove are inert (a take set is open on this target)', async () => {
    const w = mount(MyEffectRecipe, { props: { effectId: 'mine_aaaaaaaaaaaa', values: valuesForVersion(rec, 1), disabled: true } })
    const chip = w.findAll('[data-testid="my-effect-version"]')[0]!
    expect(chip.attributes('disabled')).toBeDefined()
    await chip.trigger('click')
    expect(w.emitted('pick-version')).toBeUndefined()

    const nameInput = w.get('[data-testid="my-effect-name"]')
    expect(nameInput.attributes('disabled')).toBeDefined()
    await nameInput.setValue('Wet glass'); await nameInput.trigger('change')
    expect(rename).not.toHaveBeenCalled()

    const removeBtn = w.get('[data-testid="my-effect-remove"]')
    expect(removeBtn.attributes('disabled')).toBeDefined()
    await removeBtn.trigger('click')
    expect(w.find('[data-testid="my-effect-remove-confirm"]').exists()).toBe(false)
    expect(remove).not.toHaveBeenCalled()
  })

  // Fix round 1, #3: a rejected rename/remove shows useMyEffects' plain-sentence error
  // inline, rather than a silently swallowed rejection.
  it('a rename failure shows the plain-sentence error inline', async () => {
    rename.mockRejectedValueOnce(new Error('That effect isn’t in My effects any more.'))
    const w = mount(MyEffectRecipe, { props: { effectId: 'mine_aaaaaaaaaaaa', values: {} } })
    const input = w.get('[data-testid="my-effect-name"]')
    // A single `setValue` already dispatches its own 'change' (see the "renames on
    // change" test's own note on this) — no second explicit trigger needed here, and
    // adding one would fire onRename again against the RE-RENDERED (reset-to-rec.name)
    // DOM value once `error` flips from the rejection, causing a spurious second call.
    await input.setValue('Wet glass')
    await flushPromises(); await nextTick()
    expect(w.get('[data-testid="my-effect-error"]').text()).toBe('That effect isn’t in My effects any more.')
  })
  it('a remove failure shows the plain-sentence error inline', async () => {
    remove.mockRejectedValueOnce(new Error('Couldn’t remove that effect from My effects.'))
    const w = mount(MyEffectRecipe, { props: { effectId: 'mine_aaaaaaaaaaaa', values: {} } })
    await w.get('[data-testid="my-effect-remove"]').trigger('click')
    await w.get('[data-testid="my-effect-remove-confirm"] button').trigger('click')
    await flushPromises(); await nextTick()
    expect(w.get('[data-testid="my-effect-error"]').text()).toBe('Couldn’t remove that effect from My effects.')
  })

  // Fix round 1, #4: `lastSent` must re-sync when the target switches to a different
  // record, or a name that happens to match the PREVIOUS record's last-committed text
  // is wrongly treated as already sent.
  it('re-syncs its rename de-dupe when the target switches to a different record', async () => {
    setMyEffectRecord(rec2)
    const w = mount(MyEffectRecipe, { props: { effectId: 'mine_aaaaaaaaaaaa', values: {} } })
    const input = w.get('[data-testid="my-effect-name"]')
    await input.setValue('Wet glass'); await input.trigger('change')
    expect(rename).toHaveBeenCalledWith('mine_aaaaaaaaaaaa', 'Wet glass')
    rename.mockClear()

    await w.setProps({ effectId: 'mine_bbbbbbbbbbbb', values: {} })
    await input.setValue('Wet glass'); await input.trigger('change')
    expect(rename).toHaveBeenCalledWith('mine_bbbbbbbbbbbb', 'Wet glass')
  })
})
