# Shape Studio Background Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Shape Studio a document-level background (solid / gradient / image / shader, plus explicit transparent) that reaches the editor preview, PNG bake, live Frame source, and SVG export.

**Architecture:** Add one `background: Paint | null` field to `GeoStudioDoc`. Paint it as a full-output rect at the top of `drawToCanvas` (canvas) and as a leading `<rect>` in `studioToSvg` (SVG). Async (image/shader) backgrounds join the existing warm pass. A `FillControl` in the editor's document-settings block edits it; `null` = transparent.

**Tech Stack:** Nuxt 4 / Vue 3 / TypeScript, Vitest (`environment: 'node'` — no DOM/canvas/Path2D; tests use a mock 2D context and SVG-string assertions), existing `Paint` + `resolvePaintCanvas` + `paintToVectorPaint` machinery.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-04-shape-studio-background-design.md`.
- Transparent is canonically `null`. `drawToCanvas` and the SVG path ALSO treat `'none'`/`''` as transparent (defensive); the doc validator collapses `'none'`/`''` → `null`.
- Backward compatibility is non-negotiable: every previously saved doc has no `background`, must load as `null`, and must render byte-identical to today. The new `drawToCanvas` param is optional and last.
- `Paint = string | Gradient | Fill | ImageFill` (from `~/lib/compositor/paint`).
- Run tests from `frontend/`: `npx vitest run <path>`.
- Commit messages end with the Co-Authored-By trailer:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- Stage only the files each task names (parallel sessions share this working tree). Commit to `main` directly. Never `git stash`.

---

### Task 1: Data model — `background` on `GeoStudioDoc`

**Files:**
- Modify: `frontend/app/lib/geoshape/studio.ts` (interface `GeoStudioDoc` ~L60-69, `defaultDoc` ~L141-148, `mergeStudioDoc` ~L151-162, `studioDocFromPersisted` legacy branch ~L173-180)
- Test: `frontend/tests/unit/geoshape-studio-doc.unit.spec.ts` (existing — append)

**Interfaces:**
- Consumes: `Paint` (already imported in studio.ts via config re-export; confirm/import from `~/lib/compositor/paint` if not).
- Produces: `GeoStudioDoc.background: Paint | null`; `mergeStudioDoc`/`defaultDoc`/`studioDocFromPersisted` all set it. A module-private `normalizeBackground(raw: unknown): Paint | null`.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/tests/unit/geoshape-studio-doc.unit.spec.ts` (import `mergeStudioDoc`, `defaultDoc` if not already):

```ts
describe('GeoStudioDoc background', () => {
  it('defaults a missing background to null (transparent)', () => {
    expect(mergeStudioDoc({ layers: [] }).background).toBeNull()
    expect(defaultDoc().background).toBeNull()
  })

  it('collapses the none-sentinels to null', () => {
    expect(mergeStudioDoc({ background: 'none' }).background).toBeNull()
    expect(mergeStudioDoc({ background: '' }).background).toBeNull()
    expect(mergeStudioDoc({ background: null }).background).toBeNull()
  })

  it('round-trips a solid-colour background', () => {
    expect(mergeStudioDoc({ background: '#112233' }).background).toBe('#112233')
  })

  it('round-trips a gradient background object', () => {
    const g = { type: 'linear', angle: 45, stops: [{ offset: 0, color: '#000' }, { offset: 1, color: '#fff' }] }
    expect(mergeStudioDoc({ background: g }).background).toEqual(g)
  })

  it('migrates a legacy single-mark blob with a null background', () => {
    // studioDocFromPersisted is already imported by this suite for other tests.
    expect(studioDocFromPersisted({ config: { shape: 'hexagon' } }).background).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/geoshape-studio-doc.unit.spec.ts`
Expected: FAIL — `background` is `undefined`, not `null` (property does not exist yet).

- [ ] **Step 3: Implement the field, default, validator, migration**

In `frontend/app/lib/geoshape/studio.ts`:

Add to the `GeoStudioDoc` interface (after `seed`):

```ts
  /** Full-composite background painted behind every layer. `null` = transparent
   *  (historical behaviour). A `Paint` fills the entire output rect. */
  background: Paint | null
```

Add the normaliser near the other validators (after `mergeOverlap`):

```ts
/** A background is any Paint, or null for transparent. The none-sentinels a
 *  paint picker can emit ('none'/'') collapse to null so "transparent" has one
 *  canonical stored form. */
export function normalizeBackground(raw: unknown): Paint | null {
  if (raw == null || raw === 'none' || raw === '') return null
  if (typeof raw === 'string' || typeof raw === 'object') return raw as Paint
  return null
}
```

In `defaultDoc()`'s returned object add: `background: null,`

In `mergeStudioDoc`'s returned object add: `background: normalizeBackground(o.background),`

In `studioDocFromPersisted`'s legacy `p.config` branch returned object add: `background: null,`

Ensure `Paint` is imported at the top of studio.ts (it is used by `mergeConfig`'s types already via config import; if `Paint` is not in scope, add `import type { Paint } from '~/lib/compositor/paint'`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/geoshape-studio-doc.unit.spec.ts`
Expected: PASS (all, including the pre-existing tests in the file).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/lib/geoshape/studio.ts frontend/tests/unit/geoshape-studio-doc.unit.spec.ts
git commit -m "feat(shape-studio): add document background field to GeoStudioDoc

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Canvas render — background paint + warm helper

**Files:**
- Modify: `frontend/app/lib/geoshape/render.ts` (`drawToCanvas` ~L392, plus a new `studioWarmPaints` export near `shapePaints` ~L458)
- Test: `frontend/tests/unit/geoshape-render.unit.spec.ts` (existing — append)

**Interfaces:**
- Consumes: `Paint`, `resolvePaintCanvas` (aliased `resolvePaintCanvas`), `STILL_FIELD`, `shapePaints` — all already in render.ts.
- Produces:
  - `drawToCanvas(shapes, ctx, w, h, pad = 0, background: Paint | null = null): void`
  - `studioWarmPaints(shapes: VectorShape[], background: Paint | null): Paint[]`

- [ ] **Step 1: Write the failing tests**

Append to `frontend/tests/unit/geoshape-render.unit.spec.ts`. A tiny mock 2D context records `fillStyle` assignments and `fillRect` calls; every other method drawToCanvas touches is a no-op (empty shapes means the Path2D shape-loop never runs, so this is safe in the node env):

```ts
import { drawToCanvas, studioWarmPaints } from '~/lib/geoshape/render'

function mockCtx() {
  const calls: any = { fillRectArgs: [], styles: [] }
  const ctx: any = {
    _fillStyle: null,
    set fillStyle(v: any) { this._fillStyle = v; calls.styles.push(v) },
    get fillStyle() { return this._fillStyle },
    clearRect() {}, save() {}, restore() {}, translate() {}, scale() {},
    fill() {}, stroke() {}, set strokeStyle(_v: any) {}, set lineWidth(_v: any) {},
    fillRect(x: number, y: number, w: number, h: number) { calls.fillRectArgs.push([x, y, w, h]) },
  }
  return { ctx, calls }
}

describe('drawToCanvas background', () => {
  it('paints a solid background over the whole output rect', () => {
    const { ctx, calls } = mockCtx()
    drawToCanvas([], ctx, 200, 100, 0, '#ff8800')
    expect(calls.fillRectArgs).toContainEqual([0, 0, 200, 100])
    expect(calls.styles).toContain('#ff8800')
  })

  it('paints nothing for a null background (transparent, the default)', () => {
    const { ctx, calls } = mockCtx()
    drawToCanvas([], ctx, 200, 100, 0, null)
    expect(calls.fillRectArgs).toEqual([])
  })

  it('treats the none-sentinel as transparent', () => {
    const { ctx, calls } = mockCtx()
    drawToCanvas([], ctx, 200, 100, 0, 'none' as any)
    expect(calls.fillRectArgs).toEqual([])
  })

  it('omitting the background arg stays transparent (back-compat)', () => {
    const { ctx, calls } = mockCtx()
    drawToCanvas([], ctx, 200, 100, 0)
    expect(calls.fillRectArgs).toEqual([])
  })
})

describe('studioWarmPaints', () => {
  const img = { type: 'image', src: 'x.png' } as any
  it('appends an image background to the shape paints', () => {
    expect(studioWarmPaints([], img)).toContain(img)
  })
  it('appends a solid background too (harmless; hasAsyncPaint filters it)', () => {
    expect(studioWarmPaints([], '#000')).toContain('#000')
  })
  it('omits a null background', () => {
    expect(studioWarmPaints([], null)).toEqual([])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/geoshape-render.unit.spec.ts`
Expected: FAIL — `drawToCanvas` ignores the 6th arg (no `fillRect`), and `studioWarmPaints` is not exported.

- [ ] **Step 3: Implement**

In `frontend/app/lib/geoshape/render.ts`, change the `drawToCanvas` signature and add the background paint immediately after the existing `ctx.clearRect(0, 0, w, h)` and BEFORE `const b = contentBounds(shapes)`:

```ts
export function drawToCanvas(
  shapes: VectorShape[], ctx: CanvasRenderingContext2D,
  w: number, h: number, pad = 0, background: Paint | null = null,
): void {
  ctx.clearRect(0, 0, w, h)
  // Document background: a full-output rect behind the padding frame and every
  // shape. Painted in the UNTRANSFORMED device frame (before the fit/centre
  // transform below) so it spans the whole canvas, not the mark's box. `null`
  // and the 'none'/'' sentinels stay transparent (the historical behaviour).
  if (background && background !== 'none') {
    if (typeof background === 'string') {
      ctx.fillStyle = background
      ctx.fillRect(0, 0, w, h)
    } else {
      const style = resolvePaintCanvas(ctx, background as Paint, { w, h }, STILL_FIELD)
      ctx.fillStyle = (style as any) ?? FALLBACK_FILL
      ctx.fillRect(0, 0, w, h)
    }
  }
  const b = contentBounds(shapes)
  // ... unchanged remainder ...
```

Add `studioWarmPaints` next to `shapePaints` (~L469):

```ts
/** The paints a studio doc needs warmed before a real paint/rasterize: every
 *  shape's authored paint (via `shapePaints`) plus the document background.
 *  Solid/null entries are harmless — `hasAsyncPaint` filters them; only
 *  image/shader entries actually cost a warm. */
export function studioWarmPaints(shapes: VectorShape[], background: Paint | null): Paint[] {
  const out = shapePaints(shapes)
  if (background && background !== 'none') out.push(background)
  return out
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/geoshape-render.unit.spec.ts`
Expected: PASS (new + all pre-existing).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/lib/geoshape/render.ts frontend/tests/unit/geoshape-render.unit.spec.ts
git commit -m "feat(shape-studio): paint a document background in drawToCanvas

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: SVG export — leading background rect

**Files:**
- Modify: `frontend/app/lib/geoshape/render.ts` (`studioToSvg` ~L341-346; add module-private `frameBox` + `backgroundRectShape` helpers near `frameSvg` ~L262)
- Test: `frontend/tests/unit/geoshape-studio-render.unit.spec.ts` (existing — append)

**Interfaces:**
- Consumes: `contentBounds`, `paddedExtent`, `studioFramePad`, `embedShapePaints`, `frameSvg`, `VectorShape`, `VectorCommand`, `FALLBACK_FILL`, `Paint`.
- Produces (module-private, not exported): `frameBox(bounds, pad): { x: number; y: number; w: number; h: number }`, `backgroundRectShape(box, paint: Paint): VectorShape`.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/tests/unit/geoshape-studio-render.unit.spec.ts` (it already imports `studioToSvg` / `mergeStudioDoc` for other tests; add them if missing):

```ts
describe('studioToSvg background', () => {
  const doc = (bg: any) => mergeStudioDoc({ layers: [{ mark: { shape: 'hexagon' } }], background: bg })

  it('emits no background rect when transparent', async () => {
    const svg = await studioToSvg(doc(null))
    // No full-frame rect element (shapes are <path>, never <rect>).
    expect(svg).not.toContain('<rect')
  })

  it('emits a solid background rect as the first drawable, behind the paths', async () => {
    const svg = await studioToSvg(doc('#123456'))
    const rectAt = svg.indexOf('<rect')
    const pathAt = svg.indexOf('<path')
    expect(rectAt).toBeGreaterThanOrEqual(0)
    expect(svg).toContain('#123456')
    expect(rectAt).toBeLessThan(pathAt)   // background is behind the marks
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/geoshape-studio-render.unit.spec.ts`
Expected: FAIL — no `<rect>` is emitted for a solid background.

- [ ] **Step 3: Implement**

In `frontend/app/lib/geoshape/render.ts`, add helpers just above `frameSvg` (they reuse the exact `paddedExtent` + centred-box formula `frameSvg` uses, so the rect matches the viewBox precisely):

```ts
/** The final framed box (document coords) a mark's `bounds` grown by `pad`
 *  occupies — the SAME extent+centre `frameSvg`/`drawToCanvas` frame into. */
function frameBox(bounds: { minX: number; minY: number; w: number; h: number }, pad: number): { x: number; y: number; w: number; h: number } {
  const w = paddedExtent(bounds.w, pad)
  const h = paddedExtent(bounds.h, pad)
  const cx = bounds.minX + bounds.w / 2
  const cy = bounds.minY + bounds.h / 2
  return { x: cx - w / 2, y: cy - h / 2, w, h }
}

/** A full-frame rectangle shape carrying the background `paint`, drawn first
 *  (behind the marks). Non-solid paints ride on `.paint` so `embedShapePaints`
 *  boxes them to the rect's own (full-frame) bounds; the solid `.fill` is the
 *  synchronous fallback. */
function backgroundRectShape(box: { x: number; y: number; w: number; h: number }, paint: Paint): GeoVectorShape {
  const { x, y, w, h } = box
  const commands: VectorCommand[] = [
    { command: 'moveTo', args: [x, y] },
    { command: 'lineTo', args: [x + w, y] },
    { command: 'lineTo', args: [x + w, y + h] },
    { command: 'lineTo', args: [x, y + h] },
    { command: 'closePath', args: [] },
  ]
  return { commands, fill: typeof paint === 'string' ? paint : FALLBACK_FILL, paint }
}
```

`VectorCommand` is already imported from `~/lib/vector/svg`? Confirm the top-of-file imports include it; if not, add `VectorCommand` to that import list (it currently imports `commandsToPathData, shapesToSVG, transformCommands, type SvgDocOptions`).

Then modify `studioToSvg` to prepend the background rect (still passing the ORIGINAL content bounds `b` to `frameSvg`, so the viewBox is unchanged):

```ts
export async function studioToSvg(doc: GeoStudioDoc, opts: Partial<SvgDocOptions> = {}): Promise<string> {
  const shapes = await renderStudio(doc)
  const b = contentBounds(shapes)
  const pad = studioFramePad(doc)
  const bg = doc.background
  const withBg = (bg && bg !== 'none')
    ? [backgroundRectShape(frameBox(b, pad), bg as Paint), ...shapes]
    : shapes
  await embedShapePaints(withBg)   // embeds a gradient/image background too
  return frameSvg(withBg, b, pad, opts)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/geoshape-studio-render.unit.spec.ts`
Expected: PASS (new + all pre-existing).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/lib/geoshape/render.ts frontend/tests/unit/geoshape-studio-render.unit.spec.ts
git commit -m "feat(shape-studio): emit a background rect in studioToSvg

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Wire the render call sites to pass the background

**Files:**
- Modify: `frontend/app/components/vue-canvas/ShapeStudioSurface.vue` (preview ~L361 & L367, rasterizePng ~L418-420, warm list ~L363 & L419)
- Modify: `frontend/app/components/vue-canvas/ShapeStudioNode.vue` (`bakeOutput` ~L64-87, `renderFrameSurface` ~L98-113)
- Modify: `frontend/app/lib/agent/takeThumbs.ts` (Shape thumbnail `drawToCanvas` ~L240)
- Test: none new (behavioural wiring verified by existing suites + Task 5 browser check). Typecheck is the gate.

**Interfaces:**
- Consumes: `drawToCanvas(..., background)`, `studioWarmPaints(shapes, background)`, `hasAsyncPaint`, `warmPaints` (all from render.ts). Each call site already holds the `doc`/`studioDoc`.

- [ ] **Step 1: Surface — pass background to both preview draws + the export, and warm it**

In `ShapeStudioSurface.vue`, replace the preview warm+draw block (the code around L361-367 that does `drawToCanvas(...); const paints = shapePaints(shapes); if (hasAsyncPaint(paints)) { await warmPaints(...); drawToCanvas(...) }`) so BOTH `drawToCanvas` calls pass `doc.value.background` and the warm list uses `studioWarmPaints`:

```ts
    drawToCanvas(shapes, ctx, el.width, el.height, pad, doc.value.background)
    const paints = studioWarmPaints(shapes, doc.value.background)
    if (hasAsyncPaint(paints)) {
      await warmPaints(paints, { w: el.width, h: el.height })
      drawToCanvas(shapes, ctx, el.width, el.height, pad, doc.value.background)
    }
```

In the `rasterizePng` block (~L418-420):

```ts
  const paints = studioWarmPaints(shapes, doc.value.background)
  if (hasAsyncPaint(paints)) await warmPaints(paints, { w: off.width, h: off.height })
  drawToCanvas(shapes, ctx, off.width, off.height, studioFramePad(doc.value), doc.value.background)
```

Update the import on ~L21 to add `studioWarmPaints` (drop nothing):
`renderStudio, studioToSvg, drawToCanvas, warmPaints, shapePaints, studioWarmPaints, hasAsyncPaint, studioFramePad,`
(`shapePaints` may now be unused in this file — if so, remove it from the import to keep the lint clean.)

- [ ] **Step 2: Node — warm + pass background in both bake and frame source**

In `ShapeStudioNode.vue`, add the render.ts imports at the top import group:
`import { renderStudio, drawToCanvas, studioFramePad, studioWarmPaints, hasAsyncPaint, warmPaints } from '~/lib/geoshape/render'`
(extend the existing `~/lib/geoshape/render` import rather than adding a second one.)

In `bakeOutput`, read the background and warm+pass it. Replace the render/draw portion:

```ts
  const studioDoc = studioDocFromPersisted(blob)
  const bg = studioDoc.background
  const w = typeof blob?.canvasW === 'number' ? blob.canvasW : 1024
  const h = typeof blob?.canvasH === 'number' ? blob.canvasH : 1024
  try {
    const shapes = await renderStudio(studioDoc)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(w))
    canvas.height = Math.max(1, Math.round(h))
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    const paints = studioWarmPaints(shapes, bg)
    if (hasAsyncPaint(paints)) await warmPaints(paints, { w: canvas.width, h: canvas.height })
    drawToCanvas(shapes, ctx, canvas.width, canvas.height, studioFramePad(studioDoc), bg)
    // ...unchanged toBlob + bakedThumb...
```

In `renderFrameSurface`, do the same warm+pass:

```ts
  const studioDoc = studioDocFromPersisted(blob)
  const shapes = await renderStudio(studioDoc)
  if (!frameCanvas) frameCanvas = document.createElement('canvas')
  frameCanvas.width = Math.max(1, Math.round(w))
  frameCanvas.height = Math.max(1, Math.round(h))
  const ctx = frameCanvas.getContext('2d')
  if (!ctx) return frameCanvas
  ctx.clearRect(0, 0, frameCanvas.width, frameCanvas.height)
  const paints = studioWarmPaints(shapes, studioDoc.background)
  if (hasAsyncPaint(paints)) await warmPaints(paints, { w: frameCanvas.width, h: frameCanvas.height })
  drawToCanvas(shapes, ctx, frameCanvas.width, frameCanvas.height, studioFramePad(studioDoc), studioDoc.background)
  return frameCanvas
```

(The explicit `ctx.clearRect` before `drawToCanvas` is now redundant — `drawToCanvas` clears first — but harmless; leave it or remove it, either is fine.)

- [ ] **Step 3: Agent thumbnails — pass the background**

In `frontend/app/lib/agent/takeThumbs.ts` at the Shape thumbnail draw (~L240), add the background arg. The `doc` is in scope there (`renderStudio(doc)` on the line above):

```ts
  drawToCanvas(shapes, out.getContext('2d')!, w, h, studioFramePad(doc), doc.background)
```

(This path bakes a small still; a solid/gradient background paints synchronously. Skip warming here — thumbnails tolerate the image/shader fallback, matching the file's existing no-warm behaviour.)

- [ ] **Step 4: Typecheck the touched files**

Run: `npx vue-tsc --noEmit -p tsconfig.json 2>&1 | grep -iE "ShapeStudioSurface|ShapeStudioNode|takeThumbs|geoshape/render" ; echo DONE`
Expected: only `DONE` (no error lines naming these files).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/components/vue-canvas/ShapeStudioSurface.vue frontend/app/components/vue-canvas/ShapeStudioNode.vue frontend/app/lib/agent/takeThumbs.ts
git commit -m "feat(shape-studio): thread the document background through every render path

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: UI — Background control in the editor

**Files:**
- Modify: `frontend/app/components/vue-canvas/ShapeStudioSurface.vue` (document-settings block near the Aspect/Width/Height controls ~L674-683; a `setBackground` handler near the other doc setters ~L140-175)
- Verify: browser (this session's own dev server)

**Interfaces:**
- Consumes: `FillControl` (already imported ~L37), `doc.value.background`, `normalizeBackground` (from `~/lib/geoshape/studio`), the existing `saveConfig`/persist path used by other doc edits.

- [ ] **Step 1: Add the `setBackground` handler**

In `ShapeStudioSurface.vue`, import the normaliser (extend the existing `~/lib/geoshape/studio` import):
`import { studioDocFromPersisted, normalizeBackground } from '~/lib/geoshape/studio'`

Add a setter alongside the other document-level setters (it writes `doc.value.background`, normalising the none-sentinels to `null`, then persists exactly as the other doc edits do — mirror whatever `padding`/`seed` edits call; here shown via the shared `saveConfig`):

```ts
function setBackground(p: Paint) {
  doc.value.background = normalizeBackground(p)
  try { saveConfig() } catch (e) { console.error('[shape-studio] saveConfig failed', e) }
}
```

If document edits in this file go through a helper (e.g. `setDocControl`/`persist`) rather than a bare `saveConfig()`, use that same helper instead of the try/catch shown — match the file's existing pattern for `padding`.

- [ ] **Step 2: Add the control to the document-settings block**

Next to the Aspect / Width / Height inputs (~L674-683), add:

```vue
          <StudioColorField label="Background" v-if="false" />
          <div class="mt-2">
            <div class="mb-1 text-[11px] text-white/50">Background</div>
            <FillControl
              :model-value="doc.background ?? 'none'"
              allow-none
              allow-image
              @update:modelValue="setBackground"
            />
          </div>
```

(Remove the `v-if="false"` placeholder line — it is only here to show placement relative to the existing `StudioColorField` usages; the real element is the `<div>` block. Match the surrounding markup's label styling if it differs.)

- [ ] **Step 3: Typecheck**

Run: `npx vue-tsc --noEmit -p tsconfig.json 2>&1 | grep -iE "ShapeStudioSurface" ; echo DONE`
Expected: only `DONE`.

- [ ] **Step 4: Browser verification (this session's own server)**

Follow the preview workflow: `preview_start` with `{ name: "frontend" }` (starts THIS session's server; do not reuse another chat's). Open the canvas, add a Shape Studio node, open its editor, and exercise the Background control:
- Set a solid colour → the preview and the node card show it behind the shapes.
- Switch to a gradient → gradient background renders.
- Switch to None → the checkerboard shows through (transparent).
- Wire the Shape Studio into a Frame → the chosen background appears in the Frame (live source), transparent stays transparent.

Capture a screenshot of the solid-background case in the Frame as proof. If anything is blank, diagnose via `read_console_messages` before editing.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/components/vue-canvas/ShapeStudioSurface.vue
git commit -m "feat(shape-studio): Background control in the editor (solid/gradient/image/none)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Data model (`background: Paint | null`, default null, migration) → Task 1. ✓
- `drawToCanvas` full-rect background + async warm helper → Task 2. ✓
- SVG background rect ("Include SVG now") → Task 3. ✓
- All output paths (preview, export, node bake, Frame source, thumbnails) threaded → Task 4. ✓
- UI control in document settings ("near Aspect/padding") → Task 5. ✓
- Transparent = null, `'none'`/`''` collapse → Tasks 1 (`normalizeBackground`), 2 (drawToCanvas guard), 3 (SVG guard), 5 (setBackground). ✓
- Resolution controls untouched (out of scope). ✓

**Placeholder scan:** The only literal placeholder is the `v-if="false"` marker in Task 5 Step 2, explicitly called out for removal. No TBD/TODO; every code step shows real code.

**Type consistency:** `background: Paint | null` is consistent across studio.ts, render.ts, and the Vue call sites. `drawToCanvas`'s 6th param and `studioWarmPaints`'s signature match every caller in Task 4. `normalizeBackground` is defined in Task 1 and reused in Task 5. `frameBox`/`backgroundRectShape` are module-private to render.ts (Task 3) and not referenced elsewhere.
