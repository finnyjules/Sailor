# Slice F7 · Print recipes  (task-level plan)

> Part of the **Frame Effects Programme** (`docs/superpowers/plans/2026-09-09-frame-effects-programme.md`).
> Written when reached, executed with superpowers:subagent-driven-development as F1–F6 were.

**Goal:** one-click print LOOKS — **risograph**, **photocopy**, **letterpress** — as per-layer effect
kinds that, at paint time, **expand into a sequence of the existing `postEffects.ts` passes** with a
few high-level dials each. A designer picks "Risograph" and gets the whole stack (limited inks +
grain + crushed tone) behind two or three knobs, instead of hand-stacking five effects and tuning
each. Recipes are ordinary orderable pixel-region members of the effect stack.

## The mechanism (why this is cheap and safe)

The per-layer pixel passes already run one at a time through a dispatch loop in
`useCompositorLayers.ts` (`for (const e of bodyPasses) { switch (e.type) … default: applyPasses(off,[e],opts) }`,
~line 2865). Every pass is a pure `pass<Name>(ctx, off, effect, opts)` over the layer's device-res
offscreen, and `applyPasses(off, passes, opts)` runs an ordered list. So a recipe is nothing more
than **a function from its few dials to an ordered `PostEffect[]`**, dropped into `applyPasses` at
paint time. No new render machinery; the recipe reuses posterise / gradientMap / grain / threshold /
levels / ink_bleed / rough_edge / adjust, which are already tuned and tested.

- **Expansion is a pure function** `expandRecipe(e): PostEffect[]` in a new `app/lib/compositor/recipes.ts`
  (imports the recipe interfaces type-only from effectStack.ts and `PostEffect` + `defaultPostEffect`
  from postEffects.ts — postEffects.ts keeps its one-way independence). Each entry is a full
  `{ type, visible:true, …params }` built from `defaultPostEffect(type)` + overrides derived from the
  recipe's dials. Unit-testable with zero canvas.
- **Dispatch:** add recipe cases to the bodyPasses loop — `case 'risograph': case 'photocopy':
  case 'letterpress': applyPasses(off, expandRecipe(e), { W, scale: s }); break`. That is the whole
  wiring; `applyPasses` already skips non-visible / unknown entries.
- **Byte-identical when absent** by construction: the new cases only fire for a recipe that is present
  and visible; a layer with none renders exactly as before (the same real-canvas A/B, RED-first,
  proves it per recipe).

## Global constraints (bind every task)

- Recipes are **orderable pixel-region kinds** (not pinned): `regionOf` falls through to `'pixel'`,
  they reorder among the other pixel passes, duplicate, and sit in `EFFECT_ORDER` in the pixel band.
- Reuse existing passes; **add a new primitive only if a look cannot be reached by composition** (the
  candidate is letterpress emboss — see Task 3). Any new primitive is a normal `pass*` + PASS_TYPES
  entry + POST_EFFECT_DEFAULTS, byte-identical when absent, unit-tested.
- These are **LOOKS** — the exact compositions below are grounded starting points, tuned by eye by the
  controller in the live gate (the F6 lesson: the live GPU/canvas gate is the oracle; a pass list can
  be "green" and read wrong). Each task ends with a real-browser screenshot for Julien.
- UI copy sentence case, human names, no dead controls; `optionLabels` on any select over internal
  values. `CompositorModal.vue` / `useCompositorLayers.ts` staged BY HUNK (private `GIT_INDEX_FILE`,
  own hunks only, never `git add -A` / `git stash`); the private-index recipe MUST be ONE bash call.
- **Agent is PICKER/UI-ONLY this slice**, like F5/F6: the compositor agent-hint budget is at its
  ceiling (26248/26250), so a recipe vocabulary can't be added without the ceiling decision Julien
  owns. A unit asserts a `{type:'risograph'}` (and the other two) patch is rejected and
  `COMPOSITOR_HINT_CEILING` is unchanged. (Recipes are the strongest case yet for raising it — noted
  as the owed follow-up.)
- NEVER a subagent dev server; controller runs the live gate (healthy :3002 or a fresh harness).
- Commits end `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Interfaces produced

### `lib/compositor/effectStack.ts`
- `RisographEffect  { type:'risograph';  visible:boolean; ink:string; inkTwo:string; levels:number; grain:number; contrast:number }`
- `PhotocopyEffect  { type:'photocopy';  visible:boolean; threshold:number; dirt:number; contrast:number }`
- `LetterpressEffect{ type:'letterpress';visible:boolean; depth:number; angle:number; ink:string; paper:number }`
- Added to `LayerEffect`, `EFFECT_ORDER` (pixel band — near the other tone/texture pixel kinds,
  contiguous as a "recipes" trio, e.g. right after `ink_bleed`), `EFFECT_LABELS`
  (`'Risograph'` / `'Photocopy'` / `'Letterpress'`), `LOCAL_DEFAULTS`. `regionOf` needs NO change
  (pixel is the fall-through). NOT pinned, NOT geometry.

### `lib/compositor/recipes.ts` (new, pure)
- `RECIPE_KINDS = ['risograph','photocopy','letterpress'] as const`; `isRecipeKind(k)`.
- `expandRecipe(e: RisographEffect | PhotocopyEffect | LetterpressEffect): PostEffect[]` — the pure
  dial→passes maps (Tasks 1–3 fill these in). CPU-twin unit-tested.

### `useCompositorLayers.ts`
- Import `expandRecipe` + the recipe types (re-export the types like the other effect interfaces).
- The three recipe cases in the bodyPasses dispatch loop.

### `CompositorModal.vue`
- Three inspector blocks (Task 4), high-level dials only, sentence-case.

---

## Tasks

### Task 1 · Recipe scaffold + Risograph
- effectStack.ts: all three interfaces + union + EFFECT_ORDER + labels + defaults (so the trio lands
  in the add-menu together and the model is complete once), but only **risograph** gets a real
  `expandRecipe` branch this task (the other two return `[]` until their task — a `[]` expansion is a
  visible no-op, safe).
- recipes.ts with `expandRecipe(risograph)`. Grounded starting composition (tune by eye):
  `adjust`(contrast from the dial) → `posterise`(levels from the dial) → `gradientMap`(a riso ramp
  paper→ink→inkTwo built from the two ink dials) → `grain`(grain dial). Dials: two inks, levels,
  grain, contrast.
- Dispatch case in useCompositorLayers.ts.
- **Tests:** unit on `expandRecipe(risograph)` (right pass types, in order, dials mapped, disabled
  dials drop their pass); real-canvas A/B byte-identity when absent (RED-first); applied changes the
  pixels. Controller runs the live gate + screenshots the look.
- **Acceptance:** a risograph layer renders the composed look; absent ⇒ byte-identical.

### Task 2 · Photocopy
- `expandRecipe(photocopy)`: `adjust`(contrast) → `levels` or `threshold`(from the threshold dial —
  choose by eye for a gritty vs pure-1-bit crush) → `ink_bleed` + `rough_edge`(dirt dial) →
  `grain`(dirt dial). Dials: threshold, dirt, contrast.
- **Tests:** expand unit + byte-identity + applied. Controller live-tunes + screenshots.

### Task 3 · Letterpress
- `expandRecipe(letterpress)` — try composition first: `inner_glow`(dark, tight — the debossed inner
  shadow, depth+angle dials) + a paper tint (`color_overlay` low-alpha, paper dial) + a slight
  desaturate (`adjust`). **If the emboss does not read by eye**, add ONE small primitive
  `passEmboss` (a light/dark edge shift along `angle` from the alpha/luminance gradient) to
  postEffects.ts (PASS_TYPES + POST_EFFECT_DEFAULTS + byte-identical when absent + its own unit) and
  use it — decided in the live gate, not up front.
- **Tests:** expand unit (+ emboss unit if added) + byte-identity + applied. Controller live-tunes +
  screenshots.

### Task 4 · Inspector UI + agent-reject + copy + whole-slice proofs
- CompositorModal.vue: three inspector blocks, high-level dials only (StudioSlider for numbers,
  StudioColorField for inks, sentence-case labels, a one-line helper each). Add-menu lists the trio
  (auto via EFFECT_ORDER) — re-check the menu fit at ~640px (studio-add-menus-overflow-viewport).
- Agent-reject unit for all three + `COMPOSITOR_HINT_CEILING` unchanged (no compositor.ts change).
- Duplicates/coexistence (a recipe + a hand-stacked pass on one layer both apply; two recipes),
  copy sweep, typecheck baseline.
- **Acceptance:** full F7 Playwright describe green live; whole-slice unit sweep green; inspector +
  add-menu verified in-browser.

---

## Acceptance (whole slice)
- Three print recipes, each a composed look behind a few dials, orderable pixel members of the stack,
  byte-identical when absent, live-verified by eye.
- At most one new primitive (letterpress emboss), only if composition can't reach the look.
- Agent picker/UI-only (deliberate, documented); hint budget unchanged.

## Follow-ups (owed)
- The agent recipe vocabulary — needs the hint-ceiling decision (recipes are the strongest case for
  raising it; "make this risograph" is one hint per recipe).
- A "misregistration" primitive (channel offset) would sharpen risograph — deferred; not in scope.
- By-eye: the three looks against real riso/xerox/letterpress references; the default palettes.
