// frontend/tests/unit/shader-fill-editor-my-effects.unit.spec.ts
// Fix round 1, #2 (task-11-review): preflight C2 explicitly calls for one unit case
// proving ShaderFillEditor's `u_` ↔ unprefixed key mapping at its MyEffectRecipe mount —
// `ShaderSpec.params` drops the `u_` prefix, but a My effect's own values (and what the
// Recipe emits on `pick-version`) keep it. A broken mapping either resets every dial to
// its default (values not re-prefixed on the way in, so `activeVersionIndex` never
// matches) or silently drops every dial on Keep (values not unprefixed on the way out).
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import { recordFromTake } from '~/lib/myEffects/defs'
import { myEffectRecords, setMyEffectRecord } from '~/lib/myEffects/library'
import { unprefixedKey } from '~/lib/shaderfill/descriptor'
import { DEFAULT_SHADER_SPEC } from '~/lib/spacetype/fillTile'
import { SPIKE_TAKES } from '~/lib/shadergen/__eval__/spikeTakes'

const rename = vi.fn(async () => ({})), remove = vi.fn(async () => {})
vi.mock('~/composables/useMyEffects', () => ({ useMyEffects: () => ({ rename, remove }) }))

// Real catalog module, stubbed the way shader-effect-node-takes.unit.spec.ts does: no
// network I/O, and `catalog` starts empty so this editor's own paramRows/effectDef stay
// empty — this test is about the key-mapping seam, not the derived param controls.
const catalog = ref<{ effects: unknown[] } | null>(null)
vi.mock('~/lib/shaderfx/catalog', () => ({
  useShaderCatalog: () => catalog,
  fetchShaderFxCatalog: async () => catalog.value,
  resolveEffectId: (id: string) => id,
  assetUrl: (f: string) => f,
}))
vi.mock('~/lib/shaderfill/field', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/shaderfill/field')>()
  return { ...actual, retryFieldCatalog: () => {} }
})

import ShaderFillEditor from '~/components/vue-canvas/widgets/ShaderFillEditor.vue'
import MyEffectRecipe from '~/components/vue-canvas/MyEffectRecipe.vue'

const t = SPIKE_TAKES.rain![2]!
const u = t.params[0]!.uniform // e.g. 'u_density' — the RAW, `u_`-prefixed uniform name
const bare = unprefixedKey(u)  // e.g. 'density' — how ShaderSpec.params keys it
const rec = recordFromTake(t, { id: 'mine_aaaaaaaaaaaa', request: 'rain on a window', from: null, now: 'x' })

function mountEditor(params: Record<string, number>) {
  return mount(ShaderFillEditor, {
    props: {
      modelValue: { ...DEFAULT_SHADER_SPEC, effectId: 'mine_aaaaaaaaaaaa', params },
      showAnchor: false, showSpeed: false, showSeed: false, showInput: false,
    },
  })
}

describe('ShaderFillEditor ⇄ MyEffectRecipe: the u_ ↔ unprefixed round-trip (preflight C2)', () => {
  beforeEach(() => { myEffectRecords.value = []; setMyEffectRecord(rec) })

  it('re-prefixes modelValue.params (unprefixed) into u_-prefixed values for the Recipe', () => {
    const w = mountEditor({ [bare]: 0.75 })
    const recipe = w.findComponent(MyEffectRecipe)
    expect(recipe.exists()).toBe(true)
    expect(recipe.props('values')).toEqual({ [u]: 0.75 })
  })

  it('a pick-version emit (u_-prefixed values) patches modelValue.params unprefixed', async () => {
    const w = mountEditor({})
    const recipe = w.findComponent(MyEffectRecipe)
    recipe.vm.$emit('pick-version', { effectId: 'mine_aaaaaaaaaaaa', values: { [u]: 0.42 } })
    await nextTick()
    const emitted = w.emitted('update:modelValue')!.at(-1)![0] as typeof DEFAULT_SHADER_SPEC
    expect(emitted.effectId).toBe('mine_aaaaaaaaaaaa')
    expect(emitted.params).toEqual({ [bare]: 0.42 })
    expect(Object.keys(emitted.params)).not.toContain(u) // never left `u_`-prefixed
  })
})
