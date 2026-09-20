# Frame effects — Slice F4: missing layer styles

BASE e12c287d7. Eight tasks adding the Photoshop-style "layer styles" the Compositor's per-layer
effect stack lacks. These are PIXEL-region passes over the rasterised layer (extending
`postEffects.ts`'s PostEffect system), NOT geometry-outline transforms like F2/F3. A layer with
none of them renders byte-identically to HEAD.

## The families (one task each)
1. **Outer glow, inner glow** — a blurred, tinted halo outside the alpha (outer, composited
   behind, grows outward → offscreen pad) and inside the alpha (inner, clipped source-atop).
   Dials: colour, size/radius, intensity, (blend). Closest existing: drop_shadow / inner_shadow.
2. **Colour overlay, gradient overlay** — fill the alpha region with a solid colour / a gradient
   at a blend mode + opacity, clipped to the layer (source-atop). Gradient: stops + angle
   (non-clamped, like gradientMap stops).
3. **Stroke from alpha** — a stroke traced from the layer's alpha edge: width, align
   (inside/centre/outside), colour. Outside/centre grow outward → offscreen pad.
4. **Directional, radial, zoom blur** — motion-blur variants over the offscreen (angle+distance;
   centre+amount; centre+amount). Radial/zoom bleed slightly → pad if needed.
5. **Levels, posterise, threshold, invert** — per-pixel tone ops (black/white/gamma; N levels;
   cutoff; invert), within bounds like `adjust`.
6. **Rough edge, ink bleed** — seeded distortion of the alpha boundary (rough edge = jitter the
   edge; ink bleed = feathered spread). Deterministic (seed). May grow outward → pad.
7. **Playwright** — a pixel-change case per family + an amount/none-is-byte-identical case.
8. **Copy sweep + agent hint** — verify the generic `sanitizePostEffect` path covers all new kinds
   (defaults + clamps), add hint copy under `COMPOSITOR_HINT_CEILING` (compress, don't raise),
   handle any non-clampable params (overlay colour, gradient stops).

## Per-kind registration (see f4-constraints.md for the exact surface)
postEffects.ts (interface + PostEffect union + POST_EFFECT_DEFAULTS + passX + applyPasses case +
PASS_TYPES/CHAIN_TYPES + POST_FX_PARAM_CLAMP) · effectStack.ts (EFFECT_ORDER pixel-region slot +
EFFECT_LABELS) · CompositorModal.vue inspector card + effect-row icon · agent hint (Task 8).

## Guarantees
- No new effect on a layer ⇒ byte-identical to HEAD (real-canvas A/B on paint-path changes).
- Outward-growing kinds fold their reach into the offscreen pad (0 when absent).
- Deterministic; no dead controls; sentence-case copy; own-hunks staging on the shared files.
