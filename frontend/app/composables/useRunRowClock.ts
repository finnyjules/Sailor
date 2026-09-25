// frontend/app/composables/useRunRowClock.ts
// One shared 30-second clock for every Run row's "Rendered N min ago" line —
// a single module-level interval started on first use, not one timer per node.
import { ref, type Ref } from 'vue'

const now = ref(Date.now())
let handle: ReturnType<typeof setInterval> | null = null

export function useRunRowClock(): Ref<number> {
  if (!handle && typeof window !== 'undefined') {
    now.value = Date.now()
    handle = setInterval(() => { now.value = Date.now() }, 30_000)
  }
  return now
}
