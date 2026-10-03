/**
 * GET /api/health → `{ sailor: true }`: Sailor answers. The app polls it for
 * its boot/reconnect loader (app/composables/useBackendHealth.ts). There is no
 * local engine to report on (step 4, C5). Listed in NITRO_API_PATHS so the
 * engine-path middleware never takes it; in hosted mode it sits behind the
 * same sign-in as every other /api route and reveals nothing tenant-specific.
 */
import { defineEventHandler, setResponseHeader } from 'h3'

export default defineEventHandler((event) => {
  setResponseHeader(event, 'cache-control', 'no-store')
  return { sailor: true as const }
})
