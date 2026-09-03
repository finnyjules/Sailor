# 3D Studio — shape library shelf — design

Date: 2026-09-02
Status: Approved (decided in-session, Julien asleep; the four-consumer order was agreed earlier), implementing
Sub-project 4 of 5 of the shape library. Predecessors: foundation + Expressive separator, Compositor layers, Shape Studio base shape (all landed 2026-09-02).

## Plain-language summary

3D Studio can already extrude any SVG into solids (the SVG import: one object per path, held in a group). The shape library shelf is the same move with no file: the primitives menu gets a **"Shape library…"** row that opens the shared picker, and the picked shape lands as an extruded solid through the exact SVG-import path, so every material, modifier, motion and export the studio has applies from the first click. The drawing's own colour seeds the material, the one place the library's `sourceColor` hint is worth spending.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Insert path | Build a one-path SVG string from the manifest and hand it to the existing `importSvgSource(svg, name)` | Reuses parsing, normalisation (`targetWidth 1.5`), stroke outlining, naming, grouping and selection unchanged. Zero new geometry code. |
| Material colour | The SVG carries `fill="<sourceColor>"`, which the importer already reads as the seed colour | The one legitimate use of the hint: a 3D solid needs *some* starting colour and the drawing's is better than a default. |
| Menu placement | A "Library" group at the end of the primitives menu with one full-width row | The row is an action (open the picker), not a `PrimitiveKind`, so it cannot be a face; the last-used face keeps working for real primitives. |
| Escape | The surface's window-capture `onKey` returns early while the library picker is open, before the menu/deselect branches | The surface's handler runs BEFORE the picker's (registered earlier), so a flag check is sound here — the opposite of the Compositor, where the picker ran first. |
| Agent | Not in this sub-project | The 3D agent's `primitive` macro is keyed by `PrimitiveKind`; a library-shape macro is a separate seam (`addOrTargetPrimitive` cannot take a path). Logged as owed. |

## Architecture

- `frontend/app/lib/shapes/svg.ts` (new, pure): `shapeToSvg(shape, opts?: { fill?: string }): string` → `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96"><path d="…" fill="…" fill-rule="…"/></svg>`; fill defaults to `shape.sourceColor`.
- `Scene3DStudioSurface.vue`: `libraryPickerOpen`, `libraryPickerAnchor`, `primClusterRef`; `openLibraryPicker()` (closes the primitives menu, anchors above the cluster); `onLibraryPick(id)` → `importSvgSource(shapeToSvg(shape), shape.name)`; `closeAddMenus()` also clears `libraryPickerOpen`; the primitives menu gains a "Library" group with a "Shape library…" row (lucide `Shapes` icon); `<ShapePicker allowNone=false :ignore="primClusterRef">` mounted in the cluster; `onKey` Escape branch starts with `if (libraryPickerOpen.value) return`.

## What stays identical

SVG file/paste import, all primitives, faces, menus, the agent.

## Testing

- `shapes-svg.unit.spec.ts` — string contains the viewBox, the path data verbatim, the fill-rule, the source colour by default and an override when given; a real manifest shape round-trips (`shapeById('sparkle')`).
- `scene3d-svg-import.unit.spec.ts` (extend) — `buildSvgObjects([leaf(shape.d, shape.sourceColor)], [], { name: shape.name })` → group named `Sparkle`, one `svgPath` child whose content `d` equals the shape's `d`, colour seeded from `sourceColor`.
- Live: 3D Studio → primitives ▾ → Shape library… → Sparkle: an extruded sparkle appears, selected, in the drawing's colour; Escape inside the picker leaves the studio open; a second pick adds another solid.

## Owed

Agent path for library shapes in 3D (`"add a 3D sparkle"`), and the Render footer bake with a library solid.
