import { describe, it, expect } from 'vitest'
import { candidatesForFrame, planLayout } from '~/lib/frame/patterns/kit/plan'
import type { LayoutPlanArgs } from '~/lib/frame/patterns/kit/plan'
import { inkBoxOf } from '~/lib/frame/patterns/kit/check'
import type { Box } from '~/lib/frame/patterns/kit/check'
import { makeStubMeasure } from '~/lib/frame/patterns/kit/measure'
import { makeSheet } from '~/lib/frame/patterns/kit/sheet'
import type { El, PhotoEl, TextEl } from '~/lib/frame/patterns/kit/types'
import { layoutsForStyle } from '~/lib/frame/patterns/layouts/catalog'
import { createTextLayer } from '~/composables/useCompositorLayers'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import { palette } from './helpers/frameLayoutFixtures'

// ═══════════════════════ Run-off on a 728×90 banner, image on the left ═══════════════════════
// Bug seen in the browser: a 728×90 Frame (title "Weather Report", Inter 600; "Ines Vollmer",
// Inter 500; the date; a one-line caption; two wired images) took Run-off with
// `{ lines: 0, arr: 2, scale: 'full', side: 'left' }` ("Lower", image side "Left"). The first
// wired image, drawn above the text, covered the START of the title ("Weathe").
//
// On a wide frame the planner gives an image layout a side image and composes the layout on the
// other 62% of the columns. Run-off draws that image OVER its title on purpose: the image's edge is
// the page's edge for the type, and the title runs off under it. But Run-off anchored its title at
// the PAGE margin (`M`) and fitted it to the page's width from x = 0 — right for the image on the
// right (the design columns start at the margin), wrong for the image on the left, where the design
// columns start after the image: the title started under the image. The checker let it pass because
// the side image is exempt from collisions (`ok`) and "runs under the side image" counts as keeping
// the bleed promise, whichever end of the title is under it.
//
// The rule these tests hold: text drawn under an image (the image later in element order, so on
// top) is refused — except Run-off's title, and only at the end it runs off: its anchored edge (the
// left edge of a left-aligned title, the right edge of a right-aligned one) stays clear of the
// image. The stub measure shows the bug as plainly as the real face does (stub title ink starts at
// 0.3 units, the image ends at 37.4), so the stub is used, like the other matrices.

const t = (id: string, text: string, fontSize: number, fontWeight: number) =>
  createTextLayer({ id, text, fontSize, fontFamily: 'Inter', fontWeight, color: '#111111' }) as LocalLayer
const wired = (id: string, slot: number): LocalLayer =>
  ({ id, kind: 'wired', slot, w: 0.4, lastAspect: 1.25, x: 0.7, y: 0.7, rotation: 0, opacity: 1 } as unknown as LocalLayer)
const bannerFrame = (): LocalLayer[] => [
  t('t', 'Weather Report', 0.12, 600),
  t('d', 'Ines Vollmer', 0.04, 500),
  t('dt', '19.09.–15.11.2026', 0.03, 400),
  t('c', 'Kunstraum Lenz, Lenzgasse 14, Basel', 0.02, 400),
  wired('w1', 0),
  wired('w2', 1),
]
const W = 728, H = 90
const argsFor = (layoutId: string): Omit<LayoutPlanArgs, 'choice'> => ({
  props: { sailor_localLayers: bannerFrame(), sailor_frame: { preset: 'ad-728x90' } },
  frameW: W, frameH: H, layoutId, palette, connectedSlots: [], measure: makeStubMeasure(),
})
const S = makeSheet({ frameW: W, frameH: H, measure: makeStubMeasure() })
const overlaps = (a: Box, b: Box) =>
  Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0.25 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0.25

/** Every text drawn under an image, with the reason it is wrong; empty when none is. Run-off's
 *  title may run off under an image at its free end only. */
function textUnderImage(els: El[], layoutId: string): string[] {
  const bad: string[] = []
  els.forEach((e, i) => {
    if (e.k !== 't') return
    const tb = inkBoxOf(e, S)!
    for (const p of els.slice(i + 1)) {
      if (p.k !== 'p') continue
      const pb = inkBoxOf(p, S)!
      if (!overlaps(tb, pb)) continue
      if (layoutId === 'runoff' && e.role === 'title') {
        // The anchored edge must be clear of the image: only the run-off end goes under it.
        const anchor = (e as TextEl).align === 'right' ? tb.x1 : tb.x0
        if (anchor > pb.x0 + 0.25 && anchor < pb.x1 - 0.25) bad.push(`title starts under ${p.role} (anchor ${anchor.toFixed(1)} in ${pb.x0.toFixed(1)}..${pb.x1.toFixed(1)})`)
        continue
      }
      bad.push(`${e.role} under ${p.role}`)
    }
  })
  return bad
}

describe('Run-off on a 728×90 banner with two wired images', () => {
  it('the browser choice (Lower, image on the left) keeps the title\'s start clear of the image, or is refused', () => {
    const choice = { lines: 0, arr: 2, scale: 'full', side: 'left' } as const
    const plan = planLayout({ ...argsFor('runoff'), choice })!
    expect(plan).not.toBeNull()
    if (!plan.issues.length) {
      const cand = candidatesForFrame(argsFor('runoff')).find(c => JSON.stringify(c.choice) === JSON.stringify(choice))
      expect(cand, 'an issue-free plan is offered').toBeDefined()
      expect(textUnderImage(cand!.out.els, 'runoff')).toEqual([])
      // The planned layers agree: the title's left edge is right of the side image's right edge.
      const title = cand!.out.els.find((e): e is TextEl => e.k === 't' && e.role === 'title')!
      const side = cand!.out.els.find((e): e is PhotoEl => e.k === 'p' && e.role === 'photo')!
      expect(inkBoxOf(title, S)!.x0).toBeGreaterThanOrEqual(side.x + side.w - 0.25)
    }
  })

  it('every offered Run-off variation keeps the title\'s anchored edge clear of the side image', () => {
    const cands = candidatesForFrame(argsFor('runoff'))
    expect(cands.length).toBeGreaterThan(0)
    for (const c of cands) expect(textUnderImage(c.out.els, 'runoff'), JSON.stringify(c.choice)).toEqual([])
  })

  it('both image sides are still offered (the fix does not just drop the left side)', () => {
    const sides = new Set(candidatesForFrame(argsFor('runoff')).map(c => c.choice.side))
    expect([...sides].sort()).toEqual(['left', 'right'])
  })

  it('no offered Swiss variation on this Frame draws text under an image', () => {
    for (const def of layoutsForStyle('swiss')) {
      for (const c of candidatesForFrame(argsFor(def.id))) {
        expect.soft(textUnderImage(c.out.els, def.id), `${def.id} ${JSON.stringify(c.choice)}`).toEqual([])
      }
    }
  })

  it('the checker refuses a Run-off title anchored under the side image (the planner\'s own check)', async () => {
    // Force the old geometry through the checker: Run-off's side-image rule must see the title's
    // start under the image and refuse it, whatever the layout function does.
    const { checkSideRunOff } = await import('~/lib/frame/patterns/kit/check')
    const side: PhotoEl = { k: 'p', x: -5, y: 0, w: 42.4, h: 12.4, role: 'photo', bleed: true }
    const title: TextEl = { k: 't', s: 'Weather Report', x: -0.4, base: 10, size: 10.7, ls: 0, lh: 1, role: 'title', bleed: true }
    expect(checkSideRunOff(title, side, S)).toEqual(['title: starts under the image'])
    // Its run-off end under the image passes: the title starts at 40 and runs off to the right,
    // under an image on the right.
    const right: PhotoEl = { ...side, x: 64 }
    expect(checkSideRunOff({ ...title, x: 4 }, right, S)).toEqual([])
    // A right-aligned title (Run-off's "Left edge") anchors its right edge.
    const rTitle: TextEl = { ...title, x: 30, w: 60, align: 'right' }
    expect(checkSideRunOff(rTitle, side, S)).toEqual([])
    expect(checkSideRunOff({ ...rTitle, x: -30 }, side, S)).toEqual(['title: starts under the image'])
  })
})
