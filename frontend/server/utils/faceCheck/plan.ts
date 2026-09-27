/**
 * Pure face-check planning for the characters rework (spec: Checks). Decides
 * which pictures need a check and against which face, turns a similarity into
 * a verdict, and writes results back. No IO — the route and the AWS wrapper
 * live elsewhere, so this unit-tests without a network.
 */
import type { CharacterRecord, Check, CheckVerdict, PanelSlot } from '#shared/characters/types'

/** AWS Rekognition similarity, 0–100. Calibrated 2026-09-27 on Jene/Reva/Millie/Vera: same ≥ 94.4, different ≤ 39.1. */
export const FACE_THRESHOLDS = { match: 90, unsure: 65 }

const HEADLESS: ReadonlySet<PanelSlot> = new Set(['body-front', 'body-back'])

export type CheckTarget =
  | { kind: 'photo'; filename: string; against: string }
  | { kind: 'panel'; stateId: string; slot: PanelSlot; filename: string; against: string }

export function faceFor(record: CharacterRecord, stateId: string | null): string | null {
  const look = stateId ? record.states.find(s => s.id === stateId) : undefined
  return look?.face?.filename ?? record.face?.filename ?? null
}

export function planChecks(record: CharacterRecord): CheckTarget[] {
  const out: CheckTarget[] = []
  const recordFace = faceFor(record, null)
  if (recordFace) {
    for (const p of record.photos) {
      if (p.filename === recordFace) continue
      if (!p.check || p.check.against !== recordFace) out.push({ kind: 'photo', filename: p.filename, against: recordFace })
    }
  }
  for (const s of record.states) {
    const face = faceFor(record, s.id)
    if (!face) continue
    for (const p of s.panels) {
      if (HEADLESS.has(p.slot) || p.filename === face) continue
      if (!p.check || p.check.against !== face) out.push({ kind: 'panel', stateId: s.id, slot: p.slot, filename: p.filename, against: face })
    }
  }
  return out
}

export function verdictFor(score: number | null, t = FACE_THRESHOLDS): CheckVerdict {
  if (score === null) return 'no-face'
  if (score >= t.match) return 'match'
  if (score >= t.unsure) return 'unsure'
  return 'different'
}

export interface CheckResult { target: CheckTarget; score: number | null; verdict?: CheckVerdict; note?: string }

export function applyChecks(record: CharacterRecord, results: CheckResult[], now: string): CharacterRecord {
  type R = { score: number | null; against: string; verdict?: CheckVerdict; note?: string; filename?: string }
  const mk = (r: R) => {
    const out: Check = { verdict: r.verdict ?? verdictFor(r.score), against: r.against, at: now }
    if (r.score !== null) out.score = r.score
    if (r.note) out.note = r.note
    return out
  }
  const photoRes = new Map<string, R>()
  const panelRes = new Map<string, R>()
  for (const { target, score, verdict, note } of results) {
    const r: R = { score, against: target.against, verdict, note, filename: target.filename }
    if (target.kind === 'photo') photoRes.set(target.filename, r)
    else panelRes.set(`${target.stateId}\u0000${target.slot}`, r)
  }
  const recordFace = faceFor(record, null)
  const photos = record.photos.map((p) => {
    if (recordFace && p.filename === recordFace) return { ...p, check: mk({ score: 100, against: recordFace }) }
    const r = photoRes.get(p.filename)
    return r ? { ...p, check: mk(r) } : p
  })
  const states = record.states.map((s) => {
    const face = faceFor(record, s.id)
    return {
      ...s,
      panels: s.panels.map((p) => {
        if (face && p.filename === face) return { ...p, check: mk({ score: 100, against: face }) }
        // Ruling L: a panel re-rolled since the check ran holds a new picture — the result isn't about it.
        const r = panelRes.get(`${s.id}\u0000${p.slot}`)
        return r && r.filename === p.filename ? { ...p, check: mk(r) } : p
      }),
    }
  })
  return { ...record, photos, states }
}
