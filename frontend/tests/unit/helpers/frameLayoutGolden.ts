// Stage 3's baseline: every layout's candidates on a fixed set of Frames, as the planner makes them
// BEFORE the kit moves onto the Frame's layout grid. `sig` pins the geometry (Tasks 2–7 must not
// move it); `count` is the yardstick the sweep ratchet measures losses against (Task 8 onward).
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { candidatesForFrame } from '~/lib/frame/patterns/kit/plan'
import type { LayoutPlanArgs } from '~/lib/frame/patterns/kit/plan'
import { LAYOUTS, layoutsForStyle } from '~/lib/frame/patterns/layouts/catalog'
import { makeStubMeasure } from '~/lib/frame/patterns/kit/measure'
import { FRAME_FORMATS } from '~/lib/frame/formats'
import type { Kind } from '~/lib/frame/patterns/kit/types'
import { createImageLayer, createTextLayer } from '~/composables/useCompositorLayers'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import { adFrameLayers, eventFrameLayers, frameLayers, galleryFrameLayers, palette } from './frameLayoutFixtures'

type Frame = { id: string; w: number; h: number; preset?: string }
const fmt = (id: string): Frame => { const f = FRAME_FORMATS.find(x => x.id === id)!; return { id, w: f.w, h: f.h, preset: id } }
const SWISS_FRAMES: Frame[] = [
  { id: 'portrait', w: 895, h: 1280 }, { id: 'square', w: 1080, h: 1080 },
  { id: 'landscape', w: 1280, h: 720 }, { id: 'banner', w: 1280, h: 400 },
  fmt('meta-story'), fmt('pinterest-9x16'), fmt('pmax-landscape'), fmt('ad-300x250'), fmt('ad-728x90'),
]
const STYLE_FRAMES: Frame[] = [{ id: 'portrait', w: 895, h: 1280 }, fmt('meta-story'), fmt('ad-300x250'), fmt('ad-728x90')]
const STYLE_FIXTURES = { performance: adFrameLayers, editorial: galleryFrameLayers, street: eventFrameLayers } as const

// The Stage 4 content layouts (`needsContent`) need the full ad Frame — a copy of the ads matrix's
// `LINES` / `fullAdLayers` (a spec file can't be imported).
const AD_LINES: [string, string, number][] = [
  ['t', 'Run lighter.', 0.12], ['s', '198 g', 0.06], ['sl', 'Our lightest trail shoe yet.', 0.045],
  ['d', 'Halden Trail 2', 0.04], ['q', '“Lightest shoe I have ever raced in.”', 0.035], ['dt', '–30%', 0.03],
  ['a', 'Shop now', 0.025], ['r', '4.7 ★', 0.022],
  ['l', 'Carbon plate for push-off\n198 g per shoe\nGrips on wet rock\nFree returns for 60 days', 0.022],
  ['c', 'Offer ends 12 October. While stocks last.', 0.02], ['v', 'vs a typical trail shoe', 0.02],
  ['b', '— Maya R., verified buyer', 0.018],
]
function fullAdLayers(image2: boolean): LocalLayer[] {
  const out = AD_LINES.map(([id, text, fontSize]) =>
    createTextLayer({ id, text, fontSize, fontFamily: 'Inter', fontWeight: 600, color: '#111111' }) as LocalLayer)
  out.push(createImageLayer('x.png', 1.25, { id: 'img', w: 0.5, h: 0.625 }) as LocalLayer)
  if (image2) out.push(createImageLayer('y.png', 1.25, { id: 'img2', w: 0.5, h: 0.625 }) as LocalLayer)
  return out
}

export interface GoldenCombo { layoutId: string; label: string; args: Omit<LayoutPlanArgs, 'choice'> }

const argsFor = (layoutId: string, f: Frame, layers: LocalLayer[], style?: 'performance' | 'editorial' | 'street'): Omit<LayoutPlanArgs, 'choice'> => ({
  props: { sailor_localLayers: layers, ...(f.preset ? { sailor_frame: { preset: f.preset } } : {}) },
  frameW: f.w, frameH: f.h, layoutId, palette, connectedSlots: [], measure: makeStubMeasure(),
  ...(style ? { style } : {}),
})

/** Every baseline combination, in a fixed order. */
export function goldenCombos(): GoldenCombo[] {
  const out: GoldenCombo[] = []
  for (const def of LAYOUTS) {
    for (const kind of def.fits as Kind[]) for (const image of [false, true]) for (const f of SWISS_FRAMES) {
      out.push({ layoutId: def.id, label: `swiss|${f.id}|${kind}|${image}`, args: argsFor(def.id, f, frameLayers(kind, { image, shape: !!def.needs?.shape })) })
    }
  }
  for (const style of ['performance', 'editorial', 'street'] as const) {
    for (const def of layoutsForStyle(style)) {
      if (def.needsContent) {
        for (const f of STYLE_FRAMES) {
          out.push({ layoutId: def.id, label: `${style}|${f.id}|content`, args: argsFor(def.id, f, fullAdLayers(def.needsContent.includes('image2')), style) })
        }
        continue
      }
      for (const kind of def.fits as Kind[]) for (const image of [false, true]) for (const f of STYLE_FRAMES) {
        out.push({ layoutId: def.id, label: `${style}|${f.id}|${kind}|${image}`, args: argsFor(def.id, f, STYLE_FIXTURES[style](kind, { image, action: true }), style) })
      }
    }
  }
  return out
}

const r2 = (_k: string, v: unknown) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)

/** One layout's combinations: a SHA-256 (first 16 hex) over every candidate's choice and elements,
 *  numbers rounded to 0.01 (as `frame-layout-plan.unit.spec.ts`'s `geometrySig`), and how many
 *  candidates there are in all. */
export function goldenOf(combos: GoldenCombo[]): { sig: string; count: number } {
  const lists = combos.map(c => [c.label, candidatesForFrame(c.args).map(x => [x.choice, x.out.els])] as const)
  const count = lists.reduce((n, [, l]) => n + l.length, 0)
  return { sig: createHash('sha256').update(JSON.stringify(lists, r2)).digest('hex').slice(0, 16), count }
}

export const GOLDEN_PATH = resolve(__dirname, 'frameLayoutGolden.json')
export function readGolden(): Record<string, { sig: string; count: number }> {
  return JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'))
}
