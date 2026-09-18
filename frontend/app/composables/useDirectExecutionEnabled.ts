import { hostedModeEnabled } from '~/lib/hostedMode'

const directExecutionEnabled = ref(false)
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
 * The setting as actually applied. Hosted overrides the stored value: there is
 * no reachable engine origin for a hosted browser (the bridge/worker iframes
 * are not mounted), so a bridge run would await a bridge that never becomes
 * ready — and mounting one is the hole that let the iframe post to :8188
 * unmetered. Local mode keeps the default-OFF beta behavior byte-for-byte.
 */
export function directExecutionResolved(stored: string | null, hosted: boolean): boolean {
  return hosted || directExecutionDefault(stored)
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
