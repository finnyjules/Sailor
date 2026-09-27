# Node design: one look for every canvas node

**Date:** 2026-09-27 · **Status:** designed with Julien through seven clickable prototypes; build not started.
**Prototype:** `docs/superpowers/specs/assets/2026-09-27-node-design-prototype.html` (the seventh pass; its pictures load only
from the brainstorm session folder `.superpowers/brainstorm/36164-1790494516/content/`, so open it there to see them).
Its switches still offer the options that were turned down (and its Frame glass still has the old top highlight line); where
the prototype and this spec differ, **this spec wins**.

## Why

The canvas nodes were tuned one at a time for months and now look like 25 different products. Each of the ~25 node
components draws its own frame, header, edges and run bar; only the port and (on four nodes) the run row are shared.
The Generate node shows the result: four greys stacked inside one card, a bright empty prompt box as the loudest thing on
it, a header so full the title is cut to "Generate an imag…", the price shown twice, and unnamed half-circles for inputs.

This spec gives every node one of a small number of shared looks, built as shared shells, so the look can't drift again.

## What stays exactly as it is

Julien likes these; the build must not change them:

- **Selection, running and failed states** of nodes (the current outline, the running treatment, the failure look).
- **Wires** (the connections between nodes).
- **The Note node.**

## The families

| Family | What it is | Nodes |
|---|---|---|
| **Content card** | The content *is* the card. Flora-like: name above, controls only on hover. | Image, Video, Audio, Text (incl. the result cards generators make), 3D model, Collection, Moodboard, Character, Reference, Batch pile, Sketch pile |
| **Instrument** | Everything visible and calm: prompt well, settings rows, Run with its price. | Every generator and action (Generate image / video / audio, Upscale, Edit, Remove background, all nodes drawn by `ComfyNode.vue`), Gate, **Shader effect**, Subgraph in/out |
| **Studio** | Looks like an instrument, but is *opened* to be worked on. Preview only. | Gradient, Shader, Texture, Shape, Space Type, Vector Type, 3D Studio, Pose Mannequin, Smart Layout, Shot Director, Lip-sync |
| **Print** | The main thing you are building. | **Frame**, **Timeline** |
| Unchanged | | Note |

## Rules every node follows

**One surface, one edge.**
- One fill per node. No boxes inside boxes: zones are separated by space or a hairline, never by a different grey.
- One even 1px border all the way round, and nothing else along the edge: no inner highlight line, no gradient fill
  inside a shell. (Both were tried. A top highlight doubles the top edge; a fill that is lighter at the top makes the
  same border read as a dark seam there and a light line on the sides.)
- Borders stay one *screen* pixel at every zoom (thickness divided by the canvas zoom), and stay low-contrast, so the
  unavoidable half-pixel rounding at odd zoom levels is hard to see.

**Header.** Icon + title. Actions (lock, all settings, more) appear only on hover or while selected, so the title is never cut
short by icons.

**Type.** PP Neue Montreal. Node text is **Medium (500)**; titles are **Semibold (600)**; buttons Semibold with the price in
Medium. Text that is the user's own content (a Text card's words) keeps its own weight, not the node default.

**Price shown once**, on the Run button: "Run $0.03", "Run again $0.03".

**Inputs and outputs** (one change, in `NodePort.vue`, so every node gets it):
- The dot sits *behind* the node: its centre is on the node's edge and the node is drawn over it, so half a dot peeks
  out. Wires run under the node to meet it.
- No names at rest. Hovering one dot grows it (10px → 16px), fills it with its colour, slides it ~5px out from under the
  edge, shows **that dot's name only**, and lights its wires.
- The hover area is only the half outside the node, so pointing inside a node never catches a port.
- Colours stay the app's own type colours (`getTypeColor`).
- If the resting half-dots prove too easy to miss, make the resting dot a little larger (12–14px). Don't add anything else.

## Instrument

- **Dark glass shell:** 14px corners, border white 10%, fill `rgba(26,26,28,.58)` with a background blur (18px, saturation 1.4),
  soft drop shadow.
- **Blur only at rest.** While the canvas pans or zooms, swap to the no-blur version (same tint at `.86`, no blur) and
  bring the blur back when it stops. Blur behind dozens of nodes, recomputed every frame, is what would bring back pan lag.
- 8px inset inside the shell, so 14 − 8 = 6px corners on everything inside (the rule `StudioRow.vue` already follows).
- **Prompt well:** darker glass (`rgba(0,0,0,.35)`), 6px corners, 12px padding, at least 88px tall.
- **Settings rows are the studio row** (`StudioRow.vue`), so studio sliders, pickers and colours work on nodes as they do
  in studios:
  - **Quieter fills, everywhere** (studios too, in the one component): row fill 3% white at rest, 6.5% on hover or while
    dragging; the value band 10%, 16% while in use; labels 55%.
  - **A roomier size on nodes only:** 32px rows (studios' inspectors keep 28px), 11px side padding, 5px between rows,
    a little more space under the prompt well and above the footer.
- **Footer:** status on the left, the Run button (white) on the right. Running and failed look as they do today.

## Studio

- The instrument's dark glass shell and header.
- **Preview only:** the live preview sits in a well (6px corners). No settings rows on the node.
- **The Open bar rises on hover:** it slides up over the bottom of the preview on frosted glass, so the card never changes
  size, and stays up while the node is selected. Left: a short description (e.g. "3 colours · mesh"); right: **Open**.
- Double-click anywhere on the node opens the studio.
- A footer only when there is something to run (e.g. Pose Mannequin's Generate).
- Shot Director and Lip-sync have no picture: a short summary sits in the well (the scene's opening words; the voice and length).
- **Later, not in this spec:** promoting a studio control from inside the studio so it stays visible on its node.

## Content card

- The content is the card: 12px corners, no border (a faint inner edge only), a soft shadow.
- Name above the card (the file name, or the card's own text), quiet at rest, brighter on hover.
- Hover actions (download, more) float in the top-right corner on small dark-glass buttons.
- Collection shows a grid of its items; Moodboard and the piles show a loose stack with a count; Character shows the portrait;
  3D model stays orbitable.

## Print: Frame and Timeline

- **Thin light-glass edge:** an even 6px of frosted light glass around the artwork (8px outer corners, 3px on the artwork).
- **The glass takes its colour from the artwork itself:** the node's own picture, heavily blurred (~28px, saturation 1.6,
  ~75% opacity) behind a white veil. A blue poster gets blue glass. (Plain glass over the dark canvas reads as flat grey;
  there is nothing behind it to show.)
- The edge is one even ring (a single 1px inner line), no separate top highlight: the same rule as the shells.
- Name above ("Frame", Semibold) with the size beside it ("4:5 · 1080 × 1350", quiet, even-width numbers).
- No header, no footer. **Render** and **Open** live in the bar that rises over the bottom of the artwork on hover.
- Larger than other nodes by default (Frame 320px wide).
- Timeline: the same treatment; its preview is its clip strip.
- To watch: where the artwork is very saturated at the edge, the glass takes that colour strongly. Tune the blur and veil in
  the build; don't add a control for it.

## Result card (stage 6)

A generator's result becomes a **content card beside it** instead of growing the generator:
- **One result card per generator.** The first run creates it to the right, already wired. Later runs add takes to the same
  card; the card shows the chosen take, with its take strip under it.
- Wires to Frame and other nodes come **from the result card**, not from the generator.
- Pulling a take out of the strip makes it a separate card.
- If the result card is deleted, the next run makes a fresh one.
- Older projects wire generators straight into Frames and other nodes. When opened, a result card is slipped in between.
- Pose Mannequin already works this way (it creates an Image card on generate), so it is the precedent to follow.
- Julien leaned towards "a card beside it" ("but I could be wrong"); the one-card-per-generator rule above was proposed and
  not objected to. Confirm it with him before stage 6 is built.

## Build stages

Each stage ends with something to look at on the real canvas.

1. **Shells and ports.** The shared pieces: instrument/studio shell (with the blur that drops out during pan/zoom), content
   card, print surface, the comfortable row size and quieter fills in `StudioRow.vue`, and the new ports in `NodePort.vue`.
   Shown on a dev page first.
2. **Instruments.** `ComfyNode.vue` (the biggest, ~2,500 lines), then Gate, Shader effect, Subgraph in/out. Change the frame
   and template; leave the logic alone.
3. **Studios.** The nine studios, Pose Mannequin, Smart Layout, Shot Director, Lip-sync.
4. **Content cards.** Image, Video, Audio, Text, 3D model, Collection, Moodboard, Character, Reference, the piles.
5. **Frame and Timeline** on the print surface.
6. **Result card behaviour.** Held until the parallel session porting ComfyUI nodes to the Sailor runner has finished the node
   families it is on, because this stage changes how the graph runs (generators → result card → Frame), which is that
   session's territory. The runner already passes values through simple cards (step 3, R1), so it should hold; check first.

## Working alongside other sessions

- The runner porting session works almost entirely in `frontend/server/runner/`, `frontend/shared/` and tests; it does not
  touch node components. Ported nodes are drawn by `ComfyNode.vue`, so they pick up the instrument shell automatically.
- `ComfyNode.vue` is edited often by other sessions (run row, model line-up switches). Stage 2 commits only its own hunks
  with the private-index recipe.
- Ported nodes with unusual controls (masks, colour ranges, Painter) may need a row type the comfortable row can't show yet;
  stage 2 covers them.

## Not in this spec

- Promoting a studio control onto its node.
- Any change to selection, running or failed states, wires, or the Note node.
- The inspector panels (only the shared row's fills change there).
