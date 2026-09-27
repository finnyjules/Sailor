// frontend/tests/unit/studio-actions.unit.spec.ts
// @vitest-environment happy-dom
// The inspector's action rows after the 2026-09-25 redesign: rows that each do something
// different, with a plain name, one line of description and the price; no Tune, no
// Edit / Develop headings; a hint line pointing at the prompt.
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { LAYERS_FULL, REMIX_ACTION, layerAddActions, runStudioAction, studioActions, type StudioAction } from '~/lib/studio/studioActions'
import { assistEstimateText } from '~/lib/pricing'
import StudioActionRows from '~/components/vue-canvas/studio/StudioActionRows.vue'
import StudioActionRow from '~/components/vue-canvas/studio/StudioActionRow.vue'
import StudioInspectorHead from '~/components/vue-canvas/studio/StudioInspectorHead.vue'

const ids = (a: { id: string }[]) => a.map(x => x.id)
const labels = (a: { label: string }[]) => a.map(x => x.label)
// happy-dom rewrites import.meta.url, so read from the frontend root (vitest's cwd).
const src = (name: string) => readFileSync(resolve(process.cwd(), 'app/components/vue-canvas', name), 'utf8')
const prompt = () => ({ setMode: vi.fn(), runKind: vi.fn() })

describe('studioActions: each studio’s rows', () => {
  it('Shader: Try other settings, then Rewrite the effect — nothing else', () => {
    const rows = studioActions({ place: 'shader', canTakes: true })
    expect(ids(rows)).toEqual(['vary', 'remix'])
    expect(labels(rows)).toEqual(['Try other settings', 'Rewrite the effect'])
    expect(rows[0]!.description).toBe('Same effect, 3 new sets of dial values')
    expect(rows[1]!.description).toBe('3 new versions of the code itself')
    expect(rows[1]).toBe(REMIX_ACTION)
  })
  it('the studios with takes get Try other settings, named for their own thing', () => {
    expect(labels(studioActions({ place: 'gradient', canTakes: true }))).toEqual(['Try other settings'])
    expect(studioActions({ place: 'gradient', canTakes: true })[0]!.description).toBe('Same gradient, 3 new sets of dial values')
    expect(studioActions({ place: 'shape', canTakes: true })[0]!.description).toBe('Same shape, 3 new sets of dial values')
    expect(studioActions({ place: 'vectortype', canTakes: true })[0]!.description).toBe('Same lettering, 3 new sets of dial values')
  })
  it('a studio without takes has no AI row (Texture, Space type): typing is the way in', () => {
    expect(studioActions({ place: 'texture', canTakes: false })).toEqual([])
    expect(studioActions({ place: 'spacetype', canTakes: false })).toEqual([])
  })
  it('Frame: Write copy, Describe a new background, and Rewrite the background only over a shader background', () => {
    expect(labels(studioActions({ place: 'frame', canTakes: false }))).toEqual(['Write copy', 'Describe a new background'])
    expect(ids(studioActions({ place: 'frame', canTakes: false, backgroundIsShader: true }))).toEqual(['write-copy', 'new-background', 'remix-background'])
  })
  it('no row is Tune: typing in the prompt already does that', () => {
    for (const place of ['shader', 'gradient', 'shape', 'texture', 'vectortype', 'spacetype', 'frame'] as const) {
      const rows = studioActions({ place, canTakes: true, backgroundIsShader: true })
      expect(ids(rows)).not.toContain('tune')
      expect(rows.some(r => 'mode' in r.run && r.run.mode === 'Tune')).toBe(false)
    }
  })
  it('local rows follow the AI rows', () => {
    const reroll: StudioAction = { id: 'reroll', label: 'Randomize', description: 'Random new settings', ai: false, lands: null, run: { call: vi.fn() } }
    expect(ids(studioActions({ place: 'shape', canTakes: true, local: [reroll] }))).toEqual(['vary', 'reroll'])
  })
  it('names are sentence case, with no identifiers and no trailing ellipsis; every row has a description', () => {
    const all = [
      ...studioActions({ place: 'shader', canTakes: true }),
      ...studioActions({ place: 'frame', canTakes: false, backgroundIsShader: true }),
      ...layerAddActions({ addEmpty: () => {} }),
    ]
    for (const a of all) {
      expect(a.label).toMatch(/^[A-Z][a-z]/)
      expect(a.label).not.toMatch(/…|\.\.\.|tweak|new-effect|_/)
      expect(a.label.slice(1)).toBe(a.label.slice(1).toLowerCase())
      expect(a.description.length).toBeGreaterThan(0)
      expect(a.description).not.toMatch(/…$/)
    }
  })
})

describe('prices', () => {
  it('Try other settings costs a run of assist calls, in credits locally and hosted', () => {
    const vary = studioActions({ place: 'shader', canTakes: true })[0]!
    expect(vary.priceFor!(false)).toBe('2–6 credits')
    expect(vary.priceFor!(true)).toBe('2–6 credits')
    expect(vary.priceFor!(true)).toBe(assistEstimateText(true))
  })
  it('the effect rows carry the shader-generation estimate', () => {
    const rows = [...studioActions({ place: 'frame', canTakes: false, backgroundIsShader: true }), ...studioActions({ place: 'shader', canTakes: true }), ...layerAddActions({ addEmpty: () => {} })]
    for (const id of ['new-background', 'remix-background', 'new-layer', 'remix']) {
      const a = rows.find(r => r.id === id)!
      expect(a.lands).toBe('takes')
      expect(a.priceFor!(false)).toBe('30–84 credits')
      expect(a.priceFor!(true)).toMatch(/^\d+–\d+ credits$/)
    }
  })
  it('a row that spends nothing has no price', () => {
    expect(layerAddActions({ addEmpty: () => {} }).find(a => a.id === 'empty-layer')!.priceFor).toBeUndefined()
  })
})

describe('runs', () => {
  it('a mode chip, a kind, or the surface’s own call — the same as before', () => {
    const p = prompt()
    const [vary, remix] = studioActions({ place: 'shader', canTakes: true })
    runStudioAction(vary!, p); expect(p.runKind).toHaveBeenCalledWith('tweak', { fromMenu: true })
    runStudioAction(remix!, p); expect(p.setMode).toHaveBeenLastCalledWith('Remix', { add: undefined })
    const newLayer = layerAddActions({ addEmpty: () => {} }).find(a => a.id === 'new-layer')!
    runStudioAction(newLayer, p); expect(p.setMode).toHaveBeenLastCalledWith('New effect', { add: true })
    const [writeCopy, newBg] = studioActions({ place: 'frame', canTakes: false })
    runStudioAction(writeCopy!, p); expect(p.setMode).toHaveBeenLastCalledWith('Write copy', { add: undefined })
    runStudioAction(newBg!, p); expect(p.setMode).toHaveBeenLastCalledWith('New effect', { add: undefined })
    const addEmpty = vi.fn()
    runStudioAction(layerAddActions({ addEmpty })[0]!, null)
    expect(addEmpty).toHaveBeenCalled()
  })
})

describe('Layers + menu (Shader)', () => {
  it('offers an empty layer and Describe a new layer, the AI one starred and priced', () => {
    const acts = layerAddActions({ addEmpty: () => {} })
    expect(labels(acts)).toEqual(['Empty layer', 'Describe a new layer'])
    const w = mount(StudioActionRow, { props: { action: acts[1]!, prompt: prompt() } })
    expect(w.findComponent({ name: 'AiMark' }).exists()).toBe(true)
    expect(w.find('[data-testid="studio-action-price"]').text()).toBe('30–84 credits')
    const e = mount(StudioActionRow, { props: { action: acts[0]!, prompt: prompt() } })
    expect(e.findComponent({ name: 'AiMark' }).exists()).toBe(false)
    expect(e.find('[data-testid="studio-action-price"]').exists()).toBe(false)
  })
  it('a full stack turns both off and says why; running does nothing', async () => {
    const addEmpty = vi.fn()
    const [empty, newLayer] = layerAddActions({ addEmpty, layersFull: true })
    expect(newLayer).toMatchObject({ disabled: true, disabledHint: LAYERS_FULL })
    expect(LAYERS_FULL).toBe('The studio holds six layers. Remove one to add another.')
    const p = prompt()
    const w = mount(StudioActionRow, { props: { action: newLayer!, prompt: p } })
    expect(w.find('button').attributes('disabled')).toBeDefined()
    expect(w.find('[data-testid="studio-action-disabled-hint"]').text()).toBe(LAYERS_FULL)
    await w.find('button').trigger('click')
    runStudioAction(empty!, p)
    expect(p.setMode).not.toHaveBeenCalled()
    expect(addEmpty).not.toHaveBeenCalled()
  })
  it('the Shader surface opens the menu from +, and the menu runs through its prompt', () => {
    const s = src('ShaderStudioSurface.vue')
    expect(s).toContain('@add="openAddMenu"')
    expect(s).toMatch(/const addLayerActions = computed\(\(\) => layerAddActions\(\{ addEmpty: addEffect, layersFull: layersFull\.value \}\)\)/)
    expect(s).toMatch(/data-testid="shader-add-layer-menu"[\s\S]{0,400}<StudioActionRow v-for="a in addLayerActions"[^>]*:prompt="shellRef\?\.prompt"[^>]*@ran="addMenuOpen = false"/)
    // "New layer from a description…" is no longer an inspector row.
    expect(s).not.toContain('New layer from a description')
  })
})

describe('Shader head and dice', () => {
  it('the head names the effect, with Change effect on its row as an enabled-looking small button', () => {
    const s = src('ShaderStudioSurface.vue')
    // The same label as the prompt's chip: the effect's own name ("Prism drift").
    expect(s).toMatch(/const promptLabel = computed\(\(\) => effectDef\.value\?\.name \?\? 'Shader'\)/)
    expect(s).toMatch(/<StudioInspectorHead :title="promptLabel"[\s\S]{0,120}<template #aside>\s*<StudioButton :disabled="layerReadOnly" @click="openPicker" variant="outline" size="sm">Change effect<\/StudioButton>/)
    const w = mount(StudioInspectorHead, { props: { title: 'Prism drift' }, slots: { aside: '<button>Change effect</button>' } })
    expect(w.find('[data-testid="studio-inspector-title"]').text()).toBe('Prism drift')
    // same row as the title
    expect(w.find('[data-testid="studio-inspector-title"]').element.parentElement!.parentElement!.textContent).toContain('Change effect')
  })
  it('New variation is a dice button on the Variation dial, not a row', () => {
    const s = src('ShaderStudioSurface.vue')
    expect(s).toMatch(/label="Variation"[\s\S]{0,300}<button type="button" aria-label="New variation"[\s\S]{0,400}@click="rerollSeed">\s*<Dice5 /)
    expect(s).not.toMatch(/id: 'new-variation'/)
  })
})

describe('StudioActionRows', () => {
  it('one card of rows — no headings, no hint line; the description is the row\'s tooltip, not a line', () => {
    const w = mount(StudioActionRows, { props: { actions: studioActions({ place: 'shader', canTakes: true }), prompt: prompt() as any } })
    expect(w.findAll('h4')).toHaveLength(0)
    const rows = w.findAll('[data-testid="studio-action-row"]')
    expect(rows.map(r => r.attributes('data-action-id'))).toEqual(['vary', 'remix'])
    expect(rows[0]!.find('[data-testid="studio-action-name"]').text()).toBe('Try other settings')
    expect(rows[0]!.find('[data-testid="studio-action-description"]').exists()).toBe(false)
    expect(rows[0]!.attributes('aria-description')).toBe('Same effect, 3 new sets of dial values')
    expect(rows[0]!.find('[data-testid="studio-action-price"]').text()).toBe('2–6 credits')
    expect(rows[1]!.find('[data-testid="studio-action-price"]').text()).toBe('30–84 credits')
    for (const r of rows) expect(r.findComponent({ name: 'AiMark' }).exists()).toBe(true)
    expect(w.text()).not.toContain('prompt below')
  })
  it('the card matches the StudioSection cards; no pills, no new colours', () => {
    const w = mount(StudioActionRows, { props: { actions: studioActions({ place: 'gradient', canTakes: true }), prompt: prompt() as any } })
    const card = w.find('[data-testid="studio-actions"]')
    for (const c of ['rounded-lg', 'border', 'border-white/[0.10]', 'bg-white/[0.04]']) expect(card.classes()).toContain(c)
    expect(w.html()).not.toMatch(/rounded-full/)
    const name = w.find('[data-testid="studio-action-name"]')
    expect(name.classes()).toContain('whitespace-nowrap') // names never truncate
    expect(name.classes()).not.toContain('truncate')
  })
  it('a non-AI row has no star and no price', () => {
    const local: StudioAction[] = [{ id: 'randomize', label: 'Randomize', description: 'A random new gradient, no AI', ai: false, lands: null, run: { call: vi.fn() } }]
    const w = mount(StudioActionRows, { props: { actions: studioActions({ place: 'gradient', canTakes: true, local }), prompt: prompt() as any } })
    const r = w.find('[data-action-id="randomize"]')
    expect(r.findComponent({ name: 'AiMark' }).exists()).toBe(false)
    expect(r.find('[data-testid="studio-action-price"]').exists()).toBe(false)
  })
  it('no rows (Space type): nothing at all', () => {
    const w = mount(StudioActionRows, { props: { actions: [], prompt: prompt() as any } })
    expect(w.find('[data-testid="studio-actions"]').exists()).toBe(false)
  })
  it('a disabled row keeps its reason as a visible line', () => {
    const local: StudioAction[] = [{ id: 'x', label: 'Randomize', description: 'Random', disabled: true, disabledHint: 'Add a layer first', ai: false, lands: null, run: { call: vi.fn() } }]
    const w = mount(StudioActionRows, { props: { actions: local, prompt: prompt() as any } })
    expect(w.find('[data-testid="studio-action-disabled-hint"]').text()).toBe('Add a layer first')
  })
  it('a click runs the action through the prompt', async () => {
    const p = prompt() as any
    const w = mount(StudioActionRows, { props: { actions: studioActions({ place: 'gradient', canTakes: true }), prompt: p } })
    await w.find('[data-action-id="vary"]').trigger('click')
    expect(p.runKind).toHaveBeenCalledWith('tweak', { fromMenu: true })
  })
})

describe('the studios’ own rows', () => {
  it('renamed in plain words, each with a description', () => {
    expect(src('GradientStudioSurface.vue')).toMatch(/id: 'randomize', label: 'Randomize', description: 'A random new gradient, no AI'/)
    expect(src('ShapeStudioSurface.vue')).toMatch(/id: 'reroll', label: 'Randomize', description: 'Random new settings, locked sections stay'/)
    expect(src('TextureStudioSurface.vue')).toMatch(/id: 'roll', label: 'New variation', description: 'Same pattern, a new random seed'/)
    expect(src('CompositorModal.vue')).toMatch(/id: 'layouts', label: 'Try layouts', description: 'Other arrangements of this frame, no AI'/)
  })
})
