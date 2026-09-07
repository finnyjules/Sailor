// frontend/app/composables/useNextStepsStrip.ts
// Singleton coordination for the post-render "next steps" chip strip: exactly
// one artifact (the most recently rendered) shows it, and any new render or
// dismissal replaces/clears it. Module-scoped refs = shared across components.
// Two channels: `active` (generic suggestion chips, 12s TTL in the component)
// and `fixes` (reviewer-found paid fixes — sticky until clicked/dismissed/stale).
import { ref } from 'vue'

export interface FixChip {
  id: number
  label: string
  hint: string | null
  apply: () => void
}

const active = ref<{ nodeId: string; shownAt: number } | null>(null)
const fixes = ref<{ nodeId: string; chips: FixChip[] } | null>(null)

export function useNextStepsStrip() {
  function announceFreshTake(nodeId: string) {
    active.value = { nodeId, shownAt: Date.now() }
    // A new render invalidates fixes found on the previous one.
    if (fixes.value?.nodeId === nodeId) fixes.value = null
  }
  function announceFixes(nodeId: string, chips: FixChip[]) {
    fixes.value = { nodeId, chips }
  }
  function clearFixes(nodeId?: string) {
    if (!nodeId || fixes.value?.nodeId === nodeId) fixes.value = null
  }
  function dismiss() {
    active.value = null
  }
  return { active, fixes, announceFreshTake, announceFixes, clearFixes, dismiss }
}
