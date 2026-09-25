/**
 * ProjectDoc — the multi-canvas project document.
 *
 * A project tab no longer holds a single workflow but a ProjectDoc: an ordered
 * list of named canvases, each with its own workflow, plus which one is shown.
 * The doc is the unit of persistence everywhere — sessionStorage, the rolling
 * durable autosave, and named versions all store the whole doc, so restoring a
 * version brings back every canvas. Anything that hands us a bare workflow
 * (old sessions, old durable versions, /history, community templates) gets
 * wrapped into a one-canvas doc via toProjectDoc at the entry point, so the
 * rest of the code only ever sees docs. The backend never inspects version
 * bodies, so this needs no server-side changes.
 */

export interface ProjectCanvas { id: string; name: string; workflow: any }
export interface ProjectDoc {
  canvases: ProjectCanvas[]
  activeCanvasId: string
  /** Active brand-library kit for this project (id into /api/brand-kits).
   *  Unset/null ⇒ no brand theming; all consumers behave as before. */
  brandKitId?: string | null
  /** Project-scoped named image references (`@refs`): handle → { filename, text? }. */
  assetRegistry?: import('./refs/registry').RefRegistry
  /** Ordered delivery shelf (Ready to deliver). Array order == display order.
   *  Absent ⇒ treat as []. References existing on-disk output files only. */
  deliverables?: import('./deliverables/model').DeliverableItem[]
  /** Client save stamp (ms epoch), written on every successful canvas
   *  snapshot. Lets load-time code compare the sessionStorage copy against
   *  the durable server copy and keep the newer one — the two stores can
   *  silently diverge (quota-failed session writes, parallel windows).
   *  Absent ⇒ legacy doc of unknown age. */
  savedAt?: number
  /** Copies of the My effects this project uses (AI in Sailor spec §7.4), so it renders
   *  without the owner's library. Written on save, registered on load. Absent ⇒ none. */
  myEffects?: import('~~/shared/myEffects/record').MyEffectRecord[]
}

export const BLANK_WORKFLOW = { last_node_id: 0, last_link_id: 0, nodes: [], links: [], groups: [], config: {}, extra: {}, version: 0.4 }

let _canvasSeq = 0
export function makeCanvasId(): string {
  _canvasSeq += 1
  return `cv_${Date.now().toString(36)}_${_canvasSeq}`
}

export function makeBlankWorkflow(): any {
  return JSON.parse(JSON.stringify(BLANK_WORKFLOW))
}

export function isProjectDoc(x: any): x is ProjectDoc {
  return !!x && Array.isArray(x.canvases)
}

/** Wrap a legacy bare workflow (or nothing) into a one-canvas doc. Docs pass through. */
export function toProjectDoc(x: any): ProjectDoc {
  if (isProjectDoc(x)) return x
  const id = makeCanvasId()
  const workflow = (x && typeof x === 'object') ? x : makeBlankWorkflow()
  return { canvases: [{ id, name: 'Canvas 1', workflow }], activeCanvasId: id, assetRegistry: {} }
}

export function activeCanvasOf(doc: ProjectDoc): ProjectCanvas {
  return doc.canvases.find((c) => c.id === doc.activeCanvasId) ?? doc.canvases[0]!
}

/** Does this doc (or legacy bare workflow) contain any real content? */
export function docHasContent(x: any): boolean {
  if (isProjectDoc(x)) return x.canvases.some((c) => (c.workflow?.nodes?.length ?? 0) > 0)
  return (x?.nodes?.length ?? 0) > 0
}

/** Decide which copy of a project doc to trust on load: the in-session
 *  sessionStorage copy or the durable server copy. Rules, in order:
 *    - an empty/missing side loses to one with content (both empty → session);
 *    - a session doc with content but no savedAt stamp is legacy (unknown
 *      age) and is never replaced — swapping a fresh-but-unstamped session
 *      copy for an older durable one is exactly the loss this guards against;
 *    - otherwise the durable copy wins only when STRICTLY newer (ties keep
 *      session, matching pre-guard behavior). */
export function pickNewerDoc(sessionDoc: any, durableDoc: any): { doc: any; source: 'session' | 'durable' } {
  const sessionHas = !!sessionDoc && docHasContent(sessionDoc)
  const durableHas = !!durableDoc && docHasContent(durableDoc)
  if (!sessionHas) return durableHas ? { doc: durableDoc, source: 'durable' } : { doc: sessionDoc, source: 'session' }
  if (!durableHas) return { doc: sessionDoc, source: 'session' }
  const sessionStamp = typeof sessionDoc.savedAt === 'number' ? sessionDoc.savedAt : null
  if (sessionStamp === null) return { doc: sessionDoc, source: 'session' }
  const durableStamp = typeof durableDoc.savedAt === 'number' ? durableDoc.savedAt : 0
  return durableStamp > sessionStamp
    ? { doc: durableDoc, source: 'durable' }
    : { doc: sessionDoc, source: 'session' }
}

/** Bump doc.savedAt to lastEditAt, monotonically.
 *
 *  savedAt must track content FRESHNESS, not serialization time. Stamping
 *  Date.now() on every snapshot let a stale browser window "launder" old
 *  content: re-serializing a 2-hour-old doc re-labeled it as newest, so the
 *  load-time recency guard (pickNewerDoc) and the backend's stale-write
 *  rejection both waved it through — clobbering fresh work from another
 *  window. Instead, callers record WHEN the user last edited the doc and pass
 *  that here at save time:
 *    - lastEditAt is a number and newer than the current stamp (or the doc is
 *      unstamped) → savedAt becomes lastEditAt;
 *    - otherwise savedAt is left untouched — never lowered, and never minted
 *      fresh for content this window didn't edit. */
export function stampDocForSave(doc: ProjectDoc, lastEditAt: number | null | undefined): void {
  if (typeof lastEditAt !== 'number') return
  if (typeof doc.savedAt === 'number' && lastEditAt <= doc.savedAt) return
  doc.savedAt = lastEditAt
}

/** Next available "Canvas N" name that doesn't collide with existing ones. */
export function nextCanvasName(doc: ProjectDoc): string {
  let n = doc.canvases.length + 1
  while (doc.canvases.some((c) => c.name === `Canvas ${n}`)) n += 1
  return `Canvas ${n}`
}
