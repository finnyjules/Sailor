import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cardBox, cardScale, cardViewOf, cardViewStale, cardViewToStore } from '~/lib/frame/responsive/cardView'

/** Today's fixed-Frame box: the long side is the display edge, the short one follows the aspect. */
function fixedBox(design: { w: number; h: number }, E: number) {
  const a = design.w / design.h
  return a >= 1 ? { w: E, h: Math.round(E / a) } : { w: Math.round(E * a), h: E }
}

describe('cardScale', () => {
  it('maps the design long side onto the display edge', () => {
    expect(cardScale({ w: 1080, h: 1350 }, 308)).toBeCloseTo(308 / 1350, 10)
    expect(cardScale({ w: 1920, h: 1080 }, 400)).toBeCloseTo(400 / 1920, 10)
  })
  it('never divides by zero', () => {
    expect(Number.isFinite(cardScale({ w: 0, h: 0 }, 308))).toBe(true)
  })
})

describe('cardBox', () => {
  it('at the design size is exactly the fixed box', () => {
    const designs = [
      { w: 1080, h: 1350 }, { w: 1920, h: 1080 }, { w: 1000, h: 1000 }, { w: 1200, h: 628 },
      { w: 628, h: 1200 }, { w: 1080, h: 1920 }, { w: 300, h: 250 }, { w: 728, h: 90 }, { w: 160, h: 600 },
    ]
    for (const d of designs) for (const E of [180, 308, 311, 517, 999, 1600]) {
      expect(cardBox(d, { ...d }, E), `${d.w}x${d.h} @ ${E}`).toEqual(fixedBox(d, E))
    }
  })
  it('doubling the view width doubles the box width and keeps the height', () => {
    const d = { w: 1000, h: 1000 }
    const a = cardBox(d, { w: 1000, h: 1000 }, 300)
    const b = cardBox(d, { w: 2000, h: 1000 }, 300)
    expect(b.w).toBe(a.w * 2)
    expect(b.h).toBe(a.h)
  })
  it('grows each side independently at a constant scale', () => {
    const d = { w: 1080, h: 1350 }
    const k = cardScale(d, 308)
    expect(cardBox(d, { w: 1440, h: 900 }, 308)).toEqual({ w: Math.round(1440 * k), h: Math.round(900 * k) })
  })
})

describe('cardViewOf', () => {
  const design = { w: 1000, h: 800 }
  it('is the design size when nothing is stored', () => {
    expect(cardViewOf(undefined, design)).toEqual(design)
    expect(cardViewOf({}, design)).toEqual(design)
    expect(cardViewOf({ cardView: { w: 'x', h: 3 } }, design)).toEqual(design)
  })
  it('reads the stored view', () => {
    expect(cardViewOf({ cardView: { w: 1440, h: 900 } }, design)).toEqual({ w: 1440, h: 900 })
  })
  it('honours the viewing-size clamp (0.25x to 5x the design)', () => {
    expect(cardViewOf({ cardView: { w: 10, h: 99999 } }, design)).toEqual({ w: 250, h: 4000 })
  })
})

describe('cardViewToStore', () => {
  const design = { w: 1000, h: 800 }
  it('stores nothing at the design size (the card drops its cardView)', () => {
    expect(cardViewToStore({ w: 1000, h: 800 }, design)).toBeNull()
    expect(cardViewToStore({ w: 1000.4, h: 799.6 }, design)).toBeNull()
  })
  it('stores the viewing size, rounded, off the design size', () => {
    expect(cardViewToStore({ w: 1440, h: 900 }, design)).toEqual({ w: 1440, h: 900 })
    expect(cardViewToStore({ w: 1440.6, h: 900.2 }, design)).toEqual({ w: 1441, h: 900 })
  })
  it('returns a fresh object (never the view passed in)', () => {
    const v = { w: 1440, h: 900 }
    expect(cardViewToStore(v, design)).not.toBe(v)
  })
  it('round-trips through cardViewOf', () => {
    const v = { w: 1440, h: 900 }
    expect(cardViewOf({ cardView: cardViewToStore(v, design) }, design)).toEqual(v)
    expect(cardViewOf({ cardView: cardViewToStore(design, design) ?? undefined }, design)).toEqual(design)
  })
})

describe('cardViewStale', () => {
  const base = { w: 1080, h: 1080, responsive: true }
  it('is stale when the design size or Responsive changes', () => {
    expect(cardViewStale(base, { ...base, w: 1920 })).toBe(true)
    expect(cardViewStale(base, { ...base, h: 1920 })).toBe(true)
    expect(cardViewStale(base, { ...base, responsive: false })).toBe(true)
    expect(cardViewStale({ ...base, responsive: false }, base)).toBe(true)
  })
  it('is not stale when nothing changed', () => {
    expect(cardViewStale(base, { ...base })).toBe(false)
  })
  it('ignores a Frame that had no size yet (the widgets arriving is not a change)', () => {
    expect(cardViewStale({ w: 0, h: 0, responsive: true }, base)).toBe(false)
  })
})

/** Source guard: the card paints the RESOLVED layers (viewing size) in both the live preview and
 *  the export, the way the Frame editor's paintItems()/paintLayers() do. */
describe('ArtifactFrameNode paints the resolved layout', () => {
  const src = readFileSync(resolve(__dirname, '../../app/components/vue-canvas/ArtifactFrameNode.vue'), 'utf8')
  function fnBody(name: string): string {
    const start = src.indexOf(`function ${name}(`)
    expect(start, `${name} not found`).toBeGreaterThan(-1)
    const open = src.indexOf('{', src.indexOf(')', start))
    let depth = 0
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i)
    }
    throw new Error(`unbalanced body for ${name}`)
  }
  function paintArgs(code: string): string[] {
    const at = code.indexOf('paintLayerStack(')
    expect(at, 'paintLayerStack( not found').toBeGreaterThan(-1)
    const args: string[] = []
    let depth = 0, cur = ''
    for (let i = at + 'paintLayerStack'.length; i < code.length; i++) {
      const c = code[i]!
      if ('([{'.includes(c)) { if (depth++ === 0) continue }
      else if (')]}'.includes(c)) { if (--depth === 0) { args.push(cur.trim()); return args } }
      else if (c === ',' && depth === 1) { args.push(cur.trim()); cur = ''; continue }
      cur += c
    }
    throw new Error('unbalanced paintLayerStack call')
  }
  it('paintCardItems/paintCardLayers swap in the resolved layers they are given', () => {
    expect(fnBody('paintCardLayers')).toContain('r?.layers')
    expect(fnBody('paintCardItems')).toContain('r.layers')
  })
  it('renderStack paints what the card displays (resolvedCard)', () => {
    const args = paintArgs(fnBody('renderStack'))
    expect(args[3]).toBe('paintCardItems(resolvedCard.value)')
    expect(args[4]).toBe('paintCardLayers(resolvedCard.value)')
  })
  // S1: the export's shape must not depend on edit mode, so it never reads the display state.
  it('exportCompositeCanvas paints the export layout (resolvedExport), not the display one', () => {
    const body = fnBody('exportCompositeCanvas')
    const args = paintArgs(body)
    expect(args[3]).toBe('paintCardItems(resolvedExport.value)')
    expect(args[4]).toBe('paintCardLayers(resolvedExport.value)')
    expect(body).toMatch(/exportView\.value/)
    expect(body).not.toMatch(/cardViewSize|resolvedCard|\bbox\.value/)
  })
  it('the export view ignores edit mode and is frozen during a video export', () => {
    const decl = /const exportView = computed[^\n]*\n([\s\S]*?)\n\}\)/.exec(src)?.[1] ?? ''
    expect(decl).toContain('frozenExportView.value')
    expect(decl).not.toContain('editMode')
  })
  // S3: a saved card shape is dropped when the design size or Responsive changes.
  it('watches the design size and Responsive and drops a stale card view', () => {
    expect(src).toMatch(/watch\(\[frameW, frameH, isResponsive\][\s\S]{0,400}cardViewStale[\s\S]{0,200}setCardView\(null\)/)
  })
})

/** Source guard: the Frame editor's viewing size IS the card's shape — it opens at the stored
 *  cardView, saves its viewing size back, and every output path renders at the output shape
 *  (outputFrame: the viewing size + resolved layout off the design size, else bakeSize()). */
describe('CompositorModal follows the card shape', () => {
  const src = readFileSync(resolve(__dirname, '../../app/components/vue-canvas/CompositorModal.vue'), 'utf8')
  function fnBody(name: string): string {
    const start = src.indexOf(`function ${name}(`)
    expect(start, `${name} not found`).toBeGreaterThan(-1)
    const open = src.indexOf('{', src.indexOf(')', start))
    let depth = 0
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i)
    }
    throw new Error(`unbalanced body for ${name}`)
  }
  it('outputFrame outputs the card\'s SAVED shape with its resolved layout, else bakeSize()', () => {
    const body = fnBody('outputFrame')
    expect(body).toMatch(/cardOutput\.value/)
    expect(body).toMatch(/bakeSize\(\)/)
    expect(body).not.toMatch(/viewSize/)
    const decl = /const cardOutput = computed[\s\S]*?\n\}\)/.exec(src)?.[0] ?? ''
    expect(decl).toMatch(/cardViewOf\(\(compositor\.value\?\.data\?\.properties as any\)\?\.sailor_frame, d\)/)
    expect(decl).toMatch(/isAtDesignSize\(card, d\)\) return null/)
    expect(decl).toMatch(/W: card\.w, H: card\.h, resolved: r/)
    // the live layout is reused only when the view IS the saved shape; else resolved at the card shape
    expect(decl).toMatch(/viewSize\.w === card\.w && viewSize\.h === card\.h\) \? live/)
    expect(decl).toMatch(/resolveLayout\([\s\S]*card\.w, card\.h, \{ measureCtx: measureCtx\(\), withBoxes: true \}\)/)
  })
  it('the four output paths and the render key size from outputFrame, not bakeSize()', () => {
    for (const name of ['generateImage', 'generateVideo', 'bakeMotion', 'downloadFramePng', 'staticSourceKey']) {
      const body = fnBody(name)
      expect(body, name).toMatch(/outputFrame\(\)/)
      expect(body, name).not.toMatch(/bakeSize\(\)/)
    }
  })
  it('each output path paints the resolved layers of its output', () => {
    expect(fnBody('generateImage')).toMatch(/renderStaticComposite\(out\.W, out\.H, undefined, out\.resolved\)/)
    expect(fnBody('downloadFramePng')).toMatch(/renderStaticComposite\(out\.W, out\.H, undefined, out\.resolved\)/)
    const rsc = fnBody('renderStaticComposite')
    expect(rsc).toMatch(/paintItemsFor\(r\)/)
    expect(rsc).toMatch(/paintLayersFor\(r\)/)
    const video = fnBody('generateVideo')
    expect(video).toMatch(/prepareMotionFramePainter\(\(\) => paintItemsFor\(out\.resolved\), paintLayersFor\(out\.resolved\), W, H, outputMotion\(motion, out\.resolved\)/)
    // Browser-only export (R10.4): the server fallback that re-baked through bakeMotion is gone.
    expect(video).not.toMatch(/bakeMotion\(/)
    const bake = fnBody('bakeMotion')
    expect(bake).toMatch(/opts\?\.out \?\? outputFrame\(\)/)
    expect(bake).toMatch(/bakeAndUpload\(\s*\(\) => paintItemsFor\(out\.resolved\), paintLayersFor\(out\.resolved\), W, H, motion/)
    expect(bake).toMatch(/outputMotion\(/)
  })
  it('the viewing-size reset opens at the stored cardView', () => {
    expect(src).toMatch(/!viewOpened && frameIsResponsive\.value\s*\?\s*cardViewOf\(\(compositor\.value\?\.data\?\.properties as any\)\?\.sailor_frame, d\)/)
  })
  it('a viewing-size change is saved as the card shape, only when it differs', () => {
    const body = fnBody('persistCardView')
    expect(body).toMatch(/cardViewToStore\(viewSize, designSize\.value\)/)
    expect(body).toMatch(/cur\?\.w === next\.w && cur\?\.h === next\.h/)
    expect(body).not.toMatch(/recordHistory/)
  })
  // B1: only the explicit viewing-size actions save; a design-only tool's snap never does.
  it('only explicit viewing-size actions save the card shape; no watcher, no guard snap', () => {
    for (const name of ['setViewDim', 'pickViewShape', 'onEdgeUp', 'backToDesignSizeAndSave'])
      expect(fnBody(name), name).toMatch(/persistCardView\(\)/)
    expect(fnBody('backToDesignSize')).not.toMatch(/persistCardView/)
    expect(fnBody('viewOnlyGuard')).not.toMatch(/persistCardView|AndSave/)
    // no watcher persists viewSize
    expect(src).not.toMatch(/watch\([^;]*persistCardView/)
    const calls = src.match(/(?<!function )persistCardView\(\)/g) ?? []
    expect(calls.length).toBe(4)   // setViewDim, pickViewShape, onEdgeUp, backToDesignSizeAndSave
    // the button and the readout's Done save; nothing else in the template calls the saving one
    expect(src).toMatch(/@done="backToDesignSizeAndSave"/)
    expect(src).toMatch(/@click="backToDesignSizeAndSave">Back to design size</)
    expect((src.match(/="backToDesignSizeAndSave"/g) ?? []).length).toBe(2)   // the two bindings
    expect(src).not.toMatch(/[^"]\bbackToDesignSizeAndSave\(\)(?!\s*\{)/)          // never called from script
  })
  it('leaves harmonize on the design size (bakeSize())', () => {
    expect(src).toMatch(/function renderSceneForHarmonize\(\)[^\n]*\{\n\s*const \{ W, H \} = bakeSize\(\)/)
  })
})
