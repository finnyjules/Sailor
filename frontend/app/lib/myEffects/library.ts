/** The user's My effects library as the page knows it (AI in Sailor spec §7.4): the records,
 *  loaded once per page from /api/my-effects, and kept current by useMyEffects. Pickers list a
 *  My effect only while it is here (once the library has loaded); the live shader catalog
 *  (~/lib/shaderfx/catalog) holds the definitions that render. */
import { shallowRef } from 'vue'
import type { MyEffectRecord } from '~~/shared/myEffects/record'
import * as client from './client'

/** Newest first. */
export const myEffectRecords = shallowRef<MyEffectRecord[]>([])
/** True once a list call has succeeded. Until then pickers list every registered My effect. */
export const myEffectsLoaded = shallowRef(false)

let loaded: Promise<MyEffectRecord[]> | null = null

/** Load the library, once per page unless `force`. A failure is not cached: the next call retries. */
export function loadMyEffectRecords(api: Pick<typeof client, 'listMyEffects'> = client, force = false): Promise<MyEffectRecord[]> {
  if (!loaded || force) {
    const p: Promise<MyEffectRecord[]> = api.listMyEffects()
      .then((r) => { myEffectRecords.value = r; myEffectsLoaded.value = true; return r })
      .catch((e) => { if (loaded === p) loaded = null; throw e })
    loaded = p
  }
  return loaded
}

export const myEffectRecordById = (id: string): MyEffectRecord | null =>
  myEffectRecords.value.find(r => r.id === id) ?? null

/** Put `r` at the front (newest), replacing any record with its id; `null` removes `id`. */
export function setMyEffectRecord(r: MyEffectRecord | null, id: string | undefined = r?.id): void {
  const rest = myEffectRecords.value.filter(x => x.id !== id)
  myEffectRecords.value = r ? [r, ...rest] : rest
}
