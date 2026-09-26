import sharp from 'sharp'
import { LAYOUT_TREATMENT_FAILED } from '#shared/template-grid/limits'
import { describe, expect, it } from 'vitest'
import {
  editorImgFilter, hasTreatment, needsServerBake, treatmentCssFilter,
  treatmentIntensity, treatmentOverlay,
} from '~~/shared/template-grid/treatment'
import type { PhotoTreatment } from '~~/shared/template-grid/treatment'
import { generate, shuffle, surprise } from '~~/shared/template-grid/generate/generate'
import { templateToSatori } from '~~/server/templates/translate'
import { bakeTreatment, inlineTreeImages } from '~~/server/templates/inlineImages'
import { useGridEditor } from '~/composables/useGridEditor'
import type { ElementV2, ImageElementV2, TemplateV2, TemplateV3 } from '~~/shared/template-grid/types'

function baseV3(): TemplateV3 {
  return {
    version: 3, id: 't', name: 'T', master: '3x4',
    formats: { '3x4': { w: 1080, h: 1440 } },
    grid: { gutter: 16, margin: 48, baseline: 8, columns: 12, rows: 16 },
    typeScale: { base: 14, ratio: 1.5 },
    background: {},
    elements: [],
    sections: [],
    tiers: {
      hero: { content: 'MAT + FEST' },
      anchor: { content: '15—26 June' },
      support: { content: 'Street food' },
      fineprint: { content: 'Slakthus' },
    },
  }
}

function imageT(): TemplateV2 {
  return {
    version: 2, id: 't', name: 't', master: '1x1',
    formats: { '1x1': { w: 1080, h: 1080 } },
    grid: { gutter: 24, margin: 72, baseline: 12 },
    typeScale: { base: 28, ratio: 1.414 },
    elements: [
      { id: 'hero', type: 'image', content: 'http://x/img.png', priority: 1,
        region: { col: 1, colSpan: 6, row: 1, rowSpan: 6 } },
    ],
  }
}

function flatten(node: any, out: any[] = []): any[] {
  out.push(node)
  const kids = node?.props?.children
  if (Array.isArray(kids)) kids.forEach((k: any) => typeof k === 'object' && flatten(k, out))
  else if (kids && typeof kids === 'object') flatten(kids, out)
  return out
}

describe('treatment: default + pure mapping', () => {
  it('absent treatment maps to no filter, no overlay, no server bake', () => {
    expect(hasTreatment(undefined)).toBe(false)
    expect(treatmentCssFilter(undefined)).toBeUndefined()
    expect(editorImgFilter(undefined)).toBeUndefined()
    expect(needsServerBake(undefined)).toBe(false)
    expect(treatmentOverlay(undefined, '#111111')).toBeNull()
  })

  it("kind 'none' behaves identically to absent", () => {
    const t: PhotoTreatment = { kind: 'none' }
    expect(hasTreatment(t)).toBe(false)
    expect(treatmentCssFilter(t)).toBeUndefined()
    expect(needsServerBake(t)).toBe(false)
  })

  it('grayscale maps to a CSS filter string at the given intensity, no server bake', () => {
    expect(treatmentCssFilter({ kind: 'grayscale', intensity: 1 })).toBe('grayscale(1)')
    expect(treatmentCssFilter({ kind: 'grayscale', intensity: 0.4 })).toBe('grayscale(0.4)')
    expect(needsServerBake({ kind: 'grayscale' })).toBe(false)
    expect(editorImgFilter({ kind: 'grayscale', intensity: 0.4 })).toBe('grayscale(0.4)')
  })

  it('grayscale defaults intensity to 1 when omitted', () => {
    expect(treatmentIntensity({ kind: 'grayscale' })).toBe(1)
    expect(treatmentCssFilter({ kind: 'grayscale' })).toBe('grayscale(1)')
  })

  it('intensity is clamped to [0, 1]', () => {
    expect(treatmentIntensity({ kind: 'grayscale', intensity: 5 })).toBe(1)
    expect(treatmentIntensity({ kind: 'grayscale', intensity: -2 })).toBe(0)
  })

  it('duotone/grain never produce a CSS filter — they need the server bake', () => {
    expect(treatmentCssFilter({ kind: 'duotone' })).toBeUndefined()
    expect(treatmentCssFilter({ kind: 'grain' })).toBeUndefined()
    expect(needsServerBake({ kind: 'duotone' })).toBe(true)
    expect(needsServerBake({ kind: 'grain' })).toBe(true)
  })

  it('duotone editor preview: grayscale filter + an ink-tint overlay blend', () => {
    expect(editorImgFilter({ kind: 'duotone' })).toBe('grayscale(1)')
    const overlay = treatmentOverlay({ kind: 'duotone', intensity: 0.6 }, '#ff0000')
    expect(overlay?.kind).toBe('duotone')
    expect(overlay?.style.background).toBe('#ff0000')
    expect(overlay?.style.opacity).toBe(0.6)
  })

  it('duotone editor grayscale filter scales with intensity — matches the bake direction', () => {
    // Server bake at intensity 0 blends the tint over the ORIGINAL (near-colour)
    // image; the editor preview must trend the same way, not hardcode full gray.
    expect(editorImgFilter({ kind: 'duotone', intensity: 0 })).toBe('grayscale(0)')
    expect(editorImgFilter({ kind: 'duotone', intensity: 0.5 })).toBe('grayscale(0.5)')
    expect(editorImgFilter({ kind: 'duotone', intensity: 1 })).toBe('grayscale(1)')
  })

  it('grain editor preview: no filter, a noise-texture overlay instead', () => {
    expect(editorImgFilter({ kind: 'grain' })).toBeUndefined()
    const overlay = treatmentOverlay({ kind: 'grain', intensity: 0.8 }, '#111111')
    expect(overlay?.kind).toBe('grain')
    expect(String(overlay?.style.backgroundImage)).toContain('feTurbulence')
  })
})

describe('treatment: schema round-trip', () => {
  it('ImageElementV2.style.treatment survives a JSON round-trip untouched', () => {
    const el: ImageElementV2 = {
      id: 'hero', type: 'image', content: 'http://x/img.png', priority: 1,
      region: { col: 1, colSpan: 6, row: 1, rowSpan: 6 },
      style: { treatment: { kind: 'duotone', intensity: 0.75 } },
    }
    const round = JSON.parse(JSON.stringify(el)) as ImageElementV2
    expect(round.style?.treatment).toEqual({ kind: 'duotone', intensity: 0.75 })
  })

  it('an image element with no style.treatment key resolves as no-treatment (default absent)', () => {
    const el: ImageElementV2 = {
      id: 'hero', type: 'image', content: 'http://x/img.png', priority: 1,
      region: { col: 1, colSpan: 6, row: 1, rowSpan: 6 },
    }
    expect(hasTreatment(el.style?.treatment)).toBe(false)
  })
})

describe('treatment: shuffle/surprise immunity', () => {
  it('a freeform image element with treatment set survives shuffle byte-identical', () => {
    const t0 = generate(baseV3(), { staging: 'tower', theme: 'paper', seed: 1 })
    const photo: ElementV2 = {
      id: 'photo', type: 'image', content: 'http://x/photo.png', priority: 9,
      region: { col: 1, colSpan: 4, row: 12, rowSpan: 3 }, origin: 'freeform',
      style: { fit: 'cover', treatment: { kind: 'grain', intensity: 0.3 } },
    }
    const withPhoto: TemplateV3 = { ...t0, elements: [...t0.elements, photo] }
    const before = JSON.stringify(withPhoto.elements.find(e => e.id === 'photo'))

    const rolled = shuffle(withPhoto)
    const after = JSON.stringify(rolled.elements.find(e => e.id === 'photo'))
    expect(after).toBe(before)
    expect((rolled.elements.find(e => e.id === 'photo') as ImageElementV2).style?.treatment)
      .toEqual({ kind: 'grain', intensity: 0.3 })
  })

  it('surprise (both axes) leaves the same freeform photo + treatment untouched', () => {
    const t0 = generate(baseV3(), { staging: 'tower', theme: 'paper', seed: 1 })
    const photo: ElementV2 = {
      id: 'photo', type: 'image', content: 'http://x/photo.png', priority: 9,
      region: { col: 1, colSpan: 4, row: 12, rowSpan: 3 }, origin: 'freeform',
      style: { treatment: { kind: 'duotone', intensity: 1 } },
    }
    const withPhoto: TemplateV3 = { ...t0, elements: [...t0.elements, photo] }
    const before = JSON.stringify(withPhoto.elements.find(e => e.id === 'photo'))
    const rolled = surprise(withPhoto)
    const after = JSON.stringify(rolled.elements.find(e => e.id === 'photo'))
    expect(after).toBe(before)
  })

  it('never stamped by generate itself — a fresh generate never sets treatment on any element', () => {
    const t = generate(baseV3(), { staging: 'tower', theme: 'blue', seed: 3 })
    for (const e of t.elements) {
      if (e.type === 'image') expect((e as ImageElementV2).style?.treatment).toBeUndefined()
    }
  })
})

describe('treatment: property-panel round-trip (useGridEditor.patchStyle)', () => {
  it('patchStyle writes and reads back a treatment on the selected image element', () => {
    const ctx = useGridEditor(imageT())
    ctx.patchStyle('hero', { treatment: { kind: 'grayscale', intensity: 0.5 } })
    const el = ctx.elById('hero') as ImageElementV2
    expect(el.style?.treatment).toEqual({ kind: 'grayscale', intensity: 0.5 })
  })

  it('switching kind to none clears the treatment (undefined, not stale kind)', () => {
    const ctx = useGridEditor(imageT())
    ctx.patchStyle('hero', { treatment: { kind: 'duotone', intensity: 1 } })
    ctx.patchStyle('hero', { treatment: undefined })
    const el = ctx.elById('hero') as ImageElementV2
    expect(hasTreatment(el.style?.treatment)).toBe(false)
  })
})

describe('treatment: server-side branch per GATE verdict (templateToSatori)', () => {
  it("grayscale rides the satori <img> style.filter — the CSS branch", () => {
    const t = imageT()
    ;(t.elements[0] as ImageElementV2).style = { treatment: { kind: 'grayscale', intensity: 0.6 } }
    const { tree } = templateToSatori(t as any, '1x1', {})
    const img = flatten(tree).find(n => n?.type === 'img' && n.props.src === 'http://x/img.png')
    expect(img.props.style.filter).toBe('grayscale(0.6)')
    expect(img.props.__treatment).toBeUndefined()
  })

  it('duotone carries NO CSS filter — it is tagged for the server-side sharp bake instead', () => {
    const t = imageT()
    ;(t.elements[0] as ImageElementV2).style = { treatment: { kind: 'duotone', intensity: 0.8 } }
    const { tree } = templateToSatori(t as any, '1x1', {}, { foreground: '#ff0000' })
    const img = flatten(tree).find(n => n?.type === 'img' && n.props.src === 'http://x/img.png')
    expect(img.props.style.filter).toBeUndefined()
    expect(img.props.__treatment).toEqual({ kind: 'duotone', intensity: 0.8, ink: '#ff0000' })
  })

  it('grain is also tagged for the server bake, defaulting ink from brand.foreground', () => {
    const t = imageT()
    ;(t.elements[0] as ImageElementV2).style = { treatment: { kind: 'grain' } }
    const { tree } = templateToSatori(t as any, '1x1', {})
    const img = flatten(tree).find(n => n?.type === 'img' && n.props.src === 'http://x/img.png')
    expect(img.props.__treatment.kind).toBe('grain')
    expect(img.props.__treatment.intensity).toBe(1)
  })

  it('no treatment set (default) — no filter, no bake tag, unchanged from before this feature', () => {
    const t = imageT()
    const { tree } = templateToSatori(t as any, '1x1', {})
    const img = flatten(tree).find(n => n?.type === 'img' && n.props.src === 'http://x/img.png')
    expect(img.props.style.filter).toBeUndefined()
    expect(img.props.__treatment).toBeUndefined()
  })
})

describe('treatment: fallback branch — sharp bake (duotone/grain)', () => {
  // A flat mid-gray swatch with distinct RGB so a duotone tint is unmistakable.
  async function graySwatch(): Promise<ArrayBuffer> {
    const buf = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 140, g: 140, b: 140 } } })
      .png().toBuffer()
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  }

  it('duotone at full intensity tints toward the ink colour (channel dominance flips)', async () => {
    const src = await graySwatch()
    const out = await bakeTreatment(src, { kind: 'duotone', intensity: 1, ink: '#ff0000' })
    const { data, info } = await sharp(Buffer.from(out)).raw().toBuffer({ resolveWithObject: true })
    expect(info.channels).toBeGreaterThanOrEqual(3)
    // Sample the center pixel: red-tinted duotone must dominate R over G/B.
    const idx = (4 * info.width + 4) * info.channels
    const [r, g, b] = [data[idx], data[idx + 1], data[idx + 2]]
    expect(r).toBeGreaterThan(g)
    expect(r).toBeGreaterThan(b)
  })

  it('duotone at intensity 0 stays close to the untinted source (blend, not replace)', async () => {
    const src = await graySwatch()
    const out = await bakeTreatment(src, { kind: 'duotone', intensity: 0, ink: '#ff0000' })
    const { data, info } = await sharp(Buffer.from(out)).raw().toBuffer({ resolveWithObject: true })
    const idx = (4 * info.width + 4) * info.channels
    // Neutral gray survives — R/G/B stay close to each other, no red dominance.
    expect(Math.abs(data[idx] - data[idx + 1])).toBeLessThan(15)
  })

  it('grain visibly perturbs pixels and is deterministic for the same source size', async () => {
    const src = await graySwatch()
    const out1 = await bakeTreatment(src, { kind: 'grain', intensity: 1, ink: '#000000' })
    const out2 = await bakeTreatment(src, { kind: 'grain', intensity: 1, ink: '#000000' })
    expect(Buffer.compare(Buffer.from(out1), Buffer.from(out2))).toBe(0)   // seeded, not Math.random

    const srcRaw = await sharp(Buffer.from(src)).raw().toBuffer({ resolveWithObject: true })
    const outRaw = await sharp(Buffer.from(out1)).raw().toBuffer({ resolveWithObject: true })
    let changed = 0
    for (let i = 0; i < srcRaw.data.length; i++) if (srcRaw.data[i] !== outRaw.data[i % outRaw.data.length]) changed++
    expect(changed).toBeGreaterThan(0)
  })

  it('inlineTreeImages bakes __treatment then strips the tag before satori sees the node', async () => {
    const swatch = await graySwatch()
    const node: any = {
      type: 'img',
      props: { src: 'http://x/swatch.png', __treatment: { kind: 'duotone', intensity: 1, ink: '#00ff00' } },
    }
    await inlineTreeImages({ type: 'div', props: { children: node } },
      async () => ({ data: swatch, contentType: 'image/png' }))
    expect(node.props.__treatment).toBeUndefined()
    expect(node.props.src).toMatch(/^data:image\/png;base64,/)
    const decoded = Buffer.from(node.props.src.split(',')[1], 'base64')
    const { data, info } = await sharp(decoded).raw().toBuffer({ resolveWithObject: true })
    const idx = (4 * info.width + 4) * info.channels
    expect(data[idx + 1]).toBeGreaterThan(data[idx])   // green-tinted
  })

  it('a bake failure (corrupt/unsupported image) fails the render plainly: never the untreated picture in its place (R1.6 fix round 3)', async () => {
    const garbage = new TextEncoder().encode('not-a-real-image-these-are-garbage-bytes').buffer as ArrayBuffer
    const node: any = {
      type: 'img',
      props: { src: 'http://x/corrupt.jpg', __treatment: { kind: 'duotone', intensity: 1, ink: '#00ff00' } },
    }
    await expect(inlineTreeImages({ type: 'div', props: { children: node } },
      async () => ({ data: garbage, contentType: 'image/jpeg' }))).rejects.toThrow(LAYOUT_TREATMENT_FAILED)
    expect(node.props.__treatment).toBeUndefined()
    // Not inlined untreated.
    expect(node.props.src).toBe('http://x/corrupt.jpg')
  })
})
