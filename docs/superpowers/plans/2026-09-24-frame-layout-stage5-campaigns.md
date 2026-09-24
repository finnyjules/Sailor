# Frame layouts, Stage 5 — Campaigns (Make a set) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the Layout tab, pick formats; the Frame's current layout is recomposed at each one, checked, shown side by side at true proportions; download the set as a zip of PNGs, or send any one format to the canvas as its own Frame.

**Architecture:** A pure `planSet` in the kit runs the existing planner once per format (same layout, closest choice; else the best-ranked layout in the same style). The Layout tab gains a "Make a set" section that opens a set sheet painting each result with the Frame's own renderer. Download renders each format with the static composite path at the format's size. "Send to canvas" creates a new, independent Frame node beside the original.

**Tech Stack:** Nuxt 4 / Vue 3 / TypeScript; vitest in `frontend/tests/unit/`; Playwright in `frontend/tests/`.

**Spec:** `docs/superpowers/specs/2026-09-23-frame-layout-system-design.md` §9 (Stage 5 — Campaigns), plus Julien's answers on the mockup https://claude.ai/artifact/ST57qzK8ULBgUZeJdnVaqx (db `answers/*`): output = **both** (download + send one to the canvas); fallback = **best fit** in the same style; hand edits = **send it to the canvas** (no per-format Vary inside the set).

## Global Constraints

- Layouts never set the font family, weight or colour of the user's text (colour only when recolour is on); never edit the user's words.
- The set never changes the original Frame: planning is pure, and nothing is written to the source Frame except the remembered format selection (no history step for that).
- Every format result passes the same checker as a single Frame; a format with no passing layout at all is shown as "Nothing fits this format" and is not exported.
- UI copy: sentence case, quote the Frame's own text, "image" never "photo", no internal ids (format names come from `FRAME_FORMATS` labels).
- Formats come from `frontend/app/lib/frame/formats.ts` (`FRAME_FORMATS`); sizes are the formats' own pixel sizes.
- v1 exports stills (PNG). A Frame with motion exports its still; a video set is out of scope (named in the sheet: "Stills only for now").
- Work in the main checkout; subagents never commit and never run the dev server. Other sessions edit `CompositorModal.vue` — stage only your own hunks.

---

### Task 1: `planSet` — the set, planned

**Files:** create `frontend/app/lib/frame/patterns/kit/set.ts`; test `frontend/tests/unit/frame-layout-set.unit.spec.ts`.

`planSet(args)` takes what `candidatesForFrame` / `planLayout` take for the source Frame (its layers views, roles, tags, style, palette, brand logo, recolour flag, stored choice and layout id) plus `formats: string[]`, and returns one entry per format, in the order given:

`{ formatId, label, w, h, layoutId: string | null, layoutName: string | null, swapped: boolean, choice, plan: LayoutPlan | null, layers: LocalLayer[] | null }`

- Plan the SAME layout at the format's own size (`frameW/H` = the format's w/h, the format passed so keep-clear bands, levels and hidden lines apply). Choose the candidate whose choice equals the stored one, else the closest (most matching axes — reuse the helper Task 6 of the decisions plan added for tag re-apply if exported; export it if not), else the first.
- If the layout is not offered at that format: take the first layout of the same style's library order at that format (`swapped: true`). Stage 4 `needsContent` gating and every Stage 1–4 rule apply as usual.
- If nothing is offered: `layoutId: null, plan: null, layers: null`.
- `layers` is the result of applying the plan to a deep clone of the source layers (the same pure apply the Layout tab uses — find it, e.g. `applyLayoutToFrame`), so owned pieces, extra images (Task 7 of the decisions plan) and hidden lines are exactly what an apply would write. The source array must be untouched (test: deep-equal before/after).
- Deterministic: same inputs → same output.

Tests: a portrait source with Run-off applied → meta-feed-1x1 keeps Run-off (not swapped), meta-story swaps (Run-off is never offered on stories) to the style's first offered layout, a format where nothing fits returns nulls; the stored choice is kept where it exists; the source layers are unchanged; performance: a 10-format set plans in under 1.5 s in the unit environment (report the number).

### Task 2: The set sheet in the Layout tab

**Files:** `frontend/app/composables/useLayoutVary.ts` (expose what `planSet` needs, or a `useLayoutSet` composable beside it), create `frontend/app/components/vue-canvas/compositor/LayoutSetSheet.vue`, `LayoutVaryPanel.vue` or `CompositorModal.vue` wiring (own hunks only); tests `frontend/tests/unit/layout-set.unit.spec.ts`.

- A collapsed **Make a set** section in the Layout tab (under the layout panel, above Title face): format checkboxes grouped as in the size menu (Social / Display ads — reuse the grouping `plainPresets.ts`/`frameSize.ts` use), and a button `Open the set` (disabled with no format ticked). Only shown when a layout is applied.
- The selection is remembered on the Frame in `sailor_posterState.set = { formats: string[] }`, written WITHOUT a history step, and not part of `LAYOUT_KEYS`.
- The sheet: an overlay over the canvas area (reuse the modal's existing sheet pattern — the web export sheet is the model), title `<Layout name>, in N formats`, a summary line (`N as <layout> · M with another layout · K where nothing fits`), and one tile per format at true proportions (longest side capped so a row fits; banners wrap), each painted by the Frame's own renderer (reuse `LayoutTile`'s painting path so the tile is the real picture), labelled with the format label, and a chip: the layout name, or `<Other layout> — <Layout> doesn't fit` in amber, or `Nothing fits this format`.
- A `Show covered areas` switch draws each format's keep-clear bands over its tile (reuse `KeepClearOverlay` geometry).
- Footer: `Download N images` and a note `Stills only for now.` when the Frame has motion.
- Each tile has `Send to canvas` (Task 4 wires it; here it emits an event).
- The sheet re-plans when opened and when the selection changes; it never writes the source Frame.

Tests: the section lists every `FRAME_FORMATS` entry in its group; ticking persists without a history step; the sheet shows one tile per ticked format with the right chip for kept / swapped / nothing-fits; the covered-areas switch adds bands only on formats that have them.

### Task 3: Download the set

**Files:** `CompositorModal.vue` (own hunks: parametrise `renderStaticComposite` to take layers + size, or add a sibling that does), reuse an existing zip helper (`lib/deliverables/zip.ts` or `lib/collection/batchZip.ts` — pick one, say why); tests `frontend/tests/unit/layout-set-export.unit.spec.ts` for the pure parts (file naming, which entries export).

- Each exported format renders the planned `layers` at the format's own pixel size through the same static path `Download PNG` uses (fonts and images ensured, wired content resolved per slot as the modal does), so a set image equals what that Frame would download at that size.
- One zip: `<frame-name-or-"frame">_set_<timestamp>.zip`, entries `<format-id>.png` (e.g. `meta-story.png`, `ad-300x250.png`). Entries with nothing fitting are skipped.
- Progress in the sheet (`Rendering 3 of 7…`), a Cancel that stops before the next format, errors named per format without aborting the others.
- Download through the app's existing download helper (`downloadBlobAsFile`).

Tests: naming, skipping, cancel between formats (with the renderer injected), an error on one format leaves the others.

### Task 4: Send one format to the canvas

**Files:** find how the canvas creates / duplicates a Frame node (⌘D on a Frame, `VueNodeCanvas.vue`, the `sailor:*` window-event convention — canvas nodes never own modal state); a `sailor:` event from the modal; tests in a unit spec for the pure node-props builder.

- `Send to canvas` creates a NEW Frame node next to the source (offset right of it, not overlapping; several sends step further), fixed size = the format's w×h with its preset stored (so `formatFor` detects it), `sailor_localLayers` = the planned layers, the source's background, groups, wired inputs/edges where a wired image slot is used (reuse duplicate's edge handling), and `sailor_posterState` = `{ patternId, choice, style, roles, tags }` of that plan so its Layout tab opens on that layout. Owned pieces keep their `owner`.
- Independent: nothing links back; the source Frame is untouched.
- One canvas undo step if the canvas records node creation (say what it does).
- A toast: `Added “<Frame name>” · <format label> to the canvas.`

Tests: the props builder (size, preset, layers, posterState, owned pieces kept, source untouched).

### Task 5: Browser proof, E2E, docs (controller)

E2E: tick three formats → open the set → three tiles with the right chips → Send to canvas adds a Frame node of the story size → Download produces a zip with the expected entries (Playwright download event). Browser look at the lab Frame's set. STATE.md, dashboard (Stage 5 LANDED; the Smart Layout retirement staged), memory.
