import { describe, it, expect } from 'vitest'
import { Steadier, HoldWatch, STEADY_DEFAULTS, holdMsOf, sanitizeSteady } from '~/lib/brushTips/steady'

const OFF = { ...STEADY_DEFAULTS, streamline: 0, stabilise: 0, filter: 0 }
const jittery = (n: number) => Array.from({ length: n }, (_, i) => ({ x: i * 3, y: 100 + (i % 2 ? 2.5 : -2.5), t: i * 8 }))
const wobble = (pts: { y: number }[]) => { let s = 0; for (let i = 1; i < pts.length; i++) s += Math.abs(pts[i]!.y - pts[i - 1]!.y); return s / (pts.length - 1) }

describe('steady', () => {
  it('defaults and hold time', () => {
    expect(STEADY_DEFAULTS).toEqual({ streamline: 0.3, stabilise: 0.15, filter: 0.4, snap: true, hold: 0.5 })
    expect(holdMsOf(0)).toBe(250); expect(holdMsOf(1)).toBe(1000); expect(holdMsOf(0.5)).toBe(625)
  })
  it('all at zero passes samples through untouched', () => {
    const s = new Steadier(OFF, 0, 100, 0)
    for (const p of jittery(20)) expect(s.input(p.x, p.y, p.t)).toEqual([{ x: p.x, y: p.y }])
  })
  it('filtering and stabilisation reduce jitter', () => {
    const s = new Steadier({ ...OFF, filter: 0.4, stabilise: 0.15 }, 0, 100, 0)
    const out = jittery(60).flatMap(p => s.input(p.x, p.y, p.t))
    expect(wobble(out)).toBeLessThan(wobble(jittery(60)) * 0.5)
  })
  it('streamline emits nothing on input, then catches up on advance', () => {
    const s = new Steadier({ ...OFF, streamline: 0.3 }, 0, 0, 0)
    expect(s.input(100, 0, 10)).toEqual([])
    const a = s.advance(26)
    expect(a.samples.length).toBeGreaterThan(0)
    expect(a.samples.at(-1)!.x).toBeGreaterThan(0); expect(a.samples.at(-1)!.x).toBeLessThan(100)
    const b = s.advance(2000)
    expect(b.samples.at(-1)!.x).toBeGreaterThan(99)
    for (const smp of [...a.samples, ...b.samples]) expect(smp.t).toBeGreaterThan(0)
  })
  it('releasing catches up faster', () => {
    const slow = new Steadier({ ...OFF, streamline: 0.5 }, 0, 0, 0), fast = new Steadier({ ...OFF, streamline: 0.5 }, 0, 0, 0)
    slow.input(100, 0, 1); fast.input(100, 0, 1)
    expect(fast.advance(60, true).samples.at(-1)!.x).toBeGreaterThan(slow.advance(60).samples.at(-1)!.x)
  })
  it('caughtUp once within 0.6 px', () => {
    const s = new Steadier({ ...OFF, streamline: 0.2 }, 0, 0, 0); s.input(10, 0, 1)
    expect(s.advance(5000).caughtUp).toBe(true)
  })
  it('hold watch: still time resets on a move over 3 px', () => {
    const h = new HoldWatch(0, 0, 0)
    h.move(2, 0, 100); expect(h.stillFor(500)).toBe(500)
    h.move(6, 0, 600); expect(h.stillFor(700)).toBe(100)
  })
  it('sanitises stored settings', () => {
    expect(sanitizeSteady(null)).toEqual(STEADY_DEFAULTS)
    expect(sanitizeSteady({ streamline: 2, stabilise: -1, filter: 'x', snap: 0, hold: 0.8 }))
      .toEqual({ streamline: 1, stabilise: 0, filter: 0.4, snap: true, hold: 0.8 })
  })
})
