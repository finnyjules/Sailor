# 3D treatments — Slice S4: new masked & edge treatments

BASE b05cc7af2. Nine new per-object treatments on the S3 treatment stage. The 3D twin of Frame F4.

## Masked treatments (object drawn alone, composited back with the depth test + `invert`)
- **colour grade** — brightness/contrast/saturation/hue (+ tint) over the object only.
- **dissolve** — seeded noise threshold erodes the object's alpha (amount, scale, seed; a soft
  edge band).
- **halftone / dot screen** — the object rendered through a dot/line screen (cell size, angle,
  contrast); a print look.
- **chromatic split** — RGB channels offset by a direction+amount (a per-object aberration).
- **glitch / scanlines** — seeded horizontal displacement bands + scanline darkening (amount,
  scanline density, seed).
- **flat drop shadow** — a solid offset copy of the silhouette behind the object (angle, distance,
  colour, softness) — a graphic drop shadow, distinct from the scene's cast shadow.

## Edge treatments (mesh shells or G-buffer consumers)
- **dashed outline** — the inverted-hull outline as a dashed line (colour, width, dash, gap).
- **silhouette cutout** — knock the object out to a flat fill / hole (a sticker-cut look).
- **cross-hatch** — hatching whose density follows luminance or the normal gradient (reads the S3
  G-buffer → `BUFFER_TREATMENT_KINDS`; colour, spacing, angle, threshold).

## Per-kind registration (see s4-constraints.md for the exact surface)
treatments.ts (group array + interface + LABELS + DEFAULTS + parseTreatment) · treatmentControls.ts
(rows) · treatmentStage.ts (composite/shell) · Scene3DTreatmentRow.vue TREATMENT_ICONS (total Record).

## Tasks (≈8-9)
1. colour grade · 2. dissolve · 3. halftone · 4. chromatic split · 5. glitch/scanlines · 6. flat
drop shadow · 7. edge trio (dashed outline / silhouette cutout / cross-hatch) · 8. Playwright per
kind + agent/copy. One review per task + a whole-slice review.

## Guarantees
- The stage runs only for enabled treatments (a scene without the new kinds is unaffected); a
  G-buffer reader stays gated in BUFFER_TREATMENT_KINDS so the S3 byte-identity gate holds.
- Deterministic (seeded); display-space blend before OutputPass; no dead controls; sentence case.
- Every kind gets a TREATMENT_ICONS entry; frozen enumeration guards bumped per kind.
