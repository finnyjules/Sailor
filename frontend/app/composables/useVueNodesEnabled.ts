import { hostedModeEnabled } from '~/lib/hostedMode'

const vueNodesEnabled = ref(true)
let listenerRegistered = false

/**
 * Hosted mode forces the Vue canvas ON. Captured ONCE inside the composable
 * body, where the Nuxt context that owns useRuntimeConfig() exists — the
 * storage / custom-event listeners below fire outside that context and would
 * throw if they re-read the config, which is why this is a captured flag and
 * not a lookup inside load(). Same shape as useDirectExecutionEnabled.
 */
let hostedForced = false

/** Default-ON: only an explicit 'false' (Settings toggle) disables the Vue canvas. */
export function vueNodesDefault(stored: string | null): boolean {
  return stored !== 'false'
}

/**
 * The setting as actually applied. Hosted overrides the stored value: turning
 * "Modern node design" off routes canvas loads down the LiteGraph/bridge
 * branch, and hosted never mounts a bridge iframe (that iframe is the hole
 * that let the browser post to the engine unmetered). The legacy branch would
 * wait out its 120s bridge timeout and leave a permanently empty canvas.
 * Local mode keeps the stored setting byte-for-byte.
 */
export function vueNodesResolved(stored: string | null, hosted: boolean): boolean {
  return hosted || vueNodesDefault(stored)
}

export function useVueNodesEnabled() {
  // Callers include event handlers (useNodeSearch.addNode) that run outside a
  // Nuxt instance, where useRuntimeConfig() throws. Keep the last successful
  // capture — the layout resolves this at app setup, long before any of them.
  try { hostedForced = hostedModeEnabled(useRuntimeConfig().public) }
  catch { /* outside the Nuxt context — keep the captured value */ }

  function load() {
    if (import.meta.server) return
    vueNodesEnabled.value = vueNodesResolved(localStorage.getItem('sailor:Comfy.VueNodes.Enabled'), hostedForced)
  }

  // Listen for setting changes (cross-tab via storage event, same-tab via custom event)
  if (import.meta.client && !listenerRegistered) {
    listenerRegistered = true
    window.addEventListener('storage', (e) => {
      if (e.key === 'sailor:Comfy.VueNodes.Enabled') load()
    })
    window.addEventListener('sailor:setting-changed', ((e: CustomEvent) => {
      if (e.detail?.key === 'sailor:Comfy.VueNodes.Enabled') load()
    }) as EventListener)
    load()
  }

  return { vueNodesEnabled, reloadSetting: load }
}
