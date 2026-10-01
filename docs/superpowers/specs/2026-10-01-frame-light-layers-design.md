# Frame light layers — design

**Date:** 2026-10-01
**Status:** approved in conversation, section by section (Julien, 2026-09-30 / 10-01)
**Prototype:** artifact `Fw3HS51Ddc5Rti85iojbhV` ("Frame Light Layers"), source in the session scratchpad `lightproto/light-layer.html`
**Builds on:** `docs/superpowers/specs/2026-09-30-relight-layer-effect-design.md` (Relight stages 1–3, landed) and the print-finishes Frame light (`frontend/app/lib/compositor/frameLight.ts`)

## In plain words

A Frame can now have **lights**: real elements you add from the toolbar, see as glowing dots, drag, colour and animate. Three kinds — **Lamp** (a glowing point that fades with distance), **Spot** (a lamp with a cone you aim) and **Sun** (light from one direction, no fade, long even shadows).

Lights reach every layer in the Frame — photos, text, shapes, the background, foil — unless you say otherwise. Each layer has two switches, shown as two small toggles on its row:

- **Lit by lights** — off keeps the layer flat whatever the lights do (a logo, a price).
- **Casts shadows** — the layer floats a little above what is beneath it (its **Lift**) and casts a soft shadow from every light.

The Frame gets a **Darkness** dial: at 0 the lights only add light; at 100% the Frame is a dark room where only your lights show. It starts at 45%.

A photo with **Relight** takes the light properly — its own shape (depth, surfaces) catches it, and **Finish** turns the result into a realistic photograph — but the lights themselves now belong to the Frame, not to the effect.

A Frame with no light looks exactly as it does today.

## Where it comes from

- Today there are two separate light systems: one hidden light per Frame (position + height, used only by Foil and Spot UV) and Relight's own one-to-three lights per photo effect. Neither is something you can see, select or animate.
- After Effects and Apple Motion do this with Light layers and per-layer "Accepts lights / Casts shadows" — but only for 3D layers with a camera. Photoshop's Relight beta lights one image; Figma has per-layer drop shadows and an AI shadow generator; Canva has neither. Sailor's version works on a flat 2D Frame (Lift instead of 3D), lights photos by their real shape, and lights text, shapes, photos and print finishes from one shared set of lights.
- After Effects users complain that shadows start off; Sailor starts them on for text and shapes.

## The decisions (Julien's)

| Question | Choice |
|---|---|
| What does a light reach? | Every layer, each with a **Lit by lights** switch (option 3) |
| Which kinds? | **Lamp, Spot, Sun** (glow/area light later) |
| Relight's own lights? | **Go away** — Relight keeps how the photo takes light; the lights come from the Frame. Adding Relight to a Frame with no light **also adds a light** |
| What happens to unlit areas? | A Frame **Darkness** dial, starting in the middle |
| Shadows | A matching **Casts shadows** toggle on every layer row, beside the bulb |
| Where is Darkness? | In **every light's inspector** ("All lights" group) and in the Frame card while the Frame has a light |

## 1. What a Light layer is

- A new local layer kind `light` with `light: { kind: 'lamp' | 'spot' | 'sun', height, color, brightness, reach, aim?: {x, y}, cone?, edge? }`. Position is the layer's own `x`/`y` (fractions of the Frame, allowed up to half a Frame past an edge). For a sun, the dot sits where the light comes from and the light travels toward the Frame's centre; `height` sets how low it is (low = long shadows).
- Added from the toolbar's **+ Light** (Lamp / Spot / Sun). At most **6 lights** per Frame (a GPU budget); the add button greys out with a tooltip at 6.
- Lights list **at the top of the layer panel** with a glowing swatch of their colour. They are never drawn themselves; in the editor each shows as a glowing dot you drag, a spot also has a dashed aim ring joined by a line, a sun a dashed line toward the centre. Dots never appear in Render, video, web export or the canvas card.
- Light inspector: Lamp / Spot / Sun segmented control, Colour (swatches + any colour), Brightness, Height, Reach (lamp and spot), Cone and Edge (spot), Delete; at the bottom an **All lights** group with **Darkness** (tooltip: applies to the whole Frame).
- Every other layer gains `lit?: boolean` (absent = on) and `castsShadow?: boolean` + `lift?: number`. Defaults: text and shapes cast (lift ~4.5% of the Frame width), photos and wired layers don't (lift 3% when switched on), the background has Lit only. The layer row shows two toggles (shadow, bulb); the inspector shows **Lit by lights** and **Casts shadows** switches and, while casting, **Lift**. Copy: sentence case; explanations only in tooltips.
- The Frame stores `darkness` (default 0.45, stored only once a light exists). The Frame card shows Darkness only while the Frame has a light.
- **No light ⇒ byte-identical**: with zero light layers the switches, lifts and darkness change nothing, and nothing is written to a Frame until the user edits — every saved Frame renders exactly as today.

## 2. How what exists moves onto the lights

- **Foil and Spot UV.** With no light layer they keep today's hidden light, presets and handle, pixel for pixel. Once a light layer exists they are lit by the light list (all lights, with colour); their panel's Light row reads "Lit by the Frame's lights" and selects the first light on click. The hidden light retires quietly.
- **Relight on a photo.** The effect's own lights go. Its panel keeps Original light, Depth, Texture, Shine, Shadows, Read shape and Finish. Adding Relight to a Frame with no light also adds a Lamp in the Golden key position. **Setups** (Window, Golden key, Neon, Under, Rim) replace the Frame's lights with that arrangement as one undo step; its light chips become shortcuts that select those light layers.
- **Frames that already carry Relight lights** (made since 2026-09-30): on open, each effect's lights become light layers, and every other layer is set to Lit off and Casts off so the layout looks as before — only the photo responds. The photo itself looks slightly different (the shared lighting model). More than 6 lights across several photos: the extras are dropped and a one-time note says so.
- **Finish** sends the photo as lit by the Frame's lights; model, price, bar and undo are unchanged.
- The parked Relight canvas node is untouched.

## 3. How it is drawn

- **One lighting step for the whole Frame.** While `paintLayerStack` paints bottom to top it also fills three Frame-sized maps: **lit** (from each layer's switch, by its silhouette), **lift** (stacked lifts add up, by silhouette, for casting layers only) and **facing** (normals: flat for text and shapes; a Relight photo contributes its depth-derived and MoGe-2 surfaces through its crop, scaled by its Depth/Texture). Then one WebGL2 pass lights the composed picture: per pixel, ambient `1 − darkness·0.92` plus each light's colour × brightness × falloff (lamp/spot) × cone (spot) × facing, with a screen-space shadow walk toward each light over the lift map (soft, jittered), and a small shine highlight where a layer has shine. Unlit pixels pass through unchanged. Post-processing runs after it.
- **Speed.** Moving a light or a dial re-runs only the pass (milliseconds — instant drag). The maps rebuild only when layers change. Measured budget to set in the plan (target: the pass under ~4 ms at a 1080×1350 Frame on a retina editor).
- **Everywhere the same.** It lives in the shared Frame painter, so editor, canvas card, Render, video and web export match (the web export carries the pass).
- **Relight becomes a supplier**: it applies Original light (flattening the photo's baked light) to its own pixels and hands depth/surfaces to the maps; its own GPU lighting pass is retired once stage 2 lands.
- **Foil and Spot UV** finish shaders read the light list instead of the single light.
- **Motion.** Light position, height, colour, brightness, reach, aim and cone, the Frame's Darkness and every layer's Lift are Motion properties — animated in the Motion tab like anything else.
- **No GPU.** Without WebGL2 the Frame draws as today, unlit, with a small note in the editor ("Lights need graphics acceleration").

## 4. Build order, testing, out of scope

**Stages** (each usable on its own):

1. **Lights for text, shapes and backgrounds** — the light layer, dots and inspector, the two switches + Lift, Darkness, the lighting step; editor, card, Render, video, web export. Photos lit flat.
2. **Photos** — Relight as a supplier; Relight setups and adding Relight create light layers; today's Relight Frames convert; Finish uses the Frame's lights.
3. **Print finishes** — Foil and Spot UV lit by the light list; the hidden light retires.
4. **Motion and the assistant** — every light dial, Darkness and Lift as Motion properties; the assistant learns lights ("add a warm lamp top left", "make it night").

**Testing:** a Frame with no light renders byte-identical to today (the headline check); pixel checks — a light on the left brightens the left, a shadow falls away from the light, a layer with Lit off is unchanged, Darkness 0 never darkens; real-editor browser tests for drag, undo and the switches; a frame-time budget while dragging a light; conversion of a stage-1–3 Relight Frame.

**Out of scope (later):** an ambient (fill) light and glow/area lights (softbox, neon shapes); coloured shadows through tinted layers; 3D Studio's own lights (stay separate); lights shared across Frames; per-light "only these layers" linking.

## Open for the plan

- Exact lift units (fraction of Frame width) and the shadow walk's step budget — tune against the prototype's look (prototype: headline 4.5%, sticker 3.5%, photo 3%).
- How a group's switches cascade (proposal: a group's Lit/Casts act on its members, like visibility).
- Whether a light can be masked or blended (proposal: no — lights have no blend, mask or effects).
