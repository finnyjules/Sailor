# Relight: drag lights over a photo

Date: 2026-09-30 · Status: design approved in chat, spec awaiting review

**Reference mockup:** https://claude.ai/artifact/7rAD2Mu5a2S5d34kHU42iy ("Relight in Frame", v3). It is the
target for layout, controls and presets.
**Reference prototype:** `frontend/app/pages/dev/relight.vue` (uncommitted, `/dev/relight?img=<input file>`). It is
the target for the shader. Its constants are the starting values for the real pass.

## In plain words

- **What it is.** You add *Relight* to a photo layer in the Frame editor. Glowing dots appear on the photo. Drag
  them and the photo's lighting changes as you move, with no waiting. Each dot is a light with a colour, a
  brightness, a height and a reach.
- **Why it feels instant.** No AI runs while you drag. Sailor works out the photo's shape once, when the effect is
  added (about 8 seconds and about half a cent; up to about 3 minutes the first time after a quiet spell, while
  the provider wakes up, with the photo already lit from a free local shape meanwhile). After that, ordinary graphics code lights that shape 60 times a
  second on your own machine.
- **Finish.** The live version can't cast real shadows onto the floor, and it can't fully remove the photo's old
  lighting. *Finish* sends the photo plus the live version to Nano Banana 2, which returns a realistic picture in
  about 14 seconds for $0.08. You then keep it, try again, or go back to your lights.
- **Why it's an effect.** Like other effects it never changes the photo itself. You can come back and move the
  lights at any time, and it renders wherever the Frame renders. Finish is the one step that replaces pixels, so
  it is an edit, not an effect.
- **What's risky.** The shape step costs money on every new photo, so hosted Sailor needs it priced and metered.
  The live look depends on the shape model: good on people, animals and objects, weaker on flat graphics.
  Server-side Frame renders don't run effects today, so a relit layer renders unlit there.
- **The old Relight node** on the canvas is **parked**: left exactly as it is. A new node that shares this
  engine is designed below but not scheduled.

## What we are building

1. A **Relight** layer effect in the Frame editor, with live, draggable lights.
2. **Finish**, which bakes a realistic version with Nano Banana 2.
3. One shared relight engine (settings, presets, shader, shape step, Finish call) that a future node can reuse.

## How it works for the user

### Adding it

- **Effects menu.** *Relight* is an entry in an image layer's effect list (the + menu). It appears as a row under
  the layer in the left panel, with the usual eye, duplicate and delete. At most one per layer.
- **Right-click shortcut.** Right-click an image layer → *Relight…* (between *Edit an area…* and
  *Select an object…*). If the layer has no Relight effect, this adds one and selects it. If it has one, it selects
  it.
- Relight is offered on **image layers only**, including wired image layers (parity rule). Text and shapes have no
  photographic lighting to change.

### Working with lights

When the Relight row is selected:

- **Light dots** appear over the layer on the canvas (the mockup's handles). Drag to move. They may sit up to 40%
  past the layer's edges, since a light can be outside the picture. Scroll over a dot to raise or lower it. A
  dashed ring means the light is behind the subject (rim light). Double-click the layer to add a light. Up to
  **three** lights. Each drag is one undo step.
- The rest of the Frame dims slightly, as in the mockup, so the layer being lit is clear.
- **Compare**: hold to see the photo without the effect.
- While the shape step runs, the layer lights from Sailor's local depth estimate and shows a small
  *Reading shape* pulse. The better shape swaps in when it arrives.

### The settings panel

Top to bottom, as in the mockup:

| Group | Controls |
|---|---|
| Setups | Window, Golden key, Rim, Neon, Under (one-click buttons; the active one is highlighted and un-highlights as soon as anything changes) |
| Lights | A chip per light, plus an add button |
| Selected light | On/off, remove, colour (Warm, Tungsten, Daylight, Blue hour, Magenta, Cyan, any colour), Brightness, Height, Reach, *Use Frame light* (Light 1 only, see below) |
| Photo | Original light, Depth, Texture, Shine, Shadows |

Labels follow the house copy rules: sentence case, no identifiers, explanations as tooltips only.

What the photo controls mean (tooltip text drafts):

- **Original light**: how much of the photo's own lighting stays as the room's base level.
- **Depth**: how strongly the photo's shape bends the light.
- **Texture**: how much fine relief comes from the photo itself (fur, pores, knit).
- **Shine**: glossy highlights. Default off; on by default it made everything look like plastic.
- **Shadows**: short contact shadows (hair on skin, chin on neck, folds). Default on.

### Sharing the Frame light

The Frame already has one light (`sailor_localLight`, from print finishes), which lights gold foil and spot UV and
will get the *Shine* move and pointer-follow. With **Use Frame light** on, Relight's Light 1 *is* that light: moving
either moves both, and a Shine sweep crosses the photo and the foil together. Off by default. Height maps across
(Frame light 0–1 to Relight 0–1; Relight's "behind" range is unavailable while linked).

### Finish

- A **Finish** button on the Relight effect. Its tooltip gives the price and time: *About 14 s · $0.08*. It goes
  through the normal cost-confirm step.
- While it runs, the lights hide and the layer shows a soft sweep.
- The result lands in the existing edit-result bar under the layer: **Undo** (back to your lights),
  **Try again** (always from the original photo, never compounding), **Keep**.
- **Keep** replaces the layer's image with the finished picture and **removes the Relight row** (its lighting is
  now in the pixels). Global undo restores both.

### Motion

The light dials (position, height, brightness, colour) are animatable like other effect dials, and are authored
only in the Motion tab (house rule). A moving light re-renders live; Finish is for stills and is not animated.

### Exports

- **PNG / Render / video**: the effect renders live, like other GPU effects.
- **Web exports**: pre-rendered in this plan, like depth of field. A live, interactive relight in web exports is
  out of scope.

## How it works inside

### The shared engine: `lib/relight/`

One module both the effect and a future node use:

- `settings.ts`: the stored shape and its sanitizer.
  `RelightSettings = { lights: RelightLight[] (≤3), keep, depth, texture, shine, shadows, useFrameLight }`,
  `RelightLight = { id, x, y, height, color, brightness, reach, on }`. Positions are fractions of the **layer**,
  −0.4…1.4. Height −0.3…1 (below 0 = behind).
- `presets.ts`: the five setups, values from the mockup (`SETUPS`).
- `shader.ts`: the fragment shader, ported from the prototype (see *Shader* below).
- `surfaces.ts`: fetching and caching the shape maps (below).
- `finish.ts`: builds the Finish request (original + guide render + prompt) and hands it to the runner.

### Shape maps

Two maps per source image, both cached by content hash in `input/sailor_depth/` (so the same photo in two
Frames is paid for once):

1. **Depth**: the existing local `POST /api/depth/estimate` (Depth Anything V2 Small, the only Apache-licensed
   size; Base and Large are CC-BY-NC). Free, about 1 s. Used for falloff, shadows, and as the first-look shape.
   Reuse `depthRegistry.ts` as depth of field does.
2. **Surfaces (normals)**: MoGe-2 on fal (`fal-ai/moge-2`, `vitl-normal`, MIT). About $0.005. Send
   `export_glb:false, export_ply:false` (they default on and are not used). The returned normal PNG is red = right,
   green = up, blue = toward camera. Its depth output is a coloured preview, not data, so it is not used.
   **Timing, measured 2026-09-30:** warm 7.7 s (1.1 s queue + 6.2 s work); **cold 203 s** (194 s waiting for the
   provider to start + 9.4 s work). The endpoint is rarely used, so it goes cold between sessions. The design
   never waits on it: the effect lights from local depth at once and swaps the surfaces in whenever they land,
   with no timeout. The call keeps running if the user leaves Relight, so the result is cached for next time.

The prototype's dev-only route `server/api/depth/moge-normals.post.ts` (local fal key, no ledger hold) becomes a
real runner family (below) and is then deleted.

### The effect kind

- `relight` joins the effect stack as a **pinned GPU kind**, placed right after `dof` in `EFFECT_ORDER`, for the
  same structural reason as `dof`: its maps must line up with the layer's own pixels, before the layer is moved,
  scaled or rotated into the Frame. Add it to `PINNED_KINDS` and `GPU_TYPES` (`postEffects.ts`), and to both
  unions (`PostEffect` and `LayerEffect`; the depth-of-field work found the second one the hard way).
- Stored on the layer's effect entry as `RelightSettings` plus the two map filenames. Read through the existing
  `effectStackOf` path (no migration).
- While its row is selected, the canvas shows the light handles, built on the Distort corner-pin handle pattern
  as the Frame light's handle is.

### Shader

Port the prototype's final fragment shader. The lessons it cost:

- **8-bit depth makes contour stripes**: read it into floats, bilateral-smooth it (edges kept), store as R16F.
- **Depth coarser than the photo makes stair-steps**: rebuild it at photo resolution with a joint-bilateral pass
  guided by the photo's colours. It renders into a framebuffer, so take uv from `gl_FragCoord`; `vUv` is flipped
  there (this bug shipped once in the prototype, drawing the figure upside down).
- **Depth jumps light up as outlines**: on a cliff, borrow the slope from a few texels away on the pixel's own
  side, and flatten only thin slivers.
- **Long cast shadows are wrong**: a depth map can't say where the wall is. Contact shadows only (6% of the
  layer), and skip occluders far in front of the pixel.
- **Texture** adds the photo's luminance slope to the normal. **Shine** default 0.
- Lighting in linear light, a soft shoulder instead of clipping, then back to sRGB.

The prototype's defaults: Original light 0.35 (the Golden key setup uses 0.12), Depth 4, Texture 2, Shine 0,
Shadows on. Measured about 5 ms a frame at 1024² with two lights and shadows.

### Finish

- A new runner family (off until priced), calling `fal-ai/nano-banana-2/edit` with
  `image_urls: [original, guide]`, `resolution: '1K'`, and the prompt used in the 2026-09-29 bake-off:

  > Relight image 1 so its lighting matches image 2: the same light direction, colour, intensity and falloff.
  > Image 2 is only a rough lighting preview — take nothing but the lighting from it. Remove image 1's original
  > lighting where it conflicts, and add physically correct shading, bounce light and shadows. Cast shadows may
  > only fall on surfaces already visible in image 1, such as a floor or a wall; never add new walls, floors,
  > objects or scenery, and if the background is a flat colour, keep it flat. Keep image 1's medium and style
  > (an illustration stays an illustration), and keep the subject, composition, framing, textures and every
  > detail of image 1 exactly the same.

  (Revised 2026-09-30 after the paid check: the bake-off wording asked for "cast shadows on the floor or
  background", and on a flat illustration the model invented a wall to cast them on. Checked on the same two
  pairs: the illustration's background stays flat; the puppy keeps its floor shadow — one of two puppy draws
  lit from the wrong side, the other matched the guide.)

- The **guide** is the effect's current render of the layer at the source image's resolution (capped at 1536 px),
  uploaded first.
- Result handling reuses the Edit-image pending-result machinery (`editResult`, revert / re-roll / validate),
  reading from the original every time.

### Money and hosting

- Two runner families, both **off** until priced and given a live check: *relight surfaces* (MoGe-2, about
  $0.005 per new photo) and *relight finish* (Nano Banana 2, $0.08).
- Both go through the ledger hold and cost-confirm like other paid calls. **Surfaces shows its cost every time a
  photo gets Relight** (user decision 2026-09-30), except when the photo's surfaces are already cached, which is
  free.
- If surfaces are refused (unpriced, no balance), the effect still works on the free local depth shape, just
  less well. It never blocks.

## The node (designed, not scheduled)

- A future **Relight** studio node reusing `lib/relight/`: opening it shows the same lights-on-the-photo editor;
  the card shows the live result; the output is the rendered picture, baked in the browser the way shader studio
  nodes are baked; a **Finish** switch makes a run go through Nano Banana 2 instead, with the cost badge.
- Limit: the free live output needs a browser (WebGL), so headless or hosted batch runs can't make it. Finish can.
- **The existing Relight node is parked**: untouched, still running its current prompt-from-dial behaviour. Whether
  the new node replaces it, or both exist under different names, is decided when the node is scheduled.

## Stages

1. **Engine + live effect.** `lib/relight/`, the `relight` effect kind, handles, panel, presets, local depth only.
   Free. Checked against the prototype's renders.
2. **Surfaces.** The MoGe-2 runner family (off), caching, the *Reading shape* swap, the paid live check (a few
   cents, user go).
3. **Finish.** The Nano Banana 2 runner family (off), guide upload, result bar, Keep removes the row. Paid live
   check (about $0.30, user go).
4. **Frame light link.** *Use Frame light*, and Motion dials.
5. **Node.** Parked.

## Out of scope

- Removing the photo's original lighting in the *live* preview (an intrinsic-decomposition model such as
  Marigold-IID Lighting, OpenRAIL++; not hosted on fal). Revisit only if the live look needs it.
- Real cast shadows onto the floor in the live preview (needs full 3D from MoGe's point cloud, which is the slow
  export, or self-hosting MoGe).
- A live, interactive relight in web exports.
- Relighting text or shape layers.

## Open questions

- **Cold starts.** If three minutes for the better shape proves too long in use, two options, both costlier:
  warm MoGe-2 up when a Frame with a photo opens (one paid call per session, only helps if Relight follows soon),
  or run MoGe-2 ourselves on an always-on server (hourly cost). Check first whether fal bills the cold-start wait.

## Decided in review (2026-09-30)

- Surfaces shows its price every time a photo gets Relight.
- Texture's default stays at 2.
- MoGe-2 cold start measured at about 3 minutes; handled by never waiting on it (above).
