# Frame layout decisions (Stage 4b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the 12 Frame-layout calls Julien made on 2026-09-24 ("Layout calls" artifact, `picks/*`).

**Architecture:** Small, independent changes on the existing kit (`frontend/app/lib/frame/patterns/kit/`), layouts (`layouts/`), and the Layout tab (`composables/useLayoutVary.ts`, `compositor/LayoutVaryPanel.vue`). One larger change: every layout places the Frame's extra images.

**Tech Stack:** Nuxt 4 / Vue 3 / TypeScript; vitest unit specs in `frontend/tests/unit/`; Playwright in `frontend/tests/`.

**Spec:** `docs/superpowers/specs/2026-09-23-frame-layout-system-design.md` plus the user's picks (memory `frame-layout-decisions-2026-09-24`). The picks override the spec where they differ.

## Global Constraints

- Layouts never set the font family, weight or colour of the user's text (colour only when recolour is on). They may set position, size, rotation, line/letter spacing, letter case, opacity, blend, crop.
- Never edit the user's words.
- Every piece carrying user text goes through the contrast picker (`kit/contrast.ts`).
- The catalog order is append-only (it seeds randomness).
- Every change ships a unit test that fails before it. Matrices (Stage 1, format, style, ads) stay green; any candidate-set change is intended and pinned with a measured reason.
- UI copy: sentence case, quote the Frame's own text, "image" never "photo", no internal ids.
- Work in the main checkout; subagents never commit and never run the dev server.

## Kept as is (no task)

Review/Stat/Post-it keep hiding the headline · the Content menu keeps plain "Automatic" · Run-off stays off stories · Street Repeat stays solid.

---

### Task 1: Ad content tweaks

**Files:** `layouts/performanceAds.ts`, `kit/content.ts`; tests `frame-layout-ads-matrix.unit.spec.ts`, `frame-layout-content.unit.spec.ts`.

- **Stars:** Review draws its owned stars only when the rating line does not already contain a star glyph (★ ☆ ⭐). The `did` stays true in both cases.
- **Partial list markers:** when some list lines carry a marker (a number or a bullet) and some don't, `contentHints` adds, verbatim: `Some lines start with a number and some don't.` Reasons why still draws no numbers then.
- **Us vs them:** the product image grows into the height left under the table (it moves below the table, full content width, height = what is left above the foot), instead of the prototype's small image above it. Keep the checker's image rules.

### Task 2: The Button choice in every style

**Files:** `kit/plan.ts`, `kit/vary.ts` (gate only); tests `frame-layout-style-matrix.unit.spec.ts`, `frame-layout-vary.unit.spec.ts`.

The `cta` axis (In the image / Platform's own) is offered in every style that draws a button — Performance, Editorial, Street — on platform-button formats with an action line (spec §6). Swiss hides the action line, so it never offers it. Rulings R11 (native is never a rescue) and R11b (the first candidate is drawn) apply in every style. Non-platform formats and Frames without an action: byte-identical.

### Task 3: Small banners and long dates

**Files:** `kit/styles.ts` (the 0.55 cover rule at ~l.98), the measure/wrap code for the date (`kit/sheet.ts` / `kit/measure.ts`); tests in the format and style matrices.

- **Small formats:** Performance's "image mostly hidden" limit relaxes from 55% covered to 70% covered (at least 30% visible) when the Frame's design width is under 336 px. Pin which layouts newly pass on 300×250 and 320×50.
- **Date ranges:** a date line may break after an en dash or a hyphen between two dates ("19.09.–" / "15.11.2026") — never elsewhere. Pinterest with the long date must offer more layouts than today; pin the count.

### Task 4: Knockout remembers the shape; overlap accent copy

**Files:** `layouts/swissShapes.ts` (knockout), `layouts/overlap.ts` (overprint, number behind), `patterns/apply.ts` (layoutPrev); tests `frame-layout-apply*.unit.spec.ts` or a new spec.

- **Knockout:** the shape's size and geometry the layout overrides are recorded in `layoutPrev` like other fields, so a later layout that doesn't set them restores the shape (an ellipse comes back an ellipse).
- **Overlap accent:** with recolour off, Overprint and Number behind add their own owned copy of the overlapping line in the accent colour — same words, face, weight and size as the user's line it copies (an exception to R10: a copy must match what it copies) — and leave the user's line in its own colour, drawn over the copy. With recolour on, unchanged.

### Task 5: Arrangement pills as words

**Files:** `kit/types.ts` (`LayoutDef.arrLabels`), every layout file, `composables/useLayoutVary.ts` (AXES arr labels from the layout), tests `layout-vary*.unit.spec.ts` + a catalog test.

Each layout with more than one arrangement names them in words that describe what changes (e.g. Run-off: "Right edge", "Left edge", "Lower"), sentence case, ≤ 14 characters, distinct within a layout. A catalog test asserts every layout offering `arr` has one label per value. No generic fallback to letters.

### Task 6: Re-apply on tag change and after a suggested face loads

**Files:** `composables/useLayoutVary.ts`, `useLocalLayerEditor.ts` if needed; tests `layout-content.unit.spec.ts`, `layout-vary*.unit.spec.ts`.

- **Tag change:** when a layout is applied, changing a tag re-applies the current layout (same layout, the closest candidate to the current choice, else the first) in the SAME undo step as the tag write. One undo restores both.
- **Suggested face:** after accepting the suggested face, once the font has loaded (`document.fonts.load` for that family/weight; give up after 3 s) re-apply the current layout, folded into the face's undo step. No re-apply if the user did anything else meanwhile.

### Task 7: Every layout places the extra images

**Files:** `kit/plan.ts` (a kit-level extras pass), `kit/sheet.ts` / `kit/check.ts` (occupancy), `kit/toOps.ts`; tests: new `frame-layout-extras.unit.spec.ts`, all matrices.

A Frame image a layout does not place (beyond `image`, and `image2` where a layout uses it) is placed by the planner after the layout: as a row of equal tiles (cropped, `crop` set so wired images honour `h`) in the largest free rectangle that clears every text box and the keep-clear band, at a minimum tile of 12% of the frame width. If no such room exists the variation is refused with the reason `no room for the other images`. This replaces ruling R14's hide-and-name. A Frame with a single image is byte-identical. Pin, with measured reasons, how many layouts the lab Frame (two images) and the matrices' two-image fixtures lose.

### Task 8: Browser proof, E2E, docs (controller)

E2E additions for: arrangement words, Button pills on Editorial, the lab Frame's second image placed by a Swiss layout. Browser look at Us vs them (grown image), a two-image Frame through three layouts, Knockout → another layout restoring an ellipse. STATE.md, dashboard, memory.
