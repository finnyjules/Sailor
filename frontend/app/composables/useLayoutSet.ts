import { ref, shallowRef, watch } from 'vue'
import type { Ref, ShallowRef } from 'vue'
import type { SetEntry } from '~/lib/frame/patterns/kit/set'

// ═══════════════════════ the set sheet's state (Stage 5 — Make a set) ═══════════════════════
// Whether the set sheet is open, and the set it shows. The set is planned when the sheet opens and
// again whenever the ticked formats change while it is open — never while it is closed. Planning
// is `useLayoutVary().planSet`: pure, the Frame is never written.

export interface LayoutSetSource {
  /** The ticked formats (`useLayoutVary().setFormats`). */
  formats: () => readonly string[]
  /** Plan the Frame's applied layout at these formats (`useLayoutVary().planSet`). */
  plan: (formats: readonly string[]) => SetEntry[]
}

export function useLayoutSet(src: LayoutSetSource): {
  open: Ref<boolean>
  entries: ShallowRef<SetEntry[]>
  openSet(): void
  close(): void
} {
  const open = ref(false)
  const entries = shallowRef<SetEntry[]>([])
  const replan = () => { entries.value = src.plan([...src.formats()]) }
  function openSet() { open.value = true; replan() }
  function close() { open.value = false; entries.value = [] }
  watch(() => src.formats().join(','), () => { if (open.value) replan() })
  return { open, entries, openSet, close }
}
