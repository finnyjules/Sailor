import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'

/** Pure state machine (no Vue lifecycle) so it can be unit-tested with fake timers.
 *  Call onEdit() on every edit: it debounces persist(), and drives saving/saved.
 *  A persist() that returns `false` saved nothing (e.g. a previewed draft): no "Saved" flash. */
export function createAutosaveController(
  persist: () => void | boolean,
  opts: { debounceMs?: number; flashMs?: number } = {},
) {
  const { debounceMs = 400, flashMs = 1500 } = opts
  const saving = ref(false)
  const saved = ref(false)
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let flashTimer: ReturnType<typeof setTimeout> | undefined
  function onEdit() {
    saving.value = true
    saved.value = false
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      const wrote = persist()
      saving.value = false
      if (wrote === false) return
      saved.value = true
      clearTimeout(flashTimer)
      flashTimer = setTimeout(() => { saved.value = false }, flashMs)
    }, debounceMs)
  }
  function dispose() { clearTimeout(saveTimer); clearTimeout(flashTimer) }
  return { saving, saved, onEdit, dispose }
}

/** Composable: fires createAutosaveController.onEdit whenever `source` changes
 *  (deep), cleans up on unmount. Returns saving/saved refs for the footer status.
 *
 *  The watch is registered in onMounted → nextTick, NOT at setup: a studio hydrates
 *  its config from the node during its own onMounted, and that hydration write is a
 *  change the watcher would otherwise see as the "first edit" — flashing Saving…/Saved ✓
 *  on every reopen with no user action. Because this composable's onMounted runs before
 *  the host's (call order), the nextTick still resolves after the host's synchronous
 *  hydration settles, so the watch baselines on the hydrated state and only genuine
 *  later edits trigger it. */
export function useStudioAutosave(
  source: () => unknown,
  persist: () => void | boolean,
  opts?: { debounceMs?: number; flashMs?: number },
) {
  const c = createAutosaveController(persist, opts)
  onMounted(() => { nextTick(() => { watch(source, c.onEdit, { deep: true }) }) })
  onBeforeUnmount(c.dispose)
  return { saving: c.saving, saved: c.saved }
}
