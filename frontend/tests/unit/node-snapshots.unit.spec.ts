// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { nodeSnapshotRefs, nodeSnapshotRef, isBlankPixels, NODE_SNAPSHOT_SUBFOLDER, pickPreviewElement } from '~/lib/nodeSnapshots'
import { extractCoverImages } from '~/lib/projectCover'

const view = (filename: string) => `/view?${new URLSearchParams({ filename, type: 'input' })}`
const doc = (nodes: any[]) => ({ canvases: [{ id: 'c1', name: 'Canvas', workflow: { nodes } }], activeCanvasId: 'c1' })

describe('nodeSnapshotRefs', () => {
  it('names one snapshot per node without a persisted preview', () => {
    const d = doc([
      { id: 1, type: 'ShaderStudio' },
      { id: 2, type: 'Image', properties: { sailor_preview: { images: [view('a.png')] } } },
      { id: 3, type: 'GradientStudio' },
    ])
    expect(nodeSnapshotRefs(d, 'proj-1').map(r => r.filename)).toEqual([
      'node_proj-1_c1_1.webp', 'node_proj-1_c1_3.webp',
    ])
    expect(nodeSnapshotRef('p', 'c', 9)).toEqual({ kind: 'image', filename: 'node_p_c_9.webp', subfolder: NODE_SNAPSHOT_SUBFOLDER, type: 'input' })
  })
  it('needs a uuid and a ProjectDoc', () => {
    expect(nodeSnapshotRefs(doc([{ id: 1 }]), undefined)).toEqual([])
    expect(nodeSnapshotRefs({ nodes: [{ id: 1 }] }, 'p')).toEqual([])
  })
})

describe('extractCoverImages with snapshots', () => {
  it('lists persisted previews first, then node snapshots, up to the cap', () => {
    const d = doc([
      { id: 1, type: 'ShaderStudio' },
      { id: 2, type: 'Image', properties: { sailor_preview: { images: [view('a.png')] } } },
    ])
    expect(extractCoverImages(d, { uuid: 'p', cap: 12 }).map(r => r.filename)).toEqual(['a.png', 'node_p_c1_1.webp'])
    expect(extractCoverImages(d).map(r => r.filename)).toEqual(['a.png'])
  })
})

describe('isBlankPixels', () => {
  const px = (rgba: number[][]) => {
    const out: number[] = []
    for (let i = 0; i < 200; i++) out.push(...rgba[i % rgba.length]!)
    return new Uint8ClampedArray(out)
  }
  it('treats transparent and black frames as blank', () => {
    expect(isBlankPixels(px([[0, 0, 0, 0]]))).toBe(true)
    expect(isBlankPixels(px([[0, 0, 0, 255], [200, 10, 10, 0]]))).toBe(true)
  })
  it('keeps a flat colour — a solid fill is real content', () => {
    expect(isBlankPixels(px([[20, 120, 220, 255]]))).toBe(false)
  })
  it('keeps frames with real variation', () => {
    expect(isBlankPixels(px([[255, 0, 200, 255], [250, 250, 120, 255], [10, 10, 10, 255]]))).toBe(false)
  })
})

describe('pickPreviewElement', () => {
  it('ignores a print surface tint, however large it is', () => {
    const node = document.createElement('div')
    node.innerHTML = '<div class="print-surface__glow"><canvas class="tint"></canvas></div><canvas class="art"></canvas>'
    const size = (el: Element, s: number) => { (el as any).getBoundingClientRect = () => ({ width: s, height: s }) }
    size(node.querySelector('.tint')!, 500)
    size(node.querySelector('.art')!, 300)
    expect(pickPreviewElement(node)).toBe(node.querySelector('.art'))
  })
})
