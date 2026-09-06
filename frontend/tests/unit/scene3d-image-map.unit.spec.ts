import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { imageTilingXY, imageFitTransform, applyImageTransform, seamlessWidth, seamlessCanvas, seamlessStrips } from '~/lib/scene3d/imageMap'
import type { SceneMaterial } from '~/lib/scene3d/config'

const img = (patch: Partial<SceneMaterial> = {}): SceneMaterial =>
  ({ type: 'image', color: '#ffffff', roughness: 0.6, metalness: 0, image: 'a.png', ...patch })

describe('imageTilingXY', () => {
  it('drives both axes from one number while linked', () => {
    expect(imageTilingXY(img({ imageTiling: 3 }))).toEqual([3, 3])
    expect(imageTilingXY(img({ imageTiling: 3, imageTilingY: 9 }))).toEqual([3, 3])
  })

  it('reads the second number only once the link is off', () => {
    expect(imageTilingXY(img({ imageTiling: 3, imageTilingY: 9, imageTilingLinked: false }))).toEqual([3, 9])
  })

  it('falls back to one repeat with nothing set', () => {
    expect(imageTilingXY(img())).toEqual([1, 1])
  })
})

describe('imageFitTransform', () => {
  it('stretches by default — an identity transform', () => {
    expect(imageFitTransform(img(), { w: 1600, h: 900 })).toEqual({ rx: 1, ry: 1, ox: 0, oy: 0 })
  })

  it('is an identity transform until the natural size is known', () => {
    expect(imageFitTransform(img({ imageFit: 'cover' }), null)).toEqual({ rx: 1, ry: 1, ox: 0, oy: 0 })
  })

  it('covers a wide picture by cropping its sides', () => {
    // 2:1 picture: show the full height, and a centred half of the width.
    const t = imageFitTransform(img({ imageFit: 'cover' }), { w: 200, h: 100 })
    expect(t.rx).toBeCloseTo(0.5)
    expect(t.ry).toBeCloseTo(1)
    expect(t.ox).toBeCloseTo(0.25)
    expect(t.oy).toBeCloseTo(0)
  })

  it('contains a wide picture by letterboxing it', () => {
    // 2:1 picture: full width, occupying the middle half of the height.
    const t = imageFitTransform(img({ imageFit: 'contain' }), { w: 200, h: 100 })
    expect(t.rx).toBeCloseTo(1)
    expect(t.ry).toBeCloseTo(2)
    expect(t.ox).toBeCloseTo(0)
    expect(t.oy).toBeCloseTo(-0.5)
  })

  it('mirrors the maths for a tall picture', () => {
    const cover = imageFitTransform(img({ imageFit: 'cover' }), { w: 100, h: 200 })
    expect(cover.rx).toBeCloseTo(1)
    expect(cover.ry).toBeCloseTo(0.5)
    expect(cover.oy).toBeCloseTo(0.25)
    const contain = imageFitTransform(img({ imageFit: 'contain' }), { w: 100, h: 200 })
    expect(contain.rx).toBeCloseTo(2)
    expect(contain.ox).toBeCloseTo(-0.5)
  })
})

describe('applyImageTransform', () => {
  it('clamps by default and never re-uploads the pixels', () => {
    const tex = new THREE.Texture()
    const before = tex.version
    applyImageTransform(tex, img())
    expect(tex.wrapS).toBe(THREE.ClampToEdgeWrapping)
    expect(tex.wrapT).toBe(THREE.ClampToEdgeWrapping)
    expect(tex.repeat.x).toBe(1)
    expect(tex.offset.x).toBe(0)
    // First application stamps the wrap mode, which is a sampler parameter — one bump.
    expect(tex.version).toBe(before + 1)
    // Re-applying the SAME wrap must not bump it again: needsUpdate re-uploads the image.
    const after = tex.version
    applyImageTransform(tex, img({ imageTiling: 4 }))
    expect(tex.repeat.x).toBe(4)
    expect(tex.version).toBe(after)
  })

  it('maps each wrap mode onto its three constant', () => {
    const tex = new THREE.Texture()
    applyImageTransform(tex, img({ imageWrap: 'tile' }))
    expect(tex.wrapS).toBe(THREE.RepeatWrapping)
    applyImageTransform(tex, img({ imageWrap: 'mirror' }))
    expect(tex.wrapS).toBe(THREE.MirroredRepeatWrapping)
  })

  it('composes fit, tiling and offset', () => {
    const tex = new THREE.Texture()
    applyImageTransform(
      tex,
      img({ imageFit: 'cover', imageTiling: 2, imageOffsetX: 0.1 }),
      { w: 200, h: 100 },
    )
    expect(tex.repeat.x).toBeCloseTo(1)   // fit 0.5 * tiling 2
    expect(tex.repeat.y).toBeCloseTo(2)   // fit 1   * tiling 2
    expect(tex.offset.x).toBeCloseTo(0.35) // fit 0.25 + user 0.1
  })

  it('flips by walking the same band backwards', () => {
    const tex = new THREE.Texture()
    applyImageTransform(tex, img({ imageTiling: 2, imageOffsetX: 0.1, imageFlipX: true }))
    expect(tex.repeat.x).toBeCloseTo(-2)
    expect(tex.offset.x).toBeCloseTo(2.1)
  })

  it('rotates about the middle of the picture', () => {
    const tex = new THREE.Texture()
    applyImageTransform(tex, img({ imageRotation: 90 }))
    expect(tex.rotation).toBeCloseTo(Math.PI / 2)
    expect(tex.center.x).toBe(0.5)
    expect(tex.center.y).toBe(0.5)
  })
})

describe('seamless pre-pass', () => {
  it('is off by default and off at zero', () => {
    expect(seamlessWidth(img())).toBe(0)
    expect(seamlessWidth(img({ imageSeamless: 0 }))).toBe(0)
  })

  it('clamps the blend to less than half the picture, where it would overlap itself', () => {
    expect(seamlessWidth(img({ imageSeamless: 0.2 }))).toBeCloseTo(0.2)
    expect(seamlessWidth(img({ imageSeamless: 5 }))).toBeCloseTo(0.45)
    expect(seamlessWidth(img({ imageSeamless: -1 }))).toBe(0)
  })

  it('declines to build a canvas with no DOM rather than throwing', () => {
    expect(seamlessCanvas(null as never, 64, 64, 0.2)).toBeNull()
  })
})

describe('seamlessStrips (geometry)', () => {
  // This is the assertion that would have caught the shipped defect: the old
  // `seamlessCanvas` positioned each band a full width/height away from the canvas
  // (`band(-w, 0, …)` / `band(w, 0, …)` / etc.), which has ZERO overlap with `[0, w)` —
  // shifting a rectangle by exactly its own size moves it entirely off-canvas. Every
  // strip this function returns must actually land on the canvas.
  it('guards against the shipped no-op: every destination rectangle overlaps the canvas', () => {
    for (const [w, h, width] of [[64, 64, 0.1], [64, 64, 0.25], [64, 64, 0.45], [200, 100, 0.2]] as const) {
      const strips = seamlessStrips(w, h, width)
      expect(strips.length).toBeGreaterThan(0)
      for (const s of strips) {
        expect(s.dx).toBeLessThan(w)
        expect(s.dx + s.sw).toBeGreaterThan(0)
        expect(s.dy).toBeLessThan(h)
        expect(s.dy + s.sh).toBeGreaterThan(0)
      }
    }
  })

  // Reproduce the OLD geometry directly and confirm the overlap guard rejects it — proof
  // this assertion actually discriminates the broken algorithm from the fixed one.
  it('the overlap guard fails against the old (broken) band geometry', () => {
    const w = 64, h = 64
    const oldBands = [
      { dx: -w, dy: 0, sw: w, sh: h },
      { dx: w, dy: 0, sw: w, sh: h },
      { dx: 0, dy: -h, sw: w, sh: h },
      { dx: 0, dy: h, sw: w, sh: h },
    ]
    for (const b of oldBands) {
      const overlapsX = b.dx < w && b.dx + b.sw > 0
      const overlapsY = b.dy < h && b.dy + b.sh > 0
      expect(overlapsX && overlapsY).toBe(false)
    }
  })

  it('clamps strip width to at least 1px and never beyond the dial share of the dimension', () => {
    expect(seamlessStrips(10, 10, 0.01).every(s => s.sw >= 1 && s.sh >= 1)).toBe(true)
    const strips = seamlessStrips(200, 100, 0.2)
    // Horizontal strips: 200 * 0.2 = 40 exactly.
    expect(strips.filter(s => s.mirror === 'x').every(s => s.sw === 40)).toBe(true)
    // Vertical strips: 100 * 0.2 = 20 exactly.
    expect(strips.filter(s => s.mirror === 'y').every(s => s.sh === 20)).toBe(true)
  })

  it('reads the horizontal strips from the opposite edge', () => {
    const w = 200, h = 100
    const strips = seamlessStrips(w, h, 0.2)
    const bx = 40
    const leftBorder = strips.find(s => s.mirror === 'x' && s.dx === 0)!
    expect(leftBorder.sx).toBe(w - bx) // reads the RIGHT edge for the LEFT border
    const rightBorder = strips.find(s => s.mirror === 'x' && s.dx === w - bx)!
    expect(rightBorder.sx).toBe(0) // reads the LEFT edge for the RIGHT border
  })

  it('yields no strips for a zero or negative dial', () => {
    expect(seamlessStrips(64, 64, 0)).toEqual([])
    expect(seamlessStrips(64, 64, -1)).toEqual([])
  })
})
