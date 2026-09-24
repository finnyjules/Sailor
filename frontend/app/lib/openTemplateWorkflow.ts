/**
 * Open a comfy.org template / community workflow in a new project tab, with
 * its graph loaded.
 *
 * The graph is fetched BEFORE the tab opens. Opening first would make the tab
 * active while it is still empty, and the layout's start-picker watcher
 * (shouldOfferStartPicker) would pop "What do you want to make?" over the
 * graph that is about to arrive. Fetch → open → load in one synchronous step
 * means the layout's sailor:loadTabWorkflow handler has already filled the tab
 * by the time that watcher runs.
 *
 * Throws (and opens no tab) when the graph isn't available.
 */
export interface TemplateRef {
  slug: string
  title: string
}

export interface OpenTemplateDeps {
  fetch: (url: string) => Promise<Response>
  openTab: (opts: { type: 'project'; label: string }) => { id: string }
  loadIntoTab: (tabId: string, workflow: unknown) => void
}

export async function openTemplateWorkflow(template: TemplateRef, deps: OpenTemplateDeps): Promise<string> {
  // Server proxy: resolves both official comfy.org templates and community
  // workflows, and bypasses comfy.org's missing CORS headers.
  const res = await deps.fetch(`/api/community-workflow?slug=${encodeURIComponent(template.slug)}`)
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string }
    throw new Error(body?.message || `Failed to load workflow (${res.status})`)
  }
  const workflow = await res.json()
  const tab = deps.openTab({ type: 'project', label: template.title })
  deps.loadIntoTab(tab.id, workflow)
  return tab.id
}

/** The browser wiring: hands the graph to the layout's sailor:loadTabWorkflow handler. */
export function dispatchLoadTabWorkflow(tabId: string, workflow: unknown) {
  window.dispatchEvent(new CustomEvent('sailor:loadTabWorkflow', {
    detail: { tabId, workflow },
  }))
}
