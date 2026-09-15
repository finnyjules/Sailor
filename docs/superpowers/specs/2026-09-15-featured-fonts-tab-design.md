# Featured fonts tab — design

**Date:** 2026-09-15
**Status:** Design (awaiting review)

## Goal

Add a new font-picker tab, **"Featured"**, that surfaces a curated list of free
fonts (seeded from Bram Naus's "Free Font (№X)" series, ~132 recovered of 157).
The tab presents the whole list in one place. Fonts already available on Google
resolve through the existing Google path (no file bundled); the rest are
self-hosted like the Pangram/Off-Type libraries. Non-redistributable fonts carry
a flag and are dropped from the build behind a build-time env var.

Internal foundry id: `bram-naus`. User-facing label: **Featured**.

> Note: the Google tab already renders a "Featured" *group header* inside its
> list. The new tab is a separate surface; keep them visually distinct.

## Non-goals

- No re-scraping of X to complete the missing 24 numbers (separate, optional).
- No new font-loading runtime — reuse the existing Google loader and the
  `lib:`/`goog:` resolution already in place.
- No unrelated refactors beyond what this feature touches.

## Data model

New seed file `frontend/app/data/free-fonts.seed.json`. One entry per font:

```json
{
  "name": "Cabinet Grotesk",
  "num": 33,
  "source": "self-hosted",
  "googleFamily": null,
  "license": "OFL-1.1",
  "redistributable": true,
  "designer": "Indian Type Foundry",
  "sourceUrl": "https://github.com/..."
}
```

- `source`: `"google"` | `"self-hosted"`.
- `googleFamily`: the exact Google Fonts family name when `source == "google"`;
  omitted/null otherwise.
- `license`: short SPDX-ish tag (`OFL-1.1`, `Apache-2.0`, `Free-noredist`, …).
- `redistributable`: `false` marks fonts we may keep locally but must not ship.
- `num`, `designer`, `sourceUrl`: provenance/credit; `num` also drives ordering.

Self-hosted files live under `Assets/Fonts/Free Fonts/<Family>/…`, mirroring the
existing PPF / Off-Type bundle layout.

## Two resolution paths

- `source: "google"` → picker row stores a `goog:<family>` key and loads through
  the **existing Google mechanism**. No file bundled, no manifest faces.
- `source: "self-hosted"` → bundled `.otf/.ttf/.woff2`, served from
  `Assets/Fonts` and resolved via the existing `lib:` key, exactly like Pangram.

This keeps the whole curated list visible in one tab while avoiding duplicate
files for the ~40–50 fonts that are already Google Fonts.

## Generator changes

`frontend/scripts/build-font-library.mjs` and `frontend/scripts/fontLibrary.mjs`:

1. **Foundry mapping** (`foundryFromRelPath`): top folder `Free Fonts/` →
   `{ id: 'bram-naus', label: 'Featured' }`.
2. **File walker**: extend `walkOtf` (rename → `walkFontFiles`) to accept
   `.otf`, `.ttf`, and `.woff2` (fontkit parses all three). Existing bundles are
   unaffected (still `.otf`).
3. **Seed merge**: after scanning files, merge `free-fonts.seed.json`:
   - `google` entries → emit a lightweight family record: `family` (name),
     `foundry: 'bram-naus'`, `source: 'google'`, `googleFamily`, no local faces.
   - `self-hosted` entries → match to scanned files by family; attach `license`,
     `redistributable`, `source: 'self-hosted'`.
   - Seed entries with no matching files (self-hosted, not yet downloaded) are
     skipped with a warning (they surface in the coverage report, not the app).
4. **Restricted filter**: read `process.env.BUNDLE_RESTRICTED_FONTS`. When `'0'`,
   drop `redistributable: false` entries from the manifest. Default (unset) =
   include, so they appear in local dev. Hosted/prod build sets it to `0`.
5. Add `bram-naus` to the generator's `foundries` list (filtered to present).

### Manifest schema additions

Per family, add: `source` (`'self-hosted' | 'google'`), optional `googleFamily`,
`license`, `redistributable`. Existing Pangram/Off-Type families default to
`source: 'self-hosted'`, `redistributable: true` (licensed bundles) so nothing
downstream breaks.

## Resolution / lookup

`frontend/app/data/library-fonts-lookup.ts` and the server resolver
(`frontend/server/utils/libraryFontManifest.ts`,
`frontend/server/api/fonts/…`):

- self-hosted `bram-naus` families → existing `lib:` path (server serves the file
  from `Assets/Fonts`). No change beyond the new foundry being present.
- google `bram-naus` families → the picker emits `goog:<googleFamily>` so
  selection and loading go through the existing Google path. The lookup must not
  try to resolve these as local files.

## Picker UI

Three FontPicker copies exist:
`components/vue-canvas/FontPicker.vue`,
`components/vue-canvas/widgets/FontPicker.vue`,
`components/templates/FontPicker.vue`.

- Rather than hardcode a third tab in each, make the tab list **foundry-driven**
  from the manifest's `foundries` (Google stays a special first tab). This adds
  the "Featured" tab everywhere at once and makes future libraries free.
- The "Featured" tab lists families ordered by `num`. Self-hosted rows preview in
  their own face; google rows preview via the Google-loaded face.
- Restricted fonts simply aren't in the manifest when built with the flag off, so
  the UI needs no special handling for them.

(If the foundry-driven refactor proves risky across all three during planning,
fall back to adding the tab explicitly next to the "Pangram" tab in each — same
user-visible result, more duplication.)

## Sourcing pass

`frontend/scripts/fetch-free-fonts.mjs` (best-effort, re-runnable):

- Reads `free-fonts.seed.json`.
- Detects Google-available names against the same catalog the Google tab uses;
  marks those `source: "google"`.
- For self-hosted OFL/GitHub entries with a `sourceUrl`, downloads the file(s)
  into `Assets/Fonts/Free Fonts/<Family>/`.
- Writes `docs/superpowers/specs/assets/free-fonts-coverage.md` (or similar):
  per font — sourced / via-Google / needs-manual, with the reason.

The seed itself is built by research (per-font: on Google? license? file URL?),
done in batches. Coverage will have a manual tail; the tab works from day one
with whatever the seed currently resolves.

## Licensing note

Only redistributable (OFL/Apache/etc.) fonts are safe to commit and ship.
Non-redistributable "free" fonts are flagged and excluded from builds via
`BUNDLE_RESTRICTED_FONTS=0`. Caveat on the record: committing the *files* of
non-redistributable fonts to git is itself distribution if this repo is ever
shared or made public. For a private repo this is the owner's call; the build
flag governs only the shipped/hosted product, not the git history.

## Testing

Mirror existing font-library specs
(`tests/unit/font-library-manifest.unit.spec.ts`,
`library-font-resolve.unit.spec.ts`, `library-font-server-resolve.unit.spec.ts`):

- Generator merge: a google seed entry produces a `source:'google'` family with
  no faces; a self-hosted entry attaches license/redistributable and faces.
- Restricted filter: `BUNDLE_RESTRICTED_FONTS=0` drops `redistributable:false`
  entries; unset keeps them.
- Lookup: google family → `goog:` key; self-hosted family → `lib:` key.
- Manifest schema: new fields present and typed; existing bundles back-filled
  with `source:'self-hosted'`, `redistributable:true`.
- File walker accepts `.ttf`/`.woff2` without breaking `.otf` bundles.

## Rollout

1. Schema + generator + lookup + one seed with a small verified set (a handful of
   known-Google + one self-hosted OFL font) → tab renders end to end.
2. Picker tab (foundry-driven) + tests green.
3. Sourcing pass builds out the seed/files in batches; coverage report tracks the
   tail.
```
