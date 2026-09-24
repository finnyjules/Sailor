/**
 * The Frame web export sheet's wired-clip cache. Every change while the sheet is open rebuilds
 * the file (Fit, Transparent, an edit), and a wired clip is the expensive part of a build — a
 * fresh 3D engine, or 180 Space Type frames. A clip depends only on its slot, its frame count,
 * its size and what its source draws, so a rebuild that changed none of those reuses the frames
 * it already has. The Frame editor keeps one while the sheet is open and clears it on close.
 *
 * Only a complete pull is kept: a pull that named failures, threw or was abandoned is asked
 * again next build. Pure — the editor supplies the pull and the source's change signal.
 */
import type { WiredFrames } from './gather'

export interface WiredClipKey {
  slot: number
  count: number
  maxPx: number
  /** The slot's live source. A different object (re-wired, re-registered) never hits. */
  source: object | undefined
  /** What the source draws, as a string that changes when it does (its node's saved state). */
  signal: string
}

export interface WiredClipCache {
  /** The frames for `key`: kept ones when nothing about the clip changed, else `pull()`'s. */
  get(key: WiredClipKey, pull: () => Promise<WiredFrames>): Promise<WiredFrames>
  clear(): void
  readonly size: number
}

export function createWiredClipCache(): WiredClipCache {
  const bySlot = new Map<number, { key: WiredClipKey; frames: string[] }>()
  const same = (a: WiredClipKey, b: WiredClipKey) =>
    a.count === b.count && a.maxPx === b.maxPx && a.source === b.source && a.signal === b.signal
  return {
    async get(key, pull) {
      const hit = bySlot.get(key.slot)
      if (hit && same(hit.key, key)) return { frames: hit.frames, failures: [] }
      const got = await pull()
      if (!got.failures.length && got.frames.length === key.count) bySlot.set(key.slot, { key, frames: got.frames })
      return got
    },
    clear() { bySlot.clear() },
    get size() { return bySlot.size },
  }
}
