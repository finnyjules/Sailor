/** The four /api/my-effects calls (server/api/my-effects). Async functions, so a
 *  `$fetch` that throws synchronously outside a Nuxt runtime still arrives as a rejection. */
import type { MyEffectRecord } from '~~/shared/myEffects/record'

const url = (id: string) => `/api/my-effects/${encodeURIComponent(id)}`

export async function listMyEffects(): Promise<MyEffectRecord[]> {
  const res = await $fetch<{ effects: MyEffectRecord[] }>('/api/my-effects')
  return Array.isArray(res?.effects) ? res.effects : []
}

export async function putMyEffect(r: MyEffectRecord): Promise<MyEffectRecord> {
  return $fetch<MyEffectRecord>(url(r.id), { method: 'PUT', body: r })
}

export async function renameMyEffect(id: string, name: string): Promise<MyEffectRecord> {
  return $fetch<MyEffectRecord>(url(id), { method: 'PATCH', body: { name } })
}

export async function deleteMyEffect(id: string): Promise<void> {
  await $fetch(url(id), { method: 'DELETE' })
}
