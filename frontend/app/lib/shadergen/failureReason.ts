/** Why a take slot gave up, read from the engine's log for it (its last line is what ended it),
 *  as the reason its tile shows. Undefined: nothing the tile can say more plainly than
 *  "Didn't come back" (an unreadable reply, a static or compile failure, a model error). */
import type { TileFailReason } from '~/lib/prompt/takesSession'

const CREDITS_RE = /\b402\b|credits/i

export function takeFailureReason(log: readonly string[]): TileFailReason | undefined {
  const last = log.at(-1) ?? ''
  if (last.startsWith('model error')) return CREDITS_RE.test(last) ? 'credits' : undefined
  if (!last.startsWith('checks:')) return undefined
  if (last.includes('does not loop')) return 'loop'
  if (last.includes('heavy')) return 'slow'
  if (last.includes('no visible change')) return 'unchanged'
  return 'looks' // black, blown out, flat
}
