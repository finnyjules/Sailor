import { historyEntryToRecord, type GenOutput } from '~/lib/generations'
import { isRunnerPromptId } from '#shared/runner/messages'
import { buildPreviewImages } from '~/lib/projectCover'
import { createTaskQueue } from '~/lib/coverBackfill'

export interface RecentProject {
  workflowId: string
  name: string
  promptIds: string[] // all prompt IDs for this project (most recent first)
  images: { filename: string; subfolder: string; type: string; v?: string }[] // last 3 images across all runs
  lastTimestamp: number
  runCount: number
  /** Generation thumbnails alone, kept so a new cover can be re-mixed in. */
  rendered?: RecentProject['images']
  /** LC8 (B4): its generation records aren't read yet (read when its card comes into view: observeProjectCard). */
  generationsPending?: boolean
}

/**
 * LC8 (B4): Home read every saved project's generation records at once
 * (about 1,500 fetches); Chromium failed hundreds with ERR_INSUFFICIENT_RESOURCES
 * and those cards lost their pictures. Now at most GENERATIONS_CONCURRENCY
 * are in flight, only the GENERATIONS_EAGER most recently saved projects are
 * read before the list shows, and every other card's are read when it comes
 * into view in the All projects grid.
 */
export const GENERATIONS_CONCURRENCY = 6
export const GENERATIONS_EAGER = 24
const generationsQueue = createTaskQueue(GENERATIONS_CONCURRENCY)
/** Projects whose records were asked for this load (each once). */
let generationsAsked = new Set<string>()
/** Each pending project's cover (re-mixed with its records when they come). */
let pendingCovers = new Map<string, RecentProject['images']>()
/** Runs /history holds for a project whose records aren't read yet: recorded once they are, if missing. */
let pendingHistory = new Map<string, { promptId: string; record: NonNullable<ReturnType<typeof historyEntryToRecord>>['record'] }[]>()

/** Run a task in the shared generations queue (at most GENERATIONS_CONCURRENCY at once). */
function queued<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => generationsQueue.push(() => task().then(resolve, reject)))
}

/** Interleave renders with the canvas's own content (cover) so a project that
 *  has both shows both, not just its generated pictures. */
function mixPreview(rendered: RecentProject['images'], cover: RecentProject['images']): RecentProject['images'] {
  const mixed: GenOutput[] = []
  for (let i = 0; i < Math.max(rendered.length, cover.length); i++) {
    if (rendered[i]) mixed.push(rendered[i] as GenOutput)
    if (cover[i]) mixed.push(cover[i] as GenOutput)
  }
  return buildPreviewImages([mixed])
}

// `recentProjects` is the first 10 for the home row; `allProjects` is the full
// list (same data, unsliced) for the "All projects" grid.
const recentProjects = ref<RecentProject[]>([])
const allProjects = ref<RecentProject[]>([])
const loading = ref(false)
let fetchedOnce = false

function deriveProjectName(classTypes: string[]): string {
  // Pick the most descriptive node type as the project name
  const ignore = new Set(['PreviewImage', 'SaveImage', 'LoadImage', 'LoadCheckpoint', 'CLIPTextEncode', 'KSampler', 'VAEDecode', 'VAELoader', 'CLIPLoader'])
  const meaningful = classTypes.filter((t) => !ignore.has(t))
  if (meaningful.length > 0) {
    // Format: "NodeType" → "Node Type"
    return meaningful[0].replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
  }
  return classTypes[0]?.replace(/([a-z])([A-Z])/g, '$1 $2') || 'Workflow'
}

function getSavedNames(): Record<string, string> {
  if (import.meta.server) return {}
  try {
    return JSON.parse(localStorage.getItem('sailor:project-names') || '{}')
  }
  catch { return {} }
}

function persistNames(names: Record<string, string>) {
  if (import.meta.server) return
  localStorage.setItem('sailor:project-names', JSON.stringify(names))
}

export function useRecentProjects() {
  function thumbnailUrl(img: { filename: string; subfolder: string; type: string; v?: string }): string {
    const params = new URLSearchParams({ filename: img.filename, type: img.type })
    if (img.subfolder) params.set('subfolder', img.subfolder)
    if (img.v) params.set('v', img.v)
    return `/view?${params}`
  }

  function timeAgo(timestamp: number): string {
    const now = Date.now()
    const diff = now - timestamp
    const minutes = Math.floor(diff / 60000)
    if (minutes < 1) return 'Just now'
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    if (days === 1) return 'Yesterday'
    return `${days}d ago`
  }

  async function fetchRecentProjects() {
    if (fetchedOnce && recentProjects.value.length > 0) return
    loading.value = true
    try {
      const savedNames = getSavedNames()
      const { listProjects, listGenerations, saveGeneration } = useProjects()
      const projects: RecentProject[] = []
      const durableIds = new Set<string>()
      const recordedPromptIds = new Set<string>()

      generationsAsked = new Set()
      pendingCovers = new Map()
      pendingHistory = new Map()
      // 1) Durable projects are the primary list — names + thumbnails from
      // their generation records, which survive ComfyUI restarts.
      // LC8 (B4): the most recently saved first; only the first GENERATIONS_EAGER read now, a few at a time.
      const durable = [...await listProjects()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      const coverOf = (d: (typeof durable)[number]): GenOutput[] => Array.isArray(d.cover)
        ? d.cover.filter((c): c is GenOutput => !!c && typeof c.filename === 'string' && (!c.kind || c.kind === 'image'))
            .map((c) => ({ kind: c.kind || 'image', filename: c.filename, subfolder: c.subfolder || '', type: c.type || 'input', ...(c.v ? { v: c.v } : {}) }))
        : []
      for (const d of durable.slice(GENERATIONS_EAGER)) {
        durableIds.add(d.uuid)
        const cover = coverOf(d)
        pendingCovers.set(d.uuid, cover)
        projects.push({
          workflowId: d.uuid,
          name: d.name || savedNames[d.uuid] || 'Untitled project',
          promptIds: [],
          images: mixPreview([], cover),
          lastTimestamp: d.updatedAt || 0,
          runCount: 0,
          generationsPending: true,
        })
      }
      await Promise.all(durable.slice(0, GENERATIONS_EAGER).map(async (d) => {
        durableIds.add(d.uuid)
        generationsAsked.add(d.uuid)
        const gens = await queued(() => listGenerations(d.uuid))
        // Paid renders (type 'output') and studio/Frame assets recorded as
        // generations (type 'input' — recordAsset), mixed below with the
        // doc-derived cover (stamped at save time: node previews and canvas
        // snapshots).
        const outputImages: GenOutput[] = []
        const inputAssets: GenOutput[] = []
        for (const g of gens) {
          if (g.promptId) recordedPromptIds.add(g.promptId)
          for (const o of g.outputs || []) {
            if (o.kind !== 'image') continue
            if (o.type === 'output') outputImages.push(o)
            else inputAssets.push(o)
          }
        }
        const cover = coverOf(d)
        const rendered = [...outputImages, ...inputAssets]
        projects.push({
          workflowId: d.uuid,
          name: d.name || savedNames[d.uuid] || 'Untitled project',
          promptIds: gens.map((g) => g.promptId).filter(Boolean),
          images: mixPreview(rendered, cover),
          rendered,
          lastTimestamp: Math.max(d.updatedAt || 0, gens[0]?.ts || 0),
          runCount: gens.length,
        })
      }))

      // 2) /history fallback for pre-durable work + backfill of unrecorded
      // runs into their durable project (idempotent — server dedups by
      // promptId, so re-posting on every Home load is harmless).
      try {
        const res = await fetch('/history')
        const data = (await res.json()) as Record<string, any>
        const byFingerprint = new Map<string, RecentProject>()
        for (const [promptId, entry] of Object.entries(data)) {
          // A runner stage: the runner wrote its own record (R10.8) — never re-posted from here.
          if (isRunnerPromptId(promptId)) continue
          const parsed = historyEntryToRecord(promptId, entry)
          if (!parsed) continue
          if (parsed.projectUuid && durableIds.has(parsed.projectUuid)) {
            // LC8 (B4): its records aren't read yet: checked (and recorded if missing) once they are.
            if (pendingCovers.has(parsed.projectUuid)) {
              const list = pendingHistory.get(parsed.projectUuid) ?? []
              list.push({ promptId, record: parsed.record })
              pendingHistory.set(parsed.projectUuid, list)
              continue
            }
            if (!recordedPromptIds.has(promptId)) {
              // Lazy migration: persist this run before history forgets it.
              saveGeneration(parsed.projectUuid, parsed.record)
            }
            continue // already represented by its durable project card
          }
          const e = entry as any
          const nodes = (e.prompt ?? [])[2] ?? {}
          const classTypes = [...new Set(Object.values(nodes).map((n: any) => n.class_type || ''))] as string[]
          const workflowId = parsed.projectUuid || classTypes.filter(Boolean).sort().join(',')
          let p = byFingerprint.get(workflowId)
          if (!p) {
            p = {
              workflowId,
              name: savedNames[workflowId] || deriveProjectName(classTypes),
              promptIds: [],
              images: [],
              lastTimestamp: parsed.record.ts,
              runCount: 0,
            }
            byFingerprint.set(workflowId, p)
          }
          p.promptIds.push(promptId)
          p.runCount++
          p.lastTimestamp = Math.max(p.lastTimestamp, parsed.record.ts)
          for (const o of parsed.record.outputs) {
            if (o.kind === 'image' && p.images.length < 3) p.images.push(o)
          }
        }
        projects.push(...byFingerprint.values())
      } catch { /* history unreachable — durable list stands */ }

      projects.sort((a, b) => b.lastTimestamp - a.lastTimestamp)
      allProjects.value = projects
      recentProjects.value = projects.slice(0, 10)

      fetchedOnce = true
    }
    catch (err) {
      console.error('[useRecentProjects] Failed to fetch:', err)
    }
    finally {
      loading.value = false
    }
  }

  function refresh() {
    fetchedOnce = false
    fetchRecentProjects()
  }

  /**
   * LC8 (B4): read a pending project's generation records (once per load, in
   * the shared queue) and fill its card in both lists: its pictures, run
   * count and last run. Runs /history holds for it that it hasn't recorded
   * are recorded then, as the eager ones are.
   */
  async function ensureGenerations(workflowId: string): Promise<void> {
    if (!pendingCovers.has(workflowId) || generationsAsked.has(workflowId)) return
    generationsAsked.add(workflowId)
    const { listGenerations, saveGeneration } = useProjects()
    let gens: Awaited<ReturnType<typeof listGenerations>>
    try { gens = await queued(() => listGenerations(workflowId)) }
    catch { generationsAsked.delete(workflowId); return }
    const cover = pendingCovers.get(workflowId) ?? []
    pendingCovers.delete(workflowId)
    const recorded = new Set<string>()
    const outputImages: GenOutput[] = []
    const inputAssets: GenOutput[] = []
    for (const g of gens) {
      if (g.promptId) recorded.add(g.promptId)
      for (const o of g.outputs || []) {
        if (o.kind !== 'image') continue
        if (o.type === 'output') outputImages.push(o)
        else inputAssets.push(o)
      }
    }
    const rendered = [...outputImages, ...inputAssets]
    for (const list of [recentProjects.value, allProjects.value]) {
      const project = list.find((p) => p.workflowId === workflowId)
      if (!project || !project.generationsPending) continue
      project.generationsPending = false
      project.rendered = rendered
      project.images = mixPreview(rendered, cover)
      project.promptIds = gens.map((g) => g.promptId).filter(Boolean)
      project.runCount = gens.length
      project.lastTimestamp = Math.max(project.lastTimestamp, gens[0]?.ts || 0)
    }
    for (const run of pendingHistory.get(workflowId) ?? []) {
      if (!recorded.has(run.promptId)) saveGeneration(workflowId, run.record)
    }
    pendingHistory.delete(workflowId)
  }

  // LC8 (B4): a pending card's records are read when it comes into view (or is about to).
  let generationsObserver: IntersectionObserver | null = null
  const observedProject = new WeakMap<Element, string>()
  function observeProjectCard(el: Element | null | undefined, project: RecentProject): void {
    if (!el || !project.generationsPending || generationsAsked.has(project.workflowId)) return
    if (typeof IntersectionObserver === 'undefined') { void ensureGenerations(project.workflowId); return }
    generationsObserver ??= new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        generationsObserver!.unobserve(entry.target)
        const id = observedProject.get(entry.target)
        if (id) void ensureGenerations(id)
      }
    }, { rootMargin: '400px' })
    observedProject.set(el, project.workflowId)
    generationsObserver.observe(el)
  }

  function setProjectName(workflowId: string, name: string) {
    const names = getSavedNames()
    names[workflowId] = name
    persistNames(names) // offline fallback — server below is the source of truth
    // History-fingerprint ids (comma-joined class types, pre-uuid projects)
    // must not become junk server projects.
    if (workflowId && !workflowId.includes(',')) {
      useProjects().renameProject(workflowId, name)
    }
    // Update in-memory (both lists share the same objects, but guard anyway)
    for (const list of [recentProjects.value, allProjects.value]) {
      const project = list.find((p) => p.workflowId === workflowId)
      if (project) project.name = name
    }
  }

  // Write-through for the lazy cover backfill (useCoverBackfill): update the
  // blank card in BOTH shared lists so the grid and the Home row repaint.
  // Guarded to blank cards only — a race with a real fetch never downgrades
  // generation thumbnails to doc-derived ones.
  function applyBackfilledImages(workflowId: string, images: RecentProject['images']) {
    for (const list of [recentProjects.value, allProjects.value]) {
      const project = list.find((p) => p.workflowId === workflowId)
      if (project && project.images.length === 0) project.images = images
    }
  }

  // Write-through for a freshly stamped cover (stampProjectCover): re-mix the
  // card in both lists so an open grid shows the new snapshot without a refetch.
  function applyProjectCover(workflowId: string, cover: RecentProject['images']) {
    for (const list of [recentProjects.value, allProjects.value]) {
      const project = list.find((p) => p.workflowId === workflowId)
      if (project?.rendered) project.images = mixPreview(project.rendered, cover)
    }
  }

  return {
    recentProjects,
    allProjects,
    loading,
    thumbnailUrl,
    timeAgo,
    fetchRecentProjects,
    refresh,
    ensureGenerations,
    observeProjectCard,
    setProjectName,
    applyBackfilledImages,
    applyProjectCover,
  }
}
