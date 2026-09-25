/** The four /api/my-effects calls (server/api/my-effects). Async functions, so a
 *  `$fetch` that throws synchronously outside a Nuxt runtime still arrives as a rejection.
 *
 *  Every failure is rethrown as a plain sentence (sentence case, no URL, id or status code):
 *  an ofetch error's own message reads `[PUT] "/api/my-effects/mine_…": 413 …`, and the
 *  server's texts are for logs, not for the screen. */
import type { MyEffectRecord } from '~~/shared/myEffects/record'

export const MY_EFFECTS_ERRORS = {
  gone: 'That effect isn’t in My effects any more.',
  tooLarge: 'That effect is too large to save.',
  unreachable: 'My effects couldn’t be reached. Try again in a moment.',
  save: 'Couldn’t save to My effects.',
  load: 'Couldn’t load My effects.',
  remove: 'Couldn’t remove that effect from My effects.',
} as const

type Fallback = 'save' | 'load' | 'remove'

/** The HTTP status of a fetch error, or null when there was no answer (offline, timeout, abort). */
function statusOf(e: unknown): number | null {
  const x = e as { statusCode?: unknown; status?: unknown; response?: { status?: unknown } } | null
  const s = x?.statusCode ?? x?.status ?? x?.response?.status
  return typeof s === 'number' && s > 0 ? s : null
}

export function myEffectsError(e: unknown, fallback: Fallback): Error {
  const status = statusOf(e)
  if (status === 404) return new Error(MY_EFFECTS_ERRORS.gone)
  if (status === 413) return new Error(MY_EFFECTS_ERRORS.tooLarge)
  if (status === null) return new Error(MY_EFFECTS_ERRORS.unreachable)
  return new Error(MY_EFFECTS_ERRORS[fallback])
}

async function call<T>(fallback: Fallback, run: () => Promise<T>): Promise<T> {
  try { return await run() } catch (e) { throw myEffectsError(e, fallback) }
}

const url = (id: string) => `/api/my-effects/${encodeURIComponent(id)}`

export function listMyEffects(): Promise<MyEffectRecord[]> {
  return call('load', async () => {
    const res = await $fetch<{ effects: MyEffectRecord[] }>('/api/my-effects')
    return Array.isArray(res?.effects) ? res.effects : []
  })
}

export function putMyEffect(r: MyEffectRecord): Promise<MyEffectRecord> {
  return call('save', () => $fetch<MyEffectRecord>(url(r.id), { method: 'PUT', body: r }))
}

export function renameMyEffect(id: string, name: string): Promise<MyEffectRecord> {
  return call('save', () => $fetch<MyEffectRecord>(url(id), { method: 'PATCH', body: { name } }))
}

export function deleteMyEffect(id: string): Promise<void> {
  return call('remove', async () => { await $fetch(url(id), { method: 'DELETE' }) })
}
