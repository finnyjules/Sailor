# Letter Behaviours — Phase 2 Implementation Plan (loops, Decode, Slot slide)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add five letter behaviours to Frame text layers — Wave, Bounce, Jitter (loops), Decode (letters flicker through random characters, then lock) and Slot slide (each letter is a slot-machine reel that lands on the real glyph) — and hide the Easing section on letter bars where easing does nothing.

**Architecture:** Phase 1 (`docs/superpowers/plans/2026-09-19-letter-behaviours-phase1.md`, spec `docs/superpowers/specs/2026-09-19-letter-behaviours-design.md`) built the pure evaluator `frontend/app/lib/motionx/text/` and a per-glyph emitter `drawTextCells(ctx, cells, frame, paint)` in `text/draw.ts`, where `paint(ch)` inks one character at the origin. Phase 2 extends the per-cell output with two optional fields — a substitute character and a reel — computed by a new optional PER-CELL callback on a behaviour definition, and teaches `drawTextCells` to draw them. No change to `useCompositorLayers.ts` is needed or allowed.

**Tech Stack:** TypeScript, Vitest, Vue 3 `<script setup>`, Tailwind, Canvas 2D.

## Global Constraints

- Work in the main checkout `/Users/julien/Documents/GitHub/Sailor`. No worktree, no branch, never `git stash`, never `git add -A` / `git add .`, never `git checkout -- <file>` / `git restore` / `git reset --hard` / a bare `git reset`. (The ONE allowed form is `git reset -q -- <exact paths you just committed>`, see below.)
- **Never start, stop or restart a dev server.** Do not run Playwright.
- You share this checkout with other live sessions: touch ONLY the files your task names.
- **Every commit uses a private git index, then syncs the shared index:**
  ```bash
  GIT_INDEX_FILE=$(mktemp); export GIT_INDEX_FILE; git read-tree HEAD
  git add -- <exact paths>; git diff --cached --stat   # must list ONLY your files
  git commit -q -m "<subject>

  <body>

  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
  rm -f "$GIT_INDEX_FILE"; unset GIT_INDEX_FILE
  git reset -q -- <the same exact paths>     # REQUIRED: sync the shared index to HEAD for those paths
  ```
  The trailer is the LAST line of the body after a blank line. To see your change to a file use `git show HEAD:<path> | diff - <path>` (do not trust `git status`).
- Unit tests from `frontend/`: `npm run test:unit -- <filter>`. Typecheck: `npx vue-tsc --noEmit 2>&1 | grep -E "<your files>"`. `CompositorModal.vue` has 6 pre-existing errors on lines you must not touch.
- Byte-identity: a text layer with no active letter behaviour draws exactly as today. `useCompositorLayers.ts` is NOT to be modified in this phase.
- No `Math.random()` / `Date.now()` anywhere reachable from rendering — randomness only via `hash01` (`text/rng.ts`). (`Math.random()` is allowed only in an authoring click handler such as Shuffle.)
- Every enum param is read through `oneOf(value, allowed, fallback)`; every numeric param through the finite-number guard `num(v, default)` — both already exist in `text/evaluate.ts`.
- TDD: failing test first, show it fail, implement. Never weaken an existing test.
- UI copy: sentence case, plain words, no internal identifiers. Palette: surfaces `#1a1a1a` / `#0e0e10`, `border-white/10`, accent `#7c9cff`, behaviour bars emerald.
- "Live check" steps are skipped by subagents and done by the controller.

---

### Task 1: Core — per-cell output, the five behaviours, "uses easing"

**Files:**
- Modify: `frontend/app/lib/motionx/text/evaluate.ts`, `frontend/app/lib/motionx/text/behaviours.ts`, `frontend/app/lib/motionx/text/index.ts`
- Create: `frontend/app/lib/motionx/text/charsets.ts`
- Test: `frontend/tests/unit/motionx/text-phase2.unit.spec.ts`

**Interfaces produced**
```ts
// evaluate.ts — additions
export interface ReelDraw { chars: string[]; pos: number; roll: 1 | -1 }   // roll 1 = rolls UP (next char arrives from below)
export interface CellDraw { /* existing fields */ char?: string; reel?: ReelDraw }
export interface CellCtx extends PieceCtx { cellIndex: number; cell: TextCell; cells: TextCell[] }
export interface TextBehaviourDef {
  /* existing */
  cell?: (c: CellCtx) => { char?: string; reel?: ReelDraw; clipToCell?: boolean; clipPad?: number } | undefined
  usesEase?: (params: Record<string, unknown>) => boolean          // absent ⇒ true
  wholeBar?: boolean   // pieces are ACTIVE from the bar's start, not from their own delay (see rules)
}
export function textBehaviourUsesEase(kind: string, params?: Record<string, unknown>): boolean
// PieceCtx gains: rank: number; maxRank: number
// CellDraw.clip gains an optional `pad?: number` (share of clip.h added above and below; draw default stays 0.15)
// charsets.ts
export type Charset = 'text' | 'letters' | 'numbers' | 'symbols' | 'mixed'
export function pickChar(set: Charset, real: string, cells: { char: string }[], r: number): string   // r in [0,1)
```

**Rules**
- `charsets.ts`: `letters` = A–Z, returned in the CASE of `real` (lowercase when `real` is lowercase, else uppercase); `numbers` = `0123456789`; `symbols` = `#%&@$?!*+=<>/`; `mixed` = letters + numbers + symbols; `text` = the distinct non-whitespace characters of `cells` (fallback to `letters` when fewer than 2). `pickChar` = `pool[floor(r × pool.length)]`. It may return `real` by chance — fine.
- `usesEase`: `text.cascade`, `text.maskSlide`, `text.slot` → true; `text.scramble` → `move === 'glide'`; `text.typewriter`, `text.decode`, `text.wave`, `text.bounce`, `text.jitter` → false. `textBehaviourUsesEase` reads the registry (unknown kind → false).
- `wholeBar`: for an ENTRANCE, a piece whose own delay has not started yet is normally HIDDEN. With `wholeBar: true` the behaviour's `piece`/`cell` callbacks are called for every piece from the BAR's start (`barElapsed >= 0`) until the piece's own `p >= 1`; before the bar → HIDDEN, at/after the piece's `p >= 1` → REST. Mirror for an EXIT: from the piece's own start until the bar's end the callbacks run; after the bar → HIDDEN. Read how `text.scramble` settle currently gets this effect and generalise it behind this flag rather than adding a second mechanism (scramble may adopt the flag if that is cleaner — its tests must stay green).
- Composition of the new fields: the LAST behaviour (list order) that returns a `char` / `reel` for a cell wins. `clipToCell: true` sets `CellDraw.clip` to the CELL's own rest box `{ x: cell.x, y: cell.y, w: max(cell.w, cell.h × 0.8) × 1.1, h: cell.h, angle: cell.angle, pad: clipPad ?? 0.15 }` and that clip then travels with later transforms exactly like a Mask slide clip does (phase-1 fix).
- `textCanMove` needs no new rule (the new kinds are ordinary in / out / span bars) — add tests proving it for each new kind, incl. the consistency test (whenever `textCanMove` is false, `evaluateTextBehaviours` is `atRest`).

**The five kinds** (shared params `by`, `order`, `seed` as before; `stagger` applies to decode and slot only)
- `text.wave` / `text.bounce` / `text.jitter` — phase `'span'`. Params: `amount` (piece-heights; defaults 0.25 / 0.35 / 0.08), `speed` (cycles per second; defaults 1 / 1.4 / 12 for jitter = ticks per second), `offset` (cycles of lag per rank, default 0.12; jitter ignores it). Envelope `env` = smooth ramp 0→1 over the first `r` seconds and 1→0 over the last `r` seconds of the bar, `r = min(0.3, barDur × 0.25)`, using smoothstep. Phase `φ = barElapsed × speed − rank × offset`.
  - wave: `dy = −env × amount × piece.h × sin(2π φ)` (frame `'piece'`).
  - bounce: `dy = −env × amount × piece.h × |sin(π φ)|` — never goes below the baseline.
  - jitter: tick `k = floor(barElapsed × speed)`; `dx = env × amount × piece.h × (hash01(seed, piece.index, k, 1) − 0.5) × 2`, `dy` likewise with channel 2, `rotation = env × (hash01(seed, piece.index, k, 3) − 0.5) × 2 × 6°` in radians.
- `text.decode` — `dir: 'resolve' | 'dissolve'` (default resolve → phase `'in'`; dissolve → `'out'`), `charset: Charset` (default `'text'`), `rate` (flickers per second, default 14, min 1), `wholeBar: true`. While active the piece is at REST position with opacity 1, and each CELL shows `pickChar(charset, cell.char, cells, hash01(seed, cellIndex, floor(barElapsed × rate)))`. Resolve: a piece locks (REST, real char) at its own `p >= 1`. Dissolve: a piece starts flickering at its own start and is HIDDEN after the bar.
- `text.slot` — `dir: 'in' | 'out'` (default in), `roll: 'up' | 'down'` (default up), `steps` (integer 1–40, default 8 — **how many characters the slot rolls through before it lands**), `filler: Charset` (default `'letters'`), `springTail: true`, `usesEase` true. Per cell: `in` → `chars = [f1 … f_steps, real]` with `f_j = pickChar(filler, real, cells, hash01(seed, cellIndex, j))`, `pos = e × steps`; `out` → `chars = [real, f1 … f_steps, '']`, `pos = e × (steps + 1)`. `roll = up ? 1 : -1`. `clipToCell: true`, `clipPad: 0`. The piece itself stays at REST position, opacity 1 (the reel does the motion). With a spring, `pos` overshoots past the last index and comes back — entries beyond the list are simply not drawn.

**Tests to write** (derive exact expectations from the formulas above; small fixed cell list like phase 1's spec; `toBeCloseTo(…, 6)` for trig):
1. `pickChar`: case-matching, each set's membership, `text` set built from cells, fallback when < 2 distinct chars, determinism in `r`.
2. wave / bounce / jitter: rest outside the bar; envelope is 0 at both bar edges and 1 in the middle; wave value at a hand-computed instant; bounce never positive `dy`; jitter constant within a tick and changes across ticks; same seed same frame; `offset` makes rank 1 lag rank 0; `by: 'words'` moves a word's letters together.
3. decode: hidden before the bar; mid-bar every cell has opacity 1, rest position and a `char` from the chosen set; a locked piece has NO `char` field and the frame is `atRest` after the bar; flicker constant within `1/rate` and changing after; with stagger the first-ranked piece locks first while later ones still flicker; dissolve mirror (rest before, hidden after).
4. slot: `chars.length === steps + 1` ending with the real char (in); `pos` = 0 at start, `steps` at end; linear ease mid-bar → `pos = steps / 2`; `roll` sign; `clip` = the cell box with `pad: 0`; a spring overshoots (`pos > steps` at some instant) and ends `atRest`; out variant ends HIDDEN with `chars[0] === real`; by words: all letters of a word share `pos`.
5. composition: Slot + Scramble on the same layer → the reel's clip travels with the scrambled cell (cell centre stays inside its clip).
6. `textBehaviourUsesEase` truth table incl. scramble snap/glide and an unknown kind.
7. `textCanMove` for each new kind + the consistency test.
8. Every existing phase-1 test stays green.

- [ ] Steps: failing tests → implement → `npm run test:unit -- motionx` all green → typecheck the text module (no output) → commit `feat(motionx): letter loops (wave, bounce, jitter), Decode and Slot slide — per-cell characters and reels`.

---

### Task 2: Draw substitute characters and reels

**Files:**
- Modify: `frontend/app/lib/motionx/text/draw.ts`
- Test: `frontend/tests/unit/motionx/text-draw.unit.spec.ts`

**What to build** — in `drawTextCells`, inside the existing per-cell `save/restore`:
- clip: use `clip.pad ?? 0.15` for the vertical pad (today a hard-coded 0.15).
- `d.char` present → `paint(d.char)` instead of `paint(cells[i].char)`.
- `d.reel` present → after the cell transform, for each index `k` from `floor(pos) − 1` to `ceil(pos) + 1` that exists in `reel.chars` and is a non-empty string: `ctx.save(); ctx.translate(0, (k − reel.pos) × cell.h × reel.roll); paint(reel.chars[k]); ctx.restore()`. (`roll = 1`: the character at `pos` sits centred, the next one waits BELOW and travels up.) Non-finite `pos` → skip the cell.
- `movingTextFrame`'s complex-script guard is unchanged. Nothing else changes; a frame with neither field draws exactly as in phase 1.

**Tests** (extend the recording-ctx harness already in the spec): a substitute char is what reaches `fillText`; a reel at `pos = 2.5` inks exactly the characters at indices 1–4 that exist, at `translate(0, ±0.5h …)` offsets with the right sign for `roll` 1 and −1; `''` entries ink nothing; `pad: 0` produces a clip rect of exactly `clip.h` (and the default still pads 15%); save/restore stay balanced (equal counts) with reels; phase-1 sequences unchanged (existing tests).

- [ ] Steps: failing tests → implement → `npm run test:unit -- motionx/text-draw motionx` green → typecheck → commit `feat(motionx): per-letter drawing inks substitute characters and slot reels`.

---

### Task 3: Gallery, labels, inspector

**Files:**
- Modify: `frontend/app/lib/motionx/gallery.ts`, `frontend/app/lib/motionx/bands.ts`, `frontend/app/components/vue-canvas/compositor/MotionGallery.vue`, `frontend/app/components/vue-canvas/compositor/MotionInspector.vue`
- Test: `frontend/tests/unit/motionx/gallery.unit.spec.ts`, `frontend/tests/unit/motionx/bands.unit.spec.ts`

**What to build**
- Gallery (Letters group, `needs: 'text'`), after the phase-1 tiles: `letters-decode` ("Decode", `text.decode`, `{ dir: 'resolve' }`, cycle 1.5), `letters-slot` ("Slot slide", `text.slot`, `{ dir: 'in', roll: 'up' }`, cycle 1.6), `letters-wave` ("Wave", `text.wave`, cycle 3), `letters-bounce` ("Bounce", `text.bounce`, cycle 3), `letters-jitter` ("Jitter", `text.jitter`, cycle 3). New `PreviewKind`s `letters-decode | letters-slot | letters-wave | letters-bounce | letters-jitter` with CSS-only previews on the word "Type" (decode: letters swap via stacked spans with `steps()` opacity; slot: each letter in an `overflow:hidden` box with a 3-glyph column translating up and easing out; wave / bounce / jitter: per-letter `translateY` / shake with staggered `animation-delay`). Respect `prefers-reduced-motion`.
- Labels: "Decode" / "Decode out", "Slot slide" / "Slot slide out", "Wave", "Bounce", "Jitter".
- Inspector (behaviour branch, `text.*`):
  - Show the **Easing** block only when `textBehaviourUsesEase(kind, params)` (import from `~/lib/motionx/text`). This also hides it for Typewriter and for Scramble in Snap mode.
  - Loops: hide Stagger and the "Each piece runs for" line; show "Amount (letter heights)" (step 0.01, min 0), "Speed (per second)" (step 0.1, min 0.1), and for wave/bounce "Offset between pieces" (step 0.01, min 0). Order stays. Shuffle shows for Jitter.
  - Decode: Direction (Resolve · Dissolve), Characters (Same as the text · Letters · Numbers · Symbols · Mixed), Flicker rate (per second, step 1, min 1). Shuffle shows.
  - Slot slide: Direction (In · Out), Roll (Rolls up · Rolls down), **Steps** (integer, step 1, min 1, max 40, title "How many characters roll past before it lands"), Filler (same five options). Shuffle shows.
  - Test ids: `loop-amount`, `loop-speed`, `loop-offset`, `decode-dir`, `decode-charset`, `decode-rate`, `slot-dir`, `slot-roll`, `slot-steps`, `slot-filler` (segmented: id on the wrapper, `data-value` on each option). Defaults shown must equal the evaluator's defaults. Number fields never emit NaN (reuse the inspector's existing guard helpers).
- Tests: catalog allow-lists extended; the five new moves are text-only; each label.

- [ ] Steps: failing tests → implement → `npm run test:unit -- motionx` green → typecheck the four files clean → commit `feat(compositor): Decode, Slot slide and letter loops in the gallery + inspector; easing hidden where it does nothing`.

---

### Task 4: Close out

- [ ] Controller: live checks (Wave on straight text; Decode resolve; Slot slide with Steps 3 vs 12 and a spring; Slot on text on a circle; easing hidden on Typewriter / Snap), final whole-feature review on the most capable model, fixes, ledger + memory.
