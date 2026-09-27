/** Orchestrates one face-check pass over a character, IO injected (route builds the real deps). */
import type { CharacterRecord, CheckVerdict } from '#shared/characters/types'
import { applyChecks, planChecks, type CheckResult, type CheckTarget } from './plan'
import { FaceCheckError } from './rekognition'

export const MAX_COMPARES_PER_CALL = 40

export interface RunDeps {
  readImage(filename: string): Promise<Buffer | null>
  compare(source: Buffer, target: Buffer): Promise<number | null | { verdict: CheckVerdict; note?: string }>
  now(): string
}

const NO_SOURCE_NOTE = 'No face found in the approved face picture'

export async function runChecks(record: CharacterRecord, deps: RunDeps) {
  const plan = planChecks(record)
  const batch = plan.slice(0, MAX_COMPARES_PER_CALL)
  const skipped = plan.length - batch.length
  const faces = new Map<string, Buffer | null | 'no-face'>()
  const results: CheckResult[] = []
  const noSource: CheckTarget[] = []
  let compared = 0

  for (const target of batch) {
    if (!faces.has(target.against)) faces.set(target.against, await deps.readImage(target.against))
    const face = faces.get(target.against)
    if (face === 'no-face') { noSource.push(target); continue }
    if (!face) continue
    const img = await deps.readImage(target.filename)
    if (!img) continue
    try {
      const r = await deps.compare(face, img)
      results.push(typeof r === 'object' && r !== null ? { target, score: null, verdict: r.verdict, note: r.note } : { target, score: r })
      compared++
    } catch (e) {
      if (e instanceof FaceCheckError && e.code === 'no-source-face') {
        faces.set(target.against, 'no-face')
        noSource.push(target)
        continue
      }
      throw e
    }
  }

  const now = deps.now()
  let next = applyChecks(record, results, now)
  if (noSource.length) {
    const note = (t: CheckTarget) => ({ verdict: 'no-face' as const, against: t.against, at: now, note: NO_SOURCE_NOTE })
    const photoSet = new Map(noSource.filter(t => t.kind === 'photo').map(t => [t.filename, t]))
    const panelSet = new Map(noSource.filter(t => t.kind === 'panel').map(t => [`${(t as any).stateId}\u0000${(t as any).slot}`, t]))
    next = {
      ...next,
      photos: next.photos.map(p => (photoSet.has(p.filename) ? { ...p, check: note(photoSet.get(p.filename)!) } : p)),
      states: next.states.map(s => ({
        ...s,
        panels: s.panels.map((p) => { const t = panelSet.get(`${s.id}\u0000${p.slot}`); return t ? { ...p, check: note(t) } : p }),
      })),
    }
  }
  return { record: next, compared, skipped }
}
