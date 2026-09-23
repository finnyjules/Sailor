# Frame layout system — Stage 2 (formats) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Layouts know the real ad and social format a Frame is sized for: they keep text out of the areas the platform covers, keep text readable at the size people actually see the format, drop the least important lines where a format carries fewer, and recognise number-like text.

**Architecture:** A pure `formats.ts` table (size, viewing width, keep-clear areas, levels carried, platform button, column count) extends the Frame size presets. The planner finds the Frame's format from its stored preset (or its size) and passes the format's rules to the sheet (minimum sizes, columns, side margins), composes inside the uncovered band (then extends bleeding images and panels to the real edges, as the prototype does), hides lines the format does not carry through a tracked `visible` field, and the checker gains a keep-clear rule. The Layout tab names the format and its rules, and the editor shows the covered areas while the Layout tab is open.

**Tech Stack:** Nuxt 4 / Vue 3 / TypeScript, vitest (node), Playwright on `/dev/frame-lab`.

**Spec:** `docs/superpowers/specs/2026-09-23-frame-layout-system-design.md` §6 (Stage 2). Prototype: `docs/superpowers/specs/assets/2026-09-23-frame-layout-system/layout-pane.html` (`SHAPES` ~line 178, `setShape` ~200, `runCandidate` ~1664, keep-clear check ~1763, levels `TIERS`/`shown`/`carriedContent` ~1637–1654). Stage 1 ledger (rulings R1–R13): `.superpowers/sdd/2026-09-23-frame-layout-system-stage1/progress.md`.

## Global Constraints

- Everything from Stage 1 stays binding: a layout may set position, size, rotation, line and letter spacing, opacity, blend, crop — never the font family, weight, or the colour of the user's own text (unless recolour is on). Owned pieces take palette-role colours. Existing Frames render byte-identically when new fields are absent.
- A Frame with **no recognised format** (a custom size, or one of the six existing presets) plans **exactly as in Stage 1** — same candidates, same geometry. A test pins this.
- Keep-clear areas apply to **text only**; full-bleed images, panels and bands extend to the real edges (spec §6).
- Minimum text by viewing size: **at least 9px at the width people see the format**: `INFO.size = max(1.95·B, 100·9/view)`, `SECOND.size = max(4.4·B, 1.6·INFO.size)` (prototype `setShape`).
- Levels of importance, most to least: `title → details → date → caption` (the prototype's `TIERS`). A format that carries N levels hides the rest.
- UI copy: sentence case; quote the Frame's own text; "image", never "photo"; no internal ids.
- Kit units: percent of frame width (W = 100, H = 100 × frameH / frameW). Sailor layers: `x` normalised by width, `y` by height, sizes by width.
- Catalog order is the seed order (Stage 1 R9) — never reorder `LAYOUTS`.
- Subagents never commit and never run the dev server; the controller commits with the private-index recipe.

## Rulings made while planning (the spec leaves these open)

- **P1 — Platform button choice deferred to Stage 3.** "Button: In the image / Platform's own" needs a drawn button, which is a Stage 3 owned piece; the Swiss layouts have no button content. Stage 2 records `platformButton` in the format table only.
- **P2 — Google responsive display export mode and the "blank space ≤ 80%" check deferred** to Stage 5 (Campaigns), where exports per format live. Stage 2 adds the Performance Max keep-clear (centre 80%) only.
- **P3 — Viewing widths the spec does not give:** Pinterest 2:3 and 9:16 → 236px (the Pinterest feed column); 300×600 → 300; 320×50 → 320; 970×250 → 970; Google display 1.91:1 and 1:1 → 390 (they serve in mobile feeds). Levels carried the spec does not give: 320×50 carries 2; 300×600 and 970×250 carry 3.
- **P4 — Roles keep their Stage 1 keys internally** (`title/details/date/caption`); "levels of importance" is their order. Stage 3 styles may reorder it.
- **P5 — Format detection is explicit, never guessed from aspect:** (1) the stored `sailor_frame.preset` names a format and the Frame's aspect matches it within 0.5% → that format; (2) otherwise, a format whose `w×h` equals the Frame's size exactly, **unless one of the six plain presets has that same size** (1280×720 is the plain 16:9 preset, so an old 16:9 Frame is not a video thumbnail unless the user picks it); (3) otherwise none. Aspect alone never selects a format, so every existing Frame and the Stage 1 matrix frames (895×1280, 1080×1080, 1280×720, 1280×400) have no format.
- **P6 — Extreme banners** (728×90, 320×50, 970×250, 160×600) are matrix-gated by "at least N layouts offered" rather than per layout: many Swiss poster layouts have no honest composition at 8:1. N is in Task 7.

---

### Task 1: The format table and the new size presets

**Files:**
- Create: `frontend/app/lib/frame/formats.ts`
- Modify: `frontend/app/lib/frame/frameSize.ts` (`FRAME_SIZE_PRESETS` gains the formats)
- Test: `frontend/tests/unit/frame-formats.unit.spec.ts`

**Interfaces — Produces:**
```ts
// lib/frame/formats.ts
/** Fractions of the Frame's width (left/right) and height (top/bottom) the platform covers with its own interface. */
export interface KeepClear { top: number; bottom: number; left: number; right: number }
export interface FrameFormat {
  id: string; label: string; w: number; h: number
  /** Width in CSS px people actually see it at — sets the minimum text size. Absent: no floor. */
  view?: number
  keep?: KeepClear
  /** How many levels of text it carries (title → details → date → caption). Absent: all four. */
  carries?: 2 | 3
  /** The platform draws its own button under or on the ad (recorded; used from Stage 3). */
  platformButton?: boolean
  /** Real column count override (very wide banners). */
  nc?: number
}
export const FRAME_FORMATS: readonly FrameFormat[]
/** The format a Frame is sized for (ruling P5), or null. */
export function formatFor(props: Record<string, unknown> | undefined, frameW: number, frameH: number): FrameFormat | null
```

The table (ids, labels and numbers verbatim):

| id | label | w×h | view | keep (top, bottom, left, right) | carries | platformButton | nc |
|---|---|---|---|---|---|---|---|
| `meta-feed-4x5` | Meta feed · 4:5 | 1440×1800 | 390 | — | — | yes | — |
| `meta-feed-1x1` | Meta feed · 1:1 | 1200×1200 | 390 | — | — | yes | — |
| `meta-story` | Meta story / reel · 9:16 | 1080×1920 | 390 | .14, .35, .06, .06 | — | yes | — |
| `meta-story-hd` | Meta story / reel HD · 9:16 | 1440×2560 | 390 | .14, .35, .06, .06 | — | yes | — |
| `pinterest-2x3` | Pinterest pin · 2:3 | 1000×1500 | 236 | — | — | no | — |
| `pinterest-9x16` | Pinterest idea pin · 9:16 | 1080×1920 | 236 | 270/1920, 440/1920, 65/1080, 195/1080 | — | no | — |
| `link-preview` | Link preview · 1.91:1 | 1200×628 | 500 | — | — | no | — |
| `video-thumb` | Video thumbnail · 16:9 | 1280×720 | 170 | — | 2 | no | — |
| `pmax-landscape` | Google display · 1.91:1 | 1200×628 | 390 | .10, .10, .10, .10 | — | yes | — |
| `pmax-square` | Google display · 1:1 | 1200×1200 | 390 | .10, .10, .10, .10 | — | yes | — |
| `ad-300x250` | Display ad · 300×250 | 300×250 | 300 | — | — | no | — |
| `ad-160x600` | Display ad · 160×600 | 160×600 | 160 | — | 3 | no | — |
| `ad-728x90` | Display ad · 728×90 | 728×90 | 728 | — | 3 | no | 24 |
| `ad-300x600` | Display ad · 300×600 | 300×600 | 300 | — | 3 | no | — |
| `ad-320x50` | Display ad · 320×50 | 320×50 | 320 | — | 2 | no | 24 |
| `ad-970x250` | Display ad · 970×250 | 970×250 | 970 | — | 3 | no | 24 |

`FRAME_SIZE_PRESETS` = the existing six presets unchanged, then one preset per format `{ id, label, w, h }` in table order. `framePresetId(w, h)` keeps returning the FIRST preset whose size matches (so 1080×1920 → `meta-story`; the stored preset disambiguates Pinterest).

- [ ] **Step 1: Write the failing test** (`frame-formats.unit.spec.ts`):
  - `FRAME_FORMATS` has 16 entries with the table's values (spot-check `meta-story.keep`, `pinterest-9x16.keep.right ≈ 195/1080`, `video-thumb.carries === 2`, `ad-728x90.nc === 24`); every label starts with a capital letter.
  - `formatFor({ sailor_frame: { preset: 'pinterest-9x16' } }, 1080, 1920)?.id === 'pinterest-9x16'`; `formatFor(undefined, 1080, 1920)?.id === 'meta-story'` (exact size, first match); `formatFor(undefined, 300, 250)?.id === 'ad-300x250'`; `formatFor({ sailor_frame: { preset: 'video-thumb' } }, 1280, 720)?.id === 'video-thumb'`.
  - `null` for: `(undefined, 1280, 720)` (the plain 16:9 preset's size), `(undefined, 540, 960)` and `(undefined, 600, 500)` (aspect alone never selects), `({ sailor_frame: { preset: 'meta-story' } }, 1000, 1000)` (stored preset's aspect does not match), and each Stage 1 matrix frame 895×1280, 1080×1080, 1280×720, 1280×400.
  - `FRAME_SIZE_PRESETS.slice(0, 6)` deep-equals the old six; `framePresetId(1080, 1920) === 'meta-story'`; `applyFramePreset` with `'ad-728x90'` writes 728×90.
- [ ] **Step 2:** run `cd frontend && pnpm vitest run tests/unit/frame-formats.unit.spec.ts` → FAIL (module missing).
- [ ] **Step 3:** implement `formats.ts` and extend `FRAME_SIZE_PRESETS`. Check every consumer of `FRAME_SIZE_PRESETS` (`ArtifactFrameNode.vue:84`, `CompositorModal.vue:420`) still renders: a flat select with 22 options is acceptable; if either select supports groups (`optgroup` or a grouped `StudioSelect` prop — read the component), group as "Sizes" / "Social" / "Display ads" and say so in the report.
- [ ] **Step 4:** run the test and the existing `frame-size*` / `frameSize*` specs → PASS. Typecheck the touched files.

---

### Task 2: The sheet takes a format

**Files:**
- Modify: `frontend/app/lib/frame/patterns/kit/sheet.ts`
- Test: `frontend/tests/unit/frame-layout-kit-sheet.unit.spec.ts` (extend)

**Interfaces:**
- Consumes: `FrameFormat` (Task 1).
- Produces: `SheetOpts` gains
```ts
  /** The format's rules for the sheet: the minimum text size from its viewing width, its column
   *  count, and the platform's side margins. Absent: Stage 1 behaviour, unchanged. */
  format?: Pick<FrameFormat, 'view' | 'nc'> & { keepSide?: number }
  /** Compose on a band this tall (kit units) instead of the full height — the part the platform
   *  leaves uncovered. `B` still comes from the FULL height. */
  composeH?: number
```
Rules (prototype `setShape`, verbatim maths):
- `B` from the full frame (`H_full = 100·frameH/frameW`); `H = composeH ?? H_full`.
- `M = gridOn ? grid.margin·100 : min(4, H·0.06)`; then if `format.keepSide` → `M = max(M, keepSide·100)`.
- `NC`: explicit grid wins; else `format.nc` when set; else the Stage 1 aspect rule (computed on `H_full`).
- `INFO.size = max(1.95·B, format.view ? 900/format.view : 0)`; `SECOND.size = max(4.4·B, 1.6·INFO.size)` — **only when `format.view` is set**; otherwise both stay exactly the Stage 1 values (`SECOND.size = 4.4·B`).

- [ ] **Step 1: Failing tests:** (a) no `format` / no `composeH` → every exported number identical to a Stage 1 sheet for 895×1280, 1080×1080, 1280×720, 1280×400 (deep-equal the numeric fields); (b) `format: { view: 170 }` on 1280×720 → `INFO.size ≈ 900/170 ≈ 5.294`, `SECOND.size ≈ 1.6·5.294`; (c) `format: { nc: 24 }` on 728×90 → `NC === 24`; (d) `keepSide: 0.06` → `M === 6`; (e) `composeH: 50` on 1080×1920 → `S.H === 50`, `S.B` equals the full-height sheet's `B`, `L(16) ≈ 50 − M`.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** run the whole `frame-layout*` set → PASS (Stage 1 matrix unchanged).

---

### Task 3: Hide a line the format does not carry (tracked `visible`)

**Files:**
- Modify: `frontend/app/lib/frame/patterns/types.ts` (`LayerOp.hidden?: boolean`), `frontend/app/lib/frame/patterns/apply.ts`, `frontend/app/lib/frame/patterns/kit/toOps.ts`
- Test: `frontend/tests/unit/frame-layout-toops.unit.spec.ts`, `frontend/tests/unit/frame-patterns-apply.unit.spec.ts` (extend)

**Interfaces — Produces:**
- `LayerOp.hidden?: boolean` — apply runs `track('visible', op.hidden ? false : undefined)` for every op on an existing layer (the same remember/restore rule as the other tracked fields: a later op without `hidden` hands the user's own visibility back, unless the user changed it since).
- `elementsToOps(els, S, targets, frame, palette?, opts?: { hide?: RoleKey[] })` — for each role in `hide` that has a target layer, emit `{ target, kind: 'text', hidden: true, z: <after all elements> }` with **no** geometry fields (the layer keeps its position; apply must not write `x/y` for an op without them — check `apply.ts:50`, which writes `x: op.x, y: op.y` unconditionally today, and make position writes conditional on `op.x != null`; add a test that an op with no `x/y` leaves the position alone).

- [ ] **Step 1: Failing tests:** apply an op `{ hidden: true }` → `visible === false` and `layoutPrev.visible = { was: null, set: false }`; a second op on the same layer without `hidden` → `visible` key absent again (restored), `layoutPrev` entry dropped; if the user set `visible: true` in between (a user edit), the next op without `hidden` keeps `true`. `elementsToOps(..., { hide: ['caption'] })` emits exactly one op for the caption layer with `hidden: true` and no `x`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** run `frame-layout*`, `frame-patterns*`, `pattern-apply-clears-pins` → PASS.

---

### Task 4: The planner runs a format (keep-clear band, levels, extensions) + checker rule 8

**Files:**
- Modify: `frontend/app/lib/frame/patterns/kit/plan.ts`, `frontend/app/lib/frame/patterns/kit/check.ts`, `frontend/app/lib/frame/patterns/kit/types.ts` (`LayoutDef.smallText?: boolean`), `frontend/app/lib/frame/patterns/layouts/*.ts` (flag six layouts)
- Test: `frontend/tests/unit/frame-layout-plan.unit.spec.ts`, `frontend/tests/unit/frame-layout-check.unit.spec.ts` (extend)

**Interfaces:**
- Consumes: `formatFor` (T1), `SheetOpts.format/composeH` (T2), `elementsToOps(..., { hide })` (T3).
- Produces:
  - `checkPlan(els, S, premise?, opts?: { keep?: KeepClear; fullH?: number })` — **rule 8:** a text element whose box leaves the uncovered band (`y0 < fullH·keep.top − 0.3`, `y1 > fullH·(1 − keep.bottom) + 0.3`, `x0 < 100·keep.left − 0.3`, `x1 > 100 − 100·keep.right + 0.3`) → `` `${role}: under the app's interface` ``. Only text. Negative control required.
  - `LayoutPlan.format: { id: string; label: string; hidden: RoleKey[] } | null` — the format used and the roles it hid (the UI quotes their text).
  - `LayoutDef.smallText?: true` on `index`, `badge`, `dateBehind`, `label`, `sidebar`, `fourCorners` (the prototype's "built around the smaller text"): such a layout does not fit a format with `carries < 3`.

Pipeline changes in `prepare`/`runChoice`/`planLayout`/`candidatesForFrame` (prototype `runCandidate` lines ~1664–1700, ported):
1. `const fmt = formatFor(a.props, a.frameW, a.frameH)`. **Check first** what `frameW/frameH` the Layout tab passes (`CompositorModal.vue` → `useLayoutVary` → planner): exact-size detection needs the Frame's design size in pixels (`readFrameSize` / the `width`/`height` widgets), not the on-screen artboard size. If the tab passes a display size, pass the design size instead (only the aspect mattered in Stage 1, so geometry is unchanged) and say so in the report. With `fmt == null` nothing below happens (Stage 1 path, byte-for-byte).
2. **Levels:** `carries = fmt.carries ?? 4`; roles beyond the first `carries` of `['title','details','date','caption']` are removed from `content` before the layout runs and listed as `hidden`. `fitsFrame` also rejects `def.smallText` when `carries < 3`, and `needs.number` when the number's role is hidden.
3. **Keep-clear band:** with `fmt.keep`, `H_full = 100·frameH/frameW`, `inset = H_full·keep.top`, `composeH = H_full·(1 − keep.top − keep.bottom)`; build the sheet with `composeH` and `format: { view, nc, keepSide: max(keep.left, keep.right) }`. After the layout runs, shift every element's `y`, `top`, `base`, `cy` by `inset`. Then extend, exactly as the prototype: a `k:'r'` with role `panel` spanning the band (top ≤ inset+0.5 and bottom ≥ bandEnd−0.5) becomes `y = 0, h = H_full`; a `k:'p'` with `bleed` spanning the band becomes the full-height cover box (`w = max(W, H_full/PHOTO_ASPECT, e.w)`, `h = w·PHOTO_ASPECT`, centred). Asymmetric side keeps (Pinterest) set `keepSide = max(left, right)` for the sheet margin in Stage 2 (a known simplification — note it in the report).
4. The **checker** runs on a full-height sheet (for off-page) with `opts.keep`/`fullH` (rule 8). The wide-frame side image (Stage 1) still applies when the **band** is wide (`composeH < 70`).
5. `elementsToOps(..., { hide: hidden })`; `LayoutPlan.format` filled; `posterState` unchanged in shape.

- [ ] **Step 1: Failing tests** (stub measure, the plan spec's Frame fixture):
  - A Frame with **no format** (895×1280, custom): `plan.format === null`, and the whole Stage 1 matrix (`frame-layout-matrix.unit.spec.ts`) stays green with identical candidate counts — record the per-layout candidate counts on 895×1280 before the change and assert them after (a small table in the new test).
  - `meta-story` (1080×1920, preset stored): every text box of every candidate of `runoff`, `statement`, `footer` lies inside the band (assert with `boxOf`); a full-bleed image element (Full bleed layout, image present) spans `0..H_full`.
  - `video-thumb` (1280×720): `plan.format.hidden` is `['date','caption']`; the date and caption layers end `visible: false`; `index` is not offered (`candidatesForFrame` empty) because it is `smallText`.
  - Minimum size: on `video-thumb` every text element's `size ≥ 900/170 − 0.01`.
  - Checker rule 8 negative control: a text element placed at `top: 1` on a `meta-story` sheet → exactly `'title: under the app's interface'`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** run all `frame-layout*`, `frame-patterns*`, `layout-*` → PASS (the Stage 1 matrix must stay green and unchanged).

---

### Task 5: Number-like text is recognised

**Files:**
- Modify: `frontend/app/lib/frame/patterns/hierarchy.ts`, `frontend/app/lib/frame/patterns/kit/plan.ts` (export `isNumberish` stays the one copy; hierarchy imports it — move it to `hierarchy.ts` if the import would create a cycle, and re-export from `plan.ts`)
- Test: `frontend/tests/unit/frame-patterns-hierarchy.unit.spec.ts` (create or extend the existing hierarchy spec — grep for it)

Rule: among the middle texts, the **number** (the `date` role) is the first whose text is number-like — `isNumberish` (price, discount, a date, a time) — falling back to the Stage 1 `DATE_RE` match. A caption holding a postcode is still the caption (only the middle texts are considered, as today).

- [ ] **Step 1: Failing tests:** texts `['Summer sale' (large), '–30%' (mid), 'Only this week' (mid), 'Terms apply' (small)]` → `date` is `–30%`, `details` is `Only this week`; `['Big title', '€29', 'Free delivery', 'Small print']` → `date` is `€29`; `['Title', 'Doors 19:30', 'Ines Vollmer', 'Kunstraum Lenz, 4056 Basel']` → `date` is `Doors 19:30`; the Stage 1 fixture (`19.09.–15.11.2026`) still resolves identically.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** run `frame-layout*`, `frame-patterns*` → PASS.

---

### Task 6: Vary ranks down text that covers the image

**Files:**
- Modify: `frontend/app/lib/frame/patterns/kit/vary.ts`
- Test: `frontend/tests/unit/frame-layout-vary.unit.spec.ts` (extend)

Rule (spec §6, "soft penalty, not rejection"): for each candidate with an image element (`k:'p'`, or `k:'c'` with `photo`), `cover = Σ area(textBox ∩ imageBox) / area(imageBox)` over text elements (use `boxOf`; `enumerate` receives the sheet through a new optional `boxOf?: (e: El) => Box | null` in its opts, so vary stays free of the sheet); `score −= cover > 0.2 ? 0.5 : 0`. The default-first guarantee (Stage 1) still holds.

- [ ] **Step 1: Failing test:** two fake candidates identical except one's title box covers 40% of the image → the covering one ranks below; with no `boxOf` passed, scores equal the Stage 1 formula exactly.
- [ ] **Step 2–4:** FAIL → implement (pass `boxOf: e => boxOf(e, S)` from `candidatesForFrame`) → PASS on `frame-layout*`.

---

### Task 7: The format matrix

**Files:**
- Create: `frontend/tests/unit/frame-layout-format-matrix.unit.spec.ts`
- Modify (only if a genuine layout bug surfaces): `frontend/app/lib/frame/patterns/layouts/*.ts`

For every format in `FRAME_FORMATS` × kinds {word, phrase, sentence} × {image, no image}, with the Stage 1 content fixtures plus a number fixture (`date: '–30%'` variant for one pass), using `candidatesForFrame` with the stub measure and the format's preset stored in `sailor_frame.preset`:
1. Every candidate re-planned with `planLayout` has `issues: []` (which now includes rule 8).
2. Every text element (placed, not hidden) has `size ≥ INFO floor − 0.01` for the format.
3. The number of layouts offered is **≥ 6** for every non-banner format, **≥ 3** for `ad-160x600`, `ad-970x250`, `ad-300x600`, **≥ 2** for `ad-728x90`, **≥ 1** for `ad-320x50` (ruling P6). A combination below its floor is a failure unless listed in `EXPECTED_THIN` with a measured reason.
4. `video-thumb`, `ad-320x50`: date and caption layers are hidden in every plan; `ad-160x600`, `ad-728x90`, `ad-300x600`, `ad-970x250`: caption hidden.
5. Keep-clear formats: no text box outside the band (independent of the checker: assert with `boxOf` against the band).

- [ ] **Step 1:** write the matrix. **Step 2:** run; for each failure, decide: a genuine layout bug → fix the layout minimally (report it); a format where a layout honestly cannot compose → it must be *rejected by the checker*, not offered — never loosen the checker; a floor miss → `EXPECTED_THIN` with the measured reason. **Step 3:** green, and the Stage 1 matrix still green.

---

### Task 8: The Layout tab names the format; the editor shows covered areas

**Files:**
- Modify: `frontend/app/composables/useLayoutVary.ts`, `frontend/app/components/vue-canvas/compositor/LayoutVaryPanel.vue`, `frontend/app/components/vue-canvas/CompositorModal.vue` (stage overlay only, Layout-tab block and stage markup — stage only your hunks)
- Create: `frontend/app/components/vue-canvas/compositor/KeepClearOverlay.vue`
- Test: `frontend/tests/unit/layout-vary.unit.spec.ts` (extend), `frontend/tests/unit/keep-clear-overlay.unit.spec.ts` (mount with @vue/test-utils in happy-dom, like neighbouring component specs)

**Interfaces:**
- `useLayoutVary(...)` returns `format: ComputedRef<{ label: string; notes: string[]; hidden: string[] } | null>` — `hidden` is the **text** of the hidden layers (quoted in the UI), `notes` are plain sentences built from the format:
  - with `keep`: `The app covers the top and bottom of this format; text stays clear of them.` (for `pmax-*`: `Google may crop the edges; text stays in the middle.`)
  - with `view`: `Seen about ${view}px wide, so text is at least ${round(9)}px there.` → exactly: `` `Seen about ${view} px wide, so no text is smaller than 9 px there.` ``
  - with `carries`: `` `Carries the ${carries === 2 ? 'two' : 'three'} most important lines.` ``
- Panel: under the current layout's description, one line `Format: <label>` then the notes as small text, then, when `hidden.length`, `Not shown in this format: “<text1>”, “<text2>”.` (quote the first 24 characters of each, with an ellipsis when cut).
- `KeepClearOverlay.vue` props `{ keep: KeepClear; w: number; h: number }` draws four hatched, non-interactive (`pointer-events: none`) rectangles over the stage artboard, labelled `Covered by the app` (top and bottom only), visible only while the Layout tab is showing and the Frame has a format with `keep`. It must sit inside the artboard's own transformed box so it pans and zooms with the Frame (read how existing artboard overlays — grid overlay, guides — are mounted in CompositorModal and mount it the same way).

- [ ] **Step 1: Failing tests:** `format` is `null` for a custom Frame; for `video-thumb` its notes contain the view sentence and the "two most important lines" sentence and `hidden` quotes the date and caption texts; the overlay renders two labelled bars with heights `keep.top·h` and `keep.bottom·h` and `pointer-events: none`.
- [ ] **Step 2–4:** FAIL → implement → PASS; typecheck the three files against the baseline.

---

### Task 9: Browser proof, E2E, docs (controller)

**Files:**
- Modify: `frontend/tests/frame-layout-tab.spec.ts` (add a format test), `docs/STATE.md`

- [ ] E2E (subagent writes, controller runs against :3002): set the lab Frame to `meta-story` through the Frame size select, open Layout, apply the first tile → no text layer's box (from `sailor_localLayers` + the renderer's own box helper, or the tile's plan) lies in the top 14% / bottom 35%; the overlay is visible with "Covered by the app"; switch to `video-thumb` → the caption layer is `visible: false`, the panel says "Not shown in this format"; switch back to a custom size and apply → the caption is visible again (restored).
- [ ] Controller: in the browser pane, step Vary on `meta-story`, `video-thumb`, `ad-300x250`, `ad-728x90`; screenshot each; confirm nothing under the covered areas and nothing unreadable.
- [ ] STATE.md block; dashboard (read the live artifact fully first; replace, never append).

---

## Self-review notes (plan author)

- Spec §6 coverage: presets → T1; keep-clear → T2 (side margin), T4 (band, extensions, rule 8), T8 (overlay); minimum text by viewing size → T2; levels → T3 + T4 + T8; number-like text → T5 (and Stage 1's Number behind); platform buttons → P1 deferred to Stage 3; Google responsive display + blank space → P2 deferred to Stage 5; text over > 20% of the image → T6. §2.4 "the Frame's real pixel size" → covered by format detection (T1/P5): only the format's viewing width matters for readability, not the Frame's pixels.
- Types across tasks: `FrameFormat`, `KeepClear` (T1) → `SheetOpts.format/composeH` (T2) → `checkPlan(..., opts)` / `LayoutPlan.format` (T4) → `useLayoutVary().format` (T8). `LayerOp.hidden` (T3) → planner (T4).
