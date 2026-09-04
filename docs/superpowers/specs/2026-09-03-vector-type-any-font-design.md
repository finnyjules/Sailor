# Vector Type — any font: the shared picker, Google cuts and library uploads

**Status:** designed 2026-09-03, approved by Julien in conversation (Sections 1 and 2). Plan follows.

## The ask

"I want our general font picker for Vector Type." Today the studio's Font row is a
select over ten curated variable families (`app/data/variable-fonts.ts`), because
Vector Type needs real outlines (fontkit), and the only place Google serves a
variable file is the fonts repo, one hand-verified path per family. That
constraint limits the *axes*, not the *families*. Every other studio picks fonts
through the shared `FontPicker` (Google catalog + the licensed library). Vector
Type should too, with the same reach: option A — Google catalog plus library
uploads. (Option C — promoting any Google family to variable by locating its file
in the fonts repo at runtime — is deliberately out.)

## Section 1 — what the user sees

- The **Font** row becomes the shared `FontPicker` in row mode (28 px, label
  left, family right, variable glyph for bindings), exactly the row Space Type
  draws. It searches the Google catalog (~1,900 families) and the library.
- The **ten curated variable families are pinned** at the top and badged `var`,
  because they are the only ones with live axes. Picking one behaves exactly as
  today: the Axes group appears with the family's sliders.
- Picking a **Google family** loads it as one static cut. A **Weight** select
  appears listing the cuts that family actually ships (from the catalog's
  `weights`), default 400 or the nearest. The Axes group hides (a static cut has
  no axes). Smart stretch, layers, motion, agent and export keep working — the
  stretch engine was built for non-variable fonts from the start.
- Picking a **library family** loads the nearest face (weight 400 by default)
  through the library route; the same Weight select lists that family's faces.
  Library files are OTF/TTF today; a face whose file fontkit cannot parse shows a
  one-line reason in the row and the studio keeps the previous font.
- A font that cannot be loaded at all (network, unknown token) falls back to
  **Inter** with a visible note in the row; never a blank canvas.

## Section 2 — how it works underneath

**One string, three shapes.** `config.fontId` stays a string:

| token | meaning | file route |
|---|---|---|
| `inter`, `roboto-flex`, … (bare) | curated variable family | `/api/fonts/variable?id=` (unchanged) |
| `google:Family@400` | one Google cut | `/api/fonts/google-file?family=&weight=` (fail-closed, see below) |
| `local:Family@400` / `local:Family@700i` | one library face | `/api/library-font/<faceId>` (unchanged) |

The `local:` grammar is the library's existing token (`libraryToken` in
`app/data/library-fonts.ts`); Vector Type reuses it rather than minting a fourth
shape. `google:` is new and explicit so a bare id can never be mistaken for a
family name.

**One loader.** `loadVectorFont(token): Promise<VtFont>` in
`app/lib/vectortype/font.ts` replaces `loadVariableFont(id)` for every caller
(surface, node, thumb, collection controls, agent tune, take thumbs, dev pages).
It parses the token, fetches through the matching route, parses with fontkit,
normalises axes (empty for static cuts — the "no axes" error goes away), and
caches the promise per token as today. `loadVariableFont` stays as a thin alias
for one release so nothing else breaks.

**Fail-closed server route for Google cuts.** `server/api/fonts/google-file.get.ts`
is the 3D Studio's `scene3d/google-font-file` proxy moved to a shared home (the
old path keeps working as an alias): `family` must exist in the server-side
Google catalog (`server/utils/googleCatalog.ts`) and `weight` must be one of that
family's listed weights, or the route answers 400 before touching the network.
Same curl user-agent trick, same 24 h / 50-entry cache.

**Config parse.** `mergeConfig` accepts any of the three token shapes (a
validator `isVtFontToken`), falling back to the default id for anything else —
today's `oneOf(VT_FONT_IDS)` would silently reset a Google pick on reload.

**Weight is a control.** A new `fontWeight: number` field (default 400) with a
`select` control whose options derive from the current family's shipped weights
(curated families: hidden, their weight is an axis). Changing it re-tokens
`fontId` (`google:Family@<w>` / `local:Family@<w>`), so the token remains the
single source of truth and persisted projects carry the weight inside it.

**Everything downstream** already takes a `VtFont`; nothing reads the catalog by
id except `variableFontUrl`/`loadVariableFont` and the `fontId` select options.
The headless bake and the embed load the font through the same loader, so a font
that loads in the studio cannot fail in a bake.

**Agent.** The `fontId` control's options stop being ten ids: the descriptor
exposes the pinned ten plus "any Google family name", validated against the
catalog the way Space Type's `font` is (`resolveFontFamily`). Guidance: "a
family name picks a static cut; the ten pinned families have live axes."

**Collections.** `fontId` stays bindable; a bound column can carry any token.

## Not in scope

- Promoting arbitrary Google families to variable (option C).
- Italic for Google cuts (the catalog knows `italic: boolean`; a later `i` suffix
  can ride the same token grammar).
- WOFF2 uploads (the library is OTF/TTF).

## Failure modes designed against

- **Loads in the studio, fails in the bake** — one loader, one token grammar.
- **Reload resets the font** — the parser accepts all three token shapes.
- **Open proxy** — the Google route validates family and weight against the
  catalog before fetching.
- **Static font breaks the axes UI** — `VtFont.axes` may be empty; every axis
  consumer already handles "no axes" for a font with none (Axes group hides,
  axis presets report their requirement).

## Testing

- Token grammar: parse/format round-trips for all three shapes; junk → default.
- Loader: a static TTF fixture parses to a `VtFont` with empty axes; the curated
  path still yields axes; a rejected load is evicted from the cache.
- Server route: unknown family → 400 without a fetch; weight not shipped → 400;
  known pair → TTF bytes (mocked upstream).
- Surface: the Weight select lists the catalog's weights for a Google family and
  hides for a curated one (component-level test through the control schema).
- Live: pick a Google family in the studio, see it render, export SVG; pick a
  library family; reload the project and see the same font.
