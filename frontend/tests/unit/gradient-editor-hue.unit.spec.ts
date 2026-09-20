// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import GradientEditor from '~/components/vue-canvas/compositor/GradientEditor.vue'
import { hexToRgb } from '~/lib/color/convert'
import { gradientFromPaint } from '~/lib/compositor/fillPalette'
import type { Gradient, GradientStop } from '~/lib/compositor/paint'

// Two distant hues — orange vs blue — the case a straight sRGB ramp muddies.
const ORANGE = '#e4572e'
const BLUE = '#2e5be4'
const direct2 = (): Gradient => ({ type: 'linear', angle: 90, stops: [{ offset: 0, color: ORANGE }, { offset: 1, color: BLUE }] })

const mountWith = (g: Gradient) => mount(GradientEditor, { props: { modelValue: g } })
// Interpolation was a row of three buttons; since the studio-row polish (98c60a2e0) it is a
// labelled StudioSelect — a native <select aria-label="Interpolation"> under the row. Pick the
// option the way a person does; the name is kept so the cases below read as they did.
const clickInterp = async (w: ReturnType<typeof mountWith>, label: string) => {
  const sel = w.find('select[aria-label="Interpolation"]')
  if (!sel.exists()) throw new Error('no Interpolation select')
  const opt = sel.findAll('option').find(o => o.text() === label || o.attributes('value') === label)
  if (!opt) throw new Error('no interpolation option ' + label)
  await sel.setValue(opt.attributes('value') ?? label)
}
const lastEmit = (w: ReturnType<typeof mountWith>): Gradient & { interp?: string; interpBase?: GradientStop[] } => {
  const ev = w.emitted('update:modelValue')
  if (!ev?.length) throw new Error('nothing emitted')
  return ev[ev.length - 1]![0] as Gradient & { interp?: string; interpBase?: GradientStop[] }
}

/** What a native canvas linear gradient paints at position p: sRGB lerp between
 *  the two baked stops that bracket p. This is the actual rendered pixel. */
function sampleSRGB(stops: GradientStop[], p: number): [number, number, number] {
  const s = [...stops].sort((a, b) => a.offset - b.offset)
  if (p <= s[0]!.offset) return hexToRgb(s[0]!.color)
  if (p >= s[s.length - 1]!.offset) return hexToRgb(s[s.length - 1]!.color)
  for (let i = 0; i < s.length - 1; i++) {
    const lo = s[i]!, hi = s[i + 1]!
    if (p >= lo.offset && p <= hi.offset) {
      const t = hi.offset === lo.offset ? 0 : (p - lo.offset) / (hi.offset - lo.offset)
      const a = hexToRgb(lo.color), b = hexToRgb(hi.color)
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
    }
  }
  return hexToRgb(s[0]!.color)
}

describe('GradientEditor — hue-walk interpolation wiring', () => {
  it('Direct is byte-identical: still two stops, no interp fields', async () => {
    const w = mountWith(direct2())
    await clickInterp(w, 'Hue (short)')
    await clickInterp(w, 'Direct')
    const g = lastEmit(w)
    expect(g.stops).toHaveLength(2)
    expect(g.stops[0]!.color).toBe(ORANGE)
    expect(g.stops[1]!.color).toBe(BLUE)
    expect(g.interp).toBeUndefined()
    expect(g.interpBase).toBeUndefined()
  })

  it('Hue (long) bakes many intermediate stops and records mode + author stops', async () => {
    const w = mountWith(direct2())
    await clickInterp(w, 'Hue (long)')
    const g = lastEmit(w)
    expect(g.stops.length).toBeGreaterThan(2)         // extra baked stops present
    expect(g.interp).toBe('hue-long')
    expect(g.interpBase).toHaveLength(2)              // the two author stops preserved
    expect(g.interpBase![0]!.color).toBe(ORANGE)
    expect(g.type === 'linear' && g.angle).toBe(90)   // geometry untouched
  })

  it('the rendered midpoint pixel actually changes Direct -> Hue (long)', async () => {
    const directMid = sampleSRGB(direct2().stops, 0.5)

    const w = mountWith(direct2())
    await clickInterp(w, 'Hue (long)')
    const longMid = sampleSRGB(lastEmit(w).stops, 0.5)

    const d = Math.hypot(longMid[0] - directMid[0], longMid[1] - directMid[1], longMid[2] - directMid[2])
    // eslint-disable-next-line no-console
    console.log('midpoint RGB — direct:', directMid.map(Math.round), 'hue-long:', longMid.map(Math.round), 'Δ=', Math.round(d))
    expect(d).toBeGreaterThan(20)                     // a plainly visible difference
  })

  it('short and long paint different midpoints', async () => {
    const ws = mountWith(direct2()); await clickInterp(ws, 'Hue (short)')
    const shortMid = sampleSRGB(lastEmit(ws).stops, 0.5)
    const wl = mountWith(direct2()); await clickInterp(wl, 'Hue (long)')
    const longMid = sampleSRGB(lastEmit(wl).stops, 0.5)
    expect(shortMid.map(Math.round)).not.toEqual(longMid.map(Math.round))
  })

  it('round-trips THROUGH the real read-back normalizer: mode + author stops survive gradientFromPaint', async () => {
    // Emit a hue-long gradient, then feed it back in the way the app actually does:
    // FillControl.toGrad → gradientFromPaint before it reaches the editor. Mounting the
    // saved object directly would bypass that path (and mask the stripping bug), so route
    // it through the normalizer first — this test fails if interp/interpBase are dropped.
    const w1 = mountWith(direct2())
    await clickInterp(w1, 'Hue (long)')
    const saved = lastEmit(w1)
    expect(saved.interp).toBe('hue-long')

    // The normalizer must preserve the interpolation choice + the author stops.
    const reloaded = gradientFromPaint(saved, ORANGE, BLUE, 90) as Gradient & { interp?: string; interpBase?: GradientStop[] }
    expect(reloaded.interp).toBe('hue-long')
    expect(reloaded.interpBase).toHaveLength(2)
    expect(reloaded.interpBase![0]!.color).toBe(ORANGE)

    // And the editor, re-fed the normalized gradient, still shows Hue (long) (not Direct),
    // so Direct then cleanly restores the two author colours.
    const w2 = mountWith(reloaded)
    await clickInterp(w2, 'Direct')
    const back = lastEmit(w2)
    expect(back.stops).toHaveLength(2)
    expect(back.stops[0]!.color).toBe(ORANGE)
    expect(back.stops[1]!.color).toBe(BLUE)
    expect(back.interp).toBeUndefined()
  })
})
