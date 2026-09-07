# Plan — Vector Type Studio, per-letter vertical position

Spec: `docs/superpowers/specs/2026-09-07-vector-type-baseline-rise-design.md`

Work in the MAIN checkout, no worktree, no branch. Other sessions share this
repo: stage only the exact paths listed below, never `git stash`.

Order: Task 1 → Task 2 → (Task 3 ∥ Task 4) → Task 5.

---

## Task 1 — Schema

**File:** `frontend/app/lib/vectortype/config.ts`

1. `export const VT_RISE_SHAPES = ['off','random','wave','ramp','arch','zigzag'] as const`
   and `export type VtRiseShape = (typeof VT_RISE_SHAPES)[number]`, beside
   `VT_FITS` / `VT_ALIGNS` (~line 877).
2. Bounds beside `VT_SKEW_MAX` / `VT_ARC_MAX`: `VT_RISE_MAX = 1`,
   `VT_RISE_CYCLES_MIN = 0.25`, `VT_RISE_CYCLES_MAX = 8`, `VT_RISE_SEED_MAX = 999`.
3. Five fields on `VectorTypeConfig` after `fit`: `riseShape: VtRiseShape`,
   `rise: number`, `riseCycles: number`, `risePhase: number`, `riseSeed: number`,
   with a doc comment covering: em units not pixels, up-positive at the control
   and y-down at `dy`, why it is per-glyph where skew is whole-run, and why the
   shapes are zero-centred.
4. `DEFAULT_CONFIG`: `riseShape: 'off'`, the rest `0` except `riseCycles: 1`.
5. `mergeConfig`: `riseShape: oneOf(o.riseShape, VT_RISE_SHAPES, d.riseShape)`
   and four `num(...)` lines. **Do not clamp `rise` here** — say why in a
   comment, pointing at the `skewX` note directly above it.

**Verify:** `npx nuxt typecheck` clean for this file; a default config
round-trips through `mergeConfig` unchanged.

---

## Task 2 — The module, test-first

**Files:** `frontend/app/lib/vectortype/rise.ts` (new),
`frontend/tests/unit/vectortype-rise.unit.spec.ts` (new)

Write the tests from the spec's Tests section FIRST, watch them fail, then
implement. All seven groups, including the measured channel-independence one —
it is the test that justifies the named channel.

`rise.ts` imports `./random` and `./config` types only. No canvas, no fontkit.

```ts
export const VT_RISE_CHANNEL = 'rise'
export function vtRiseActive(cfg): boolean
export function vtRiseDy(cfg, index, count, em): number
```

`vtRiseActive` is `shape !== 'off' && clamped rise !== 0`. `vtRiseDy` returns 0
immediately when inactive, and otherwise `-(shapeOffset) * clampedRise * em` —
the single negation from up-positive to y-down, with the comment saying so.

Clamp `rise` to ±`VT_RISE_MAX` and `riseCycles` into its range HERE, the render
choke point both the merge path and a motion track pass through.

**Verify:** the new spec file green; the four goldens are literal numbers.

---

## Task 3 — Controls

**File:** `frontend/app/lib/vectortype/controls.ts`

1. Gate predicates beside `scattersAtAll`, optional-chained the same way:
   `risesAtAll` (shape not off), `riseIsWave`, `riseIsRandom`.
2. Five controls in the `Layout` group, placed after `fit`, using the existing
   `slider` / `select` helpers. The select carries
   `optionLabels: { off: 'Off', random: 'Random', … }` — sentence case, never the
   raw identifiers — and `animatable: false`. `riseSeed` also `animatable: false`.
   `riseCycles` / `risePhase` carry `when: riseIsWave`; `riseSeed`
   `when: riseIsRandom`; `rise` `when: risesAtAll`.
3. Hints in plain language, each saying what the shape looks like rather than
   naming its formula.
4. One paragraph in the agent vocabulary blurb (the block containing the SCATTER
   and SKEW paragraphs, ~line 739), written to steer a model to Baseline rather
   than Skew Y when the user asks for letters at different heights.

**Verify:** every one of the five controls reaches a real config leaf — chase
each key to the `setParam` that consumes it, per the dead-control rule.

---

## Task 4 — Wire it in

**File:** `frontend/app/lib/vectortype/presetMotion.ts`

In `vtGlyphMotion` (~line 836), beside the blink and scatter gates:

```ts
const riseDy = vtRiseActive(cfg) ? vtRiseDy(cfg, index, count, em ?? vtEmSize(cfg, t)) : 0
```

and `dy: tr.dy + pr.dy + riseDy`. Reuse the `em` already resolved for
`presetTransform` rather than resolving it twice.

Add to the module header's units table that `dy` now carries a static baseline
term as well as motion.

**Integration test** in the existing vectortype motion spec: a config with
`riseShape: 'ramp'`, `rise: 0.5` produces a `dy` spread across glyphs, and the
default config's `dy` is unchanged.

---

## Task 5 — Verify and land

1. `npx nuxt typecheck` — compare against the recorded baseline, do not assume 0.
2. `npx vitest run tests/unit/vectortype-*.unit.spec.ts`.
3. Live: check for an existing dev server for this checkout before starting one
   (`lsof -nP -iTCP -sTCP:LISTEN | grep node`, then `lsof -a -p <pid> -d cwd`).
   Screenshot a word under each of the five shapes, plus one with Arc on to prove
   the letters leave their OWN baseline rather than the screen's.
4. After any frontend restart, check `127.0.0.1:8188/system_stats` and relaunch
   ComfyUI if it died.
5. Stage ONLY: the two docs, `rise.ts`, `config.ts`, `controls.ts`,
   `presetMotion.ts`, and the two test files. Commit.
6. Update the State of the Build dashboard artifact — read the live one first,
   replace in place, never append.
