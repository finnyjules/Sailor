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
 */
export function bundleNameFor(kind: string, config: unknown): string {
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
