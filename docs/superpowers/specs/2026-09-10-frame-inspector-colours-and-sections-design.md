# Frame inspector — colour rows and section cards — design

Date: 2026-09-10. Status: approved by Julien ("yes please") on the proposal below. Follows the Frame recolour spec (`2026-09-10-frame-recolour-design.md`).

## Plain-language summary

Two pieces of feedback after recolour landed: "I like the colour system, but I think I like the Figma presentation more", and "all the different sections on the inspector need some sort of separation, it's pretty messy."

**Colours, Figma's way.** The swatch strip becomes a list, one row per colour, biggest first: a swatch, the hex, and an opacity field. The swatch opens the house colour picker, so a colour can go to *any* colour, not only the family's, and the change lands everywhere that colour is used, as its own undo step. The hex can be typed. Opacity shows the value when every use of that colour shares one alpha, "Mixed" otherwise; editing it rewrites the alpha on every use. The family popover goes away: the picker covers it. The palette shelf and Images too stay below the list.

**Separation.** The other studios already solve this with `StudioSection`: a bordered card with a muted title and a chevron, collapsible, open by default. The Frame's Design tab never adopted it and uses bare grey labels with the odd hairline. Every block of the Design tab becomes a card. Markup only; no control changes behaviour.

## Colour rows

- Row = swatch (`StudioColor`, the house picker, bound to the slot's colour with its alpha when uniform) · hex text (6-digit, editable, commits on Enter or blur, invalid input reverts) · opacity `NN %` (editable 0–100 when uniform; shows `Mixed` and is read-only when the slot's uses carry different alphas).
- Sorted heaviest first, as today. `data-testid="colour-slot"` with `data-hex` stays on the row; the hex input is `colour-slot-hex`, the opacity input `colour-slot-alpha`.
- A change from the picker or the hex field → `recolourSlot(slotHex → newHex, alpha kept per use)`; a change from the opacity field → the same slot with the new alpha on every use. Each is its own undo step. Reassigning never touches image gradient maps.
- The family popover (`colour-slot-options`) is removed. `sailor_recolour.applied` keeps recording family applies; a manual edit records nothing extra.

## Section cards

`StudioSection` (`frontend/app/components/vue-canvas/StudioSection.vue`, props `title`, `badge?`, `open?`), open by default, one per block. Sub-labels inside a card stay as they are.

**Nothing selected:** Background · Colours · Post-processing · Grid · Arrange (the "Expressive arrange" block, shown only when it applies today).

**A layer selected** (the `selectedLocal` branch), the existing label clusters fold into:
- **Text** — Font, Size, Weight, Align, V-align, width/height, Follow a path and its dials, Line height, Letter spacing, Style, Expressive, Colour, Outline (text layers).
- **Fill and outline** — Fill, Stroke, Corner radius, Sides, Points, Shape, Colour, Thickness, Library (rect / ellipse / polygon / star / path / line / brush).
- **Style** — the Mosaic / Scatter element blocks (Blend, Module mix, Palette, Treatments, Plate, Centre, Inks, Grid, Origin & fan, Arcs & labels, Line widths, Line style, Inks / Palette).
- **Image** — Tint (image layers).
- **Transform** — Size, Length, Rotation, Opacity.
- **Distort and blend** — Distort, Blend, Displacement map (Read, Amount, Softness).
- **Mask and crop** — Mask, Crop.
The layer name row stays above the cards. The effect-row and outline-row panels (their own breadcrumb branches) are not touched.

## Not changed

No control, handler, default or copy inside a block changes. The Motion and Layout tabs are untouched. Every existing Frame browser test (templates, layout tab, recolour, multi-stroke) must stay green; the cards are open by default so their contents remain reachable.

## Proof

Unit tests for the alpha plumbing; the recolour E2E updated for the rows (type a hex into a row → that colour changes everywhere; edit opacity → every use carries it); a before-and-after screenshot pair of the Design tab with nothing selected and with a text layer selected.
