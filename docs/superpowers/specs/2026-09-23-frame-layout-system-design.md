# Frame layout system — design

**Date:** 2026-09-23 · **Status:** approved direction, stage 1 ready to plan
**Replaces the core of:** the Frame Layout tab pattern engine (`frontend/app/lib/frame/patterns/`)
**Visual reference (open in a browser):**
- `assets/2026-09-23-frame-layout-system/layout-sheet.html` — all 42 layouts on one system, four shapes, live checker
- `assets/2026-09-23-frame-layout-system/layout-pane.html` — the Layout pane with Vary, styles, content types, formats, ad layouts

Both are working prototypes: their JavaScript is the model for the toolkit described here (same rules, same numbers).

---

## In plain words

**What is broken.** The Layout tab's layouts look bad. Each of the 27 layouts places things with its own
hand-picked fractions, so small text is a different size in every layout and often unreadable, stacked
titles spread apart because the layout guesses line spacing wrong, photos land on top of titles, the Frame's
grid is ignored, and photos are stretched. There is no shared idea of "a scale", "a grid" or "space that is
already taken", so fixing one layout never fixes the next.

**What changes.** Every layout is rebuilt on one shared toolkit: a type scale with a minimum readable size,
a grid taken from your Frame, real text measurement, one spacing system, and a map of which space is taken.
A single checker tests every layout for collisions, text off the page, text too small, text that should sit
inside a shape but doesn't, and layouts that no longer do what they promise. A **Vary** button walks through
each layout's checked, de-duplicated variations, best first, each step visibly different.

**What falls out of it.** Layouts adapt to any Frame shape (portrait, square, landscape, banner). Photos are
cropped instead of stretched. Layouts may set line spacing and letter spacing (never your font, weight or
colour). Later stages add real ad and social formats, three styles (Performance, Editorial, Street) and the
ad layouts from the research.

**What is risky.** (1) One renderer change: images learn to crop to their box — every existing Frame must
look exactly the same. (2) Layouts start owning the pieces they add (rules, bands, buttons) and removing them
when you switch — the moment you edit one, it becomes yours and is never removed. (3) Vary renders many small
previews; it must stay fast inside the Frame editor.

**Built in five stages, each shippable:**
1. **Foundation** — the toolkit, the checker, the 42 Swiss layouts, Vary in the Layout tab, image cropping,
   layout-owned pieces.
2. **Formats** — real ad and social sizes, platform keep-clear areas, minimum text size by viewing size,
   levels of importance, numbers.
3. **Styles** — Performance, Editorial, Street; buttons, logos, bands, cards, tags; suggested fonts.
4. **Ad content** — reviews, lists, comparisons, stats, and the ad layouts built on them.
5. **Campaigns** — one Frame out to every format at once.

---

## Decisions already made (do not reopen)

| Decision | Source |
|---|---|
| Rebuild the pattern core; keep the plumbing (apply as one undo step, draw order, wired-photo keys, palette roles, face pickers, real-renderer tiles, the Layout tab) | 2026-09-22 |
| Layouts **may set line spacing and letter spacing**. Font, weight and colour stay the user's. | 2026-09-22 |
| **Keep all 27 layouts**, rebuild each; add 8 photo layouts and 7 overlap layouts (42 total) | 2026-09-22 |
| **Every layout places the photo** when the Frame has one | 2026-09-22 |
| Approach: **shared toolkit + every layout rewritten on it + one checker** (not layouts-as-data, not a clean-up pass) | 2026-09-22 |
| The grid comes from the **Frame's own grid** when set | 2026-09-22 |
| Yoga is **not** used by the layout engine (only later, for buttons and arranged info rows) | 2026-09-22 |
| UI copy **quotes the Frame's own text** ("“Ines Vollmer”"), never guessed roles ("the artist", "the dates"); "Default", "image" | 2026-09-23 |
| Layouts **own the pieces they add**; replaced on switch/Vary; editing one makes it yours | 2026-09-23 |
| A style **suggests** faces; applied only when the user accepts. Letter case is spacing-like and the style may set it. | 2026-09-23 |
| Product ads: the image is mostly **full size**; text never sits on a raw photo — only on the page colour (bands, cards, panels, stickers) | 2026-09-23 |
| One **spacing system**; layouts built in **groups** (logo top, message + offer at the foot) | 2026-09-23 |
| Text is **measured with canvas metrics**, never page boxes (a hidden viewer measures zero) | 2026-09-23 |

---

## 1. What stays

Kept as is (all review-hardened):
- `applyToFrame.ts` / `apply.ts` — apply = `recordHistory()` → `commit(layers)` → `writeOrder(order)`, one undo step.
- `order.ts` — draw order through `sailor_stackOrder`; `z` re-sorts only touched layers.
- `connectedSlots` handling for wired photos; `posterLayerViews` treats a wired layer as an image.
- `palette.ts` / `framePalette.ts` — colour roles `ink | accent | field`, opt-in recolour.
- `pairings.ts` and the Layout tab's Title face / Text face pickers.
- `LayoutTile.vue` — tiles are painted by the real renderer (`paintLayerStack`) inside `withWiredContent`.
- `sailor_posterState` remembers seed, choices and the last applied layout outside undo.

Replaced: the 27 files in `patterns/patterns/`, `space.ts`, `hierarchy.ts` (widened), `sheet.ts`, the
"Another" / "More like this" buttons.

## 2. Renderer and data model changes (stage 1)

### 2.1 Images crop instead of stretch
Today `ctx.drawImage(img, -w/2, -h/2, w, h)` stretches the picture to its box, and `apply.ts` writes both
`w` and `h`, so the photo layouts distort photos.

Add to `ImageLayer` and `WiredLayer`:
```ts
crop?: { fit: 'cover'; fx?: number; fy?: number }   // fx/fy = focus 0..1, default 0.5
```
and to `WiredLayer` an optional `h?: number` that is honoured **only when `crop` is present** (without `crop`,
a wired layer's height keeps following its content aspect, exactly as today).
When `crop.fit === 'cover'`, the renderer draws the source rectangle that covers `w×h` at the focus point
(`drawImage(img, sx, sy, sw, sh, -w/2, -h/2, w, h)`). **Absent `crop` ⇒ byte-identical to today.**
Layouts set `crop` whenever they give a photo a box whose aspect differs from the photo's.

### 2.2 Layout-owned pieces
Add to `LayerCommon`:
```ts
owner?: { by: 'layout'; key: string }   // key is stable per piece, e.g. 'rule-2', 'band-foot', 'button'
```
- A layout may **insert** pieces: `rect` (rules, bands, cards, panels, labels), `ellipse` (stickers, dots),
  library shapes (as today), `text` (later stages: button labels, tags), and stand-in images (as today).
- On apply (and every Vary step), layout-owned layers whose key is **not** in the new plan are **removed**;
  layers whose key is in the new plan are **updated in place** (same id), so undo, masks and motion
  references survive.
- **Any user edit to an owned layer clears `owner`** — the layer becomes the user's and is never removed.
  The clearing happens at the local editor's user-edit entry points (`setLocal` and the drag/resize/rotate
  commits), never inside `applyPatternToFrame`.
- Owned pieces are part of the same single undo step as the rest of the apply.

### 2.3 What a layout may set (LayerOp)
Extend `LayerOp` with: `lineHeight`, `letterSpacing` (em), `opacity`, `blend` (all 10 renderer modes, not just
`multiply`), `crop`, `radius` (inserted rects), `fillRole` / `fill` (inserted pieces only: a colour role or a
gradient built from a role, e.g. page colour → transparent for a band), `shadow` (inserted pieces only),
`insert` (`{ kind, key }` for owned pieces), `textTransform` (styles, stage 3).
**Never:** font family, weight, or the colour of the user's own text (recolour stays opt-in, as today).
`apply.ts` clears `lineHeight` / `letterSpacing` / `opacity` / `blend` / `crop` it previously set when the next
layout doesn't set them (same rule as `expressive` today), so switching layouts never leaves residue.

### 2.4 Sizes and positions
Unchanged conventions: `x/y` are the layer centre normalised to frame W/H; sizes are normalised to frame
**width**. The engine gets the frame's aspect from `buildFrameContext` (the on-screen artboard size — only the
aspect matters in stage 1). Stage 2 adds the Frame's real pixel size for viewing-size rules.

## 3. The toolkit (`lib/frame/patterns/kit/`, pure TypeScript, no Vue, no DOM)

Everything a layout needs, so a layout is a short composition, not 50 lines of fractions. Every function is
unit-tested. Numbers below are the prototype's and are the starting defaults.

### 3.1 `sheet.ts` — the grid
- Layouts are written on a **12-column × 16-row design grid**. `X(c)`, `XR(c)`, `SPAN(a,b)` map design
  columns onto the **real** columns; `L(r)` maps design rows proportionally onto the real height.
- Real columns: the Frame's own grid when `sailor_localGrid` is on; otherwise by aspect —
  portrait/square 12, landscape 16, very wide (≤ 1:2.5) 20.
- Margin: the Frame grid's margin, else `min(4%, 6% of height)` of the width. Gutter `1.6 × B`% where
  `B = √(area) / √(portrait area)` (1 on an 895×1280 portrait).
- A **sub-sheet** remaps the 12 design columns onto a subset of real columns (used on wide Frames when the
  photo takes a side, and later for panels).

### 3.2 `type.ts` — scale and spacing
- **Three sizes, nothing between** (per style in stage 3; Swiss values):
  display = fitted to its space · second level `4.4·B`% · information `1.95·B`% of width.
  Information is also the **minimum**: the checker fails any text smaller than it.
- **Spacing belongs to the layout** (Swiss): display line spacing 0.9, letter spacing −0.05 em; second level
  1.04 / −0.02 em; information 1.3 / 0.
- **One spacing system:** `gapBelow(s) = max(0.4·s, 1.1·info)` after a line of size `s` within a group;
  `groupGap = max(1.4·row, 3.4·info)` between groups; `inset = max(margin, 2.4·info)` inside panels and cards.

### 3.3 `metrics.ts` — measurement that matches the renderer
- Width: canvas `measureText` at 100px in the layer's real font stack (`cssFontStack`) and weight (`wght` axis
  if present), **plus `letterSpacing × 100 × (characters − 1)`**, on the case-transformed string.
  Never read page boxes. Never cache a zero. Measurement waits for the layer's fonts (`ensureLayerFonts`).
- Cap height, ascent, descent from `measureText('H')` / font bounding box (existing `capMetrics`).
- **Line breaking is shared with the renderer:** the renderer's word-wrap (`wrappedTextLinesMeta`) is moved
  into a pure, context-injected function that both the renderer and the kit call, so the kit's lines are the
  renderer's lines by construction.
- The renderer draws each line centred in a slot of `fontSize · lineHeight` (`textBaseline = 'middle'`). The
  kit converts design anchors — **cap top of the first line**, **baseline of the last line** — into the
  layer's centre `y` using those metrics. Unit tests pin this against the renderer's own line model.

### 3.4 `place.ts` — building ops
`text(role, {x, w, size, top | base, align, lh, ls, rot})`, `photo({box, crop, over})`,
`rule(...)`, `band(...)`, `circle(...)`, and `photoIn(zone, {side})` — the largest photo of whole columns
that fits a free zone at the photo's real aspect (or a cropped box when the layout wants a fixed shape).
Every element carries: its **role**, the roles it **may overlap** (`over: ['photo']`), whether it may
**bleed** off the page, and (for text in a shape) the shape it must sit **inside**.

### 3.5 `check.ts` — one checker for every layout (pure geometry, no DOM)
Works on the planned ops plus metrics. A plan fails on:
1. **Collision** — two elements' boxes intersect and neither names the other in `over`.
2. **Off the page** — an element leaves the Frame and is not marked `bleed`.
3. **Too small** — any text below the information size.
4. **Not inside its shape** — text marked `inside` a circle/rect whose text box corners leave the shape.
5. **Too close to its panel's edge** — text inside a panel or card closer than 0.9 × margin to its edges.
6. **No room** — a layout reports it could not place a required piece (with a reason, e.g. "the number is
   unreadable on the sticker").
7. **Broken promise** — each layout declares its premise and the checker asserts it: overlap layouts must
   actually overlap; Run-off must actually bleed; Tilt must actually be rotated.
Stage 2 adds keep-clear areas and blank-space limits; stage 3 adds product visibility, logo clear space and
text-over-image contrast.

### 3.6 `vary.ts` — variations that make sense
A layout = **a fixed idea + a few named choices**. Choices are discrete positions, never random ranges:
- **Line breaks** (phrase: one word per line / one line; sentence: balanced 2, 3, 4 lines) — a layout may
  prefer one line first (Run-off).
- **Arrangement** A/B/C — hand-designed per layout (e.g. Run-off: off the right edge / off the left /
  lower baseline). Every layout declares 1–3.
- **Scale** Full / Quieter — refused by layouts whose idea *is* their scale (Run-off, Cross, Wall, Block, Ghost).
- **Accent colour** — Default, or one of the Frame's own text layers (labelled by its text).
- **Image side** — right / left, only when a photo is present and it changes something.

Vary enumerates every combination (typically 10–60), drops checker failures, removes duplicates by geometry
signature, ranks (scale contrast, few distinct left edges, low clutter, the layout's intended version first),
then **orders for diversity** (each next step differs most; weights: line breaks 3, arrangement 3, image side 2,
scale 1.5, colour 1). Deterministic: a variation is an index into that ordered list; the seed is kept for
stand-in content only. Budget: < 100 ms per layout in the editor (prototype: 20–90 ms).

## 4. The 42 Swiss layouts (stage 1)

All 27 existing layouts keep their names and ids and are rewritten on the toolkit; each is described by one
line in the prototype sheet (`layout-sheet.html`). Plus:
- **8 photo layouts:** Plate, Panel, Side split, Cross, Overlap, Stamp, Column, Rising.
- **7 overlap layouts:** Overprint, Date behind (shown only when the Frame has date/number-like text),
  Tight stack, Behind the photo, Collage, Label, Ghost.

Each layout declares: `fits` (word/phrase/sentence), `needs` (image / shape / number-like text),
its arrangements, `keepScale`, its premise, and where the photo goes when there is one.
**On wide Frames** (height < 70% of width) type layouts give the photo the right (or left) side and compose the
type in the remaining columns (sub-sheet); layouts that put the photo inside their own shape (Shape
counter-form, Bleed, Ring) are exempt.
**Photos** are placed by whole columns at their real aspect, or in a fixed box with `crop: cover`.
Full-bleed photos may run under everything; type over a photo only where a layout declares it
(Photo behind, Full bleed, Cross, Overlap, and the overlap family).

Wording rule for every description and choice: quote the Frame's text, never a guessed role.

## 5. The Layout tab (stage 1)

Top to bottom:
1. **Current layout** — name, one-line description (quoting the Frame's text), "3 of 14".
2. **Vary** — one primary button (also the **V** key) plus ‹ › (also ← →). Each step applies to the Frame
   immediately and is one undo step.
3. **Choices** — plain-language pills, shown only when they change something for this layout and content.
4. **Best variations** — a strip of up to 8 thumbnails.
5. **All layouts** — the library, only layouts that fit the content and pass the checker; the rest are named
   with the reason ("Not offered for this shape: …").
6. Existing controls kept below: Title face / Text face / Suggest, palette, shape picker, "Photo moves".

Replaces "Another" and "More like this". Thumbnails are painted lazily (visible ones first) and cached per
(layout, choice set); Vary is computed per layout on demand, not for all 42 at once.

## 6. Stage 2 — Formats and platform rules

- **Format presets** (added to `lib/frame/frameSize.ts`): Meta feed 4:5 1440×1800, 1:1 1200×1200, 9:16
  1440×2560 / 1080×1920, Pinterest 2:3 1000×1500, link 1.91:1 1200×628, video thumbnail 16:9 1280×720,
  display ads 300×250, 160×600, 728×90 (+ 300×600, 320×50, 970×250).
- **Keep-clear areas** (text and logos only; images and bands may run under): Meta 9:16 top 14%, bottom 35%,
  sides 6% · Pinterest 9:16 top 270, bottom 440, left 65, right 195 px of 1080×1920 (asymmetric) ·
  Google Performance Max: key content in the centre 80%. Layouts compose inside the free area; full-bleed
  images, panels and bands extend to the real edges.
- **Minimum text by viewing size:** at least 9px at the width people actually see the format
  (feed ≈ 390px, video thumbnail ≈ 170px, 300×250 = 300px).
- **Levels of importance** replace the four guessed roles: headline → second line → supporting line → fine
  print (a style may reorder: Performance puts the number second). A format **carries** N levels (video
  thumbnail 2, tall/wide display ads 3); the least important text is dropped from that format.
- **Number-like text** (price, discount, date, time) is recognised; layouts built on a number only appear
  when there is one. "Date behind" becomes "Number behind".
- **Platform buttons:** formats where the platform adds its own button (Meta, LinkedIn, TikTok, Snapchat,
  Google) offer the choice "Button: In the image / Platform's own"; display banners always draw one.
- **Google responsive display:** export mode with a clean image (no text or logo on it) plus separate text
  fields; blank space ≤ 80%.
- Checker additions: text under keep-clear areas; blank space; soft penalty (Vary rank, not rejection) for
  text covering > 20% of the image.

## 7. Stage 3 — Styles

A style is a **rule set on the same toolkit**: type spacing and case, button shape, its own order of
importance, its own layouts, its own Vary ranking, its own checks.

| | Performance | Editorial | Street |
|---|---|---|---|
| Type | heavy, tight, one-line headline first | light, centred, small title (≤ 2.5 × second level), tracked capitals for small text | heavy capitals, lines fitted to full width, negative line spacing |
| Button | pill, drawn or platform's own | underlined text link | hard-edged box, capitals |
| Suggested face | (your font) | Instrument Serif | Anton |
| Layouts | Offer, Sticker, Price tag, Card, Centred, Strip | Cover, Framed, Quiet, Diptych | Fill, Tag, Drop, Repeat, Strip |
| Vary rewards | a big number, a visible button | empty space, ≤ 3 text sizes | display scale, overlaps |
| Extra checks | **product stays visible**: solid page colour covers ≤ 55% of the visible image (fades count 0.35) | — | text over a photo only after a **contrast** check |

New owned pieces: **button** (padded shape that grows with its text), **logo** (from the brand kit's logos —
`BrandKit.logos.primary|mark|wordmark|onDark`; clear space ≥ 0.35 × logo height, checked), **band** (page
colour → transparent gradient), **card**, **panel**, **sticker**, **tag** (rotated, placed by its rotated edge).
Text never sits on a raw photo in Performance: bands, cards, panels or stickers only.
The Style choice sits at the top of the Layout tab; switching keeps content and format.

## 8. Stage 4 — Ad content and research layouts

New content kinds, recognised from the Frame's text layers where unambiguous (stars/“quote” for a review,
bullet or numbered lines for a list, a stat like "198 g"), otherwise tagged by the user in the Layout tab:
`review {stars, quote, by}`, `list [..]`, `compare {them, rows[[label, us, them]]}`, `stat {value, line}`.
Layouts (Performance), each offered only when its content exists: Offer first, Stat, Review, Us vs them,
Before / after (two images; Meta limits it for health products), Feature callouts (leader lines), Reasons
why, Notes app (its own paper/amber by design), Post-it. Not planned until their inputs exist: Bundle
(several product images), Face + gaze (face detection).
Vary rank additions from the research: penalise clutter (many small competing elements — strong evidence),
reward a single dominant element and offer/button contrast; content hints: % discount under ~$100, amount
above; stars 4.0–4.8 read more credible than 5.0.

## 9. Stage 5 — Campaigns

One Frame → every chosen format in one go: the same layout idea recomposed per format, each checked; the
user reviews a contact sheet and exports the set. This is Responsive Frames slice 5 ("Adapt"); the arranged
info row / button is where Yoga enters.

## 10. Testing

- **Unit, per kit module:** grid mapping, scale/spacing, measurement (letter spacing counted; zero never
  cached), anchor conversion vs the renderer's line model, `photoIn`, each checker rule.
- **Negative control for every checker rule** — a deliberately broken plan must fail with the named reason
  (a checker that always passes proves nothing; that is how two layouts once passed while not doing their job).
- **The matrix:** 42 layouts × {word, phrase, sentence} × {photo, no photo} × {portrait, square, landscape,
  banner} × 3 seeds × every Vary choice → zero checker failures and every premise holds. Runs in node with a
  deterministic measure stub plus a real-font run in the browser E2E.
- **Renderer:** image `crop` absent ⇒ pixel-identical to today (existing painter specs); `crop: cover` crops
  at the focus point; wired `h` ignored without `crop`.
- **Owned pieces:** switching layout removes the old layout's pieces; Vary updates them in place (same ids);
  a user-edited piece survives a switch; everything is one undo step.
- **E2E (`/dev/frame-lab`):** apply → one undo step; Vary steps apply and undo; the library hides layouts
  that fail; thumbnails paint with wired photos present (count pixels that differ from the background —
  a pixel test that passes on the background alone is vacuous).

## 11. Risks and how they are held

| Risk | Hold |
|---|---|
| Image crop changes existing Frames | `crop` absent ⇒ unchanged code path; painter specs pinned |
| Kit geometry drifts from the renderer | shared line-wrap function; anchor-conversion tests against the renderer's model |
| Vary is slow in the editor | per-layout on demand, lazy thumbnails, cached per choice set, budget test |
| Owned pieces delete user work | owner cleared on any user edit; removal only of layers still owned; one undo step |
| Fonts not loaded when measuring | measure after `ensureLayerFonts`; canvas metrics only |
| Parallel sessions in the checkout | private git index per commit + shared-index resync; subagents never run the dev server |

## 12. Research sources (stages 2–4)

Platform (official unless noted): Meta Ads Guide image specs incl. 9:16 safe zone
(facebook.com/business/ads-guide/update/image, …/instagram-story, …/instagram-reels); Google Ads responsive
display & Performance Max image guidance (support.google.com/google-ads/answer/7005917, 9823397, 14530211;
adspolicy 10347108); YouTube thumbnails (support.google.com/youtube/answer/72431); TikTok creative best
practices (ads.tiktok.com/help/article/creative-best-practices); Pinterest product specs & creative best
practices (help.pinterest.com, business.pinterest.com/creative-best-practices); LinkedIn single-image ads
guide. Evidence: Pieters & Wedel 2004 (J. Marketing) — image captures attention, text size adds; Pieters,
Wedel & Batra 2010 — feature clutter hurts, designed complexity helps; Sajjacholapunt & Ball 2014 — gaze
toward product; EyeSee — product visible in thumbnail; Spiegel Research Center 2017 — reviews, 4.0–4.7 stars;
Chen, Monroe & Lou 1998 — % vs $ discounts; Grewal et al. 1997 — comparative ads; Motion 2026 creative
benchmarks (vendor, mixed static/video) — offer-first banners lead spend; Olsen, Pracejus & O'Guinn 2012 —
white space and prestige.
