import type { EmbedSurface } from './contract'
import { SPACE_TYPE_EFFECTS } from '~/lib/spacetype/effects/index'

/**
 * One entry per embeddable surface. This list IS the feature's scope — the same
 * declaration-per-capability shape as shader_effects/manifest.json.
 * Dynamic imports so an embed bundle only ever pulls in its own adapter.
 */
const REGISTRY: Record<string, () => Promise<{ default: EmbedSurface }>> = {
  shader: () => import('./surfaces/shader'),
  gradient: () => import('./surfaces/gradient'),
  spacetype: () => import('./surfaces/spacetype'),
  frame: () => import('./surfaces/frame'),
  frames: () => import('./surfaces/frames'),
}

export function embedSurfaceKinds(): string[] {
  return Object.keys(REGISTRY)
}

export function isEmbeddable(kind: string): boolean {
  return Object.prototype.hasOwnProperty.call(REGISTRY, kind)
}

export async function loadEmbedSurface(kind: string): Promise<EmbedSurface | null> {
  const loader = REGISTRY[kind]
  if (!loader) return null
  return (await loader()).default
}

/**
 * Maps an export request to the built /embed/<name>.js file that should be
 * fetched for it. Lives here — app-side, never bundled into an embed itself
 * (see this file's module doc) — rather than in export.ts, which stays
 * generic across every surface: kind → bundle name is app knowledge, and the
 * one surface where that mapping isn't the identity (spacetype, split into
 * one bundle per effect by vite.embed.config.ts) is exactly the kind of
 * surface-specific fact export.ts must never encode directly.
 *
 * Every other registered kind (shader, gradient, ...) still builds ONE bundle
 * per surface (see vite.embed.config.ts), so its bundle name is just the kind
 * itself — this only branches for the one surface that isn't 1:1.
 *
 * Space Type's config.effectId is validated against SPACE_TYPE_EFFECTS — the
 * SAME array the live app builds its effect list from (effects/index.ts) —
 * rather than a permissive pattern (e.g. rejecting only strings containing
 * "..") for two reasons: (1) an allowlist can't drift from what effects
 * actually exist, so a renamed/removed effect id is caught here too, not just
 * a hostile one, and (2) it closes path traversal as a side effect, for free
 * — an effectId of "../../etc/passwd" simply isn't in the list, so it throws
 * for the same reason "banana" would. Case-insensitive, matching the
 * embed adapter's own effectId lookup in surfaces/spacetype.ts.
 *
 * Frame's `config` (a FrameSnapshot) is the OTHER branch that isn't 1:1 (Task 10): most Frames
 * carry no outlined text and no `boolean`/`shatter`/`morph` geometry effect, so they take the
 * smaller `frame-lean.js` (no paper.js, no fontkit) — see FrameSnapshot.needsOutlines's doc and
 * gather.ts's computeNeedsOutlines for exactly what forces the full bundle.
 *
 * R14e: 'frame-lean' only on an EXPLICIT `needsOutlines === false` — every other value (`true`,
 * `undefined`, a missing field, a malformed/non-object `config`) falls back to the full 'frame'.
 * Same asymmetric-default posture as the spacetype branch below refusing rather than guessing a
 * default effect: an incomplete or unexpected config is a reason to take the SAFE (full) bundle,
 * never the lean one — the failure mode a permissive `needsOutlines ? 'frame' : 'frame-lean'`
 * would have (silently picking lean for anything falsy, missing field included) is exactly the
 * "still Frame draws unclipped" bug this whole fix round exists to close.
 */
export function bundleNameFor(kind: string, config: unknown): string {
  if (kind === 'frame') {
    const needsOutlines = (config as { needsOutlines?: unknown } | null | undefined)?.needsOutlines
    return needsOutlines === false ? 'frame-lean' : 'frame'
  }
  if (kind !== 'spacetype') return kind

  const effectId = (config as { effectId?: unknown } | null | undefined)?.effectId
  if (typeof effectId !== 'string' || effectId.length === 0) {
    throw new Error('embed: spacetype config has no effectId')
  }
  const lower = effectId.toLowerCase()
  const effect = SPACE_TYPE_EFFECTS.find(e => e.id.toLowerCase() === lower)
  if (!effect) {
    // Never fall back to a generic/default bundle here — that would silently
    // export a piece rendered by the wrong effect, which is worse than a
    // failed export because nothing signals it happened.
    throw new Error(`embed: unknown spacetype effectId "${effectId}"`)
  }
  return `spacetype-${effect.id}`
}

/**
 * Every bundle an export needs, nested players first, the main bundle last — export.ts
 * concatenates them in this order. For a Frame: one entry per DISTINCT live bundle in
 * `config.wired`, in slot order, each re-derived with bundleNameFor(entry.surface, entry.config) —
 * throws if it differs from entry.bundle (the Frame player resolves the nested player by
 * entry.bundle, so a mismatch would play the wrong effect or none). A live entry must name an
 * embeddable studio other than a Frame: the name becomes a fetched path, and a Frame nested in a
 * Frame would collide with the main bundle.
 */
export function bundleNamesFor(kind: string, config: unknown): string[] {
  const main = bundleNameFor(kind, config)
  if (kind !== 'frame') return [main]
  const wired = (config as { wired?: unknown } | null | undefined)?.wired
  if (!wired || typeof wired !== 'object') return [main]
  const nested: string[] = []
  const slots = Object.keys(wired).sort((a, b) => Number(a) - Number(b))
  for (const slot of slots) {
    const entry = (wired as Record<string, { kind?: unknown; surface?: unknown; bundle?: unknown; config?: unknown }>)[slot]
    if (!entry || entry.kind !== 'live') continue
    const surface = entry.surface
    if (typeof surface !== 'string' || !isEmbeddable(surface) || surface === 'frame') {
      throw new Error(`embed: a live layer names a player that cannot be nested ("${String(surface)}")`)
    }
    const derived = bundleNameFor(surface, entry.config)
    if (derived !== entry.bundle) {
      throw new Error(`embed: a live layer's bundle "${String(entry.bundle)}" is not its config's ("${derived}")`)
    }
    if (!nested.includes(derived)) nested.push(derived)
  }
  return [...nested, main]
}
