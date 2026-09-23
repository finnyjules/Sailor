# Frame layout system — Stage 3 (styles) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Layout tab offers four styles — Swiss (Stages 1–2), Performance, Editorial and Street — each a rule set on the same kit with its own type spacing and case, its own pieces (buttons, logos, bands, cards, stickers, tags), its own 4–6 layouts, its own Vary ranking and its own checks, plus a suggested title face you can accept.

**Architecture:** A `kit/styles.ts` table holds each style's display/info spacing, letter case, button look, level order, suggested face, rank and extra checks. The sheet takes a style; toOps writes the style's letter case as a tracked field. Two new content roles are read from the Frame: an **action** line ("Shop now") and a **logo** from the project's brand kit. New owned pieces map onto existing layer kinds: a band is a rect with a page-colour → transparent gradient, a button is a rounded rect behind the user's own action text, a logo is an image layer. Style layouts live in `layouts/performance.ts`, `layouts/editorial.ts`, `layouts/street.ts`; the catalog gains a `style` on each layout, and the Layout tab gains a Style picker.

**Tech Stack:** Nuxt 4 / Vue 3 / TypeScript, vitest (node + happy-dom), Playwright on `/dev/frame-lab`.

**Spec:** `docs/superpowers/specs/2026-09-23-frame-layout-system-design.md` §7 (Stage 3) and the decisions table. Prototype: `docs/superpowers/specs/assets/2026-09-23-frame-layout-system/layout-pane.html` — `STYLES` ~1121, `setStyle` ~1131, `button` ~1140, `logo`/`logoH`/`clear` ~1150, `tag` ~1159, `scrim` ~1178, spacing `gapBelow`/`groupGap`/`inset` ~1184, `offerBox`/`offerStack`/`headStack` ~1189–1216, the 15 layouts (`defS('performance', 'perfOffer' … 'perfStrip'` ~1219–1292, `edCover … edDiptych` ~1452–1522, `stFill … stStrip` ~1523–1588), `STYLES.performance.check` ~1592, the three `rank`s ~1610–1612. Stage 1–2 ledgers: `.superpowers/sdd/2026-09-23-frame-layout-system-stage1/progress.md`, `.superpowers/sdd/2026-09-24-frame-layout-system-stage2/progress.md`.

## Global Constraints

- Everything from Stages 1–2 stays binding: a layout may set position, size, rotation, line and letter spacing, **letter case** (spec decision: "letter case is spacing-like and the style may set it"), opacity, blend, crop — never the font family, weight or colour of the user's own text unless recolour is on. Owned pieces take palette-role colours.
- The Swiss style is exactly Stages 1–2: same 42 layouts, same candidates, same geometry (the Stage 1 no-format geometry pin and the Stage 1 and format matrices stay green, unchanged).
- A suggested face is applied **only when the user accepts it** (a button, its own undo step) — never by a layout.
- Performance: **text never sits on a raw image** — only on the page colour (bands, cards, panels, stickers). Street: text over an image only where a band or tag bridges them (pixel contrast checks are deferred — ruling S5).
- Performance product visibility: solid page colour covers ≤ 55% of the visible image; fades count 0.35 (prototype `STYLES.performance.check`).
- Logo clear space ≥ 0.35 × logo height on every side (spec §7), checked.
- UI copy: sentence case; quote the Frame's own text; "image", never "photo"; no internal ids.
- Kit units: percent of frame width. Catalog order is seed order — style layouts are appended after the 42 Swiss layouts, never interleaved.
- Subagents never commit and never run the dev server; the controller commits with the private-index recipe (zsh: pass paths as an array).

## Rulings made while planning

- **S1 — The button label is the user's own text; the button colour adapts to it.** An `action` text layer is placed on a rounded rect (owned). Because a layout may not recolour the user's text, the rect's fill is the palette role (`ink`, `accent`, `field`) with the **highest contrast against the action text's own colour**, required ≥ 3:1; if none reaches 3:1, the button draws as an **underlined link** instead (tracked `underline` on the action text). With recolour on, the prototype's colours apply (text `field` on `ink`/`accent`).
- **S2 — Logo from the brand kit.** The planner takes `brandLogo?: { url: string; aspect: number; onDarkUrl?: string }`; the Layout tab passes the project's brand kit logo (`logos.primary`, `logos.onDark` on a dark field; legacy `logo`). With no kit logo, layouts simply omit it. The logo is an owned image piece (key `logo-0`); edit it and it becomes yours.
- **S3 — The action role.** A text layer is the action when it is ≤ 4 words, not number-like, not the largest text, and either matches a call-to-action verb list (`shop, buy, order, get, book, reserve, download, sign up, join, subscribe, learn, discover, see, try, start, register, apply, donate, watch, listen, call, visit, explore` — case-insensitive, first word) or ends with `→`/`›`. The action is its own level, placed after `date` in every style's level order except Performance (`title, date, details, action, caption` — the offer outranks the product name).
- **S4 — Styles filter the library.** Each layout carries `style: 'swiss' | 'performance' | 'editorial' | 'street'` (Swiss for the 42). The Layout tab shows one style at a time; the chosen style is stored in `sailor_posterState.style` (default `'swiss'`).
- **S5 — Street's contrast check is structural in Stage 3.** Text may overlap the image only where a band or a tag lies between them (the prototype's own interim rule, ~line 1527). A pixel contrast check needs the image's luminance and is deferred.
- **S6 — Only the 15 layouts the spec names** (Performance: Offer, Sticker, Price tag, Card, Centred, Strip; Editorial: Cover, Framed, Quiet, Diptych; Street: Fill, Tag, Drop, Repeat, Strip). The prototype's research layouts (Offer first, Stat, Review, Us vs them, Before / after, Feature callouts, Reasons why, Notes app, Post-it) are Stage 4.
- **S7 — Editorial's rank uses element boxes**, not page boxes: text share = Σ text box areas / page area (the prototype measured DOM boxes).

---

### Task 1: The style table; the sheet and toOps take a style

**Files:**
- Create: `frontend/app/lib/frame/patterns/kit/styles.ts`
- Modify: `kit/sheet.ts` (`SheetOpts.style?`), `kit/toOps.ts` (letter case), `patterns/apply.ts` (`track('textTransform', …)`), `patterns/types.ts` (`LayerOp.textTransform?`), `kit/types.ts` (`TextEl.upper?`, `LayoutDef.style?`)
- Test: `frontend/tests/unit/frame-layout-styles.unit.spec.ts`

**Interfaces — Produces:**
```ts
// kit/styles.ts
export type StyleId = 'swiss' | 'performance' | 'editorial' | 'street'
export interface StyleSpec {
  id: StyleId; label: string                 // 'Swiss' | 'Performance' | 'Editorial' | 'Street'
  display: { wt: number; ls: number; lh: number; upper?: boolean }
  info: { wt: number; ls: number; lh: number; upper?: boolean }
  button?: { shape: 'pill' | 'box' | 'link'; wt: number; ls: number }
  /** Level order, most important first (Stage 2 `carries` uses it). */
  levels: ('title' | 'details' | 'date' | 'action' | 'caption')[]
  face?: { family: string; wt: number; ls: number; note: string }
  /** No text on a raw image (Performance, Street — see S5). */
  textOffImage?: boolean
}
export const STYLES: Record<StyleId, StyleSpec>
```
Values verbatim from the prototype `STYLES` (~1121): swiss display `{600,-0.05,0.9}` info `{400,0,1.3}`, levels `title, details, date, action, caption`; performance display `{700,-0.035,0.94}` info `{500,0,1.3}` button pill `{600,0}` levels `title, date, details, action, caption`, `textOffImage`; editorial display `{400,-0.015,1.04}` info `{500,0.16,1.6, upper}` button link `{500,0.16}` face `Instrument Serif` wt 400 ls −0.01 note `A serif for the title`; street display `{700,-0.045,0.84, upper}` info `{600,0.04,1.25, upper}` button box `{700,0.06}` face `Anton` wt 400 ls 0 note `A heavy condensed face for the title`, `textOffImage`.
- `SheetOpts.style?: StyleId` sets `DISPLAY`/`INFO` `wt/ls/lh` from the table (`SECOND` keeps its Swiss values in every style — the prototype did not restyle it). Absent → `'swiss'` → byte-identical to today.
- `disp()`/`info()` mark `upper: true` when the style's display/info is upper; the kit measures an upper element with `transformCase(text,'uppercase')` (the measure takes the case through a new optional `upper` flag on `w100`/`lines` — the canvas measure already uppercases when the role layer is uppercase; extend it to honour the flag).
- toOps writes `textTransform: 'uppercase'` on an op whose element is `upper`; apply tracks it (`track('textTransform', op.textTransform)`), so the user's own case comes back when a later layout leaves it unset.

- [ ] **Step 1: Failing tests:** each style's sheet has the table's DISPLAY/INFO values; a swiss (or style-less) sheet deep-equals today's sheet on the 4 Stage 1 frames; an upper display element measures wider with the stub (upper letters) and its op carries `textTransform: 'uppercase'`; apply then a later op without it restores the user's `textTransform` (absent → key removed; user's `'lowercase'` → back to `'lowercase'`).
- [ ] **Step 2–4:** FAIL → implement → PASS on all `frame-layout*`, `frame-patterns*`, `layout-*`.

---

### Task 2: The action line and the brand logo

**Files:**
- Modify: `frontend/app/lib/frame/patterns/hierarchy.ts` (action), `patterns/types.ts` (`FrameElements.action?`), `kit/types.ts` (`Content.action?`, `Content.logo?: { url: string; aspect: number; onDarkUrl?: string }`, `RoleKey` gains `'action'`), `kit/plan.ts` (`LayoutPlanArgs.brandLogo?`, content/targets/levels/stored roles for `action`), `kit/toOps.ts` (targets `action`)
- Test: `frontend/tests/unit/frame-patterns-hierarchy.unit.spec.ts`, `frame-layout-plan.unit.spec.ts` (extend)

Rules: ruling S3 for the action; the action is excluded before the Stage 1 title/caption/date/details inference runs (so it never becomes the caption). Levels: Stage 2's `hiddenRoles` uses the **style's** `levels` (Swiss: `title, details, date, action, caption`), counting only lines the Frame has. `faceOf('action')` → `'caption'` for measuring (the info face). The Swiss layouts ignore `action` and `logo` (they never read them) — so Swiss plans are unchanged except that an action layer is no longer mistaken for the caption or details: **record this as the one intended Swiss change** and pin it with a test (a Frame with an action line: Swiss places the other four exactly as a Frame without it does).

- [ ] **Step 1: Failing tests:** `['Run lighter.' (large), 'Halden Trail 2', '–30%', 'Shop now', 'Offer ends 12 October.' (small)]` → title/details/date/caption as before and `action = 'Shop now'`; `'Book tickets →'` is an action; `'Learn more about our process today'` (6 words) is not; a Frame without an action line infers exactly as before (deep-equal, all Stage 1/2 hierarchy fixtures); `brandLogo` passes through to `content.logo`.
- [ ] **Step 2–4:** FAIL → implement → PASS (Stage 1 + format matrices unchanged).

---

### Task 3: New owned pieces — band, button, logo — and their checks

**Files:**
- Modify: `kit/types.ts` (new elements), `kit/sheet.ts` (builders), `kit/toOps.ts` (mapping), `kit/check.ts` (boxes + rules), `kit/plan.ts` (palette + action-colour to toOps for S1)
- Test: `frame-layout-toops.unit.spec.ts`, `frame-layout-check.unit.spec.ts`, `frame-layout-kit-sheet.unit.spec.ts` (extend)

**Interfaces — Produces:**
```ts
// kit/types.ts
export interface BandEl extends Base { k: 'band'; side: 'top' | 'bottom'; y: number; h: number; solid: number }      // prototype `scrim`
export interface ButtonEl extends Base { k: 'btn'; x: number; y: number; w: number; h: number; size: number; shape: 'pill' | 'box' | 'link' }   // the label is the action text element, placed separately with role 'action', over: ['btn']
export interface LogoEl extends Base { k: 'logo'; x: number; y: number; w: number; h: number }
// Sheet builders (prototype maths verbatim): band(side, from, to) · button(label, x, top, o) → { btn: ButtonEl, text: TextEl } · logo(x, top, h, o) · logoH() · clear(logo) · gapBelow(s) · groupGap() · inset()
```
Mapping in toOps (owned keys `band-N`, `button-N`, `logo-0`):
- `band` → owned rect `x 0, w 1` over its y/h with a linear gradient Paint: the `field` colour at 94% opacity from the band's outer edge to `solid`, then to fully transparent at the inner edge (read `lib/compositor/paint` for the LinearGradient shape: stops, angle).
- `btn` pill/box → owned rect with `radius` = h/2 (pill) or 0 (box); its fill role per ruling S1 (contrast ≥ 3:1 against the action text layer's current colour; the planner passes that colour into toOps); `link` → no rect, and the action op gets `underline: true` (tracked).
- `logo` → owned image layer from `content.logo.url` (`onDarkUrl` when the field colour's luminance < 0.4), box `w×h`, `crop` absent (contain — the logo keeps its aspect: `h = w × aspect`).
Checks (with negative controls):
- rule 9: **logo clear space** — any other element's box closer than `0.35 × logo.h` to the logo box → `'logo: needs clear space'`.
- rule 10 (styles with `textOffImage`): a text box that overlaps an image element by > 0.25 on both axes must lie **inside** the union of `band`/`card`/`panel`/`sticker`/`tag` boxes that sit above the image → else `` `${role}: sits on the raw image` ``.
- `boxOf`: band = `0..W × y..y+h`; btn = its rect; logo = its rect.

- [ ] **Step 1: Failing tests:** each builder matches the prototype numbers on a stub sheet; a band becomes one owned rect with a 3-stop gradient whose stop at `solid` is the field colour; a button on a black action text picks `field` (or whichever passes 3:1) and a button whose action text contrasts with no role becomes a link (`underline: true`, no rect); a logo becomes an owned image with the kit URL and aspect-true height; negative controls for rules 9 and 10.
- [ ] **Step 2–4:** FAIL → implement → PASS on `frame-layout*`, `frame-patterns*`.

---

### Task 4: Style checks and style ranks

**Files:**
- Modify: `kit/styles.ts` (`check?`, `rank?` per style), `kit/plan.ts` (run the style's check in `checkRun`; pass the style's rank to `enumerate`), `kit/vary.ts` (`opts.rank?: (out) => number` added to the score)
- Test: `frame-layout-styles.unit.spec.ts`, `frame-layout-vary.unit.spec.ts` (extend)

- Performance check — product visibility, the prototype's `STYLES.performance.check` ported to elements (`band` = scrim with its solid part and fade; `r` with role `card`/`panel`), with Stage 2 keep-clear areas taken from the format (only what people see counts) → `'the image is mostly hidden'` above 0.55.
- Ranks (added to the Stage 1 score): Performance `log(numberSize / INFO.size) × 0.8 + (a btn present ? 0.5 : 0)`; Editorial `3 × (1 − textShare) − max(0, distinctTextSizes − 3) × 0.6` (ruling S7); Street `2 × maxTitleSize / W + 0.3 × count(elements with non-empty over)`. Swiss: none (unchanged).

- [ ] **Step 1: Failing tests:** the visibility check passes at 50% solid cover, fails at 60%, and counts a fade at 0.35 (a band fade over 100% of the image alone does not fail); each rank orders two fake candidates as the prototype would; Swiss candidates' scores are unchanged (pin on one Stage 1 fixture).
- [ ] **Step 2–4:** FAIL → implement → PASS.

---

### Task 5: The six Performance layouts

**Files:** Create `frontend/app/lib/frame/patterns/layouts/performance.ts`; modify `layouts/catalog.ts` (append after the 42, `style: 'performance'`); Test `frontend/tests/unit/frame-layout-style-matrix.unit.spec.ts` (created here, extended by Tasks 6–7).

Port `perfOffer`, `perfSticker`, `perfPriceTag`, `perfCard`, `perfCentred`, `perfStrip` verbatim from the prototype, with `offerBox`/`offerStack`/`headStack` as shared helpers in `performance.ts` (or the sheet if Editorial/Street reuse them). Every Performance layout has `oneLineFirst: true` (prototype ~1591). Stage 1 port conventions apply (skip missing text; measure in the role's face; "image" in `did`). `wideOnly` (prototype flag) becomes `fits`-level gating: a `wideOnly` layout is offered only when the (composed) sheet is wide (`H < 70`).

**Style matrix:** for Performance × {portrait 895×1280, square 1080×1080, landscape 1280×720, story `meta-story`, feed `meta-feed-4x5`, `ad-300x250`} × {word, phrase, sentence} × {image, no image} × {with action, without} × {with logo, without} using the ad content fixture (`title 'Run lighter.'`, `details 'Halden Trail 2'`, `date '–30%'`, `caption 'Offer ends 12 October. While stocks last.'`, `action 'Shop now'`, logo `{ url: 'data:…', aspect: 0.3 }`): every candidate re-planned has no issues (all rules incl. 8–10 and the visibility check), every text ≥ the format floor, and each combination offers ≥ 2 Performance layouts when an image is present (≥ 1 without) unless listed in `EXPECTED_THIN` with a measured reason.

- [ ] Steps: failing matrix → port → green; Stage 1 and format matrices unchanged.

---

### Task 6: The four Editorial layouts

**Files:** Create `layouts/editorial.ts`; modify `layouts/catalog.ts`; extend the style matrix (same combinations, gallery content fixture: `title 'Weather Report'`, `details 'Ines Vollmer'`, `date '19.09.–15.11.2026'`, `caption 'Kunstraum Lenz\nLenzgasse 14, 4056 Basel'`, `action 'Book tickets'`), floors ≥ 2 with image, ≥ 1 without.

Port `edCover`, `edFramed`, `edQuiet`, `edDiptych` verbatim. Editorial's title may use the suggested face (Task 8) — layouts must not assume it: they measure with whatever face the title layer has.

---

### Task 7: The five Street layouts

**Files:** Create `layouts/street.ts`; modify `layouts/catalog.ts`; extend the style matrix (event content fixture: `title 'Open Studio'`, `details 'Mara Lind and guests'`, `date 'Sat 4.10., 18–23h'`, `caption 'Werkhof 3, Zürich\nFree entry'`, `action 'Get tickets'`), floors as above; `stStrip` is `wideOnly`.

Port `stFill`, `stTag`, `stDrop`, `stRepeat`, `stStrip` verbatim, with the prototype's `tag()` as a sheet builder (rotated owned rect + the user's text on it, placed by its rotated edge). `stRepeat` repeats the title: the user's title layer is ONE layer, so the repeats must be placed lines (`runs`) of the same layer (like Stage 1 display text) — never extra text layers. Street's rule 10 applies (S5).

---

### Task 8: The Layout tab — Style picker and suggested face

**Files:** Modify `composables/useLayoutVary.ts`, `components/vue-canvas/compositor/LayoutVaryPanel.vue`, `CompositorModal.vue` (wiring only: pass `brandLogo`, the face action); Test `layout-vary.unit.spec.ts`, a panel spec.

- A segmented **Style** control at the top of the Layout tab: `Swiss · Performance · Editorial · Street` (StudioSegmented). Switching style keeps content and format, rebuilds the library for that style's layouts, and does not apply anything by itself. The style is stored in `sailor_posterState.style` (a stored Frame without it is Swiss). Each apply records the style it used.
- **Suggested face** (Editorial, Street): under the style control, a line `Suggested: <family> — <note>` and a button `Use <family> for “<the title's first 20 characters>”`. Clicking sets the title layer's `fontFamily` (and `fontWeight` to the face's `wt`) as **its own undo step**, loads the font the way the Frame's font picker does (read how the Title face picker loads a Google family), and re-plans. Hidden when the title already uses that family.
- `brandLogo` comes from the project's brand kit through `useBrandLibrary` (read it): `logos.primary` (else legacy `logo`), `logos.onDark`; aspect from the image's natural size (load once, cache).
- Library copy: `Not offered for this Frame: …` as today; a style with no layout for this Frame says `None of the <label> layouts fit this Frame yet.`

- [ ] **Step 1: Failing tests:** switching style changes `library` to that style's layouts only and writes nothing; `posterState.style` round-trips; the suggested-face action is one `recordHistory` and sets family + weight; a missing brand kit gives `content.logo` undefined.
- [ ] **Step 2–4:** FAIL → implement → PASS; typecheck.

---

### Task 9: Browser proof, E2E, docs (controller)

- E2E: pick Performance on the lab Frame with an image and an action line → a tile applies; the action text sits on a button rect (an owned `button-*` layer below it); no text layer box overlaps the image outside a band/card (read layers); Editorial → Use Instrument Serif → the title's family changes, one undo step reverts it; Street on `meta-story` → text inside the band.
- Controller: screenshots of two layouts per style in the browser; STATE.md; dashboard (read fully, replace, never append).

---

## Self-review notes (plan author)

- Spec §7 coverage: rule sets (T1, T4), button/logo/band/card/panel/sticker/tag (T3; card/panel/sticker/tag already exist as rect/circle kinds from Stage 1 — the tag builder lands in T7), suggested faces (T8), the 15 layouts (T5–T7), Vary rewards (T4), extra checks (T3 rule 10, T4 visibility; Street contrast structural — S5), Style choice at the top keeping content and format (T8), logo clear space (T3 rule 9).
- Deferred with rulings: pixel contrast (S5), research ad layouts (S6 → Stage 4).
- Types across tasks: `StyleId`/`StyleSpec` (T1) → `SheetOpts.style` (T1) → `BandEl`/`ButtonEl`/`LogoEl` (T3) → `StyleSpec.check/rank` (T4) → `LayoutDef.style` (T1, used T5–T8) → `LayoutPlanArgs.brandLogo` (T2, wired T8).
