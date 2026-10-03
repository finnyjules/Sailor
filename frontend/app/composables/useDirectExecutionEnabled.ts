import { hostedModeEnabled } from '~/lib/hostedMode'

const directExecutionEnabled = ref(true)
let listenerRegistered = false

/**
 * Hosted mode forces direct execution ON. Captured ONCE inside the composable
 * body, where the Nuxt context that owns useRuntimeConfig() exists — the
 * storage / custom-event listeners below fire outside that context and would
 * throw if they re-read the config, which is why this is a captured flag and
 * not a lookup inside load().
 */
let hostedForced = false

const STORAGE_KEY = 'sailor:Comfy.DirectExecution.Enabled'

/** Default-OFF (beta): only an explicit 'true' (Settings toggle) enables
 * direct execution. Every other stored value stays off. */
export function directExecutionDefault(stored: string | null): boolean {
  return stored === 'true'
}

/**
 * The setting as actually applied: always on. The in-app prompt build is the
 * only dispatch path (the bridge iframe and, since step 4 C5, the local engine
 * are gone); every run goes to the runner.
 */
export function directExecutionResolved(stored: string | null, hosted: boolean): boolean {
  // Tier 1 (bridge retirement): direct execution is now the ONLY dispatch path
  // in every mode — the bridge iframe/queuePrompt route is being removed. Dev no
  // longer falls back to the bridge, so this resolves ON unconditionally.
  // (Previous behaviour: `hosted || directExecutionDefault(stored)`.) To restore
  // the dev bridge toggle for debugging, revert this and the `ref(true)` above.
  void stored; void hosted
  return true
}

export function useDirectExecutionEnabled() {
  hostedForced = hostedModeEnabled(useRuntimeConfig().public)

  function load() {
    if (import.meta.server) return
    directExecutionEnabled.value = directExecutionResolved(localStorage.getItem(STORAGE_KEY), hostedForced)
  }

  // Listen for setting changes (cross-tab via storage event, same-tab via custom event)
  if (import.meta.client && !listenerRegistered) {
    listenerRegistered = true
    window.addEventListener('storage', (e) => {
      if (e.key === STORAGE_KEY) load()
    })
    window.addEventListener('sailor:setting-changed', ((e: CustomEvent) => {
      if (e.detail?.key === STORAGE_KEY) load()
    }) as EventListener)
    load()
  }

  return { directExecutionEnabled, reloadSetting: load }
}
