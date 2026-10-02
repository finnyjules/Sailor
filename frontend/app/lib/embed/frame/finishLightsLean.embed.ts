/**
 * `frame-lean` build only: stands in for ~/lib/compositor/finishLights (vite.embed.config.ts's
 * frameLeanStubsPlugin). Foil and Spot UV lit by the Frame's light layers, and the painter state
 * that goes with them, are not in the lean bundle; a Frame with a visible light and a foil /
 * `spot_uv` is routed to `frame.js` (`frameNeedsFullBundle`). Everything here is a no-op, so the
 * painter falls back to the hidden light.
 */
import { leanFeatureUsed } from './leanStub.embed'

export type FinishLights = { lights: unknown[]; lighting: unknown }
export type FinishScope = null

export function applyFinishLit(..._args: unknown[]): boolean {
  leanFeatureUsed('Print finishes under lights')
  return false
}
export function currentFinishLights(): FinishLights | null { return null }
export function enterFinishScope(): FinishScope { return null }
export function leaveFinishScope(_prev: FinishScope): void {}
export function lightFinishes(..._args: unknown[]): void {}
export function spotUvLitOnce(_layer: unknown): boolean { return false }
export function armSelfLit(_a: boolean): void {}
export function clearSelfLit(): void {}
export function takeSelfLit(): HTMLCanvasElement | null { return null }
export function selfLitStamp(_c: unknown, sig: string | null): { sig: string | null; draw: null } { return { sig, draw: null } }
export function recordSelfLit(..._args: unknown[]): void {}
export function eraseSelfLit(..._args: unknown[]): void {}
export function punchSelfLit(..._args: unknown[]): void {}
