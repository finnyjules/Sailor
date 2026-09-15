# Featured fonts tab — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Featured" font-picker tab that surfaces a curated free-font list; Google-available fonts resolve through the existing Google path, the rest are self-hosted like the Pangram library, with non-redistributable fonts gated by a build-time env flag.

**Architecture:** A seed file (`free-fonts.seed.json`) drives a new `bram-naus` foundry in the generated library manifest. The generator emits google-source families (no faces, resolved via Google) and self-hosted families (bundled files under `Assets/Fonts/Free Fonts/`). Three existing FontPicker components gain a "Featured" tab that reuses their existing Google and library pick handlers per row. No consumer/parent changes — self-hosted featured fonts flow through the identical `lib:` server path as Pangram, google ones through the existing `goog:` path.

**Tech Stack:** Nuxt 4 / Vue 3 / TypeScript, Node ESM generator scripts, fontkit, vitest.

## Global Constraints

- **Work in the main checkout.** No worktree/branch. Stage only your own hunks by exact path. Never `git stash`.
- **Private git index for EVERY commit** (shared checkout). Commit recipe, used verbatim in every commit step:
  ```bash
  export GIT_INDEX_FILE=$(mktemp /tmp/gidx.XXXXXX) && cp .git/index "$GIT_INDEX_FILE" \
    && git add <exact paths> \
    && git commit -m "<msg>

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" && rm -f "$GIT_INDEX_FILE"
  ```
- **Foundry id / label:** internal id `bram-naus`, user-facing label `Featured`.
- **UI copy:** sentence case, no lowercase-start labels (repo rule).
- **Env flag:** `BUNDLE_RESTRICTED_FONTS`. Unset → include restricted fonts (dev default). `=0` → exclude `redistributable:false` families. Hosted/prod build sets `=0`.
- **Manifest is generated, never hand-edited.** Regenerate with `cd frontend && node scripts/build-font-library.mjs`.
- **Dev server:** `:3002` is the main checkout's port. Check `lsof -nP -iTCP -sTCP:LISTEN | grep node` before starting; never let a subagent run `npm run dev` (it kills the shared `:3002`). After any frontend restart, check `127.0.0.1:8188/system_stats` and relaunch ComfyUI if gone.
- **Tests:** run from `frontend/` with `npx vitest run <file>`.

---

### Task 1: Manifest schema fields (forward-compatible)

Add optional fields to `LibraryFamily` and relax the manifest test so the new shapes (a third foundry, google-source families with zero faces, `.ttf`/`.woff2` srcs) are accepted. Safe on the current manifest — no runtime behavior changes yet.

**Files:**
- Modify: `frontend/shared/library-fonts.ts:15-23`
- Modify (test): `frontend/tests/unit/font-library-manifest.unit.spec.ts`

**Interfaces:**
- Produces: `LibraryFamily` with optional `source?: 'self-hosted' | 'google'`, `googleFamily?: string`, `license?: string`, `redistributable?: boolean`, `num?: number`. Absent `source` means `'self-hosted'`; absent `redistributable` means `true`.

- [ ] **Step 1: Update the manifest test to accept new shapes**

Replace the body of `frontend/tests/unit/font-library-manifest.unit.spec.ts` with:

```ts
// frontend/tests/unit/font-library-manifest.unit.spec.ts
import { describe, it, expect } from 'vitest'
import manifest from '../../app/data/library-fonts.manifest.json'
import type { LibraryManifest } from '../../shared/library-fonts'

const m = manifest as unknown as LibraryManifest

describe('generated library manifest', () => {
  it('includes the licensed foundries', () => {
    const ids = new Set(m.foundries.map(f => f.id))
    expect(ids.has('pangram')).toBe(true)
    expect(ids.has('off-type')).toBe(true)
    expect(m.families.length).toBeGreaterThan(60)
  })
  it('every family + face id is unique', () => {
    const famIds = m.families.map(f => f.id)
    expect(new Set(famIds).size).toBe(famIds.length)
    const faceIds = m.families.flatMap(f => f.faces.map(x => x.id))
    expect(new Set(faceIds).size).toBe(faceIds.length)
  })
  it('self-hosted faces have a weight in range, a style, a font src, a known foundry; google families have no faces', () => {
    const foundries = new Set(m.foundries.map(f => f.id))
    for (const fam of m.families) {
      expect(foundries.has(fam.foundry)).toBe(true)
      if (fam.source === 'google') {
        expect(fam.faces.length).toBe(0)
        expect(typeof fam.googleFamily).toBe('string')
        continue
      }
      expect(fam.faces.length).toBeGreaterThan(0)
      for (const face of fam.faces) {
        expect(face.weight).toBeGreaterThanOrEqual(1)
        expect(face.weight).toBeLessThanOrEqual(1000)
        expect(face.style.length).toBeGreaterThan(0)
        expect(/\.(otf|ttf|woff2)$/i.test(face.src)).toBe(true)
      }
    }
  })
  it('includes known flagship families', () => {
    const names = new Set(m.families.map(f => f.family))
    expect([...names].some(n => /Editorial New/i.test(n))).toBe(true)
    expect([...names].some(n => /Mori/i.test(n))).toBe(true)
  })
})
```

- [ ] **Step 2: Run it — passes on the current manifest**

Run: `cd frontend && npx vitest run tests/unit/font-library-manifest.unit.spec.ts`
Expected: PASS (current manifest has only otf, two foundries, no `source` fields).

- [ ] **Step 3: Add the optional fields to `LibraryFamily`**

In `frontend/shared/library-fonts.ts`, replace the `LibraryFamily` interface (lines 15-23) with:

```ts
export interface LibraryFamily {
  /** `${foundry}-${slug(family)}`. */
  id: string
  /** Typographic family name, e.g. "PP Editorial New". */
  family: string
  /** Foundry id: "pangram" | "off-type" | "bram-naus". */
  foundry: string
  faces: LibraryFace[]
  /** 'self-hosted' (bundled file) | 'google' (resolves via the Google path). Absent → 'self-hosted'. */
  source?: 'self-hosted' | 'google'
  /** Exact Google Fonts family name when source === 'google'. */
  googleFamily?: string
  /** SPDX-ish license tag, e.g. "OFL-1.1". */
  license?: string
  /** false → dropped from the build when BUNDLE_RESTRICTED_FONTS=0. Absent → true. */
  redistributable?: boolean
  /** Curation order (Bram's series number); Featured tab sort key. */
  num?: number
}
```

- [ ] **Step 4: Typecheck the shared type + rerun the test**

Run: `cd frontend && npx vitest run tests/unit/font-library-manifest.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
export GIT_INDEX_FILE=$(mktemp /tmp/gidx.XXXXXX) && cp .git/index "$GIT_INDEX_FILE" \
  && git add frontend/shared/library-fonts.ts frontend/tests/unit/font-library-manifest.unit.spec.ts \
  && git commit -m "feat(fonts): manifest schema fields for source/license/redistributable/num

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" && rm -f "$GIT_INDEX_FILE"
```

---

### Task 2: Generator — foundry mapping, wider walker, seed merge, restricted filter

Teach the pure generator helpers about the `bram-naus` foundry and the seed→families merge, and wire them into the fontkit adapter. Pure helpers are unit-tested; the adapter (fs/fontkit) is exercised by regenerating in Task 3.

**Files:**
- Modify: `frontend/scripts/fontLibrary.mjs`
- Modify: `frontend/scripts/build-font-library.mjs`
- Modify (test): `frontend/tests/unit/font-library-helpers.unit.spec.ts`

**Interfaces:**
- Consumes: `familyId(foundryId, family)`, `buildFamilies(records)` (existing, unchanged).
- Produces:
  - `foundryFromRelPath(relPath)` now returns `{ id:'bram-naus', label:'Featured' }` for paths under `Free Fonts/`.
  - `buildFeaturedFamilies(scannedBramFamilies, seed, { bundleRestricted })` → `LibraryFamily[]` for the `bram-naus` foundry, google + self-hosted, restricted-filtered, sorted by `num` then family.

- [ ] **Step 1: Write failing tests for the new helpers**

Append to `frontend/tests/unit/font-library-helpers.unit.spec.ts`:

```ts
import { buildFeaturedFamilies } from '../../scripts/fontLibrary.mjs'

describe('foundryFromRelPath — Featured bundle', () => {
  it('maps the Free Fonts bundle to bram-naus / Featured', () => {
    expect(foundryFromRelPath('Free Fonts/BDO Grotesk/BDOGrotesk-Regular.ttf'))
      .toEqual({ id: 'bram-naus', label: 'Featured' })
  })
})

describe('buildFeaturedFamilies', () => {
  const scanned = [{
    id: 'bram-naus-bdo-grotesk', family: 'BDO Grotesk', foundry: 'bram-naus',
    faces: [{ id: 'bram-naus-bdogrotesk-regular', weight: 400, style: 'Regular', italic: false, postscriptName: 'BDOGrotesk-Regular', src: 'Free Fonts/BDO Grotesk/BDOGrotesk-Regular.ttf' }],
  }]
  const seed = [
    { name: 'Sora', num: 26, source: 'google', googleFamily: 'Sora', license: 'OFL-1.1', redistributable: true },
    { name: 'BDO Grotesk', num: 112, source: 'self-hosted', license: 'OFL-1.1', redistributable: true },
    { name: 'Restricted Face', num: 200, source: 'self-hosted', license: 'Free-noredist', redistributable: false },
    { name: 'Missing Local', num: 300, source: 'self-hosted', license: 'OFL-1.1', redistributable: true },
  ]

  it('emits google families with no faces and a googleFamily', () => {
    const fams = buildFeaturedFamilies(scanned, seed, { bundleRestricted: true })
    const sora = fams.find(f => f.family === 'Sora')
    expect(sora).toMatchObject({ foundry: 'bram-naus', source: 'google', googleFamily: 'Sora', num: 26 })
    expect(sora.faces).toEqual([])
  })
  it('attaches license/num/source to a matched self-hosted family', () => {
    const fams = buildFeaturedFamilies(scanned, seed, { bundleRestricted: true })
    const bdo = fams.find(f => f.family === 'BDO Grotesk')
    expect(bdo).toMatchObject({ source: 'self-hosted', license: 'OFL-1.1', num: 112 })
    expect(bdo.faces.length).toBe(1)
  })
  it('drops a self-hosted seed entry with no scanned file', () => {
    const fams = buildFeaturedFamilies(scanned, seed, { bundleRestricted: true })
    expect(fams.some(f => f.family === 'Missing Local')).toBe(false)
  })
  it('drops non-redistributable families when bundleRestricted is false', () => {
    // Use a google restricted entry so the only reason to drop it is the flag
    // (a file-less self-hosted entry would be dropped regardless).
    const seed2 = [{ name: 'Sneaky', num: 47, source: 'google', googleFamily: 'Sneaky Times', redistributable: false }]
    expect(buildFeaturedFamilies([], seed2, { bundleRestricted: true }).length).toBe(1)
    expect(buildFeaturedFamilies([], seed2, { bundleRestricted: false }).length).toBe(0)
  })
  it('sorts by num then family', () => {
    const fams = buildFeaturedFamilies(scanned, seed, { bundleRestricted: true })
    const nums = fams.map(f => f.num)
    expect(nums).toEqual([...nums].sort((a, b) => a - b))
  })
})
```

- [ ] **Step 2: Run — fails (buildFeaturedFamilies not exported, Free Fonts unmapped)**

Run: `cd frontend && npx vitest run tests/unit/font-library-helpers.unit.spec.ts`
Expected: FAIL (`buildFeaturedFamilies is not a function`, and the Free Fonts mapping returns null).

- [ ] **Step 3: Implement the helpers in `fontLibrary.mjs`**

In `frontend/scripts/fontLibrary.mjs`, extend `foundryFromRelPath` (add the Free Fonts branch before `return null`):

```js
  if (top.startsWith('Free Fonts')) return { id: 'bram-naus', label: 'Featured' }
```

Then append this exported function:

```js
/**
 * Build the `bram-naus` (Featured) families from the seed, merged with the
 * self-hosted families already scanned from disk.
 *   scanned: LibraryFamily[] whose foundry === 'bram-naus' (from buildFamilies)
 *   seed:    Array<{ name, num?, source:'google'|'self-hosted', googleFamily?, license?, redistributable? }>
 *   opts.bundleRestricted: when false, drop entries with redistributable === false
 * A self-hosted seed entry with no matching scanned family is skipped (its file
 * hasn't been downloaded yet). Sorted by (num ?? Infinity) then family name.
 */
export function buildFeaturedFamilies(scanned, seed, { bundleRestricted } = {}) {
  const byFamily = new Map(scanned.map(f => [f.family, f]))
  const out = []
  for (const e of seed || []) {
    const redistributable = e.redistributable !== false
    if (!redistributable && !bundleRestricted) continue
    const base = { num: e.num, license: e.license, redistributable }
    if (e.source === 'google') {
      out.push({
        id: familyId('bram-naus', e.name),
        family: e.name,
        foundry: 'bram-naus',
        faces: [],
        source: 'google',
        googleFamily: e.googleFamily || e.name,
        ...base,
      })
    } else {
      const scannedFam = byFamily.get(e.name)
      if (!scannedFam) continue // file not downloaded yet — surfaced by the coverage report
      out.push({ ...scannedFam, source: 'self-hosted', ...base })
    }
  }
  out.sort((a, b) => (a.num ?? Infinity) - (b.num ?? Infinity) || a.family.localeCompare(b.family))
  return out
}
```

- [ ] **Step 4: Run the helper tests — pass**

Run: `cd frontend && npx vitest run tests/unit/font-library-helpers.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Wire the adapter in `build-font-library.mjs`**

Make these edits to `frontend/scripts/build-font-library.mjs`:

(a) Extend imports and the walker to accept ttf/woff2. Replace `walkOtf` with:

```js
const FONT_EXT = /\.(otf|ttf|woff2)$/i
/** Recursively list every font file under dir. */
function walkFontFiles(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walkFontFiles(full, acc)
    else if (FONT_EXT.test(name)) acc.push(full)
  }
  return acc
}
```

(b) Update the import line to add `buildFeaturedFamilies`, and add `readFileSync, existsSync`:

```js
import { readdirSync, statSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { foundryFromRelPath, isItalicFace, buildFamilies, buildFeaturedFamilies } from './fontLibrary.mjs'
```

(c) In `faceRecordFromFont`, change the filename fallbacks from `basename(relPath, '.otf')` to strip any font ext:

```js
  const stem = basename(relPath).replace(FONT_EXT, '')
  const family = rec.preferredFamily?.en || font.familyName || stem
  const style = rec.preferredSubfamily?.en || font.subfamilyName || 'Regular'
  ...
  const postscriptName = font.postscriptName || stem
```

(d) In `main()`, replace `const files = walkOtf(FONTS_ROOT)` with `const files = walkFontFiles(FONTS_ROOT)`, then replace the `buildFamilies` + `foundries` + `manifest` block with:

```js
  const allFamilies = buildFamilies(records)
  const licensed = allFamilies.filter(f => f.foundry !== 'bram-naus')
  const scannedBram = allFamilies.filter(f => f.foundry === 'bram-naus')

  const SEED = join(HERE, '..', 'app', 'data', 'free-fonts.seed.json')
  const seed = existsSync(SEED) ? JSON.parse(readFileSync(SEED, 'utf8')) : []
  const bundleRestricted = process.env.BUNDLE_RESTRICTED_FONTS !== '0'
  const featured = buildFeaturedFamilies(scannedBram, seed, { bundleRestricted })

  const families = [...licensed, ...featured]
  const foundries = [
    { id: 'pangram', label: 'Pangram' },
    { id: 'off-type', label: 'Off-Type' },
    { id: 'bram-naus', label: 'Featured' },
  ].filter(fo => families.some(f => f.foundry === fo.id))
  const manifest = {
    generatedAt: new Date().toISOString(),
    fontsRoot: 'Assets/Fonts',
    foundries,
    families,
  }
```

Leave the rest of `main()` (write + logging) unchanged; the skipped-file report still works.

- [ ] **Step 6: Smoke-run the generator (no seed yet → unchanged foundries)**

Run: `cd frontend && node scripts/build-font-library.mjs`
Expected: prints families/faces/foundries; with no seed file present, `bram-naus` is absent (filtered out). `git diff --stat app/data/library-fonts.manifest.json` should show only the `generatedAt` timestamp changing.

- [ ] **Step 7: Restore the manifest timestamp churn (avoid noise), rerun helper tests**

Run: `cd frontend && git checkout app/data/library-fonts.manifest.json && npx vitest run tests/unit/font-library-helpers.unit.spec.ts`
Expected: PASS. (The manifest is regenerated for real in Task 3.)

- [ ] **Step 8: Commit**

```bash
export GIT_INDEX_FILE=$(mktemp /tmp/gidx.XXXXXX) && cp .git/index "$GIT_INDEX_FILE" \
  && git add frontend/scripts/fontLibrary.mjs frontend/scripts/build-font-library.mjs frontend/tests/unit/font-library-helpers.unit.spec.ts \
  && git commit -m "feat(fonts): generator maps Free Fonts bundle, merges seed, filters restricted

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" && rm -f "$GIT_INDEX_FILE"
```

---

### Task 3: Seed file + Google-source starter + regenerate manifest

Create the seed with a small verified Google-only starter set (proves the novel google-source path end-to-end with no network fetch), regenerate the manifest, and lock it with a Featured-specific test.

**Files:**
- Create: `frontend/app/data/free-fonts.seed.json`
- Modify (generated): `frontend/app/data/library-fonts.manifest.json`
- Create (test): `frontend/tests/unit/featured-fonts-manifest.unit.spec.ts`

**Interfaces:**
- Consumes: `buildFeaturedFamilies` (Task 2), the generator (Task 2).
- Produces: a manifest containing a `bram-naus` foundry and google-source families `Sora`, `Lexend`, `Geologica`, `Onest`, `Syne` (faces `[]`, `source:'google'`).

- [ ] **Step 1: Write the seed starter**

Create `frontend/app/data/free-fonts.seed.json`:

```json
[
  { "name": "Sora", "num": 26, "source": "google", "googleFamily": "Sora", "license": "OFL-1.1", "redistributable": true, "designer": "Jonny Pinhorn", "sourceUrl": "https://fonts.google.com/specimen/Sora" },
  { "name": "Lexend", "num": 40, "source": "google", "googleFamily": "Lexend", "license": "OFL-1.1", "redistributable": true, "designer": "Bonnie Shaver-Troup, Thomas Jockin", "sourceUrl": "https://fonts.google.com/specimen/Lexend" },
  { "name": "Geologica", "num": 30, "source": "google", "googleFamily": "Geologica", "license": "OFL-1.1", "redistributable": true, "designer": "Vasily Biryukov", "sourceUrl": "https://fonts.google.com/specimen/Geologica" },
  { "name": "Onest", "num": 29, "source": "google", "googleFamily": "Onest", "license": "OFL-1.1", "redistributable": true, "designer": "Rasmus Andersson (adapt.)", "sourceUrl": "https://fonts.google.com/specimen/Onest" },
  { "name": "Syne", "num": 125, "source": "google", "googleFamily": "Syne", "license": "OFL-1.1", "redistributable": true, "designer": "Bonjour Monde", "sourceUrl": "https://fonts.google.com/specimen/Syne" }
]
```

- [ ] **Step 2: Regenerate the manifest**

Run: `cd frontend && node scripts/build-font-library.mjs`
Expected: log now reports 3 foundries; `bram-naus` present.

- [ ] **Step 3: Write the Featured manifest test**

Create `frontend/tests/unit/featured-fonts-manifest.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import manifest from '../../app/data/library-fonts.manifest.json'
import type { LibraryManifest } from '../../shared/library-fonts'

const m = manifest as unknown as LibraryManifest

describe('Featured (bram-naus) foundry in the manifest', () => {
  it('registers the Featured foundry', () => {
    expect(m.foundries.find(f => f.id === 'bram-naus')).toEqual({ id: 'bram-naus', label: 'Featured' })
  })
  it('carries the google-source starter families with no faces', () => {
    const feat = m.families.filter(f => f.foundry === 'bram-naus')
    const sora = feat.find(f => f.family === 'Sora')
    expect(sora).toBeTruthy()
    expect(sora!.source).toBe('google')
    expect(sora!.googleFamily).toBe('Sora')
    expect(sora!.faces).toEqual([])
    expect(feat.map(f => f.family)).toEqual(expect.arrayContaining(['Sora', 'Lexend', 'Geologica', 'Onest', 'Syne']))
  })
})
```

- [ ] **Step 4: Run both manifest tests**

Run: `cd frontend && npx vitest run tests/unit/featured-fonts-manifest.unit.spec.ts tests/unit/font-library-manifest.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
export GIT_INDEX_FILE=$(mktemp /tmp/gidx.XXXXXX) && cp .git/index "$GIT_INDEX_FILE" \
  && git add frontend/app/data/free-fonts.seed.json frontend/app/data/library-fonts.manifest.json frontend/tests/unit/featured-fonts-manifest.unit.spec.ts \
  && git commit -m "feat(fonts): seed the Featured tab with a Google-source starter set

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" && rm -f "$GIT_INDEX_FILE"
```

---

### Task 4: Shared lookup helpers — exclude Featured from Pangram tab, add `featuredFamilies`

Keep the "Pangram" tab licensed-only, and add a pure `featuredFamilies(query)` the picker tabs consume.

**Files:**
- Modify: `frontend/app/data/library-fonts-lookup.ts`
- Modify: `frontend/app/data/library-fonts.ts` (re-export)
- Modify (test): `frontend/tests/unit/library-fonts-filter.unit.spec.ts`

**Interfaces:**
- Produces:
  - `FEATURED_FOUNDRY_ID = 'bram-naus'`
  - `filterLibraryGroups(query)` — unchanged signature, now excludes the Featured foundry.
  - `featuredFamilies(query: string): LibraryFamily[]` — Featured families filtered by name, sorted by `num` then family.

- [ ] **Step 1: Write failing tests**

Replace `frontend/tests/unit/library-fonts-filter.unit.spec.ts` with:

```ts
import { describe, it, expect } from 'vitest'
import { filterLibraryGroups, librariesByFoundry, featuredFamilies, FEATURED_FOUNDRY_ID } from '../../app/data/library-fonts'

describe('filterLibraryGroups (Pangram tab — excludes Featured)', () => {
  it('empty query returns all non-empty NON-featured foundry groups', () => {
    const all = filterLibraryGroups('')
    const base = librariesByFoundry().filter(g => g.families.length && g.foundry.id !== FEATURED_FOUNDRY_ID)
    expect(all.length).toBe(base.length)
    expect(all.some(g => g.foundry.id === FEATURED_FOUNDRY_ID)).toBe(false)
  })
  it('a query matching a known family narrows to matching families only', () => {
    const groups = filterLibraryGroups('mori')
    expect(groups.length).toBeGreaterThan(0)
    for (const g of groups) for (const f of g.families) expect(f.family.toLowerCase()).toContain('mori')
  })
  it('a nonsense query returns no groups', () => {
    expect(filterLibraryGroups('zzzz-not-a-real-font-xyz')).toEqual([])
  })
})

describe('featuredFamilies', () => {
  it('returns Featured families, filtered by name', () => {
    expect(featuredFamilies('').some(f => f.family === 'Sora')).toBe(true)
    const sora = featuredFamilies('sora')
    expect(sora.length).toBe(1)
    expect(sora[0].family).toBe('Sora')
  })
  it('is sorted by num ascending', () => {
    const nums = featuredFamilies('').map(f => f.num ?? Infinity)
    expect(nums).toEqual([...nums].sort((a, b) => a - b))
  })
})
```

- [ ] **Step 2: Run — fails (`featuredFamilies` undefined; filter still includes featured)**

Run: `cd frontend && npx vitest run tests/unit/library-fonts-filter.unit.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement in `library-fonts-lookup.ts`**

In `frontend/app/data/library-fonts-lookup.ts`, add after the `byFamily` const:

```ts
export const FEATURED_FOUNDRY_ID = 'bram-naus'
```

Change `filterLibraryGroups` to exclude the Featured foundry:

```ts
export function filterLibraryGroups(query: string): { foundry: LibraryFoundry; families: LibraryFamily[] }[] {
  const q = query.trim().toLowerCase()
  return librariesByFoundry()
    .filter(g => g.foundry.id !== FEATURED_FOUNDRY_ID)
    .map(g => ({
      foundry: g.foundry,
      families: q ? g.families.filter(f => f.family.toLowerCase().includes(q)) : g.families,
    }))
    .filter(g => g.families.length)
}
```

Add the Featured helper (uses the manifest's Featured families, already sorted by the generator but re-sorted defensively):

```ts
/** Featured (curated free) families, filtered by name and ordered by curation number. */
export function featuredFamilies(query: string): LibraryFamily[] {
  const q = query.trim().toLowerCase()
  return LIBRARY_FONTS.families
    .filter(f => f.foundry === FEATURED_FOUNDRY_ID)
    .filter(f => (q ? f.family.toLowerCase().includes(q) : true))
    .sort((a, b) => (a.num ?? Infinity) - (b.num ?? Infinity) || a.family.localeCompare(b.family))
}
```

- [ ] **Step 4: Re-export from `library-fonts.ts`**

In `frontend/app/data/library-fonts.ts`, add `featuredFamilies` and `FEATURED_FOUNDRY_ID` to the existing `export { … } from './library-fonts-lookup'` block.

- [ ] **Step 5: Run the filter tests — pass**

Run: `cd frontend && npx vitest run tests/unit/library-fonts-filter.unit.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
export GIT_INDEX_FILE=$(mktemp /tmp/gidx.XXXXXX) && cp .git/index "$GIT_INDEX_FILE" \
  && git add frontend/app/data/library-fonts-lookup.ts frontend/app/data/library-fonts.ts frontend/tests/unit/library-fonts-filter.unit.spec.ts \
  && git commit -m "feat(fonts): featuredFamilies helper; keep Pangram tab licensed-only

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" && rm -f "$GIT_INDEX_FILE"
```

---

### Task 5: Featured tab in `widgets/FontPicker.vue`

Add a third tab. Each row branches on `source`: google rows reuse `pickGoogle`, self-hosted reuse `pickLibrary`.

**Files:**
- Modify: `frontend/app/components/vue-canvas/widgets/FontPicker.vue`

**Interfaces:**
- Consumes: `featuredFamilies` (Task 4), existing `pickGoogle(f: GoogleFont)`, `pickLibrary(family)`, `ensureGoogleFont`, `ensureLibFace`.

- [ ] **Step 1: Script changes**

In `frontend/app/components/vue-canvas/widgets/FontPicker.vue`:

(a) Add `featuredFamilies` to the import on line 11:
```ts
import { filterLibraryGroups, featuredFamilies } from '~/data/library-fonts'
```
(b) Widen the tab type (line 39):
```ts
type FontPickerTab = 'google' | 'pangram' | 'featured'
```
(c) After `filteredLibrary` (line 102), add:
```ts
const filteredFeatured = computed(() => featuredFamilies(query.value))
watch([activeTab, filteredFeatured], () => {
  if (activeTab.value !== 'featured') return
  for (const f of filteredFeatured.value) {
    if (f.source === 'google') ensureGoogleFont(f.googleFamily || f.family)
    else ensureLibFace(f.family)
  }
})
function pickFeatured(f: { family: string; source?: string; googleFamily?: string }) {
  if (f.source === 'google') pickGoogle({ family: f.googleFamily || f.family, category: 'sans-serif', weights: [400], italic: false, axes: [] })
  else pickLibrary(f.family)
}
```

- [ ] **Step 2: Template changes**

(a) Add the tab button after the Pangram button (line 134):
```html
<button type="button" class="fp__tab" :class="{ 'fp__tab--active': activeTab === 'featured' }" @click="activeTab = 'featured'">Featured</button>
```
(b) Change the library list wrapper `v-else` (line 194) to `v-else-if="activeTab === 'pangram'"`, then add the Featured list block immediately after that `</div>` (before the panel-closing `</div>`):
```html
<div v-else class="fp__list">
  <button
    v-for="f in filteredFeatured"
    :key="f.id"
    type="button"
    class="fp__row"
    :class="{ 'fp__row--sel': f.source === 'google' ? selectedKey === 'goog:' + (f.googleFamily || f.family) : selectedKey === 'lib:' + f.family }"
    @click="pickFeatured(f)"
  >
    <span class="fp__row-name" :style="{ fontFamily: f.source === 'google' ? (f.googleFamily || f.family) : f.family }">{{ f.family }}</span>
    <span class="fp__row-meta">{{ f.source === 'google' ? 'google' : f.faces.length }}</span>
  </button>
  <div v-if="!filteredFeatured.length" class="fp__more">No fonts match “{{ query }}”.</div>
</div>
```

- [ ] **Step 3: Verify in the running app**

Confirm the shared dev server is up (do NOT start a new one): `lsof -nP -iTCP -sTCP:LISTEN | grep node` and confirm a server for this checkout on `:3002`. If healthy, open a node with a Text Mask / Text-on-Path widget, open the font picker, click **Featured**. Expected: Sora/Lexend/Geologica/Onest/Syne listed, each previewing in-face; picking Sora sets the widget font (loads via Google). If the server is broken, report it and offer to restart on its own port — do not spin up an extra one.

- [ ] **Step 4: Commit**

```bash
export GIT_INDEX_FILE=$(mktemp /tmp/gidx.XXXXXX) && cp .git/index "$GIT_INDEX_FILE" \
  && git add frontend/app/components/vue-canvas/widgets/FontPicker.vue \
  && git commit -m "feat(fonts): Featured tab in the widget FontPicker

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" && rm -f "$GIT_INDEX_FILE"
```

---

### Task 6: Featured tab in `vue-canvas/FontPicker.vue`

Same tab, mapped to this picker's handlers: google rows call `selectGoogle(family)`, self-hosted call `selectLibrary(family, foundry)`; google preview via `ensureFontFace`.

**Files:**
- Modify: `frontend/app/components/vue-canvas/FontPicker.vue`

**Interfaces:**
- Consumes: `featuredFamilies` (Task 4), existing `selectGoogle(family)`, `selectLibrary(family, foundry)`, `ensureFontFace`, `ensureLibFace`, and this picker's `fontSearch` ref.

- [ ] **Step 1: Script changes**

(a) Add `featuredFamilies` to the import on line 12:
```ts
import { filterLibraryGroups, featuredFamilies } from '~/data/library-fonts'
```
(b) Widen the tab type (line 88): `type FontPickerTab = 'google' | 'pangram' | 'featured'`.
(c) After `filteredLibrary` (line 91) add:
```ts
const filteredFeatured = computed(() => featuredFamilies(fontSearch.value))
watch([activeTab, filteredFeatured], () => {
  if (activeTab.value !== 'featured') return
  for (const f of filteredFeatured.value) {
    if (f.source === 'google') ensureFontFace(f.googleFamily || f.family)
    else ensureLibFace(f.family)
  }
})
function selectFeatured(f: { family: string; foundry: string; source?: string; googleFamily?: string }) {
  if (f.source === 'google') selectGoogle(f.googleFamily || f.family)
  else selectLibrary(f.family, f.foundry)
}
```

- [ ] **Step 2: Template changes**

(a) Add the tab button after the Pangram button (near line 163), matching the Tailwind classes used by the Pangram button:
```html
<button type="button" @click="activeTab = 'featured'"
        class="rounded px-2 py-0.5 text-[11px]"
        :class="activeTab === 'featured' ? 'bg-white/15 text-white/90' : 'text-white/50 hover:text-white/80'">Featured</button>
```
(b) After the Pangram list block (the `<div v-if="activeTab === 'pangram'" …>` … `</div>` around lines 217-229), add:
```html
<div v-if="activeTab === 'featured'" class="max-h-48 overflow-y-auto">
  <button
    v-for="f in filteredFeatured"
    :key="f.id"
    type="button"
    class="flex w-full items-baseline justify-between gap-2 rounded px-2 py-1 text-left hover:bg-white/10"
    @click="selectFeatured(f)"
  >
    <span class="truncate text-[13px] text-white/90" :style="{ fontFamily: f.source === 'google' ? (f.googleFamily || f.family) : f.family }">{{ f.family }}</span>
    <span class="shrink-0 text-[10px] text-white/40">{{ f.source === 'google' ? 'google' : f.faces.length }}</span>
  </button>
  <p v-if="!filteredFeatured.length" class="px-2 py-1 text-white/40">No matches</p>
</div>
```

- [ ] **Step 3: Verify in the running app**

On the shared `:3002` server, open a node whose font uses this picker, open it, click **Featured**, confirm the starter list renders and picking Sora applies a Google font. (Server hygiene as in Task 5, Step 3.)

- [ ] **Step 4: Commit**

```bash
export GIT_INDEX_FILE=$(mktemp /tmp/gidx.XXXXXX) && cp .git/index "$GIT_INDEX_FILE" \
  && git add frontend/app/components/vue-canvas/FontPicker.vue \
  && git commit -m "feat(fonts): Featured tab in the canvas FontPicker

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" && rm -f "$GIT_INDEX_FILE"
```

---

### Task 7: Featured tab in `templates/FontPicker.vue`

This picker stores a raw family name as `modelValue` for both Google and library picks, so google rows call `selectGoogle(googleFamily)` and self-hosted call `selectLibrary(family)`.

**Files:**
- Modify: `frontend/app/components/templates/FontPicker.vue`

**Interfaces:**
- Consumes: `featuredFamilies` (Task 4), existing `selectGoogle(name)`, `selectLibrary(family)`, `ensureGoogleFont`, `ensureLibFace`, and this picker's `search` ref + `activeTab` (`FontTab`).

- [ ] **Step 1: Script changes**

(a) Add `featuredFamilies` to the import on line 4:
```ts
import { filterLibraryGroups, libraryFamily, librariesByFoundry, featuredFamilies } from '~/data/library-fonts'
```
(b) Widen the tab union type `FontTab` (find its `type FontTab = …` declaration) to include `'featured'`.
(c) After `filteredLibrary` (line 109) add:
```ts
const filteredFeatured = computed(() => featuredFamilies(search.value))
function selectFeatured(f: { family: string; source?: string; googleFamily?: string }) {
  if (f.source === 'google') selectGoogle(f.googleFamily || f.family)
  else selectLibrary(f.family)
}
```
(d) In `preloadTab(tab)` (around line 134-136), add a branch so the Featured tab previews in-face:
```ts
  else if (tab === 'featured') for (const f of filteredFeatured.value) {
    if (f.source === 'google') ensureGoogleFont(f.googleFamily || f.family)
    else ensureLibFace(f.family)
  }
```

- [ ] **Step 2: Template changes**

(a) Add the tab button after the Pangram button (near line 289-291), matching its classes:
```html
<button type="button" @click="setTab('featured')"
        class="rounded px-2 py-0.5"
        :class="activeTab === 'featured' ? 'bg-white/15 text-white/90' : 'text-white/40 hover:text-white/70'"
>Featured</button>
```
(If this picker toggles tabs via `activeTab = tab` inline rather than a `setTab` helper, use the same pattern the Pangram button uses.)
(b) After the Pangram tab template block (`<template v-else-if="activeTab === 'pangram'">` … `</template>`, around lines 386-404), add:
```html
<template v-else-if="activeTab === 'featured'">
  <button
    v-for="f in filteredFeatured"
    :key="f.id"
    type="button"
    class="flex w-full items-baseline justify-between gap-2 px-3 py-1.5 text-left hover:bg-white/10"
    @click="selectFeatured(f)"
  >
    <span class="truncate text-[13px] text-white/90" :style="{ fontFamily: f.source === 'google' ? (f.googleFamily || f.family) : f.family }">{{ f.family }}</span>
    <span class="shrink-0 text-[10px] text-white/35">{{ f.source === 'google' ? 'google' : f.faces.length }}</span>
  </button>
  <p v-if="!filteredFeatured.length" class="px-3 py-1.5 text-white/40">No matches</p>
</template>
```

- [ ] **Step 3: Verify in the running app**

Open a template that uses this picker, open it, click **Featured**, confirm the list and a Google pick. (Server hygiene as in Task 5, Step 3.)

- [ ] **Step 4: Commit**

```bash
export GIT_INDEX_FILE=$(mktemp /tmp/gidx.XXXXXX) && cp .git/index "$GIT_INDEX_FILE" \
  && git add frontend/app/components/templates/FontPicker.vue \
  && git commit -m "feat(fonts): Featured tab in the templates FontPicker

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" && rm -f "$GIT_INDEX_FILE"
```

---

### Task 8: Sourcing script + coverage report

A re-runnable script that classifies each seed entry (google / downloadable / manual), downloads self-hosted `sourceUrl` files into `Assets/Fonts/Free Fonts/`, and writes a coverage report. Pure classifier is unit-tested; the network fetch is best-effort.

**Files:**
- Create: `frontend/scripts/fetch-free-fonts.mjs`
- Create (test): `frontend/tests/unit/free-fonts-classify.unit.spec.ts`
- Create (output, git-ignored or committed): `docs/superpowers/specs/assets/free-fonts-coverage.md`

**Interfaces:**
- Produces: `classifySeedEntry(entry)` → `'google' | 'download' | 'manual'` (google → `'google'`; self-hosted with a fetchable file URL → `'download'`; self-hosted without one → `'manual'`).

- [ ] **Step 1: Write the failing classifier test**

Create `frontend/tests/unit/free-fonts-classify.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { classifySeedEntry } from '../../scripts/fetch-free-fonts.mjs'

describe('classifySeedEntry', () => {
  it('google source → google', () => {
    expect(classifySeedEntry({ name: 'Sora', source: 'google', googleFamily: 'Sora' })).toBe('google')
  })
  it('self-hosted with a direct font-file URL → download', () => {
    expect(classifySeedEntry({ name: 'BDO Grotesk', source: 'self-hosted', fileUrl: 'https://example.com/BDOGrotesk-Regular.ttf' })).toBe('download')
  })
  it('self-hosted without a file URL → manual', () => {
    expect(classifySeedEntry({ name: 'Cabinet Grotesk', source: 'self-hosted', sourceUrl: 'https://www.fontshare.com/fonts/cabinet-grotesk' })).toBe('manual')
  })
})
```

- [ ] **Step 2: Run — fails (module/function missing)**

Run: `cd frontend && npx vitest run tests/unit/free-fonts-classify.unit.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `fetch-free-fonts.mjs`**

Create `frontend/scripts/fetch-free-fonts.mjs`:

```js
// frontend/scripts/fetch-free-fonts.mjs
// Best-effort sourcing for the Featured font seed. Reads app/data/free-fonts.seed.json:
//   - source:'google'                    → nothing to fetch (loaded via Google at runtime)
//   - source:'self-hosted' + fileUrl     → download into Assets/Fonts/Free Fonts/<Family>/
//   - source:'self-hosted' (no fileUrl)  → left for manual download
// Writes a coverage report. Re-runnable; skips files that already exist.
// Run: `node scripts/fetch-free-fonts.mjs` (from frontend/).
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const SEED = join(HERE, '..', 'app', 'data', 'free-fonts.seed.json')
const FONTS_DIR = join(REPO_ROOT, 'Assets', 'Fonts', 'Free Fonts')
const REPORT = join(REPO_ROOT, 'docs', 'superpowers', 'specs', 'assets', 'free-fonts-coverage.md')

/** Route a seed entry: 'google' | 'download' | 'manual'. */
export function classifySeedEntry(entry) {
  if (entry.source === 'google') return 'google'
  if (entry.source === 'self-hosted' && entry.fileUrl) return 'download'
  return 'manual'
}

async function download(url, destDir) {
  mkdirSync(destDir, { recursive: true })
  const dest = join(destDir, basename(new URL(url).pathname))
  if (existsSync(dest)) return { dest, skipped: true }
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  writeFileSync(dest, buf)
  return { dest, skipped: false }
}

async function main() {
  const seed = JSON.parse(readFileSync(SEED, 'utf8'))
  const rows = []
  for (const e of seed) {
    const kind = classifySeedEntry(e)
    if (kind !== 'download') { rows.push([e.name, kind, e.source === 'google' ? 'via Google' : 'needs manual download']); continue }
    try {
      const { dest, skipped } = await download(e.fileUrl, join(FONTS_DIR, e.name))
      rows.push([e.name, 'sourced', `${skipped ? 'already present' : 'downloaded'}: ${basename(dest)}`])
    } catch (err) {
      rows.push([e.name, 'failed', String(err.message || err)])
    }
  }
  mkdirSync(dirname(REPORT), { recursive: true })
  const body = [
    '# Featured fonts — sourcing coverage', '',
    `Generated ${new Date().toISOString()} from \`app/data/free-fonts.seed.json\`.`, '',
    '| Font | Status | Notes |', '| --- | --- | --- |',
    ...rows.map(([n, s, note]) => `| ${n} | ${s} | ${note} |`), '',
  ].join('\n')
  writeFileSync(REPORT, body)
  console.log(`Wrote ${REPORT} — ${rows.length} entries`)
}

if (process.argv[1] && process.argv[1].endsWith('fetch-free-fonts.mjs')) main()
```

- [ ] **Step 4: Run the classifier test — pass**

Run: `cd frontend && npx vitest run tests/unit/free-fonts-classify.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Generate an initial coverage report (google-only seed)**

Run: `cd frontend && node scripts/fetch-free-fonts.mjs`
Expected: writes `docs/superpowers/specs/assets/free-fonts-coverage.md` with all starter entries marked "via Google".

- [ ] **Step 6: Commit**

```bash
export GIT_INDEX_FILE=$(mktemp /tmp/gidx.XXXXXX) && cp .git/index "$GIT_INDEX_FILE" \
  && git add frontend/scripts/fetch-free-fonts.mjs frontend/tests/unit/free-fonts-classify.unit.spec.ts docs/superpowers/specs/assets/free-fonts-coverage.md \
  && git commit -m "feat(fonts): best-effort sourcing script + coverage report for Featured seed

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" && rm -f "$GIT_INDEX_FILE"
```

---

### Task 9: Populate the seed (iterative data work)

Not TDD — this grows the seed and downloads files in batches, riding on the pipeline from Tasks 1-8. The tab already works with whatever the seed resolves; each batch just adds fonts.

**Files:**
- Modify: `frontend/app/data/free-fonts.seed.json`
- Add font files under: `Assets/Fonts/Free Fonts/<Family>/…`
- Regenerate: `frontend/app/data/library-fonts.manifest.json`
- Update: `docs/superpowers/specs/assets/free-fonts-coverage.md`

**Per-batch loop (≈10-15 fonts at a time, from the recovered list in the design doc):**

- [ ] **Step 1: Research each font in the batch.** For each name, determine: is it on Google Fonts (exact family)? its license (OFL/Apache/UFL = redistributable; anything free-but-no-redistribute = `redistributable:false`); and, for self-hosted, a direct `fileUrl` to a `.ttf/.otf/.woff2` (GitHub raw/release) plus a `sourceUrl` for provenance.
- [ ] **Step 2: Append entries** to `free-fonts.seed.json` in the seed shape (`name, num, source, googleFamily?, license, redistributable, designer?, sourceUrl?, fileUrl?`). Google-available fonts → `source:'google'` (no file). Non-redistributable → `redistributable:false`.
- [ ] **Step 3: Fetch files.** Run `cd frontend && node scripts/fetch-free-fonts.mjs`. Inspect the coverage report; fix `failed`/`manual` rows (better URL, or leave as manual).
- [ ] **Step 4: Regenerate + test.** Run `cd frontend && node scripts/build-font-library.mjs && npx vitest run tests/unit/featured-fonts-manifest.unit.spec.ts tests/unit/font-library-manifest.unit.spec.ts`. Expected: PASS; new families present.
- [ ] **Step 5: Verify** the batch shows in the Featured tab on the shared `:3002` server (in-face previews; a self-hosted pick loads its bundled file; a google pick loads via Google).
- [ ] **Step 6: Commit the batch** (seed + manifest + coverage + any font files) via the private-index recipe. Keep font files and their manifest in the same commit.

**Restricted-build check (once, after the first non-redistributable font lands):**
- [ ] Run `cd frontend && BUNDLE_RESTRICTED_FONTS=0 node scripts/build-font-library.mjs` and confirm `redistributable:false` families drop out of the manifest; then regenerate without the flag (`node scripts/build-font-library.mjs`) to restore the dev manifest before committing. Document this command in the coverage report header.

---

## Notes on scope & sequencing

- Tasks 1-4 are pure/tested infra. Task 3 proves the google-source path end to end. Tasks 5-7 are the three picker UIs (independently reviewable; each reuses existing pick handlers, so no consumer changes). Task 8 is the sourcing tool. Task 9 is ongoing data population.
- The "foundry-driven tabs" refactor from the spec was intentionally **not** taken: the explicit-tab-per-picker approach keeps the blast radius small (each picker edit is self-contained and reviewable) while sharing all logic through `featuredFamilies`/`filterLibraryGroups`.
- Licensing caveat (from the spec) stands: committing non-redistributable font *files* is distribution if this repo is shared; the build flag governs only the shipped product.
