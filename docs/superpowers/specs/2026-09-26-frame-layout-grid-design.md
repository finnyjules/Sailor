# The Frame's layout grid — one standard, Swiss grid

Status: designed 2026-09-26 from an approved prototype; owner questions answered the same day. Plan not written.
Prototype: `docs/superpowers/specs/assets/2026-09-26-frame-grid/grid-prototype.html` (standalone; open it in a browser).

## In plain words

**What's wrong today.** A Frame has two grids that don't agree. The Grid section in the editor draws one, but it's off by default and buried under Post-processing. The Layout tab places text and pictures on a second, hidden grid. Even with the visible grid on, the two use different column edges, and the hidden one ignores the visible rows. The controls are also engine settings rather than design settings: gutter and margin are fractions like 0.01, plus a seed, a "regularity" dial and merge settings. Grid changes can't be undone.

**What changes.**
1. **One grid per Frame**, and the Layout tab builds on it. What you see is what layouts use.
2. **A standard grid, like Figma's or InDesign's.** You set columns, gutter and margin in pixels, choose Stretch, Center or Left, and pick rows: Off, Square or Count. Every format starts with a sensible grid. It follows the format until you change it, and after that it's yours.
3. **A finer, Swiss grid.** There are 12 columns and square modules. A baseline grid comes from the body text's line spacing (the **Line** value), so text and pictures share the same horizontal lines.
4. **Text snaps by what you see, not its box.** Capitals snap to module tops and the last baseline to module bottoms. Otherwise the baseline stays on the baseline grid.
5. **It behaves like a real tool.** Grid changes can be undone, a shortcut shows or hides the grid, and a selected layer shows the columns and rows it covers, which you can edit.

**What goes away.** The Frame's "generated" grid (seed, regularity, merge, symmetry) moves to Mosaic, where it's really a look. Also removed: "Fill grid with sections" and "Draw section".

**What's risky.**
- The Layout tab's type sizes and spacing shift slightly to sit on the baseline grid. All 42 layouts are re-checked in every format.
- Responsive Frames currently hold layers to grid "sections". They will hold to the columns and rows a layer covers instead.
- ⌃G on Mac changes from Group to showing the grid, as in Figma. ⌘G still groups.

## Decisions taken in the conversation (don't relitigate)

- The grid is a standard tool. The user asked for "something standard".
- It is finer: 12 columns by default, and rows of square modules.
- It follows Swiss practice (Müller-Brockmann):
  - The grid is derived from the body text's line spacing.
  - Text aligns by its capitals and baselines.
  - Module tops, heights and gaps are whole half-lines.
- The generated grid belongs in Mosaic.
- Panels show labels and values only. Explanations go in tooltips; see the UI copy rule.
- When a stretched grid's numbers don't divide evenly, the Margin field shows the real margin.
- **No red.** The grid is drawn as neutral hairlines. The one colour is the app's accent: the modules a dragged layer covers, the snap lines and the badge. (Owner, 2026-09-26: the red tint is "visually annoying".)
- **Changing the Line does not resize text already on the Frame.** Only the Layout tab's suggestions follow it. (Owner answer 1.)
- **⌃G shows or hides the grid on Mac, as in Figma.** ⌘G still groups. (Owner answer 2.)
- **Older Frames open with the grid hidden,** so they look the same as before. New Frames show it. (Owner answer 3.)

## The grid

### What's stored (`lib/frame/layoutGrid.ts`, new)

```ts
interface LayoutGrid {
  v: 2
  auto: boolean            // true = derive everything below from the Frame's format; false = the user's own
  show: boolean            // overlay + snapping
  line: number             // px at the design size — body text line spacing; the baseline grid is line/2
  cols: { count: number; fit: 'stretch' | 'center' | 'left'; margin: number; gutter: number; width: number }  // px
  rows: { mode: 'off' | 'square' | 'count'; count: number }
}
```

- It's stored on the Frame's node as `sailor_layoutGrid`.
- The `auto` grid is recomputed from the format on every read. A format change moves an auto grid to the new format's grid. The first edit to any grid field saves the resolved values and sets `auto: false`.
- The **↺** button (tooltip "Use the suggested grid for 4:5") sets `auto: true` again.
- All pixel values are at the Frame's design size. A responsive Frame seen at another size scales them by its fit scale, as `unitW` does today.

### The suggested grid (auto)

- **Columns:**
  - The count is `format.nc` when the format sets it: 24 for the leaderboard and wide banners.
  - Otherwise it's 12.
- **Line:** the Layout kit's body text line spacing for this shape and format, rounded to 4 px. The kit already computes this as `INFO.size` × the style's info line height.
- **Unit:** half the line. This is the baseline grid step, called U below.
- **Gutter:** one unit.
- **Margin:** the kit's margin (`min(4, 0.06·H)` % of width, widened by `format.keepSide`), rounded to the unit.
- **Fit:** Stretch.
- **Rows:** Square.
- **Covered areas:** in formats where the platform covers part of the frame (`format.keep`, for example Story), rows start below the covered top and stop above the covered bottom. The kit's "compose in the uncovered band" then becomes simply "use the rows".

### Resolving it (`resolveLayoutGrid(g, W, H, scale = 1)`)

It returns the columns, the rows, the unit, and the snap lines.

- **Columns** are real column edges, not gutter centre lines as in today's `resolveGrid`.
  - Stretch: exact widths, margin to margin.
  - Center and Left: `width` per column. Center centres the columns; Left starts them at the margin, which the panel labels "Offset".
  - Column widths are not rounded to the unit, because horizontal positions don't need the baseline grid.
- **Rows** always sit on the baseline grid:
  - The first top is `toUnit(margin)`, or the bottom of the covered top area.
  - The gap between rows is `max(U, toUnit(gutter))`.
  - Square: height = `round(columnWidth / U)·U`, repeated as many times as fit.
  - Count: `floor(available / count / U)·U − gap`.
- **Baselines** are every U from the top of the Frame.
- **Snap lines:**
  - x: the column edges, the Frame's edges and its centre.
  - y: row tops, row bottoms, the margins, and the centre.
  - Text uses its own targets; see "Snapping".

### Old Frames (migration in `readLayoutGrid`)

- With no `sailor_layoutGrid`, the grid is read as `auto: true`.
  - `show` is `false` when the Frame predates this change (it has layers but no grid property), so opening an old Frame looks the same.
  - New Frames start with `show: true`.
- An **explicit** `sailor_localGrid` is kept as the user's own grid (`auto: false`):
  - Columns, gutter and margin are converted from fractions to px.
  - Rows mode is `count` with the old row count.
- A **generated** `sailor_localGrid` becomes the auto grid. It was only a guide, so nothing in any export changes.
- `sailor_localGrid` is left on the node and is no longer read by the Frame. Mosaic keeps its own copy; see below.

## The editor

### Panel (`CompositorModal.vue`)

The **Layout grid** section sits directly under the Frame section, not after Post-processing. It shows labels and values only; each explanation is a tooltip on the label.

- **Header:** "Layout grid", a ↺ button (only while the grid isn't auto), and the show switch (tooltip "Show grid ⌃G").
- **Columns:**
  - Count and Gutter.
  - Stretch / Center / Left.
  - Margin (or Offset) and Width. Width is read-only in Stretch. Margin shows the real margin.
- **Rows:** Off / Square / Count, with a Count field only in Count mode.
- **Line:** in px, rounded to 4 px when you leave the field.
- The old off/explicit/generated control, the generated controls, Draw section and Fill grid with sections are removed.

In the **Layer** section, each selected layer shows **Column** and **Span**, plus **Row** and **Span** when rows are on. For text, rows are counted from the capitals. Typing a value moves or resizes the layer.

The text box's "col" unit becomes one column plus one gutter of this grid. Today it falls back to a sixth of the width even when the grid is off.

### Overlay

- **Colour:**
  - **At rest,** only the column edges show, as very faint neutral vertical lines (white at 9% under the difference blend). They stay visible whenever the grid is on, whether or not anything is selected; ⌃G hides the grid entirely (owner chose this over showing lines only on selection). The square modules are distracting when you're only looking (owner, 2026-09-26).
  - **While something is being dragged,** the modules appear as neutral hairline outlines with no fill (columns when rows are off), together with the baseline lines.
  - **Selecting never changes the grid.** A press only counts as a move after 4 screen px. Until then nothing shows, nothing snaps, and no undo step is recorded.
  - The modules and baselines **fade** in and out (about 0.2 s) rather than popping. The column edges never disappear while you work. The overlay elements persist between frames and only toggle their opacity (owner, 2026-09-26: appearing on select was "jarring").
  - The outlines use `mix-blend-mode: difference` with white at low opacity, so they read on a light or a dark Frame.
  - The baseline lines are the same, fainter.
  - The only colour is the app's accent (`#7c9cff` family). It is used for the fill on the modules a dragged layer covers, the snap lines, the badge, and the selected text's capital and baseline lines.
  - No red or pink anywhere.
- **While dragging:**
  - The columns and modules the layer covers fill with the accent.
  - Faint baseline lines appear.
  - A badge reads "4 × 3 modules", or "4 columns" when rows are off.
- **Selected text:** a dashed line at its capitals and a solid line at each baseline.
- The overlay is never painted into renders, exports or embeds, as today.
- It's drawn with SVG `<pattern>`s for the baseline lines and modules, not one element per line.
- The read-only overlay on the canvas card (`ArtifactFrameNode.vue`) uses the same resolver.

### Shortcut

- On Mac, **⌃G** shows or hides the grid, as in Figma. ⌘G groups and ⇧⌘G ungroups; the onKeydown handler stops treating Ctrl as ⌘ for G.
- On Windows and Linux the shortcut is **Ctrl+Shift+4**, as in Figma.
- Pressing it records one undo step.

### Undo

- The grid joins the editor's history snapshot (`Snapshot` in `useLocalLayerEditor.ts`).
- `setGrid` records a history step. Edits typed into a field record one step when you leave the field. The agent's `setGrid` also records one.

## Snapping

Snapping to the grid only happens while the grid is shown. ⌥ places freely. The snap distance stays at 6 screen px.

**Boxes** (pictures, shapes, anything not text):
- **Move:** the left or right edge snaps to x lines, and the top or bottom edge to y lines, whichever is nearest. If nothing is within reach, the top rounds to the baseline grid.
- **Resize:** the dragged edges snap the same way. Today only move snaps.

**Text** (new, `lib/frame/textMetrics.ts`):
- `textMetrics(layer, W)` measures the text with the renderer's own font and line layout (`applyFont`, `wrappedTextLinesMeta`, lines drawn at the middle of each line slot). It returns, from the box top:
  - the capital top of the first line (from `measureText('H')`, as `kit/measure.ts` does);
  - each baseline;
  - the line count.
- The results are cached by font, size, line height, width and text.
- **Move** has three candidates:
  1. Capitals to the nearest row top (or the top margin).
  2. The last baseline to the nearest row bottom (or the bottom margin).
  3. Otherwise, the first baseline to the nearest baseline line.
- **Resize** of the text box width snaps to column edges. Height follows the text.
- **Fix owed:** snapping and Re-snap currently treat `y` as the centre and ignore `textVAlignCenterOffset`. Text placed by the Layout tab uses `valign: 'top'`, so its snap edges are off by half the box. Snapping must use the same box the hit test and handles use.
- **Re-snap** (the selection-header button) uses the same rules: capitals and baselines for text, edges for boxes.

## The Layout tab on this grid (`lib/frame/patterns/kit/`)

- **Columns** come from the resolved grid:
  - `makeSheet` takes the resolved `LayoutGrid` instead of reading `grid.mode` or `grid.columns`.
  - `NC`, `M`, `G` and `CW`, and every column edge `Xr(c)`, are the grid's own edges, so layout text lands exactly on the visible columns.
  - Layouts are still written on 12 design columns and mapped onto the real count. The wide-frame sub-sheet (`colRange`) is unchanged.
- **Rows:**
  - With rows on, the design's 16 rows map onto the real row tops. `L(r)` returns the nearest row top at or after the proportional position, and a bottom rule uses row bottoms. Things start on a module top and end on a module bottom.
  - With rows off, positions round to the baseline grid.
- **Type sizes follow the Line:**
  - **Body and small text:** line spacing = Line, and the size is chosen so the capitals are exactly one unit tall in the text's own font (`U / capAbove(role)`).
  - **Display type:** the size is still fitted per layout. It's then rounded to the nearest size whose capitals are a whole number of units, and its line spacing is rounded to a whole number of units. The layout may set line spacing; font, weight and colour stay the user's (decided 2026-09-22).
  - Placing text then puts its capitals on the module tops and its baselines on the baseline grid, both at once.
- **Covered areas:** formats with `keep` compose on the rows, which already avoid the covered areas. The shift-by-inset step goes.
- **Changing the Line** updates the baseline grid and re-plans what the Layout tab offers. It does **not** resize text already on the Frame (owner answer 1).
- **Checker:** the shared checker adds "text on the baseline grid" and "capitals on a row top when rows are on". The full sweep (every layout × every format × 3 content lengths × with and without a photo) must pass, as it did at 880 tiles, 0 failures.

## Responsive Frames (`lib/frame/responsive/`)

- Today a layer holds to the single grid region it sits in (`sectionOf`, with a gutter-inset cell or merged region). That never works on a 12-column, square-module grid, because layers cover many modules.
- New rule: a layer holds to the **span** it covers (its first and last column, plus first and last row when rows are on), found the same way as the Layer section's Column/Span. At another size, `resolveLayout` places it on the same span of the grid resolved at that size.
- `holdTo: 'section'` is renamed `'grid'`; `'frame'` is unchanged. Stored `'section'` pins read as `'grid'`.
- The overlay at a viewing size uses the same scaled grid as the resolver. Today they can differ.

## The agent (`lib/agent/surfaces/compositor.ts`)

- `setGrid` takes:
  - `columns` and `gutter`/`margin` in px;
  - `fit` (`stretch`/`center`/`left`) and `width`;
  - `rows` (`off`/`square`/`count`) and `rowCount`;
  - `line` and `show`;
  - `suggested: true` to return to the auto grid.
- The hint says "a standard layout grid" and names the phrases "a 12-column grid", "square modules", "a baseline grid" and "show the grid".
- `generate` and `reroll` on `setGrid` now answer: "The Frame's grid is a layout guide; for a generated grid pattern use mosaic."
- `describe` reads out, for example, "12 columns, square rows, line 40 px".
- `mosaic` create no longer copies the Frame's grid. It makes a fresh mosaic grid, as the toolbar stamp already does.

## Mosaic keeps the old grid

- `DealLayer.grid` keeps today's type, renamed `MosaicGrid` in `lib/compositor/mosaicGrid.ts`, which is today's `grid.ts` moved. It keeps `resolveGrid` and the generated mode, seeds, merge and symmetry. The Mosaic inspector is unchanged.
- The Frame no longer imports it. `frameContext.ts`, which only tests use, moves to the new grid or is deleted if nothing needs it.

## Stages

1. **The grid:**
   - `LayoutGrid`, the suggested grid, the resolver and migration.
   - The panel and the overlay (editor and card).
   - The shortcut and undo.
   - Box snapping on move and resize.
   - Mosaic split out.
   - Generated mode, Draw section and Fill grid with sections removed.
2. **Text:**
   - `textMetrics`, text snapping and Re-snap.
   - The `valign` snapping fix.
   - Column/Row/Span in the Layer section.
   - The "col" text box unit.
3. **Layouts:**
   - The kit on the resolved grid: columns, rows, type from the Line, covered areas.
   - The checker additions and the full sweep.
4. **Responsive and agent:**
   - Holding to spans.
   - The scaled overlay.
   - The agent vocabulary.

## Testing

- **Unit:**
  - The resolver: Stretch, Center and Left; Square and Count rows; covered areas; the scale.
  - Migration from explicit, generated and absent grids.
  - The suggested grid per format.
  - `textMetrics` against the renderer.
  - Snapping candidates: capitals, last baseline, fallback.
  - The kit sheet's edges equal the resolver's edges.
  - The agent `setGrid` vocabulary.
  - Responsive span holding.
  - Update the existing grid, sheet, responsive and agent specs listed in the survey.
- **Browser (Playwright, real mouse):**
  - Drag a picture and see it snap to a column edge.
  - Drag text and see its capitals land on a row top.
  - ⌃G toggles the grid; ⌘G still groups.
  - Changing the column count, then ⌘Z, restores it.
  - An old Frame opens with the grid hidden.
  - Applying a Layout tab layout puts text on the visible columns.
- **Sweep:** the Layout tab checker over every layout × format × length × photo, run outside `requestAnimationFrame` (the paused hidden pane trap).

## Owner answers (2026-09-26)

1. Changing the Line does not resize text already on the Frame.
2. ⌃G on Mac shows the grid; ⌘G groups.
3. Old Frames open with the grid hidden; new Frames show it.

## Later (not in this spec)

- Margins per side, from classic book proportions.
- A few fixed horizontal lines that hold across formats, like Vignelli's Unigrid.
- The Frame edge as a snap target for bleeds.
- A "grid visible in the export" Frame style, like Crouwel.
