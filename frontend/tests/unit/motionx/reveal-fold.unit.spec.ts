import { describe, it, expect } from 'vitest'
import { compileBehaviour, evaluateTracks, pickTrack, type Behaviour, type StoredBehaviour, type Track } from '~/lib/motionx'
import { applyRevealBehaviours, applyMotionxTracks, compileBehaviourForLayer, animatableProperties, MOTION_ONLY_LABELS } from '~/lib/motionx/adapter/frame'
import { SILHOUETTE_KEY_STRIP } from '~/lib/compositor/silhouetteCache'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { MotionReveal } from '~/lib/motionx/reveal'

const layer = (id = 'L') => ({ id, kind: 'rect', x: 0.5, y: 0.5, w: 0.3, h: 0.2, rotation: 0, opacity: 1, fill: '#fff' }) as unknown as LocalLayer
const beh = (params: Record<string, unknown> = {}, start = 1, duration = 2, id = 'b1', layerId = 'L'): StoredBehaviour =>
  ({ id, layerId, kind: 'dither', params, timing: { start, duration } }) as StoredBehaviour
const tracksOf = (b: StoredBehaviour, l = layer(b.layerId)): Track[] =>
  compileBehaviourForLayer(l, b as unknown as Behaviour).map((t) => ({ ...t, behaviourId: b.id }))
const noteOf = (l: LocalLayer) => (l as unknown as { motionReveal?: MotionReveal }).motionReveal
const TARGET = { get: () => undefined, has: () => false }

describe('the dither compiler', () => {
  it('in: ONE number track on `reveal`, 0 → 1 across the bar', () => {
    const tr = compileBehaviour(beh() as unknown as Behaviour, TARGET)
    expect(tr).toHaveLength(1)
    expect(tr[0]!.path).toBe('reveal'); expect(tr[0]!.type).toBe('number')
    expect(tr[0]!.keyframes.map((k) => [k.t, k.value])).toEqual([[1, 0], [3, 1]])
  })
  it('out: 1 → 0', () => {
    const tr = compileBehaviour(beh({ dir: 'out' }) as unknown as Behaviour, TARGET)
    expect(tr[0]!.keyframes.map((k) => k.value)).toEqual([1, 0])
  })
  it('honours params.ease like every other bar', () => {
    const tr = compileBehaviour(beh({ ease: 'linear' }) as unknown as Behaviour, TARGET)
    expect(tr[0]!.keyframes[0]!.ease).toBe('linear')
  })
})

describe('pickTrack', () => {
  const tk = (start: number, id: string): Track => ({ path: 'p', type: 'number', behaviourId: id, keyframes: [{ t: start, value: 0, ease: 'linear' }, { t: start + 1, value: 1, ease: 'linear' }] })
  it('is the rule evaluateTracks already uses: latest STARTED wins, else the earliest lead-in', () => {
    const list = [tk(0, 'a'), tk(2, 'b')]
    expect(pickTrack(list, 1)?.behaviourId).toBe('a')
    expect(pickTrack(list, 2.5)?.behaviourId).toBe('b')
    expect(pickTrack([tk(3, 'late'), tk(2, 'early')], 0)?.behaviourId).toBe('early')
    expect(pickTrack([], 1)).toBeUndefined()
    expect(evaluateTracks(list, 2.5).get('p')).toBeCloseTo(0.5, 9)
  })
})

describe('applyRevealBehaviours', () => {
  it('mid-bar: parks the amount, the dials and the seconds into the bar on a CLONE', () => {
    const b = beh({ style: 'wipe', cell: 20, angle: 90, ease: 'linear' })
    const ls = [layer()]
    const out = applyRevealBehaviours(ls, tracksOf(b), [b], 2)
    expect(out).not.toBe(ls); expect(out[0]).not.toBe(ls[0])
    const n = noteOf(out[0]!)!
    expect(n.amount).toBeCloseTo(0.5, 9); expect(n.elapsed).toBeCloseTo(1, 9)
    expect(n.style).toBe('wipe'); expect(n.cell).toBeCloseTo(0.02, 9); expect(n.angle).toBeCloseTo(Math.PI / 2, 9)
    expect(noteOf(ls[0]!)).toBeUndefined()      // the stored layer is never written
  })
  it('fully shown → the layer is returned BY IDENTITY with no note (a finished entrance costs nothing)', () => {
    const b = beh()
    const ls = [layer()]
    expect(applyRevealBehaviours(ls, tracksOf(b), [b], 3.5)).toBe(ls)
    const spring = beh({ ease: { type: 'spring', bounce: 0.6 } })
    const st = tracksOf(spring)
    for (let t = 3; t < 6; t += 0.05) {
      const n = noteOf(applyRevealBehaviours(ls, st, [spring], t)[0]!)
      if (n) { expect(n.amount).toBeLessThan(1); expect(n.amount).toBeGreaterThanOrEqual(0) }
    }
  })
  it('fully hidden → a note with amount 0 (the painter skips the layer): before an In, after an Out', () => {
    const b = beh()
    expect(noteOf(applyRevealBehaviours([layer()], tracksOf(b), [b], 0.2)[0]!)!.amount).toBe(0)
    const o = beh({ dir: 'out' })
    expect(noteOf(applyRevealBehaviours([layer()], tracksOf(o), [o], 9)[0]!)!.amount).toBe(0)
    expect(applyRevealBehaviours([layer()], tracksOf(o), [o], 0.2)[0]).toBeDefined()
    expect(noteOf(applyRevealBehaviours([layer()], tracksOf(o), [o], 0.2)[0]!)).toBeUndefined()   // Out, before: fully shown
  })
  it('two bars on one layer: the note carries the dials of the bar whose track WINS', () => {
    const first = beh({ style: 'dots' }, 0, 1, 'first'), second = beh({ style: 'wipe', dir: 'out' }, 2, 1, 'second')
    const tracks = [...tracksOf(first), ...tracksOf(second)]
    expect(noteOf(applyRevealBehaviours([layer()], tracks, [first, second], 0.5)[0]!)!.style).toBe('dots')
    const late = noteOf(applyRevealBehaviours([layer()], tracks, [first, second], 2.5)[0]!)!
    expect(late.style).toBe('wipe'); expect(late.out).toBe(true); expect(late.elapsed).toBeCloseTo(0.5, 9)
  })
  it('idle inputs return the same array: no clock, no tracks, no behaviours, other layers, an untagged reveal band', () => {
    const b = beh(); const ls = [layer()]
    expect(applyRevealBehaviours(ls, tracksOf(b), [b], undefined)).toBe(ls)
    expect(applyRevealBehaviours(ls, [], [b], 2)).toBe(ls)
    expect(applyRevealBehaviours(ls, tracksOf(b), [], 2)).toBe(ls)
    expect(applyRevealBehaviours([layer('other')], tracksOf(b), [b], 2)[0]).toBeDefined()
    expect(noteOf(applyRevealBehaviours([layer('other')], tracksOf(b), [b], 2)[0]!)).toBeUndefined()
    const bare = tracksOf(b).map(({ behaviourId: _drop, ...t }) => t as Track)
    expect(applyRevealBehaviours(ls, bare, [b], 2)).toBe(ls)
  })
  it('the ordinary track fold ignores `reveal` (it is not a layer property)', () => {
    const b = beh(); const ls = [layer()]
    expect(applyMotionxTracks(ls, tracksOf(b), 2)).toBe(ls)
  })
  it('`reveal` is NOT offered in Add property, has a sentence-case row label, and is kept out of the outline cache key', () => {
    expect(animatableProperties(layer()).some((p) => p.path.endsWith('.reveal'))).toBe(false)
    expect(MOTION_ONLY_LABELS.reveal).toBe('Reveal')
    expect((SILHOUETTE_KEY_STRIP as readonly string[]).includes('motionReveal')).toBe(true)
  })
})

// Review follow-ups: the edges the first pass left to inspection.
describe('applyRevealBehaviours — edges', () => {
  it('a bar with a delay: the amount and the seconds-in are both measured from when the bar really starts', () => {
    const b = { ...beh({ ease: 'linear' }, 1, 2), timing: { start: 1, duration: 2, delay: 0.5 } } as StoredBehaviour
    const tr = tracksOf(b)
    expect(tr[0]!.keyframes.map((k) => k.t)).toEqual([1.5, 3.5])
    expect(noteOf(applyRevealBehaviours([layer()], tr, [b], 1.2)[0]!)!.amount).toBe(0)       // still waiting
    const n = noteOf(applyRevealBehaviours([layer()], tr, [b], 2.5)[0]!)!
    expect(n.amount).toBeCloseTo(0.5, 9); expect(n.elapsed).toBeCloseTo(1, 9)
  })
  it('exactly at the bar\'s start the layer is hidden; exactly at its end it is fully shown (no note)', () => {
    const b = beh({ ease: 'linear' }); const ls = [layer()]
    expect(noteOf(applyRevealBehaviours(ls, tracksOf(b), [b], 1)[0]!)!.amount).toBe(0)
    expect(applyRevealBehaviours(ls, tracksOf(b), [b], 3)).toBe(ls)
  })
  it('a tagged track whose bar was deleted has no look to draw: ignored, layer by identity', () => {
    const b = beh(); const other = beh({}, 0, 1, 'someone-else', 'other-layer'); const ls = [layer()]
    expect(applyRevealBehaviours(ls, tracksOf(b), [other], 2)).toBe(ls)
  })
  it('a tagged reveal track owned by a NON-dither bar is ignored', () => {
    const b = beh(); const impostor = { ...b, kind: 'fade' } as StoredBehaviour; const ls = [layer()]
    expect(applyRevealBehaviours(ls, tracksOf(b), [impostor], 2)).toBe(ls)
  })
  it('an Out bar under a spring never reports an amount below 0 or a note at/after full', () => {
    const o = beh({ dir: 'out', ease: { type: 'spring', bounce: 0.7 } }); const tr = tracksOf(o)
    for (let t = 0; t < 7; t += 0.05) {
      const n = noteOf(applyRevealBehaviours([layer()], tr, [o], t)[0]!)
      if (n) { expect(n.amount).toBeGreaterThanOrEqual(0); expect(n.amount).toBeLessThan(1); expect(Number.isFinite(n.elapsed)).toBe(true) }
    }
  })
})

describe('a dither bar cannot be opened into keyframes — everywhere the app offers it', () => {
  it('isMotionOnlyPath knows a reveal path from a layer property', async () => {
    const { isMotionOnlyPath } = await import('~/lib/motionx/adapter/frame')
    expect(isMotionOnlyPath('layers.L.reveal')).toBe(true)
    expect(isMotionOnlyPath('layers.L.opacity')).toBe(false)
    expect(isMotionOnlyPath('layers.L.effects.e1.radius')).toBe(false)
  })
  it('the timeline bar\'s Open chip, the inspector\'s button and the modal\'s handler all refuse it', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const src = (p: string) => readFileSync(resolve(__dirname, '../../../app/components/vue-canvas', p), 'utf8')
    const chip = src('compositor/MotionBandTimeline.vue').split('\n').find((l) => l.includes('<button v-if="isBehSel(b)'))!
    expect(chip).toContain('!isMotionOnlyPath(r.path)')
    expect(src('compositor/MotionInspector.vue')).toMatch(/data-testid="beh-open"|v-if="!isTextBeh && behaviour\.kind !== 'dither'"/)
    const modal = src('CompositorModal.vue')
    const fn = modal.slice(modal.indexOf('function openBehaviour('), modal.indexOf('function openBehaviour(') + 600)
    expect(fn.indexOf('isMotionOnlyPath(t.path)')).toBeGreaterThan(-1)
    expect(fn.indexOf('isMotionOnlyPath(t.path)')).toBeLessThan(fn.indexOf('recordHistory()'))
  })
})
