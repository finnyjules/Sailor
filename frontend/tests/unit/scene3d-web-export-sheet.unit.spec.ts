// @vitest-environment happy-dom
/**
 * 3D Studio's Export embed sheet (3D Studio on the web, Phase 1, Task 6). A pure view: the
 * surface bakes the frames and builds the file; the sheet shows the options, the progress,
 * what stops the export, and answers Render / Download / Copy embed code.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import Sheet, { assetDisplayName, failureSentence } from '~/components/vue-canvas/Scene3DWebExportSheet.vue'
import type { AssetFailure } from '~/lib/scene3d/assetTracker'

type Props = InstanceType<typeof Sheet>['$props']
const BASE = {
  state: 'idle' as const, size: 'output' as const, fps: 30 as const,
  cinematic: false, transparent: false, still: false, bytes: 0, failures: [] as AssetFailure[],
  outputSize: { width: 1200, height: 800 },
}
const mountWith = (over: Partial<Props> = {}) => mount(Sheet, { props: { ...BASE, ...over } as any })
const byTestId = (w: ReturnType<typeof mountWith>, id: string) => w.find(`[data-testid="${id}"]`)

describe('assetDisplayName', () => {
  it('shows a path as its last segment without the extension', () => {
    expect(assetDisplayName('/fonts/Inter-Bold.ttf')).toBe('Inter-Bold')
    expect(assetDisplayName('sailor_textures/Bricks104/Color.jpg')).toBe('Color')
    expect(assetDisplayName('/view?filename=robot.glb&type=input')).toBe('robot')
  })
  it('strips the texture library prefix', () => {
    expect(assetDisplayName('ambientcg:Bricks104')).toBe('Bricks104')
  })
  it('leaves a plain name alone, dots and all', () => {
    expect(assetDisplayName('Robot v1.2')).toBe('Robot v1.2')
    expect(assetDisplayName('Hero cube')).toBe('Hero cube')
  })
})

describe('failureSentence', () => {
  it('names the kind in plain words and quotes the name', () => {
    expect(failureSentence({ kind: 'font', name: '/fonts/Inter-Bold.ttf', reason: 'x' })).toBe('Font "Inter-Bold" couldn\'t load.')
    expect(failureSentence({ kind: 'texture', name: 'ambientcg:Bricks104', reason: 'x' })).toBe('Image "Bricks104" couldn\'t load.')
    expect(failureSentence({ kind: 'hdri', name: 'studio_small', reason: 'x' })).toBe('Lighting "studio_small" couldn\'t load.')
  })
  it('tells a person what to do about a model', () => {
    expect(failureSentence({ kind: 'model', name: 'Robot', reason: 'x' })).toBe('Model "Robot" couldn\'t load. Re-generate or re-upload it.')
  })
  it('does not quote a name that is only the kind again', () => {
    expect(failureSentence({ kind: 'shader', name: 'Shader effects', reason: 'x' })).toBe('Shader effects couldn\'t load.')
  })
})

describe('Scene3DWebExportSheet', () => {
  it('offers the output size and the doubled sharp size', () => {
    const w = mountWith()
    const radios = w.findAll('[role="radiogroup"][aria-label="Size"] [role="radio"]')
    expect(radios.map(r => r.text())).toEqual(['Output · 1200×800', '2× sharp · 2400×1600'])
    expect(w.text()).toContain('Sharp looks crisper on high-resolution screens and makes the file about four times bigger.')
  })

  it('renders one line per failure, a model with what to do', () => {
    const failures: AssetFailure[] = [
      { kind: 'model', name: '/view?filename=robot.glb', reason: 'Unexpected token < in JSON at position 0' },
      { kind: 'font', name: '/fonts/Inter-Bold.ttf', reason: "didn't finish loading" },
    ]
    const w = mountWith({ state: 'blocked', failures })
    const group = byTestId(w, 'scene3d-web-export-blocked')
    expect(group.exists()).toBe(true)
    expect(group.text()).toContain('Can\'t export yet')
    const items = group.findAll('li')
    expect(items).toHaveLength(2)
    expect(items[0]!.text()).toContain('Model "robot" couldn\'t load. Re-generate or re-upload it.')
    expect(items[0]!.text()).toContain('Unexpected token < in JSON at position 0')
    expect(items[1]!.text()).toContain('Font "Inter-Bold" couldn\'t load.')
    expect(items[1]!.text()).not.toContain('Re-generate')
  })

  it('shows no failure group when nothing failed', () => {
    expect(byTestId(mountWith(), 'scene3d-web-export-blocked').exists()).toBe(false)
  })

  it('says a still scene exports as one picture, exactly when it is still', () => {
    const line = 'This scene doesn\'t move, so it exports as a single picture.'
    expect(mountWith({ still: true }).text()).toContain(line)
    expect(mountWith({ still: false }).text()).not.toContain(line)
  })

  it('keeps Download and Copy embed code disabled until the file is built', () => {
    for (const state of ['idle', 'working', 'blocked', 'error'] as const) {
      const w = mountWith({ state })
      expect(byTestId(w, 'scene3d-web-export-download').attributes('disabled'), state).toBeDefined()
      expect(byTestId(w, 'scene3d-web-export-copy').attributes('disabled'), state).toBeDefined()
    }
    const ready = mountWith({ state: 'ready', bytes: 2_500_000 })
    expect(byTestId(ready, 'scene3d-web-export-download').attributes('disabled')).toBeUndefined()
    expect(byTestId(ready, 'scene3d-web-export-copy').attributes('disabled')).toBeUndefined()
    expect(byTestId(ready, 'scene3d-web-export-size').text()).toBe('One file · plays anywhere · 2.4 MB')
  })

  it('shows the Cinematic warning only when Cinematic is on and there is one', () => {
    const warning = 'Cinematic simplifies the shader material on 1 object.'
    expect(mountWith({ cinematic: true, cinematicWarning: warning }).text()).toContain(warning)
    expect(mountWith({ cinematic: false, cinematicWarning: warning }).text()).not.toContain(warning)
    expect(mountWith({ cinematic: true }).text()).toContain('Path-traced, like the Cinematic view. Much slower to export.')
  })

  it('shows progress and a Cancel while working', async () => {
    const w = mountWith({ state: 'working', progress: { done: 12, total: 90 } })
    expect(w.text()).toContain('Rendering frame 12 of 90')
    await byTestId(w, 'scene3d-web-export-cancel').trigger('click')
    expect(w.emitted('cancel')).toHaveLength(1)
    expect(byTestId(w, 'scene3d-web-export-render').exists()).toBe(false)
  })

  it('emits each option change', async () => {
    const w = mountWith()
    await w.find('[role="radiogroup"][aria-label="Size"] [data-value="sharp"]').trigger('click')
    expect(w.emitted('update:size')?.[0]).toEqual(['sharp'])
    await w.find('[role="radiogroup"][aria-label="Frame rate"] [data-value="24"]').trigger('click')
    expect(w.emitted('update:fps')?.[0]).toEqual([24])
    await w.find('[role="switch"][aria-label="Cinematic"]').trigger('click')
    expect(w.emitted('update:cinematic')?.[0]).toEqual([true])
    await w.find('[role="switch"][aria-label="Transparent background"]').trigger('click')
    expect(w.emitted('update:transparent')?.[0]).toEqual([true])
  })

  it('answers Render, Download, Copy embed code and Close', async () => {
    const idle = mountWith()
    await byTestId(idle, 'scene3d-web-export-render').trigger('click')
    expect(idle.emitted('build')).toHaveLength(1)
    await byTestId(idle, 'scene3d-web-export-close').trigger('click')
    expect(idle.emitted('close')).toHaveLength(1)
    const ready = mountWith({ state: 'ready', bytes: 1000 })
    await byTestId(ready, 'scene3d-web-export-download').trigger('click')
    await byTestId(ready, 'scene3d-web-export-copy').trigger('click')
    expect(ready.emitted('download')).toHaveLength(1)
    expect(ready.emitted('copy')).toHaveLength(1)
  })

  it('shows the embed code to copy by hand when the clipboard refused', () => {
    const snippet = '<iframe src="sailor-3d.html"></iframe>'
    const w = mountWith({ state: 'ready', copyStatus: 'failed', snippet })
    expect((byTestId(w, 'scene3d-web-export-copy-failed').find('textarea').element as HTMLTextAreaElement).value).toBe(snippet)
  })

  it('writes the error in plain words', () => {
    const w = mountWith({ state: 'error', errorText: 'The export couldn\'t be built. Try again.' })
    expect(w.text()).toContain('The export couldn\'t be built. Try again.')
  })

  it('locks the transparent switch on, with a hint, when the scene background is already transparent', () => {
    const w = mountWith({ transparent: true, transparentLocked: true })
    expect(w.find('[role="switch"][aria-label="Transparent background"]').attributes('aria-checked')).toBe('true')
    expect(byTestId(w, 'scene3d-web-export-transparent-lock').classes()).toEqual(
      expect.arrayContaining(['pointer-events-none', 'opacity-60']))
    expect(w.text()).toContain('This scene\'s background is already transparent.')
  })

  it('leaves the transparent switch free to toggle when the background is not transparent', () => {
    const w = mountWith()
    expect(byTestId(w, 'scene3d-web-export-transparent-lock').classes()).not.toContain('pointer-events-none')
    expect(byTestId(w, 'scene3d-web-export-transparent-hint').exists()).toBe(false)
  })

  it('shows the download confirmation without hiding Copy embed code', () => {
    const w = mountWith({ state: 'ready', bytes: 636_000, downloadNotice: 'Downloaded · 636 KB' })
    expect(byTestId(w, 'scene3d-web-export-downloaded').text()).toBe('Downloaded · 636 KB')
    expect(byTestId(w, 'scene3d-web-export-copy').exists()).toBe(true)
  })

  it('shows no download confirmation until one is set', () => {
    expect(byTestId(mountWith({ state: 'ready' }), 'scene3d-web-export-downloaded').exists()).toBe(false)
  })
})
