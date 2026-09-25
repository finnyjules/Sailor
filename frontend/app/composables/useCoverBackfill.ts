// frontend/app/composables/useCoverBackfill.ts
/**
 * useCoverBackfill — lazily derive preview images for legacy "No preview"
 * cards. Projects saved before cover stamping shipped (stampProjectCover in
 * layouts/default.vue) only gain a cover on their next open+save; this
 * composable closes the gap from the read side: when a blank card scrolls
 * into view, fetch the project's current version doc, extract preview images
 * (studio bakes / Frame composites — see ~/lib/projectCover), paint them into
 * the shared card state, and stamp the cover server-side so the next grid
 * load needs no doc fetch.
 */
import { isBackfillCandidate, createTaskQueue, filterToExistingImages } from '~/lib/coverBackfill'
import { extractCoverImages, COVER_CANDIDATE_CAP, COVER_CAP } from '~/lib/projectCover'
import type { RecentProject } from '~/composables/useRecentProjects'

// Module scope on purpose: a uuid is attempted once per session no matter how
// often its card re-mounts, and one queue bounds fetches across all views.
const attempted = new Set<string>()
const queue = createTaskQueue(3)

export function useCoverBackfill() {
  let observer: IntersectionObserver | null = null
  const cardProjects = new WeakMap<Element, RecentProject>()

  async function backfill(project: RecentProject): Promise<void> {
    if (!isBackfillCandidate(project) || attempted.has(project.workflowId)) return
    attempted.add(project.workflowId)
    const { loadVersion, setProjectCover } = useProjects()
    const version = await loadVersion(project.workflowId, 'current')
    if (!version?.workflow) return
    const cover = (await filterToExistingImages(
      extractCoverImages(version.workflow, { uuid: project.workflowId, cap: COVER_CANDIDATE_CAP }),
    )).slice(0, COVER_CAP)
    if (!cover.length) return
    useRecentProjects().applyBackfilledImages(project.workflowId, cover)
    // Stamp server-side (fire-and-forget — setProjectCover swallows errors)
    // so future loads read the cover straight off the project index.
    setProjectCover(project.workflowId, cover)
  }

  function ensureObserver(): IntersectionObserver | null {
    if (observer || typeof IntersectionObserver === 'undefined') return observer
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        observer!.unobserve(entry.target)
        const project = cardProjects.get(entry.target)
        if (project) queue.push(() => backfill(project))
      }
    }, { rootMargin: '200px' })
    return observer
  }

  /** Template function-ref hook: watch a card element until it first becomes
   *  visible, then queue its backfill. No-op for ineligible/attempted cards
   *  and on the server. */
  function observeCard(el: Element | null | undefined, project: RecentProject): void {
    if (!el || !isBackfillCandidate(project) || attempted.has(project.workflowId)) return
    const obs = ensureObserver()
    if (!obs) return
    cardProjects.set(el, project)
    obs.observe(el)
  }

  function disconnect(): void {
    observer?.disconnect()
    observer = null
  }

  return { observeCard, disconnect, backfill }
}
