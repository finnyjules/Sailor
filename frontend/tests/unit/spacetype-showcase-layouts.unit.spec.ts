import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as THREE from 'three'
import { SHOWCASE_LAYOUTS, LAYOUT_FAMILIES, getLayout, showcaseEffectId } from '~/lib/spacetype/layouts/index'
import { SPACE_TYPE_EFFECTS, getEffect, rehomeLegacyShowcase } from '~/lib/spacetype/effects'
import { SHOWCASE_SHARED_KEYS } from '~/lib/spacetype/effects/showcase'
import { isShowcaseEffectId } from '~/lib/spacetype/effect'
import { EASINGS, EASING_IDS, EASING_LABELS, loopRatesOf, queuePos, rowPlace, steppedU, travel, travelOf } from '~/lib/spacetype/layouts/util'
import { ringEffect } from '~/lib/spacetype/effects/ring'
import { defaultsFromControls } from '~/lib/spacetype/effect'
import { parseContent } from '~/lib/spacetype/tile'
import { OPEN_MAX } from '~/lib/spacetype/layouts/ring'
import { loopMultiplier } from '~/lib/spacetype/loop'
import { SPACE_TYPE_SECTIONS } from '~/lib/spacetype/sections'
import { showIfVisible } from '~/lib/studio/sections'

// Every layout is its own effect now; `fx` is the entry for a layout id. DEFAULTS is the
// shared dials plus EVERY layout's own, so one params object can drive any layout's place().
const fx = (layoutId: string) => getEffect(showcaseEffectId(layoutId))
const DEFAULTS = defaultsFromControls([...ringEffect.controls, ...SHOWCASE_LAYOUTS.flatMap(l => l.controls)])
const P = (over: Record<string, unknown> = {}) => ({ ...DEFAULTS, speed: 2, ...over }) as any
const NUMS = ['x', 'y', 'z', 'rotY', 'scale'] as const
// A roll/yaw of −π and +π is the same pose; compare angles on the circle.
const sameAngle = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)))

describe('showcase layouts — every layout', () => {
  it('ids are unique and labels are sentence case (no identifiers in the picker)', () => {
    const ids = SHOWCASE_LAYOUTS.map(l => l.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const l of SHOWCASE_LAYOUTS) {
      expect(l.label[0]).toBe(l.label[0]!.toUpperCase())
      // one capital only: "Card tunnel", not "Card Tunnel"
      expect(l.label.slice(1)).toBe(l.label.slice(1).toLowerCase())
    }
  })

  it('no two layouts share a dial key, and none needs gating — a layout is a whole effect', () => {
    const seen = new Set<string>()
    for (const l of SHOWCASE_LAYOUTS) for (const c of l.controls) {
      expect((c as any).showIf, `${l.id}.${c.key}`).toBeUndefined()
      expect(seen.has(c.key)).toBe(false)
      seen.add(c.key)
      expect(SHOWCASE_SHARED_KEYS).not.toContain(c.key)                 // …nor collides with a shared dial
    }
  })

  for (const layout of SHOWCASE_LAYOUTS) {
    describe(layout.id, () => {
      const aspects = [1, 1.5, 0.75, 1, 1.78, 1, 1, 0.56, 1, 1.33, 1]
      const n = aspects.length

      it('places every card at finite numbers, fade within 0…1', () => {
        for (let i = 0; i < n; i++) for (const t of [0, 0.13, 0.5, 0.77, 1]) {
          const tf = layout.place(i, n, P(), t, aspects)
          for (const k of NUMS) expect(Number.isFinite(tf[k])).toBe(true)
          for (const k of ['rotX', 'rotZ'] as const) if (tf[k] !== undefined) expect(Number.isFinite(tf[k])).toBe(true)
          if (tf.opacity !== undefined) { expect(tf.opacity).toBeGreaterThanOrEqual(0); expect(tf.opacity).toBeLessThanOrEqual(1) }
        }
      })

      it('loops seamlessly: t01=0 and t01=1 are the same pose', () => {
        for (let i = 0; i < n; i++) {
          const a = layout.place(i, n, P(), 0, aspects), b = layout.place(i, n, P(), 1, aspects)
          // A card sitting exactly on a wrap can land on either end of its path — but only
          // where it is fully faded, so the jump can't be seen.
          if ((a.opacity ?? 1) < 1e-6 && (b.opacity ?? 1) < 1e-6) continue
          for (const k of ['x', 'y', 'z', 'scale'] as const) expect(b[k]).toBeCloseTo(a[k], 5)
          expect(sameAngle(a.rotY, b.rotY)).toBeLessThan(1e-6)
          expect(sameAngle(a.rotX ?? 0, b.rotX ?? 0)).toBeLessThan(1e-6)
          expect(sameAngle(a.rotZ ?? 0, b.rotZ ?? 0)).toBeLessThan(1e-6)
          expect(b.opacity ?? 1).toBeCloseTo(a.opacity ?? 1, 5)
        }
      })

      it('survives one card and zero speed', () => {
        const tf = layout.place(0, 1, P({ speed: 0 }), 0.4, [1])
        for (const k of NUMS) expect(Number.isFinite(tf[k])).toBe(true)
      })

      it('fractional speeds close over the engine\'s loop multiplier (0.25 → 4 loops)', () => {
        for (const speed of [0.25, 0.5, 0.05, 1.5]) {
          const p = P({ speed })
          const k = loopMultiplier(layout.loopRates?.(p) ?? [])
          expect(k).toBeLessThan(60)   // a real closing loop count, not the best-effort cap
          for (let i = 0; i < n; i++) {
            const a = layout.place(i, n, p, 0, aspects), b = layout.place(i, n, p, k, aspects)
            if ((a.opacity ?? 1) < 1e-6 && (b.opacity ?? 1) < 1e-6) continue
            for (const key of ['x', 'y', 'z', 'scale'] as const) expect(b[key]).toBeCloseTo(a[key], 4)
            expect(sameAngle(a.rotY, b.rotY)).toBeLessThan(1e-5)
            expect(sameAngle(a.rotZ ?? 0, b.rotZ ?? 0)).toBeLessThan(1e-5)
            expect(b.opacity ?? 1).toBeCloseTo(a.opacity ?? 1, 4)
          }
        }
      })

      it('a slow speed really is slower — it is not rounded to a whole trip', () => {
        if (layout.id === 'grid') return   // grid only ripples; covered by its own test
        // Distance every card travels over one loop, sampled finely (the stepped layouts rest
        // between moves, so one short interval can legitimately show no motion). A step where
        // the card is invisible at either end is skipped: that is where a card wraps from one
        // end of its path to the other, which is a jump, not travel.
        const moved = (speed: number) => {
          let d = 0
          const STEPS = 400, p = P({ speed })
          for (let i = 0; i < n; i++) {
            let a = layout.place(i, n, p, 0, aspects)
            for (let s = 1; s <= STEPS; s++) {
              const b = layout.place(i, n, p, s / STEPS, aspects)
              if ((a.opacity ?? 1) > 0.02 && (b.opacity ?? 1) > 0.02) {
                d += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) + Math.abs(b.scale - a.scale)
                  + sameAngle(a.rotY, b.rotY) + sameAngle(a.rotZ ?? 0, b.rotZ ?? 0) + Math.abs((b.opacity ?? 1) - (a.opacity ?? 1))
              }
              a = b
            }
          }
          return d
        }
        expect(moved(0.25)).toBeGreaterThan(0)
        expect(moved(0.25)).toBeLessThan(moved(1))
        expect(moved(0)).toBe(0)
      })
    })
  }
})

describe('showcase layouts — specifics', () => {
  it('globe cards lie on the surface: the yaw+pitch normal points straight out', () => {
    const g = getLayout('globe')
    for (const i of [0, 3, 7, 11]) {
      const tf = g.place(i, 12, P(), 0.2)
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(tf.rotX ?? 0, tf.rotY, tf.rotZ ?? 0, 'YXZ'))
      const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(q)
      const out = new THREE.Vector3(tf.x, tf.y, tf.z).normalize()
      expect(normal.dot(out)).toBeCloseTo(1, 5)
    }
  })

  it('cover flow opens with card 0 square-on in the middle, neighbours turned inward', () => {
    const c = getLayout('coverflow')
    const mid = c.place(0, 8, P(), 0), right = c.place(1, 8, P(), 0), left = c.place(7, 8, P(), 0)
    expect(mid.x).toBeCloseTo(0, 6); expect(mid.rotY).toBeCloseTo(0, 6)
    expect(right.x).toBeGreaterThan(0); expect(right.rotY).toBeLessThan(0)     // faces back toward the middle
    expect(left.x).toBeLessThan(0); expect(left.rotY).toBeGreaterThan(0)
    expect(mid.scale).toBeGreaterThan(right.scale)
    expect(mid.z).toBeGreaterThan(right.z)
  })

  it('stepped travel rests on a slot, then moves exactly one slot', () => {
    const p = P({ speed: 1 })
    // 4 slots → each step spans a quarter loop; the first 30% of a step is rest
    expect(steppedU(0, 4, p, 0.05)).toBeCloseTo(steppedU(0, 4, p, 0), 9)
    expect(steppedU(0, 4, p, 0.25)).toBeCloseTo(0.25, 9)
  })

  it('wheel: card 0 starts at the top, upright; a quarter-turn card lies on its side', () => {
    const w = getLayout('wheel')
    const p = P({ wheelRadius: 5, wheelDrop: 0 })
    const top = w.place(0, 4, p, 0), side = w.place(1, 4, p, 0)
    expect(top.x).toBeCloseTo(0, 6); expect(top.y).toBeCloseTo(5, 6); expect(top.rotZ).toBeCloseTo(0, 6)
    expect(side.x).toBeCloseTo(5, 6); expect(side.y).toBeCloseTo(0, 6); expect(side.rotZ).toBeCloseTo(-Math.PI / 2, 6)
  })

  it('orbit keeps the first card still and large in the middle', () => {
    const o = getLayout('orbit')
    const a = o.place(0, 6, P(), 0), b = o.place(0, 6, P(), 0.37)
    expect([a.x, a.y, a.z]).toEqual([0, 0, 0]); expect([b.x, b.y, b.z]).toEqual([0, 0, 0])
    expect(a.scale).toBeGreaterThan(o.place(1, 6, P(), 0).scale)
  })

  it('rows space by real card widths, so mixed ratios never overlap', () => {
    const aspects = [2, 0.5, 1]
    const xs = aspects.map((_, i) => rowPlace(i, 3, 1, aspects, 1, 0.1, 0))
    expect(xs[0]!.length).toBeCloseTo(2 + 0.5 + 1 + 0.3, 9)
    // unwrapped centres are 1, 2.35, 3.2 → gaps between neighbours' EDGES are all 0.1
    const centre = (i: number) => [1, 2.35, 3.2][i]!
    expect(centre(1) - 0.25 - (centre(0) + 1)).toBeCloseTo(0.1, 9)
    expect(centre(2) - 0.5 - (centre(1) + 0.25)).toBeCloseTo(0.1, 9)
  })

  it('marquee deals cards into rows that travel opposite ways', () => {
    const m = getLayout('marquee')
    const p = P({ marqueeRows: 2, speed: 1 })
    const dx = (i: number) => m.place(i, 8, p, 0.01).x - m.place(i, 8, p, 0).x
    expect(Math.sign(dx(2))).toBe(-Math.sign(dx(3)))   // cards 2 and 3 are in rows 0 and 1
    expect(m.place(0, 8, p, 0).y).toBeGreaterThan(m.place(1, 8, p, 0).y)
  })

  it('grid: Wave 0 is the old static grid; any wave makes it loop', () => {
    const g = getLayout('grid')
    const still = P({ gridWave: 0 })
    expect(g.place(2, 8, still, 0.3)).toEqual(g.place(2, 8, still, 0.8))
    expect(g.loopRates!(still)).toEqual([])
    expect(g.loopRates!(P({ gridWave: 0.4, speed: 2 }))).toEqual([2])
    expect(g.place(2, 8, P({ gridWave: 0.4 }), 0.1).z).not.toBe(0)
  })
})

describe('showcase layouts — the full catalogue', () => {
  it('every layout is a first-class effect: its own id, label, gallery tab and dials', () => {
    expect(SHOWCASE_LAYOUTS.length).toBeGreaterThanOrEqual(35)
    for (const l of SHOWCASE_LAYOUTS) {
      const e = fx(l.id)
      expect(e.id, l.id).toBe(l.id === 'ring' ? 'ring' : `show${l.id}`)
      expect(/^[a-z0-9]+$/.test(e.id)).toBe(true)                       // the backend's id rule
      expect(e.label).toBe(l.label)
      expect(e.gallery).toBe('layouts')
      expect(e.showcaseLayout).toBe(l)
      for (const c of l.controls) expect(e.controls.some(x => x.key === c.key), `${e.id}.${c.key}`).toBe(true)
      expect(e.controls.some(c => c.key === 'layout')).toBe(false)      // no layout dial: the entry IS the layout
    }
  })

  it('each entry is its own module, built by a PURE-annotated call (or every embed bundle carries every layout)', () => {
    // effects/index.ts imports all effect modules; an un-annotated top-level factory call is a
    // side effect Rollup must keep, so Ball's embed would ship the whole Showcase host and all
    // 35 layouts. Caught by bundle sizes once — this keeps it caught.
    const dir = path.resolve(__dirname, '../../app/lib/spacetype/effects')
    const files = fs.readdirSync(dir).filter(f => /^show[A-Z]\w*\.ts$/.test(f)).concat('ring.ts')
    expect(files).toHaveLength(SHOWCASE_LAYOUTS.length)
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8')
      expect(src, f).toMatch(/= \/\* @__PURE__ \*\/ makeShowcaseEffect\(/)
      expect(src.match(/\bid:\s*'([a-z][a-z0-9]*)'/)?.[1], f).toBeTruthy()      // the embed build reads the id off the file
    }
  })

  it('the gallery splits cleanly: Showcase entries on Layouts, everything else on Text', () => {
    for (const e of SPACE_TYPE_EFFECTS) {
      expect(isShowcaseEffectId(e.id), e.id).toBe(e.gallery === 'layouts')
      expect(!!e.showcaseLayout).toBe(e.gallery === 'layouts')
    }
    expect(SPACE_TYPE_EFFECTS.filter(e => e.gallery === 'layouts')).toHaveLength(SHOWCASE_LAYOUTS.length)
    for (const id of ['ribbon', 'cylinder', 'ball', 'pile', 'tunnel', 'spiral', 'cascade', 'turntable']) {
      expect(getEffect(id).gallery ?? 'text', id).toBe('text')         // same-named text effects are untouched
    }
  })

  it('the Layouts tab is grouped: registry order keeps each family together, in the declared order', () => {
    const families = SPACE_TYPE_EFFECTS.filter(e => e.showcaseLayout).map(e => e.showcaseLayout!.family)
    const seen: string[] = []
    for (const f of families) if (seen[seen.length - 1] !== f) seen.push(f)
    expect(new Set(seen).size).toBe(seen.length)                        // no family appears twice (no split section)
    expect(seen).toEqual(LAYOUT_FAMILIES.filter(f => seen.includes(f)))
  })

  it('switching between layouts keeps the work: every shared dial is carried, no layout dial is', () => {
    for (const l of SHOWCASE_LAYOUTS) {
      const e = fx(l.id)
      expect(e.carryKeys).toBe(SHOWCASE_SHARED_KEYS)
      for (const c of e.controls) expect(SHOWCASE_SHARED_KEYS.includes(c.key), `${e.id}.${c.key}`).toBe(!l.controls.some(x => x.key === c.key))
    }
    for (const k of ['content', 'repeat', 'cardSize', 'cardRatio', 'shadow', 'speed', 'motion', 'easing', 'font', 'wordFill']) expect(SHOWCASE_SHARED_KEYS).toContain(k)
    expect(getEffect('ribbon').carryKeys).toBeUndefined()               // text effects still reset on switch
  })

  it('a scene saved while every layout lived under `ring` still draws, and re-homes in the editor', () => {
    expect(rehomeLegacyShowcase('ring', { layout: 'sphere' })).toBe('showsphere')
    expect(rehomeLegacyShowcase('ring', { layout: 'Tunnel' })).toBe('showtunnel')
    expect(rehomeLegacyShowcase('ring', { layout: 'ring' })).toBeNull()
    expect(rehomeLegacyShowcase('ring', {})).toBeNull()
    expect(rehomeLegacyShowcase('ring', { layout: 'nope' })).toBeNull()
    expect(rehomeLegacyShowcase('ribbon', { layout: 'sphere' })).toBeNull()
    // ring itself keeps rendering the saved layout — wherever the scene is drawn un-migrated
    const legacy = { ...defaultsFromControls(ringEffect.controls), layout: 'grid', content: '[{"id":"a","kind":"card","fillKind":"solid"},{"id":"b","kind":"card","fillKind":"solid"}]' } as any
    const root = ringEffect.buildScene(THREE, legacy, new THREE.Texture(), { width: 960, height: 540, imageTextures: new Map() }) as THREE.Group
    ringEffect.update!(0.2, legacy, root)
    expect([root.rotation.x, root.rotation.y, root.rotation.z]).toEqual([0, 0, 0])      // the grid's head-on pose, not the ring's
    const zs = ((root as any).userData.ringState.quads as THREE.Mesh[]).map(q => q.position.x)
    expect(zs.every(Number.isFinite)).toBe(true)                        // grid dials it never saved are backfilled
    expect(ringEffect.loopRates!(legacy)).toEqual(getLayout('grid').loopRates!(P({ speed: 1 })))
  })

  it('a queue shows card 0 first, card 1 next, and moves one card per step', () => {
    const p = P({ speed: 1 })
    expect(queuePos(0, 5, p, 0)).toBe(0)
    expect(queuePos(1, 5, p, 0)).toBe(1)
    expect(queuePos(1, 5, p, 0.2)).toBeCloseTo(0, 9)                   // one fifth of the loop later, card 1 is on show
    expect(queuePos(0, 5, p, 0.1)).toBeCloseTo(4.5, 9)                 // mid-move, card 0 is leaving: wrapped to just under n
  })

  it('one-at-a-time layouts keep exactly one card fully on show at rest', () => {
    for (const id of ['stage', 'deck', 'slide', 'focusshift']) {
      const l = getLayout(id)
      const tfs = Array.from({ length: 6 }, (_, i) => l.place(i, 6, P({ speed: 1 }), 0))
      expect(tfs[0]!.opacity ?? 1).toBe(1)
      const others = tfs.slice(1).filter(t => (t.opacity ?? 1) > 0)
      expect(tfs[0]!.scale).toBeGreaterThanOrEqual(Math.max(0, ...others.map(t => t.scale)))
    }
  })

  it('triple scene opens as the grid, and its pose follows the scene in play', () => {
    const m = getLayout('medley'), g = getLayout('grid'), p = P({ speed: 1 })
    for (const i of [0, 5, 11]) expect(m.place(i, 12, p, 0)).toEqual(g.place(i, 12, p, 0))
    expect(m.pose!(p, 0)).toEqual({ rotX: 0, rotY: 0, rotZ: 0 })       // grid: head-on
    expect(m.pose!(p, 0.5).rotX).toBeCloseTo(-Number(DEFAULTS.ringOpening) * OPEN_MAX, 6)   // mid-loop: the ring's pose
  })

  it('grid motions all rest on the plain grid at Amount 0, and each moves something otherwise', () => {
    const g = getLayout('grid')
    for (const gridMotion of ['wave', 'pop', 'flip', 'spotlight']) {
      const still = g.place(3, 12, P({ gridMotion, gridWave: 0 }), 0.37)
      expect([still.z, still.rotY, still.opacity]).toEqual([0, 0, undefined])
      const samples = Array.from({ length: 40 }, (_, k) => g.place(3, 12, P({ gridMotion, gridWave: 0.5, speed: 1 }), k / 40))
      expect(new Set(samples.map(t => `${t.z.toFixed(4)}|${t.rotY.toFixed(4)}|${t.scale.toFixed(4)}`)).size).toBeGreaterThan(1)
    }
  })

  it('upright/column options swap the travelling axis', () => {
    const cf = getLayout('coverflow')
    const side = cf.place(1, 8, P({ flowAxis: 'vertical' }), 0)
    expect(side.x).toBe(0); expect(side.y).not.toBe(0); expect(side.rotX).not.toBe(0)
    const mq = getLayout('marquee'), pc = P({ marqueeAxis: 'columns', speed: 1 })
    expect(mq.place(0, 8, pc, 0.01).x).toBe(mq.place(0, 8, pc, 0).x)   // a column card keeps its x…
    expect(mq.place(0, 8, pc, 0.01).y).not.toBe(mq.place(0, 8, pc, 0).y)   // …and travels in y
  })
})

describe('showcase motion — Motion, Easing, Hold, There and back', () => {
  const at = (over: Record<string, unknown>, t: number, own: 'glide' | 'step' = 'glide') => travel(P({ speed: 1, ...over }), t, 10, own)

  it('Layout default keeps each layout\'s habit, exactly as before the dial existed', () => {
    expect(at({}, 0.37)).toBeCloseTo(0.37, 12)                                   // a glider glides
    // a stepper rests 30%, moves 40% along smoothstep, rests 30% — the original curve
    for (const t of [0.01, 0.04, 0.05, 0.063, 0.09]) {
      const f = t * 10, g = Math.min(1, Math.max(0, (f - 0.3) / 0.4))
      expect(at({}, t, 'step')).toBeCloseTo((g * g * (3 - 2 * g)) / 10, 12)
    }
    // …and ignores Easing / Hold left over from an earlier Step per card session
    expect(at({ easing: 'bounce', hold: 0.1 }, 0.05, 'step')).toBeCloseTo(at({}, 0.05, 'step'), 12)
  })

  it('Motion overrides the habit both ways', () => {
    expect(at({ motion: 'continuous' }, 0.05, 'step')).toBeCloseTo(0.05, 12)     // a stepper made to glide
    expect(at({ motion: 'stepped' }, 0.01)).toBe(0)                              // a glider made to rest…
    expect(at({ motion: 'stepped' }, 0.1)).toBeCloseTo(0.1, 12)                  // …and land a slot on
  })

  it('Hold sets the share of each step spent at rest; 0 never rests', () => {
    const p = { motion: 'stepped', easing: 'linear' }
    expect(at({ ...p, hold: 0.8 }, 0.035)).toBe(0)                               // still inside the opening rest (40%)
    expect(at({ ...p, hold: 0.2 }, 0.035)).toBeGreaterThan(0)
    expect(at({ ...p, hold: 0 }, 0.037)).toBeCloseTo(0.037, 12)                  // linear, no hold = a glide
  })

  it('every easing starts a step at rest and ends it exactly one slot on', () => {
    expect(EASING_LABELS).toHaveLength(EASING_IDS.length)
    for (const id of EASING_IDS) {
      expect(EASINGS[id]!(0), id).toBeCloseTo(0, 9)
      expect(EASINGS[id]!(1), id).toBeCloseTo(1, 9)
      for (let k = 0; k <= 20; k++) expect(Number.isFinite(EASINGS[id]!(k / 20))).toBe(true)
      expect(at({ motion: 'stepped', easing: id, hold: 0.3 }, 0.2), id).toBeCloseTo(0.2, 9)
    }
    expect(at({ motion: 'stepped', easing: 'overshoot', hold: 0 }, 0.08)).toBeGreaterThan(0.1)   // overshoots its slot on the way
  })

  it('There and back goes out, returns, and closes every loop at any speed', () => {
    for (const speed of [0.3, 1, 2.5]) {
      const p = P({ speed, direction: 'alternate' })
      expect(travelOf(p, 0)).toBeCloseTo(0, 12)
      expect(travelOf(p, 0.5)).toBeCloseTo(speed, 12)                            // furthest out at half-time
      expect(travelOf(p, 1)).toBeCloseTo(0, 12)
      expect(travelOf(p, 0.25)).toBeCloseTo(travelOf(p, 0.75), 12)               // the way back retraces the way out
      expect(loopRatesOf(p)).toEqual([1])                                        // one loop, not 1/speed of them
    }
  })

  it('every layout obeys all of it: seamless under each Motion, Easing and Direction', () => {
    const variants = [
      { motion: 'stepped', easing: 'bounce', hold: 0.2 }, { motion: 'stepped', easing: 'elastic', hold: 0.7 },
      { motion: 'continuous' }, { direction: 'alternate' }, { direction: 'alternate', motion: 'stepped', easing: 'swing' }, { direction: 'ccw', motion: 'stepped' },
    ]
    for (const layout of SHOWCASE_LAYOUTS) for (const v of variants) {
      const p = P({ speed: 1, ...v })
      for (let i = 0; i < 9; i++) {
        const a = layout.place(i, 9, p, 0), b = layout.place(i, 9, p, 1), mid = layout.place(i, 9, p, 0.43)
        for (const k of NUMS) expect(Number.isFinite(mid[k]), `${layout.id} ${JSON.stringify(v)}`).toBe(true)
        if ((a.opacity ?? 1) < 1e-6 && (b.opacity ?? 1) < 1e-6) continue
        for (const k of ['x', 'y', 'z', 'scale'] as const) expect(b[k], `${layout.id} ${k} ${JSON.stringify(v)}`).toBeCloseTo(a[k], 5)
      }
    }
  })

  it('There and back actually reverses a layout: the second half mirrors the first', () => {
    for (const id of ['ring', 'filmstrip', 'wheel', 'tunnel', 'coverflow']) {
      const l = getLayout(id), p = P({ speed: 1, direction: 'alternate' })
      const a = l.place(2, 9, p, 0.2), b = l.place(2, 9, p, 0.8)
      for (const k of ['x', 'y', 'z'] as const) expect(b[k], id).toBeCloseTo(a[k], 6)
    }
  })
})

describe('showcase host', () => {
  const env = { width: 960, height: 540, imageTextures: new Map() }
  // Solid cards only: the unit environment has no DOM, and every other fill (and any word)
  // rasterises through a canvas.
  const SOLIDS = JSON.stringify(Array.from({ length: 12 }, (_, i) => ({
    id: `s${i}`, kind: 'card', fillKind: 'solid', fill: { type: 'solid', a: '#ff0000', b: '#000000', textColor: '#ffffff', angle: 45, density: 8 },
  })))
  // `layout` picks the ENTRY to build with (it is not a param any more).
  const build = ({ layout = 'ring', ...over }: Record<string, unknown> = {}) => {
    const effect = fx(String(layout))
    const params = P({ content: SOLIDS, ...over })
    const root = effect.buildScene(THREE, params, new THREE.Texture(), env)
    effect.update!(0.3, params, root)
    return { root: root as THREE.Group, params, quads: (root as any).userData.ringState.quads as THREE.Mesh[] }
  }

  it('a fresh Showcase opens on a dozen fill cards, each a different fill — no words', () => {
    const items = parseContent(String(DEFAULTS.content))
    expect(items).toHaveLength(12)
    expect(items.every(i => i.kind === 'card' && i.fillKind !== 'image' && i.fill?.type === i.fillKind)).toBe(true)
    expect(new Set(items.map(i => JSON.stringify((i as any).fill))).size).toBe(12)
    expect(new Set(items.map(i => i.id)).size).toBe(12)
  })

  it('the group pose comes from the layout — ring keeps its opening/tilt, a grid is head-on', () => {
    const ring = build({ layout: 'ring' }).root.rotation
    expect(ring.x).toBeCloseTo(-Number(DEFAULTS.ringOpening) * OPEN_MAX, 9)
    expect(ring.z).toBeCloseTo(Number(DEFAULTS.ringTilt), 9)
    const grid = build({ layout: 'grid' }).root.rotation
    expect([grid.x, grid.y, grid.z]).toEqual([0, 0, 0])
    expect(build({ layout: 'iso' }).root.rotation.x).toBeLessThan(-0.5)
  })

  it('every layout dial is live — dragging one re-places the cards, never rebuilds', () => {
    for (const l of SHOWCASE_LAYOUTS) {
      const e = fx(l.id)
      for (const c of l.controls) expect(e.liveKeys, `${e.id}.${c.key}`).toContain(c.key)
      for (const k of e.liveKeys!) expect(e.controls.some(c => c.key === k), `${e.id} liveKey ${k}`).toBe(true)
    }
  })

  it('applies a layout\'s pitch/roll and fade to the card', () => {
    const globe = build({ layout: 'globe' }).quads
    expect(globe.some(q => Math.abs(q.rotation.x) > 0.1)).toBe(true)
    expect(globe.every(q => q.rotation.order === 'YXZ')).toBe(true)
    const tunnel = build({ layout: 'tunnel' }).quads.map(q => (q.material as THREE.MeshBasicMaterial).opacity)
    expect(Math.min(...tunnel)).toBeLessThan(1)
    expect(Math.max(...tunnel)).toBeCloseTo(1, 6)
  })

  it('a faded word fades instead of vanishing (its alphaTest cut tracks opacity)', () => {
    // Word materials cut their glyph with alphaTest 0.5, recorded on the mesh at build. No
    // DOM here to rasterise a real word, so mark a card the way buildScene marks a word.
    const { root, params, quads } = build({ layout: 'ring', backFade: 1 })
    for (const q of quads) q.userData.alphaTest = 0.5
    ringEffect.update!(0.3, params, root)
    const faded = quads.filter(q => (q.material as THREE.MeshBasicMaterial).opacity < 0.5)
    expect(faded.length).toBeGreaterThan(0)
    for (const q of quads) {
      const m = q.material as THREE.MeshBasicMaterial
      expect(m.alphaTest).toBeCloseTo(Math.max(0.001, 0.5 * m.opacity), 9)
    }
  })

  it('back fade works on a layout with no declared depth, and leaves a flat one alone', () => {
    const op = (over: Record<string, unknown>) => build({ backFade: 1, ...over }).quads.map(q => (q.material as THREE.MeshBasicMaterial).opacity)
    const stack = op({ layout: 'filmstrip' })       // angled strip: real depth range, measured per frame
    expect(Math.max(...stack) - Math.min(...stack)).toBeGreaterThan(0.3)
    expect(op({ layout: 'grid', gridWave: 0 }).every(o => o === 1)).toBe(true)
  })

  it('Bend exists only on layouts with a curve to bend round; without it cards stay flat', () => {
    const hasBend = (id: string) => fx(id).controls.some(c => c.key === 'bend')
    for (const id of ['ring', 'globe', 'spiral']) expect(hasBend(id), id).toBe(true)
    for (const id of ['grid', 'coverflow', 'deck']) expect(hasBend(id), id).toBe(false)
    const flat = build({ layout: 'grid', bend: 1 }).quads[0]!
    const pos = (flat.geometry as THREE.PlaneGeometry).attributes.position as THREE.BufferAttribute
    for (let k = 0; k < pos.count; k++) expect(pos.getZ(k)).toBe(0)
    const bent = build({ layout: 'ring', bend: 1 }).quads[0]!
    const bpos = (bent.geometry as THREE.PlaneGeometry).attributes.position as THREE.BufferAttribute
    expect(Array.from({ length: bpos.count }, (_, k) => bpos.getZ(k)).some(z => z !== 0)).toBe(true)
  })

  const shown = (layoutId: string, group: string, state: Record<string, unknown> = {}) =>
    fx(layoutId).controls.filter(c => c.group === group && showIfVisible(c, k => ({ motion: 'auto', content: '[]', ...state } as any)[k])).map(c => c.label)

  it('the panel reads in decision order: Layout, Content, Cards — nothing under "Ribbon" or "Transform"', () => {
    for (const l of SHOWCASE_LAYOUTS) {
      const e = fx(l.id)
      expect(e.leadSections).toEqual(['Layout', 'Content', 'Cards'])
      for (const c of e.controls) expect(['Layout', 'Content', 'Cards', 'Type', 'Look', 'Motion'], `${e.id}.${c.key}`).toContain(c.group)
    }
    for (const name of ['Layout', 'Content', 'Cards']) expect(SPACE_TYPE_SECTIONS).toContain(name)
    const inGroup = (g: string) => ringEffect.controls.filter(c => c.group === g).map(c => c.key)
    expect(inGroup('Content')).toEqual(['content', 'repeat'])
    expect(inGroup('Cards')).toEqual(['cardSize', 'cardRatio', 'cornerRadius', 'padding', 'bend'])
    expect(inGroup('Look')).toEqual(['shadow', 'backFade', 'perspective'])
    expect(inGroup('Type')).toEqual(['font', 'typeWeight', 'typeYScale', 'tracking', 'wordFill'])
  })

  it('the Layout card holds ONLY that layout\'s own dials — its shape is in one place', () => {
    for (const l of SHOWCASE_LAYOUTS) {
      const own = l.controls.filter(c => c.group === 'Layout').map(c => c.key)
      expect(fx(l.id).controls.filter(c => c.group === 'Layout').map(c => c.key), l.id).toEqual(own)
    }
    expect(shown('ring', 'Layout')).toEqual(['Size', 'Opening', 'Tilt'])
    expect(shown('coverflow', 'Layout')).toEqual(['Orientation', 'Spacing', 'Side angle'])
    expect(shown('marquee', 'Layout')).toEqual(['Lanes', 'Lane count', 'Gap'])
    expect(shown('stage', 'Layout')).toEqual([])                        // sized by Card size alone → no Layout card
  })

  it('animation is only authored on the Motion tab — shared dials first, then the layout\'s own', () => {
    for (const l of SHOWCASE_LAYOUTS) {
      expect(fx(l.id).controls.filter(c => c.group === 'Motion').slice(0, 6).map(c => c.key), l.id).toEqual(['speed', 'direction', 'motion', 'easing', 'hold', 'pulse'])
    }
    expect(shown('ring', 'Motion')).toEqual(['Speed', 'Direction', 'Pacing', 'Pulse'])
    expect(shown('grid', 'Motion')).toEqual(['Speed', 'Direction', 'Pacing', 'Pulse', 'Grid motion', 'Amount'])
    expect(shown('iso', 'Motion')).toContain('Swell')
    expect(shown('medley', 'Motion')).toContain('Scene hold')
    expect(shown('ring', 'Motion', { motion: 'stepped' })).toEqual(['Speed', 'Direction', 'Pacing', 'Easing', 'Hold', 'Pulse'])
  })

  it('no two dials on a panel share a name', () => {
    for (const l of SHOWCASE_LAYOUTS) {
      const labels = fx(l.id).controls.map(c => c.label)
      expect(labels.length, `${l.id}: ${labels.join(', ')}`).toBe(new Set(labels).size)
    }
  })

  it('the type dials appear only while the content holds text', () => {
    const font = ringEffect.controls.find(c => c.key === 'font')!
    const withContent = (content: string) => showIfVisible(font, k => ({ content } as any)[k])
    expect(withContent(String(DEFAULTS.content))).toBe(false)                           // a fresh Showcase is all cards
    expect(withContent('[{"id":"w","kind":"word","text":"HI","resolution":"whole"}]')).toBe(true)
    expect(withContent('[{ "id": "w", "kind" : "word" }]')).toBe(true)                  // hand-written spacing
    expect(ringEffect.controls.filter(c => c.group === 'Type').every(c => (c as any).showIf?.matches)).toBe(true)
  })

  it('Pulse swells cards in turn; 0 leaves every card its layout size', () => {
    const sizes = (pulse: number) => build({ layout: 'ring', pulse }).quads.map(q => q.scale.y)
    expect(new Set(sizes(0).map(v => v.toFixed(6))).size).toBe(1)
    const swollen = sizes(1)
    expect(Math.max(...swollen)).toBeGreaterThan(Math.max(...sizes(0)) * 1.2)
    expect(Math.min(...swollen)).toBeCloseTo(Math.min(...sizes(0)), 6)            // most cards are untouched at any moment
  })

  it('on a ring, the card the pulse peaks on is the one facing the camera', () => {
    const { quads, root } = build({ layout: 'ring', pulse: 1, ringOpening: 0, ringTilt: 0 })
    root.updateMatrixWorld(true)
    const biggest = quads.reduce((a, b) => (b.scale.y > a.scale.y ? b : a))
    const frontmost = quads.reduce((a, b) => (b.position.z > a.position.z ? b : a))
    expect(biggest).toBe(frontmost)
  })

  it('every card carries a shadow behind it that follows Shadow and the card\'s own fade', () => {
    const { quads } = build({ layout: 'tunnel', shadow: 0.5 })
    for (const q of quads) {
      const sh = q.userData.shadow as THREE.Mesh
      expect(sh.parent).toBe(q)
      expect(sh.position.z).toBeLessThan(0)                                       // behind the card
      expect((sh.material as THREE.ShaderMaterial).side).toBe(THREE.FrontSide)   // never in front of a card seen from behind
      const strength = (sh.material as THREE.ShaderMaterial).uniforms.uStrength!.value
      expect(strength).toBeCloseTo(0.5 * (q.material as THREE.MeshBasicMaterial).opacity, 9)
      expect(sh.visible).toBe(strength > 0.001)
    }
    expect(build({ shadow: 0 }).quads.every(q => (q.userData.shadow as THREE.Mesh).visible === false)).toBe(true)
  })

  it('a bent card\'s shadow bends with it, so the card never pokes through its own shadow', () => {
    const { quads } = build({ layout: 'ring', bend: 1, shadow: 0.5 })
    const sh = quads[0]!.userData.shadow as THREE.Mesh
    const pos = (sh.geometry as THREE.PlaneGeometry).attributes.position as THREE.BufferAttribute
    expect(Array.from({ length: pos.count }, (_, k) => pos.getZ(k)).some(z => z < -1e-4)).toBe(true)
  })

  it('a doc saved before Shadow existed stays shadowless', () => {
    const params = P({ content: SOLIDS }); delete (params as any).shadow
    const root = ringEffect.buildScene(THREE, params, new THREE.Texture(), env)
    ringEffect.update!(0.3, params, root)
    const quads = (root as any).userData.ringState.quads as THREE.Mesh[]
    expect(quads.every(q => (q.userData.shadow as THREE.Mesh).visible === false)).toBe(true)
  })

  it('Easing and Hold only show under Step per card; the new dials are all live', () => {
    const ctl = (k: string) => ringEffect.controls.find(c => c.key === k) as any
    expect(ctl('easing').showIf).toEqual({ key: 'motion', equals: 'stepped' })
    expect(ctl('hold').showIf).toEqual({ key: 'motion', equals: 'stepped' })
    expect(ctl('motion').optionLabels).toEqual(['Layout default', 'Continuous', 'Step per card'])
    for (const k of ['motion', 'easing', 'hold', 'pulse', 'shadow']) expect(ringEffect.liveKeys).toContain(k)
  })

  it('the pickers show words, not stored values', () => {
    const ctl = (k: string) => ringEffect.controls.find(c => c.key === k) as any
    expect(ctl('direction').optionLabels).toEqual(['Forward', 'Reverse', 'There and back'])
    expect(ctl('cardRatio').optionLabels[0]).toBe('Original')
    for (const e of SPACE_TYPE_EFFECTS.filter(x => x.showcaseLayout)) for (const c of e.controls) {
      if (c.kind === 'select') expect((c as any).optionLabels, `${e.id}.${c.key}`).toHaveLength((c as any).options.length)
    }
  })

})
