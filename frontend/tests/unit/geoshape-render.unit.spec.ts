import { describe, it, expect } from 'vitest'
import { renderShapes, toSvg, contentBounds, framePad, fitScale, shapePaints } from '~/lib/geoshape/render'
import { DEFAULT_CONFIG } from '~/lib/geoshape/config'
import { paintToVectorPaint } from '~/lib/paint/toVector'
import type { ImageFill } from '~/lib/compositor/paint'
import type { Fill } from '~/lib/spacetype/fillTile'

describe('geoshape render', () => {
  it('produces shapes and an evenodd SVG for the default (geologo) config', async () => {
    const shapes = await renderShapes(DEFAULT_CONFIG)
    expect(shapes.length).toBeGreaterThanOrEqual(1)
    const svg = await toSvg(DEFAULT_CONFIG)
    expect(svg).toContain('<svg')
    expect(svg).toContain('fill-rule="evenodd"')
  })

  it('overlapMode shape yields an extra filled shape vs hole', async () => {
    // DEFAULT_CONFIG's own radius (180) puts adjacent hexagon clones exactly
    // vertex-to-vertex (zero-area contact, no real overlap to speak of), so
    // this pulls the ring in — `radius: 100` — to a config whose clones
    // genuinely overlap, which is what the assertion is actually testing.
    const cfg = { ...DEFAULT_CONFIG, radius: 100 }
    const hole = await renderShapes({ ...cfg, overlapMode: 'hole' })
    const shape = await renderShapes({ ...cfg, overlapMode: 'shape' })
    expect(shape.length).toBeGreaterThan(hole.length)
  })

  it('composite bbox is non-degenerate', async () => {
    const shapes = await renderShapes(DEFAULT_CONFIG)
    let maxAbsX = 0
    let maxAbsY = 0
    for (const s of shapes) {
      for (const c of s.commands) {
        const a = c.args ?? []
        for (let i = 0; i + 1 < a.length; i += 2) {
          maxAbsX = Math.max(maxAbsX, Math.abs(a[i] as number))
          maxAbsY = Math.max(maxAbsY, Math.abs(a[i + 1] as number))
        }
      }
    }
    expect(maxAbsX).toBeGreaterThan(0)
    expect(maxAbsY).toBeGreaterThan(0)
  })

  // The "Padding" control is the canvas-fill lever: the live preview and the
  // PNG bake (drawToCanvas) share `framePad`/`fitScale` with the SVG export
  // (toSvg), so lowering padding grows the mark toward the edges everywhere,
  // and padding 0 fills the frame edge-to-edge on its tight axis. Before this
  // fix drawToCanvas used a fixed 0.9 margin and ignored padding entirely, so
  // no control could make the preview/PNG fill the canvas.
  it('framePad follows the padding control, including negative (overscan)', () => {
    expect(framePad({ padding: 40, strokeWidth: 8 })).toBe(44)
    expect(framePad({ padding: 0, strokeWidth: 0 })).toBe(0)
    // Negative padding passes through (overscan) — the stroke half-width is a
    // rounding term next to it, not a floor at 0 any more.
    expect(framePad({ padding: -100, strokeWidth: 8 })).toBe(-96)
  })

  it('framePad reserves the outline arm\u2019s 1-unit fallback so a 0-width outline is not clipped', () => {
    // `styled` draws an outline/both shape at `strokeWidth || 1`, so a
    // strokeWidth of 0 still puts a 1-unit line on the canvas. Padding by
    // strokeWidth/2 alone would clip half of it at the frame edge.
    expect(framePad({ padding: 10, strokeWidth: 0, paintTarget: 'outline' })).toBe(10.5)
    expect(framePad({ padding: 10, strokeWidth: 0, paintTarget: 'both' })).toBe(10.5)
    // A real stroke width still wins over the fallback, and fill mode is unchanged.
    expect(framePad({ padding: 10, strokeWidth: 8, paintTarget: 'outline' })).toBe(14)
    expect(framePad({ padding: 10, strokeWidth: 0, paintTarget: 'fill' })).toBe(10)
  })

  it('fitScale grows as padding shrinks, and pad 0 fills the tight axis edge-to-edge', () => {
    const b = { w: 400, h: 300 }
    const full = fitScale(b, 1024, 1024, 0)
    const inset = fitScale(b, 1024, 1024, 100)
    // Less padding => larger mark.
    expect(full).toBeGreaterThan(inset)
    // Pad 0 fits the tight (wider) axis exactly to the box: 1024 / 400.
    expect(full).toBeCloseTo(1024 / 400, 6)
    // Fit, never crop at pad 0: the taller axis stays within the box.
    expect(b.h * full).toBeLessThanOrEqual(1024 + 1e-6)
  })

  it('fitScale overscans (crops to fill) on negative padding, then saturates', () => {
    const b = { w: 400, h: 300 }
    const touch = fitScale(b, 1024, 1024, 0)
    const bleed = fitScale(b, 1024, 1024, -80)
    // Negative padding grows the mark past the fit size.
    expect(bleed).toBeGreaterThan(touch)
    // Enough overscan makes BOTH axes exceed the box (true whole-canvas fill):
    // the previously-letterboxed short axis now bleeds off the edges.
    expect(b.h * bleed).toBeGreaterThan(1024)
    // Extreme negative padding saturates instead of exploding: the padded
    // extent floors at 20% of the raw extent, so scale caps at 5× the fit.
    const extreme = fitScale(b, 1024, 1024, -100000)
    expect(extreme).toBeCloseTo(1024 / (400 * 0.2), 6)
    expect(Number.isFinite(extreme)).toBe(true)
  })

  it('toSvg keeps a positive, mark-centred viewBox even under heavy overscan', async () => {
    const svg = await toSvg({ ...DEFAULT_CONFIG, padding: -100000 })
    const m = svg.match(/viewBox="([^"]+)"/)
    expect(m).toBeTruthy()
    const [minX, minY, w, h] = (m![1].trim().split(/[\s,]+/).map(Number)) as [number, number, number, number]
    // Never non-positive (would be an invalid SVG document / division blow-up).
    expect(w).toBeGreaterThan(0)
    expect(h).toBeGreaterThan(0)
    // Still centred on the mark, so the crop is symmetric.
    const b = contentBounds(await renderShapes(DEFAULT_CONFIG))
    expect(minX + w / 2).toBeCloseTo(b.minX + b.w / 2, 2)
    expect(minY + h / 2).toBeCloseTo(b.minY + b.h / 2, 2)
  })

  it('drawToCanvas and toSvg frame the mark identically (shared framePad)', async () => {
    // toSvg's viewBox is bounds grown by framePad; drawToCanvas fits that same
    // padded box into its output box. The scale drawToCanvas would pick for a
    // square canvas equals output / (viewBox tight axis) — proving one framing.
    const b = contentBounds(await renderShapes(DEFAULT_CONFIG))
    const pad = framePad(DEFAULT_CONFIG)
    const viewW = b.w + pad * 2
    const viewH = b.h + pad * 2
    const canvasScale = fitScale(b, 1024, 1024, pad)
    expect(canvasScale).toBeCloseTo(Math.min(1024 / viewW, 1024 / viewH), 6)
  })

  it('viewBox contains the actual rendered geometry (regression: static-size cropping)', async () => {
    const svg = await toSvg(DEFAULT_CONFIG)
    const match = svg.match(/viewBox="([^"]+)"/)
    expect(match).not.toBeNull()
    const [minX, minY, w, h] = match![1]!.split(/\s+/).map(Number)
    const b = contentBounds(await renderShapes(DEFAULT_CONFIG))
    // The old static `size + padding*2` formula sized the box without
    // regard for `arrange`'s actual clone spread — this would fail against
    // that bug because the real geometry ran well outside it.
    expect(b.minX).toBeGreaterThanOrEqual(minX!)
    expect(b.maxX).toBeLessThanOrEqual(minX! + w!)
    expect(b.minY).toBeGreaterThanOrEqual(minY!)
    expect(b.maxY).toBeLessThanOrEqual(minY! + h!)
  })

  it('default config genuinely overlaps (overlapMode shape yields more shapes than hole)', async () => {
    const hole = await renderShapes({ ...DEFAULT_CONFIG, overlapMode: 'hole' })
    const shape = await renderShapes({ ...DEFAULT_CONFIG, overlapMode: 'shape' })
    expect(shape.length).toBeGreaterThan(hole.length)
  })

  it('toSvg emits a real <linearGradient> for a gradient fill', async () => {
    const grad: any = { type: 'linear', angle: 45, stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }] }
    const svg = await toSvg({ ...DEFAULT_CONFIG, fill: grad })
    expect(svg).toMatch(/<linearGradient/)
    expect(svg).toContain('#ff0000')
  })
  it('toSvg emits a <pattern> for a procedural pattern fill', async () => {
    const patt: any = { type: 'stripes', a: '#111111', b: '#eeeeee', textColor: '#000', angle: 0, density: 8 }
    const svg = await toSvg({ ...DEFAULT_CONFIG, fill: patt })
    expect(svg).toMatch(/<pattern/)
  })
  it('a solid fill stays a plain fill attribute (no defs)', async () => {
    const svg = await toSvg({ ...DEFAULT_CONFIG, fill: '#123456' })
    expect(svg).toContain('#123456')
    expect(svg).not.toMatch(/<linearGradient|<pattern/)
  })

  // ── Task 4: image/shader TIER 3 raster embed ────────────────────────────────
  //
  // `toSvg`'s own raster step rasterizes via a `<canvas>` (`document.
  // createElement('canvas')`), which this suite's `environment: 'node'` vitest
  // config (no jsdom, no `document`) cannot run — `toSvg` itself detects that
  // and degrades to the pre-Task-4 solid fallback (asserted below). The actual
  // "does a raster turn into a `<pattern>`-with-`<image>`" logic lives entirely
  // in `paintToVectorPaint` (`~/lib/paint/toVector.ts`), which is pure — no DOM,
  // no canvas — so it's exercised DIRECTLY here with a stubbed raster, the way
  // `toSvg` would call it after rasterizing for real in a browser. Full
  // image/shader canvas warming + rasterization is browser/GPU-only and is
  // verified live (Task 5), not here — see task-4-report.md.
  const TINY_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
  const box = { x: -10, y: -10, width: 20, height: 20 }

  it('paintToVectorPaint embeds an ImageFill as a <pattern>-with-<image> when given a raster', () => {
    const imageFill: ImageFill = { type: 'image', src: 'blob:whatever', fit: 'cover' }
    // No raster: the pre-Task-4 behaviour — ImageFill has no vector form on its
    // own, so this stays null (the caller's solid fallback).
    expect(paintToVectorPaint(imageFill, { units: 'userSpaceOnUse', box })).toBeNull()
    const vp = paintToVectorPaint(imageFill, { units: 'userSpaceOnUse', box, raster: TINY_PNG_DATA_URL })
    expect(vp).not.toBeNull()
    expect((vp as any).type).toBe('pattern')
    expect((vp as any).image).toBe(TINY_PNG_DATA_URL)
    expect((vp as any).width).toBe(box.width)
    expect((vp as any).height).toBe(box.height)
  })

  it('paintToVectorPaint embeds a shader Fill as a <pattern>-with-<image> when given a raster', () => {
    const shaderFill: Fill = {
      type: 'shader', a: '#111111', b: '#eeeeee', textColor: '#000', angle: 0, density: 8,
      shader: { effectId: 'fbm_warp', params: {}, anchor: 'object', speed: 0, input: '#111111' },
    }
    expect(paintToVectorPaint(shaderFill, { units: 'userSpaceOnUse', box })).toBeNull()
    const vp = paintToVectorPaint(shaderFill, { units: 'userSpaceOnUse', box, raster: TINY_PNG_DATA_URL })
    expect(vp).not.toBeNull()
    expect((vp as any).type).toBe('pattern')
    expect((vp as any).image).toBe(TINY_PNG_DATA_URL)
  })

  it('toSvg degrades gracefully (solid fallback, no crash) for an ImageFill with no DOM available', async () => {
    const imageFill: ImageFill = { type: 'image', src: 'blob:whatever', fit: 'cover' }
    const svg = await toSvg({ ...DEFAULT_CONFIG, fill: imageFill })
    expect(svg).toContain('<svg')
    expect(svg).not.toMatch(/<pattern|<image/)
  })

  it('toSvg fillStrategy perClone emits each clone as its own path, cycling fills', async () => {
    const svg = await toSvg({ ...DEFAULT_CONFIG, fillStrategy: 'perClone', fills: ['#ff0000', '#0000ff'], count: 4 })
    expect(svg).toContain('#ff0000')
    expect(svg).toContain('#0000ff')
    expect((svg.match(/<path/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })

  it('toSvg boxes a gradient paint PER-SHAPE, not to the whole mark', async () => {
    // Two clones 500 apart on x, each filled with the SAME horizontal gradient.
    // A userSpaceOnUse gradient's x1/x2 = box.x + axis*box.width, so if each
    // shape is boxed to its OWN bounds the two <linearGradient>s carry different
    // x1 (each ramp spans its own clone). Boxing to the whole-mark bounds (the
    // bug) gives every shape the SAME coords — one ramp both shapes slice.
    const grad = { type: 'linear', angle: 0, stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }] }
    const svg = await toSvg({ ...DEFAULT_CONFIG, fillStrategy: 'perClone', fills: [grad as any], layout: 'linear', count: 2, spacing: 500, size: 60, symmetry: false, clipMask: 'none' })
    const x1s = [...svg.matchAll(/<linearGradient[^>]*\bx1="(-?[\d.]+)"/g)].map((m) => m[1])
    expect(x1s.length).toBeGreaterThanOrEqual(2)          // one gradient per clone
    expect(new Set(x1s).size).toBeGreaterThanOrEqual(2)   // each anchored to its OWN box (== 1 under the whole-mark bug)
  })

  it('renders a library base shape into shapes and an SVG', async () => {
    const cfg = { ...DEFAULT_CONFIG, shape: 'library' as const, libraryShape: 'swirl', count: 6 }
    const shapes = await renderShapes(cfg)
    expect(shapes.length).toBeGreaterThanOrEqual(1)
    expect(shapes.some(s => s.commands.length > 4)).toBe(true)
    const svg = await toSvg(cfg)
    expect(svg).toMatch(/<path/)
  })
})

describe('blend layout', () => {
  it('count 1 renders the same geometry as linear count 1 (shape A only)', async () => {
    const base = { ...DEFAULT_CONFIG, shape: 'hexagon' as const, fillStrategy: 'perClone' as const, count: 1 }
    const a = await renderShapes({ ...base, layout: 'linear' })
    const b = await renderShapes({ ...base, layout: 'blend', blendShape: 'circle', blendSize: 300 })
    expect(b).toHaveLength(1)
    // NOT a byte-for-byte commandsToPathData() match, unlike the task-6 brief's
    // verbatim assertion: blendPath only takes the exact-skeleton (point-lerp)
    // path when dA and dB share a command skeleton (morph.ts:366). Hexagon (all
    // lineTo) and circle (arcs) never do, so even at blend=0/count=1 shape A
    // comes back through blendPath's RESAMPLED branch — a many-point polyline
    // approximation, not the original 8-command outline. Verified directly:
    // a[0].commands has 8 commands (moveTo + 6 lineTo + closePath), b[0].commands
    // has 130 (resampled to BLEND_SAMPLES points). So this compares geometry
    // (bounds, single-closed-subpath shape) instead, per the brief's guidance for
    // exactly this case.
    const ab = contentBounds(a)
    const bb = contentBounds(b)
    expect(bb.minX).toBeCloseTo(ab.minX, 1)
    expect(bb.maxX).toBeCloseTo(ab.maxX, 1)
    expect(bb.minY).toBeCloseTo(ab.minY, 1)
    expect(bb.maxY).toBeCloseTo(ab.maxY, 1)
    expect(b[0]!.commands.filter(c => c.command === 'moveTo').length).toBe(1)
    expect(b[0]!.commands.filter(c => c.command === 'closePath').length).toBe(1)
  })

  it('the last step lands on shape B, offset by blendX/blendY and sized by blendSize', async () => {
    const cfg = { ...DEFAULT_CONFIG, shape: 'square' as const, size: 100, layout: 'blend' as const, count: 3, blendShape: 'square' as const, blendSize: 200, blendX: 300, blendY: 0, fillStrategy: 'perClone' as const }
    const shapes = await renderShapes(cfg)
    expect(shapes).toHaveLength(3)
    const b = contentBounds([shapes[2]!])
    expect(b.w).toBeCloseTo(200, 0)
    expect(b.minX + b.w / 2).toBeCloseTo(300, 0)
    const mid = contentBounds([shapes[1]!])
    expect(mid.w).toBeCloseTo(150, 0)
    expect(mid.minX + mid.w / 2).toBeCloseTo(150, 0)
  })

  it('a rotated shape B rotates the steps', async () => {
    const cfg = { ...DEFAULT_CONFIG, shape: 'square' as const, size: 100, layout: 'blend' as const, count: 2, blendShape: 'square' as const, blendSize: 100, blendRotate: 45, fillStrategy: 'perClone' as const }
    const shapes = await renderShapes(cfg)
    const b = contentBounds([shapes[1]!])
    expect(b.w).toBeCloseTo(100 * Math.SQRT2, 0) // a 45° square spans its diagonal
  })
})

describe('outline mode reaches the SVG and the canvas paths', () => {
  it('toSvg writes fill="none" and a stroke per outline shape', async () => {
    const svg = await toSvg({ ...DEFAULT_CONFIG, fillStrategy: 'perClone', paintTarget: 'outline', fills: ['#ff0000', '#00ff00'], strokeWidth: 1, count: 2, layout: 'linear', spacing: 300 })
    expect(svg).toContain('fill="none"')
    expect(svg).toContain('stroke="#ff0000"')
    expect(svg).toContain('stroke="#00ff00"')
  })
  it('shapePaints skips outline shapes (nothing to warm)', async () => {
    const shapes = await renderShapes({ ...DEFAULT_CONFIG, fillStrategy: 'perClone', paintTarget: 'outline', count: 3, layout: 'linear' })
    expect(shapePaints(shapes)).toEqual([])
  })
})
