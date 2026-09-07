import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '@playwright/test'
import { openCompositor, stackPixels } from './_helpers'

/**
 * A layer's strokes as an ordered stack — end to end.
 *
 * The load-bearing case is BYTE-IDENTITY: every stroked kind, stored in TODAY'S
 * single-stroke shape, must render the same pixels through the stack painter as it did
 * through the single `strokeAligned` call the painter used to make. That is what protects
 * every frame anyone has already saved, and no screenshot can argue with it.
 *
 * The mechanism it is guarding: `strokeStackOf` folds a legacy stroke into a ONE-entry
 * list at distance 0, and `paintStrokeBand` delegates distance 0 straight back to
 * `strokeAligned` — so the loop that replaced the single call runs exactly the statements
 * the single call ran. This test is the proof that the chain actually holds for real
 * layers, alignments, dashes, gradients and path scales, rather than only in the argument.
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/multi-stroke-legacy.txt', import.meta.url))

/**
 * Fourteen layers in the LEGACY single-stroke shape, covering every stroked kind and
 * every branch the painter can take for one:
 *  - rect × centre (default, rounded) / outside / inside
 *  - ellipse × plain, and a fill-less DASHED one
 *  - polygon and star, which delegate to `drawPath`
 *  - path × scale 1 and scale 1.8 (its stroke units are local, not width-normalized)
 *  - text, whose outline comes from `strokeColor` and is drawn with `strokeText`
 *  - line, which has no interior and keeps a single stroke by design
 *  - two layers whose stroke must draw NOTHING ('none' paint, and a zero width)
 *  - a GRADIENT stroke, so `resolvePaint` is exercised through the new call path too.
 *    `type` MUST be 'linear' or 'radial' — `isGradient` in lib/compositor/paint.ts accepts
 *    only those two, and an invented discriminant ('gradient') falls through every branch,
 *    reaches `strokeStyle` as an object, coerces to an invalid value and paints DEFAULT
 *    BLACK. The fixture carried exactly that bug and the gradient branch was never run.
 */
const LEGACY_LAYERS = [
  { kind: 'rect', x: 0.2, y: 0.2, w: 0.2, h: 0.15, fill: '#3b82f6', stroke: '#ff0000', strokeWidth: 0.01, radius: 0.02 },
  { kind: 'rect', x: 0.5, y: 0.2, w: 0.2, h: 0.15, fill: '#f59e0b', stroke: '#000', strokeWidth: 0.012, strokeAlign: 'outside', radius: 0 },
  { kind: 'rect', x: 0.8, y: 0.2, w: 0.15, h: 0.15, fill: '#22c55e', stroke: '#fff', strokeWidth: 0.012, strokeAlign: 'inside', radius: 0.04 },
  { kind: 'ellipse', x: 0.2, y: 0.5, w: 0.18, h: 0.18, fill: '#ef4444', stroke: '#fff', strokeWidth: 0.008 },
  { kind: 'ellipse', x: 0.45, y: 0.5, w: 0.18, h: 0.12, fill: 'none', stroke: '#0ff', strokeWidth: 0.01, strokeDash: { dash: 0.02, gap: 0.012 } },
  { kind: 'polygon', x: 0.7, y: 0.5, w: 0.16, h: 0.16, sides: 6, fill: '#a855f7', stroke: '#fff', strokeWidth: 0.01, cornerRadius: 0 },
  { kind: 'star', x: 0.9, y: 0.5, w: 0.16, h: 0.16, points: 5, innerRatio: 0.5, fill: '#fde047', stroke: '#000', strokeWidth: 0.008, cornerRadius: 0 },
  { kind: 'path', x: 0.25, y: 0.8, d: 'M -0.1 -0.05 L 0.1 -0.05 L 0 0.08 Z', bbox: { w: 0.2, h: 0.13 }, scale: 1, fill: '#06b6d4', fillRule: 'nonzero', stroke: '#fff', strokeWidth: 0.006 },
  { kind: 'path', x: 0.5, y: 0.8, d: 'M -0.1 -0.05 L 0.1 -0.05 L 0 0.08 Z', bbox: { w: 0.2, h: 0.13 }, scale: 1.8, fill: 'none', fillRule: 'nonzero', stroke: '#f0f', strokeWidth: 0.006, strokeAlign: 'outside' },
  { kind: 'text', x: 0.78, y: 0.8, text: 'Edge', fontFamily: 'Inter', fontWeight: 700, fontSize: 0.07, color: '#ffffff', align: 'center', lineHeight: 1.1, strokeColor: '#ff0000', strokeWidth: 0.004 },
  { kind: 'line', x: 0.5, y: 0.95, w: 0.6, stroke: '#fff', strokeWidth: 0.004, strokeDash: { dash: 0.02, gap: 0.01 } },
  { kind: 'rect', x: 0.35, y: 0.35, w: 0.2, h: 0.2, fill: '#111', stroke: 'none', strokeWidth: 0, radius: 0 },
  { kind: 'ellipse', x: 0.6, y: 0.35, w: 0.14, h: 0.14, fill: '#eee', stroke: '#333', strokeWidth: 0 },
  { kind: 'rect', x: 0.1, y: 0.65, w: 0.1, h: 0.1, fill: 'none', stroke: { type: 'linear', stops: [{ color: '#f00', offset: 0 }, { color: '#00f', offset: 1 }], angle: 45 }, strokeWidth: 0.014, radius: 0 },
]

test('every legacy stroked layer renders identically through the stack painter', async ({ page }) => {
  await openCompositor(page)
  await page.evaluate((ls) => (window as any).__compositorSetLayers(
    ls.map((l, i) => ({ ...l, id: `l${i}`, opacity: 1, rotation: 0, visible: true }))), LEGACY_LAYERS)
  const after = await stackPixels(page)
  expect(after).toBeTruthy()

  // The BASELINE is committed alongside this test, captured once by running it against the
  // PRE-STACK painter (`git show 81b71e4ec:frontend/app/composables/useCompositorLayers.ts`).
  // Regenerating it is a deliberate act, never a fix for a red run: a red run here means
  // the refactor moved a pixel in someone's saved frame, and that is the finding.
  if (!existsSync(FIXTURE)) {
    mkdirSync(dirname(FIXTURE), { recursive: true })
    writeFileSync(FIXTURE, `${after}\n`, 'utf8')
    throw new Error(`Baseline written to ${FIXTURE}. Re-run to compare against it.`)
  }
  const baseline = readFileSync(FIXTURE, 'utf8').trim()
  expect(after).toBe(baseline)
})
