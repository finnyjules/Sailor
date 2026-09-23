# Frame layout system — Stage 4 (ad content and research layouts) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Frame's text can be read as ad content — a review, a list, a comparison, a stat, a second image — recognised where unambiguous and otherwise tagged by the user in the Layout tab; nine research-backed Performance layouts are built on it; the platform's own button becomes a Vary choice; Vary's ranking learns the research's clutter and dominance rules.

**Architecture:** The role model grows from four text roles plus action to a content model (`quote`, `by`, `rating`, `list`, `stat`, `statline`, `them`, `image2`). A new `kit/content.ts` reads it from the Frame (conservative recognition + the user's tags stored in `sailor_posterState.tags`). The kit gains owned text (a layout's own words: ✓ ✕ • 1 2 3, "Before"/"After", the Notes app's chrome), star ratings (owned star shapes with a hard-stop gradient) and leader lines (owned line layers); a list is ONE user layer placed line by line as runs. Nine layouts go into `layouts/performanceAds.ts`, appended to CATALOG. The Layout tab gains a Content section (what each line is) and a Button choice on formats where the platform draws its own.

**Tech Stack:** Nuxt 4 / Vue 3 / TypeScript, vitest, Playwright on `/dev/frame-lab`.

**Spec:** `docs/superpowers/specs/2026-09-23-frame-layout-system-design.md` §8 (Stage 4), §6 (platform buttons, carried by Stage 2 P1 → Stage 3 R11). Prototype: `docs/superpowers/specs/assets/2026-09-23-frame-layout-system/layout-pane.html` — `perfOfferFirst` … `perfPostit` ~1293–1451, `CONTENT_SETS` ~1620, the `stars` renderer ~1052, the `cta` axis ~1661. Ledgers: stage1/2/3 under `.superpowers/sdd/`.

## Global Constraints

- Stages 1–3 stay binding: layouts may set position, size, rotation, line/letter spacing, letter case, opacity, blend, crop — never the font family, weight or colour of the user's own text unless recolour is on. Every piece that carries user text reads against it (Stage 3 R6/R12 contrast picker) or the variation is refused.
- A layout's **own words** (✓ ✕, bullets, list numbers, "Before"/"After", the Notes app's "‹ Notes"/"Done", quote marks around a quote are NOT own words — see R4) are **owned text layers**: set in the Frame's caption layer's family (so they match the Frame), weight from the kit, colour by palette role (or the fixed Notes colours), removed/replaced like every owned piece.
- Swiss, Editorial and Street and the existing six Performance layouts are unchanged for Frames without the new content (all earlier matrices and the geometry pin stay green and unchanged).
- UI copy: sentence case; quote the Frame's own text; "image", never "photo"; no internal ids.
- Catalog order is seed order — the nine layouts are appended after the Stage 3 layouts.
- Subagents never commit or run the dev server; the controller commits (zsh: paths as an array).

## Rulings made while planning

- **R1 — Recognition is conservative; tags win.** A line is read as content only when unambiguous (rules below). The user can tag any text layer in the Layout tab's Content section; a tag always wins over recognition and over stored roles. Tags live in `sailor_posterState.tags: Record<layerId, ContentRole | 'unused'>` and are part of undo (add `'tags'` to `LAYOUT_KEYS`). `'unused'` hides the line from layouts (it is left where it is and never placed).
- **R2 — Recognition rules** (a layer is considered only if not already the title):
  - `rating`: the whole text matches `^\s*([0-5](?:[.,]\d)?)\s*(?:★|stars?|\/\s*5|out of 5)?\s*$` or consists of 1–5 `★` optionally followed by `☆`s → value (★ count, or the number).
  - `quote`: starts with `“`, `"` or `„` and is ≥ 3 words.
  - `by`: starts with `—`, `–` or `- ` and is ≤ 8 words (the reviewer).
  - `list`: a text layer with ≥ 2 lines (after splitting on `\n`) where every line is ≤ 8 words, or every line starts with `•`, `-`, `·` or `\d+[.)]`. Leading markers are stripped for layout (the user's text keeps them; the kit places the stripped lines as runs only if the marker is a bullet — see R5).
  - `stat`: number-like (`isNumberish`) AND ends in a unit word of ≤ 4 letters or a unit symbol (`g kg mg km m cm mm h min s mAh W V L ml x ×`), with no `%`, currency sign or date pattern. A stat's `statline` is the next-smaller text layer that is not otherwise claimed, if any.
  - `them` (compare): a layer starting with `vs`, `vs.` or `versus` (case-insensitive) → the rest of the line.
  - `image2`: the second image layer (document order), when there are ≥ 2.
  - Content shapes: `review = { stars?, quote, by? }` needs `quote`; `list = string[]` needs `list`; `compare = { them, rows }` needs `list` + `them` — rows are the list's lines; a line ending in ` ✓✓` or ` (both)` is ticked for both, otherwise ours ✓ and theirs ✕ (the suffix is stripped for display in owned glyph columns but the row label is the user's line placed as a run); `stat = { value, line? }` needs `stat`.
- **R3 — The nine layouts are Performance style** (spec §8 "Layouts (Performance)") and appear only when their content exists: Offer first (a number), Stat (stat), Review (review), Us vs them (compare), Before / after (image + image2), Feature callouts (list), Reasons why (list), Notes app (list), Post-it (no extra content).
- **R4 — Quote marks.** The quote's own text is the user's layer; the layout does not add quote marks around it (that would be changing the user's text). Review layouts may add a large owned `“` glyph as a decorative piece.
- **R5 — A list is one user layer placed as runs.** Each list item is placed by the layout as one or more runs (wrapped by the kit's line breaking) of the SAME layer, like Stage 1 display text. Markers the user typed (`•`, `-`, `1.`) stay in the user's text; layouts that draw their own numbers or bullets (Reasons why, Notes app) do so only when the user's lines have no marker, otherwise they use the user's markers.
- **R6 — Fixed colours by design.** Notes app: paper `#fbf8f1`, chrome text `#d49a1a` (owned). Post-it: note `#ffe45c`. These are owned pieces with fixed fills; the user's text on them goes through the contrast picker (if it does not read, the variation is refused). The prototype's Post-it handwriting face (Caveat) is **not** applied — the user's face stays (it would set the font of the user's text).
- **R7 — Platform's own button** (Stage 2 P1 / Stage 3 R11): on formats with `platformButton` and a Frame with an action line, Vary gains a choice `Button: In the image | Platform's own`; `Platform's own` hides the action line (named in "Not shown") and draws no button. Default: In the image.
- **R8 — Rank additions (research):** `−0.25 × max(0, smallTexts − 4)` where smallTexts = text elements with size < 1.3 × INFO (clutter); `+0.4` when the largest text is ≥ 2 × the second largest (a single dominant element); `+0.3` when a drawn button's fill contrasts ≥ 4.5:1 with the page (a button that stands out). Applies to Performance only.
- **R9 — Content hints** (spec §8, shown in the Layout tab under the Content section, never enforced): a rating of exactly 5.0 → `Ratings between 4.0 and 4.8 tend to read as more believable than a perfect 5.` ; an offer written as a percentage with a price ≥ 100 elsewhere (or an amount with a price < 100) → `For prices under 100, a percentage reads bigger; above it, an amount does.`

---

### Task 1: The content model — recognition, tags, content shapes

**Files:** Create `frontend/app/lib/frame/patterns/kit/content.ts`; modify `patterns/hierarchy.ts` (only if needed to share `isNumberish`/DATE_RE), `kit/types.ts` (`Content.review/list/compare/stat`, `RoleKey` gains the new roles, `faceOf` maps the new roles to a measured face: `quote` and `stat` → `details`; `by`, `rating`, `list`, `statline`, `them` → `caption`), `kit/plan.ts` (prepare: content + targets for the new roles; tags from `sailor_posterState.tags` win over everything; `'unused'` layers excluded), `composables/useLocalLayerEditor.ts` (`'tags'` in `LAYOUT_KEYS`).
**Test:** `frontend/tests/unit/frame-layout-content.unit.spec.ts`.

**Produces:**
```ts
export type ContentRole = 'title' | 'details' | 'date' | 'caption' | 'action' | 'quote' | 'by' | 'rating' | 'list' | 'stat' | 'statline' | 'them' | 'image2'
export interface ReadContent { roles: Partial<Record<ContentRole, string>>; review?: { stars?: number; quote: string; by?: string }; list?: string[]; compare?: { them: string; rows: { label: string; us: boolean; them: boolean }[] }; stat?: { value: string; line?: string } }
/** Read the Frame's content: tags first, then stored roles (Stage 1–3 rules), then R2 recognition. */
export function readContent(userLayers: LocalLayer[], inferred: FrameElements, tags: Record<string, ContentRole | 'unused'> | undefined): ReadContent
```
- [ ] Tests: each R2 rule with positives and negatives (`'4.7 ★'`, `'★★★★☆'`, `'5/5'` ratings; `'4.7 million'` not a rating; `'“Lightest shoe…”'` quote; `'— Maya R., verified buyer'` by; a 4-line list; a 2-line caption with a long line is NOT a list; `'198 g'` stat, `'–30%'` not a stat, `'19.09.2026'` not a stat; `'vs a typical trail shoe'` them); a tag overrides recognition and a stored role; `'unused'` removes a layer from every role; a Frame with none of the new content reads exactly as Stage 3 (deep-equal roles on all Stage 1–3 fixtures); undo restores tags.

---

### Task 2: Kit pieces — owned text, stars, leader lines, second image, list runs

**Files:** `kit/types.ts` (`OwnTextEl {k:'own', s, x, top|base, size, wt, ls, lh, align?, color?, hex?, rot?, role}`, `StarsEl {k:'stars', x, y, size, value, role}`, `LineEl {k:'ln', x1, y1, x2, y2, role?}`), `kit/sheet.ts` (builders: `own(s, o)`, `stars(value, x, y, size)`, `leader(x1, y1, x2, y2)`), `kit/toOps.ts` (owned text layer via `createTextLayer` in the caption layer's family, owned stars as star shape layers with a hard-stop linear gradient accent→`ink` at 22% alpha per star, owned line layers; `photo2`/`image2` role → op on `targets.image2` with crop cover; list items: elements with base role `list` become ONE op with runs on the list layer — reuse `displayOp` by making list items `pre` runs), `kit/check.ts` (boxes for the new kinds; owned text counts as text for collisions, off-page and minimum size; lines never collide), `kit/contrast.ts` (owned text and stars go through the picker as text on pieces), `kit/plan.ts` (targets.image2).
**Test:** extend `frame-layout-toops`, `frame-layout-check`, `frame-layout-contrast`.
- [ ] Tests: an `own` element becomes an owned text layer (`owner.key 'own-N'`), family = the caption layer's, colour role applied (fixed `hex` when given); stars 4.7 → 5 star layers, the 5th with a stop at 70%; a leader line → an owned line layer; an `image2` photo → op on the second image with `crop: cover`; three list items → one op on the list layer with the items' runs (union centred, R2 invariant); checker negative controls for owned text off the page and below the minimum size.

---

### Task 3: The platform button choice, research ranks, content hints

**Files:** `kit/vary.ts` (`Choice.cta?: 'drawn' | 'native'`, offered only when `opts.platformButton && opts.hasAction`, diversity weight 1.5), `kit/plan.ts` (pass `platformButton`/`hasAction`; `cta: 'native'` → action not placed + no button, named in notPlaced), `kit/styles.ts` (Performance rank additions R8), `kit/content.ts` (`contentHints(read): string[]` R9).
**Test:** extend `frame-layout-vary`, `frame-layout-styles`, `frame-layout-content`.
- [ ] Tests: the cta choice appears only on a `platformButton` format with an action line; `native` hides the action and draws no `btn`; Swiss/Editorial/Street never offer it; each R8 term with a two-candidate ordering test; Stage 3 Performance candidate SETS unchanged (only order may move — report); both R9 hints fire on the right inputs and not otherwise.

---

### Task 4: Four layouts — Offer first, Stat, Review, Us vs them

**Files:** Create `layouts/performanceAds.ts`; modify `layouts/catalog.ts` (append, `style: 'performance'`, `oneLineFirst: true`, a `needsContent?: ('number'|'stat'|'review'|'compare'|'list'|'image2')[]` gate in `fitsFrame`); **Test:** create `frame-layout-ads-matrix.unit.spec.ts`.
Port `perfOfferFirst`, `perfStat`, `perfReview`, `perfVersus` from the prototype (~1293–1366) with R4/R5/R6 applied. Offer first's number panel is an owned `panel` (contrast picker). Us vs them: row labels are the list layer's runs; ✓/✕ are owned text; the "them" heading is the user's `them` layer; the product name heading is the details layer.
**Matrix:** the ad fixture (`title 'Run lighter.'`, `details 'Halden Trail 2'`, `date '–30%'`, `caption 'Offer ends 12 October. While stocks last.'`, `action 'Shop now'`, `quote '“Lightest shoe I have ever raced in.”'`, `by '— Maya R., verified buyer'`, `rating '4.7 ★'`, `list 'Carbon plate for push-off\n198 g per shoe\nGrips on wet rock\nFree returns for 60 days'`, `stat '198 g'` + `statline 'Our lightest trail shoe yet.'`, `them 'vs a typical trail shoe'`) × frames {portrait, square, story, feed 4:5, 300×250} × {with image} × {with/without action}: every candidate passes, floors ≥ 1 per layout where its content exists (EXPECTED_THIN with measured reasons otherwise); a Frame without the content never offers the layout.

---

### Task 5: Five layouts — Before / after, Feature callouts, Reasons why, Notes app, Post-it

**Files:** `layouts/performanceAds.ts`, `layouts/catalog.ts`, extend the ads matrix (second image fixture for Before / after).
Port from the prototype (~1368–1451) with R4–R6: Before / after uses `image` + `image2` (the "before" image gets no colour filter — a filter would change the user's image; label pieces are owned text "Before"/"After"); Feature callouts' leader lines and dots are owned; Reasons why numbers are owned text unless the user's lines carry markers (R5); Notes app's paper/chrome fixed colours (R6); Post-it without Caveat (R6).

---

### Task 6: The Layout tab — Content section, hints, Button choice

**Files:** `composables/useLayoutVary.ts`, `components/vue-canvas/compositor/LayoutVaryPanel.vue`, a new `compositor/LayoutContentList.vue`; `CompositorModal.vue` wiring only.
- **Content** (collapsed by default, under the Style control): one row per text layer — the layer's text quoted (first 24 chars, `…`) and a select of what it is: `Headline`, `Product or name`, `Offer or date`, `Fine print`, `Button`, `Quote`, `Reviewer`, `Rating`, `List`, `Stat`, `Stat line`, `Competitor`, `Not used` (plus `Automatic` = recognition). Changing a row writes `sailor_posterState.tags` as its own undo step and re-plans. Second image: a row for each image layer beyond the first — `Second image (before / after)` / `Not used`.
- **Hints** (R9) as small text under the Content section.
- **Button** choice pills appear in the Choices when offered (R7), labels `In the image` / `Platform's own`.
- Tests: tags round-trip and undo; a tag changes the library (e.g. tagging a line as Quote makes Review appear); hints render; the Button pills appear only on a platform-button format with an action line.

---

### Task 7: Browser proof, E2E, docs (controller)

- E2E: on the lab Frame, tag a line as Quote and one as Rating → Review appears in Performance and applies; tag a line List → Reasons why applies with the list layer's runs; on `meta-story`, the Button choice appears and `Platform's own` hides the action.
- Browser screenshots of Review, Us vs them, Notes app; STATE.md; dashboard (read fully, replace).

## Self-review notes

- Spec §8 coverage: content kinds review/list/compare/stat recognised (T1 R2) or tagged (T1 + T6); the nine layouts (T4–T5), each offered only when its content exists; Vary rank additions (T3 R8); content hints (T3 R9, T6). Not planned (spec says so): Bundle, Face + gaze. Carried: platform's own button (T3 R7, T6).
- Types: `ContentRole`/`ReadContent` (T1) → `OwnTextEl`/`StarsEl`/`LineEl` (T2) → `Choice.cta` (T3) → `needsContent` (T4) → panel (T6).
