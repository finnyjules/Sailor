/**
 * The runner writes one generation-history record per finished stage, with
 * the exact charge, into the project's store — the file behind
 * /sailor/projects/{uuid}/generations, written natively (server/native). The
 * browser sees `recorded: true` on the finish event and does not save its own
 * copy.
 */
import { isSafeProjectId } from '../utils/engineGate'
import type { StageRecordSummary } from './engine'

const VIDEO_RE = /\.(mp4|webm|mov|m4v)$/i

export function toGenerationRecord(s: StageRecordSummary, hosted: boolean): Record<string, unknown> {
  return {
    promptId: s.charge.stageKey,
    runId: s.run.id,
    ts: s.ts,
    canvasId: s.run.canvasId,
    outputs: s.outputs.map(o => ({ kind: VIDEO_RE.test(o.filename) ? 'video' : 'image', ...o })),
    usd: null,
    usdApproximate: false,
    credits: hosted ? (s.charge.actual ?? null) : null,
    nodes: s.nodeTypes,
  }
}

export function createGenerationRecords(d: {
  hosted(): boolean
  ownerOf(kind: string, id: string): Promise<string | null>
  recordOwner(kind: string, id: string, userId: string): Promise<void>
  post(uuid: string, body: unknown): Promise<void>
}) {
  return {
    async write(s: StageRecordSummary): Promise<void> {
      const uuid = s.run.projectUuid
      if (!uuid || !isSafeProjectId(uuid)) return
      if (d.hosted()) {
        const userId = s.run.userId
        if (!userId) return
        const owner = await d.ownerOf('project', uuid)
        if (owner && owner !== userId) return
        if (!owner) await d.recordOwner('project', uuid, userId)
      }
      await d.post(uuid, { projectName: s.run.projectName ?? undefined, generation: toGenerationRecord(s, d.hosted()) })
    },
  }
}
