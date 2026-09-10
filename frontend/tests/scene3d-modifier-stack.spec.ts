import { test, expect, type Page } from '@playwright/test'

/**
 * S1 Task 8 — the modifier STACK proven on the running WebGL app (design spec, S1 slice).
 *
 * Byte-identity of the folded geometry is already nailed at the unit level (Task 2: 95/95
 * vertex buffers). This suite proves the two things a unit test cannot: that the stack renders
 * in LIST order (so twist-then-bend ≠ bend-then-twist and two twists ≠ one), that a legacy
 * `modifiers` bag renders identically to the equivalent `modifierStack` through the read-through,
 * and that the real tree + inspector flow drives the stored stack end to end.
 *
 * Instrument: `?state=<doc>` seeds a whole scene (a `modifierStack` now persists through parseDoc,
 * Task 4), `__scene3dSnapshot()` returns one rendered frame as a PNG data URL, and `__scene3dDoc()`
 * returns the live doc. Rendered claims are a CHANGED-PIXEL COUNT between two frames (see
 * `diffPixels`), never a bare string compare — a count separates "the order changed the geometry"
 * from "two loads of the same scene jittered by a few pixels".
 *
 * Which proofs click vs seed (reported in the task summary):
 *  1 order-matters      — SEED (two seeded stacks, rendered)
 *  2 two-twists         — SEED
 *  3 legacy parity      — SEED (bag vs stack, rendered)
 *  4 add + select + tune— CLICK (the "+" menu → row select → real Twist slider)
 *  5 select coercion    — CLICK (the real axis RowSelect; asserts the stored INDEX is a number)
 *  6 duplicate carry    — CLICK (the tree duplicate button; asserts fresh ids + no cross-edit)
 *
 * Headless Chromium draws WebGL through SwiftShader, hence the generous settle wait.
 */

const SETTLE_MS = 3000

// Hand-written instances. sanitizeModifierStack rebuilds every MODIFIER_KIND_PARAMS key from its
// MODIFIER_SPECS default, so an instance only needs the fields it means to set; the rest default
// (twistAxis 1 = Y, bendAxis 2 = Z) exactly as `createModifier` would mint them.
const subdivide = (n: number, id = 'sd') => ({ id: `m-sub-${id}`, kind: 'subdivide', enabled: true, subdivide: n })
const twist = (deg: number, axis = 1, id = 't') => ({ id: `m-twist-${id}`, kind: 'twist', enabled: true, twist: deg, twistAxis: axis })
const bend = (deg: number, axis = 2, id = 'b') => ({ id: `m-bend-${id}`, kind: 'bend', enabled: true, bend: deg, bendAxis: axis })

// One centred box, viewed three-quarter so a twist or bend deforms its silhouette on screen.
const box = (modifierStack?: unknown[], extra?: Record<string, unknown>) => ({
  id: 'box', name: 'Box', kind: 'primitive', primitive: 'box', visible: true,
  position: [0, 0.6, 0], rotation: [0, 0, 0], scale: [1.1, 1.1, 1.1],
  material: { type: 'standard', color: '#d94f3a', roughness: 0.4, metalness: 0 },
  ...(modifierStack ? { modifierStack } : {}),
  ...extra,
})

const scene = (...objects: unknown[]) => ({
  version: 1, background: '#202020', showFloor: false,
  camera: { position: [2.6, 1.9, 3.4], target: [0, 0.6, 0], fov: 40 },
  objects,
})

async function openLab(page: Page, state: { objects: unknown[] }): Promise<void> {
  await page.goto(`/dev/scene3d-lab?state=${encodeURIComponent(JSON.stringify(state))}`)
  await expect
    .poll(() => page.evaluate(() => typeof (window as { __scene3dSnapshot?: unknown }).__scene3dSnapshot === 'function'), { timeout: 30_000 })
    .toBe(true)
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __scene3dDoc(): { objects: unknown[] } }).__scene3dDoc().objects.length), { timeout: 10_000 })
    .toBe(state.objects.length)
  await page.waitForTimeout(SETTLE_MS)
}

const snapshot = (page: Page) => page.evaluate(() => (window as unknown as { __scene3dSnapshot(): string }).__scene3dSnapshot())
const liveDoc = (page: Page) => page.evaluate(() => (window as unknown as { __scene3dDoc(): any }).__scene3dDoc())

/** Count pixels whose summed RGB step exceeds a threshold — a robust "how different are these two
 *  frames" that shrugs off a few SwiftShader-jittered pixels. Both frames come from the same
 *  render path, so there is no cross-path brightness bias to cancel here. */
async function diffPixels(page: Page, a: string, b: string): Promise<number> {
  return page.evaluate(async ({ a, b }) => {
    const load = async (u: string) => {
      const img = new Image(); img.src = u; await img.decode()
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
      const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0)
      return ctx.getImageData(0, 0, c.width, c.height)
    }
    const A = await load(a), B = await load(b)
    const len = Math.min(A.data.length, B.data.length)
    let n = 0
    for (let i = 0; i < len; i += 4) {
      const d = Math.abs(A.data[i]! - B.data[i]!) + Math.abs(A.data[i + 1]! - B.data[i + 1]!) + Math.abs(A.data[i + 2]! - B.data[i + 2]!)
      if (d > 24) n++
    }
    return n
  }, { a, b })
}

function watchConsole(page: Page): string[] {
  const errs: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()) })
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`))
  return errs
}

// The dev lab page emits a benign SSR "Hydration completed but contains mismatches" on first
// mount (the known dev-harness hydration race); a real stage throw or GLSL failure is anything
// else. Assert on what's left after dropping that one known line.
const realErrors = (errs: string[]): string[] =>
  errs.filter((e) => !/Hydration completed but contains mismatches/.test(e))

test.describe('3D Studio modifier stack', () => {
  // The rendered floor: a real geometry change moves thousands of pixels; the noise between two
  // loads of one scene is a few dozen at most (measured 0 here). 400 sits comfortably between.
  const CHANGED = 400
  const PARITY = 200

  test('order matters: twist-then-bend renders differently from bend-then-twist', async ({ page }) => {
    const errs = watchConsole(page)
    await openLab(page, scene(box([subdivide(4), twist(90), bend(60)])))
    const twistFirst = await snapshot(page)
    await openLab(page, scene(box([subdivide(4), bend(60), twist(90)])))
    const bendFirst = await snapshot(page)
    const d = await diffPixels(page, twistFirst, bendFirst)
    console.log(`[order] twist-then-bend vs bend-then-twist changed=${d}`)
    expect(realErrors(errs), `console errors: ${realErrors(errs).join(' | ')}`).toEqual([])
    expect(d).toBeGreaterThan(CHANGED)
  })

  test('two twists apply more total twist than one', async ({ page }) => {
    await openLab(page, scene(box([subdivide(4), twist(45, 1, 'a')])))
    const one = await snapshot(page)
    await openLab(page, scene(box([subdivide(4), twist(45, 1, 'a'), twist(45, 1, 'b')])))
    const two = await snapshot(page)
    const d = await diffPixels(page, one, two)
    console.log(`[two-twists] one vs two changed=${d}`)
    expect(d).toBeGreaterThan(CHANGED)
  })

  test('legacy modifiers bag renders identically to the equivalent modifierStack', async ({ page }) => {
    // Read-through parity: the engine folds the legacy bag through modifierStackOf, so the same
    // twist reaches the geometry either way. Same single-box scene, only the storage shape differs.
    await openLab(page, scene(box(undefined, { modifiers: { twist: 90 } })))
    const legacy = await snapshot(page)
    await openLab(page, scene(box([twist(90, 1)])))
    const stack = await snapshot(page)
    const parity = await diffPixels(page, legacy, stack)

    // Sanity: the twist is actually PRESENT (both differ from a plain box), so parity is not
    // "two undeformed boxes happen to match".
    await openLab(page, scene(box()))
    const plain = await snapshot(page)
    const twistVsPlain = await diffPixels(page, stack, plain)
    console.log(`[parity] legacy-vs-stack=${parity} twist-vs-plain=${twistVsPlain}`)
    expect(twistVsPlain).toBeGreaterThan(CHANGED)
    expect(parity).toBeLessThan(PARITY)
  })

  test('the tree flow: add Twist from the + menu, select it, tune the slider (INTERACTIVE)', async ({ page }) => {
    const errs = watchConsole(page)
    await openLab(page, scene(box()))
    const before = await snapshot(page)

    // Open the object's add menu and pick Twist.
    await page.locator('[data-testid="add-treatment"]').first().click()
    await page.locator('[data-testid="add-modifier-item"][data-kind="twist"]').click()

    // The row appears and auto-selects, so the modifier inspector shows a Twist card.
    await expect(page.locator('[data-testid="modifier-row"][data-kind="twist"]')).toBeVisible()
    await expect(page.locator('[data-testid="modifier-breadcrumb"]')).toBeVisible()

    // A fresh twist is 0 (identity). Drive the REAL Twist slider by typed entry — click its value
    // readout to open the row's input, type a value, commit with Enter (StudioRow.up → editing →
    // RowSlider.commit → parseTyped). 150° (deliberately NOT a whole 360° turn, which would wind
    // this low-poly box's corners right back to where they started and read as no change on screen).
    const twistRow = page.locator('div.group:has([role="slider"][aria-label="Twist"])')
    await twistRow.locator('[data-row-value]').click()
    const input = twistRow.locator('input')
    await input.fill('150')
    await input.press('Enter')

    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __scene3dDoc(): any }).__scene3dDoc().objects[0].modifierStack?.[0]?.twist))
      .toBe(150)
    const doc = await liveDoc(page)
    expect(typeof doc.objects[0].modifierStack[0].twist).toBe('number')

    await page.waitForTimeout(SETTLE_MS)
    const after = await snapshot(page)
    const d = await diffPixels(page, before, after)
    console.log(`[tree-flow] twist 0→150 changed=${d}`)
    expect(realErrors(errs), `console errors: ${realErrors(errs).join(' | ')}`).toEqual([])
    expect(d).toBeGreaterThan(CHANGED)
  })

  test('the axis select stores the numeric INDEX, not the label, through the real RowSelect (INTERACTIVE)', async ({ page }) => {
    // Seed a visibly-twisted box (subdivide so the axis change reads on screen), select its Twist
    // row, then drive the real axis <select> from Y (index 1, seeded) to X (index 0).
    await openLab(page, scene(box([subdivide(4), twist(90, 1)])))
    await page.locator('[data-testid="modifier-row"][data-kind="twist"]').click()
    await expect(page.locator('[data-testid="modifier-breadcrumb"]')).toBeVisible()
    const before = await snapshot(page)

    await page.getByLabel('Twist axis').selectOption('x')

    const twistOf = (doc: any) => doc.objects[0].modifierStack.find((m: any) => m.kind === 'twist')
    await expect.poll(async () => twistOf(await liveDoc(page)).twistAxis).toBe(0)
    const stored = twistOf(await liveDoc(page)).twistAxis
    expect(typeof stored).toBe('number') // the INDEX, never the label string 'x'

    await page.waitForTimeout(SETTLE_MS)
    const after = await snapshot(page)
    const d = await diffPixels(page, before, after)
    console.log(`[select-coercion] twistAxis Y→X changed=${d} stored=${stored} (${typeof stored})`)
    expect(d).toBeGreaterThan(CHANGED)
  })

  test('a duplicated object carries a fresh-id stack and edits do not cross (INTERACTIVE)', async ({ page }) => {
    await openLab(page, scene(box([subdivide(4), twist(90, 1)])))

    // Duplicate through the tree's own duplicate button on the box row.
    const row = page.locator('[data-testid="object-row"][data-object-id="box"]')
    await row.hover()
    await row.locator('button:has(svg.lucide-copy)').click()

    await expect.poll(() => page.evaluate(() => (window as unknown as { __scene3dDoc(): any }).__scene3dDoc().objects.length)).toBe(2)
    const dup = await liveDoc(page)
    const [orig, copy] = dup.objects
    const origTwist = orig.modifierStack.find((m: any) => m.kind === 'twist')
    const copyTwist = copy.modifierStack.find((m: any) => m.kind === 'twist')

    // Both carry a twist row, and the copy's ids are FRESH (a shared id would make one edit drive
    // both — the cloneTreatments lesson).
    expect(origTwist.twist).toBe(90)
    expect(copyTwist.twist).toBe(90)
    expect(copy.id).not.toBe(orig.id)
    expect(copyTwist.id).not.toBe(origTwist.id)
    expect(copy.modifierStack.map((m: any) => m.id)).not.toEqual(orig.modifierStack.map((m: any) => m.id))

    // Both render twisted: the two-box scene differs from the same two boxes with no modifiers.
    const twisted = await snapshot(page)
    await openLab(page, scene(box(undefined, { id: 'box' }), box(undefined, { id: 'box2', position: [0.5, 0.6, 0.5] })))
    const plainPair = await snapshot(page)
    const twistVsPlain = await diffPixels(page, twisted, plainPair)
    console.log(`[duplicate] pair twist-vs-plain=${twistVsPlain}`)
    expect(twistVsPlain).toBeGreaterThan(CHANGED)

    // Editing the ORIGINAL's twist must not touch the copy's.
    await openLab(page, scene(box([subdivide(4), twist(90, 1)]))) // reload clean, then re-duplicate
    await page.locator('[data-testid="object-row"][data-object-id="box"]').hover()
    await page.locator('[data-testid="object-row"][data-object-id="box"] button:has(svg.lucide-copy)').click()
    await expect.poll(() => page.evaluate(() => (window as unknown as { __scene3dDoc(): any }).__scene3dDoc().objects.length)).toBe(2)

    // Select the ORIGINAL box's twist row (data-object-id pins it to the seeded id) and crank it.
    await page.locator('[data-testid="modifier-row"][data-object-id="box"][data-kind="twist"]').click()
    const slider = page.getByRole('slider', { name: 'Twist', exact: true })
    await slider.focus()
    await slider.press('End')

    await expect
      .poll(async () => {
        const d = await liveDoc(page)
        return d.objects.find((o: any) => o.id === 'box').modifierStack.find((m: any) => m.kind === 'twist').twist
      })
      .toBe(360)
    const after = await liveDoc(page)
    const origAfter = after.objects.find((o: any) => o.id === 'box')
    const copyAfter = after.objects.find((o: any) => o.id !== 'box')
    console.log(`[duplicate] after edit orig.twist=${origAfter.modifierStack.find((m: any) => m.kind === 'twist').twist} copy.twist=${copyAfter.modifierStack.find((m: any) => m.kind === 'twist').twist}`)
    expect(origAfter.modifierStack.find((m: any) => m.kind === 'twist').twist).toBe(360)
    expect(copyAfter.modifierStack.find((m: any) => m.kind === 'twist').twist).toBe(90) // unchanged
  })
})
