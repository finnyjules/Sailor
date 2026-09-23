/**
 * On server start, pick up every runner run that was mid-flight: ask fal
 * again about each request it had sent. Paused runs need nothing — they wait
 * for a Gate button. Off unless NUXT_RUNNER_ENABLED is set.
 */
import { runnerEnabled } from '../runner/config'
import { getEngine } from '../runner/index'

const g = globalThis as unknown as { __sailorRunnerReattached?: boolean }

export default defineNitroPlugin(() => {
  if (!runnerEnabled() || g.__sailorRunnerReattached) return
  g.__sailorRunnerReattached = true
  // Not awaited: boot must not wait on the database or fal.
  setTimeout(() => {
    getEngine().reattach()
      .then(n => { if (n) console.log(`[runner] picked up ${n} run(s) after start-up`) })
      .catch(e => console.error('[runner] could not pick up runs after start-up', e))
  }, 2000)
})
