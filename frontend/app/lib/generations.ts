/**
 * generations — shared shapes + parsing for durable generation records.
 *
 * One generation record = one completed run (see
 * docs/plans/2026-06-09-durable-generations-and-cost-tracking-design.md).
 * The same output-extraction logic serves three callers: recording at
 * execution_complete (bridge `executed` payloads), reading records back, and
 * parsing legacy /history entries for merge + backfill.
 */

export type GenKind = 'image' | 'video' | 'audio'

export interface GenOutput {
  kind: GenKind; filename: string; subfolder: string; type: string
  /** Content version (the file's etag) for files overwritten in place, e.g.
   *  node snapshots — appended to the URL so a browser cache can't pin an old picture. */
  v?: string
}

export interface GenerationRecord {
  id?: string
  promptId: string
  ts: number
  canvasId?: string | null
  outputs: GenOutput[]
  usd?: number | null
  usdApproximate?: boolean
  credits?: number | null
  nodes?: string[]
}

export function classifyOutput(filename: string): GenKind {
  const f = (filename || '').toLowerCase()
  if (/\.(mp4|webm|mov|avi|mkv|m4v)$/.test(f)) return 'video'
  if (/\.(mp3|wav|flac|ogg|m4a|aac)$/.test(f)) return 'audio'
  return 'image'
}

/** Final saved files from one node's output dict (a bridge `executed` payload
 *  or one entry of a /history `outputs` map). Live-preview temp frames are
 *  skipped — only `type: 'output'` files persist on disk. */
export function extractOutputFiles(output: any): GenOutput[] {
  const out: GenOutput[] = []
  for (const key of ['images', 'gifs', 'audio', 'video']) {
    const arr = output?.[key]
    if (!Array.isArray(arr)) continue
    for (const f of arr) {
      if (!f?.filename || f.type !== 'output') continue
      out.push({ kind: classifyOutput(f.filename), filename: f.filename, subfolder: f.subfolder || '', type: f.type })
    }
  }
  return out
}

/** Parse one completed /history entry into a generation record + the project
 *  uuid it was stamped with (null when the run predates uuid stamping). */
export function historyEntryToRecord(promptId: string, entry: any): { record: GenerationRecord; projectUuid: string | null } | null {
  if (!entry?.status?.completed) return null
  const startMsg = (entry.status?.messages ?? []).find((m: any) => m[0] === 'execution_start')
  const ts = startMsg?.[1]?.timestamp ?? 0
  const prompt = entry.prompt ?? []
  const nodes = prompt[2] ?? {}
  const workflow = prompt[3]?.extra_pnginfo?.workflow ?? {}
  const projectUuid = workflow.extra?.projectUuid || null
  const outputs: GenOutput[] = []
  for (const nodeOut of Object.values(entry.outputs ?? {})) outputs.push(...extractOutputFiles(nodeOut))
  if (!outputs.length) return null
  const classTypes = [...new Set(Object.values(nodes).map((n: any) => n.class_type || ''))].filter(Boolean) as string[]
  return {
    record: { promptId, ts, canvasId: null, outputs, usd: null, usdApproximate: false, credits: null, nodes: classTypes },
    projectUuid,
  }
}
