# Frame recolour — design

Date: 2026-09-10. Status: designed, awaiting Julien's review. Sibling of the typographic-poster spec (`2026-09-08-poster-composition-design.md`); independent of it.

## Plain-language summary

A Frame is a design with a handful of colours in it: a ground, the type, a couple of accents, maybe a gradient. Today the seed→palette engine can hand you twelve good palettes from one colour you like, but the only way to put one on a Frame is to select layers and let it deal colours across them in turn, which scrambles which things match.

**Recolour** swaps the frame's palette while keeping its colour *structure*. Sailor reads every colour the frame holds, groups the identical ones into **slots** (everything that was red stays one slot), ranks the slots by how much of the picture they cover and how light they are, and maps them onto a palette family in the same light-to-dark order. Things that shared a colour still share one; the darkest thing is still the darkest; the ground and the main type still read against each other. One click, one undo step, any frame — a poster, an ad, a slide.

It lives on the Design tab with nothing selected, as a **Colours** section: the frame's slots as swatches, the palette picker beneath. Pick a family and the frame recolours. Click a slot to send it to a different colour of that family, so a wrong mapping is one click, not a rebuild. The Layout tab needs nothing: it already reads the frame's colours as its palette.

## What counts as a colour (v1)

Every solid hex the frame holds, read through one walker that returns `{ get, set }` accessors so reading and writing can never disagree:

- the frame background (`sailor_localBg`): a solid, or each stop of a gradient
- text `color`; a legacy text `strokeColor`
- shape `fill` and `stroke` on rect, ellipse, path, polygon, star, line, brush; each entry of a layer's stroke stack
- gradient stops and `Fill.a` / `Fill.b` / `Fill.textColor` wherever a Paint sits in the fields above
- image `tint`
- deal and scatter ink arrays for the active style (`pane.inks`, `mosh.inks`, `carve.inks`, `totem.inks`, `modular.{bg,rule,inks}`, `parcel.{ground,ink,hairline}`, `blueprint.{ink,inkDim}`, `chaff/strand/husk.inks`)

**Not in v1, by decision:** effect-stack colours (drop/inner shadow are transparent black by convention, not palette), duotone and gradient-map post effects, shader params, image fills (no colour), wired layers (no paint of their own). An 8-digit alpha hex is grouped by its RGB and written back with its alpha kept. Anything that is not a hex (an `rgba()` string, a CSS name) is left untouched.

## Slots and weights

- **Slot** = one distinct 6-digit hex (lower-cased). All sites carrying it belong to it.
- **Weight** = how much of the picture the slot covers, so the ranking reads as a designer would: background 1.0 (the whole frame); a shape its `w × h` (normalised); a text layer `fontSize × characters × 0.55` (an ink-coverage proxy); a stroke `perimeter × width` (small); a gradient stop its layer's area ÷ stops; an image tint its area × 0.3; deal/scatter inks the layer's area ÷ inks.
- The slot list is sorted by weight, descending. The first slot is the **ground**; the heaviest text slot is the **ink**.

## Mapping a family onto the slots

Given a family of N colours and M slots:

1. Sort the family's colours by OKLCH lightness. Sort the slots by the lightness of their current colour.
2. **M ≤ N:** choose M colours from the family at even quantiles of its lightness order, always including its lightest and darkest, so the frame keeps its light-to-dark span. Assign in lightness order.
3. **M > N:** each slot takes the family colour at the nearest lightness rank; several slots share one colour (that is what a smaller palette means).
4. **Contrast guard:** the ground and the ink must reach 4.5:1. If they do not, the ink takes whichever family colour contrasts best with the ground (the poster engine's `autoInk` over the family). Nothing else is auto-corrected.
5. Deterministic: same frame + same family → same result. No seed.

Rationale: lightness order is what preserves a design's reading; hue is what the family brings. Mapping by hue similarity instead would keep the old palette's temperature and defeat the point.

## Reassigning a slot

After a family is applied, the family is remembered on the frame (`sailor_recolour: { hexes, applied: Record<slotHex, familyHex> }`, UI memory, not document content). Clicking a slot swatch opens a small row of that family's colours; picking one rewrites every site of that slot to it, as its own undo step. Before any family is applied the slots are read-only swatches (a picture of the frame's palette). No locks in v1 (recorded as a follow-up: lock a slot so a brand colour survives a recolour).

## Undo model

One click = one undo step covering layers **and** background. The editor gains a non-recording `writeBackground(paint)` beside `setBackground` (which records its own history), so the recolour path is `recordHistory()` → `commit(layers)` → `writeBackground(bg)`, once each, mirroring the poster apply. The undo snapshot must include the background; if it does not today, the snapshot type gains it (verify in the plan).

## Where it lives

Design tab, nothing selected, a new **Colours** section immediately after **Background**: the slot swatches in weight order (largest first), then the existing `PalettePicker` in `stops` mode with only `apply-family` and `apply-stops` bound (never `apply-literal-stops`, which double-fires on seed tiles — the multi-select popover already avoids it). The picker's Library pane is the seed engine's shelf; its seed defaults to the frame's ink slot so the shelf opens near the frame's own colours. No toolbar button, no takeover, no new tab.

## Components and files

- `frontend/app/lib/compositor/recolour/sites.ts` (new, pure) — `colourSites(layers, background) → ColourSite[]` with `{ layerId | 'bg', path, get(), set(hex), weight }`; the one walker.
- `frontend/app/lib/compositor/recolour/slots.ts` (new, pure) — `slotsOf(sites) → Slot[]` (`{ hex, weight, sites }`, sorted), `groundOf`, `inkOf`.
- `frontend/app/lib/compositor/recolour/map.ts` (new, pure) — `mapFamily(slots, familyHexes) → Record<slotHex, familyHex>` (quantile / nearest-rank + contrast guard).
- `frontend/app/lib/compositor/recolour/apply.ts` (new, pure) — `recolourFrame(layers, background, mapping) → { layers, background }` (structured clone, writes through the sites).
- `frontend/app/composables/useLocalLayerEditor.ts` (modify) — export `writeBackground`; snapshot carries background.
- `frontend/app/components/vue-canvas/compositor/ColourSlots.vue` (new) — the slot row + reassign popover.
- `frontend/app/components/vue-canvas/CompositorModal.vue` (modify, by hunk) — the Colours section; `applyFamilyToFrame(fam)`.
- Tests: unit for sites / slots / map / apply (including "layers that shared a colour still share one", "lightest stays lightest", contrast guard, alpha kept, gradient stops rewritten in place, deal inks); E2E on `/dev/frame-lab`: pick a family → distinct colours change, sharing preserved, background changed, one undo restores both.

## Success criterion

On a frame with a ground, a headline, two accents and a gradient, any of the shelf's twelve families lands in one click with the headline still readable and every pair of elements that matched before still matching. The taste call left to Julien: whether the ground should stay in the family's *lightest* colour (paper-first) or follow the frame's current ground lightness (a dark frame stays dark). v1 follows the frame's current lightness order, so a dark frame stays dark; a "flip" is a one-click reassign of the ground slot.

## Out of scope, named

Hover-preview (no preview-without-commit infrastructure exists); locks; recolouring effects and shader parameters; a per-layer "exclude from recolour" flag; the agent verb ("recolour this in blues") — one line once the pure functions exist, deferred to keep this slice small.
