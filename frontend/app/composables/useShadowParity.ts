// Shadow-parity log: records divergences between OUR prompt builder and the
// bridge iframe's own `graphToPrompt` on every dev run (wired up in Task 8).
// Module-level singleton state (same pattern as `useVueNodesEnabled.ts`) so
// every caller — the dev-only diagnostics panel included — shares one ring
// buffer regardless of how many components call `useShadowParity()`.

import { ref } from 'vue'
import { diffPrompts, type PromptDivergence } from '~/lib/graph/promptDiff'
import type { ApiPrompt } from '~/lib/graph/graphToPrompt'

export interface ParityEntry {
  label: string
  at: number
  divergences: PromptDivergence[]
}

const MAX_ENTRIES = 50

const log = ref<ParityEntry[]>([])

export function useShadowParity() {
  function record(ours: ApiPrompt, theirs: ApiPrompt, label: string): void {
    const divergences = diffPrompts(ours, theirs)
    const entry: ParityEntry = { label, at: Date.now(), divergences }

    log.value.push(entry)
    if (log.value.length > MAX_ENTRIES) {
      log.value.splice(0, log.value.length - MAX_ENTRIES)
    }

    if (divergences.length > 0) {
      console.warn('[shadow-parity]', label, divergences)
    }
  }

  return { record, log }
}
