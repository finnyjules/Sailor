/**
 * Checks the video tools once at start (Task R5.1a), so `mediaToolsReady()`
 * has its answer before the first run or Timeline request. Not awaited: boot
 * never waits on it, and a missing or refused build only logs why.
 */
import { mediaTools } from '../media/tools'

export default defineNitroPlugin(() => {
  void mediaTools()
})
