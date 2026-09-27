# Characters rework — stages 0–2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop sending the combined sheet grid to Seedance (stage 0). Give the character record the rework's data: face, character-level photos, clothes, checks and made-from stamps (stage 1). Add an AWS Rekognition face checker that scores a character's photos and sheet panels against her approved face (stage 2).

**Architecture:**
- **Stage 0** changes one shared helper and the Shot Director's cast step.
- **Stage 1** extends `shared/characters/types.ts` and the registry's read-time hygiene/conversion in `server/utils/characterRegistry.ts`. Old records are converted when read, never rewritten by a migration. Nothing in the UI changes yet.
- **Stage 2** adds:
  - pure planning/verdict logic (`server/utils/faceCheck/plan.ts`)
  - an image prep + Rekognition wrapper (`server/utils/faceCheck/rekognition.ts`)
  - one route, `POST /api/characters-local/check`, that checks what's unchecked, writes the results into the record and returns it.

**Tech Stack:** Nuxt 4 / Nitro (TypeScript), Vitest (`tests/unit/**/*.unit.spec.ts`, node env), Playwright E2E, `sharp` (already a dependency), `@aws-sdk/client-rekognition` (new).

**Spec:** `docs/superpowers/specs/2026-09-26-characters-rework-design.md`. Read its plain-language summary, "The model (data)", "Checks" and "What gets sent" before starting.

## Global Constraints

- **Work in the main checkout.**
  - No worktree, no branch, never `git stash`.
  - Never run `npm run dev`. `:3002` is shared, and killing it can take ComfyUI down with it.
- **Commit through a private index every time,** and stage only your own paths:
  ```bash
  export GIT_INDEX_FILE=$(mktemp)            # fresh, NEVER cp .git/index
  git read-tree HEAD
  git add <only your paths>
  git diff --cached --stat                   # confirm only your files
  git commit -m "..."
  unset GIT_INDEX_FILE
  ```
  Then, **in a separate Bash call**, run `git reset -q -- <the same paths>` to resync the shared index.
- **End commit messages** with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Run unit tests** from `frontend/`: `npx vitest run <file>`. The suite is `tests/unit/**/*.unit.spec.ts`.
- **Typecheck against the drifting baseline:** `npx nuxi typecheck 2>&1 | grep -E "error TS" > /tmp/tc.txt; wc -l < /tmp/tc.txt`. A task may not add errors that name a file it touched.
- **Stored field names stay as they are:** `states`, `descriptor`, `refImages`, `bodyShape`. The UI already says "looks" and "description". Renaming the stored keys would ripple through ~20 files for no user-visible gain. This is a deliberate deviation from the spec's `looks`/`description` names.
- **Old records are converted when read** (`parseCharacterRecord`). No script rewrites `models/characters/*.json`.
- **Paid calls need the user's explicit go-ahead in chat:** AWS Rekognition at $0.001/image, and any fal call. Tests use fakes and spend nothing.
- **Face-check thresholds** live in one constant, `FACE_THRESHOLDS`, and Task 9 calibrates them. Scores are stored on AWS's 0–100 scale.
- **Changing AWS account settings is the user's action:** the Organizations AI-services opt-out and creating keys. Tasks never do it, only document it.
- **UI copy rules** (for any message a user can see): sentence case, no internal identifiers, plain words.

---

## File structure

| File | Responsibility |
|---|---|
| `frontend/shared/characters/types.ts` | Types for face, photos, clothes, checks, made-from; `videoIdentityRefs()`; `emptyState()` defaults |
| `frontend/server/utils/characterRegistry.ts` | Hygiene for the new fields; read-time conversion; healing of vanished files |
| `frontend/server/utils/characterStatePatch.ts` | Per-look patch accepts `clothes` and `face` |
| `frontend/server/api/characters-local.patch.ts` | Record-level `face`, `photos`, `voice`, `origin`, `likenessConfirmed` |
| `frontend/server/api/characters-local.post.ts` | New records carry `origin` + `likenessConfirmed` |
| `frontend/app/lib/shotdirector/cast.ts` | Up to 2 same-person refs per member; clause says so |
| `frontend/app/composables/useCharacters.ts` | `resolveStateRefs` sends `videoIdentityRefs` |
| `frontend/app/components/vue-canvas/ShotDirectorSurface.vue` | Cast preview shows what is actually sent |
| `frontend/server/utils/faceCheck/plan.ts` (new) | Pure: which pictures need a check, against which face; score → verdict; applying results |
| `frontend/server/utils/faceCheck/rekognition.ts` (new) | Image prep (pad, JPEG, size cap) and `compareFaces()` over an injectable client |
| `frontend/server/api/characters-local/check.post.ts` (new) | Route: gate, rate-limit, run checks, write the record |
| `frontend/scripts/face-check-calibrate.ts` (new) | One-off paid calibration run on Jene and Reva |

---

## STAGE 0 — Seedance stops receiving the grid

### Task 1: `videoIdentityRefs()` — at most two same-person pictures for video

The combined sheet reads as several people to Seedance. ByteDance's guide recommends a headshot plus one full-body picture. The two panels come from one generation pipeline, so they show one person. With no panels, send only the cover: two photos could be two different people, as Jene's are.

**Files:**
- Modify: `frontend/shared/characters/types.ts` (after `identityRefs`, ~line 90)
- Test: `frontend/tests/unit/character-model.unit.spec.ts`

**Interfaces:**
- Produces: `export function videoIdentityRefs(state?: CharacterState): string[]`. It returns bare filenames, length 0–2: `[portrait, body-front]` panels when present (either may be missing), otherwise `[cover]`.

- [ ] **Step 1: Write the failing tests.** Append to `tests/unit/character-model.unit.spec.ts`, and add `videoIdentityRefs` to the existing import from `'#shared/characters/types'`:

```ts
describe('videoIdentityRefs', () => {
  it('sends the portrait and full-body front panels, never the sheet', () => {
    const s = state({
      sheetImage: 'sheet.png', refImages: ['a.png'], coverIndex: 0,
      panels: [
        { slot: 'face-smile', filename: 'smile.png' },
        { slot: 'body-front', filename: 'front.png' },
        { slot: 'portrait', filename: 'portrait.png' },
      ],
    })
    expect(videoIdentityRefs(s)).toEqual(['portrait.png', 'front.png'])
  })
  it('sends whichever of the two panels exists', () => {
    const s = state({ panels: [{ slot: 'body-front', filename: 'front.png' }], refImages: ['a.png'] })
    expect(videoIdentityRefs(s)).toEqual(['front.png'])
  })
  it('falls back to the cover alone — never two photos, which may be two people', () => {
    const s = state({ refImages: ['a.png', 'b.png', 'c.png'], coverIndex: 1 })
    expect(videoIdentityRefs(s)).toEqual(['b.png'])
  })
  it('is empty for an empty look', () => {
    expect(videoIdentityRefs(state({}))).toEqual([])
    expect(videoIdentityRefs(undefined)).toEqual([])
  })
})
```

- [ ] **Step 2: Run the tests to check they fail.**
  - Run: `cd frontend && npx vitest run tests/unit/character-model.unit.spec.ts`
  - Expected: FAIL, `videoIdentityRefs is not a function` (or an export error).

- [ ] **Step 3: Implement.** In `shared/characters/types.ts`, directly after `identityRefs`:

```ts
/**
 * What a VIDEO model gets for one character look: at most two pictures of the
 * same person. The combined sheet grid is never sent — Seedance's own guide
 * warns multi-view images read as several people. Portrait + full-body front
 * come from one generation, so they are one person; without panels, only the
 * cover (two photos could be two different people).
 */
export function videoIdentityRefs(state?: CharacterState): string[] {
  if (!state) return []
  const panels = [panelFilename(state, 'portrait'), panelFilename(state, 'body-front')]
    .filter((f): f is string => !!f)
  if (panels.length) return panels
  const cover = coverFirstRefs(state)[0]
  return cover ? [cover] : []
}
```

- [ ] **Step 4: Run the tests to check they pass.**
  - Run: `npx vitest run tests/unit/character-model.unit.spec.ts`
  - Expected: PASS (all tests, the older `identityRefs` ones included).

- [ ] **Step 5: Commit** `shared/characters/types.ts` and the test, with the private-index recipe: `feat(characters): videoIdentityRefs — at most two same-person pictures for video`.

### Task 2: The Shot Director sends portrait + full body, and says they are one person

**Files:**
- Modify: `frontend/app/composables/useCharacters.ts:9,84-93`
- Modify: `frontend/app/lib/shotdirector/cast.ts` (the `CAST_REF_CAP` comment + value, the budget warning, `castClause`)
- Modify: `frontend/app/components/vue-canvas/ShotDirectorSurface.vue:74-85`
- Test: `frontend/tests/unit/shotdirector-cast.unit.spec.ts`, `frontend/tests/character-sheet.spec.ts` (E2E)

**Interfaces:**
- Consumes: `videoIdentityRefs` (Task 1).
- Produces: `CAST_REF_CAP = 2`, and `castClause` output such as `Characters: Reva (soaked jacket) @Image1 @Image2 (the same person).`

- [ ] **Step 1: Rewrite the unit tests that encode "one cover".** In `tests/unit/shotdirector-cast.unit.spec.ts`:

  **1a.** Replace the test `'injects one cover ref per member (cast-first) and renumbers manual refs after'` with:

```ts
  it('injects up to two refs per member (cast-first) and renumbers manual refs after', () => {
    const s = sheetWithCast()
    s.references = [{ kind: 'image', slot: 1, src: U('manual.png'), role: 'style-transfer' }]
    const { sheet } = materializeCast(s, { reva: [U('rp'), U('rb'), U('extra')], marcus: [U('m1')] }, SEEDANCE_PROFILE)
    const imgs = sheet.references.filter(r => r.kind === 'image')
    expect(imgs.map(r => [r.slot, r.src, r.castSlug ?? null])).toEqual([
      [1, U('rp'), 'reva'], [2, U('rb'), 'reva'], [3, U('m1'), 'marcus'], [4, U('manual.png'), null],
    ])
    expect(imgs[0]!.role).toBe('identity-lock')
  })
```

  **1b.** Replace `'sends only the cover (one ref) per member, however many photos resolve'` with:

```ts
  it('sends at most two refs per member, however many resolve', () => {
    const s = sheetWithCast()
    s.cast = [s.cast[0]!]
    const { sheet } = materializeCast(s, { reva: [U('1'), U('2'), U('3'), U('4')] }, SEEDANCE_PROFILE)
    expect(sheet.references.filter(r => r.castSlug === 'reva').map(r => r.src)).toEqual([U('1'), U('2')])
  })
```

  **1c.** In `'still gives each member exactly one cover when manual refs are present (no squeeze)'`:
  - rename it to `'gives each member their two refs when they fit the budget'`;
  - change both `toHaveLength(1)` to `toHaveLength(2)`;
  - update the comment to `// 5 manual + 2×2 = 9 ≤ 9 → fits`.

  **1d.** In `'warns with "remove manual references" when budget < members (overcap)'`, keep the body but change the resolved map to two refs each, so the warning counts real refs: `{ a: [U('1'), U('1b')], b: [U('2'), U('2b')], c: [U('3'), U('3b')] }`.

  **1e.** Add a clause test inside the `castClause` describe block (or append a new `describe('castClause', …)` if none exists):

```ts
  it('marks a member with two pictures as one person', () => {
    const s = createDefaultShotSheet()
    s.cast = [{ slug: 'reva', name: 'Reva', via: 'picker', stateId: null }]
    const { sheet } = materializeCast(s, { reva: [U('p'), U('b')] }, SEEDANCE_PROFILE)
    expect(castClause(sheet, SEEDANCE_PROFILE, { reva: 'soaked jacket' }))
      .toBe('Characters: Reva (soaked jacket) @Image1 @Image2 (the same person).')
  })
  it('leaves a one-picture member unchanged', () => {
    const s = createDefaultShotSheet()
    s.cast = [{ slug: 'reva', name: 'Reva', via: 'picker', stateId: null }]
    const { sheet } = materializeCast(s, { reva: [U('p')] }, SEEDANCE_PROFILE)
    expect(castClause(sheet, SEEDANCE_PROFILE)).toBe('Characters: Reva @Image1.')
  })
```

  Before relying on the tag format, check how `profile.refTag` renders a tag: `grep -n "refTag\|atTag" frontend/app/lib/shotdirector/profiles.ts`. If the existing tests expect `[Image1]` rather than `@Image1`, use that form in both expectations.

- [ ] **Step 2: Run the tests to check they fail.**
  - Run: `npx vitest run tests/unit/shotdirector-cast.unit.spec.ts`
  - Expected: FAIL on the four changed/added cases (1 ref instead of 2, and no "(the same person)").

- [ ] **Step 3: Implement `cast.ts`.**

  **3a.** Replace the `CAST_REF_CAP` block with:

```ts
// Identity references sent per cast member: at most two pictures of ONE person
// (portrait + full-body front panel, or the cover alone — see
// videoIdentityRefs). Never the combined sheet grid and never several photos:
// Seedance maps visibly different views/people to distinct subjects, and the
// clause marks the pair as one person.
export const CAST_REF_CAP = 2
```

  **3b.** Replace the budget warning block (`const manualImages = … if (manualImages + members.length > profile.maxRefImages) {…}`) with:

```ts
  const manualImages = manual.filter(r => r.kind === 'image').length
  const castImages = members.reduce((n, m) => n + Math.min(CAST_REF_CAP, (resolved[m.slug] ?? []).length), 0)
  if (manualImages + castImages > profile.maxRefImages) {
    issues.push({
      level: 'warning', code: 'cast-refs-squeezed',
      message: `Manual references leave no room in the ${profile.maxRefImages}-image budget for all ${members.length} cast members — remove some manual references.`,
    })
  }
```

  **3c.** Update the loop comment to `// resolved[slug] is videoIdentityRefs order (portrait, body-front) — see useCharacters.`

  **3d.** In `castClause`, change the `.map` body to:

```ts
    .map((m) => {
      const tagList = bySlug.get(m.slug)!
      const tags = tagList.join(' ') + (tagList.length > 1 ? ' (the same person)' : '')
      const d = descriptors?.[m.slug]?.trim()
      return d ? `${m.name} (${d}) ${tags}` : `${m.name} ${tags}`
    })
```

- [ ] **Step 4: Implement the resolver and preview.**

  **4a.** In `useCharacters.ts`, change the import to include `videoIdentityRefs`, and in `resolveStateRefs` replace `identityRefs(state).map(viewRefUrl)` with `videoIdentityRefs(state).map(viewRefUrl)`. Update its doc comment to: `Resolve picks to the /view URLs a VIDEO model gets: at most two same-person pictures (videoIdentityRefs).` Leave the `identityRefs` import if other code in the file still uses it; delete it otherwise.

  **4b.** In `ShotDirectorSurface.vue` `castRefRows`, replace the two comment lines and `.slice(0, 1)` with:

```ts
    // What is actually sent: up to CAST_REF_CAP pictures of one person.
    const urls = resolved[m.slug]?.slice(0, CAST_REF_CAP) ?? []
```

  Add `import { CAST_REF_CAP } from '~/lib/shotdirector/cast'` if it isn't imported yet (`grep -n "shotdirector/cast" frontend/app/components/vue-canvas/ShotDirectorSurface.vue`).

- [ ] **Step 5: Run the unit tests.**
  - Run: `npx vitest run tests/unit/shotdirector-cast.unit.spec.ts tests/unit/characters-composable.unit.spec.ts tests/unit/shotdirector-compile.unit.spec.ts`
  - Expected: PASS. If `characters-composable` asserts that the sheet leads `resolveStateRefs`, update that expectation to the `videoIdentityRefs` order: portrait, then body-front, else the cover.

- [ ] **Step 6: Update the E2E fixture and assertions** in `tests/character-sheet.spec.ts`.

  **6a.** In `FIXTURE`, set the default state's panels:

```ts
      panels: [
        { slot: 'portrait', filename: 'portrait-cal.png' },
        { slot: 'body-front', filename: 'front-cal.png' },
      ],
```

  **6b.** Replace the Scenario A `image_urls[0]` assertions (lines ~199-200) with:

```ts
    expect(modelOptions.image_urls[0]).toContain('filename=portrait-cal.png')
    expect(modelOptions.image_urls[1]).toContain('filename=front-cal.png')
    expect(modelOptions.image_urls.some((u: string) => u.includes(SHEET_FILENAME)), 'the combined sheet is never sent to video').toBe(false)
```

  **6c.** In Scenario B, keep `expect(widgetByName(imageNode, 'image')).toBe(SHEET_FILENAME)`. The image path is unchanged until stage 6. Replace its comment with `// The image path still uses the sheet (stage 6 of the rework changes it); video no longer does.`

  **6d.** Do not run Playwright yourself unless `:3002` is healthy: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3002/api/characters-local` must print 200. If it is healthy, run `cd frontend && npx playwright test tests/character-sheet.spec.ts -g "Scenario A"` and expect PASS. If it isn't, report the E2E as owed; do not start a server.

- [ ] **Step 7: Commit** the five touched files through the private index: `fix(shotdirector): send portrait + full-body front, never the combined sheet, and mark them as one person`.

---

## STAGE 1 — The character record learns the rework's data

### Task 3: New types and their hygiene

**Files:**
- Modify: `frontend/shared/characters/types.ts`
- Modify: `frontend/server/utils/characterRegistry.ts` (`stateHygiene` + new hygiene helpers)
- Test: `frontend/tests/unit/character-registry.unit.spec.ts`

**Interfaces:**
- Produces (in `shared/characters/types.ts`, all exported):

```ts
export type CheckVerdict = 'match' | 'unsure' | 'different' | 'no-face'
export interface Check {
  verdict: CheckVerdict
  /** Similarity on the checker's scale (AWS Rekognition: 0–100). Absent for 'no-face'. */
  score?: number
  /** The face filename this check compared against — a different face makes the check stale. */
  against: string
  lookFit?: 'ok' | 'off'
  note?: string
  at: string
}
export interface FaceRef { filename: string; approvedAt: string }
/** Fractions of the image (0..1) — which person, for photos with two people. */
export interface FaceBox { x: number; y: number; w: number; h: number }
export interface Photo { filename: string; check: Check | null; crop?: FaceBox }
export interface Garment { id: string; filename: string; name: string }
export interface MadeFrom { face: string; clothesKey: string; bodyKey: string; model: string }
export interface VoiceRef { kind: 'stock' | 'trained'; id: string; label: string }
export type CharacterOrigin = 'described' | 'photos' | 'canvas'
```

- `CharacterPanel` becomes `{ slot: PanelSlot; filename: string; check?: Check | null; madeFrom?: MadeFrom | null }`.
- `CharacterState` gains `clothes: Garment[]` and `face: FaceRef | null`. `emptyState` sets `clothes: []` and `face: null`.
- `CharacterRecord` gains `face: FaceRef | null`, `photos: Photo[]`, `voice: VoiceRef | null`, `origin: CharacterOrigin` and `likenessConfirmed: boolean`.
- In `characterRegistry.ts`, exported: `checkHygiene(v: unknown): Check | null`, `faceRefHygiene(v: unknown): FaceRef | null`, `photoHygiene(v: unknown): Photo | null`, `garmentHygiene(v: unknown): Garment | null`, `voiceHygiene(v: unknown): VoiceRef | null`.

- [ ] **Step 1: Write the failing tests.** Append to `tests/unit/character-registry.unit.spec.ts`, adding the five helpers to its import from `'~~/server/utils/characterRegistry'` (match the file's existing import path style):

```ts
describe('rework field hygiene', () => {
  it('checkHygiene keeps a well-formed check and drops junk', () => {
    expect(checkHygiene({ verdict: 'match', score: 97.2, against: 'f.png', at: 't' }))
      .toEqual({ verdict: 'match', score: 97.2, against: 'f.png', at: 't' })
    expect(checkHygiene({ verdict: 'nope', against: 'f.png', at: 't' })).toBeNull()
    expect(checkHygiene({ verdict: 'match', against: '../x', at: 't' })).toBeNull()
    expect(checkHygiene({ verdict: 'unsure', score: 250, against: 'f.png', at: 't' })!.score).toBe(100)
    expect(checkHygiene(null)).toBeNull()
  })
  it('faceRefHygiene needs a safe filename', () => {
    expect(faceRefHygiene({ filename: 'f.png', approvedAt: 't' })).toEqual({ filename: 'f.png', approvedAt: 't' })
    expect(faceRefHygiene({ filename: 'a/b.png' })).toBeNull()
  })
  it('photoHygiene keeps check and a clamped crop', () => {
    expect(photoHygiene({ filename: 'p.png', check: null, crop: { x: -1, y: 0.2, w: 0.5, h: 2 } }))
      .toEqual({ filename: 'p.png', check: null, crop: { x: 0, y: 0.2, w: 0.5, h: 1 } })
    expect(photoHygiene({ filename: '' })).toBeNull()
  })
  it('garmentHygiene needs id, filename and a name', () => {
    expect(garmentHygiene({ id: 'g1', filename: 'coat.png', name: 'Green waxed raincoat' }))
      .toEqual({ id: 'g1', filename: 'coat.png', name: 'Green waxed raincoat' })
    expect(garmentHygiene({ id: 'g1', filename: 'coat.png', name: '  ' })).toBeNull()
  })
  it('voiceHygiene accepts stock and trained voices only', () => {
    expect(voiceHygiene({ kind: 'stock', id: 'warm', label: 'Warm, low' })).toEqual({ kind: 'stock', id: 'warm', label: 'Warm, low' })
    expect(voiceHygiene({ kind: 'cloned', id: 'x', label: 'x' })).toBeNull()
  })
  it('stateHygiene carries clothes, look face and panel checks', () => {
    const s = stateHygiene({
      id: 'default', label: 'Everyday',
      clothes: [{ id: 'g1', filename: 'coat.png', name: 'Raincoat' }, { id: 'bad' }],
      face: { filename: 'heavier.png', approvedAt: 't' },
      panels: [{ slot: 'portrait', filename: 'p.png', check: { verdict: 'match', score: 99, against: 'f.png', at: 't' },
        madeFrom: { face: 'f.png', clothesKey: 'g1', bodyKey: '', model: 'gpt-image-2.5-sunburst' } }],
    })!
    expect(s.clothes).toEqual([{ id: 'g1', filename: 'coat.png', name: 'Raincoat' }])
    expect(s.face).toEqual({ filename: 'heavier.png', approvedAt: 't' })
    expect(s.panels[0]!.check!.verdict).toBe('match')
    expect(s.panels[0]!.madeFrom!.model).toBe('gpt-image-2.5-sunburst')
  })
  it('stateHygiene gives an old look empty clothes and no face', () => {
    const s = stateHygiene({ id: 'default', label: 'Default', panels: [{ slot: 'portrait', filename: 'p.png' }] })!
    expect(s.clothes).toEqual([])
    expect(s.face).toBeNull()
    expect(s.panels[0]!.check ?? null).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to check they fail.**
  - Run: `npx vitest run tests/unit/character-registry.unit.spec.ts`
  - Expected: FAIL (missing exports).

- [ ] **Step 3: Add the types** to `shared/characters/types.ts`:
  - Paste the interface block from **Interfaces** above, directly after `export interface StressResult …`.
  - Change `CharacterPanel` to `export interface CharacterPanel { slot: PanelSlot; filename: string; check?: Check | null; madeFrom?: MadeFrom | null }`.
  - Add to `CharacterState`, after `sheetImage`:

```ts
  /** Clothing pieces for this look, their photos kept (sent as their own references). */
  clothes: Garment[]
  /** This look's own face, set when a body change moves the face and the user approves it. Null → the character's face. */
  face: FaceRef | null
```

  - Add to `CharacterRecord`, after `slug`:

```ts
  /** The approved face — the anchor every picture is checked against. */
  face: FaceRef | null
  /** Photos of who she is, for all looks (was per-look refImages; those stay for old consumers). */
  photos: Photo[]
  voice: VoiceRef | null
  origin: CharacterOrigin
  /** The creator confirmed the right to use this person's likeness (photo/canvas origins). */
  likenessConfirmed: boolean
```

  - In `emptyState`, add `clothes: [], face: null,` to the returned object.

- [ ] **Step 4: Add the hygiene helpers** to `characterRegistry.ts`, after `validRefFilename`. Extend the type import to include `Check, FaceRef, Photo, Garment, VoiceRef, MadeFrom, FaceBox`.

```ts
const VERDICTS = new Set(['match', 'unsure', 'different', 'no-face'])
const clamp01 = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0)
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null

export function checkHygiene(v: unknown): Check | null {
  const o = obj(v)
  if (!o || !VERDICTS.has(o.verdict as string) || !validRefFilename(o.against as string)) return null
  const out: Check = { verdict: o.verdict as Check['verdict'], against: o.against as string, at: typeof o.at === 'string' ? o.at : '' }
  if (typeof o.score === 'number' && Number.isFinite(o.score)) out.score = Math.min(100, Math.max(0, o.score))
  if (o.lookFit === 'ok' || o.lookFit === 'off') out.lookFit = o.lookFit
  if (typeof o.note === 'string' && o.note) out.note = o.note
  return out
}

export function faceRefHygiene(v: unknown): FaceRef | null {
  const o = obj(v)
  if (!o || !validRefFilename(o.filename as string)) return null
  return { filename: o.filename as string, approvedAt: typeof o.approvedAt === 'string' ? o.approvedAt : '' }
}

function faceBoxHygiene(v: unknown): FaceBox | undefined {
  const o = obj(v)
  if (!o) return undefined
  return { x: clamp01(o.x), y: clamp01(o.y), w: clamp01(o.w), h: clamp01(o.h) }
}

export function photoHygiene(v: unknown): Photo | null {
  const o = obj(v)
  if (!o || !validRefFilename(o.filename as string)) return null
  const p: Photo = { filename: o.filename as string, check: checkHygiene(o.check) }
  const crop = faceBoxHygiene(o.crop)
  if (crop) p.crop = crop
  return p
}

export function garmentHygiene(v: unknown): Garment | null {
  const o = obj(v)
  if (!o || typeof o.id !== 'string' || !o.id || !validRefFilename(o.filename as string)) return null
  const name = typeof o.name === 'string' ? o.name.trim() : ''
  return name ? { id: o.id, filename: o.filename as string, name } : null
}

export function voiceHygiene(v: unknown): VoiceRef | null {
  const o = obj(v)
  if (!o || (o.kind !== 'stock' && o.kind !== 'trained') || typeof o.id !== 'string' || !o.id) return null
  return { kind: o.kind, id: o.id, label: typeof o.label === 'string' ? o.label : o.id }
}

function madeFromHygiene(v: unknown): MadeFrom | null {
  const o = obj(v)
  if (!o || typeof o.face !== 'string' || typeof o.model !== 'string') return null
  return { face: o.face, clothesKey: typeof o.clothesKey === 'string' ? o.clothesKey : '', bodyKey: typeof o.bodyKey === 'string' ? o.bodyKey : '', model: o.model }
}
```

- [ ] **Step 5: Extend `stateHygiene`.**

  **5a.** Replace its `panels` computation with:

```ts
  const panels = (Array.isArray(v.panels) ? v.panels : [])
    .filter((p): p is CharacterPanel =>
      !!p && typeof p === 'object'
      && PANEL_SLOTS.has((p as CharacterPanel).slot)
      && validRefFilename((p as CharacterPanel).filename))
    .map((p) => {
      const out: CharacterPanel = { slot: p.slot, filename: p.filename }
      const check = checkHygiene(p.check)
      const madeFrom = madeFromHygiene(p.madeFrom)
      if (check) out.check = check
      if (madeFrom) out.madeFrom = madeFrom
      return out
    })
```

  **5b.** Add to the returned object, after `sheetImage,`:

```ts
    clothes: (Array.isArray(v.clothes) ? v.clothes : []).map(garmentHygiene).filter((g): g is Garment => !!g),
    face: faceRefHygiene(v.face),
```

- [ ] **Step 6: Run the tests to check they pass.**
  - Run: `npx vitest run tests/unit/character-registry.unit.spec.ts tests/unit/character-model.unit.spec.ts tests/unit/character-state-patch.unit.spec.ts`
  - Expected: PASS. If an older test builds a `CharacterState` literal and compares it with `toEqual`, add `clothes: [], face: null` to that literal. This is expected churn from the new required fields.

- [ ] **Step 7: Typecheck.** Run the baseline command from Global Constraints. Fix every *new* error that names `CharacterState`, `CharacterRecord` or `CharacterPanel`: add `clothes: [], face: null` to state literals, and the five record fields to record literals such as test fixtures and `characters-local.post.ts`. Task 5 finishes the POST route properly, so for now give it `face: null, photos: [], voice: null, origin: 'photos', likenessConfirmed: false`.

- [ ] **Step 8: Commit** the touched files: `feat(characters): record types for face, photos, clothes, checks and made-from stamps`.

### Task 4: Read-time conversion of old records, and healing the new files

**Files:**
- Modify: `frontend/server/utils/characterRegistry.ts` (`parseCharacterRecord`, `healRefImages`)
- Test: `frontend/tests/unit/character-registry.unit.spec.ts`

**Interfaces:**
- Consumes: Task 3's hygiene helpers and types.
- Produces: `parseCharacterRecord` always returns the five new record fields. The conversion rules:
  - `photos` = the stored `photos` if the record has them; otherwise the union of every state's `refImages`, default state first, deduplicated, each as `{ filename, check: null }`.
  - `face` = the stored `face`; otherwise the default state's cover, as `{ filename, approvedAt: '' }`; otherwise `null`.
  - `origin` = the stored value if valid, else `'photos'`. Every existing character was made from photos.
  - `likenessConfirmed` = `r.likenessConfirmed === true`.
  - `voice` = `voiceHygiene(r.voice)`.
- `healRefImages` also drops vanished `photos`, vanished `clothes`, and a vanished record or look `face`, setting it to `null`. All of these count toward `dropped`.

- [ ] **Step 1: Write the failing tests** (append):

```ts
describe('read-time conversion for the rework', () => {
  const era2 = JSON.stringify({
    name: 'Jene',
    variants: [
      { id: 'default', label: 'Default', refImages: ['a.png', 'b.png'], coverIndex: 1 },
      { id: 'wet', label: 'Wet', refImages: ['b.png', 'c.png'], coverIndex: 0 },
    ],
  })
  it('builds character photos from every look, default first, without duplicates', () => {
    const r = parseCharacterRecord(era2, 'jene')!
    expect(r.photos.map(p => p.filename)).toEqual(['a.png', 'b.png', 'c.png'])
    expect(r.photos.every(p => p.check === null)).toBe(true)
  })
  it('takes the face from the default look\'s cover', () => {
    expect(parseCharacterRecord(era2, 'jene')!.face).toEqual({ filename: 'b.png', approvedAt: '' })
  })
  it('defaults origin to photos, likeness unconfirmed, no voice', () => {
    const r = parseCharacterRecord(era2, 'jene')!
    expect(r.origin).toBe('photos')
    expect(r.likenessConfirmed).toBe(false)
    expect(r.voice).toBeNull()
  })
  it('keeps stored rework fields as they are', () => {
    const r = parseCharacterRecord(JSON.stringify({
      name: 'Maren', origin: 'described', likenessConfirmed: false,
      face: { filename: 'f.png', approvedAt: '2026-09-27T00:00:00.000Z' },
      photos: [{ filename: 'f.png', check: { verdict: 'match', score: 100, against: 'f.png', at: 't' } }],
      voice: { kind: 'stock', id: 'warm', label: 'Warm, low' },
      states: [{ id: 'default', label: 'Everyday', refImages: [] }],
    }), 'maren')!
    expect(r.origin).toBe('described')
    expect(r.face!.filename).toBe('f.png')
    expect(r.photos[0]!.check!.verdict).toBe('match')
    expect(r.voice!.id).toBe('warm')
  })
  it('a character with no photos at all has no face', () => {
    const r = parseCharacterRecord(JSON.stringify({ name: 'X', states: [{ id: 'default', label: 'D', refImages: [] }] }), 'x')!
    expect(r.face).toBeNull()
    expect(r.photos).toEqual([])
  })
})

describe('healRefImages for rework fields', () => {
  it('drops vanished photos, clothes and faces', () => {
    const r = parseCharacterRecord(JSON.stringify({
      name: 'R', face: { filename: 'gone-face.png', approvedAt: '' },
      photos: [{ filename: 'keep.png' }, { filename: 'gone.png' }],
      states: [{ id: 'default', label: 'D', refImages: ['keep.png'],
        clothes: [{ id: 'g', filename: 'gone-coat.png', name: 'Coat' }], face: { filename: 'gone-look.png', approvedAt: '' } }],
    }), 'r')!
    const { record, dropped } = healRefImages(r, f => f === 'keep.png')
    expect(record.photos.map(p => p.filename)).toEqual(['keep.png'])
    expect(record.face).toBeNull()
    expect(record.states[0]!.clothes).toEqual([])
    expect(record.states[0]!.face).toBeNull()
    expect(dropped).toBe(4)
  })
})
```

- [ ] **Step 2: Run the tests to check they fail.**
  - Run: `npx vitest run tests/unit/character-registry.unit.spec.ts`
  - Expected: FAIL (`photos` undefined, etc.).

- [ ] **Step 3: Implement the conversion.**

  **3a.** In `parseCharacterRecord`, after the block that orders `default` first and before `return`, add:

```ts
  const storedPhotos = Array.isArray(r.photos)
    ? (r.photos as unknown[]).map(photoHygiene).filter((p): p is Photo => !!p)
    : null
  const photos: Photo[] = storedPhotos ?? (() => {
    const seen = new Set<string>()
    const out: Photo[] = []
    for (const s of states) for (const f of s.refImages) {
      if (!seen.has(f)) { seen.add(f); out.push({ filename: f, check: null }) }
    }
    return out
  })()
  const defaultCover = coverFirstRefs(states[0])[0]
  const face = faceRefHygiene(r.face) ?? (defaultCover ? { filename: defaultCover, approvedAt: '' } : null)
  const ORIGINS = new Set(['described', 'photos', 'canvas'])
```

  **3b.** Add to the returned object: `face, photos, voice: voiceHygiene(r.voice), origin: ORIGINS.has(r.origin as string) ? r.origin as CharacterRecord['origin'] : 'photos', likenessConfirmed: r.likenessConfirmed === true,`.

  **3c.** Import `coverFirstRefs` from `'#shared/characters/types'`.

- [ ] **Step 4: Extend `healRefImages`.**

  **4a.** Inside the `record.states.map` callback, before `return`, add:

```ts
    const keptClothes = v.clothes.filter(g => exists(g.filename))
    totalDropped += v.clothes.length - keptClothes.length
    const lookFaceVanished = v.face !== null && !exists(v.face.filename)
    if (lookFaceVanished) totalDropped += 1
```

  Add `clothes: keptClothes, face: lookFaceVanished ? null : v.face,` to the returned state.

  **4b.** After the map, before `if (!totalDropped)`:

```ts
  const keptPhotos = record.photos.filter(p => exists(p.filename))
  totalDropped += record.photos.length - keptPhotos.length
  const faceVanished = record.face !== null && !exists(record.face.filename)
  if (faceVanished) totalDropped += 1
```

  **4c.** Change the final return to `record: { ...record, states: healed, photos: keptPhotos, face: faceVanished ? null : record.face }`.

- [ ] **Step 5: Run the tests to check they pass.**
  - Run: `npx vitest run tests/unit/character-registry.unit.spec.ts tests/unit/characters-composable.unit.spec.ts`
  - Expected: PASS.

- [ ] **Step 6: Check against the real records, read-only.**
  - Run: `cd frontend && npx tsx -e "import {parseCharacterRecord} from './server/utils/characterRegistry'; import fs from 'node:fs'; for (const f of fs.readdirSync('../models/characters')) { const r = parseCharacterRecord(fs.readFileSync('../models/characters/'+f,'utf8'), f.replace('.json','')); console.log(r!.slug, r!.face?.filename, r!.photos.length, r!.origin) }"`
  - Expected: five lines. `jene` has face `sd-ref_1783013794598_sheet_1783013794582_0.png` and 4 photos; the other characters also have 4–5 photos.
  - If `tsx` isn't available, skip this step and say so.

- [ ] **Step 7: Commit** `characterRegistry.ts` and the test: `feat(characters): old records read with face and character-level photos; healing covers the new files`.

### Task 5: Writing the new fields

**Files:**
- Modify: `frontend/server/utils/characterStatePatch.ts` (`StatePatchBody`, `ALLOWED`, `CONTENT_KEYS`)
- Modify: `frontend/server/api/characters-local.patch.ts` (record-level fields)
- Modify: `frontend/server/api/characters-local.post.ts` (`origin`, `likenessConfirmed`)
- Test: `frontend/tests/unit/character-state-patch.unit.spec.ts`

**Interfaces:**
- Produces:
  - `statePatch.patch` may carry `clothes: Garment[]` and `face: FaceRef | null`. Both count as content edits.
  - The PATCH body may carry, at record level:
    - `face: { filename } | null`. The server stamps `approvedAt` with the current time.
    - `photos: Photo[]`, cleaned by `photoHygiene`.
    - `voice: VoiceRef | null`.
    - `likenessConfirmed: boolean`.
  - The POST body may carry `origin: CharacterOrigin` (default `'photos'`) and `likenessConfirmed: boolean`.

- [ ] **Step 1: Write the failing tests** (append to `tests/unit/character-state-patch.unit.spec.ts`; reuse the file's existing record-builder helper — check with `sed -n 1,40p`):

```ts
describe('rework fields in a look patch', () => {
  it('accepts clothes and a look face, cleaned', () => {
    const rec = /* the file's existing helper that builds a record with a 'default' state */ makeRecord()
    const res = applyStatePatch(rec, {
      stateId: 'default',
      patch: { clothes: [{ id: 'g1', filename: 'coat.png', name: 'Raincoat' }, { id: 'x' } as any], face: { filename: 'heavier.png', approvedAt: 't' } },
    }, 'now')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const s = res.record.states.find(s => s.id === 'default')!
    expect(s.clothes).toEqual([{ id: 'g1', filename: 'coat.png', name: 'Raincoat' }])
    expect(s.face).toEqual({ filename: 'heavier.png', approvedAt: 't' })
  })
})
```

If the file has no `makeRecord`-style helper, build the record inline with `parseCharacterRecord(JSON.stringify({ name: 'R', states: [{ id: 'default', label: 'D', refImages: [] }] }), 'r')!`.

- [ ] **Step 2: Run the test to check it fails.**
  - Run: `npx vitest run tests/unit/character-state-patch.unit.spec.ts`
  - Expected: FAIL (`Unknown patch key 'clothes'`).

- [ ] **Step 3: Implement the patch.** In `characterStatePatch.ts`:
  - Add `'clothes' | 'face'` to the `Pick` in `StatePatchBody`.
  - Add both to `ALLOWED` and to `CONTENT_KEYS`.
  - After `let next: CharacterState = { ...state, ...patch }`, re-clean them:

```ts
  if (patch.clothes !== undefined) next = { ...next, clothes: (Array.isArray(patch.clothes) ? patch.clothes : []).map(garmentHygiene).filter((g): g is Garment => !!g) }
  if (patch.face !== undefined) next = { ...next, face: faceRefHygiene(patch.face) }
```

  Import `garmentHygiene, faceRefHygiene` from `./characterRegistry` and `Garment` from the shared types.

- [ ] **Step 4: Run the test to check it passes.**
  - Run: `npx vitest run tests/unit/character-state-patch.unit.spec.ts`
  - Expected: PASS.

- [ ] **Step 5: Implement the record-level fields in the PATCH route.**

  **5a.** Extend the body type with:

```ts
    face?: { filename: string } | null, photos?: unknown[], voice?: unknown, likenessConfirmed?: boolean,
```

  **5b.** After the `bodyShape` line, add:

```ts
  if (body.face !== undefined) {
    if (body.face === null) record.face = null
    else {
      const f = faceRefHygiene({ filename: body.face?.filename, approvedAt: new Date().toISOString() })
      if (!f) throw createError({ statusCode: 400, message: 'Invalid face' })
      record.face = f
    }
  }
  if (Array.isArray(body.photos)) record.photos = body.photos.map(photoHygiene).filter((p): p is Photo => !!p)
  if (body.voice !== undefined) record.voice = body.voice === null ? null : voiceHygiene(body.voice)
  if (typeof body.likenessConfirmed === 'boolean') record.likenessConfirmed = body.likenessConfirmed
```

  Import the helpers and `Photo`. `origin` is deliberately not patchable: where a character came from doesn't change.

- [ ] **Step 6: Implement the POST route.**

  **6a.** Change the body type to `{ name?: string, origin?: string, likenessConfirmed?: boolean }`.

  **6b.** Build the record with:

```ts
    face: null, photos: [], voice: null,
    origin: body?.origin === 'described' || body?.origin === 'canvas' ? body.origin : 'photos',
    likenessConfirmed: body?.likenessConfirmed === true,
```

- [ ] **Step 7: Run the whole character test group and typecheck.**
  - Run: `npx vitest run tests/unit/character-*.unit.spec.ts tests/unit/characters-composable.unit.spec.ts tests/unit/shotdirector-cast.unit.spec.ts`
  - Expected: PASS.
  - Typecheck: no new errors that name the touched files.

- [ ] **Step 8: Commit** the four files: `feat(characters): write face, photos, voice, likeness and look clothes`.

---

## STAGE 2 — The face checker (AWS Rekognition Compare faces)

### Task 6: Pure planning, verdicts and applying results

**Files:**
- Create: `frontend/server/utils/faceCheck/plan.ts`
- Test: `frontend/tests/unit/face-check-plan.unit.spec.ts`

**Interfaces:**
- Consumes: the types from Task 3.
- Produces:

```ts
export const FACE_THRESHOLDS = { match: 90, unsure: 70 }   // AWS 0–100 scale; PROVISIONAL — Task 9 calibrates
export type CheckTarget =
  | { kind: 'photo'; filename: string; against: string }
  | { kind: 'panel'; stateId: string; slot: PanelSlot; filename: string; against: string }
export function faceFor(record: CharacterRecord, stateId: string | null): string | null
export function planChecks(record: CharacterRecord): CheckTarget[]
export function verdictFor(score: number | null, t?: { match: number; unsure: number }): CheckVerdict
export function applyChecks(record: CharacterRecord, results: { target: CheckTarget; score: number | null }[], now: string): CharacterRecord
```

`planChecks` rules:
- Body panels (`body-front`, `body-back`) are never face-checked. They are headless by design.
- A picture that *is* the face file is never sent to AWS; `applyChecks` isn't needed for it, because `planChecks` skips it and `applyChecks` stamps such items automatically. See below.
- A picture needs a check when its `check` is null, or `check.against !== faceFor(...)`.
- Photos are checked against the record face. A look's panels are checked against the look's face if it has one, otherwise the record face.
- No face → nothing to plan.

`verdictFor`:
- `null` → `'no-face'`
- `≥ match` → `'match'`
- `≥ unsure` → `'unsure'`
- anything else → `'different'`

`applyChecks`:
- Writes `{ verdict, score?, against, at: now }` onto each target.
- Also stamps the face file itself, anywhere it appears as a photo or panel, as `{ verdict: 'match', score: 100, against, at: now }`.
- Returns a new record; the input is never mutated.

- [ ] **Step 1: Write the failing tests** in `tests/unit/face-check-plan.unit.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseCharacterRecord } from '~~/server/utils/characterRegistry'
import { applyChecks, faceFor, FACE_THRESHOLDS, planChecks, verdictFor } from '~~/server/utils/faceCheck/plan'

function rec(extra: Record<string, unknown> = {}) {
  return parseCharacterRecord(JSON.stringify({
    name: 'Jene', face: { filename: 'face.png', approvedAt: 't0' },
    photos: [{ filename: 'face.png' }, { filename: 'blonde.png' }],
    states: [
      { id: 'default', label: 'Everyday', refImages: [], panels: [
        { slot: 'portrait', filename: 'portrait.png' },
        { slot: 'body-front', filename: 'front.png' },
        { slot: 'face-smile', filename: 'smile.png', check: { verdict: 'match', score: 99, against: 'face.png', at: 't' } },
      ] },
      { id: 'heavy', label: 'Heavier', refImages: [], face: { filename: 'heavy-face.png', approvedAt: 't1' },
        panels: [{ slot: 'portrait', filename: 'heavy-portrait.png' }] },
    ],
    ...extra,
  }), 'jene')!
}

describe('faceFor', () => {
  it('uses the look face when set, else the character face', () => {
    expect(faceFor(rec(), 'heavy')).toBe('heavy-face.png')
    expect(faceFor(rec(), 'default')).toBe('face.png')
    expect(faceFor(rec(), null)).toBe('face.png')
  })
})

describe('planChecks', () => {
  it('plans unchecked photos and face panels, skips body panels, the face itself and fresh checks', () => {
    const plan = planChecks(rec())
    expect(plan).toEqual([
      { kind: 'photo', filename: 'blonde.png', against: 'face.png' },
      { kind: 'panel', stateId: 'default', slot: 'portrait', filename: 'portrait.png', against: 'face.png' },
      { kind: 'panel', stateId: 'heavy', slot: 'portrait', filename: 'heavy-portrait.png', against: 'heavy-face.png' },
    ])
  })
  it('re-plans a check made against an older face', () => {
    const r = rec({ face: { filename: 'new-face.png', approvedAt: 't2' } })
    expect(planChecks(r).some(t => t.kind === 'panel' && t.slot === 'face-smile')).toBe(true)
  })
  it('plans nothing without a face', () => {
    const r = rec()
    expect(planChecks({ ...r, face: null, states: r.states.map(s => ({ ...s, face: null })) })).toEqual([])
  })
})

describe('verdictFor', () => {
  it('maps scores through the thresholds', () => {
    expect(verdictFor(null)).toBe('no-face')
    expect(verdictFor(FACE_THRESHOLDS.match)).toBe('match')
    expect(verdictFor(FACE_THRESHOLDS.match - 0.1)).toBe('unsure')
    expect(verdictFor(FACE_THRESHOLDS.unsure)).toBe('unsure')
    expect(verdictFor(FACE_THRESHOLDS.unsure - 0.1)).toBe('different')
  })
})

describe('applyChecks', () => {
  it('writes results, stamps the face itself as a match, and does not mutate', () => {
    const r = rec()
    const before = JSON.stringify(r)
    const plan = planChecks(r)
    const out = applyChecks(r, [
      { target: plan[0]!, score: 41 },
      { target: plan[1]!, score: 97 },
      { target: plan[2]!, score: null },
    ], 'now')
    expect(JSON.stringify(r)).toBe(before)
    expect(out.photos.find(p => p.filename === 'blonde.png')!.check).toEqual({ verdict: 'different', score: 41, against: 'face.png', at: 'now' })
    expect(out.photos.find(p => p.filename === 'face.png')!.check).toEqual({ verdict: 'match', score: 100, against: 'face.png', at: 'now' })
    const def = out.states.find(s => s.id === 'default')!
    expect(def.panels.find(p => p.slot === 'portrait')!.check!.verdict).toBe('match')
    const heavy = out.states.find(s => s.id === 'heavy')!
    expect(heavy.panels[0]!.check).toEqual({ verdict: 'no-face', against: 'heavy-face.png', at: 'now' })
  })
})
```

- [ ] **Step 2: Run the tests to check they fail.**
  - Run: `npx vitest run tests/unit/face-check-plan.unit.spec.ts`
  - Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `server/utils/faceCheck/plan.ts`:

```ts
/**
 * Pure face-check planning for the characters rework (spec: Checks). Decides
 * which pictures need a check and against which face, turns a similarity into
 * a verdict, and writes results back. No IO — the route and the AWS wrapper
 * live elsewhere, so this unit-tests without a network.
 */
import type { CharacterRecord, CheckVerdict, PanelSlot } from '#shared/characters/types'

/** AWS Rekognition similarity, 0–100. PROVISIONAL until the calibration run (plan Task 9). */
export const FACE_THRESHOLDS = { match: 90, unsure: 70 }

const HEADLESS: ReadonlySet<PanelSlot> = new Set(['body-front', 'body-back'])

export type CheckTarget =
  | { kind: 'photo'; filename: string; against: string }
  | { kind: 'panel'; stateId: string; slot: PanelSlot; filename: string; against: string }

export function faceFor(record: CharacterRecord, stateId: string | null): string | null {
  const look = stateId ? record.states.find(s => s.id === stateId) : undefined
  return look?.face?.filename ?? record.face?.filename ?? null
}

export function planChecks(record: CharacterRecord): CheckTarget[] {
  const out: CheckTarget[] = []
  const recordFace = faceFor(record, null)
  if (recordFace) {
    for (const p of record.photos) {
      if (p.filename === recordFace) continue
      if (!p.check || p.check.against !== recordFace) out.push({ kind: 'photo', filename: p.filename, against: recordFace })
    }
  }
  for (const s of record.states) {
    const face = faceFor(record, s.id)
    if (!face) continue
    for (const p of s.panels) {
      if (HEADLESS.has(p.slot) || p.filename === face) continue
      if (!p.check || p.check.against !== face) out.push({ kind: 'panel', stateId: s.id, slot: p.slot, filename: p.filename, against: face })
    }
  }
  return out
}

export function verdictFor(score: number | null, t = FACE_THRESHOLDS): CheckVerdict {
  if (score === null) return 'no-face'
  if (score >= t.match) return 'match'
  if (score >= t.unsure) return 'unsure'
  return 'different'
}

export function applyChecks(
  record: CharacterRecord,
  results: { target: CheckTarget; score: number | null }[],
  now: string,
): CharacterRecord {
  const mk = (score: number | null, against: string) => {
    const verdict = verdictFor(score)
    return score === null ? { verdict, against, at: now } : { verdict, score, against, at: now }
  }
  const photoRes = new Map<string, { score: number | null; against: string }>()
  const panelRes = new Map<string, { score: number | null; against: string }>()
  for (const { target, score } of results) {
    if (target.kind === 'photo') photoRes.set(target.filename, { score, against: target.against })
    else panelRes.set(`${target.stateId}\u0000${target.slot}`, { score, against: target.against })
  }
  const recordFace = faceFor(record, null)
  const photos = record.photos.map((p) => {
    if (recordFace && p.filename === recordFace) return { ...p, check: mk(100, recordFace) }
    const r = photoRes.get(p.filename)
    return r ? { ...p, check: mk(r.score, r.against) } : p
  })
  const states = record.states.map((s) => {
    const face = faceFor(record, s.id)
    return {
      ...s,
      panels: s.panels.map((p) => {
        if (face && p.filename === face) return { ...p, check: mk(100, face) }
        const r = panelRes.get(`${s.id}\u0000${p.slot}`)
        return r ? { ...p, check: mk(r.score, r.against) } : p
      }),
    }
  })
  return { ...record, photos, states }
}
```

- [ ] **Step 4: Run the tests to check they pass.**
  - Run: `npx vitest run tests/unit/face-check-plan.unit.spec.ts`
  - Expected: PASS.

- [ ] **Step 5: Commit** `plan.ts` and its test: `feat(characters): face-check planning and verdicts (pure)`.

### Task 7: Image prep and the Rekognition wrapper

**Files:**
- Modify: `frontend/package.json` (dependency `@aws-sdk/client-rekognition`)
- Modify: `frontend/nuxt.config.ts` (`runtimeConfig`: `awsRegion`, `awsAccessKeyId`, `awsSecretAccessKey`)
- Create: `frontend/server/utils/faceCheck/rekognition.ts`
- Test: `frontend/tests/unit/face-check-rekognition.unit.spec.ts`

**Interfaces:**
- Produces:

```ts
export async function prepareForCompare(input: Buffer): Promise<Buffer>
export interface CompareClient { send(cmd: CompareFacesCommand): Promise<CompareFacesCommandOutput> }
export function rekognitionClient(cfg: { region: string; accessKeyId?: string; secretAccessKey?: string }): CompareClient
/** Best similarity (0–100) of any face in `target` to the face in `source`; null when the target has no face. Throws FaceCheckError('no-source-face') when the source has none. */
export async function compareFaces(client: CompareClient, source: Buffer, target: Buffer): Promise<number | null>
export class FaceCheckError extends Error { constructor(public code: 'no-source-face' | 'aws', message: string) }
```

`prepareForCompare`:
- rotates by EXIF;
- fits inside 1600×1600 without enlarging;
- pads 40% of the longer side on every edge with mid-grey `{ r: 128, g: 128, b: 128 }`, because detectors miss faces that fill the frame;
- encodes to JPEG at quality 88, well under Rekognition's 5 MB bytes limit.

- [ ] **Step 1: Install the SDK.**
  - Run: `cd frontend && npm install @aws-sdk/client-rekognition@^3`
  - Expected: `package.json` gains the dependency.
  - This only edits the lockfile; it doesn't start a server.

- [ ] **Step 2: Add the config.** In `nuxt.config.ts` `runtimeConfig`, after `anthropicApiKey`:

```ts
    // Server-only AWS credentials for the character face checker (AWS
    // Rekognition CompareFaces, $0.001/image). NUXT_AWS_REGION /
    // NUXT_AWS_ACCESS_KEY_ID / NUXT_AWS_SECRET_ACCESS_KEY. Empty keys → the
    // SDK's default chain (env AWS_*, profile). Account must have the
    // Organizations AI-services opt-out set (spec: Checks).
    awsRegion: 'us-east-1',
    awsAccessKeyId: '',
    awsSecretAccessKey: '',
```

- [ ] **Step 3: Write the failing tests** in `tests/unit/face-check-rekognition.unit.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { compareFaces, FaceCheckError, prepareForCompare, type CompareClient } from '~~/server/utils/faceCheck/rekognition'

async function png(w: number, h: number) {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 10, b: 10 } } }).png().toBuffer()
}

describe('prepareForCompare', () => {
  it('pads 40% of the longer side on every edge and encodes JPEG', async () => {
    const out = await prepareForCompare(await png(100, 50))
    const meta = await sharp(out).metadata()
    expect(meta.format).toBe('jpeg')
    expect(meta.width).toBe(100 + 2 * 40)
    expect(meta.height).toBe(50 + 2 * 40)
  })
  it('shrinks large images to fit 1600 before padding', async () => {
    const meta = await sharp(await prepareForCompare(await png(4000, 2000))).metadata()
    expect(meta.width).toBe(1600 + 2 * 640)
  })
})

function fakeClient(out: unknown | Error): CompareClient {
  return { send: async () => { if (out instanceof Error) throw out; return out as any } }
}

describe('compareFaces', () => {
  const b = Buffer.from('x')
  it('returns the best match similarity', async () => {
    const c = fakeClient({ FaceMatches: [{ Similarity: 71.2 }, { Similarity: 98.4 }], UnmatchedFaces: [] })
    expect(await compareFaces(c, b, b)).toBe(98.4)
  })
  it('returns 0 when the target has faces but none match', async () => {
    expect(await compareFaces(fakeClient({ FaceMatches: [], UnmatchedFaces: [{}] }), b, b)).toBe(0)
  })
  it('returns null when the target has no face', async () => {
    expect(await compareFaces(fakeClient({ FaceMatches: [], UnmatchedFaces: [] }), b, b)).toBeNull()
  })
  it('turns AWS "no face in source" into a FaceCheckError', async () => {
    const e = Object.assign(new Error('Request has invalid parameters'), { name: 'InvalidParameterException' })
    await expect(compareFaces(fakeClient(e), b, b)).rejects.toMatchObject({ code: 'no-source-face' })
  })
  it('wraps other AWS failures', async () => {
    await expect(compareFaces(fakeClient(new Error('boom')), b, b)).rejects.toBeInstanceOf(FaceCheckError)
  })
})
```

- [ ] **Step 4: Run the tests to check they fail.**
  - Run: `npx vitest run tests/unit/face-check-rekognition.unit.spec.ts`
  - Expected: FAIL (module not found).

- [ ] **Step 5: Implement** `server/utils/faceCheck/rekognition.ts`:

```ts
/**
 * AWS Rekognition CompareFaces for the character face checker (spec: Checks).
 * Stateless — nothing is stored at AWS. $0.001 per call. The client is
 * injectable so tests never touch the network.
 */
import sharp from 'sharp'
import { CompareFacesCommand, RekognitionClient, type CompareFacesCommandOutput } from '@aws-sdk/client-rekognition'

export class FaceCheckError extends Error {
  constructor(public code: 'no-source-face' | 'aws', message: string) { super(message) }
}

export interface CompareClient { send(cmd: CompareFacesCommand): Promise<CompareFacesCommandOutput> }

export function rekognitionClient(cfg: { region: string; accessKeyId?: string; secretAccessKey?: string }): CompareClient {
  const credentials = cfg.accessKeyId && cfg.secretAccessKey
    ? { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey }
    : undefined
  return new RekognitionClient({ region: cfg.region, credentials })
}

const MAX_SIDE = 1600
const PAD_FRACTION = 0.4

export async function prepareForCompare(input: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(input).rotate()
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    .toBuffer({ resolveWithObject: true })
  const pad = Math.round(Math.max(info.width, info.height) * PAD_FRACTION)
  return sharp(data)
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 128, g: 128, b: 128 } })
    .jpeg({ quality: 88 })
    .toBuffer()
}

export async function compareFaces(client: CompareClient, source: Buffer, target: Buffer): Promise<number | null> {
  let out: CompareFacesCommandOutput
  try {
    out = await client.send(new CompareFacesCommand({
      SourceImage: { Bytes: source },
      TargetImage: { Bytes: target },
      SimilarityThreshold: 0,
    }))
  } catch (e: any) {
    if (e?.name === 'InvalidParameterException') throw new FaceCheckError('no-source-face', 'No face found in the approved face picture.')
    throw new FaceCheckError('aws', `Face check failed: ${e?.message ?? 'unknown error'}`)
  }
  const matches = out.FaceMatches ?? []
  const unmatched = out.UnmatchedFaces ?? []
  if (!matches.length && !unmatched.length) return null
  return matches.reduce((best, m) => Math.max(best, m.Similarity ?? 0), 0)
}
```

- [ ] **Step 6: Run the tests to check they pass.**
  - Run: `npx vitest run tests/unit/face-check-rekognition.unit.spec.ts`
  - Expected: PASS.

- [ ] **Step 7: Commit** `package.json`, `package-lock.json` (or the repo's lockfile, check with `git status --short frontend/*lock*`), `nuxt.config.ts`, `rekognition.ts` and the test: `feat(characters): Rekognition Compare faces wrapper with padded JPEG prep`.

### Task 8: `POST /api/characters-local/check`

**Files:**
- Create: `frontend/server/utils/faceCheck/run.ts` (pure orchestration with injected IO)
- Create: `frontend/server/api/characters-local/check.post.ts`
- Test: `frontend/tests/unit/face-check-run.unit.spec.ts`

**Interfaces:**
- Consumes: `planChecks`, `applyChecks` (Task 6), and `compareFaces`, `prepareForCompare`, `FaceCheckError` (Task 7).
- Produces:

```ts
export const MAX_COMPARES_PER_CALL = 40
export interface RunDeps {
  readImage(filename: string): Promise<Buffer | null>   // null → file missing
  compare(source: Buffer, target: Buffer): Promise<number | null>
  now(): string
}
export async function runChecks(record: CharacterRecord, deps: RunDeps): Promise<{ record: CharacterRecord; compared: number; skipped: number }>
```

`runChecks` behaviour:
- Takes the first 40 targets from `planChecks`. The rest are left for the next call and counted in `skipped`.
- Prepares each face once, caching the prepared buffer per face filename.
- A missing target file is skipped silently. The heal pass removes it on the next read.
- A `no-source-face` error writes `{ verdict: 'no-face', against, at, note: 'No face found in the approved face picture' }` onto *every* target for that face, and makes no further calls for that face.
- Other errors propagate.

The route:
- validates `slug`;
- 404s an unknown character, with the ownership guard exactly as `characters-local.patch.ts` does it (`guardMutation(..., true)`);
- in hosted mode, refuses with 403 when `origin !== 'described' && !likenessConfirmed`: `Confirm you have the right to use this person's likeness first.`;
- rate-limits: `assertRateLimit(event, 'character-face-check', 10)`;
- builds `RunDeps` from the input dir, the Rekognition client and `new Date().toISOString()`;
- runs, writes the record with `updatedAt` refreshed, and returns `{ record, compared, skipped }`.

- [ ] **Step 1: Write the failing tests** in `tests/unit/face-check-run.unit.spec.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { parseCharacterRecord } from '~~/server/utils/characterRegistry'
import { FaceCheckError } from '~~/server/utils/faceCheck/rekognition'
import { MAX_COMPARES_PER_CALL, runChecks } from '~~/server/utils/faceCheck/run'

const rec = (photos: string[], face = 'face.png') => parseCharacterRecord(JSON.stringify({
  name: 'R', face: { filename: face, approvedAt: 't' }, photos: photos.map(f => ({ filename: f })),
  states: [{ id: 'default', label: 'D', refImages: [] }],
}), 'r')!

describe('runChecks', () => {
  it('compares each planned picture once against a face prepared once', async () => {
    const readImage = vi.fn(async (f: string) => Buffer.from(f))
    const compare = vi.fn(async (_s: Buffer, t: Buffer) => (t.toString() === 'a.png' ? 96 : 40))
    const { record, compared, skipped } = await runChecks(rec(['face.png', 'a.png', 'b.png']), { readImage, compare, now: () => 'now' })
    expect(compared).toBe(2)
    expect(skipped).toBe(0)
    expect(readImage.mock.calls.filter(c => c[0] === 'face.png')).toHaveLength(1)
    expect(record.photos.map(p => p.check?.verdict)).toEqual(['match', 'match', 'different'])
  })
  it('caps a call and reports what is left', async () => {
    const photos = Array.from({ length: MAX_COMPARES_PER_CALL + 5 }, (_, i) => `p${i}.png`)
    const out = await runChecks(rec(photos), { readImage: async f => Buffer.from(f), compare: async () => 95, now: () => 'n' })
    expect(out.compared).toBe(MAX_COMPARES_PER_CALL)
    expect(out.skipped).toBe(5)
  })
  it('skips missing files quietly', async () => {
    const out = await runChecks(rec(['gone.png']), { readImage: async f => (f === 'gone.png' ? null : Buffer.from(f)), compare: async () => 99, now: () => 'n' })
    expect(out.compared).toBe(0)
    expect(out.record.photos.find(p => p.filename === 'gone.png')!.check).toBeNull()
  })
  it('marks every target no-face when the approved face has no detectable face', async () => {
    const compare = vi.fn(async () => { throw new FaceCheckError('no-source-face', 'x') })
    const out = await runChecks(rec(['a.png', 'b.png']), { readImage: async f => Buffer.from(f), compare, now: () => 'n' })
    expect(compare).toHaveBeenCalledTimes(1)
    expect(out.record.photos.filter(p => p.filename !== 'face.png').every(p => p.check?.verdict === 'no-face' && p.check.note)).toBe(true)
  })
})
```

- [ ] **Step 2: Run the tests to check they fail.**
  - Run: `npx vitest run tests/unit/face-check-run.unit.spec.ts`
  - Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `server/utils/faceCheck/run.ts`:

```ts
/** Orchestrates one face-check pass over a character, IO injected (route builds the real deps). */
import type { CharacterRecord } from '#shared/characters/types'
import { applyChecks, planChecks, type CheckTarget } from './plan'
import { FaceCheckError } from './rekognition'

export const MAX_COMPARES_PER_CALL = 40

export interface RunDeps {
  readImage(filename: string): Promise<Buffer | null>
  compare(source: Buffer, target: Buffer): Promise<number | null>
  now(): string
}

const NO_SOURCE_NOTE = 'No face found in the approved face picture'

export async function runChecks(record: CharacterRecord, deps: RunDeps) {
  const plan = planChecks(record)
  const batch = plan.slice(0, MAX_COMPARES_PER_CALL)
  const skipped = plan.length - batch.length
  const faces = new Map<string, Buffer | null | 'no-face'>()
  const results: { target: CheckTarget; score: number | null }[] = []
  const noSource: CheckTarget[] = []
  let compared = 0

  for (const target of batch) {
    if (!faces.has(target.against)) faces.set(target.against, await deps.readImage(target.against))
    const face = faces.get(target.against)
    if (face === 'no-face') { noSource.push(target); continue }
    if (!face) continue
    const img = await deps.readImage(target.filename)
    if (!img) continue
    try {
      results.push({ target, score: await deps.compare(face, img) })
      compared++
    } catch (e) {
      if (e instanceof FaceCheckError && e.code === 'no-source-face') {
        faces.set(target.against, 'no-face')
        noSource.push(target)
        continue
      }
      throw e
    }
  }

  const now = deps.now()
  let next = applyChecks(record, results, now)
  if (noSource.length) {
    const note = (t: CheckTarget) => ({ verdict: 'no-face' as const, against: t.against, at: now, note: NO_SOURCE_NOTE })
    const photoSet = new Map(noSource.filter(t => t.kind === 'photo').map(t => [t.filename, t]))
    const panelSet = new Map(noSource.filter(t => t.kind === 'panel').map(t => [`${(t as any).stateId}\u0000${(t as any).slot}`, t]))
    next = {
      ...next,
      photos: next.photos.map(p => (photoSet.has(p.filename) ? { ...p, check: note(photoSet.get(p.filename)!) } : p)),
      states: next.states.map(s => ({
        ...s,
        panels: s.panels.map((p) => { const t = panelSet.get(`${s.id}\u0000${p.slot}`); return t ? { ...p, check: note(t) } : p }),
      })),
    }
  }
  return { record: next, compared, skipped }
}
```

Note that the "compares once" test counts one `compare` call per target, and one `readImage` for the face. The face buffer is read raw here; the route's `readImage` runs `prepareForCompare`, so both source and target are padded JPEGs.

- [ ] **Step 4: Run the tests to check they pass.**
  - Run: `npx vitest run tests/unit/face-check-run.unit.spec.ts tests/unit/face-check-plan.unit.spec.ts`
  - Expected: PASS.

- [ ] **Step 5: Implement the route** `server/api/characters-local/check.post.ts`. Check the exact import paths first: `grep -n "import" frontend/server/api/characters-local.patch.ts frontend/server/api/characters-local/absorb.post.ts`, and `grep -rn "export function deployMode" frontend/server/utils`.

```ts
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parseCharacterRecord, validRefFilename } from '~~/server/utils/characterRegistry'
import { guardMutation } from '~~/server/utils/ownedJsonStore'
import { deployMode } from '~~/server/utils/deployMode'
import { assertRateLimit } from '~~/server/lib/rateLimit'
import { compareFaces, prepareForCompare, rekognitionClient } from '~~/server/utils/faceCheck/rekognition'
import { runChecks } from '~~/server/utils/faceCheck/run'

export default defineEventHandler(async (event) => {
  assertRateLimit(event, 'character-face-check', 10)
  const body = await readBody(event) as { slug?: string }
  const slug = (body?.slug || '').trim()
  if (!slug || slug.includes('/') || slug.includes('\\') || slug.includes('..')) {
    throw createError({ statusCode: 400, message: 'Invalid slug' })
  }
  const dir = path.resolve(process.cwd(), '..', 'models', 'characters')
  const inputDir = path.resolve(process.cwd(), '..', 'input')
  const file = path.join(dir, `${slug}.json`)
  let record
  try { record = parseCharacterRecord(await fs.readFile(file, 'utf8'), slug) }
  catch { throw createError({ statusCode: 404, message: `No character '${slug}'` }) }
  if (!record) throw createError({ statusCode: 404, message: `No character '${slug}'` })
  await guardMutation({ kind: 'character', dir }, event.context?.userId ?? null, slug, true)

  if (deployMode() === 'hosted' && record.origin !== 'described' && !record.likenessConfirmed) {
    throw createError({ statusCode: 403, message: 'Confirm you have the right to use this person\'s likeness first.' })
  }

  const cfg = useRuntimeConfig(event)
  const client = rekognitionClient({ region: cfg.awsRegion as string, accessKeyId: cfg.awsAccessKeyId as string, secretAccessKey: cfg.awsSecretAccessKey as string })
  const result = await runChecks(record, {
    async readImage(filename) {
      if (!validRefFilename(filename)) return null
      try { return await prepareForCompare(await fs.readFile(path.join(inputDir, filename))) }
      catch { return null }
    },
    compare: (s, t) => compareFaces(client, s, t),
    now: () => new Date().toISOString(),
  })
  const next = { ...result.record, updatedAt: new Date().toISOString() }
  await fs.writeFile(file, JSON.stringify(next, null, 2))
  return { record: next, compared: result.compared, skipped: result.skipped }
})
```

  Nitro routes in this repo have no route-level test harness; it's an established pattern, noted in `characters-local.patch.ts`. The logic is covered by `runChecks`. Do not call this route yourself: it costs money. Task 9 runs it with the user's go-ahead.

- [ ] **Step 6: Typecheck.** No new errors naming `faceCheck/*` or `check.post.ts`.

- [ ] **Step 7: Commit** `run.ts`, `check.post.ts` and the test: `feat(characters): face-check route — checks unchecked pictures against the right face`.

### Task 9: Calibrate on Jene and Reva (paid, needs the user)

This task runs the real checker once, costing about $0.02, and sets `FACE_THRESHOLDS` from real scores. **Stop and ask the user before Step 3.**

**Files:**
- Create: `frontend/scripts/face-check-calibrate.ts`
- Modify: `frontend/server/utils/faceCheck/plan.ts` (`FACE_THRESHOLDS`, and its comment)
- Modify: `docs/superpowers/specs/2026-09-26-characters-rework-design.md` (the thresholds table in Checks)

- [ ] **Step 1: Ask the user for two things (their actions, not ours).**
  1. **AWS keys.** Create an IAM user limited to `rekognition:CompareFaces` and put its keys in `frontend/.env` as `NUXT_AWS_ACCESS_KEY_ID` and `NUXT_AWS_SECRET_ACCESS_KEY`, plus `NUXT_AWS_REGION` if not `us-east-1`.
  2. **The AI-services opt-out.** In AWS Organizations, set the AI services opt-out policy for Rekognition. Docs: https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_ai-opt-out.html

  Never read, print or type the key values yourself.

- [ ] **Step 2: Write the script** `frontend/scripts/face-check-calibrate.ts`. It compares fixed known pairs and prints scores. It never writes records.

```ts
/**
 * One-off calibration for the character face checker (plan Task 9). Compares
 * known same-person and different-person pairs from the real input dir and
 * prints AWS similarity scores. Costs one CompareFaces call per pair
 * ($0.001 each). Reads NUXT_AWS_* from the environment.
 * Run: cd frontend && npx tsx --env-file=.env scripts/face-check-calibrate.ts
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { compareFaces, prepareForCompare, rekognitionClient } from '../server/utils/faceCheck/rekognition'

const INPUT = path.resolve(process.cwd(), '..', 'input')
const JENE_FACE = 'sd-ref_1783013794598_sheet_1783013794582_0.png'
const REVA = ['sd-ref_1783013897018_sheet_1783013897004_0.png', 'sd-ref_1783013897049_sheet_1783013897042_1.png', 'sd-ref_1783013897084_sheet_1783013897076_2.png']
const PAIRS: [label: string, expect: 'same' | 'different', a: string, b: string][] = [
  ['Reva photo 1 vs 2', 'same', REVA[0]!, REVA[1]!],
  ['Reva photo 1 vs 3', 'same', REVA[0]!, REVA[2]!],
  ['Jene cover vs her portrait panel', 'same', JENE_FACE, 'sd-ref_1786681429486_sheet_portrait.png'],
  ['Jene cover vs blonde face panel', 'different', JENE_FACE, 'sd-ref_1786656610085_sheet_face-neutral.png'],
  ['Jene cover vs blonde smile panel', 'different', JENE_FACE, 'sd-ref_1786656610109_sheet_face-smile.png'],
  ['Jene cover vs blonde photo 2', 'different', JENE_FACE, 'sd-ref_1783013795096_sheet_1783013795083_1.png'],
  ['Jene cover vs dark profile photo 3', 'different', JENE_FACE, 'sd-ref_1783013796416_sheet_1783013796406_2.png'],
  ['Jene cover vs Reva', 'different', JENE_FACE, REVA[0]!],
]

const client = rekognitionClient({
  region: process.env.NUXT_AWS_REGION || 'us-east-1',
  accessKeyId: process.env.NUXT_AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.NUXT_AWS_SECRET_ACCESS_KEY,
})
const load = async (f: string) => prepareForCompare(await fs.readFile(path.join(INPUT, f)))
for (const [label, expect, a, b] of PAIRS) {
  const score = await compareFaces(client, await load(a), await load(b))
  console.log(`${expect.padEnd(9)} ${String(score === null ? 'no face' : score.toFixed(1)).padStart(7)}  ${label}`)
}
```

- [ ] **Step 3: With the user's go-ahead, run it.**
  - Run: `cd frontend && npx tsx --env-file=.env scripts/face-check-calibrate.ts`
  - Expected: 8 lines of scores. Copy them into your report exactly.

- [ ] **Step 4: Set the thresholds from the numbers.**
  - `match` = a round number just below the lowest `same` score, and at least 10 points above the highest `different` score.
  - `unsure` = midway between the highest `different` score and `match`, rounded.
  - If the two groups overlap, keep the provisional values, report the overlap, and stop. This is a design problem, not a tuning one.
  - Put the numbers in `FACE_THRESHOLDS` and replace `PROVISIONAL` in its comment with `Calibrated 2026-MM-DD on Jene/Reva: same ≥ X, different ≤ Y`.
  - Update the Checks table in the spec: new rows on the 0–100 scale, keeping the old ArcFace table as history.

- [ ] **Step 5: Run the plan tests again.**
  - Run: `npx vitest run tests/unit/face-check-plan.unit.spec.ts`
  - Expected: PASS. The verdict tests read `FACE_THRESHOLDS`, so they follow the new values.

- [ ] **Step 6: Commit** the script, `plan.ts` and the spec: `feat(characters): calibrate face-check thresholds on Jene and Reva`.

### Task 10: Record the state

**Files:**
- Modify: `docs/superpowers/specs/2026-09-26-characters-rework-design.md` (only if the build deviated from its stages)
- Modify: `docs/STATE.md` (one entry under the characters section)
- The build dashboard artifact (the repo memory rule `update-dashboard-on-every-commit`)

- [ ] **Step 1: Check the spec's build stages still match what was built.** Veo references and per-model sending are now stage 3 (moved up on 2026-09-26); stage 0 is the Seedance fix only. Adjust only if the build deviated.

- [ ] **Step 2: Add a STATE.md entry.** Write one short plain-language paragraph under the character-system section: stages 0–2 built; what changed for Seedance; the new record fields; the face checker; the calibration numbers, or "owed" if Task 9 hasn't run.

- [ ] **Step 3: Commit** both docs through the private index: `docs(characters): stages 0–2 state`.

- [ ] **Step 4: Update the dashboard** per the memory rule:
  - Read the live artifact first and rebuild from the saved file.
  - Replace, don't append: the Characters programme row, one Landed line, and the Owed checks (calibration and the stage-0 E2E if owed).

---

## Self-review notes

- **Spec coverage:**
  - The spec's stages 0 (Seedance), 1 and 2 are all covered. Veo and per-model sending are stage 3 (moved up on the user's call), which gets its own plan next.
  - The consent step is enforced server-side in hosted mode (Task 8). The consent *UI* belongs to stage 5, creation.
  - The AWS opt-out is the user's action (Task 9, Step 1).
  - Body presets and the voice picker UI are stage 4. The `voice` field is stored now.
- **Types used across tasks:**
  - `Check.against` (Task 3) is read by `planChecks`/`applyChecks` (Task 6) and `runChecks` (Task 8).
  - `CheckTarget` (Task 6) is used by `runChecks` (Task 8).
  - `FaceCheckError('no-source-face')` (Task 7) is caught in Task 8.
  - `videoIdentityRefs` (Task 1) is used in Task 2.
- **Known judgement calls:**
  - The stored key stays `states`.
  - `origin` isn't patchable.
  - Body panels are never face-checked.
  - The face picture is never sent to AWS against itself.
  - `MAX_COMPARES_PER_CALL = 40`, and the route is rate-limited to 10 calls a minute.
