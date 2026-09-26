# Frame brush materials (Part 2 of "painting with shaders")

Date: 2026-09-26 · Status: approved by Julien ("go for it", following Part 1)
Builds on: `docs/superpowers/specs/2026-09-26-frame-brush-tips-design.md` (Part 1, landed)
Prototype (look reference, shaders to port): `docs/superpowers/specs/assets/2026-09-26-shader-brush-prototype.html` (v14)

## In plain words

Part 1 gave the Frame brush three tips. The paint they make is still a flat colour, or whatever fill the brush layer has.

Part 2 adds six **materials** you can paint with: Holographic foil, Liquid chrome, Lava, Marbled ink, Neon and Oil slick. They are live shaders, so they move gently over time.

How a material sits in the paint depends on the tip, as you decided:

- **Round and Bristle: the material follows each stroke.** It runs along the line from start to finish, so each stroke is its own object. Chrome catches light along its length, and foil bands run with the stroke.
- **Spray can: the material is fixed to the surface**, because sprayed paint has no direction. The paint reveals one sheet of material.

You pick the paint in the brush toolbar: Colour (today's behaviour) or one of the six materials. A brush layer remembers its material. It can be changed later in the layer's panel, together with one "Moving" switch that freezes the material in place.

**What's risky:** the look must hold at every render size, like Part 1's grain. A moving material also means a Frame containing one keeps a clock running. The "Moving" switch exists so a still Frame costs nothing.

## Decisions

1. **The material belongs to the brush layer, not to the fill picker.** It is a new optional `BrushLayer.material = { id, moving }`. When set, it replaces the layer's fill for the tip strokes. Other surfaces never see it: no new `FillType`. So the shader-fill machinery, the agent and every other studio are untouched.
2. **Stroke coordinates.**
   - Round dabs and Bristle ribbons carry "how far along the stroke" and "how far off-centre", as in the prototype.
   - The engine writes these into a float texture per group. This needs `EXT_color_buffer_float`; without it, strokes fall back to surface mode.
   - The material shader reads them. Spray groups use Frame-unit surface coordinates.
   - All coordinates are in Frame units (1080 per artboard width), so the look is identical at every render size.
3. **Materials are drawn per group, on the GPU.**
   - The group's coverage (grain, overspray, Part 1 unchanged) multiplies the material colour, and the group comes back already coloured.
   - Groups composite as today (paint over, erase cuts).
   - Legacy strokes on a material layer keep the layer's fill, drawn underneath.
   - The Canvas2D fallback paints the material's flat swatch colour.
4. **Time.**
   - The material reads the Frame clock (`_fieldCtx.t`, seconds). Flow speed is fixed per material, tuned in the prototype (55 Frame units per second along a stroke).
   - When `moving` is false, t is pinned to 0.
   - `hasAnimatedShaderFill` counts a moving material layer, so the editor and the Frame card run their clock only when one exists.
   - Bakes, exports and web exports get it for free through `drawLocalLayer` and `_fieldCtx.t`.
5. **Choosing a target layer.** Painting goes into the selected brush layer if its paint matches the toolbar's: the same material, or both on Colour. Otherwise a new brush layer is created with the toolbar's paint. A material never silently repaints existing strokes. Changing a layer's material later, in its panel, is an explicit edit and restyles that layer, like changing its fill.
6. **Neon is light.**
   - It glows past the paint: the shader samples the group's density in a small ring, so the halo can extend outside the coverage.
   - Every group's offscreen is padded to fit the halo. A neon layer's bounds grow by the glow radius, so the halo isn't clipped.
7. **No new dials** beyond "Moving". The materials were tuned in the prototype; defaults over controls (your standing rule).

## User-facing copy

- **Toolbar "Paint" row:**
  - A **Colour** swatch, which is today's colour picker.
  - Six round material swatches, each with a tooltip and aria-label naming it: "Holographic foil", "Liquid chrome", "Lava", "Marbled ink", "Neon", "Oil slick".
  - The selected one has a ring.
  - In Mask mode the row is hidden.
- **Brush layer panel, under Fill:**
  - A **Material** select: "None (use fill)" plus the six names.
  - When a material is set, a **Moving** switch, on by default.
  - When a material is set, the Fill control is hidden and the note "The material replaces the fill for brush strokes." shows.

## Testing

- **Unit:**
  - The catalogue.
  - Round coordinates: u increases along the stroke, v stays within ±1 of centre, and the count matches the dabs.
  - The target-layer rule.
  - `hasAnimatedShaderFill` with a moving or still material.
  - The material cache key includes the time bucket only when moving.
- **Browser (real mouse):**
  - Paint each material with Round and with the spray can.
  - A material layer differs from a Colour layer.
  - Two perpendicular Round chrome strokes show highlights running along each stroke. This is checked on screenshots.
  - The "Moving" switch off gives identical pixels a second apart.
  - Reload redraws identical pixels with Moving off.
  - Paint coverage is the same share at two render sizes.
