# Typographic posters on the Frame — design

**Date:** 2026-09-08
**Status:** Design, approved in brainstorm 2026-09-08. A programme; sub-project 1 specced here, the rest sketched.
**Area:** `frontend/` — the Frame (Compositor), Vector Type, the shape library, the expressive text-layout engine.
**Reference:** typographicposters.com (64 posters studied 2026-09-08). Prototype: `.superpowers/brainstorm/10877-1788849223/content/layout-options-v7.html` — the reference implementation of the moves library and every decision below.

---

## Plain-language summary

We want to make the kind of typographic posters found on typographicposters.com: type as the image, extreme scale contrast, strict grids with type cropped by the edge, shapes and photos overlapping the letters, two or three inks, often a seeded series of one idea.

Smart Layout was our attempt and it feels wrong. Studying its output against real posters, three reasons stand out, and the user named a fourth that sits under all of them:

1. **It owns the content.** Smart Layout makes you rank content into importance tiers and fill named slots (title, date, venue). That is a flyer brief, and it means its "options" are never *your* composition — the tool arranged its boxes, not your type.
2. **The type is web text, not typography.** Everything is a fitted text box in a grid cell. No cropping, no overlap, no expressive placement, none of the type craft that lives in Vector Type and the Frame.
3. **Shuffle rearranges, it doesn't have ideas.** N stagings × a seed is the same poster moved around, not a different idea each time.
4. **We never built typography.** Font knowledge, setting craft (leading, tracking, optical size), hierarchy/scale, and paragraph typography are all absent. Without that layer a generator has nothing to reason with and a hand tool has nothing to guide you — so both land in the safe middle.

The fix is a different model, built on the Frame, not on Smart Layout's template-grid/Satori pipeline:

> **You put your elements on a Frame — your word, your details, your face, your colours, your photo, your shape — and ask Sailor for layout options. It shows a sheet of compositions that arrange *those same elements*. Pick one and it moves and re-sets what you made. Nothing is created, nothing is replaced, undo puts it back.**

The elements are yours; the arrangement is a suggestion. That single rule is what Smart Layout could not honour, because it owned the elements.

---

## The contract (the load-bearing decision)

Every layout option arranges **the same elements** you placed. An option may touch:

- **Position** — always.
- **Scale** — type and shapes and images grow or shrink, so hierarchy can shift between options.
- **Composition moves** — line breaks, vertical/rotated text, running off the edge, cropping an image or shape to a region, which letters take an accent face, which word takes the accent colour.

An option may **never** touch: the **face**, the **weight**, the **colour palette**, or the **content**. Those are yours. (The one deliberate exception, letter swaps, still uses a face *you* chose — see Faces below.)

Because every option re-sets the same layers, applying one is non-destructive by construction: there is nothing to create or replace, and it is one undo. This dissolves the "what happens when I apply an idea over my hand edits" problem that a generate-fresh model would have.

**Inferred hierarchy, no tiers.** The engine reads hierarchy from what you made: the largest text is the title, the smallest is the caption/meta, the "date-shaped" detail line is the date, images are images. Option labels name what they inferred ("title", "details", "date", "photo") so it is visible and correctable — you change hierarchy by resizing, which you would do anyway. No tier UI, no slots. (A per-layer role *override* tag is a cheap later addition if inference misreads real posters; not in slice 1.)

---

## The programme (decomposition)

This is too big for one spec. Six sub-projects, each its own spec/plan/build. Order matters: everything after (1) consumes it.

1. **The moves library + the layout sheet** (this spec, sub-project 1). The pattern library that arranges your elements, the sheet UI in the Frame, inferred hierarchy, the grid seam, the expressive-engine reuse. Ships the "put elements down, ask for options" loop.
2. **Typography — font shelf + setting craft.** A curated poster-grade font manifest with voice/axes/optical-size/pairings; opinionated leading/tracking/optical-size rules; OpenType features. The Frame text layer reads it; the inspector shows suggestions as faint reference marks you accept or override. *This is the layer whose absence is the root cause; sub-project 1 is deliberately shippable without it (it uses plain fitting), but the posters only stop looking generic once this lands.*
3. **Paragraph typography + baseline grid.** Real line-breaking, hyphenation, rag control, columns, widows, a baseline grid the text snaps to. Makes the small text credible.
4. **The poster generator.** Brief-free: it reads the frame and proposes; optionally a one-call model "tilt" that weights the deal by what the word means (spike-tested first, see Open questions). Retires Smart Layout's generation.
5. **Reflow / multi-format.** Placement *intent* per layer; a format switch re-resolves boxes and re-sets type. Retires Smart Layout's reflow. Format-aware from day one in the data model (below), built out here.
6. **Ink model, then motion.** Multiply/overprint/misregistration/riso grain; then animated posters on the timeline.

**Smart Layout's fate:** its generation (4) and reflow (5) move to the Frame. Its brand kit and campaign-matrix concepts return as inputs to (4)/(5). The template-grid/Satori pipeline is not extended.

### Profiles — the graphic kind, not the format

The engine is not poster-specific; only its *content* is. A **profile** is the seam that lets the same machine make a different kind of graphic. Poster is the only profile built in slice 1, but the seam is designed now so a second one slots in without a rewrite.

A profile carries four things, and nothing else:

- **Its moves** — which patterns exist and their weights. This is most of a profile; the moves barely overlap between kinds (see the deck case).
- **What the Read voice checks** — the taste rubric for that kind. A poster is judged on drama and scale contrast; a slide on legibility and one-idea-per-slide.
- **Its shelf defaults** — the face filter, and whether the brand kit locks the face and colours.
- **Its suggested formats** — a *convenience list only*, never a constraint (below).

**The profile is not the format. They are independent axes.** The graphic *kind* (poster, slide, ad, editorial page) is a separate choice from the *canvas dimensions* (A2 portrait, 16:9, 1:1, 1200×628). Any profile works at any format: a poster can be square, a slide can be portrait (phone-first, story-format decks are common), a social tile can be pure poster idiom. **Choosing a format never sets the profile, and choosing a profile never forces a format** — a profile may *offer* its common formats as a starting convenience, but the user can pick any format and the profile stays put. Coupling the two would be too restrictive: it would deny the poster-in-a-square and the portrait-slide that people actually want.

**How the system knows the profile:** the user sets it, explicitly, as its own control on the Frame (default: poster). It is not inferred from format, content, or anything else — inference here is exactly the kind of cleverness that would take control away (cf. the "frame is the brief" decision). One low-friction control, changeable at any time; switching it re-fits the sheet to that profile's moves and re-points the Read voice.

**Why a second profile is real work, not a toggle — the deck case.** A slide deck is the ideal second profile precisely because it stresses the abstraction in three ways, and if the seam survives it, the seam is real:

1. **The moves barely overlap.** The overlap, edge-cropping, and off-edge drama that make a poster sing are wrong for a slide, which wants clear hierarchy, safe margins, and alignment. That is a mostly-new moves library, not a re-weighting of the poster one — which is the point: a profile owns its moves.
2. **The Read checks invert.** "Is this dramatic enough" becomes "is this legible from the back of the room, and is there one idea here." The rubric is per-profile, not global.
3. **A deck adds a dimension a poster lacks: consistency across many artifacts.** Twelve slides must feel like one set. That cross-artifact consistency layer is closer to Templates (sub-project 1's Template cousin) and reflow (sub-project 5) than to the moves library, and it is the part the poster profile never exercises. A profile therefore may declare a **set relationship** (this artifact is one of a consistent series) that the poster profile leaves null.

So profiles stay deferred, but the moves registry, the Read rubric, and the shelf filter must all be **keyed by profile from the start** (poster being the only key today), and the format control must be **fully independent of the profile control**. Those two constraints are what keep a deck (or an ad, or an editorial page) from being a retrofit.

### Typography's UX model — defaults over controls (sub-project 2 principle)

Typography features are necessary for quality but ruinous as an interface: tracking, optical size, `ss01`, `smcp`, `onum`/`tnum` require inside-baseball knowledge most users don't have, and a wall of sliders overwhelms them. The resolution is that **most typography quality is defaults, not controls** — if the shelf carries the knowledge, the user needs none of it. Three tiers of who-decides, plus a teaching voice:

- **Tier 1 — automatic and invisible. No UI.** The face's own knowledge, spent for the user: optical size driven by the size (the single biggest "looks set" lever, zero dial), kerning on, standard ligatures on, **figure style following the role** (tabular on dates/ruled lists, oldstyle in running text — decided by what the layer *is*), tracking that tightens with size on a per-face curve. **Build this first** — it needs no controls at all.
  - **Validated 2026-09-08** (Tier-1 spike, `.superpowers/brainstorm/.../typography-tier1.html`): with the same font/size/text and *zero controls touched*, the Tier-1-on column clearly beat the Tier-1-off column. So the defaults do lift quality invisibly — the bet holds. But the spike also **corrected the "≈90% of the craft" claim**: Tier-1 is a **floor-raiser, not a ceiling-raiser.** It removes the tells that read as amateur (spindly display cuts from an unmanaged `opsz`, un-kerned gaps, loose display tracking, jittery number columns), and its value **scales with how bad the input would otherwise be** (biggest on variable/feature-rich faces and extreme sizes; quiet on a face whose defaults are already good). What makes type *striking* is not the invisible defaults — it is **font choice** (the shelf's curation), weight, and the moves. So re-weight this sub-project: **the curated shelf is the high-leverage ceiling-raiser and leads; the invisible Tier-1 defaults are the cheap floor underneath it.** Both ship, shelf-first in value.
  - **Register spike (same day, `typography-tier1-registers.html`):** ran Tier-1 across four registers — microtext, condensed, all-caps, ultra-condensed. Confirmed "value scales with the extreme": the off→on gap is largest at **ultra-condensed** and **microtext**, then **caps**, then **condensed**, all bigger than the comfortable display middle. Two concrete outcomes for the build: (1) **the tracking curve is per-face AND per-register, never one global number** — display-normal wants negative, condensed gentler, ultra-condensed near-zero (a normal curve collides the glyphs), microtext positive (opens), caps +air; the shelf must carry a curve per face, keyed by size and by case/width. (2) **The highest-value invisible defaults act on the text the user isn't looking at** — the small print, the caps, the numbers, and the compressed stack — which is exactly where unmanaged type screams "template" and where the user is least equipped to fix it by hand. The headline (which the user obsesses over and picks the font for) benefits least from defaults, consistent with font-choice being the ceiling.
- **Tier 2 — plain-language and visual choices. No jargon.** Never "tracking −0.03em" → **Tighter / Looser**. Never "ss01/salt" → **pick a letterform by eye** from 2–3 specimens, like picking a layout tile. Never "smcp" → a **Small caps** look shown as a preview toggle. Every choice named by outcome or shown as a picture. Same contract as the poster sheet: you choose by looking, the machine owns the vocabulary. Add these one at a time, only where a real choice exists.
- **Tier 3 — the exact dials, folded away.** Raw tracking numbers, specific feature tags, under an Advanced fold. Control preserved for experts, hidden from everyone else. Nobody blocked, nobody overwhelmed.
- **The teaching layer — the Read voice** (from sub-project 4's critique): brings Tier-3 knowledge down to Tier-2 language, in context, one click ("the date would read cleaner with aligned figures — apply?"). The user learns the inside-baseball only when relevant, phrased plainly.

Through-line: **the user makes plain or visual choices; the machine handles the vocabulary.** You never need the word *kerning* to get kerned type — the elements-are-yours contract applied to setting. OpenType features that are per-glyph (a stylistic alternate on one title letter) enter as *composition moves* the same way letter swaps do (§Faces): you pick the feature, the seed picks the letter. **Render constraint:** any feature must survive preview + PNG bake + video + SVG export (the baseline-rise lesson); canvas does `fontFeatureSettings`, but the headless bake and any Satori path need checking — a sub-project-2 gate.

### Optical placement & leading — measured from the ink, not the font box

Validated in the optical-alignment spike (2026-09-08, `optical-alignment.html`). The unifying rule: **the box the layout positions is not the box the eye reads.** A font's line box carries uneven empty space (more below the baseline than above the cap, a built-in line gap that varies per face), so aligning, centering, and leading by that box looks mechanical. Doing them by the **ink** (measured cap-height, ascent, descent) looks set. This splits across two owners:

**Owned by the moves engine (placement) — new, and cheap:**
- **Optical vertical centering.** Centring a text op in a region by the font's line box leaves caps floating high. Centre by measured cap-height instead. This is the highest-value optical rule — it makes every centred lockup (badge, stamp, centred title) look placed rather than slightly off, and it is high-frequency.
- **Cap-height / first-baseline alignment.** Two text ops meant to share a top do not, when aligned by box-top, because each face hides a different gap above its caps. Align by measured cap-top (or a shared baseline) so the row reads as top-aligned. Fires whenever a pattern sets a headline with a kicker, or side-by-side blocks.
- **Optical leading between display lines.** For a multi-line title, measure line spacing from the ink (baseline-to-baseline sized against cap-height + descender), not the font's default line box, so tight display stacks nest without colliding.
- **Engine implication for plan 1a:** the injected `Measure` oracle is currently width-only; it must also return **vertical ink metrics** (cap-height, ascent, descent per face+size) so the apply/placement code can centre and lead optically. Cheap (canvas `TextMetrics.actualBoundingBoxAscent/…`, measured once per op), but it extends the `Measure` type — fold into 1a's placement work, and note it connects to the known local-layer-box gotcha (local frame vs baked image space).

**Owned by the shelf (setting):**
- **Hanging punctuation & edge overshoot.** Quotes, dashes, and the round side of O/C hang past a flush edge so the ink edge reads straight. The real connoisseur's tell, but subtle at moderate sizes; its value climbs with big flush display and justified blocks.

### Line-height best practices (the leading curve — Tier-1, per-face)

Leading is **not a fixed multiplier**; it is a function the shelf computes, and getting it wrong is a loud amateur tell. Reason in ratios, store absolute values. The curve, all invisible defaults:

- **Leading tightens as size grows.** Body ~1.4–1.5; subheads ~1.2–1.3; display ~1.0–1.1; large display often **< 1.0** (0.85–0.95); a tight compressed stack tighter still (~0.8, seen in the ultra-condensed spike). Big type needs less relative leading — the word shapes already dominate and the eye tracks less vertical distance.
- **Leading opens as the measure lengthens.** Long lines need more leading so the eye finds the next line's start; a narrow column can be tighter. So the *same size* wants different leading at different line lengths.
- **Leading opens for large-x-height faces.** Big-x-height grotesques (Inter, most sans) read tighter and want a touch more; small-x-height faces want less. A per-face factor.
- **All-caps and no-descender lines tighten.** The visual band is just cap-height, so lines nest closer (again the ultra-condensed stack).
- **Measure it optically, not from the em box** (see above) — the CSS/font default line box embeds a per-face line gap that makes "the same" line-height inconsistent across faces.

So the leading default is `ratio = f(sizePx, measure, faceXHeight, isCaps)`, computed by the shelf, exposed to the user only as Tier-2 "Tighter / Looser" if they want to override — never as a raw number up front. It pairs with the per-face, per-register **tracking** curve the register spike established: horizontal and vertical spacing are both per-face curves the shelf owns, not global constants.

---

## Sub-project 1 — the moves library and the sheet

### The model in one paragraph

A Frame gains a **layout sheet**: with nothing selected, a frame-panel action **Options** renders a contact sheet of tiles, each one **pattern** arranging the frame's current elements, varied by a **seed**. Hovering a tile previews it on the frame (reusing the card hover-to-play gate); clicking **applies** it — the pattern's computed boxes are written onto the existing layers. **Another** re-rolls the seed; **More like this** fills the sheet with variants of one pattern. Patterns are pure functions; the sheet is the only new UI.

### `PatternFn` — the pluggable unit

New module `app/lib/frame/patterns/` (one file per family + an index), pure and unit-tested. The shape follows `ShowcaseLayout` and the shape-library's "manifest + one module" precedent.

```ts
export interface PatternContext {
  frame: { w: number; h: number }
  grid: ResolvedGrid | null        // from resolveGrid(readGrid(props), w, h); null when grid mode is 'off'
  margin: number                    // the frame's margin (unified with the grid's — see Grid seam)
  elements: FrameElements           // the user's layers, read + hierarchy-inferred
  seed: number
}
export interface FrameElements {
  title?: TextEl; details?: TextEl; caption?: TextEl; date?: TextEl
  images: ImageEl[]; shapes: ShapeEl[]
  face: Face; textFace: Face; accentFace: Face | null; palette: Palette
  swap: { face: Face; count: number | 'word' } | null
}
export interface PatternPlacement {
  ops: LayerOp[]      // per-layer: box (x,y,w,h), scale, rotation, lineBreaks, crop, colour-role, blend, faceSwap set
  did: string         // human label: "title at 190% of the width, cropped by the left edge"
}
export interface Pattern {
  id: string
  name: string
  fits: ('word' | 'phrase' | 'sentence')[]
  needs?: { shape?: boolean; image?: boolean }
  place(ctx: PatternContext): PatternPlacement
}
export const PATTERNS: Pattern[]
export function fittingPatterns(ctx): Pattern[]   // filters by input kind + needs
```

A `PatternPlacement` is **a list of layer operations**, not pixels drawn — the Frame's existing layer editor consumes it, so hand-editing afterward is native and nothing about rendering changes. `did` drives the label; `fits`/`needs` drive the filter.

The prototype's ~66 patterns are the seed catalogue (see below). Adding a move = one entry, ~15–40 lines. The factory thesis, applied to composition.

### Inputs and the fit filter

Input kind is inferred from the title text: **word** (1), **phrase** (2–4), **sentence** (5+). Each pattern declares `fits`; the sheet shows only patterns that fit what you brought, and the count is surfaced ("47 of 66 patterns fit a word"). This is a real decision validated in the prototype: a sheet of moves that make sense beats every move attempting the input and half failing. Exploded-letter moves are **word-only** (they read weak on sentences — user call). Shape/image moves declare `needs` and appear only when a shape/image is present.

### The moves library — families

From the prototype, grounded in the 64-poster study. Names are the vocabulary the agent and the labels use.

- **Type, free placement:** Run-off, Statement, Stack, Bottom-heavy, Corner crop, Tilt, Echo, Wall, Four corners.
- **Type, structured:** Index, Spaced lines, Interleave, Perimeter, Drawn grid, Diagonal, Columns.
- **Phrase:** Edges, Ragged, Two scales, Words in cells.
- **Sentence:** Block, Inline, Highlight (+ Spaced lines, Interleave, Columns).
- **Exploded letters (word only):** Scatter, Burst, Fall, Ring, Rhythm, Letters in cells, Letter column, Spread.
- **Shape + type:** Counter-form, Knockout, Bar, Bleed, Badge, Outline, Wall, Column, Scatter, "shape for a letter", "photo in a shape".
- **Image, built on overlap:** Slices, Behind, Bands, Ring outline, Photo cells, Circle photo, Badge, Perimeter photo, Photo-as-field, Photo-as-block, Split.

**Variation, not just rearrangement.** Each pattern rolls **continuous dials** (scale, crop, position) rather than picking from 2–3 values, and a small set of **twists** (title/details in accent, caption up the edge, date pulled out large, a hairline rule) can land on any tile with a labelled, low probability. "More like this" shows 8 variants of one pattern so reroll depth is directly judgeable.

### The expressive engine is the placement primitive

`shared/text-layout/expressive.ts` (`layoutExpressive`) already emits per-word geometry from `{ text, boxWidth, lineHeight, measure, params, justifyX/Y }`, deterministic on a seed, pure, taking a `measure` callback (so it is face-agnostic). **Several patterns are this engine with fixed params:** Ragged = `placement:'random'`, Edges = `'edges'`, Staircase = `'staircase'`, Spaced lines = a justified variant, and the per-line word grouping is `wordsPerLine`. **We do not reinvent word placement — patterns call `layoutExpressive`.** Two consequences:

- The Smart Layout **per-word/character placement sliders** the user built (`wordsPerLine`, `placement`, `jitterX`, `jitterY`, seed, justify) become **live controls on a placed title layer** in the Frame inspector, not Smart-Layout-only knobs. Pick a pattern that placed the title expressively, then tune its jitter and reroll by hand. The engine is shared, so editor and any export agree by construction (its original design guarantee).
- New expressive placement rules added to the engine (e.g. an arc rule) light up everywhere the engine is used at once.

Boxes/word-measurement helpers in `shared/text-layout/boxes.ts` are reused for the fit maths; the prototype's ad-hoc `measureText`/`fitW` are replaced by these.

### The grid seam — this reads the Frame's grid, it does not add one

The Frame already has `resolveGrid(grid, w, h) → { xs, ys, regions }` ([grid.ts](../../../frontend/app/lib/frame/grid.ts)), stored at `sailor_localGrid`, read via `readGrid`. Modes: `off`, `explicit` (even N×M), `generated` (seeded irregular deal with regularity dial + cell merge). The prototype fakes its own 12-column grid; the real system consumes `resolveGrid`. **The poster sheet introduces no grid of its own.**

The split (design decision, validated against the 64 posters — most are free placement, not region-fill):

- **Free patterns** (Run-off, Statement, Stack, Tilt, letter & shape moves): the grid is **snap lines only**. They align edges to the nearest `xs`/`ys` when a grid is on, and fall back to the margin box when it is `off`. They ignore `regions`.
- **Structured patterns** (Index, Drawn grid, Words in cells, Bands, Photo cells): the grid is **regions to fill**. When the frame carries a `generated` grid, these consume its `regions` directly — **the grid deal and the layout deal then share one seed, and the poster is literally the grid filled.** When the grid is `off`, they synthesise a light internal grid so they still work.

`PatternContext.grid` is `null` when mode is `off`; each pattern decides free-vs-region from that. **Margin unification:** `resolveGrid` derives edges from the grid's own `margin`; `PatternContext.margin` is that value (or a default when off), so snapped type and the grid overlay line up. The prototype's 3.5% is replaced by the frame's margin.

### Faces — three faces, all yours

The contract says the sheet never chooses a face. It gives you three pickers, and only chooses *how* they are used:

- **Title face** — the headline.
- **Text face** — details/caption. Defaults to the title face. A **Suggest** action fills it from a **pairing table** and states the reason ("Anton has one weight and no text cut; it needs a real text face beside it"). Pairing knowledge is a `pairings` field on each family in the sub-project-2 shelf; here it is a small standalone table. The sheet never rolls a face or a pairing.
- **Accent face** — a striking display face on **one/two/three letters or a word** of the title (a real move on the site — Solothurner, Z33). The face is yours; **the seed decides which letters**, and the label names them. This is the one place a face lands inside the title, and it stays inside the contract because you chose the face; only the letter selection is the seed's — a composition decision, like which word takes the accent colour.

*(Measurement caveat carried to sub-project 2: fitting currently measures with the title face, so a swapped script glyph can run slightly wide; the real engine measures per glyph.)*

### Shapes — the library, with a family mode

Shapes are already Frame layers, so a placed shape is an ordinary element the sheet arranges. Shapes enter through the real manifest (`app/data/shape-library.manifest.json`, 100 shapes, 6 families via `familyOf`). Two selection modes, mirroring the faces:

- **A specific shape** — every tile uses it.
- **A family** — the seed picks a shape within it per tile, the label naming which.

The family mode is the one new persistent idea: a shape layer whose identity is "one of {family}", rerolled by the seed until pinned. Cheap to represent (`shapeMode: {id} | {family}`), worth keeping. Shape moves render via the manifest `d`/`box`/`fillRule` (SVG path), support fill / accent / **stroke-only outline** / **photo-filled** (SVG pattern), matching the prototype.

### Images — stand-in first, overlap is the point

An image the user drops in is used directly. When a move wants an image the user has not supplied, the tile shows a **stand-in** (a seeded grayscale placeholder), so image moves still appear and the idea is visible; the real image or a generation happens **once**, on the poster you pick (never per-tile — keeps the sheet instant and free). The image family is built around **overlap** (the user's explicit ask): photo behind the type, photo bands between type bands, photo sliced with type across the cuts, photo in a shape, photo through the letters, photo cropped to a cell the type overhangs. Existing Compositor smart-select/masks apply unchanged once a real image is in.

### What sub-project 1 does *not* do (deferred)

- No typography engine (leading/tracking/optical-size intelligence, OpenType) — plain fitting for now (sub-project 2).
- No paragraph engine / baseline grid (sub-project 3).
- No model tilt / brief object / generator (sub-project 4).
- No reflow execution — but the placement data model is format-aware from day one (below), so (5) is not a retrofit.
- No ink model / motion (sub-project 6).
- No "serif dates" auto-move (would need the sheet to assign a face to a layer — crosses the contract; a user-set Date-face picker could add it later).

### Format-aware from day one (cheap now, enables reflow later)

Placement `ops` are stored resolved (pixel boxes on the layers, as today) **and** the pattern + seed + the element roles are recorded on the frame (`sailor_posterState: { patternId, seed, shapeMode, faces, swap }`). That record is what a future format switch re-runs to re-resolve boxes at a new size — reflow (5) becomes "re-run the pattern for the new `frame.w/h`", not a new engine. Recording it now is near-free and avoids a retrofit. Slice 1 only writes it; it does not react to format changes.

## Components and files (slice 1)

- **`app/lib/frame/patterns/`** (new) — `index.ts` (registry, `fittingPatterns`), one module per family, `context.ts` (`FrameElements` inference + hierarchy). Pure, unit-tested. Consumes `resolveGrid`, `layoutExpressive`, `boxes.ts`, the shape manifest, the pairing table.
- **`app/lib/frame/pairings.ts`** (new) — the standalone face-pairing table + reason strings (folds into the sub-project-2 shelf later).
- **`shared/text-layout/expressive.ts`** (reuse; extend only if a pattern needs a new `PlacementRule`).
- **`app/composables/useCompositorLayers.ts`** (modify) — apply a `PatternPlacement`'s `ops` to the current layers as one undo step; write `sailor_posterState`.
- **`CompositorModal.vue` / frame panel** (modify) — the Options sheet (contact sheet, hover-preview via the existing loop gate, Apply, Another, More-like-this), the three face pickers + Suggest, the Shape picker (specific/family), the placement sliders on a selected expressively-placed title.
- **`ArtifactFrameNode.vue`** (modify) — nothing structural; sections are ordinary layers, grid overlay already exists.
- **`app/lib/agent/…`** (modify) — expose "give me options" (list `fittingPatterns`, apply one by id+seed) and the pickers to the agent; applying is placing layers, which the agent already does.

## Testing

- Pure pattern tests: for a fixed `PatternContext` + seed, `place()` returns stable `ops`; every op's box is finite and inside sane bounds; `fits`/`needs` honoured. (The prototype's live NaN-sweep is the model.)
- Grid seam: free patterns snap to `xs`/`ys` within tolerance when a grid is on and fall back to the margin box when off; structured patterns consume `regions` when a `generated` grid is present.
- Expressive reuse: a pattern using `layoutExpressive` produces the same `PlacedWord` geometry the inspector sliders would, proving one engine drives both.
- Apply is one undo; re-applying the same pattern+seed is idempotent; `sailor_posterState` round-trips.

## Open questions (decided / to spike)

- **Model tilt (sub-project 4), spike first.** Before building it, a throwaway script sends ~20 briefs to a cheap model for weighted hints over qualities (weight/air/distortion/…) and checks: different words → different hints; same word → stable hints across runs; the hints agree with human judgement. If they collapse or flip, ship the pure engine and drop the tilt. *Decided: engine-first regardless; tilt is an experiment gated on this spike.*
- **Profiles.** Generalising beyond posters is a first-class architecture concern with its own section below (*Profiles — the graphic kind, not the format*). Deferred to build; poster is the only profile in slice 1, but the seam is designed now so a second profile is not a retrofit.
- **Grid margin default when `off`.** Slice 1 uses a fixed default (~3.5%) when no grid; revisit if it disagrees with the overlay once a grid is turned on mid-edit.

---

## Provenance

The whole moves library, the contract, the input filter, the three-face model, the letter swaps, the shape family mode, and the grid free-vs-region split were gamed out live in the v1→v7 prototype against 64 posters pulled from typographicposters.com. That prototype is the reference for behaviour; this doc is the plan.

---

## Appendix — Profiles roadmap

The engine is a mechanism: elements you place → moves that arrange them → a Read that checks them → a seed that re-rolls. A **profile** binds that mechanism to one *kind* of graphic (see *Profiles — the graphic kind, not the format*). Once the mechanism exists, a profile is cheap — a moves list, a Read rubric, a shelf filter, and format defaults — so profiles are how Sailor widens surface area without new machinery (the technology-factory thesis). This appendix maps the whole space so the seam is designed against it, not just against posters. It is a roadmap, not a commitment; poster is the only profile in sub-project 1.

### Three axes that separate profiles

- **Register:** expressive (drama, type-as-image) → editorial (hierarchy, readable) → functional (clarity, brand-locked).
- **Cardinality:** a single artifact, or a **set** that must stay consistent across many artifacts.
- **Content load:** one idea (word/phrase) → structured (a list where size = importance) → body (paragraphs).

### The five clusters

**Cluster A — Expressive single.** The poster's own family: ~80% shared moves, cheapest to add, strongest re-roll payoff. No new capability needed.
- Poster (built), album/playlist cover, book/magazine cover, film/gig poster, zine page, **video hook graphic** (see below), quote/testimonial card, merch/apparel graphic, sticker/emblem.

**Cluster B — Editorial.** Hierarchy + readability, image as a block, moderate content; ~50% move overlap with poster (less edge-crop drama, more grid discipline).
- Magazine spread/article opener, pull-quote page, newsletter/email header, packaging front, invitation/save-the-date, greeting card.

**Cluster C — Structured listing.** The content *is* a set of items, size = importance. The Index / Spaced-lines family already built is the seed; distinct moves are ruled lists, dot leaders, size-ranked lineups.
- Menu, festival lineup, conference agenda, sports fixture, price list, film/credits cards, awards list.

**Cluster D — Set-based.** Consistency across many artifacts is the point. Needs the cross-artifact **consistency layer** — the one genuinely new capability, shared by every profile here at once, overlapping sub-project 5 (reflow). Heaviest.
- Slide deck, social carousel, story sequence, ad campaign matrix (one design × N formats), a poster series / daily practice.

**Cluster E — Functional and brand-locked.** Clarity + compliance, conservative moves, brand kit locks face/colour; Read checks legibility, CTA presence, and safe areas.
- Display ad/banner, business card, certificate, badge/credential, coupon, letterhead.

### Out of scope (say so, and why)

UI screens, long documents, dashboards/infographics, forms, diagrams/flowcharts are function- or data-driven; re-roll adds little and they belong to other tools (product layout, or the dataviz path). Forcing them dilutes the engine's identity — the same mistake as Smart Layout trying to be all layouts at once.

### The video hook graphic (recommended second profile)

"Video thumbnail," understood as a **family**, not one platform:
- **Landscape 16:9** for YouTube (the flagship) and any video platform / course / embed.
- **Portrait 9:16** covers for Reels, Shorts, TikTok — same hook craft, different format.
- **Square** podcast episode art.

Why it is the right second profile: it is Cluster A (near-free on the poster moves), it has very large demand, it proves the profile seam **without** needing the set layer, and it points at the motion wedge (thumbnails belong to video creators). Crucially its Read rubric **inverts** the poster's — a poster is made for a wall, a thumbnail for a postage stamp — so it is a genuine test of the per-profile rubric: legibility at ~5% scale, contrast, and one clear hook replace drama and scale-craft. Its moves add a subject-cutout element and a hook-phrase treatment; it drops the fine-print details a poster carries.

### Build order

1. **Poster** (sub-project 1). Proves the mechanism.
2. **Cluster A cousins**, starting with the **video hook graphic**. Reuse the moves; no new capability. Proves the profile seam and the inverted Read rubric.
3. **Cluster C (structured listing).** Extends the Index family with list/lineup moves.
4. **Cluster B (editorial).** Grid-disciplined variants.
5. **Build the set / consistency layer** (with sub-project 5, reflow) — the one new capability — which then unlocks **Cluster D** wholesale.
6. **Cluster E (functional)** alongside, as a conservative move-list + brand locking.

### What the seam must guarantee now (so none of the above is a retrofit)

- The **moves registry**, the **Read rubric**, and the **shelf filter** are keyed by profile from the start (poster is the only key today).
- The **format control is fully independent** of the profile control (a poster can be square; a thumbnail can be portrait).
- A profile may declare a **set relationship** (this artifact is one of a consistent series); the poster profile leaves it null, and Cluster D profiles populate it once the consistency layer exists.
