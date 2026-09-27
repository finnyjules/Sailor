// tests/pen-solve-speed.spec.ts
// A drag on a large connected drawing with the REAL mouse keeps up: on the
// fills suites' 161-piece petal ring and on a 160-piece filleted star (every
// line tangent to the arcs it joins, every arc true), 30 pointer moves take
// well under a few seconds and no frame stalls (was ~14 s for 30 moves with
// frames up to 6 s, nearly all of it in the dense solve), the point follows
// the pointer and every rule still holds.
// __sketchDraw only sets the drawing up and reads it back.
import { test, expect, type Page } from '@playwright/test'

const META = process.platform === 'darwin' ? 'Meta' : 'Control'
async function open(page: Page) {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)
}
const svg = (page: Page) => page.locator('svg[data-pen-overlay]')
// drawing → page px on the pen page (34 px/unit, y up, origin at (40, 400) of the board)
async function at(page: Page, x: number, y: number) {
  const b = (await svg(page).boundingBox())!
  return { x: b.x + 40 + 34 * x, y: b.y + 400 - 34 * y }
}
const doc = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify((window as any).__sketchDraw.doc)))
const load = (page: Page, raw: unknown) => page.evaluate((r) => (window as any).__sketchDraw.load(r), raw)

type Raw = { entities: any[]; constraints: any[] }
const CX = 9, CY = 5.2
// the drag: outward from the grabbed point
const DX = 0.6, DY = -0.45

/** 64 petals of two arcs round a circle, a spoke to every other petal (161 pieces) */
function petalRing(): Raw {
  const entities: any[] = [{ id: 'O', kind: 'point', x: CX, y: CY }, { id: 'ci', kind: 'circle', center: 'O', r: 4 }]
  const constraints: any[] = []
  for (let k = 0; k < 64; k++) {
    const a0 = (k / 64) * Math.PI * 2, a1 = ((k + 2) / 64) * Math.PI * 2, am = (a0 + a1) / 2
    const P = (r: number, a: number) => ({ x: CX + r * Math.cos(a), y: CY + r * Math.sin(a) })
    entities.push(
      { id: `s${k}`, kind: 'point', ...P(4, a0) }, { id: `e${k}`, kind: 'point', ...P(4, a1) },
      { id: `i${k}`, kind: 'point', ...P(3.6, am) }, { id: `o${k}`, kind: 'point', ...P(5.6, am) },
      { id: `P${k}`, kind: 'path', anchors: [`s${k}`, `e${k}`], segments: [{ kind: 'arc', center: `i${k}`, sweep: 1 }, { kind: 'arc', center: `o${k}`, sweep: 1 }], closed: true },
    )
    constraints.push(
      { id: `ki${k}`, kind: 'equalDist', refs: [`i${k}`, `s${k}`, `i${k}`, `e${k}`] },
      { id: `ko${k}`, kind: 'equalDist', refs: [`o${k}`, `e${k}`, `o${k}`, `s${k}`] },
    )
    if (k % 2 === 0) entities.push({ id: `l${k}`, kind: 'line', p1: 'O', p2: `s${k}` })
  }
  return { entities, constraints }
}

/** an 80-point star with every corner rounded: one closed path of 80 arcs and
 *  80 lines, each line tangent to both arcs it joins (160 pieces) */
function filletedStar(): Raw {
  const N = 80, rho = 0.2
  const V = Array.from({ length: N }, (_, k) => {
    const a = (k / N) * Math.PI * 2, r = k % 2 ? 4.2 : 5.4
    return { x: CX + r * Math.cos(a), y: CY + r * Math.sin(a) }
  })
  const unit = (x: number, y: number) => { const l = Math.hypot(x, y); return { x: x / l, y: y / l } }
  const entities: any[] = [], constraints: any[] = [], anchors: string[] = [], segments: any[] = []
  for (let k = 0; k < N; k++) {
    const v = V[k]!, p = V[(k + N - 1) % N]!, n = V[(k + 1) % N]!
    const u1 = unit(p.x - v.x, p.y - v.y), u2 = unit(n.x - v.x, n.y - v.y)
    const half = Math.acos(u1.x * u2.x + u1.y * u2.y) / 2
    const t = rho / Math.tan(half), b = unit(u1.x + u2.x, u1.y + u2.y), h = rho / Math.sin(half)
    entities.push(
      { id: `S${k}`, kind: 'point', x: v.x + u1.x * t, y: v.y + u1.y * t },
      { id: `E${k}`, kind: 'point', x: v.x + u2.x * t, y: v.y + u2.y * t },
      { id: `C${k}`, kind: 'point', x: v.x + b.x * h, y: v.y + b.y * h },
    )
    // outer corners turn left (anticlockwise round the star), inner ones right
    anchors.push(`S${k}`, `E${k}`)
    segments.push({ kind: 'arc', center: `C${k}`, sweep: k % 2 ? 0 : 1 }, { kind: 'line' })
    constraints.push({ id: `q${k}`, kind: 'equalDist', refs: [`C${k}`, `S${k}`, `C${k}`, `E${k}`] })
  }
  entities.push({ id: 'STAR', kind: 'path', anchors, segments, closed: true })
  for (let k = 0; k < N; k++) {
    const k1 = (k + 1) % N
    constraints.push(
      { id: `ta${k}`, kind: 'tangentLineArc', refs: [`E${k}`, `S${k1}`, `C${k}`, `E${k}`] },
      { id: `tb${k}`, kind: 'tangentLineArc', refs: [`E${k}`, `S${k1}`, `C${k1}`, `S${k1}`] },
    )
  }
  return { entities, constraints }
}

// the rules' largest miss, recomputed from the drawing read back
function worstMiss(d: Raw): number {
  const pts = new Map(d.entities.filter(e => e.kind === 'point').map(e => [e.id, e]))
  let worst = 0
  for (const c of d.constraints) {
    const [a, b, cc, s] = c.refs.map((r: string) => pts.get(r))
    if (c.kind === 'equalDist') worst = Math.max(worst, Math.abs(Math.hypot(b.x - a.x, b.y - a.y) - Math.hypot(s.x - cc.x, s.y - cc.y)))
    else if (c.kind === 'tangentLineArc') {
      const L = Math.hypot(b.x - a.x, b.y - a.y)
      const off = Math.abs((b.x - a.x) * (cc.y - a.y) - (b.y - a.y) * (cc.x - a.x)) / L
      worst = Math.max(worst, Math.abs(off - Math.hypot(s.x - cc.x, s.y - cc.y)))
    }
  }
  return worst
}

// the longest gap between two animation frames while `run` goes
async function longestFrame(page: Page, run: () => Promise<void>): Promise<number> {
  await page.evaluate(() => {
    const w = window as any
    w.__gap = { last: performance.now(), max: 0, on: true }
    const tick = (t: number) => { const g = w.__gap; if (!g.on) return; g.max = Math.max(g.max, t - g.last); g.last = t; requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
  })
  await run()
  return page.evaluate(() => { const g = (window as any).__gap; g.on = false; return g.max })
}

for (const [name, make, grab, pieces] of [
  ['161-piece petal ring', petalRing, 's0', 161],
  ['160-piece filleted star', filletedStar, 'C0', 160],
] as const) {
  test(`dragging a point of the ${name} with the real mouse keeps up, and every rule holds`, async ({ page }) => {
    await open(page)
    const raw = make()
    expect(raw.entities.filter(e => e.kind !== 'point').reduce((n, e) => n + (e.kind === 'path' ? e.segments.length : 1), 0)).toBe(pieces)
    await load(page, raw)
    await page.keyboard.press('v')
    const p0 = raw.entities.find(e => e.id === grab)!
    const from = await at(page, p0.x, p0.y), to = await at(page, p0.x + DX, p0.y + DY)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    // ⌘ held while moving: no snapping — at 34 px a unit the ring's points
    // sit ~13 px apart, so the pointer would join a neighbour on the way
    await page.keyboard.down(META)
    let ms = 0
    const gap = await longestFrame(page, async () => {
      const t = Date.now()
      await page.mouse.move(to.x, to.y, { steps: 30 })
      ms = Date.now() - t
    })
    await page.mouse.up()
    await page.keyboard.up(META)
    // eslint-disable-next-line no-console
    console.log(`[pen solve speed] ${name}: 30 moves ${ms} ms, longest frame ${gap.toFixed(0)} ms`)
    expect(ms).toBeLessThan(3000)     // was ~14 s
    expect(gap).toBeLessThan(250)     // was up to 6 s
    const d = await doc(page)
    // the press takes the point under it (on the petal ring s0 sits on e62):
    // that point ends under the pointer
    const want = { x: p0.x + DX, y: p0.y + DY }
    const taken = d.entities.filter((e: any) => e.kind === 'point')
      .sort((a: any, b: any) => Math.hypot(a.x - want.x, a.y - want.y) - Math.hypot(b.x - want.x, b.y - want.y))[0]
    const was = raw.entities.find(e => e.id === taken.id)!
    expect(Math.hypot(was.x - p0.x, was.y - p0.y)).toBeLessThan(6 / 34)   // it was under the press
    expect(Math.hypot(taken.x - want.x, taken.y - want.y)).toBeLessThan(0.01)
    expect(worstMiss(d)).toBeLessThan(1e-3)
    await expect(page.locator('[data-status]')).not.toContainText('NOT converged')
  })
}
