# Frame brush — more shaders and painted effects (Part 3 of "painting with shaders")

Date: 2026-09-26 · Status: approved by Julien ("go for it", after Parts 1 and 2)
Builds on: `2026-09-26-frame-brush-tips-design.md` (Part 1) and `2026-09-26-frame-brush-materials-design.md` (Part 2)
Prototype: `docs/superpowers/specs/assets/2026-09-26-shader-brush-prototype.html` ("Paint an effect")

## In plain words

Two additions to the Frame brush.

1. **More shaders.** Next to the six materials, a **More…** button opens the Sailor shader library, with your My effects first. Pick one and you paint with it.
   - Library shaders sit on the surface for every tip, like a sheet revealed by the paint. Only the six curated materials run along the stroke; that needs a stroke-aware shader, which library shaders aren't.
2. **Painted effects.** A third brush mode, **Effect**, beside Paint and Mask.
   - Choose an effect: Ripple, Reeded glass, Glow, Dither, Colour split, Pixels or Frost. **More…** opens every shader that works on a picture.
   - Then paint where it should happen. The effect changes **everything beneath** the brush layer, only where you painted.
   - The paint itself never shows. It only sets where the effect applies and how strongly. A spray pass is a light effect; going over it again strengthens it; the eraser takes it away.

**What's risky:**
- A painted effect snapshots everything beneath it each time the Frame draws. That already happens for the Frame's backdrop effects, and the cost is the same.
- The strength of an effect comes from the paint's coverage, so spray grain shows as a grainy effect. That is intended; it's how the prototype looked.

## Decisions

1. **Painted effects reuse the Frame's existing backdrop effect.**
   - An effect brush layer is an ordinary brush layer with:
     - `showPaint: false` (new, optional; absent = true);
     - one `backdrop_shader` entry in its effect stack, with the chosen catalogue effect and speed 0.
   - The backdrop pass already weights the effect by the layer's rendered alpha (`withBackdrop` → `destination-in` with the silhouette), so coverage becomes strength.
   - The layer's own paint draw is skipped when `showPaint === false`. The silhouette "ghost" the backdrop pass builds must still include the paint: force `showPaint: true` on the ghost.
   - The effect's own dials, speed, motion targets and agent access all come from the existing effect row, with no new UI.
2. **More shaders as paint = the brush layer's existing shader fill.**
   - The fill is `{ type: 'shader', shader: { …defaults, effectId, anchor: 'frame' } }`, poured in with source-in as today. This already renders in the brush branch.
   - No material is set.
3. **Gallery filters** use the existing `ShaderEffectGallery`:
   - The **paint** gallery lists generative shaders plus the Material category.
   - The **effect** gallery lists shaders that sample their input (`effectReadsInput`).
   - My effects follow the same rules, and are listed first as the gallery already does.
4. **Curated effects** map to catalogue ids:

   | Label | Catalogue id |
   |---|---|
   | Ripple | `water_ripple` |
   | Reeded glass | `blinds` |
   | Glow | `bloom` |
   | Dither | `bayer_dither` |
   | Colour split | `chromatic_aberration` |
   | Pixels | `pixelate` |
   | Frost | `gaussian_blur` |

   Their catalogue defaults are used as they are; the effect's dials tune it afterwards.
5. **Target layer.**
   - **Effect mode:** a stroke goes into the selected brush layer only if it is an effect layer with the same effect. Otherwise a new effect layer is added on top, so it affects everything beneath.
   - **Paint mode with a library shader:** a stroke goes into the selected brush layer only if its fill is the same shader. Otherwise a new layer is created.
   - **Eraser:** exempt, as before.
6. **Toolbar.**
   - The mode control becomes **Paint · Effect · Mask**.
   - **Paint mode:** the Paint row gains **More…**. A chosen library shader shows as a seventh swatch with its name as tooltip. Choosing Colour or a material clears it.
   - **Effect mode:** the row shows the seven effect chips plus **More…**. The tips, size and eraser work as in Paint mode. There is no colour.
   - The hint line reads "Paint where the effect should happen. Go over it again to make it stronger."
7. **Right panel.**
   - **Effect layer:** a header "Painted effect · <effect name>", **Change effect…** (opens the effect gallery and swaps the effect id, one history step), and the note "The paint is hidden; it sets where the effect applies and how strongly." Fill and Material are hidden.
   - The effect's dials stay where every effect's dials live (select its effect row).
8. **Persistence:** the toolbar's mode, chosen effect and chosen library shader are remembered in `sailor.brushTips.v1`.

## Out of scope

- Library shaders following the stroke.
- Several effects on one brush layer from the toolbar (the effect stack already allows adding more by hand).
- An effect on only one chosen layer beneath. The existing glass-lens "reads" option is not wired to brush layers.

## Testing

- **Unit:**
  - The curated list and ids.
  - The gallery filters, checked against a fake catalogue.
  - `showPaint` gating.
  - The ghost forcing `showPaint`.
  - Target-rule helpers.
  - Persistence.
- **Browser (real mouse, running app):**
  - Effect mode + Pixels over the text of a Frame makes the text pixelate only where painted.
  - The effect layer's own paint is not visible.
  - A second pass strengthens it (a larger pixel difference).
  - The eraser reduces it.
  - Paint mode → More… → a generative shader paints a layer with a shader fill.
  - Reload redraws identical pixels.
  - The toolbar at 1024 wide.
