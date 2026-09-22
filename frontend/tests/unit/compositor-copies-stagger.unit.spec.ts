// @vitest-environment happy-dom
/**
 * The copies-stagger PAINT seam.
 *
 * `copyClock`/`staggerOf`/`expandClones(…, only)` are unit-tested on their own, but none
 * of them says the renderer actually paints a cloned layer once per copy. That wire lives
 * in exactly one place — `paintLayerStack`, between the motion fold and the draw loop —
 * and it can fail two ways that every other green test would miss: the copies all fold at
 * the frame clock (a stagger that does nothing), or the expansion runs for layers that
 * have no stagger at all (every old Frame quietly re-rendered through new code).
 *
 * So this drives the REAL `paintLayerStack` with a recording context — the `makeCtx`
 * pattern of `compositor-clip-paint.unit.spec.ts`, widened to log the whole call stream
 * rather than just the images — and reads the alpha each copy was painted at straight off
 * the recorder. The fold is never called by hand.
 */
import { describe, expect, it } from 'vitest'
import { paintLayerStack, createRectLayer, type LocalLayer } from '~/composables/useCompositorLayers'
import { DEFAULT_CLONER, expandClones, type Cloner } from '~/composables/useCloner'
import { SILHOUETTE_KEY_STRIP } from '~/lib/compositor/silhouetteCache'
import type { Track } from '~/lib/motionx'

/** A recording 2D context: real transform + state stack, and every op that puts ink on
 *  the canvas logged WITH the state it was put down under (alpha, style, transform).
 *  `log` is the byte-identity witness; `alphas` is the per-copy reading. */
function makeCtx(width = 100, height = 100) {
  const log: string[] = []
  const alphas: number[] = []
  let m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
  const saves: { m: typeof m; a: number; g: string; fs: unknown; ss: unknown; lw: number }[] = []
  const num = (n: unknown) => (typeof n === 'number' ? n.toFixed(6) : String(n))
  const state = () => `a=${num(ctx.globalAlpha)} op=${ctx.globalCompositeOperation} fill=${String(ctx.fillStyle)} stroke=${String(ctx.strokeStyle)} lw=${num(ctx.lineWidth)} m=${[m.a, m.b, m.c, m.d, m.e, m.f].map(num).join('/')}`
  const rec = (op: string, ...args: unknown[]) => { log.push(`${op}(${args.map(num).join(',')}) ${state()}`) }
  const ink = (op: string, ...args: unknown[]) => { alphas.push(ctx.globalAlpha); rec(op, ...args) }
  const ctx: any = {
    canvas: { width, height },
    globalAlpha: 1, globalCompositeOperation: 'source-over', filter: 'none',
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1,
    shadowColor: 'transparent', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
    font: '', textAlign: 'start', textBaseline: 'alphabetic',
    imageSmoothingEnabled: true, imageSmoothingQuality: 'low',
    save() { saves.push({ m: { ...m }, a: ctx.globalAlpha, g: ctx.globalCompositeOperation, fs: ctx.fillStyle, ss: ctx.strokeStyle, lw: ctx.lineWidth }); rec('save') },
    restore() {
      const p = saves.pop()
      if (p) { m = p.m; ctx.globalAlpha = p.a; ctx.globalCompositeOperation = p.g; ctx.fillStyle = p.fs; ctx.strokeStyle = p.ss; ctx.lineWidth = p.lw }
      rec('restore')
    },
    translate(tx: number, ty: number) { m.e += m.a * tx + m.c * ty; m.f += m.b * tx + m.d * ty; rec('translate', tx, ty) },
    scale(sx: number, sy: number) { m.a *= sx; m.b *= sx; m.c *= sy; m.d *= sy; rec('scale', sx, sy) },
    rotate(r: number) {
      const cos = Math.cos(r), sin = Math.sin(r)
      const a = m.a * cos + m.c * sin, b = m.b * cos + m.d * sin
      const c = m.a * -sin + m.c * cos, d = m.b * -sin + m.d * cos
      m.a = a; m.b = b; m.c = c; m.d = d
      rec('rotate', r)
    },
    transform() { rec('transform') },
    setTransform(a: any, b?: number, c?: number, d?: number, e?: number, f?: number) {
      m = typeof a === 'object' ? { a: a.a, b: a.b, c: a.c, d: a.d, e: a.e, f: a.f } : { a, b: b!, c: c!, d: d!, e: e!, f: f! }
      rec('setTransform')
    },
    getTransform() { return { ...m } },
    beginPath() { rec('beginPath') }, closePath() { rec('closePath') },
    moveTo(...a: number[]) { rec('moveTo', ...a) }, lineTo(...a: number[]) { rec('lineTo', ...a) },
    arc(...a: number[]) { rec('arc', ...a) }, arcTo(...a: number[]) { rec('arcTo', ...a) },
    bezierCurveTo(...a: number[]) { rec('bezierCurveTo', ...a) },
    quadraticCurveTo(...a: number[]) { rec('quadraticCurveTo', ...a) },
    rect(...a: number[]) { rec('rect', ...a) },
    roundRect(...a: unknown[]) { rec('roundRect', ...a.map(v => (Array.isArray(v) ? v.join('|') : v))) },
    ellipse(...a: number[]) { rec('ellipse', ...a) },
    clip() { rec('clip') }, clearRect(...a: number[]) { rec('clearRect', ...a) },
    fill(...a: unknown[]) { ink('fill', ...a.map(() => 'path')) },
    stroke(...a: unknown[]) { ink('stroke', ...a.map(() => 'path')) },
    fillRect(...a: number[]) { ink('fillRect', ...a) },
    strokeRect(...a: number[]) { ink('strokeRect', ...a) },
    getImageData(_x: number, _y: number, w: number, h: number) {
      return { data: new Uint8ClampedArray(Math.max(4, w * h * 4)), width: w, height: h }
    },
    putImageData() { rec('putImageData') },
    drawImage() { ink('drawImage') },
    measureText() { return { width: 0, actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 0, actualBoundingBoxLeft: 0, actualBoundingBoxRight: 0 } },
    createLinearGradient() { return { addColorStop() {} } },
    createRadialGradient() { return { addColorStop() {} } },
    createConicGradient() { return { addColorStop() {} } },
    createPattern() { return null },
    setLineDash() { rec('setLineDash') }, getLineDash() { return [] },
    fillText(...a: unknown[]) { ink('fillText', ...a) }, strokeText(...a: unknown[]) { ink('strokeText', ...a) },
  }
  return { ctx: ctx as CanvasRenderingContext2D, log, alphas }
}

const ID = 'staggered-rect'

/** One opacity band on the layer: 0 → 1 across 0–1 s, linear. */
const band = (): Track => ({
  path: `layers.${ID}.opacity`,
  type: 'number',
  keyframes: [{ t: 0, value: 0, ease: 'linear' }, { t: 1, value: 1, ease: 'linear' }],
})

const clonedRect = (cloner: Partial<Cloner>): LocalLayer => createRectLayer({
  id: ID, x: 0.5, y: 0.5, w: 0.3, h: 0.2, radius: 0, strokeWidth: 0,
  cloner: { ...DEFAULT_CLONER, enabled: true, mode: 'radial', count: 3, ...cloner } as Cloner,
}) as LocalLayer

/** Paint one stack at `t` through the real painter. */
function paintAt(layer: LocalLayer, t: number) {
  const { ctx, log, alphas } = makeCtx()
  paintLayerStack(
    ctx, 100, 100,
    [{ type: 'local', key: `l:${layer.id}`, layer } as never], [layer],
    undefined, t, { fps: 30, duration: 2, motionx: [band()] },
  )
  return { log, alphas }
}

describe('paintLayerStack — a cloned layer with a motion stagger', () => {
  it('paints each copy at its OWN clock, in the cloner\'s own paint order', () => {
    const cloner = { motionStagger: 0.5, motionOrder: 'first' as const }
    const layer = clonedRect(cloner)
    const { alphas } = paintAt(layer, 0.75)

    // The claim, derived from the SAME expansion the painter walks (never a hand-rolled
    // order): copy k sees t − rank(k)·0.5, and the band clamps to its first key before 0.
    const copies = expandClones(layer.cloner!, 1)
    expect(copies.map(c => c.k)).toEqual([2, 1, 0])     // back-to-front; original last/on top
    expect(alphas).toHaveLength(3)
    // k=2 → 0.75 − 1.0 = −0.25 → held at 0; k=1 → 0.25; k=0 → 0.75.
    expect(alphas.map(a => Number(a.toFixed(6)))).toEqual([0, 0.25, 0.75])
    expect(new Set(alphas).size).toBe(3)               // three DIFFERENT clocks, not unison
  })

  it('honours the copy order: "last" reverses which copy leads', () => {
    const layer = clonedRect({ motionStagger: 0.5, motionOrder: 'last' })
    // ranks are [2,1,0], so k=2 leads (clock 0.75) and k=0 trails (clock −0.25 → 0).
    expect(paintAt(layer, 0.75).alphas.map(a => Number(a.toFixed(6)))).toEqual([0.75, 0.25, 0])
  })

  it('stagger 0 takes the EXISTING path: byte-identical to a layer with no stagger field', () => {
    const zero = clonedRect({ motionStagger: 0 })
    const { cloner: c0 } = zero as { cloner?: Cloner }
    const { motionStagger: _drop, ...noField } = c0!
    const absent = clonedRect({}) as LocalLayer
    ;(absent as { cloner?: Cloner }).cloner = noField as Cloner
    expect('motionStagger' in (absent as { cloner: Cloner }).cloner).toBe(false)

    const a = paintAt(zero, 0.75)
    const b = paintAt(absent, 0.75)
    expect(a.log).toEqual(b.log)
    expect(a.log.length).toBeGreaterThan(0)
    // …and the un-staggered array is unison, every copy on the frame clock.
    expect(a.alphas.map(x => Number(x.toFixed(6)))).toEqual([0.75, 0.75, 0.75])
  })

  it('a stagger on a DISABLED cloner changes nothing', () => {
    const off = clonedRect({ enabled: false, motionStagger: 0.5 })
    const plain = clonedRect({ enabled: false })
    expect(paintAt(off, 0.75).log).toEqual(paintAt(plain, 0.75).log)
    expect(paintAt(off, 0.75).alphas.map(x => Number(x.toFixed(6)))).toEqual([0.75])
  })

  it('a mirrored linear cloner stamps once per COPY, twins sharing one rank and clock', () => {
    // countX: 3, mirrorX: true → 5 copies at k = [0, 1, 2, 1, 2] (the ±1 and ±2 twins
    // share a falloff step). The BUG: the old code emitted one painted item per raw
    // entry, and each item's stamp site redraws EVERY copy at its k — so the two twins
    // at k=1 each redrew both of themselves (2×2), same at k=2 (2×2), plus the lone
    // original (1×1) = 9 stamps instead of 5, and ranks were handed out over 5 entries
    // when k only spans 0..2, starting the whole array late under motionOrder: 'last'.
    const layer = createRectLayer({
      id: ID, x: 0.5, y: 0.5, w: 0.3, h: 0.2, radius: 0, strokeWidth: 0,
      cloner: {
        ...DEFAULT_CLONER, enabled: true, mode: 'linear', countX: 3, countY: 1,
        spacingX: 0.2, mirrorX: true, motionStagger: 0.5, motionOrder: 'last',
      } as Cloner,
    }) as LocalLayer
    const { alphas } = paintAt(layer, 0.9)

    // Exactly 5 stamps — one per copy (3 distinct k values, two of them shared by a twin
    // pair) — never 9.
    expect(alphas).toHaveLength(5)
    const rounded = alphas.map(a => Number(a.toFixed(6)))

    // Draw order follows expandClones' own (k descending, original last): the k=2 twins
    // paint first (together), then the k=1 twins, then the k=0 original alone.
    // distinctCount = 3 (NOT the 5 raw entries): copyRanks(3, 'last') gives k=2 → rank 0
    // (frame clock, no lag — "sees the frame clock"), k=1 → rank 1 (clock 0.9−0.5=0.4),
    // k=0 → rank 2 (clock 0.9−1.0=−0.1 → clamped to 0, the LARGEST lag).
    expect(rounded).toEqual([0.9, 0.9, 0.4, 0.4, 0])

    // The two twins at each shared k share exactly one alpha (one clock, one fold).
    expect(rounded[0]).toBe(rounded[1])
    expect(rounded[2]).toBe(rounded[3])

    // The ORIGINAL (k=0, last stamp) has the largest lag — the smallest alpha, since the
    // band only rises with more advanced clocks.
    expect(rounded[4]).toBeLessThan(rounded[2])
    expect(rounded[4]).toBeLessThan(rounded[0])
  })

  it('`motionCopy` is transient: stripped from the silhouette cache key, never on the stored layer', () => {
    expect((SILHOUETTE_KEY_STRIP as readonly string[]).includes('motionCopy')).toBe(true)
    const layer = clonedRect({ motionStagger: 0.5 })
    paintAt(layer, 0.75)
    expect((layer as { motionCopy?: number }).motionCopy).toBeUndefined()
  })
})
