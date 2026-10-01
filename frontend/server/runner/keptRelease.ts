/**
 * Letting go of kept frame batches and sounds (step 3, R6 ruling (j)). A run
 * keeps every batch and sound it makes until it ends, which fills the hosted
 * run's 4 GiB after a few effects on a long clip. So a batch or sound is let
 * go as soon as every node that reads it has finished:
 *
 *   - `spentKeptMedia`: the kept `.mkv` and `.wav` files named by the run's
 *     values (a `frames` value, a made video's frames and sound, a sound) of
 *     which every holder's readers are done. A holder is any node whose value
 *     names the file (its maker, and a Gate, Create video, a card or an effect
 *     that hands it on); the same bytes made twice are one file, so every
 *     holder across the run's takes is counted. A file nothing reads goes as
 *     soon as its holders are done.
 *   - The engine removes each (KeptBytes.release) and writes its name on
 *     every holder's record (`released`).
 *   - `reviveReleased`: a restart (or a later leg) that needs a released value
 *     runs its maker again (free, and the same bytes: every such result is a
 *     function of its inputs and widgets, seeds included), and every holder on
 *     the way.
 *
 * Only while a maker of such files is running is nothing let go: it could be
 * writing a file with the very same bytes (kept once, by their sha256). The
 * next finish lets them go.
 */
import { linksOf, type ApiPrompt } from '#shared/runner/graph'
import { MEDIA_EFFECT_FAMILY_OF } from '#shared/runner/mediaEffects'
import type { NodeRecord, OutputFile, RunRecord, RunnerValue, TakeRecord } from './types'
import { filesOf, slotValue } from './values'
import { LOCAL_MODEL_FAMILY_OF } from '#shared/runner/localModels'

/** The classes that keep frame batches or sounds of their own as they run (R5, R6). */
export const KEPT_MEDIA_MAKERS: ReadonlySet<string> = new Set([
  'GetVideoComponents', 'LoadVideoFrames', 'SaveVideo', 'Video', 'Audio',
  ...Object.keys(MEDIA_EFFECT_FAMILY_OF),
  // R7 (ruling (f)): the local-model picture nodes keep a clip's batch of their own.
  ...Object.keys(LOCAL_MODEL_FAMILY_OF),
])

const FINISHED_BADLY: ReadonlySet<string> = new Set(['error', 'skipped', 'stopped', 'dropped'])

/** A value's kept batch or sound files (never an asset or a person's file). */
function keptMediaOf(v: RunnerValue | undefined): OutputFile[] {
  if (!v) return []
  if (v.kind !== 'frames' && v.kind !== 'video' && !(v.kind === 'files' && v.sound)) return []
  return filesOf(v).filter(f => f.type === 'kept' && /\.(?:mkv|wav)$/.test(f.filename))
}

const keyOf = (f: OutputFile) => `${f.subfolder}/${f.filename}`

/** Every node of the prompt reading (id, slot). */
function readersOf(prompt: ApiPrompt, id: string, slot: number): string[] {
  const out: string[] = []
  for (const [rid, n] of Object.entries(prompt)) if (linksOf(n).some(l => l.from === id && l.slot === slot)) out.push(rid)
  return out
}

/**
 * The run's kept batches and sounds that no node will read any more, each
 * with the records that hold it (and don't have it marked released yet).
 * Empty while a maker of such files is running.
 */
export function spentKeptMedia(run: RunRecord): { file: OutputFile; holders: NodeRecord[] }[] {
  for (const t of run.takes) {
    for (const n of Object.values(t.nodes)) if (n.status === 'running' && KEPT_MEDIA_MAKERS.has(n.classType)) return []
  }
  const uses = new Map<string, { file: OutputFile; holders: NodeRecord[]; spent: boolean }>()
  for (const t of run.takes) {
    for (const [id, rec] of Object.entries(t.nodes)) {
      if (!rec.values) continue
      for (const [slotText, v] of Object.entries(rec.values)) {
        const slot = Number(slotText)
        for (const f of keptMediaOf(v)) {
          const k = keyOf(f)
          let u = uses.get(k)
          if (!u) { u = { file: f, holders: [], spent: true }; uses.set(k, u) }
          u.holders.push(rec)
          // Every reader must be done; one not in the take's records (or not done) keeps it.
          if (rec.status !== 'done' || readersOf(t.prompt, id, slot).some(r => t.nodes[r]?.status !== 'done')) u.spent = false
        }
      }
    }
  }
  return [...uses.values()]
    .filter(u => u.spent && u.holders.some(h => !h.released?.includes(u.file.filename)))
    .map(u => ({ file: u.file, holders: u.holders }))
}

/** Writes a released file's name on its holders' records. */
export function markReleased(file: OutputFile, holders: readonly NodeRecord[]): void {
  for (const h of holders) {
    if (!h.released?.includes(file.filename)) h.released = [...(h.released ?? []), file.filename]
  }
}

/**
 * Before a take's leg runs (a restart, or a later leg): a node still to run
 * that reads a released value has its maker run again, and every holder on
 * the way (a node done whose own input was released is revived too). Returns
 * the revived nodes.
 */
export function reviveReleased(take: TakeRecord): string[] {
  const revived: string[] = []
  let again = true
  while (again) {
    again = false
    for (const [id, n] of Object.entries(take.prompt)) {
      const rec = take.nodes[id]
      if (!rec || rec.status === 'done' || FINISHED_BADLY.has(rec.status)) continue
      for (const l of linksOf(n)) {
        const maker = take.nodes[l.from]
        if (maker?.status !== 'done' || !maker.released?.length) continue
        const names = keptMediaOf(slotValue(maker, l.slot)).map(f => f.filename)
        if (!names.some(name => maker.released!.includes(name))) continue
        maker.status = 'waiting'
        delete maker.released
        revived.push(l.from)
        again = true
      }
    }
  }
  return revived
}
