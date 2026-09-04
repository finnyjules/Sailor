import { anchorOne, anchorTwo, applyVariation, type CorpusEntry } from './anchor'
import { composedFamilies } from './composed'
import { facetsOf, matchesCharacter, meanPairwiseLab, type PaletteFamily, type Character } from './seedFamily'

export interface SeedRequest {
  seedA: string
  seedB?: string | null
  char?: Character
  page?: number
  variation?: number
  source?: 'both' | 'curated' | 'composed'
}

const CURATED_DEDUPE = 0.045
const COMPOSED_DEDUPE = 0.02

export function curatedFamilies(corpus: CorpusEntry[], req: SeedRequest): PaletteFamily[] {
  const { seedA, seedB = null, char = 'any', variation = 0, page = 0 } = req
  const out: PaletteFamily[] = []
  for (const entry of corpus) {
    if (seedB && entry.c.length < 2) continue
    const a = seedB ? anchorTwo(entry, seedA, seedB) : anchorOne(entry, seedA)
    const anchorIdxs = 'anchorIdxs' in a ? a.anchorIdxs : [a.anchorIdx]
    let hexes = applyVariation(a.hexes, anchorIdxs, variation, seedA + (seedB || '') + ':' + entry.c.join('') + ':' + page)
    const f = facetsOf(hexes)
    if (!matchesCharacter(f, char)) continue
    out.push({ hexes, anchorIdxs, source: 'curated', sourceTag: entry.s, warp: a.warp })
  }
  out.sort((x, y) => x.warp - y.warp)
  return out
}

export function assembleShelf(corpus: CorpusEntry[], req: SeedRequest, size = 12): PaletteFamily[] {
  const source = req.source ?? 'both'
  const page = req.page ?? 0
  const curQuota = source === 'composed' ? 0 : source === 'curated' ? size : Math.ceil(size / 2) + 1
  const genQuota = size - curQuota

  const pickedSigs: string[][] = []
  const isDupe = (sig: string[], thresh: number) => pickedSigs.some(p => meanPairwiseLab(sig, p) < thresh)

  // curated, warp-ranked, page-skipped, deduped
  const curated: PaletteFamily[] = []
  const ranked = curQuota > 0 ? curatedFamilies(corpus, req) : []
  const skip = page * curQuota
  let skipped = 0
  for (const fam of ranked) {
    if (isDupe(fam.hexes, CURATED_DEDUPE)) continue
    if (skipped < skip) { skipped++; pickedSigs.push(fam.hexes); continue }
    pickedSigs.push(fam.hexes); curated.push(fam)
    if (curated.length >= curQuota) break
  }

  // composed, tighter dedupe
  const composed: PaletteFamily[] = []
  if (genQuota > 0) {
    for (const fam of composedFamilies(req.seedA, req.seedB ?? null, req.char ?? 'any', page, genQuota * 3)) {
      const v = applyVariation(fam.hexes, fam.anchorIdxs, req.variation ?? 0, 'genv:' + fam.recipe + page)
      const fam2 = { ...fam, hexes: v }
      if (composed.some(c => meanPairwiseLab(fam2.hexes, c.hexes) < COMPOSED_DEDUPE)) continue
      composed.push(fam2)
      if (composed.length >= genQuota) break
    }
  }

  // weave alternately
  const shelf: PaletteFamily[] = []
  const cur = [...curated], gen = [...composed]
  for (let i = 0; i < size; i++) {
    const next = i % 2 === 0 ? (cur.shift() ?? gen.shift()) : (gen.shift() ?? cur.shift())
    if (next) shelf.push(next)
  }
  return shelf
}

let corpusCache: CorpusEntry[] | null = null
export async function loadCorpus(): Promise<CorpusEntry[]> {
  if (corpusCache) return corpusCache
  const res = await fetch('/data/palette-corpus.json')
  corpusCache = (await res.json()) as CorpusEntry[]
  return corpusCache
}

export async function seedShelf(req: SeedRequest, size = 12): Promise<PaletteFamily[]> {
  return assembleShelf(await loadCorpus(), req, size)
}
