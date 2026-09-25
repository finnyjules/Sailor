/** The user's My effects library as the page knows it (AI in Sailor spec §7.4): the records,
 *  loaded once per page from /api/my-effects, and kept current by useMyEffects. Pickers list a
 *  My effect only while it is here (once the library has loaded); the live shader catalog
 *  (~/lib/shaderfx/catalog) holds the definitions that render. */
import { shallowRef } from 'vue'
import type { MyEffectRecord } from '~~/shared/myEffects/record'
import * as client from './client'
import { MY_EFFECTS_ERRORS } from './client'

/** Newest first. */
export const myEffectRecords = shallowRef<MyEffectRecord[]>([])
/** True once a list call has succeeded. Until then pickers list every registered My effect. */
export const myEffectsLoaded = shallowRef(false)

let loaded: Promise<MyEffectRecord[]> | null = null

/** How long a list call may take before the page gives up on it for now (and retries later). */
export const MY_EFFECTS_LOAD_TIMEOUT_MS = 8_000

/** Load the library, once per page unless `force`. A failure — or no answer within
 *  `timeoutMs` — is not cached and leaves the library "not loaded": the next call retries. */
export function loadMyEffectRecords(
  api: Pick<typeof client, 'listMyEffects'> = client,
  force = false,
  timeoutMs = MY_EFFECTS_LOAD_TIMEOUT_MS,
): Promise<MyEffectRecord[]> {
  if (!loaded || force) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(MY_EFFECTS_ERRORS.unreachable)), timeoutMs)
    })
    const p: Promise<MyEffectRecord[]> = Promise.race([api.listMyEffects(), timeout])
      .then((r) => { myEffectRecords.value = r; myEffectsLoaded.value = true; return r })
      .catch((e) => { if (loaded === p) loaded = null; throw e })
      .finally(() => clearTimeout(timer))
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
