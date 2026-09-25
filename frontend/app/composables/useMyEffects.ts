/** My effects: save a kept take, add versions, rename, remove, and adopt a project's copies
 *  (AI in Sailor spec §7.4; plan rulings 8, 16, 17). Every change is written through
 *  /api/my-effects first, then registered with the live shader catalog so every picker and
 *  renderer sees it at once. A failed write changes nothing on the page. */
import type { GenTake } from '~~/shared/shadergen/contract'
import { cleanName, newMyEffectId, validateMyEffect, type MyEffectRecord } from '~~/shared/myEffects/record'
import * as client from '~/lib/myEffects/client'
import { MY_EFFECTS_ERRORS } from '~/lib/myEffects/client'
import { expandMyEffect, myEffectIdOf, newestEffectId, recordFromTake, storedEffectId, withCodeVersion, withValuesVersion } from '~/lib/myEffects/defs'
import { myEffectRecordById, myEffectRecords, myEffectsLoaded, setMyEffectRecord } from '~/lib/myEffects/library'
import { loadOwnEffects, registerEffects } from '~/lib/shaderfx/catalog'
import { staticCheck } from '~/lib/shadergen/staticCheck'
import type { ParamValue } from '~/lib/shaderfx/types'

export interface MyEffectsDeps {
  api?: typeof client
  register?: typeof registerEffects
  now?: () => string
  newId?: () => string
}

/** Every code version of a record passes stage 1's static check (the loop and image-read limits
 *  that keep a shader from hanging the graphics card, spec §7.5). A project's copy may be someone
 *  else's, so it gets the same check a freshly written take does before it can render. */
function codePasses(r: MyEffectRecord): boolean {
  return r.versions.every(v => v.body === undefined
    || staticCheck({ name: r.name, animated: r.animated, generative: r.generative, params: v.params ?? [], body: v.body }).ok)
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
    if (!r) throw new Error(MY_EFFECTS_ERRORS.gone)
    return r
  }

  /** The library as the server has it, merged into the live catalog. A failure (or timeout)
   *  leaves it "not loaded" and rejects; the next call retries. */
  const load = async (): Promise<MyEffectRecord[]> => { await loadOwnEffects(api, true); return myEffectRecords.value }
  /** Before a save that depends on the library: if it hasn't loaded (a slow cold start, a failed
   *  list call), try once more. Never throws — a library still out of reach just stays unknown. */
  async function ready(): Promise<void> {
    if (myEffectsLoaded.value) return
    try { await loadOwnEffects(api) } catch { /* still unknown: the caller decides */ }
  }

  return {
    records: myEffectRecords,
    load,
    ready,
    /** True when `id` is one of the user's own My effects (as the loaded library knows it). */
    has: (id: string): boolean => !!myEffectRecordById(id),
    saveTake: (take: GenTake, o: { request: string; from: string | null }) =>
      commit(recordFromTake(take, { id: newId(), request: o.request, from: o.from, now: now() })),
    addCodeVersion: async (id: string, take: GenTake, request: string) =>
      commit(withCodeVersion(need(id), take, { request, now: now() })),
    /** A dial version for the target showing `effectId` (pinned `…~vN`; a stored bare id reads as
     *  v1). Adds nothing (null) unless the effect is in the user's library — a shared project's
     *  copy has no record to add to — and `effectId` is its newest code version (a dial version
     *  always sits on the newest code), or when no dial changed. */
    async addValuesVersion(effectId: string, values: Record<string, ParamValue>, request: string): Promise<MyEffectRecord | null> {
      const id = myEffectIdOf(effectId)
      if (!id) return null
      await ready()
      const rec = myEffectRecordById(id)
      if (!rec || storedEffectId(effectId) !== newestEffectId(rec)) return null
      const next = withValuesVersion(rec, values, { request, now: now() })
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
     *  has that effect with at least as many versions (plan ruling 17; if the library loads
     *  later, the live catalog applies the same rule then). A copy comes from a project doc,
     *  possibly someone else's, so each is validated first — its shape, and every code version
     *  through the static check (final review #5) — and one that fails is skipped whole.
     *  Never written into the library. */
    adopt(recs: MyEffectRecord[]): void {
      const take = recs.flatMap((raw) => {
        let r: MyEffectRecord
        try { r = validateMyEffect(raw) } catch { return [] }
        if (!codePasses(r)) return []
        const lib = myEffectRecordById(r.id)
        return !lib || lib.versions.length < r.versions.length ? [r] : []
      })
      if (take.length) register(take.flatMap(expandMyEffect))
    },
  }
}
