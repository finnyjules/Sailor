/** My effects: save a kept take, add versions, rename, remove, and adopt a project's copies
 *  (AI in Sailor spec §7.4; plan rulings 8, 16, 17). Every change is written through
 *  /api/my-effects first, then registered with the live shader catalog so every picker and
 *  renderer sees it at once. A failed write changes nothing on the page. */
import type { GenTake } from '~~/shared/shadergen/contract'
import { cleanName, newMyEffectId, type MyEffectRecord } from '~~/shared/myEffects/record'
import * as client from '~/lib/myEffects/client'
import { expandMyEffect, recordFromTake, withCodeVersion, withValuesVersion } from '~/lib/myEffects/defs'
import { loadMyEffectRecords, myEffectRecordById, myEffectRecords, setMyEffectRecord } from '~/lib/myEffects/library'
import { registerEffects, unregisterEffects } from '~/lib/shaderfx/catalog'
import type { ParamValue } from '~/lib/shaderfx/types'

export interface MyEffectsDeps {
  api?: typeof client
  register?: typeof registerEffects
  /** Accepted for symmetry (and so a test can prove `remove` never calls it). */
  unregister?: typeof unregisterEffects
  now?: () => string
  newId?: () => string
}

export function useMyEffects(deps: MyEffectsDeps = {}) {
  const api = deps.api ?? client
  const register = deps.register ?? registerEffects
  const now = deps.now ?? (() => new Date().toISOString())
  const newId = deps.newId ?? (() => newMyEffectId())

  function stored(saved: MyEffectRecord): MyEffectRecord {
    setMyEffectRecord(saved)
    register(expandMyEffect(saved))
    return saved
  }
  const commit = async (r: MyEffectRecord): Promise<MyEffectRecord> => stored(await api.putMyEffect(r))
  const need = (id: string): MyEffectRecord => {
    const r = myEffectRecordById(id)
    if (!r) throw new Error('That effect isn’t in My effects any more.')
    return r
  }

  return {
    records: myEffectRecords,
    load: () => loadMyEffectRecords(api, true),
    saveTake: (take: GenTake, o: { request: string; from: string | null }) =>
      commit(recordFromTake(take, { id: newId(), request: o.request, from: o.from, now: now() })),
    addCodeVersion: async (id: string, take: GenTake, request: string) =>
      commit(withCodeVersion(need(id), take, { request, now: now() })),
    async addValuesVersion(id: string, values: Record<string, ParamValue>, request: string): Promise<MyEffectRecord | null> {
      const next = withValuesVersion(need(id), values, { request, now: now() })
      return next ? commit(next) : null
    },
    rename: async (id: string, name: string) => stored(await api.renameMyEffect(id, cleanName(name))),
    /** Gone from the library (so pickers stop listing it), but its definitions stay registered:
     *  an open project that uses it keeps rendering. */
    async remove(id: string): Promise<void> {
      await api.deleteMyEffect(id)
      setMyEffectRecord(null, id)
    },
    /** Register a project's own copies of My effects so it renders — unless the library already
     *  has that effect with at least as many versions. Never written into the library. */
    adopt(recs: MyEffectRecord[]): void {
      const take = recs.filter((r) => {
        const lib = myEffectRecordById(r.id)
        return !lib || lib.versions.length < r.versions.length
      })
      if (take.length) register(take.flatMap(expandMyEffect))
    },
  }
}
