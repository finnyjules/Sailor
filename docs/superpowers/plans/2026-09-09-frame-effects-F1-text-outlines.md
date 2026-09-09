# Frame Effects F1 — Text to Outlines — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development, task-by-task. Steps use `- [ ]`.

**Goal:** A Compositor text layer can be rendered from real glyph outlines (a single SVG `d` path) instead of `fillText`, so the geometry-effect region (slice F2) can transform it — while a text layer with no geometry effect renders byte-identically to today.

**Architecture:** Compositor fonts are CSS (`fontFamily` + `fontWeight`); Vector Type outlines need fontkit bytes from `loadVectorFont(token)`. A new bridge builds a Vector Type token from the layer's family/weight/axes, loads the font async into a module cache, and returns it synchronously once present (mirroring the app's Google-font-then-redraw pattern). `drawText`'s existing layout is reused unchanged by routing each drawn run through a **sink**: `fillText` by default, or an outline collector that converts the run to positioned commands. The collected commands become one `d` for both rendering (Path2D fill) and `outlinePathData`. System fonts have no byte source, so they keep `fillText` and geometry effects skip them.

**Tech Stack:** Nuxt 4, Vue 3.5, TypeScript, Canvas 2D, fontkit (via Vector Type), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-09-frame-effects-programme.md` (slice F1).

## Global Constraints

- A text layer with no geometry effect present renders **byte-identically** to before this slice (real-canvas A/B; the sink defaults to `fillText`).
- Outlined text must match `fillText` layout: same line wrapping, alignment, letter spacing, valign, and origin-centring — because it reuses `drawText`'s own layout, not a reimplementation.
- The font bridge is **async and cached**: `paintLayer` is synchronous, so outlining a layer whose font bytes are not yet loaded renders `fillText` this frame and triggers a redraw when the bytes arrive (the existing Google-font pattern in `useTemplateFonts`/`useCompositorLayers`).
- System/unresolvable fonts render `fillText` forever and expose no outline; F2's add-menu will grey geometry effects for them (out of scope here) — this slice must make `outlinePathData` return `null` for them so the caller degrades cleanly.
- UI copy sentence case; `CompositorModal.vue` and `useCompositorLayers.ts` are shared with parallel sessions — stage own hunks by hunk (`git diff <file> > p; edit; git apply --cached p`), never `git add <file>` when foreign hunks are present; check `git log -3 --stat -- <file>` before committing.
- One dev server per checkout (`:3002`); never start another. Commits end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## File Structure

- Create `frontend/app/lib/compositor/textOutline.ts` — the font bridge (token + cache + sync-get/async-load) and the run/line → commands math; pure except the cache's fetch. Depends on `~/lib/vectortype/font` (`loadVectorFont`), `~/lib/vectortype/outline` (`textOutlines`), `~/lib/vectortype/fontToken` (`formatVtFontToken`), `~/lib/vector/svg` (`commandsToPathData`).
- Modify `frontend/app/composables/useCompositorLayers.ts` — `drawText` gains an emit sink; `outlinePathData` gains a text branch; `paintLayer` outlines text when a geometry effect is present (F2 adds the effects; here the hook keys on a passed-in predicate defaulting to false, so F1 ships inert on the render path and is proven through the unit/E2E seams).
- Modify `frontend/app/lib/compositor/textPath.ts` (or the `drawTextOnPath` seam) — outline collection along a guide.
- Tests: `frontend/tests/unit/compositor-text-outline.unit.spec.ts`, `frontend/tests/compositor-text-outline.spec.ts` (Playwright).

---

### Task 1: Font bridge — token, cache, sync-get + async-load

**Files:** Create `frontend/app/lib/compositor/textOutline.ts`; Test `frontend/tests/unit/compositor-text-outline.unit.spec.ts`.

**Interfaces produced:**
- `compositorFontToken(layer: { fontFamily: string; fontWeight: number }): string | null` — a Vector Type token (`google:Family@Weight` for a Google/curated family, a `local:`/catalog token for a library face) or `null` when the family has no fetchable byte source (system fonts). Uses `formatVtFontToken` and the family lookups in `~/data/variable-fonts` / `~/data/library-fonts-lookup`.
- `getCompositorFont(layer): VtFont | null` — synchronous: returns the cached font if loaded; else returns `null` and kicks a background `loadVectorFont` into the cache. Never throws.
- `onCompositorFontReady(cb: () => void): () => void` — subscribe to "a font finished loading"; returns an unsubscribe. `paintLayerStack`'s host wires this to a redraw (Task 3).
- `__resetCompositorFontCacheForTest()` — clears the cache and subscribers.

- [ ] **Step 1: failing tests** — token construction for a known Google family and a known curated/variable family; `null` for `'Arial'`/`'Helvetica'` (no source); `getCompositorFont` returns `null` first call and, after the mocked `loadVectorFont` resolves, returns the font and fires the ready callback; a second call returns the cached font synchronously; two layers of the same family share one in-flight load. Mock `loadVectorFont` with `vi.mock`.
- [ ] **Step 2:** run, watch fail (module missing).
- [ ] **Step 3:** implement. Cache is `Map<token, { font?: VtFont; promise?: Promise<void>; failed?: boolean }>`. `getCompositorFont`: token = `compositorFontToken(layer)`; `null` token → return null; entry hit with font → return it; failed → null; else start `loadVectorFont(token)` once, on resolve store font + notify subscribers, on reject mark failed (no console spam). Family→token resolution: exact-match the curated/variable catalog and the library lookup first, then fall back to `google:${family}@${weight}` only for families known to be Google (or attempt it and let a 404 mark `failed`); document the precedence in a comment.
- [ ] **Step 4:** run, pass.
- [ ] **Step 5:** commit (`textOutline.ts` + spec) — `feat(frame): compositor→Vector Type font bridge for text outlines`.

### Task 2: One drawn run → positioned outline commands

**Files:** Modify `frontend/app/lib/compositor/textOutline.ts`; extend the unit spec.

**Interfaces produced:**
- `runToCommands(font: VtFont, run: { text: string; x: number; y: number }, style: { fontPx: number; letterSpacingPx: number; align: CanvasTextAlign; baseline: CanvasTextBaseline }): VectorCommand[]` — outline commands in the ctx's local px, positioned exactly where `ctx.fillText(run.text, run.x, run.y)` would draw them under the same `ctx.font`, `textAlign`, `textBaseline`, `letterSpacing`. Shapes via `textOutlines(font, run.text)` (kerned advances from fontkit), applies `letterSpacingPx` per glyph, offsets x for `align` from the shaped run width, shifts y for `baseline` using the font's ascent/descent (`font.raw.ascent`/`descent` scaled), scales font-units→px by `fontPx / font.unitsPerEm`, and y-flips.

- [ ] **Step 1: failing test** — build a font (real bundled fixture via `loadVectorFont` in a beforeAll, or a fontkit stub with known glyph metrics); for a two-glyph run at `align:'left', baseline:'alphabetic'`, assert the first command's start ≈ `run.x` and the bbox width ≈ shaped-advance×scale within 0.5px; for `align:'center'` assert the bbox is centred on `run.x`; for `baseline:'middle'` assert vertical centring against ascent/descent.
- [ ] **Step 2–4:** implement, converge against the assertions.
- [ ] **Step 5:** commit — `feat(frame): position a text run's glyph outlines to match fillText`.

### Task 3: Layer outline via a sink, `outlinePathData`, and the paint hook

**Files:** Modify `frontend/app/composables/useCompositorLayers.ts`; extend both specs; add the Playwright spec.

**Interfaces produced:**
- `drawText` gains an optional emit sink: default calls `strokeTextPasses`/`fillText` as today; when a `collect` sink is passed it calls `runToCommands` for each run instead and pushes into an array — **the layout code is otherwise untouched**, so a run's `x/y/align/baseline` are the same values fillText used.
- `textLayerOutline(layer, W): string | null` — runs `drawText`'s layout with the collect sink over `getCompositorFont(layer)`; returns one `d` (via `commandsToPathData`) or `null` when the font is not ready/resolvable.
- `outlinePathData(layer, W)` returns `textLayerOutline(layer, W)` for `kind:'text'`.
- `paintLayer`: a `needsTextOutline(layer)` predicate (F1 default: `layer.renderAsOutline === true`; F2 will OR-in "a geometry effect is present"). When true AND `textLayerOutline` returns non-null, draw the Path2D (fill with the layer's paint, stroke via the existing stroke stack over the same `d`) instead of `drawText`. When null (font loading), fall back to `drawText` and register a one-shot `onCompositorFontReady` redraw.

- [ ] **Step 1: failing tests** — unit: `textLayerOutline` on a seeded text layer with a loaded fixture font returns a non-empty `d` whose bbox ≈ the layer's measured text box within 2px; returns `null` for a system-font layer; `outlinePathData` returns that `d` for text and unchanged results for rect/ellipse/path. Playwright (`compositor-text-outline.spec.ts`): seed a text layer with `renderAsOutline:true` on a Google font; assert the canvas is non-blank and that the outlined render matches a `fillText` render (same layer, flag off) with ≥99% of pixels within Δ2 (histogram of per-pixel deltas via `getImageData`).
- [ ] **Step 2–4:** implement the sink refactor (smallest possible change to `drawText`), `textLayerOutline`, the `outlinePathData` branch, the `paintLayer` hook, and the ready-redraw wire.
- [ ] **Step 5:** commit — `feat(frame): render a text layer from glyph outlines when asked`.

### Task 4: Type-on-a-path outline mode

**Files:** Modify `frontend/app/lib/compositor/textPath.ts` and the `drawTextOnPath` seam; extend the unit spec.

- [ ] Place per-glyph outlines along the guide: for each `PlacedGlyph`, take that glyph's commands from `textOutlines`, rotate by `angle`, translate to `(x,y)`, scale/flip, collect into `d`. Reuse `placeGlyphs` for positions unchanged (so on-path layout is identical). `textLayerOutline` returns this `d` when `layer.path` is set. Unit test: a glyph on a straight guide equals the flat-run placement; a glyph on a curve is rotated (its bbox tilts). Playwright: a badge (circle guide) with `renderAsOutline` is non-blank and matches the fillText path render ≥99% within Δ2.
- [ ] Commit — `feat(frame): glyph outlines follow a text path`.

### Task 5: Byte-identity guard

**Files:** `frontend/tests/compositor-text-outline.spec.ts` (extend).

- [ ] Playwright: a frame with a text layer and `renderAsOutline` **off** renders byte-identically before and after this slice — capture `toDataURL`, compare to a fillText-only baseline captured in the same run by toggling the flag; assert the flag-off render equals the pre-slice path (seed via `__compositorSetLayers`, no geometry effects). Prove the test is sensitive: with the flag on and a real outline, the images differ. Commit — `test(frame): text without an outline effect renders unchanged`.

### Task 6: Fallback, cache lifecycle, report

**Files:** `frontend/app/lib/compositor/textOutline.ts`, unit spec.

- [ ] A load failure (404 for a system family mis-taken as Google) marks the token `failed`, so `getCompositorFont` returns `null` steadily and never refetches or logs on a loop; `outlinePathData` returns `null`; the layer renders `fillText`. Unit test with a rejecting `loadVectorFont`. `axes` (variable fonts) thread into `compositorFontToken`/`textOutlines`. Confirm the ready-subscriber list is cleaned on unmount (no leak). Commit — `fix(frame): text outline degrades to fillText for unavailable fonts`.

## Self-Review checklist
- No text layer's pixels change with `renderAsOutline` off (Task 5).
- Outline layout matches fillText because `drawText`'s layout is reused via the sink, not reimplemented (Task 3).
- `paintLayer` never blocks on a font load; it degrades to fillText and redraws (Tasks 1, 3, 6).
- `outlinePathData` returns null for text whose font can't be outlined, so F2 can gate cleanly.
