# Start modal rethink — design

Date: 2026-09-23 · Status: approved in chat, building
Prototype (the visual reference): https://claude.ai/artifact/XRHvdXrY4GmQ1DzyCHP5r9 — layout A

## Why

The modal that opens on a blank project looked generic (grey icon tiles and model names, nothing
visual) and carried the wrong things (audio and Shot Director, which aren't ready, next to the
studios, which were demoted to a small "craft it by hand" strip). Frame — where most work ends
up — was not part of it at all.

## What changes

1. **Layout A — two equal halves.** "Make it with AI" on the left, "Make it by hand" on the right,
   same width and same height. Every tile is a picture with its caption over it.
2. **Every project gets a Frame.** Whatever you pick lands wired into a 1024 × 1024 Frame
   (a `Compositor` node). Skipping gives you just the Frame.
3. **Tiles show real pictures.** Studio tiles draw a still with the studio's own renderer;
   AI tiles show pictures made once with the real models and shipped with the app.

## Lineup

The modal has its own list, separate from the toolbar's Studios door (which keeps Shot Director
and Lip-Sync). Anything not listed stays reachable from the + menu and the Studios door.

**Make it with AI** (wide first tile, then 2 × 2)

| Tile | Caption line | Node |
|---|---|---|
| Generate an image | Describe it, pick a model | `GenerateImageNode` |
| An image in a style | Your prompt, a chosen look | `FluxLoRARemoteNode` |
| Edit an image | Change it in words | `EditImageNode` (source: image) |
| Upscale an image | Sharper, up to 4× | `UpscaleImageNode` |
| Generate a video | From words or a picture | `GenerateVideoNode` |

**Make it by hand** (2 columns × 4 rows)

| Tile | Caption line | Node |
|---|---|---|
| Expressive | Type that moves | `SpaceType` (only when `SPACE_TYPE_ENABLED`) |
| Gradient | Soft colour fields | `GradientStudio` |
| Shader | Live, animated surfaces | `ShaderStudio` |
| Pattern | Repeats and terrazzo | `TextureStudio` |
| Shape | Marks built from copies | `ShapeStudio` |
| Vector type | Letters you can stretch | `VectorType` |
| 3D | A lit scene with objects | `Scene3DStudio` |
| Moodboard | Collect your references | `Moodboard` |

If Expressive is disabled, the hand grid shows 7 tiles and the last row keeps one empty cell
rather than stretching a tile.

Removed from the modal: Generate speech, Generate music, Sync lips to audio, Generate a 3D model,
Shot Director, Lip-Sync. `modalHero()` and `MODAL_HERO_CAPS` retire (only the modal used them;
`HERO_BY_DOMAIN` stays — `GeneratorsPanel` uses it).

## What each pick puts on the canvas

One helper on the canvas, `materializeStart(pick)`, replaces `materializeStartGraph` and
`materializeImageShowcase` (the 2 × 2 sticky-note tour retires). It always creates the Frame,
then the pick's nodes to its left, then the wires, then fits the view to all of them.

| Pick | Canvas |
|---|---|
| Generate an image · An image in a style · Upscale an image | generator → Frame `layer1` |
| Edit an image | Image card → Edit → Frame `layer1` |
| Generate a video | video generator, Frame beside it, **not wired** (the Frame has no video input) |
| Gradient · Pattern · Shape · Vector type · Expressive · 3D | studio → Frame `layer1` |
| Shader | starter picture (Image card with a bundled sample) → Shader → Frame `layer1` |
| Moodboard | Moodboard `style` → Generate an image → Frame `layer1` |
| Skip / close / Esc | the Frame alone |

- Upscale lands without a source card, same as today's single-node picks.
- Studios whose output is the wildcard `*` wire into `layer1` (`typesCompatible('*','IMAGE')` is
  already true). `Scene3DStudio` wires its `beauty` output.
- **Live Frame sources:** a studio → Frame wire only paints if the studio registers a frame source
  (`lib/geoshape/frameSource.ts`). Gradient, Vector type, Expressive, 3D and Shape already do.
  Shader and Pattern must be made to register one as part of this work, or their Frames stay
  empty until a run.
- Failure paths keep today's behaviour: a missing node type in object_info or a canvas that never
  mounts shows the existing toasts; nothing is silently dropped.

## Tile pictures

**Studio tiles** render a still when the modal opens, through the same renderer and the same
default settings a fresh node of that studio starts with — so the tile shows what you'll get.

| Studio | Render path |
|---|---|
| Gradient | `gradientFx.render(defaultConfig(), w, h, t)` |
| Pattern | `textureFx.render(textureDefaults(), w, h, t)` (+ the card's sheet step if needed for parity) |
| Shader | `shaderFx` passes over the bundled starter picture |
| Shape | `renderStudio(doc)` → `drawToCanvas` (2D) |
| Vector type | `loadVectorFont(DEFAULT_FONT_ID)` → `drawVectorTypeToCanvas` |
| 3D | headless `SceneEngine` still, using the node's default scene |
| Expressive | `SpaceTypeEngine` on the tile canvas |
| Moodboard | a static collage made from bundled reference pictures |

- Stills render once, in parallel, on open; each tile shows a quiet placeholder until its own still
  lands.
- Hover plays the tile where the renderer is synchronous and takes a time value (Gradient,
  Pattern, Vector type, Expressive). One shared rAF loop runs only while a tile is hovered and the
  modal is visible; it stops on leave and on close.
- If a still fails (no WebGL, a font that won't load, an empty default scene), the tile keeps its
  placeholder and the error is logged with the studio name. No fake picture stands in for a failure.
- A studio whose default setting renders nothing useful (e.g. an empty 3D scene) gets a starter
  preset that the tile AND the new node both use, so the two never disagree.

**AI tiles** show five pictures under `frontend/public/start-modal/`, made once with the real
models (about five paid runs — ask the owner before running them). Video shows a still with a
play mark; Edit and Upscale show a before/after split. Until the real pictures exist the tiles use
the placeholder, never the prototype's drawn stand-ins.

## Copy

Sentence case, no node or model identifiers on tiles. Title "What do you want to make?"; subline
"Whatever you pick lands in a Frame, ready to lay out."; footer "Start with an empty Frame" plus a
small pastel dot with "Uses credits" (AI tiles carry the dot).

## Wiring in the layout

`StartProjectModal` emits one event, `start`, with a pick id (or `null` for skip). `layouts/default.vue`
keeps its tab-binding logic and forwards the pick to `canvas.materializeStart(pick)` after
`refreshSchema()`. Skip now also calls `materializeStart(null)` so the empty Frame exists.
The homepage "Create an image" path (`seedNodeType`) is unchanged.

## Testing

- Unit: the pick → nodes/edges table above, as a pure planner (`planStart(pick)` returns node types,
  relative positions and edges) so it is testable without a canvas.
- Unit: the modal list and `STUDIO_OPTIONS` are independent — the Studios door still lists Shot
  Director and Lip-Sync; the modal lists neither.
- Unit: the modal renders 5 AI tiles and 8 (or 7) hand tiles; skip emits `null`.
- Browser pass on the real app: open a blank project, pick each tile, confirm the Frame shows the
  studio's picture (Shader and Pattern included), confirm Skip leaves one empty Frame, confirm hover
  plays and stops.

## Out of scope

Curated per-studio starting looks beyond the empty-scene case; a Frame format picker on the modal;
changes to the homepage start cards; audio and 3D-model generation readiness.
