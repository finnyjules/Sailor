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

/** A face-check pass's raw findings, kept separate from the record they'll be applied to (Ruling H: split outcome from application, so a re-read record can absorb a concurrent edit). */
export interface CheckOutcome {
  results: CheckResult[]
  noSource: CheckTarget[]
  at: string
}

const isPanelTarget = (t: CheckTarget): t is Extract<CheckTarget, { kind: 'panel' }> => t.kind === 'panel'

/** Pure: stamps an outcome's results (and no-source notes) onto whatever record is passed in. Targets that no longer exist on that record simply don't apply. */
export function applyOutcome(record: CharacterRecord, outcome: CheckOutcome): CharacterRecord {
  let next = applyChecks(record, outcome.results, outcome.at)
  if (outcome.noSource.length) {
    const note = (t: CheckTarget) => ({ verdict: 'no-face' as const, against: t.against, at: outcome.at, note: NO_SOURCE_NOTE })
    const photoSet = new Map(outcome.noSource.filter(t => t.kind === 'photo').map(t => [t.filename, t]))
    const panelSet = new Map(outcome.noSource.filter(isPanelTarget).map(t => [`${t.stateId}\u0000${t.slot}`, t]))
    next = {
      ...next,
      photos: next.photos.map(p => (photoSet.has(p.filename) ? { ...p, check: note(photoSet.get(p.filename)!) } : p)),
      states: next.states.map(s => ({
        ...s,
        panels: s.panels.map((p) => { const t = panelSet.get(`${s.id}\u0000${p.slot}`); return t ? { ...p, check: note(t) } : p }),
      })),
    }
  }
  return next
}

export async function runChecks(record: CharacterRecord, deps: RunDeps) {
  const plan = planChecks(record)
  const batch = plan.slice(0, MAX_COMPARES_PER_CALL)
  const skipped = plan.length - batch.length
  const faces = new Map<string, Buffer | null | 'no-face'>()
  const results: CheckResult[] = []
  const noSource: CheckTarget[] = []
  let compared = 0
  let failed = false

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
      // Ruling I: an unexpected error stops the pass but keeps what we already
      // have — the caller writes the partial outcome and reports `failed`.
      console.warn('[faceCheck] compare failed, stopping the pass early', e)
      failed = true
      break
    }
  }

  const outcome: CheckOutcome = { results, noSource, at: deps.now() }
  const next = applyOutcome(record, outcome)
  return failed
    ? { record: next, outcome, compared, skipped, failed: true as const }
    : { record: next, outcome, compared, skipped }
}
