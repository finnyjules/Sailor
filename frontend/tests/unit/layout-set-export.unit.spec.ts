// @vitest-environment happy-dom
//
// Stage 5 (Make a set), Task 3: downloading the set as a zip of PNGs — file naming, which formats
// are exported (nothing-fits skipped), the render loop with the renderer injected (order, progress,
// cancel between formats, one failing format leaves the others), the zip itself, the set state's
// download, and the sheet's progress / Cancel / failure lines.
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import JSZip from 'jszip'
import {
  exportableEntries, mergeStackOrder, runSetExport, setFileName, setProgressLabel, setZipName,
} from '~/lib/frame/layoutSetExport'
import { zipBlobs } from '~/lib/deliverables/zip'
import { useLayoutSet } from '~/composables/useLayoutSet'
import LayoutSetSheet from '~/components/vue-canvas/compositor/LayoutSetSheet.vue'
import { FRAME_FORMATS } from '~/lib/frame/formats'
import type { SetEntry } from '~/lib/frame/patterns/kit/set'
import type { LocalLayer } from '~/composables/useCompositorLayers'

/** A set entry for a real format: something fits (`fits`), or nothing does (all nulls). */
function entry(formatId: string, fits = true): SetEntry {
  const f = FRAME_FORMATS.find(x => x.id === formatId)!
  const layers = [{ id: `t-${formatId}`, kind: 'text', text: 'Summer sale', x: 0.1, y: 0.1, w: 0.8 } as unknown as LocalLayer]
  return fits
    ? {
        formatId, label: f.label, w: f.w, h: f.h, layoutId: 'runoff', layoutName: 'Run-off', swapped: false,
        choice: {} as SetEntry['choice'],
        plan: { layers, order: [`l:t-${formatId}`], did: '', issues: [], posterState: { patternId: 'runoff', seed: 1, choice: {} as never, roles: {} as never }, format: null } as unknown as SetEntry['plan'],
        layers, groups: [],
      }
    : { formatId, label: f.label, w: f.w, h: f.h, layoutId: null, layoutName: null, swapped: false, choice: null, plan: null, layers: null, groups: null }
}
const png = (s: string) => new Blob([s], { type: 'image/png' })
const SET = [entry('meta-feed-1x1'), entry('ad-320x50', false), entry('meta-story'), entry('ad-300x250')]

describe('naming', () => {
  it('each image is <format-id>.png', () => {
    expect(setFileName(entry('meta-story'))).toBe('meta-story.png')
    expect(setFileName(entry('ad-300x250'))).toBe('ad-300x250.png')
  })
  it('the zip is <frame-name>_set_<timestamp>.zip, "frame" when the Frame has no name', () => {
    expect(setZipName('Summer sale', 1758700000000)).toBe('Summer sale_set_1758700000000.zip')
    expect(setZipName('', 42)).toBe('frame_set_42.zip')
    expect(setZipName(undefined, 42)).toBe('frame_set_42.zip')
    expect(setZipName('  ', 42)).toBe('frame_set_42.zip')
    expect(setZipName('A/B: sale?', 42)).toBe('A-B- sale-_set_42.zip')
  })
  it('the progress line reads "Rendering 3 of 7…"', () => {
    expect(setProgressLabel(3, 7)).toBe('Rendering 3 of 7…')
  })
})

describe('which formats are exported', () => {
  it('skips a format nothing fits, keeping the order', () => {
    expect(exportableEntries(SET).map(e => e.formatId)).toEqual(['meta-feed-1x1', 'meta-story', 'ad-300x250'])
  })
})

describe('the draw order of a planned format', () => {
  it('the stored order over the keys present, then the rest in their own order', () => {
    expect(mergeStackOrder(['l:b', 'l:gone', 'l:a'], ['w:1', 'l:a', 'l:b', 'l:c'])).toEqual(['l:b', 'l:a', 'w:1', 'l:c'])
    expect(mergeStackOrder([], ['w:1', 'l:a'])).toEqual(['w:1', 'l:a'])
  })
})

describe('runSetExport — the loop, renderer injected', () => {
  it('renders each exported format once, in order, at its own size, with progress before each', async () => {
    const sizes: string[] = []
    const progress: string[] = []
    const out = await runSetExport(SET, {
      render: async (e) => { sizes.push(`${e.formatId} ${e.w}×${e.h}`); return png(e.formatId) },
      onProgress: (n, total) => progress.push(setProgressLabel(n, total)),
    })
    expect(sizes).toEqual(['meta-feed-1x1 1200×1200', 'meta-story 1080×1920', 'ad-300x250 300×250'])
    expect(progress).toEqual(['Rendering 1 of 3…', 'Rendering 2 of 3…', 'Rendering 3 of 3…'])
    expect(out.files.map(f => f.path)).toEqual(['meta-feed-1x1.png', 'meta-story.png', 'ad-300x250.png'])
    expect(out.failures).toEqual([])
    expect(out.cancelled).toBe(false)
  })

  it('a cancel stops before the next format — the one rendering finishes, nothing after it starts', async () => {
    let stop = false
    const render = vi.fn(async (e: SetEntry) => { stop = true; return png(e.formatId) })
    const out = await runSetExport(SET, { render, cancelled: () => stop })
    expect(render).toHaveBeenCalledTimes(1)
    expect(out.files.map(f => f.path)).toEqual(['meta-feed-1x1.png'])
    expect(out.cancelled).toBe(true)
  })

  it('a format that fails is named, and the others still render', async () => {
    const out = await runSetExport(SET, {
      render: async (e) => {
        if (e.formatId === 'meta-story') throw new Error('Font failed to load')
        if (e.formatId === 'ad-300x250') return null
        return png(e.formatId)
      },
    })
    expect(out.files.map(f => f.path)).toEqual(['meta-feed-1x1.png'])
    expect(out.failures).toEqual([
      { formatId: 'meta-story', label: 'Meta story / reel · 9:16', message: 'Font failed to load' },
      { formatId: 'ad-300x250', label: 'Display ad · 300×250', message: 'No image was made' },
    ])
    expect(out.cancelled).toBe(false)
  })
})

describe('zipBlobs', () => {
  it('holds each file at its path with its bytes', async () => {
    const blob = await zipBlobs([{ path: 'meta-story.png', blob: png('A') }, { path: 'ad-300x250.png', blob: png('BB') }])
    const zip = await JSZip.loadAsync(await blob.arrayBuffer())
    expect(Object.keys(zip.files).sort()).toEqual(['ad-300x250.png', 'meta-story.png'])
    expect(await zip.file('meta-story.png')!.async('string')).toBe('A')
    expect(await zip.file('ad-300x250.png')!.async('string')).toBe('BB')
  })
})

describe('the tiles leave out effects and shader fills: the footer note', () => {
  it('is shown for a post effect that is on, or a shader fill on a layer or the background', async () => {
    const { effectsInDownload } = await import('~/lib/frame/layoutSetExport')
    const shader = { type: 'shader', a: '#000', b: '#fff', density: 1, shader: { effectId: 'prism' } }
    expect(effectsInDownload([], [{ id: 't', kind: 'text', color: '#111' }], '#fff')).toBe(false)
    expect(effectsInDownload([{ visible: false }], [], '#fff')).toBe(false)
    expect(effectsInDownload([{ visible: true }], [], '#fff')).toBe(true)
    expect(effectsInDownload([], [{ id: 'r', kind: 'rect', fill: shader }], '#fff')).toBe(true)
    expect(effectsInDownload([], [{ id: 't', kind: 'text', stroke: { paint: shader } }], undefined)).toBe(true)
    expect(effectsInDownload(undefined, [], shader)).toBe(true)
    expect(effectsInDownload([], [{ id: 'r', kind: 'rect', fill: { type: 'shader', a: '#000', density: 1 } }], '#fff')).toBe(false)
  })
})

describe('useLayoutSet — download', () => {
  function openedSet(entries: SetEntry[] = SET) {
    const set = useLayoutSet({ formats: () => entries.map(e => e.formatId), plan: () => entries })
    set.openSet()
    return set
  }

  it('renders, zips the formats that fit and saves <name>_set_<timestamp>.zip, showing progress meanwhile', async () => {
    const set = openedSet()
    const seen: (string | null)[] = []
    const zip = vi.fn(async (files: { path: string; blob: Blob }[]) => png(files.map(f => f.path).join(',')))
    const save = vi.fn()
    await set.download({
      name: 'Summer sale', now: () => 7, zip, save,
      render: async (e) => { seen.push(set.progress.value); return png(e.formatId) },
    })
    expect(seen).toEqual(['Rendering 1 of 3…', 'Rendering 2 of 3…', 'Rendering 3 of 3…'])
    expect(zip.mock.calls[0]![0].map(f => f.path)).toEqual(['meta-feed-1x1.png', 'meta-story.png', 'ad-300x250.png'])
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0]![1]).toBe('Summer sale_set_7.zip')
    expect(set.progress.value).toBeNull()
  })

  it('Cancel stops before the next format and saves nothing', async () => {
    const set = openedSet()
    const save = vi.fn()
    const render = vi.fn(async (e: SetEntry) => { set.cancelDownload(); return png(e.formatId) })
    await set.download({ name: '', render, save, zip: async () => png('z') })
    expect(render).toHaveBeenCalledTimes(1)
    expect(save).not.toHaveBeenCalled()
    expect(set.notice.value).toBe('Download cancelled.')
    expect(set.progress.value).toBeNull()
  })

  it('a failing format is named; the zip holds the others', async () => {
    const set = openedSet()
    const zip = vi.fn(async () => png('z'))
    const save = vi.fn()
    await set.download({
      name: null, now: () => 1, zip, save,
      render: async (e) => { if (e.formatId === 'meta-story') throw new Error('boom'); return png(e.formatId) },
    })
    expect(set.failures.value.map(f => f.label)).toEqual(['Meta story / reel · 9:16'])
    expect((zip.mock.calls[0] as unknown as [{ path: string }[]])[0].map(f => f.path)).toEqual(['meta-feed-1x1.png', 'ad-300x250.png'])
    expect(save.mock.calls[0]![1]).toBe('frame_set_1.zip')
  })
})

describe('LayoutSetSheet — while downloading', () => {
  const base = { entries: SET, layoutName: 'Run-off' }
  const stubs = { LayoutTile: true }

  it('shows the progress line and a Cancel in place of the download button; Cancel emits cancel', async () => {
    const wrap = mount(LayoutSetSheet, { props: { ...base, progress: 'Rendering 2 of 3…' }, global: { stubs } })
    expect(wrap.get('[data-testid="layout-set-progress"]').text()).toBe('Rendering 2 of 3…')
    expect(wrap.find('[data-testid="layout-set-download"]').exists()).toBe(false)
    await wrap.get('[data-testid="layout-set-cancel"]').trigger('click')
    expect(wrap.emitted('cancel')).toHaveLength(1)
  })

  it('names each format that failed, and offers the download again', async () => {
    const wrap = mount(LayoutSetSheet, {
      props: { ...base, progress: null, failures: [{ formatId: 'meta-story', label: 'Meta story / reel · 9:16', message: 'boom' }] },
      global: { stubs },
    })
    await nextTick()
    expect(wrap.findAll('[data-testid="layout-set-failure"]').map(w => w.text())).toEqual(["Couldn't render Meta story / reel · 9:16."])
    expect(wrap.find('[data-testid="layout-set-cancel"]').exists()).toBe(false)
    expect(wrap.get('[data-testid="layout-set-download"]').text()).toBe('Download 3 images')
  })
})
