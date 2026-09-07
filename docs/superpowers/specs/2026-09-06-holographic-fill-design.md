# Holographic Fill — Design

**Date:** 2026-09-06
**Status:** Approved, ready for an implementation plan

## The problem

A designer who wants a holographic surface in the fill system can already reach one — pick
`shader` as the fill type, choose the **Holographic Foil** effect, and give it a base paint.
The result is disappointing, and the reason is structural rather than cosmetic.

`shader_effects/holographic.frag` is a **stylize** effect (`generative: false`). It decorates an
image it is given:

- Its surface normal is derived entirely from the input's luminance gradient
  (`lx`/`ly` sampled from neighbouring texels). Feed it a flat colour and the gradient is zero,
  the normal is uniform, and the glancing-angle sheen `fres` becomes a constant across the
  whole fill — no variation anywhere.
- Its hue phase is `lum * 2.2 + field * 0.6 + fres * 1.0`. The input's luminance carries the
  dominant weight; the procedural pattern carries less than a third of it. Remove the image and
  what remains is a weak, washed-out band.
- Its metallic branch is `irid * (0.3 + 1.15 * lum)` — brightness scales with input luminance,
  so a flat input renders uniformly dim.

So the effect is not broken. It is doing its job, which is to lay iridescence over a picture.
What is missing is holographic as **a surface in its own right** — the thing itself, with
nothing underneath it.

## What we are building

Two pieces.

**Piece 1 — a generative shader effect.** `shader_effects/holographic_surface.frag` plus a
manifest entry, following this repo's established "one `.frag` + one manifest entry" pattern.
`generative: true`, so it needs no input. All of the visual work lives here.

**Piece 2 — a fill-picker entry.** "Holographic" appears in the fill pickers. Choosing it writes
a shader fill whose spec already names the new effect and carries good defaults, so the user
reaches convincing foil in one click.

Twenty of the catalog's seventy-four effects are already generative (`aurora`, `plasma`,
`caustics`, `mesh_gradient`, …), so "produces its own field, needs no input" is an established
pattern here, not an invention.

## Piece 1 — the shader

### The core

One shared pipeline, with only the first step differing per surface:

1. **Generate a height field** procedurally from `v_texCoord` and `u_seed`.
2. **Derive a normal** from that height field by central differences — the same shape as the
   existing effect's `normalize(vec3(-lx, -ly, 0.5))`, but reading the generated field instead
   of an input texture.
3. **Compute the view term** — `V` from `u_angle` plus `u_time * u_shimmer`, and a fresnel
   `fres = pow(1 - dot(N, V), 3)` for the glancing-angle sheen.
4. **Map phase through the iridescent palette** — the cosine palette
   `0.5 + 0.5 * cos(TAU * (t + vec3(0, 0.33, 0.66)))`, which the existing effect already uses.

Step 2 is the whole fix: the normal comes from a field we generated rather than from a picture
we were handed.

### The four surfaces

**REVISED 2026-09-06 after the user supplied reference photographs.** The original four
(Crumple / Grating / Flakes / Slick) targeted rainbow *diffraction foil* — CD undersides, glitter
vinyl, chrome-holo polish. They were built, rendered and rejected: "none of it looks like what
I'm looking for."

The actual target is **holographic sticker vinyl**: the pale iridescent sheet stock that
die-cut stickers and laminates are printed on. Three reference photographs — a stack of
holographic sticker discs, a roll of security-hologram labels, and a fan of blank holographic
sheet stock — share three qualities the first attempt inverted:

- **High key.** A pale silver-white base carries the image. Very little dark anywhere.
  The first attempt measured luminance p1 at 0.087 after a "make it read as metal" pass —
  the pass moved *away* from the target.
- **Low saturation.** Pastel blooms, roughly 0.15–0.35 mean saturation, not 0.56–0.68.
  The rainbow **tints** the silver; it does not replace it.
- **Broad and smooth.** Few, large features. Essentially no high-frequency detail, except
  the fine prismatic glitter on the security-label variant.

Two further qualities were identified by probing against the references, and both were missing
from the first probe round:

- **Silver wash-out zones.** The reference is not tinted edge to edge — the rainbow retreats in
  places and leaves neutral foil. Without this it reads as a printed rainbow gradient rather
  than as foil catching a rainbow. NB the mask window must be tight around the noise's actual
  mid-range; a wide `smoothstep` never reaches zero and delivers no silver at all.
- **A sheen band.** Broad luminance variation across the sheet, so it reads as a physical
  surface under a light. The first probe round spanned only 0.64→0.82 and looked printed.

The four surfaces, all of which the user asked to keep as options:

| Value | Label | Field | Reads as |
|---|---|---|---|
| 0 | Soft sweep | one broad rainbow band, gently bent by low-frequency noise | The pale vinyl sheet stock |
| 1 | Watercolour bloom | two slow noise fields, no direction | The dreamier mint-and-pink areas of the sheet stock |
| 2 | Sweep and sparkle | soft sweep plus fine, sparse, tinted glitter | The security-hologram label roll |
| 3 | Defined bands | the sweep at tighter repeats, distinct colour runs | The banding across the sticker discs |

Unlike the rejected set, none of these derives its colour from a *surface normal* — they are
smooth colour fields over a silver base. The normal-and-fresnel machinery that suited diffraction
foil is not what this look needs.

### Controls

Names reuse the existing effect's wherever they mean the same thing, so the two read as siblings.

**REVISED 2026-09-06 with the surfaces.** Two entries changed meaning when the look changed.
`u_metallic`'s translucent-film ↔ metal-foil axis is meaningless for pale vinyl, so the uniform
is **repurposed** — the GLSL name is kept, because `ShaderSpec.params` keys off it and the
preset below writes `metallic` — and now drives *how much neutral silver washes through*, which
is the control this look actually needs. `u_tint`'s default was a mid slate that pulled the whole
sheet dark; it is now a pale foil.

| Uniform | Label | Range | Default | Notes |
|---|---|---|---|---|
| `u_surface` | Surface | enum (4) | 0 (Soft sweep) | The table above |
| `u_scale` | Scale | 0.5–12 | 4 | Size of the bend / bloom / sparkle field |
| `u_iridescence` | Iridescence | 0–1 | 0.78 | How strongly the rainbow tints the silver |
| `u_bands` | Bands | 0.5–8 | 3 | Hue cycles across the sheet |
| `u_angle` | View angle | 0–360 | 0 | Rotates sweep, bands and sheen together |
| `u_shimmer` | Shimmer | 0–1 | 0.25 | Time drift of the hue + a fine twinkle |
| `u_metallic` | Silver wash | 0–1 | 0.6 | **Repurposed.** How much neutral foil breaks through the rainbow |
| `u_sheen` | Sheen | 0–1 | 0.5 | Matte ↔ polished: strength of the broad light band |
| `u_glow` | Glow | 0–1 | 0.5 | Blends the tinted colour from a matte "paint" mix toward a pearlescent "light" mix that pushes each hue to high value at full chroma, plus a broad soft sheen along the sweep — the only way to read as bright *and* saturated at once without clipping to white |
| `u_tint` | Foil tint | color | `#aab0b8` | The pale foil under the rainbow — grey silver, not pale white (a white base read as paper) |
| `u_crinkle` | Crinkle | 0–1 | 1.0 | Crumpled-foil facet texture: small flat cells with thin bright/dark crease lines, plus a faint per-facet hue shift. Cellular, not noise — a noise grid at this density reads as pixels. Full dial = internal strength 0.4; anything above that read as wet stone, so the dial is capped there |

Defaults are deliberately set to land on convincing foil straight from the picker, since Piece 2
is a one-click entry point. `u_tint` and `u_glow` are new relative to the stylize effect, which
took its base colour from the input it no longer has.

Three look decisions settled against the reference photos are **constants, not dials** (each was
tried as a dial and the reference sat at one value): `OVERLAP = 0.7` — two further offset
rainbows screen-blended over the first, so colours overlap translucently instead of each owning
a zone; `BAND_SHAPE = 0.8` — the sweep bends along long wavy parallel bands, not rounded blooms;
and the silver always carries a pale (30 % whitened) version of the local hue, because the
reference has no neutral grey anywhere.

## Piece 2 — the fill-picker entry

### A preset, not a twelfth fill type

`FILL_TYPES` in `app/lib/spacetype/fillTile.ts` is the single source of truth for every fill
dropdown and currently has eleven members. Adding a twelfth was considered and rejected:

- **Twelve modules import it.** `VectorTypeSurface.vue`, `SpaceTypeSurface.vue`,
  `FillControl.vue`, `ShaderFillEditor.vue`, `shapefx/controls.ts`, `geoshape/config.ts`,
  `vectortype/controls.ts`, `texturefx/types.ts`, `scene3d/materials.ts`, `scene3d/config.ts`,
  `spacetype/fills.ts` and `fillTile.ts` itself. This codebase has already had a `FILL_TYPES`
  leak reach a place it should not have — a fill type escaping into a 3D texture path and
  drawing QR codes.
- **The rendering argues against it more strongly than the blast radius does.** Canvas-painted
  fill types (`paper`, `noise`, `stripes`, …) go through `fillTexture`, which builds a 2D canvas
  tile. Per-pixel iridescence there would be slow and markedly worse-looking. Note what
  `fills.ts` already does at the top of that function: a `shader` fill in the tile path
  **degrades to its input**. A new type would therefore have to be special-cased into the WebGL
  field path in every consumer — which is exactly what `type: 'shader'` already is.

As a preset, the fill is a genuine shader fill, so it renders correctly everywhere shader fills
already render, with no new render paths and no new member in a constant twelve modules read.

### The trade-off, stated plainly

A document saves the fill as `type: 'shader'` with a spec naming `holographic_surface`, not as
`type: 'holographic'`. Anything that inspects fills by type — an agent patch, a preset browser,
a future "group by fill type" view — sees a shader fill. If the document must literally say
holographic, the twelfth type is the way, and this decision reverses.

### Where the entry appears — and where it correctly does not

The four call sites are not uniform, and the entry must respect what each already does. This is
the part most likely to be got wrong by assuming "add it to every dropdown".

| Call site | Today | Holographic entry |
|---|---|---|
| `compositor/FillControl.vue` | all of `FILL_TYPES`, minus `shader` when `nested` (the depth-1 rule) | **Yes.** Also hidden when `nested`, for the same reason — it *is* a shader fill |
| `SpaceTypeSurface.vue` (slot list, ~line 2011) | full `FILL_TYPES` | **Yes** |
| `SpaceTypeSurface.vue` (`WORD_FILL_TYPES`, `CARD_FILL_KINDS`) | a deliberate subset — `solid, gradient, ombre, grid, noise` | **No.** These curated subsets already exclude `shader`; Holographic follows the same rule |
| `VectorTypeSurface.vue` | `FILL_TYPES.filter(paintIsVector)` | **No, and this is correct.** `paintIsVector` → `exportTier`, and a generative shader field cannot be expressed as geometry, so it exports as `raster`. Its absence there is the system working, not a gap to fix |

`ShaderFillEditor.vue` is the shared editor those call sites already mount for a shader fill; it
needs no change, because the preset produces an ordinary shader fill it already knows how to edit.

Selecting the entry writes a shader fill carrying the defaults from the Controls table above:

```ts
{
  type: 'shader',
  shader: {
    effectId: 'holographic_surface',
    params: { surface: 0, scale: 4, iridescence: 0.85, bands: 3, angle: 0,
              shimmer: 0.25, metallic: 0.6, sheen: 0.5, tint: '#d8dee6' },
    anchor: 'object',
    speed: 1,
    seed: 42,
    input: DEFAULT_SHADER_SPEC.input,
  },
}
```

Two details that are easy to get wrong:

- **Param keys drop the `u_` prefix.** `ShaderSpec.params` is documented as "keyed WITHOUT the
  `u_` prefix", so it is `surface`, not `u_surface`.
- **`input` is set but unused.** `ShaderSpec` requires it and the depth-1 rule still applies, so
  it takes `DEFAULT_SHADER_SPEC.input` rather than being invented or left undefined. The
  generative effect ignores it, exactly as the other twenty generative effects do inside a
  shader fill.

## Naming

Two holographic effects will coexist, doing genuinely different jobs. Both should exist.

- **New:** id `holographic_surface`, label **"Holographic"**, category `generative`.
- **Existing:** id `holographic` keeps its id, label changes from "Holographic Foil" to
  **"Holographic Overlay"**, category stays `stylize`.

Only the label changes on the existing effect. Ids are what saved documents store, so they stay
untouched and every existing document keeps resolving.

## Testing

**Golden images.** `tests-unit/shaderfx_golden/` is the established pattern; one golden per
surface mode.

**The variance guard — the important one.** A shader that compiles, binds and renders a
completely uniform frame is this feature's version of a silent no-op, and it would pass every
"does it run" check. Each surface mode gets an explicit assertion that the rendered frame has
**real variance** — that it is not a constant colour, and that its hue actually spans a range
rather than sitting on one note. This is the test that fails if the effect silently produces
nothing.

**Manifest integrity.** The manifest entry's params match the uniforms the `.frag` actually
declares, and `generative` is `true`. A param declared but not consumed is a dead control.

**Live.** Render it in Texture Studio and as a fill, and confirm the picker entry produces foil
in one click without further tuning.

## Not in scope

- **The 3D `holographic` material is untouched.** It reads real surface normals and view
  vectors; this is a flat-field approximation. They are siblings, not duplicates.
- **The existing stylize effect keeps its behaviour.** Label only.
- **No animation-system changes.** Shimmer uses the existing `u_time`, as the stylize effect does.
- **No new fill render path.** If Piece 2 ever needs one, that is the twelfth-type decision
  above, taken deliberately.
