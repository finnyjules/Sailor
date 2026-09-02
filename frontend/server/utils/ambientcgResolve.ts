/**
 * Plain phrase → one ambientCG set id, deterministically. Pure over the slim catalog
 * so it is unit-testable without the network.
 *
 * 1. Exact id (with or without the `ambientcg:` prefix, any case).
 * 2. Every word of the phrase (after synonym expansion) scored against tags + category;
 *    most matching words wins, ties broken by popularity.
 * 3. No word matched → null. Never throws.
 */
import type { AmbientcgSet } from './ambientcgCatalog'
import { SYNONYMS } from './ambientcgSynonyms'

export const TEXTURE_ID_PREFIX = 'ambientcg:'

function words(phrase: string): string[] {
  const raw = phrase.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  const out = new Set<string>()
  for (const w of raw) {
    out.add(w)
    for (const s of SYNONYMS[w] ?? []) out.add(s)
  }
  return [...out]
}

export function resolveTexturePhrase(phrase: string, sets: AmbientcgSet[]): { id: string; name: string } | null {
  const trimmed = (phrase ?? '').trim()
  if (!trimmed) return null

  const bare = trimmed.toLowerCase().startsWith(TEXTURE_ID_PREFIX) ? trimmed.slice(TEXTURE_ID_PREFIX.length) : trimmed
  const exact = sets.find(s => s.id.toLowerCase() === bare.toLowerCase())
  if (exact) return { id: TEXTURE_ID_PREFIX + exact.id, name: exact.name }

  const ws = words(trimmed)
  if (!ws.length) return null
  let best: AmbientcgSet | null = null
  let bestScore = 0
  for (const s of sets) {
    const hay = new Set([...s.tags, s.category.toLowerCase()])
    let score = 0
    for (const w of ws) if (hay.has(w)) score++
    if (score === 0) continue
    if (score > bestScore || (score === bestScore && best && s.popularity > best.popularity)) {
      best = s
      bestScore = score
    }
  }
  return best ? { id: TEXTURE_ID_PREFIX + best.id, name: best.name } : null
}
