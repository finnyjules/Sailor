/**
 * Nested players: a Frame export can carry a studio's own embed player (Space Type, Gradient) for
 * a wired layer, instead of pre-rendered frames. The Frame player mounts each one in a detached
 * container and hands its canvas to the painter as the slot's picture.
 *
 * Bundle-safe: the Frame bundle imports this file, so it must never import the app registry
 * (`./surfaces`, which statically pulls in every Space Type effect). Nested players are found by
 * bundle NAME at runtime:
 * - in an exported file, each nested bundle runs before the Frame's and `nestedRegistrationJs`
 *   files the surface it assigned to `__SAILOR_SURFACE__` under `__SAILOR_NESTED__[name]`;
 * - in the app (the poster bake runs the Frame adapter there), `export.ts` registers a loader over
 *   the app registry with `setNestedSurfaceLoader`.
 */
import type { EmbedSurface } from './contract'

export type NestedSurfaceLoader = (bundle: string) => Promise<EmbedSurface | null>

let appLoader: NestedSurfaceLoader | null = null

export function setNestedSurfaceLoader(loader: NestedSurfaceLoader | null): void {
  appLoader = loader
}

/** globalThis.__SAILOR_NESTED__[bundle] (set by the exported file) first, then the app loader. */
export async function resolveNestedSurface(bundle: string): Promise<EmbedSurface | null> {
  const map = (globalThis as { __SAILOR_NESTED__?: Record<string, EmbedSurface | undefined> }).__SAILOR_NESTED__
  const own = map && Object.prototype.hasOwnProperty.call(map, bundle) ? map[bundle] : undefined
  if (own && typeof own.mount === 'function') return own
  return appLoader ? (await appLoader(bundle)) ?? null : null
}

/** The JS appended after a nested bundle in the exported file: files the surface it just
 *  assigned to __SAILOR_SURFACE__ under its bundle name, and clears __SAILOR_SURFACE__ — so the
 *  NEXT bundle's assignment (the Frame's, last) is the one the runtime mounts.
 *  The name is JSON-encoded, with `<`, `>` and the two JS line separators escaped as in
 *  bundle.ts's safeJson, so no name can end the string or the inline <script> block. Starts with
 *  a newline and a semicolon: the bundle before it may end in a line comment or without one. */
export function nestedRegistrationJs(bundle: string): string {
  const key = JSON.stringify(bundle)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
  return `\n;(function(g){var m=g.__SAILOR_NESTED__||(g.__SAILOR_NESTED__={});m[${key}]=g.__SAILOR_SURFACE__;g.__SAILOR_SURFACE__=undefined;})(globalThis);\n`
}

const MIN_LONG = 64
const MAX_LONG = 4096

/** Drawn device size for a nested player: keeps the source aspect, long side in [64, 4096]. */
export function nestedDeviceSize(drawnLongPx: number, srcW: number, srcH: number): { w: number; h: number } {
  const long = Number.isFinite(drawnLongPx) ? Math.min(MAX_LONG, Math.max(MIN_LONG, Math.round(drawnLongPx))) : MIN_LONG
  const sw = srcW > 0 && Number.isFinite(srcW) ? srcW : 1
  const sh = srcH > 0 && Number.isFinite(srcH) ? srcH : 1
  if (sw >= sh) return { w: long, h: Math.max(1, Math.round(long * sh / sw)) }
  return { w: Math.max(1, Math.round(long * sw / sh)), h: long }
}
