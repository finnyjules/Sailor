/**
 * App-wide frame-template library (file-backed via /api/frame-templates).
 * `StoredTemplate` is the on-disk shape — a loose placeholder until the full
 * `Template` type lands in Task 2, which this composable will then import.
 */
import { ref } from 'vue'

export interface StoredTemplate { id: string, name: string, version: number, [k: string]: unknown }

const templates = ref<StoredTemplate[]>([])
let loaded = false

async function refresh(): Promise<void> {
  const res = await fetch('/api/frame-templates')
  if (res.ok) templates.value = (await res.json()).templates ?? []
  loaded = true
}

async function save(entry: StoredTemplate): Promise<void> {
  // Optimistic upsert — see useBrandLibrary.save() for rationale.
  const i = templates.value.findIndex(t => t.id === entry.id)
  if (i >= 0) templates.value.splice(i, 1, entry)
  else templates.value.unshift(entry)
  try {
    const res = await fetch(`/api/frame-templates/${entry.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    })
    if (!res.ok) await refresh() // rollback to server truth
  } catch {
    // Network-level rejection (offline/DNS/CORS) — roll back the same way.
    await refresh()
  }
}

async function remove(id: string): Promise<void> {
  templates.value = templates.value.filter(t => t.id !== id)
  try {
    const res = await fetch(`/api/frame-templates/${id}`, { method: 'DELETE' })
    if (!res.ok) await refresh()
  } catch {
    await refresh()
  }
}

function get(id: string): StoredTemplate | undefined {
  return templates.value.find(t => t.id === id)
}

export function useTemplateLibrary() {
  if (!loaded) refresh().catch(() => {})
  return {
    templates,
    save,
    remove,
    get,
    refresh,
    _clearForTests: () => { templates.value = []; loaded = false },
  }
}
