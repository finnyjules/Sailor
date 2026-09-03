# Expressive Studio — separator on the per-glyph Cylinder effect — design

Date: 2026-09-02
Status: Approved (decided in-session, Julien asleep), implementing
Sub-project 5 of 5 of the shape library. Predecessor: the tile-based separator (foundation spec, landed 2026-09-02) which excluded the six per-glyph effects.

## Plain-language summary

The tile separator paints a shape into the repeating word tile, so it reaches the 19 effects that sample that tile. Six effects lay letters out one by one instead and never see the tile. Of those, **Cylinder** is the one where a separator means something: each ring carries its word once around the full circle, so the seam between the end of the word and its start is exactly where a separator belongs — the ring then reads "SAILOR ✦ SAILOR ✦" as it spins. This sub-project gives Cylinder the same three controls and paints the shape as one more glyph at the end of the ring.

The other five per-glyph effects stay out: Blend, Cascade and Onionburst show a single word with no repeat seam; Slot reels whole words or characters; Ring arranges content tiles (words, photos), where a separator would be a content item of its own — a later, separate seam.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Where the shape is painted | `layoutChars` appends one glyph cell after the last character: `[gap][shape][gap]` | The glyph atlas and the per-glyph UV windows are the only thing the per-glyph effects consume, so a separator that is a glyph needs no effect-side geometry changes. |
| Sizing | `shapeH = cap × size` (cap from the font's `H` ascent, fallback `0.72·fontPx`), clamped to the row; `shapeW = shapeH × aspect`; `gapPx = gap × fontPx × 0.25` | Same numbers as the tile separator, so the two paths agree. |
| How Cylinder learns about it | `makeTextTexture` stores `opts.separator` on `tex.userData.separator`; Cylinder reads it from the `textTexture` argument it already receives (and currently ignores) | No engine plumbing change; both tile-option builders already resolve `separator`. |
| Eligibility | `separatorEligible` becomes: not raw-word, and (not per-glyph or in `PER_GLYPH_SEPARATOR_READY = {cylinder}`) | Keeps the documentary per-glyph set intact and opens exactly one effect. |
| Colour / stroke | Filled with the layout's `color` (white in Cylinder's atlas — the fill rail colours it in the shader), stroked with the layout's stroke like the letters | Matches how Cylinder's own glyphs are painted. |

## Architecture

- `charLayout.ts`: `CharLayoutOpts.separator?: SeparatorSpec`. In `layoutChars`, after the measure pass and before `totalAdvance`, when a separator is present: compute `gapPx`, `shapeH`, `shapeW`; push a measured entry `{ char: sep.shape.id, x: cursor + gapPx, w: shapeW, isSpace: false, shape: sep.shape, shapeH }` and advance `cursor += gapPx + shapeW + gapPx`. In the draw pass, entries with `shape` are drawn via `drawShape(ctx, shape, { x, y: h/2 − shapeH/2, w, h: shapeH, fill: opts.color, stroke })` instead of `fillText`. The glyph list gets the entry like any other (`u0/u1/aspect/centerT`). With no separator the function is byte-identical.
- `textTexture.ts`: `tex.userData.separator = opts.separator` (undefined when absent).
- `effects/cylinder.ts`: `layoutOpts` gains `separator: _textTexture?.userData?.separator`; the `void _textTexture` line goes.
- `separator.ts`: `PER_GLYPH_SEPARATOR_READY` + the eligibility change; the controls test's literal INELIGIBLE list drops `cylinder`.

## What stays identical

Every effect but Cylinder; Cylinder with Separator = None (no extra glyph, same atlas, same advance).

## Testing

- `spacetype-char-layout-separator.unit.spec.ts` (node, fake canvas + FakePath2D as in the tile test): without a separator the glyph count equals the non-space character count and no path fill happens; with one, one extra glyph whose `aspect = shapeW / lineHeightPx`, whose `u0` follows the last letter plus the gap, and a single `fill` op with the shape's path data; `scaleX` widens the canvas for the whole run.
- `spacetype-separator-controls.unit.spec.ts` — Cylinder now has the three controls; the other five per-glyph effects still do not.
- `textTexture` — `userData.separator` present when set, undefined otherwise (extend the tile spec).
- Live: Expressive Studio → Cylinder → Separator Sparkle: the ring reads SAILOR ✦; None restores it.
