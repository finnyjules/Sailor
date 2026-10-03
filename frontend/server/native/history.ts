/**
 * GET /history, served from Sailor's own records (step 3, R10.8).
 *
 * The app's /history readers (Assets, Recent projects, the queue panel, an
 * asset's details) read ComfyUI's history shape. Sailor now answers it from:
 *   - the runner's run records (server/runner/store.ts): one entry per
 *     finished stage, keyed by its stage key — the promptId the runner's
 *     generation records and run events use;
 *   - locally, the disk cache of earlier engine entries (.cache/history.json);
 *   - locally, the engine itself, only while it is up — the one kind of run it
 *     still makes is decision 4's local-only run (shared/runner/localOnly.ts).
 * Hosted reads the caller's own runs only, and never the engine or the cache
 * (a shared, cross-tenant file).
 */
import type { OutputFile, RunRecord, StageCharge, TakeRecord } from '../runner/types'
import { runIdOf, type RunStore } from '../runner/store'

/** The most recent runs read for one /history answer. */
export const HISTORY_RUN_LIMIT = 200

const VIDEO_RE = /\.(mp4|webm|mov|avi|mkv|m4v)$/i
const AUDIO_RE = /\.(mp3|wav|flac|ogg|m4a|aac|opus)$/i

export interface HistoryEntry {
  prompt: [number, string, Record<string, { class_type: string; inputs: Record<string, never> }>, Record<string, unknown>, string[]]
  outputs: Record<string, { images?: OutputFile[]; gifs?: OutputFile[]; audio?: OutputFile[] }>
  status: { status_str: 'success' | 'error'; completed: boolean; messages: [string, { prompt_id: string; timestamp: number }][] }
  meta: Record<string, never>
}

function stageNodeIds(take: TakeRecord, charge: StageCharge): string[] {
  const planned = charge.nodeIds ? new Set(charge.nodeIds) : null
  return Object.entries(take.nodes)
    .filter(([id, n]) => n.leg === charge.leg && (!planned || planned.has(id)))
    .map(([id]) => id)
}

const fileKey = (f: OutputFile) => `${f.type}:${f.subfolder}:${f.filename}`

/**
 * One run's finished stages as ComfyUI history entries. A stage lists the
 * output files its nodes made new (not a reused result, not a file an
 * earlier stage of the run already listed), as the runner's own generation
 * records do; a stage that made none is still listed, with its status.
 */
export function runHistoryEntries(run: RunRecord): Record<string, HistoryEntry> {
  const out: Record<string, HistoryEntry> = {}
  const listed = new Set<string>()
  const charges = [...run.charges].filter(c => c.finished).sort((a, b) => a.leg - b.leg || a.take - b.take)
  for (const charge of charges) {
    const take = run.takes.find(t => t.index === charge.take)
    const leg = run.legs.find(l => l.index === charge.leg)
    if (!take || !leg) continue
    const ids = stageNodeIds(take, charge)
    const nodes = ids.map(id => [id, take.nodes[id]!] as const)
    const outcome = nodes.some(([, n]) => n.status === 'stopped') ? 'stopped'
      : nodes.some(([, n]) => n.status === 'error') ? 'error'
        : nodes.some(([, n]) => n.status === 'paused') ? 'paused' : 'done'

    const outputs: HistoryEntry['outputs'] = {}
    for (const [id, n] of nodes) {
      if (n.status !== 'done' || n.reused) continue
      for (const f of n.outputs ?? []) {
        if (f.type !== 'output' || listed.has(fileKey(f))) continue
        listed.add(fileKey(f))
        const file: OutputFile = { filename: f.filename, subfolder: f.subfolder ?? '', type: 'output' }
        const slot = outputs[id] ??= {}
        const key = VIDEO_RE.test(f.filename) ? 'gifs' : AUDIO_RE.test(f.filename) ? 'audio' : 'images'
        ;(slot[key] ??= []).push(file)
      }
    }

    const stageKey = charge.stageKey
    const started = leg.startedAt ?? run.createdAt
    const ended = leg.endedAt ?? Math.max(started, ...nodes.map(([, n]) => n.endedAt ?? 0))
    const endWord = outcome === 'done' || outcome === 'paused' ? 'execution_success' : outcome === 'stopped' ? 'execution_interrupted' : 'execution_error'
    const prompt: HistoryEntry['prompt'][2] = {}
    for (const [id, n] of nodes) prompt[id] = { class_type: n.classType, inputs: {} }
    out[stageKey] = {
      prompt: [
        charge.leg,
        stageKey,
        prompt,
        run.projectUuid ? { extra_pnginfo: { workflow: { extra: { projectUuid: run.projectUuid } } } } : {},
        Object.keys(outputs),
      ],
      outputs,
      status: {
        status_str: outcome === 'done' || outcome === 'paused' ? 'success' : 'error',
        completed: outcome === 'done',
        messages: [
          ['execution_start', { prompt_id: stageKey, timestamp: started }],
          [endWord, { prompt_id: stageKey, timestamp: ended }],
        ],
      },
      meta: {},
    }
  }
  return out
}

/** The caller's most recent runs, as history entries (local: the local runs, user null). */
export async function runnerHistory(store: RunStore, userId: string | null): Promise<Record<string, HistoryEntry>> {
  const runs = (await store.listForUser(userId))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, HISTORY_RUN_LIMIT)
  const out: Record<string, HistoryEntry> = Object.create(null)
  for (const run of runs.reverse()) Object.assign(out, runHistoryEntries(run))
  return out
}

/**
 * One runner stage's entry, `{ [promptId]: entry }`, or null when the id is
 * not the caller's runner stage (not a runner id, someone else's run, or a
 * stage that hasn't finished).
 */
export async function runnerHistoryEntry(store: RunStore, userId: string | null, promptId: string): Promise<Record<string, HistoryEntry> | null> {
  const runId = runIdOf(promptId)
  if (!runId) return null
  const run = await store.get(runId)
  if (!run || run.userId !== userId) return null
  const entry = runHistoryEntries(run)[promptId]
  return entry ? { [promptId]: entry } : null
}
