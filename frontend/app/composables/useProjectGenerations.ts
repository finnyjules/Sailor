import { ref } from 'vue'
import { historyEntryToRecord, type GenKind } from '~/lib/generations'
import { isRunnerPromptId } from '#shared/runner/messages'

// Every saved generation in a project, grouped by project. Unlike
// useRecentProjects (which caps at 3 images for the home cards), this keeps the
// FULL list — each completed /history run is one generation ("take"), so this
// is the durable record of everything a project has produced. Used by the
// Assets panel.

export interface GenAsset {
  kind: 'image' | 'video' | 'audio'
  filename: string
  subfolder: string
  type: string // 'output' | 'temp' | 'input'
  promptId: string
  timestamp: number
  usd?: number | null
}

export interface ProjectGenerations {
  workflowId: string
  name: string
  generations: GenAsset[] // newest first
  lastTimestamp: number
}

const generationsByProject = ref<ProjectGenerations[]>([])
const loading = ref(false)
let fetchedOnce = false

// Mirror of useRecentProjects' name derivation so projects read the same way.
function deriveProjectName(classTypes: string[]): string {
  const ignore = new Set(['PreviewImage', 'SaveImage', 'LoadImage', 'LoadCheckpoint', 'CLIPTextEncode', 'KSampler', 'VAEDecode', 'VAELoader', 'CLIPLoader'])
  const meaningful = classTypes.filter((t) => !ignore.has(t))
  if (meaningful.length > 0) {
    return meaningful[0]!.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
  }
  return classTypes[0]?.replace(/([a-z])([A-Z])/g, '$1 $2') || 'Workflow'
}

function getSavedNames(): Record<string, string> {
  if (import.meta.server) return {}
  try { return JSON.parse(localStorage.getItem('sailor:project-names') || '{}') }
  catch { return {} }
}

export function useProjectGenerations() {
  function viewUrl(a: { filename: string; subfolder: string; type: string }): string {
    const params = new URLSearchParams({ filename: a.filename, type: a.type || 'output' })
    if (a.subfolder) params.set('subfolder', a.subfolder)
    return `/view?${params}`
  }

  async function fetchGenerations(force = false) {
    if (!force && fetchedOnce && generationsByProject.value.length) return
    loading.value = true
    try {
      const savedNames = getSavedNames()
      const groups = new Map<string, ProjectGenerations>()
      const recordedPromptIds = new Set<string>()

      // 1) Durable records — survive ComfyUI restarts; carry per-run cost.
      const { listProjects, listGenerations } = useProjects()
      const durable = await listProjects()
      await Promise.all(durable.map(async (p) => {
        const gens = await listGenerations(p.uuid)
        const assets: GenAsset[] = []
        for (const g of gens) {
          if (g.promptId) recordedPromptIds.add(g.promptId)
          for (const o of g.outputs || []) {
            // Hide only live-preview temp frames. Real outputs ('output') and
            // frontend-tool assets saved to input/ (Space Type, Gradient Studio)
            // both count as the project's assets.
            if (o.type === 'temp') continue
            assets.push({ ...o, promptId: g.promptId, timestamp: g.ts, usd: g.usd ?? null })
          }
        }
        if (!assets.length) return
        groups.set(p.uuid, {
          workflowId: p.uuid,
          name: p.name || savedNames[p.uuid] || 'Untitled project',
          generations: assets,
          lastTimestamp: assets[0]?.timestamp || p.updatedAt || 0,
        })
      }))

      // 2) Merge runs only the live /history knows about (not yet recorded,
      // or pre-durable projects). History dies on server restart — that's
      // exactly the gap the durable pass above closes.
      try {
        const res = await fetch('/history')
        const data = (await res.json()) as Record<string, any>
        for (const [promptId, entry] of Object.entries(data)) {
          // A runner stage is in the durable records already (the runner writes them, R10.8).
          if (recordedPromptIds.has(promptId) || isRunnerPromptId(promptId)) continue
          const parsed = historyEntryToRecord(promptId, entry)
          if (!parsed) continue
          const e = entry as any
          const nodes = (e.prompt ?? [])[2] ?? {}
          const classTypes = [...new Set(Object.values(nodes).map((n: any) => n.class_type || ''))] as string[]
          const workflowId = parsed.projectUuid
            || classTypes.filter(Boolean).sort().join(',')
          let g = groups.get(workflowId)
          if (!g) {
            g = {
              workflowId,
              name: savedNames[workflowId] || deriveProjectName(classTypes),
              generations: [],
              lastTimestamp: parsed.record.ts,
            }
            groups.set(workflowId, g)
          }
          for (const o of parsed.record.outputs) {
            g.generations.push({ ...o, promptId, timestamp: parsed.record.ts, usd: null })
          }
        }
      } catch { /* history unreachable — durable list stands alone */ }

      for (const g of groups.values()) {
        g.generations.sort((a, b) => b.timestamp - a.timestamp)
        g.lastTimestamp = g.generations[0]?.timestamp ?? g.lastTimestamp
      }
      generationsByProject.value = [...groups.values()].sort((a, b) => b.lastTimestamp - a.lastTimestamp)
      fetchedOnce = true
    }
    catch (err) {
      console.error('[useProjectGenerations] fetch failed:', err)
    }
    finally {
      loading.value = false
    }
  }

  function refresh() { fetchGenerations(true) }

  /** Record a frontend-tool output (Space Type / Gradient Studio) as one of the
   *  project's generations so it shows in the Assets panel, then refresh. The file
   *  lives in input/, so it's saved with type:'input'. */
  async function recordAsset(projectUuid: string | null | undefined, kind: GenKind, filename: string) {
    if (!projectUuid || !filename) return
    const { saveGeneration } = useProjects()
    await saveGeneration(projectUuid, {
      promptId: `studio-${crypto.randomUUID()}`,
      ts: Date.now(),
      outputs: [{ kind, filename, subfolder: '', type: 'input' }],
      nodes: [],
    })
    refresh()
  }

  return { generationsByProject, loading, fetchGenerations, refresh, recordAsset, viewUrl }
}
