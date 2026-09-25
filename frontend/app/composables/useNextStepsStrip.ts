// frontend/app/composables/useNextStepsStrip.ts
// Post-render coordination. `active` = the generic suggestion channel (one node
// at a time). Fixes are PER NODE now (spec §2.3's "N fixes" badge): reviewer-found
// fixes stay on their node until applied, dismissed, or a fresh take replaces them.
import { ref } from 'vue'

export interface FixChip {
  id: number
  label: string
  hint: string | null
  apply: () => void
}

const active = ref<{ nodeId: string; shownAt: number } | null>(null)
const fixesByNode = ref<Record<string, FixChip[]>>({})

export function useNextStepsStrip() {
  function clearFixes(nodeId?: string) {
    if (!nodeId) { fixesByNode.value = {}; return }
    if (!(nodeId in fixesByNode.value)) return
    const { [nodeId]: _gone, ...rest } = fixesByNode.value
    fixesByNode.value = rest
  }
  function announceFreshTake(nodeId: string) {
    active.value = { nodeId, shownAt: Date.now() }
    clearFixes(nodeId) // a new render invalidates fixes found on the previous one
  }
  function announceFixes(nodeId: string, chips: FixChip[]) {
    fixesByNode.value = { ...fixesByNode.value, [nodeId]: chips }
  }
  function fixesFor(nodeId: string): FixChip[] { return fixesByNode.value[nodeId] ?? [] }
  function dismiss() { active.value = null }
  return { active, fixesByNode, fixesFor, announceFreshTake, announceFixes, clearFixes, dismiss }
}
