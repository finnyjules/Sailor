/**
 * `frame-lean` build only: stands in for ~/lib/compositor/finishLights (vite.embed.config.ts's
 * frameLeanStubsPlugin). Foil and Spot UV lit by the Frame's light layers, and the painter state
 * that goes with them, are not in the lean bundle; a Frame with a visible light and a foil /
 * `spot_uv` is routed to `frame.js` (`frameNeedsFullBundle`). Everything here is a no-op, so the
 * painter falls back to the hidden light — except a routing miss is reported: inside a paint with a
 * visible light (`lightFinishes`, with the real module's guard), `currentFinishLights()` answers
 * non-null, so a foil / Spot UV draw reaches `applyFinishLit`, which says so and answers false.
 */
import { leanFeatureUsed } from './leanStub.embed'
import { visibleLights } from '~/lib/frame/lighting/settings'

export type FinishLights = { lights: unknown[]; lighting: unknown }
export type FinishScope = boolean

/** Set by `lightFinishes` (a paint with a visible light), scoped like the real module's state. */
let _lit = false
const LIT: FinishLights = { lights: [], lighting: null }

export function applyFinishLit(..._args: unknown[]): boolean {
  leanFeatureUsed('Print finishes under lights')
  return false
}
export function currentFinishLights(): FinishLights | null { return _lit ? LIT : null }
export function enterFinishScope(): FinishScope { const prev = _lit; _lit = false; return prev }
export function leaveFinishScope(prev: FinishScope): void { _lit = prev }
/** The real guard (already in this bundle: the painter imports `visibleLights`). */
export function lightFinishes(layers: Parameters<typeof visibleLights>[0], groups: Parameters<typeof visibleLights>[1]): void {
  if (visibleLights(layers, groups).length) _lit = true
}
export function spotUvLitOnce(_layer: unknown): boolean { return false }
export function spotUvCoatSelfLit(_layer: unknown): boolean { return false }
export function armSelfLit(_a: boolean): void {}
export function clearSelfLit(): void {}
export function takeSelfLit(): HTMLCanvasElement | null { return null }
export function selfLitStamp(_c: unknown, sig: string | null): { sig: string | null; draw: null } { return { sig, draw: null } }
export function recordSelfLit(..._args: unknown[]): void {}
export function eraseSelfLit(..._args: unknown[]): void {}
export function eraseSelfLitUnder(_src: unknown): void {}
export function punchSelfLit(..._args: unknown[]): void {}
