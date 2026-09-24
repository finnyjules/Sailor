/**
 * GET /api/engine/health → `{ sailor: true, engine: 'up' | 'down' }`.
 *
 * Answered by Sailor itself (so an answer at all means Sailor is up), with the
 * engine's state checked against 127.0.0.1:8188/system_stats — 1.5 s timeout,
 * cached for 3 s (server/native/engineHealth.ts). Listed in NITRO_API_PATHS so
 * the engine proxy never takes it; in hosted mode it sits behind the same
 * sign-in as every other /api route and reveals nothing tenant-specific.
 */
import { defineEventHandler, setResponseHeader } from 'h3'
import { engineHealth } from '../../native/engineHealth'

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'cache-control', 'no-store')
  return { sailor: true as const, engine: await engineHealth() }
})
