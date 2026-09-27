import { describe, expect, it } from 'vitest'
import { applyStatePatch } from '~~/server/utils/characterStatePatch'
import { parseCharacterRecord } from '~~/server/utils/characterRegistry'

const rec = () => parseCharacterRecord(JSON.stringify({
  name: 'Cal',
  states: [{ id: 'default', label: 'Default', descriptor: '', refImages: ['a.png'], coverIndex: 0, panels: [], sheetImage: null, status: 'draft', stressResult: null, updatedAt: 'T1' }],
}), 'cal')!

it('patches named fields and stamps updatedAt', () => {
  const r = applyStatePatch(rec(), { stateId: 'default', patch: { descriptor: 'wet hair' } }, 'T2')
  expect(r.ok && r.record.states[0]!.descriptor).toBe('wet hair')
  expect(r.ok && r.record.states[0]!.updatedAt).toBe('T2')
})
it('404 on unknown state', () => {
  expect(applyStatePatch(rec(), { stateId: 'gone', patch: {} }, 'T2')).toMatchObject({ ok: false, code: 404 })
})
it('409 when expectedUpdatedAt is stale', () => {
  expect(applyStatePatch(rec(), { stateId: 'default', expectedUpdatedAt: 'T0', patch: { label: 'X' } }, 'T2'))
    .toMatchObject({ ok: false, code: 409 })
})
it('matching expectedUpdatedAt writes', () => {
  expect(applyStatePatch(rec(), { stateId: 'default', expectedUpdatedAt: 'T1', patch: { label: 'X' } }, 'T2'))
    .toMatchObject({ ok: true })
})
it('400 on bad filenames / unknown patch keys / bad status', () => {
  expect(applyStatePatch(rec(), { stateId: 'default', patch: { refImages: ['../evil'] } }, 'T2')).toMatchObject({ ok: false, code: 400 })
  expect(applyStatePatch(rec(), { stateId: 'default', patch: { nope: 1 } as never }, 'T2')).toMatchObject({ ok: false, code: 400 })
  expect(applyStatePatch(rec(), { stateId: 'default', patch: { status: 'gold' as never } }, 'T2')).toMatchObject({ ok: false, code: 400 })
})
it('locking requires a passing full stress result (in patch or already on state)', () => {
  expect(applyStatePatch(rec(), { stateId: 'default', patch: { status: 'locked' } }, 'T2')).toMatchObject({ ok: false, code: 400 })
  expect(applyStatePatch(rec(), {
    stateId: 'default',
    patch: { status: 'locked', stressResult: { passes: 10, total: 10, at: 'T2' } },
  }, 'T2')).toMatchObject({ ok: true })
  expect(applyStatePatch(rec(), {
    stateId: 'default',
    patch: { status: 'locked', stressResult: { passes: 9, total: 10, at: 'T2' } },
  }, 'T2')).toMatchObject({ ok: false, code: 400 })
})
it('content edits on a locked state revert it to draft and clear stressResult', () => {
  const locked = rec()
  locked.states[0]! = { ...locked.states[0]!, status: 'locked', stressResult: { passes: 10, total: 10, at: 'T1' } }
  const r = applyStatePatch(locked, { stateId: 'default', patch: { descriptor: 'new coat' } }, 'T2')
  expect(r.ok && r.record.states[0]!.status).toBe('draft')
  expect(r.ok && r.record.states[0]!.stressResult).toBe(null)
})
it('content edit + re-lock in one patch requires a fresh stressResult, not the stale one on state', () => {
  const locked = rec()
  locked.states[0]! = { ...locked.states[0]!, status: 'locked', stressResult: { passes: 10, total: 10, at: 'T1' } }
  const r = applyStatePatch(locked, { stateId: 'default', patch: { descriptor: 'x', status: 'locked' } }, 'T2')
  expect(r).toMatchObject({ ok: false, code: 400 })
})
// Route-shape guard (Task 9): the route's legacy top-level `refImages`/
// `coverIndex` alias was deleted from characters-local.patch.ts — every
// per-state write now goes through `applyStatePatch` (the `statePatch` body
// branch) or a full `states` replace. There is no server-side code left that
// reads `body.refImages` outside of `body.states[i].refImages`, so a body
// shaped like the old alias (`{ slug, refImages: [...] }`, no `statePatch`
// key) is inert at the route: `applyStatePatch` is simply never invoked, and
// nothing mutates. This is asserted at the unit level here because the pure
// `applyStatePatch` function has no knowledge of "top level" vs "state
// patch" — that framing only exists in the route, which is why this is a
// comment rather than a route-level test (route tests would need Nitro).
it('applyStatePatch never reads/expects a top-level refImages field — it only understands { stateId, patch }', () => {
  const before = rec()
  // Calling applyStatePatch with an (invalid) body shaped like the old
  // top-level alias must fail the same way any other bogus body would —
  // there is no special-case handling of `refImages` outside `patch`.
  const bogus = { stateId: 'default', refImages: ['x.png'] } as unknown as { stateId: string, patch: Record<string, unknown> }
  const r = applyStatePatch(before, { ...bogus, patch: {} }, 'T2')
  // An empty patch is a valid no-op patch — it succeeds, but the stray
  // top-level `refImages` on the body is silently ignored (not applied),
  // proving there's no alias handling inside applyStatePatch itself.
  expect(r.ok && r.record.states[0]!.refImages).toEqual(['a.png'])
})

it('content edit + re-lock with a fresh passing stressResult in the same patch succeeds', () => {
  const locked = rec()
  locked.states[0]! = { ...locked.states[0]!, status: 'locked', stressResult: { passes: 10, total: 10, at: 'T1' } }
  const r = applyStatePatch(locked, {
    stateId: 'default',
    patch: { descriptor: 'x', status: 'locked', stressResult: { passes: 10, total: 10, at: 'T2' } },
  }, 'T2')
  expect(r.ok && r.record.states[0]!.status).toBe('locked')
  expect(r.ok && r.record.states[0]!.stressResult).toMatchObject({ passes: 10, total: 10, at: 'T2' })
})

// Hardening (final-review Finding 4): a content edit landing while a state is
// 'testing' — not just 'locked' — must also demote it and clear its
// stressResult. Without this, a content edit mid-test leaves a stale 10/10
// stressResult sitting on a 'testing' state, which a LATER bare
// { status: 'locked' } patch (no fresh stressResult in the patch) can then
// consume via the `patch.stressResult ?? state.stressResult` fallback —
// locking on a result that never validated the edited content.
it('content edits on a testing state also demote it to draft and clear stressResult', () => {
  const testing = rec()
  testing.states[0]! = { ...testing.states[0]!, status: 'testing', stressResult: { passes: 10, total: 10, at: 'T1' } }
  const r = applyStatePatch(testing, { stateId: 'default', patch: { descriptor: 'new coat' } }, 'T2')
  expect(r.ok && r.record.states[0]!.status).toBe('draft')
  expect(r.ok && r.record.states[0]!.stressResult).toBe(null)
})
it('a bare re-lock after a testing-state content edit 400s — the stale stressResult was cleared', () => {
  const testing = rec()
  testing.states[0]! = { ...testing.states[0]!, status: 'testing', stressResult: { passes: 10, total: 10, at: 'T1' } }
  const afterEdit = applyStatePatch(testing, { stateId: 'default', patch: { descriptor: 'new coat' } }, 'T2')
  expect(afterEdit.ok).toBe(true)
  const relock = applyStatePatch((afterEdit as { ok: true, record: typeof testing }).record, { stateId: 'default', patch: { status: 'locked' } }, 'T3')
  expect(relock).toMatchObject({ ok: false, code: 400 })
})

describe('rework fields in a look patch', () => {
  it('accepts clothes and a look face, cleaned', () => {
    const r = rec()
    const res = applyStatePatch(r, {
      stateId: 'default',
      patch: { clothes: [{ id: 'g1', filename: 'coat.png', name: 'Raincoat' }, { id: 'x' } as any], face: { filename: 'heavier.png', approvedAt: 't' } },
    }, 'now')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const s = res.record.states.find(s => s.id === 'default')!
    expect(s.clothes).toEqual([{ id: 'g1', filename: 'coat.png', name: 'Raincoat' }])
    expect(s.face).toEqual({ filename: 'heavier.png', approvedAt: 't' })
  })
})
