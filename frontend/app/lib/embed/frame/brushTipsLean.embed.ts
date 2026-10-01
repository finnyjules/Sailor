/**
 * `frame-lean` build only: stands in for ~/lib/brushTips/coverage (vite.embed.config.ts's
 * frameLeanStubsPlugin). Brush tips (the tip engine, its materials and stroke replay) are not in
 * the lean bundle; a Frame with a tip stroke is routed to `frame.js` (`frameNeedsFullBundle`).
 */
import type { PaintStroke } from '~/lib/compositor/brushStamp'
import { isTipStroke, type TipStroke } from '~/lib/brushTips/record'
import { leanFeatureUsed } from './leanStub.embed'

export function renderTipCoverage(
  _key: string, strokes: (PaintStroke | TipStroke)[], _view: unknown, live?: TipStroke | null,
): { coverage: HTMLCanvasElement; shade: HTMLCanvasElement | null } | null {
  // A brush with only legacy stamps also calls this, and gets null exactly like the real engine.
  if (live || strokes.some(isTipStroke)) leanFeatureUsed('brush tips')
  return null
}
