# AI in Sailor, stage 4: studios

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every studio uses the one prompt:
- the simple studios (Shader, Gradient, Shape, Texture, Vector type, Space type) get the prompt above a small shared tool bar in `StudioModalShell`, and their scattered viewport controls move into that bar;
- Frame and 3D get the one prompt above whichever bar is showing, takeover modes included. Frame's "Ask…" pill is removed;
- the template editor's prompt moves to the same component, in its bottom bar;
- results land above the prompt (three takes, a proposed change, or an answer), never in the right column;
- inspectors read: the thing itself (Recipe), then Actions as light rows, then Dials;
- `AgentBar`, `VibeControlBar` and the right-column agent takeover are retired, and a guard test keeps them retired.

**Architecture:**
- **One worker shape.** Every studio agent at HEAD already returns the same core: `busy`, `error`, `notice`, `changes`, `hasProposal`, `hovered`, `review`, `reviewing`, `ask`, `acceptChange`, `rejectChange`, `reroll`, `keep`, `revert`. `useStudioAgent` adds the takes session. This plan names that shape `StudioPromptWorker` and **does not change any worker's requests**: each studio keeps its own agent (`/api/vibe`, `/api/agent-plan`, …). The one exception is `useStudioAgent`'s take count, which goes from four to three (spec §3.1).
- **`useStudioPrompt`** (`composables/useStudioPrompt.ts`) is the studio twin of stage 3's `useCanvasPrompt`:
  - it routes a request through `/api/prompt-route` (host `studio` or `frame`);
  - `lib/prompt/studioDispatch.ts` maps the kind to the worker, or to a plain message;
  - it owns the mode chip, the working label, Stop, and which card shows above the prompt.
  - The owner (the shell, `CompositorModal`, `GridEditorShell`) creates it and `provide`s it, so inspector action rows can set a mode chip or send a kind without prop drilling.
- **`StudioPromptHost.vue`** renders `SailorPrompt` with the stage 3 cards (`PromptTakes`, `PromptChangesCard`, `PromptAnswerCard`) in its `above` slot. Studio takes reach `PromptTakes` through a pure adapter (`lib/prompt/studioTakes.ts`) that turns the worker's take state into a `TakesSession`.
- **`StudioToolBar.vue` + `StudioToolButton.vue`** are the shared small bar. The shell renders a studio's `#tools` slot in it, directly under the prompt.
- **Inspector actions** come from one registry (`lib/studio/studioActions.ts`, reusing stage 2's `ActionGroup` / `ActionLands` / `landsHint`), rendered by `StudioActionRows.vue` under a `StudioInspectorHead.vue` that shows the thing itself.

**Tech stack:** Nuxt 4 (Vue 3 + TypeScript + Tailwind), Nitro server routes, `lucide-vue-next`, Vitest (`tests/unit/**/*.unit.spec.ts`, happy-dom opt-in by docblock), Playwright (`tests/*.spec.ts`).

**Spec:** `docs/superpowers/specs/2026-09-23-ai-in-sailor-design.md`. This plan is build stage 4 of §9. It covers §2.1a (studios, template editor, the guard test), §2.4, §2.5, §3.1 in studios, the studio rows of §5, and the action placements of §7.3. Shader generation itself (§7.2, §7.4) is stage 5; the shared content field (§6) is stage 6.

**Mockup:** `docs/superpowers/specs/assets/2026-09-23-ai-in-sailor/one-prompt-everywhere.html`. Its Frame, 3D, Shader studio and Space type views are the target layouts. Open it with `?place=shader`, `?place=spacetype`, `?place=frame` or `?place=scene3d`.

**Earlier plans, for format and context:**
- Stage 3: `docs/superpowers/plans/2026-09-24-ai-in-sailor-stage3-results.md`. It is being built now. This plan assumes its interfaces land as written: `CanvasPromptHost.vue`, `useCanvasPrompt.ts`, `PromptTakes.vue`, `PromptChangesCard.vue`, `PromptAnswerCard.vue`, `shared/promptRouter/router.ts`, `lib/prompt/routeRequest.ts`, `lib/prompt/takesSession.ts`, `/api/prompt-route`. At planning time (HEAD `a42fb203c`), stage 3 Tasks 1–7 had landed; Tasks 8–9 (`useCanvasPrompt`, `CanvasPromptHost`) had not.
- Stage 2: `docs/superpowers/plans/2026-09-24-ai-in-sailor-stage2-canvas.md`.

**What the code looks like at HEAD** (verified while planning; line numbers drift, so grep):
- `StudioModalShell.vue` (248 lines) imports `AgentBar`, `AgentProgress`, `AgentProposal` and `TakeStrip`. It renders `TakeStrip` + `AgentBar` under the preview (boxed layout ~L190–209, full-bleed ~L151–177), and the agent's progress or proposal **replaces the controls column** while busy (~L219–235). Slots: `aside`, `preview`, `agentBar`, `controls`, `actions`. Props include `agent` and `agentPlaceholder`.
- **Simple studios:**
  - Shader (`ShaderStudioSurface.vue`): `useStudioAgent` with takes. No viewport controls. Its inspector opens with Source (upload, "New variation" → `rerollSeed`, seed slider), then "Stylized Effects" (the effect picker `openPicker`, then the effect's params), Duotone, Gradient Map, Adjustments, Post-processing, Output, Motion.
  - Gradient (`GradientStudioSurface.vue`): `useStudioAgent` with takes and compose. **Zoom** is a top-centre toolbar on the preview (~L999–1011: `zoomBy`, `resetZoom`, `zoom`). Randomize is keyboard-only (`randomize(scope)`, Space / C / S).
  - Shape (`ShapeStudioSurface.vue`): `useStudioAgent` with takes. No viewport controls. A seed card with **Re-roll** (`rerollConfig`) tops the layer inspector.
  - Texture (`TextureStudioSurface.vue`, "Pattern Studio"): `useTextureAgent` (`/api/agent-plan`, no takes). **Repeat 1×/2×/3×** (`repeat`, `setRepeat`) and **Highlight seams** (`seams`, `toggleSeams`) sit under the canvas (~L598–607). A raster row below them (~L609–639) holds Import image, a **content prompt** ("Describe a texture to generate…") and "Make seamless". "Roll · seed N" (`roll`) is a footer utility.
  - Vector type (`VectorTypeSurface.vue`): `useStudioAgent` with takes. The Motion tab shows `MoveTimeline` under the canvas (`playing`, `previewTime`, `onSeek`), and a second Play/Pause is a footer utility.
  - Space type (`SpaceTypeSurface.vue`, "Kinetic Studio"): **no `:agent`**. Its bespoke flow (`onVibe` → `useVibeControl().requestPatch` → `/api/vibe`, with `vibeProposal` / `onVibeKeep` / `onVibeRevert`) renders `VibeControlBar` in the shell's `#agentBar` slot (~L1833). A transport pill (Play/Pause `togglePlay`, a range scrubber `onScrub`, a frame counter) floats at the bottom of the preview (~L1789–1802).
- **Frame** (`CompositorModal.vue`, ~12.5k lines):
  - the bottom stack `<div v-if="inspectorTab !== 'motion'" class="absolute bottom-8 flex flex-col …">` (~L9108) holds the prompt dock (~L9114–9142: the `AgentBar` inside a 164 px → 100 % pill, `promptExpanded`, `focusPrompt`, `data-testid="compositor-prompt-dock"` / `compositor-prompt-pill`) above the tool bar (~L9144–9468);
  - in Motion mode the whole stack is gone and `MotionBandTimeline` takes the bottom (~L9471);
  - `useCompositorAgent` (`/api/agent-plan`; no stop, no takes) is aliased `caBusy`, `caAsk`, `caKeep`, … (~L1558–1601). `onAgentAsk` (~L1596) snaps to the design size first;
  - `caPanelActive` makes the Assistant (`AgentProgress`, `AgentProposal`) take over the right panel (~L9576–9595);
  - the selected layer is `selectedLocal` (`.kind`, `.text`); `selectedLayers`, `selectedCount`;
  - no headline, copy or layout **takes** exist in Frame. The Layout tab's Vary (`useLayoutVary`, `LayoutVaryPanel`) steps through layouts.
- **3D** (`Scene3DStudioSurface.vue`): **no prompt row and no agent at all** (L1241: "Scene3D has no control-schema/agent path"). The shell is full-bleed with `:full-bleed-bottom-offset="72"`. Three bottom bars: the add tool bar (~L4947, `activeTab !== 'motion' && !sculpting`), the sculpt tool bar (~L5225, `sculpting`), and the Motion dock (~L4926, `activeTab === 'motion'`).
- **Template editor** (`GridEditorShell.vue`): `useLayoutAgent`; `AgentBar` sits in the bottom cluster above the tool row (~L605–608, v3 templates only), and the Assistant takes over the right panel (~L458–476).

Not in this plan:
- Shader generation, **Remix…** and **New effect…** results, My effects: stage 5. The actions appear now (§7.3); they set a mode chip, and sending gives a plain message.
- Headline takes, layout takes and typeface takes in Frame (§2.5): no worker exists for them. Frame requests go to Frame's existing agent and come back as a proposed change.
- The shared content field (§6). Content prompts (Texture's "Describe a texture…", Frame's "Describe the element…", 3D's generate/restyle/texture inputs, copy assist) stay where they are, and the guard test allows them by name.
- Deleting `CanvasPromptBar`: stage 3 Task 9.

## Rulings made while planning

Julien was asleep, so these calls were made without him. Each one is a line he can overturn.

1. **3D has no agent at HEAD** (the spec's §2.4 assumed it had a prompt row). 3D still gets the one prompt above whichever of its bars shows, so the stack is the same everywhere and a later worker plugs straight in. Until then **every kind answers with a plain message**: "3D can’t take instructions yet. Use the tools below, or the inspector." 3D's inspector is not reordered, since it has no actions to list.
2. **Frame has no takes worker.** Every Frame kind except `new-effect` goes to Frame's existing agent (`useCompositorAgent`) and lands as a proposed change above the prompt. §2.5's headline and layout takes wait for a worker (stage 5 for the background, a later plan for copy and layouts).
3. **Studios route too.** Requests go through `/api/prompt-route` (host `studio`, or `frame` for Frame), like the canvas. It costs about 1 credit, it sends `new-effect` to its message now and to shader generation in stage 5, and it gives answers their follow-ups. Router failure falls back to `plan`, which in a studio is the worker, so a failure behaves exactly like today.
4. **Studio dispatch:**

   | Kind | Simple studio, template editor | Frame | 3D |
   |---|---|---|---|
   | `answer`, `plan`, `edit-recipe`, `tweak`, `restyle`, `fix` | the worker (`ask`) | the worker | message |
   | `copy`, `layout` | message ("in Frame") | the worker | message |
   | `new-effect` | message (stage 5) | message | message |

   The template editor is a layout tool, so it also sends `copy` and `layout` to its worker.
5. **Answers come from the worker.** A studio worker that makes no change returns its reasoning as `notice` (`useStudioAgent.showProposal`, `useCompositorAgent`, `useLayoutAgent`). When a run ends with no takes and no proposal, a non-empty `notice` shows in the answer card: it is headed "Answer", with the router's follow-ups, when the kind was `answer`, and it is a plain notice otherwise. An `error` shows as an error card.
6. **Stop lives in the prompt layer, not in the workers.** No studio worker can abort today, and this stage doesn't change them.
   - Stop aborts routing at once. If the worker is already busy, the prompt stops showing progress immediately and marks the run as stopped.
   - When the stopped run's reply lands, it is thrown away: open takes are dismissed (`abandonTakes`), and a proposal is reverted (`revert`).
   - The prompt stays disabled until that reply has landed, so a new request can't be clobbered.
   - The call was already paid for; that's unchanged from today.
7. **Three takes in studios.** `useStudioAgent`'s `TAKE_COUNT` becomes `TAKES_PER_SET` (3). `/api/vibe` already accepts 2–4.
8. **Studio takes use stage 3's `PromptTakes`**, not `TakeStrip` (§2.1a's "identical everywhere" was decided after §5's "TakeStrip reused").
   - A pure adapter maps the worker's takes to a `TakesSession`. Tile ids are `take-0…take-2`, and a thumbnail canvas becomes a data URL.
   - The strip appears when the takes land, and pending thumbnails pulse. Studio takes arrive in one reply, so there are no pending tiles before that; the prompt shows "Working on “…”" meanwhile.
   - The per-tile promise and verdict badges `TakeStrip` drew are dropped. The worker still runs its checks and repairs; only the badges go.
   - `TakeStrip.vue` is deleted when its last importer goes (Task 4).
9. **The right-column takeover is removed everywhere** (shell, Frame, template editor). Proposals show in `PromptChangesCard` above the prompt, with Approve (`keep`), Reject (`revert`), and per-row accept, reject and re-roll. There is no "Approve and run" (`runnable` false). `AgentProgress`'s rotating generic phases are dropped: the working label quotes the request (standing rule).
10. **The glimm sweep in studios.** While working, `AgentSweep` (lagoon, 3 s) also runs over the preview (in the shell) or the artboard (Frame already has one, bound to `caBusy`). It is bound to the prompt's `working`.
11. **The shell creates the prompt, and provides it.** `StudioModalShell` calls `useStudioPrompt` from its `agent` prop and `provide`s it under `STUDIO_PROMPT_KEY`. `StudioActionRows` injects it, which works for components rendered in the shell's slots. `CompositorModal` and `GridEditorShell` create and provide their own. `/` and ⌘K focus the studio prompt while a studio is open: `StudioPromptHost` listens on `window` in the capture phase and stops propagation, so the canvas prompt (under the modal) never takes the key.
12. **The shell's props change.**
    - `agentPlaceholder` and the `#agentBar` slot are removed: the placeholder is `SailorPrompt`'s fixed pattern ("Change or ask about ‹chip›").
    - New props: `promptLabel` (the chip, which is the thing's own name or text), `promptSuggestions`, `promptPlace` (a router selection kind such as `shader-studio`), and `promptHost` (default `studio`).
    - New slot: `#tools`.
    - The prompt renders whenever the shell is given an `agent` **or** a `promptPlace`, which is how 3D gets it with no worker.
13. **A studio with nothing to move gets no tool bar.** Shader and Shape have no viewport controls at HEAD, so their prompt sits alone above the footer. The mockup's Pause, Speed, Seed and Fit for Shader are new controls, not moves, so they are out of scope.
14. **What moves into each bar:**
    - Gradient: zoom −, %, +.
    - Texture: Repeat 1×/2×/3× and Highlight seams. The raster row stays under the canvas: it holds a content prompt (stage 6).
    - Vector type: Play/Pause and the timeline scrubber. `MoveTimeline` stays in the Motion inspector's place under the canvas, and the bar gets Play/Pause plus a scrubber bound to `previewTime`. The footer's duplicate Play/Pause is removed.
    - Space type: the transport (Play/Pause, scrubber, frame counter), taken off the preview.
15. **Space type moves onto `useStudioAgent`**, without takes. It uses the same worker: `requestPatch(effect.controls, params, effect.label, phrase)` → `/api/vibe`. Its bespoke `onVibe` / `vibeProposal` state and `VibeControlBar.vue` are deleted. `VibeControlBar`'s "click a chip to scroll to the control" (`onVibeFocus`) goes with it: `PromptChangesCard` rows don't scroll the inspector. That's a small loss, noted for Julien.
16. **The inspector's "thing itself"** is a `StudioInspectorHead`. Its title is the thing's own name or text, and it is also the prompt chip:
    - Shader: the effect's name, the category underneath, a **Change effect** button (`openPicker`, moved up from Stylized Effects) and **Remix…** (✦).
    - Gradient: the selected layer's name, or "Gradient" when the layer is unnamed.
    - Shape: the selected layer's name, or "Shape".
    - Texture: the pattern's lattice name, as the panel already shows it.
    - Vector type: the text.
    - Space type: the text, with the effect's name underneath and **Change effect** (the gallery, moved up).
    - Frame: the selected layer's own text or name. The existing layer header row stays, and actions go under it.
17. **Inspector actions** (registry, Task 5). Hints are only "3 takes" and "adds a step" (stage 2's `landsHint`); an action whose result is a proposal shows no hint.
    - **Edit:** Tune… (✦, mode chip "Tune"; "3 takes" where the worker has takes) in every studio with a worker. In Frame also **Write copy…** (✦, mode chip "Write copy").
    - **Develop:**
      - **Vary** (✦, "3 takes") where the worker has takes. It sends kind `tweak` from the menu with the fixed request "Three different directions".
      - **Shader only:** **New layer from a description…** (✦, mode chip "New effect"). Remix… is in the head (Ruling 16).
      - The existing non-AI re-rolls move here from where they sit today: Shader "New variation" (from Source), Shape "Re-roll" (from the seed card), Texture "Roll" (from the footer), and Gradient **Randomize**, which becomes a button for the first time, calling `randomize('all')`.
      - **Frame:** "Try layouts" (non-AI, opens the Layout tab).
    - A mode chip whose kind has no worker (Remix, New effect) gives stage 3's plain `newEffect` message on send.
18. **Frame's prompt stays in Motion mode.** Only the tool bar is `v-if="inspectorTab !== 'motion'"` now; the prompt row sits above the Motion timeline. It uses the tool bar's width, and `min(720px, 100%)` above the full-width timeline. `onAgentAsk` keeps its snap-to-design-size step.
19. **Frame's chip** (`frameSelectionLabel`):
    - a text layer shows its own text, trimmed to 24 characters, as `“Open late” · text`;
    - another layer shows its name, else its kind in sentence case ("Image");
    - several layers show "N layers";
    - nothing selected shows no chip.
20. **Suggestions** are short, neutral, and only for things the worker can do:
    - Studios with takes: "Warmer", "Calmer", "More contrast".
    - Texture: "Tighter cells", "Two colours only".
    - Frame, text selected: "Shorter", "Bolder".
    - Frame, background selected: "Warmer background".
    - Frame, nothing selected: "Tighten the layout", "Warm the palette".
    - Template editor: "Tighten spacing", "Apply brand".
    - 3D: none.
21. **Deleting retired components.** A retired component is deleted in the task that removes its last importer:
    - `VibeControlBar.vue` in Task 7;
    - `TakeStrip.vue` (and its unit spec) in Task 4;
    - `AgentBar.vue`, `AgentProgress.vue` and `AgentProposal.vue` in Task 11, but only if the grep finds no importer. `CanvasPromptBar.vue` still imports `AgentProposal` until stage 3 Task 9 lands; if it does, leave `AgentProposal` for stage 7.
22. **The guard test** (§2.1a) fails when:
    - (a) any `.vue` outside `components/prompt/` imports `AgentBar`, `VibeControlBar` or `CanvasPromptBar`;
    - (b) the instruction-prompt signatures ("Ask Sailor", "Change or ask about", `aria-label="Ask Sailor"`) appear outside `components/prompt/` and `lib/prompt/`;
    - (c) a `.vue` outside `components/prompt/` renders an `<input>` or `<textarea>` within 6 lines of an AI mark (`AiMark`, `✦`, `Sparkles`), unless the file is on a named allowlist of **content-prompt** and search fields. Each allowlist entry carries the reason it's allowed, and stage 6 shrinks the list.
23. **Tests never reach a model.** Unit tests inject `route` and fake workers. The Playwright spec mocks `/api/prompt-route`, `/api/vibe` and `/api/agent-plan`. A real-mouse pass and one live studio request are **owed** (Task 13).

## Global Constraints

- **Work in the main checkout** (`/Users/julien/Documents/GitHub/Sailor`), on `main`. No worktree, no branch, never `git stash`. Other sessions share this checkout: leave files you didn't change alone, even if they look broken.
- **Commit only your own paths, through a private index, in two shell calls:**
  1. `cd /Users/julien/Documents/GitHub/Sailor && BEFORE=$(git rev-parse HEAD) && IDX=$(mktemp) && export GIT_INDEX_FILE=$IDX && git read-tree HEAD && git add -- <your paths> && git commit -q -m "<msg>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"; echo "rc=$? $BEFORE -> $(git rev-parse HEAD)"; rm -f "$IDX"`
  2. Then, in a separate call: `cd /Users/julien/Documents/GitHub/Sailor && git reset -q -- <the same paths>`

  To commit a deleted file, use `git rm --cached -q -- <path>` in place of `git add`, inside the same private-index call. Prove the commit by HEAD moving, not by printing HEAD.
- **Other sessions' hunks in shared files.** `CompositorModal.vue`, `SpaceTypeSurface.vue`, `Scene3DStudioSurface.vue`, `VueNodeCanvas.vue` and `layouts/default.vue` are often edited by other sessions (Frame foil work landed on `CompositorModal.vue` the day this plan was written).
  - **Before your first edit** to any of them, save its diff: `git diff -- <file> > <scratchpad>/<name>.before.patch`.
  - **At commit time**, if that saved patch was non-empty, don't `git add` the whole file. Instead:
    1. build a patch of only your hunks: `git diff -- <file>`, then drop the foreign hunks by hand into `<scratchpad>/mine.patch`;
    2. inside the private-index call, run `git apply --cached <scratchpad>/mine.patch` in place of `git add`.
  - If that is unclear for a hunk, stop and ask the controller.
- **Never run `npm run dev`, `nuxt dev`, or start or kill any server.** The shared dev server on `:3002` belongs to the controller. Implementers write Playwright specs; the controller runs them against `:3002` and nobody restarts it for this stage (it adds no server route).
- **This stage adds no Nitro route.** It uses stage 3's `/api/prompt-route`, which must already be in `frontend/server/lib/nitroApiPaths.ts` `NITRO_API_PATHS`. If a task finds it needs a new route, stop and ask: a new route needs a server restart and a `NITRO_API_PATHS` entry.
- **Unit tests:** `cd frontend && npx vitest run <spec paths>` for your specs, then `npx vitest run` (the whole suite) once before you report. The guard tests (`api-route-reachability`, and this stage's `single-instruction-prompt`) only prove anything in the full suite.
- **Typecheck:** `cd frontend && npx vue-tsc --noEmit 2>&1 | grep -E "<your file names>"`. The repo has a large standing baseline, so judge only the lines that name your files. Compare against the base commit before calling any error pre-existing (use `git show <BASE>:<path>` into a scratch copy; never `git stash`).
- **No paid model calls during the build.**
  - Unit tests inject fakes (`route`, workers, `fetcher`).
  - Every Playwright spec that submits a prompt mocks `/api/prompt-route` **and** the studio's worker route (`/api/vibe`, `/api/agent-plan`).
  - List any live check as owed.
- **The workers are unchanged.** Don't change what any studio agent sends to its route. The one allowed change is `useStudioAgent`'s take count (Task 2).
- **UI copy:**
  - sentence case, and no internal identifiers or kind names ("tweak" never appears on screen);
  - labels quote the user's own content (the effect's name, the layer's own text), never a guessed role.
- **Pastel means AI.** The pastel ring and the glimm are for AI only; chips, suggestions, tiles, tool bar buttons and action rows are neutral. Every AI mark is `components/prompt/AiMark.vue` `kind="star"`: never lucide `Sparkles`, and never a grey ✦ glyph.
- **The prompt's look is fixed by spec §2.1a.** Only `SailorPrompt` draws the prompt. Hosts set its width through their container and put cards in its `above` slot; they never restyle it.
- **Always three takes** (`TAKES_PER_SET = 3`), never four.
- **Closing a studio with takes open restores the original first.** The shell's `requestClose()` calls `abandonTakes()` before emitting `close`; keep that order (its unit spec pins it).
- **A component's leading template comment goes inside its root element.** A leading comment makes the component a fragment in dev, and a parent reading `$el` breaks.

---

### Task 1: Studio dispatch, the takes adapter and the Frame chip (pure)

**Files:**
- Create: `frontend/app/lib/prompt/studioDispatch.ts`
- Create: `frontend/app/lib/prompt/studioTakes.ts`
- Test: `frontend/tests/unit/studio-dispatch.unit.spec.ts`
- Test: `frontend/tests/unit/studio-takes.unit.spec.ts`

**Interfaces:**
- Consumes:
  - stage 3: `RouterKind` (`~~/shared/promptRouter/router`);
  - `DISPATCH_MESSAGES` (`~/lib/prompt/canvasDispatch`, for the `newEffect` wording);
  - `TakesSession`, `TakeTile`, `TAKES_PER_SET`, `CURRENT` (`~/lib/prompt/takesSession`);
  - `TakeThumb` (`~/lib/agent/takeThumbs`).
- Produces:
  - `type StudioPromptPlace = 'studio' | 'frame' | 'template' | 'scene3d'`
  - `type StudioDispatch = { worker: 'ask'; text: string } | { worker: 'message'; message: string }`
  - `STUDIO_MESSAGES: { newEffect: string; copyInFrame: string; layoutInFrame: string; noWorker3d: string; nothingToVary: string }`
  - `VARY_REQUEST = 'Three different directions'`
  - `studioDispatch(kind: RouterKind, text: string, o: { place: StudioPromptPlace; hasWorker: boolean; canTakes: boolean; fromMenu?: boolean }): StudioDispatch`
  - `frameSelectionLabel(layers: { kind: string; text?: string | null; name?: string | null }[]): string | null`
  - `studioTakeId(i: number): string` (returns `take-${i}`)
  - `studioTakeIndex(id: string | null): number | null`
  - `thumbSrc(t: TakeThumb | undefined): string | null`
  - `studioTakesSession<T>(v: { label: string; request: string; takes: T[]; thumbs: Map<T, TakeThumb>; current: TakeThumb; selected: T | null }): TakesSession | null`

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/tests/unit/studio-dispatch.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { frameSelectionLabel, STUDIO_MESSAGES, studioDispatch, VARY_REQUEST } from '~/lib/prompt/studioDispatch'
import { DISPATCH_MESSAGES } from '~/lib/prompt/canvasDispatch'

const studio = { place: 'studio' as const, hasWorker: true, canTakes: true }

describe('studioDispatch', () => {
  it('sends the worker every kind it can do, with the text as typed', () => {
    for (const k of ['answer', 'plan', 'edit-recipe', 'tweak', 'restyle', 'fix'] as const)
      expect(studioDispatch(k, 'warmer', studio)).toEqual({ worker: 'ask', text: 'warmer' })
  })
  it('copy and layout belong to Frame and the template editor', () => {
    expect(studioDispatch('copy', 'a headline', studio)).toEqual({ worker: 'message', message: STUDIO_MESSAGES.copyInFrame })
    expect(studioDispatch('layout', 'x', studio)).toEqual({ worker: 'message', message: STUDIO_MESSAGES.layoutInFrame })
    expect(studioDispatch('copy', 'a headline', { ...studio, place: 'frame' })).toEqual({ worker: 'ask', text: 'a headline' })
    expect(studioDispatch('layout', 'tighter', { ...studio, place: 'template' })).toEqual({ worker: 'ask', text: 'tighter' })
  })
  it('new-effect is stage 5: the canvas message, word for word', () => {
    expect(studioDispatch('new-effect', 'rain', studio)).toEqual({ worker: 'message', message: DISPATCH_MESSAGES.newEffect })
    expect(STUDIO_MESSAGES.newEffect).toBe(DISPATCH_MESSAGES.newEffect)
  })
  it('3D (no worker) answers every kind with its message', () => {
    for (const k of ['answer', 'plan', 'tweak', 'copy'] as const)
      expect(studioDispatch(k, 'x', { place: 'scene3d', hasWorker: false, canTakes: false })).toEqual({ worker: 'message', message: STUDIO_MESSAGES.noWorker3d })
  })
  it('Vary from the menu sends the fixed request, only where there are takes', () => {
    expect(studioDispatch('tweak', '', { ...studio, fromMenu: true })).toEqual({ worker: 'ask', text: VARY_REQUEST })
    expect(studioDispatch('tweak', '', { ...studio, canTakes: false, fromMenu: true })).toEqual({ worker: 'message', message: STUDIO_MESSAGES.nothingToVary })
  })
  it('an empty request that is not from a menu is a no-op message', () => {
    expect(studioDispatch('plan', '   ', studio)).toEqual({ worker: 'message', message: STUDIO_MESSAGES.nothingToVary })
  })
  it('messages are plain sentence-case copy with no kind names', () => {
    for (const m of Object.values(STUDIO_MESSAGES)) {
      expect(m).toMatch(/^[A-Z0-9]/)
      expect(m).not.toMatch(/tweak|new-effect|edit-recipe|router|worker/)
    }
  })
})

describe('frameSelectionLabel', () => {
  it('quotes a text layer’s own words, trimmed', () => {
    expect(frameSelectionLabel([{ kind: 'text', text: 'Open late' }])).toBe('“Open late” · text')
    expect(frameSelectionLabel([{ kind: 'text', text: '  Rainy   season \n' }])).toBe('“Rainy season” · text')
    expect(frameSelectionLabel([{ kind: 'text', text: 'A very long headline that keeps going' }])).toBe('“A very long headline th…” · text')
  })
  it('uses a layer’s name, else its kind in sentence case', () => {
    expect(frameSelectionLabel([{ kind: 'image', name: 'Hero shot' }])).toBe('Hero shot')
    expect(frameSelectionLabel([{ kind: 'image' }])).toBe('Image')
    expect(frameSelectionLabel([{ kind: 'text', text: '' }])).toBe('Text')
  })
  it('counts several, and shows nothing for nothing', () => {
    expect(frameSelectionLabel([{ kind: 'image' }, { kind: 'text', text: 'x' }])).toBe('2 layers')
    expect(frameSelectionLabel([])).toBeNull()
  })
})
```

```ts
// frontend/tests/unit/studio-takes.unit.spec.ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { studioTakeId, studioTakeIndex, studioTakesSession, thumbSrc } from '~/lib/prompt/studioTakes'
import { CURRENT } from '~/lib/prompt/takesSession'

const a = { label: 'Warm' }, b = { label: 'Cool' }, c = { label: 'Dusk' }

describe('studio takes adapter', () => {
  it('no takes → no strip', () => {
    expect(studioTakesSession({ label: 'Water ripple', request: 'warmer', takes: [], thumbs: new Map(), current: null, selected: null })).toBeNull()
  })

  it('maps takes to three tiles: drawn → ready, not yet drawn → pending, failed draw → failed', () => {
    const s = studioTakesSession({
      label: 'Water ripple', request: ' warmer ', takes: [a, b, c],
      thumbs: new Map<any, any>([[a, 'data:a'], [c, null]]), current: 'data:cur', selected: null,
    })!
    expect(s.nodeLabel).toBe('Water ripple')
    expect(s.request).toBe('warmer')
    expect(s.currentThumb).toBe('data:cur')
    expect(s.tiles.map(t => t.state)).toEqual(['ready', 'pending', 'failed'])
    expect(s.tiles[0]).toEqual({ state: 'ready', takeId: 'take-0', promptId: null, thumb: 'data:a' })
    expect(s.tiles[1]!.takeId).toBe('take-1')
  })

  it('two takes leave the third tile failed; more than three are cut to three', () => {
    const two = studioTakesSession({ label: 'x', request: '', takes: [a, b], thumbs: new Map<any, any>([[a, 'u'], [b, 'v']]), current: null, selected: null })!
    expect(two.tiles.map(t => t.state)).toEqual(['ready', 'ready', 'failed'])
    const four = studioTakesSession({ label: 'x', request: '', takes: [a, b, c, { label: 'd' }], thumbs: new Map(), current: null, selected: null })!
    expect(four.tiles).toHaveLength(3)
  })

  it('the selected take is the chosen tile; none selected means the current version', () => {
    const s = studioTakesSession({ label: 'x', request: '', takes: [a, b], thumbs: new Map(), current: null, selected: b })!
    expect(s.chosen).toBe('take-1')
    expect(studioTakesSession({ label: 'x', request: '', takes: [a], thumbs: new Map(), current: null, selected: null })!.chosen).toBe(CURRENT)
  })

  it('ids round-trip, and anything else is not a take', () => {
    expect(studioTakeIndex(studioTakeId(2))).toBe(2)
    expect(studioTakeIndex(CURRENT)).toBeNull()
    expect(studioTakeIndex(null)).toBeNull()
    expect(studioTakeIndex('take-x')).toBeNull()
  })

  it('a canvas thumbnail becomes a data URL; empty and null are no picture', () => {
    const cv = document.createElement('canvas')
    ;(cv as any).toDataURL = () => 'data:image/png;base64,AAA'
    expect(thumbSrc(cv)).toBe('data:image/png;base64,AAA')
    expect(thumbSrc('')).toBeNull()
    expect(thumbSrc(null)).toBeNull()
    expect(thumbSrc(undefined)).toBeNull()
  })
})
```

- [ ] **Step 2: Run them and see them fail**

Run: `cd frontend && npx vitest run tests/unit/studio-dispatch.unit.spec.ts tests/unit/studio-takes.unit.spec.ts`
Expected: FAIL, because the modules are missing.

- [ ] **Step 3: Implement**

```ts
// frontend/app/lib/prompt/studioDispatch.ts
// Which worker runs a routed request in a studio (AI in Sailor spec §4; stage 4
// plan rulings 1–4). Every studio keeps its own agent; this only decides whether
// the request goes to it or gets a plain message. Pure.
import type { RouterKind } from '~~/shared/promptRouter/router'
import { DISPATCH_MESSAGES } from '~/lib/prompt/canvasDispatch'

export type StudioPromptPlace = 'studio' | 'frame' | 'template' | 'scene3d'
export type StudioDispatch = { worker: 'ask'; text: string } | { worker: 'message'; message: string }

export const VARY_REQUEST = 'Three different directions'

export const STUDIO_MESSAGES = {
  newEffect: DISPATCH_MESSAGES.newEffect,
  copyInFrame: 'Copy is written in Frame. Open a Frame to write or rewrite its words.',
  layoutInFrame: 'Layouts are arranged in Frame. Open a Frame to try other layouts.',
  noWorker3d: '3D can’t take instructions yet. Use the tools below, or the inspector.',
  nothingToVary: 'Type what to change, or pick an action in the inspector.',
} as const

export function studioDispatch(
  kind: RouterKind,
  text: string,
  o: { place: StudioPromptPlace; hasWorker: boolean; canTakes: boolean; fromMenu?: boolean },
): StudioDispatch {
  const t = text.trim()
  if (!o.hasWorker) return { worker: 'message', message: STUDIO_MESSAGES.noWorker3d }
  if (kind === 'new-effect') return { worker: 'message', message: STUDIO_MESSAGES.newEffect }
  if ((kind === 'copy' || kind === 'layout') && o.place === 'studio')
    return { worker: 'message', message: kind === 'copy' ? STUDIO_MESSAGES.copyInFrame : STUDIO_MESSAGES.layoutInFrame }
  if (!t) {
    if (kind === 'tweak' && o.fromMenu && o.canTakes) return { worker: 'ask', text: VARY_REQUEST }
    return { worker: 'message', message: STUDIO_MESSAGES.nothingToVary }
  }
  return { worker: 'ask', text: t }
}

const LABEL_MAX = 24
const sentence = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1).toLowerCase() : s)

/** Frame's prompt chip (plan ruling 19): the layer's own words, never a guessed role. */
export function frameSelectionLabel(layers: { kind: string; text?: string | null; name?: string | null }[]): string | null {
  if (!layers.length) return null
  if (layers.length > 1) return `${layers.length} layers`
  const l = layers[0]!
  const text = (l.text ?? '').replace(/\s+/g, ' ').trim()
  if (l.kind === 'text' && text) {
    const cut = text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text
    return `“${cut}” · text`
  }
  const name = (l.name ?? '').trim()
  return name || sentence(l.kind)
}
```

```ts
// frontend/app/lib/prompt/studioTakes.ts
// A studio's take session (useStudioAgent) seen as stage 3's TakesSession, so the
// studios show the same PromptTakes strip as the canvas (spec §2.1a, §3.1; plan
// ruling 8). Pure apart from reading a canvas thumbnail as a data URL.
import { CURRENT, TAKES_PER_SET, type TakeTile, type TakesSession } from '~/lib/prompt/takesSession'
import type { TakeThumb } from '~/lib/agent/takeThumbs'

export const studioTakeId = (i: number): string => `take-${i}`

export function studioTakeIndex(id: string | null): number | null {
  const m = id ? /^take-(\d+)$/.exec(id) : null
  return m ? Number(m[1]) : null
}

export function thumbSrc(t: TakeThumb | undefined): string | null {
  if (!t) return null
  if (typeof t === 'string') return t || null
  try { return typeof t.toDataURL === 'function' ? t.toDataURL() || null : null } catch { return null }
}

export function studioTakesSession<T>(v: {
  label: string; request: string; takes: T[]; thumbs: Map<T, TakeThumb>; current: TakeThumb; selected: T | null
}): TakesSession | null {
  if (!v.takes.length) return null
  const tiles: TakeTile[] = Array.from({ length: TAKES_PER_SET }, (_, i) => {
    const take = v.takes[i]
    if (take === undefined) return { state: 'failed', takeId: null, promptId: null, thumb: null }
    if (!v.thumbs.has(take)) return { state: 'pending', takeId: studioTakeId(i), promptId: null, thumb: null }
    const thumb = thumbSrc(v.thumbs.get(take))
    return thumb
      ? { state: 'ready', takeId: studioTakeId(i), promptId: null, thumb }
      : { state: 'failed', takeId: studioTakeId(i), promptId: null, thumb: null }
  })
  const sel = v.selected ? v.takes.indexOf(v.selected) : -1
  return {
    nodeId: 'studio',
    nodeLabel: v.label,
    request: v.request.trim(),
    currentThumb: thumbSrc(v.current),
    known: [],
    tiles,
    hovered: null,
    chosen: sel >= 0 && sel < TAKES_PER_SET ? studioTakeId(sel) : CURRENT,
  }
}
```

- [ ] **Step 4: Run them and see them pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Full suite, typecheck, commit**

- Run `cd frontend && npx vitest run`. Expected: green, as at BASE.
- Typecheck both modules.
- Commit the four paths.
- Message: `feat(prompt): studio dispatch (each kind to the studio's own agent or a plain message), the studio takes adapter and Frame's selection chip`

---

### Task 2: `useStudioAgent` asks for three takes

**Files:**
- Modify: `frontend/app/composables/useStudioAgent.ts` (`TAKE_COUNT`, ~L45; the header comment's "Four Takes" wording)
- Modify: `frontend/app/composables/useVibeControl.ts` (`requestTakes`'s default `variants = 4`)
- Modify test: `frontend/tests/unit/studio-agent-takes.unit.spec.ts` (the count assertions, ~L122–146 and ~L300)

**Interfaces:**
- Consumes: `TAKES_PER_SET` from `~/lib/prompt/takesSession`.
- Produces: `useStudioAgent` asks `/api/vibe` for `variants: 3`. Nothing else about the request changes.

- [ ] **Step 1: Change the tests first**

In `studio-agent-takes.unit.spec.ts`:
- rename the test at ~L122 to `'asks /api/vibe for three variants and populates the strip'`;
- change `expect((opts as any).body.variants).toBe(4)` to `.toBe(3)` (~L130), `toHaveLength(4)` to `toHaveLength(3)` (~L146), and `expect(second.variants).toBe(4)` to `.toBe(3)` (~L300).

Then `grep -n "variants\|toHaveLength(4)\|four" tests/unit/studio-agent-takes.unit.spec.ts tests/unit/vibe-takes.unit.spec.ts tests/unit/vibe-control.unit.spec.ts`. For each remaining hit, decide whether it counts the **requested** takes (change it to 3) or tests the server's 2–4 range or the "over the cap" salvage (~L945: leave it). The mocked replies that return four takes to test the fallback and the cap stay as they are.

- [ ] **Step 2: Run them and see them fail**

Run: `cd frontend && npx vitest run tests/unit/studio-agent-takes.unit.spec.ts`
Expected: FAIL on the three count assertions (it still asks for 4).

- [ ] **Step 3: Implement**

In `useStudioAgent.ts`:

```ts
import { TAKES_PER_SET } from '~/lib/prompt/takesSession'

/** How many readings to ask for: always three (AI in Sailor spec §3.1). The API
 *  accepts 2–4 and rejects anything else loudly, so this is a constant. */
const TAKE_COUNT = TAKES_PER_SET
```

In `useVibeControl.ts`, change `variants = 4` to `variants = TAKES_PER_SET` (import it the same way). Update the "Four Takes" phrases in both files' comments to "three takes" where they describe the count; leave the design-doc filename references alone.

- [ ] **Step 4: Run them and see them pass**

Run: `cd frontend && npx vitest run tests/unit/studio-agent-takes.unit.spec.ts tests/unit/vibe-takes.unit.spec.ts tests/unit/vibe-control.unit.spec.ts tests/unit/takes-spread.unit.spec.ts`
Expected: PASS. If a spread or duplicate-pass test assumed four tiles, read it before changing it. A test that feeds four takes in to check the cap is not about the count asked for.

- [ ] **Step 5: Full suite, typecheck, commit**

- Run `cd frontend && npx vitest run`. Expected: green.
- Typecheck both composables.
- Commit the three paths (plus any spec you changed in Step 1).
- Message: `feat(studio): studio takes ask for three, not four (spec §3.1)`

---

### Task 3: `useStudioPrompt`: route, dispatch, cards and Stop for any studio worker

**Files:**
- Create: `frontend/app/composables/useStudioPrompt.ts`
- Test: `frontend/tests/unit/use-studio-prompt.unit.spec.ts`

**Interfaces:**
- Consumes:
  - Task 1: `studioDispatch`, `StudioPromptPlace`, `studioTakesSession`, `studioTakeIndex`;
  - stage 3: `routeRequest` (`~/lib/prompt/routeRequest`), `promptWorkingLabel` (`~/lib/prompt/canvasPromptContext`), `kindForMode`, `RouterKind`, `RouterHost`, `CURRENT`, `TakesSession`;
  - `ProposedChange`, `VisualReview` (`~/composables/useLayoutAgent`).
- Produces:
  - `interface StudioPromptWorker` (below).
  - `interface StudioPromptMode { label: string; kind: RouterKind }`
  - `interface StudioAnswerCard { kind: 'answer' | 'notice' | 'error'; text: string; reasoning: string; followUps: string[] }`
  - `type StudioPromptApi = ReturnType<typeof useStudioPrompt>`
  - `STUDIO_PROMPT_KEY: InjectionKey<StudioPromptApi>`
  - `useStudioPromptApi(): StudioPromptApi | null` (an inject with a null default)
  - `useStudioPrompt(o: { worker: () => StudioPromptWorker | null; place: StudioPromptPlace; host?: RouterHost; selectionKind: string; label: () => string | null; suggestions?: () => string[] }, deps?: { route?: typeof routeRequest; apiKey?: () => string })`, returning:
    - **Row:** `chipLabel`, `suggestions`, `mode`, `working`, `workingLabel`, `disabled`, `focusTick`
    - **Cards:** `card: ComputedRef<'takes' | 'changes' | 'answer' | null>`, `takes: ComputedRef<TakesSession | null>`, `answerCard: Ref<StudioAnswerCard | null>`, `worker: () => StudioPromptWorker | null`
    - **Actions:** `submit(text)`, `runKind(kind, o?: { text?: string; fromMenu?: boolean })`, `setMode(label)`, `clearMode()`, `stop()`, `previewTake(id | null)`, `chooseTake(id)`, `keepTake(id)`, `moreTakes()`, `closeTakes()`, `approve()`, `rejectAll()`, `dismissAnswer()`, `runFollowUp(text)`, `requestFocus()`

```ts
/** What every studio agent already returns (useStudioAgent, useTextureAgent,
 *  useCompositorAgent, useLayoutAgent). The take fields exist only on useStudioAgent. */
export interface StudioPromptWorker {
  busy: Ref<boolean>; error: Ref<string>; notice: Ref<string>
  changes: Ref<ProposedChange[]>; hasProposal: Ref<boolean> | ComputedRef<boolean>; hovered: Ref<number | null>
  review: Ref<VisualReview | null>; reviewing: Ref<boolean>; issues?: Ref<any[]>
  ask: (phrase: string) => unknown
  acceptChange: (i: number) => void; rejectChange: (i: number) => void; reroll: (i: number) => unknown
  keep: () => void; revert: () => void
  // take session (useStudioAgent only)
  hasTakes?: Ref<boolean> | ComputedRef<boolean>
  takes?: Ref<any[]>; takeThumbs?: Ref<Map<any, any>>; takeCurrentThumb?: Ref<any>; selectedTake?: Ref<any>
  previewTake?: (t: any | null) => void; selectTake?: (t: any | null) => void; keepTake?: () => void
  dismissTakes?: () => void; abandonTakes?: () => void; moreDirections?: () => unknown
}
```

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/use-studio-prompt.unit.spec.ts
// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { computed, defineComponent, h, nextTick, ref, shallowRef } from 'vue'
import { mount } from '@vue/test-utils'

;(globalThis as any).useLocalSettings = () => ({ getLocalSetting: () => 'k' })

import { useStudioPrompt, type StudioPromptWorker } from '~/composables/useStudioPrompt'
import { STUDIO_MESSAGES, VARY_REQUEST } from '~/lib/prompt/studioDispatch'

function makeWorker(withTakes = true) {
  const takes = shallowRef<any[]>([])
  const w: StudioPromptWorker = {
    busy: ref(false), error: ref(''), notice: ref(''), changes: ref([]), hovered: ref(null),
    hasProposal: computed(() => w.changes.value.length > 0) as any,
    review: ref(null), reviewing: ref(false),
    ask: vi.fn(async () => {}), acceptChange: vi.fn(), rejectChange: vi.fn(), reroll: vi.fn(), keep: vi.fn(), revert: vi.fn(),
  }
  if (withTakes) Object.assign(w, {
    takes, takeThumbs: shallowRef(new Map()), takeCurrentThumb: shallowRef(null), selectedTake: shallowRef(null),
    hasTakes: computed(() => takes.value.length > 0),
    previewTake: vi.fn(), selectTake: vi.fn(), keepTake: vi.fn(), dismissTakes: vi.fn(), abandonTakes: vi.fn(), moreDirections: vi.fn(),
  })
  return w
}

function setup(o: { worker?: StudioPromptWorker | null; place?: any; route?: any } = {}) {
  const worker = o.worker === undefined ? makeWorker() : o.worker
  const route = o.route ?? vi.fn(async () => ({ kind: 'tweak', followUps: [], routed: true }))
  let api!: ReturnType<typeof useStudioPrompt>
  mount(defineComponent({ setup() {
    api = useStudioPrompt({ worker: () => worker, place: o.place ?? 'studio', selectionKind: 'shader-studio', label: () => 'Water ripple', suggestions: () => ['Warmer'] }, { route, apiKey: () => 'k' })
    return () => h('div')
  } }))
  return { api, worker, route }
}

describe('useStudioPrompt', () => {
  it('routes with host studio and the thing’s own name, then hands the text to the worker', async () => {
    const { api, worker, route } = setup()
    await api.submit('warmer please')
    expect(route).toHaveBeenCalledWith(
      { request: 'warmer please', host: 'studio', selection: [{ kind: 'shader-studio', name: 'Water ripple' }], mode: null },
      expect.objectContaining({ apiKey: 'k' }),
    )
    expect(worker!.ask).toHaveBeenCalledWith('warmer please')
    expect(api.chipLabel.value).toBe('Water ripple')
  })

  it('frame routes with host frame', async () => {
    const { api, route } = setup({ place: 'frame' })
    await api.submit('shorter')
    expect(route.mock.calls[0][0].host).toBe('frame')
  })

  it('a kind with no worker shows a plain notice and never calls the worker', async () => {
    const { api, worker } = setup({ route: vi.fn(async () => ({ kind: 'new-effect', followUps: [], routed: true })) })
    await api.submit('rain on a window')
    expect(worker!.ask).not.toHaveBeenCalled()
    expect(api.card.value).toBe('answer')
    expect(api.answerCard.value).toMatchObject({ kind: 'notice', text: STUDIO_MESSAGES.newEffect })
  })

  it('3D with no worker answers with its message', async () => {
    const { api } = setup({ worker: null, place: 'scene3d' })
    await api.submit('make it glass')
    expect(api.answerCard.value).toMatchObject({ kind: 'notice', text: STUDIO_MESSAGES.noWorker3d })
  })

  it('working quotes the request while the worker is busy', async () => {
    const { api, worker } = setup()
    ;(worker!.ask as any).mockImplementation(async () => { worker!.busy.value = true })
    await api.submit('warmer')
    expect(api.working.value).toBe(true)
    expect(api.workingLabel.value).toBe('Working on “warmer”')
  })

  it('a worker notice with no result becomes an answer (with follow-ups) for kind answer', async () => {
    const { api, worker } = setup({ route: vi.fn(async () => ({ kind: 'answer', followUps: ['Lower warp'], routed: true })) })
    ;(worker!.ask as any).mockImplementation(async () => { worker!.busy.value = true; await Promise.resolve(); worker!.notice.value = 'Warp bends the ripples.'; worker!.busy.value = false })
    await api.submit('what does warp do?')
    await nextTick()
    expect(api.answerCard.value).toEqual({ kind: 'answer', text: 'Warp bends the ripples.', reasoning: '', followUps: ['Lower warp'] })
  })

  it('an error ends as an error card', async () => {
    const { api, worker } = setup()
    ;(worker!.ask as any).mockImplementation(async () => { worker!.busy.value = true; await Promise.resolve(); worker!.error.value = 'Rate limited'; worker!.busy.value = false })
    await api.submit('x')
    await nextTick()
    expect(api.answerCard.value).toMatchObject({ kind: 'error', text: 'Rate limited' })
  })

  it('takes win over the other cards and map to PromptTakes', async () => {
    const { api, worker } = setup()
    worker!.takes!.value = [{ label: 'a' }, { label: 'b' }, { label: 'c' }]
    await nextTick()
    expect(api.card.value).toBe('takes')
    expect(api.takes.value!.nodeLabel).toBe('Water ripple')
  })

  it('tile events drive the worker: hover previews, keep selects then keeps, × dismisses', async () => {
    const { api, worker } = setup()
    const t = [{ label: 'a' }, { label: 'b' }]
    worker!.takes!.value = t
    api.previewTake('take-1'); expect(worker!.previewTake).toHaveBeenLastCalledWith(t[1])
    api.previewTake(null); expect(worker!.previewTake).toHaveBeenLastCalledWith(null)
    api.chooseTake('take-0'); expect(worker!.selectTake).toHaveBeenLastCalledWith(t[0])
    api.keepTake('take-1'); expect(worker!.selectTake).toHaveBeenLastCalledWith(t[1]); expect(worker!.keepTake).toHaveBeenCalled()
    api.closeTakes(); expect(worker!.dismissTakes).toHaveBeenCalled()
    api.moreTakes(); expect(worker!.moreDirections).toHaveBeenCalled()
  })

  it('a proposal is the changes card; Approve keeps, Reject reverts', async () => {
    const { api, worker } = setup()
    worker!.changes.value = [{ command: { op: 'setParam' }, label: 'Warp', before: '1', after: '2', rationale: '', rerollable: true, accepted: true } as any]
    await nextTick()
    expect(api.card.value).toBe('changes')
    api.approve(); expect(worker!.keep).toHaveBeenCalled()
    api.rejectAll(); expect(worker!.revert).toHaveBeenCalled()
  })

  it('a mode chip decides the kind without routing; Tune goes to the worker', async () => {
    const { api, worker, route } = setup()
    api.setMode('Tune')
    expect(api.mode.value).toEqual({ label: 'Tune', kind: 'tweak' })
    await api.submit('slower')
    expect(route).toHaveBeenCalledWith(expect.objectContaining({ mode: 'Tune' }), expect.anything())
    expect(worker!.ask).toHaveBeenCalledWith('slower')
    expect(api.mode.value).toBeNull()
  })

  it('Vary from the inspector skips the router and sends the fixed request', async () => {
    const { api, worker, route } = setup()
    ;(worker!.ask as any).mockImplementation(async () => { worker!.busy.value = true })
    await api.runKind('tweak', { fromMenu: true })
    expect(route).not.toHaveBeenCalled()
    expect(worker!.ask).toHaveBeenCalledWith(VARY_REQUEST)
    expect(api.workingLabel.value).toBe('Making three takes of Water ripple')
  })

  it('Stop ends working at once, then throws away the stopped reply', async () => {
    const { api, worker } = setup()
    let finish!: () => void
    ;(worker!.ask as any).mockImplementation(() => { worker!.busy.value = true; return new Promise<void>(r => { finish = () => { worker!.takes!.value = [{ label: 'late' }]; worker!.busy.value = false; r() } }) })
    const sent = api.submit('warmer')
    await nextTick()
    api.stop()
    expect(api.working.value).toBe(false)
    expect(api.disabled.value).toBe(true) // until the stopped reply lands
    finish(); await sent; await nextTick()
    expect(worker!.abandonTakes).toHaveBeenCalled()
    expect(api.disabled.value).toBe(false)
  })

  it('Stop while routing aborts the route and never calls the worker', async () => {
    let seen: AbortSignal | undefined
    const route = vi.fn((_: any, o: any) => { seen = o.signal; return new Promise((_r, rej) => o.signal.addEventListener('abort', () => rej(new Error('aborted')))) })
    const { api, worker } = setup({ route })
    const sent = api.submit('x')
    api.stop()
    await sent
    expect(seen?.aborted).toBe(true)
    expect(worker!.ask).not.toHaveBeenCalled()
    expect(api.working.value).toBe(false)
  })

  it('a follow-up runs as a normal request', async () => {
    const { api, worker } = setup()
    await api.runFollowUp('Lower warp')
    expect(worker!.ask).toHaveBeenCalledWith('Lower warp')
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd frontend && npx vitest run tests/unit/use-studio-prompt.unit.spec.ts`
Expected: FAIL, because the module is missing.

- [ ] **Step 3: Write the composable**

```ts
// frontend/app/composables/useStudioPrompt.ts
/**
 * useStudioPrompt — the one prompt in a studio (AI in Sailor spec §2.1a, §2.4,
 * §3; stage 4 plan). The studio twin of useCanvasPrompt: a request is routed
 * (host studio or frame; a mode chip or an inspector action skips the call),
 * studioDispatch decides whether the studio's OWN agent runs it or a plain
 * message answers, and what comes back is shown above the prompt: three takes,
 * a proposed change, or an answer. The workers are unchanged.
 *
 * Stop lives here (plan ruling 6): no worker can abort, so Stop ends the working
 * state at once and throws the stopped run's reply away when it lands.
 *
 * The owner (StudioModalShell, CompositorModal, GridEditorShell) calls this and
 * provides it under STUDIO_PROMPT_KEY, so inspector action rows can reach it.
 */
import { computed, inject, onBeforeUnmount, ref, watch, type ComputedRef, type InjectionKey, type Ref } from 'vue'
import type { ProposedChange, VisualReview } from '~/composables/useLayoutAgent'
import { routeRequest } from '~/lib/prompt/routeRequest'
import { promptWorkingLabel } from '~/lib/prompt/canvasPromptContext'
import { studioDispatch, type StudioPromptPlace } from '~/lib/prompt/studioDispatch'
import { studioTakeIndex, studioTakesSession } from '~/lib/prompt/studioTakes'
import { CURRENT, type TakesSession } from '~/lib/prompt/takesSession'
import { kindForMode, type RouterHost, type RouterKind } from '~~/shared/promptRouter/router'

export interface StudioPromptWorker {
  busy: Ref<boolean>; error: Ref<string>; notice: Ref<string>
  changes: Ref<ProposedChange[]>; hasProposal: Ref<boolean> | ComputedRef<boolean>; hovered: Ref<number | null>
  review: Ref<VisualReview | null>; reviewing: Ref<boolean>; issues?: Ref<any[]>
  ask: (phrase: string) => unknown
  acceptChange: (i: number) => void; rejectChange: (i: number) => void; reroll: (i: number) => unknown
  keep: () => void; revert: () => void
  hasTakes?: Ref<boolean> | ComputedRef<boolean>
  takes?: Ref<any[]>; takeThumbs?: Ref<Map<any, any>>; takeCurrentThumb?: Ref<any>; selectedTake?: Ref<any>
  previewTake?: (t: any | null) => void; selectTake?: (t: any | null) => void; keepTake?: () => void
  dismissTakes?: () => void; abandonTakes?: () => void; moreDirections?: () => unknown
}
export interface StudioPromptMode { label: string; kind: RouterKind }
export interface StudioAnswerCard { kind: 'answer' | 'notice' | 'error'; text: string; reasoning: string; followUps: string[] }

export function useStudioPrompt(
  o: { worker: () => StudioPromptWorker | null; place: StudioPromptPlace; host?: RouterHost; selectionKind: string; label: () => string | null; suggestions?: () => string[] },
  deps: { route?: typeof routeRequest; apiKey?: () => string } = {},
) {
  const route = deps.route ?? routeRequest
  const apiKey = deps.apiKey ?? (() => useLocalSettings().getLocalSetting('Sailor.AI.AnthropicApiKey') ?? '')
  const host: RouterHost = o.host ?? (o.place === 'frame' ? 'frame' : 'studio')
  const worker = o.worker

  const mode = ref<StudioPromptMode | null>(null)
  const focusTick = ref(0)
  const routing = ref(false)
  const request = ref('')
  const answerCard = ref<StudioAnswerCard | null>(null)
  const stopped = ref(false) // a stopped run whose reply hasn't landed yet
  let routeCtrl: AbortController | null = null
  let lastKind: RouterKind | null = null
  let lastFollowUps: string[] = []
  let runSeq = 0

  const chipLabel = computed(() => o.label())
  const suggestions = computed(() => o.suggestions?.() ?? [])
  const workerBusy = computed(() => !!worker()?.busy.value)
  const working = computed(() => routing.value || (workerBusy.value && !stopped.value))
  const disabled = computed(() => stopped.value && workerBusy.value)
  // Vary from the inspector has no words: name the thing instead (stage 3's takesOf).
  const takesOf = ref<string | null>(null)
  const workingLabel = computed(() => promptWorkingLabel({ request: request.value, takesOf: takesOf.value }))

  const takes = computed<TakesSession | null>(() => {
    const w = worker()
    if (!w?.takes || !w.takeThumbs) return null
    return studioTakesSession({
      label: chipLabel.value ?? '', request: request.value, takes: w.takes.value,
      thumbs: w.takeThumbs.value, current: w.takeCurrentThumb?.value ?? null, selected: w.selectedTake?.value ?? null,
    })
  })
  const card = computed<'takes' | 'changes' | 'answer' | null>(() => {
    if (working.value) return null
    if (takes.value) return 'takes'
    if (worker()?.hasProposal.value) return 'changes'
    return answerCard.value ? 'answer' : null
  })

  // A run ends when the worker goes idle. A stopped run is thrown away; a live one
  // that made nothing shows its words (plan ruling 5).
  watch(workerBusy, (busy, was) => {
    if (busy || !was) return
    const w = worker()
    if (!w) return
    if (stopped.value) {
      if (w.hasTakes?.value) w.abandonTakes?.()
      if (w.hasProposal.value) w.revert()
      stopped.value = false
      return
    }
    if (w.hasTakes?.value || w.hasProposal.value) return
    if (w.error.value) answerCard.value = { kind: 'error', text: w.error.value, reasoning: '', followUps: [] }
    else if (w.notice.value) answerCard.value = {
      kind: lastKind === 'answer' ? 'answer' : 'notice', text: w.notice.value, reasoning: '',
      followUps: lastKind === 'answer' ? lastFollowUps : [],
    }
  })

  const canTakes = () => !!worker()?.takes

  async function dispatch(kind: RouterKind, text: string, fromMenu: boolean) {
    const d = studioDispatch(kind, text, { place: o.place, hasWorker: !!worker(), canTakes: canTakes(), fromMenu })
    if (d.worker === 'message') { answerCard.value = { kind: 'notice', text: d.message, reasoning: '', followUps: [] }; return }
    const w = worker()!
    w.abandonTakes?.()
    await w.ask(d.text)
  }

  function beginRun(text: string) {
    answerCard.value = null
    request.value = text
    takesOf.value = null
    stopped.value = false
    return ++runSeq
  }

  async function submit(text: string) {
    const t = text.trim()
    if (!t || working.value || disabled.value) return
    const seq = beginRun(t)
    const m = mode.value
    mode.value = null
    routeCtrl = new AbortController()
    routing.value = true
    let kind: RouterKind
    try {
      const out = await route(
        { request: t, host, selection: chipLabel.value ? [{ kind: o.selectionKind, name: chipLabel.value }] : [], mode: m?.label ?? null },
        { apiKey: apiKey(), signal: routeCtrl.signal },
      )
      kind = out.kind
      lastFollowUps = out.followUps
    } catch {
      return // aborted by Stop: drop it silently (routeRequest only rethrows on abort)
    } finally {
      if (seq === runSeq) routing.value = false
    }
    if (seq !== runSeq || stopped.value) return
    lastKind = kind
    await dispatch(kind, t, false)
  }

  /** An inspector action that decides its own kind (Vary): no router call. */
  async function runKind(kind: RouterKind, a: { text?: string; fromMenu?: boolean } = {}) {
    if (working.value || disabled.value) return
    beginRun(a.text?.trim() ?? '')
    if (kind === 'tweak' && a.fromMenu && !a.text?.trim()) takesOf.value = chipLabel.value ?? ''
    lastKind = kind
    lastFollowUps = []
    await dispatch(kind, a.text ?? '', !!a.fromMenu)
  }

  function setMode(label: string) {
    const kind = kindForMode(label)
    mode.value = kind ? { label, kind } : null
    focusTick.value++
  }
  function clearMode() { mode.value = null }
  function requestFocus() { focusTick.value++ }

  function stop() {
    routeCtrl?.abort()
    routing.value = false
    runSeq++
    if (workerBusy.value) stopped.value = true
  }

  // --- takes -------------------------------------------------------------------
  const takeAt = (id: string | null) => {
    const i = studioTakeIndex(id)
    return i == null ? null : worker()?.takes?.value[i] ?? null
  }
  function previewTake(id: string | null) { worker()?.previewTake?.(id === CURRENT ? null : takeAt(id)) }
  function chooseTake(id: string) { worker()?.selectTake?.(takeAt(id)) }
  function keepTake(id: string) {
    const w = worker()
    const t = takeAt(id)
    if (!w || !t) return
    w.selectTake?.(t)
    w.keepTake?.()
  }
  function moreTakes() { void worker()?.moreDirections?.() }
  function closeTakes() { worker()?.dismissTakes?.() }

  // --- changes and answers ----------------------------------------------------
  function approve() { worker()?.keep() }
  function rejectAll() { worker()?.revert() }
  function dismissAnswer() { answerCard.value = null }
  function runFollowUp(text: string) { return submit(text) }

  onBeforeUnmount(() => routeCtrl?.abort())

  return {
    chipLabel, suggestions, mode, working, workingLabel, disabled, focusTick,
    card, takes, answerCard, worker,
    submit, runKind, setMode, clearMode, stop, requestFocus,
    previewTake, chooseTake, keepTake, moreTakes, closeTakes,
    approve, rejectAll, dismissAnswer, runFollowUp,
  }
}

export type StudioPromptApi = ReturnType<typeof useStudioPrompt>
export const STUDIO_PROMPT_KEY: InjectionKey<StudioPromptApi> = Symbol('studio-prompt')
export function useStudioPromptApi(): StudioPromptApi | null { return inject(STUDIO_PROMPT_KEY, null) }
```

Notes for the implementer:
- `useLocalSettings` is a Nuxt auto-import. It is only called when no `deps.apiKey` is given, so the test's global stub is enough.
- The test "Stop ends working at once" needs the `workerBusy` watcher to run when `busy` flips false. It is a normal (pre-flush) watcher, and the test awaits `nextTick()` after `finish()`.

- [ ] **Step 4: Run it and see it pass**

Run the Step 2 command. Expected: PASS (15 tests).

- [ ] **Step 5: Full suite, typecheck, commit**

- Run `cd frontend && npx vitest run`. Expected: green.
- Typecheck `useStudioPrompt.ts`.
- Commit the two paths.
- Message: `feat(prompt): useStudioPrompt — route, the studio's own agent or a message, results above the prompt, and a Stop that drops the stopped reply`

---

### Task 4: `StudioPromptHost`, the shared tool bar, and the shell's new dock

**Files:**
- Create: `frontend/app/components/prompt/StudioPromptHost.vue`
- Create: `frontend/app/components/vue-canvas/studio/StudioToolBar.vue`
- Create: `frontend/app/components/vue-canvas/studio/StudioToolButton.vue`
- Modify: `frontend/app/components/vue-canvas/StudioModalShell.vue`
- Delete: `frontend/app/components/vue-canvas/studio/TakeStrip.vue`, and `frontend/tests/unit/take-strip.unit.spec.ts` (only after checking the grep in Step 5)
- Modify: `frontend/app/lib/agent/takeThumbs.ts` (comments that name `TakeStrip`; no code change)
- Modify test: `frontend/tests/unit/studio-modal-shell.unit.spec.ts`
- Test: `frontend/tests/unit/studio-prompt-host.unit.spec.ts`

**Interfaces:**
- Consumes:
  - Task 3: `useStudioPrompt`, `StudioPromptApi`, `STUDIO_PROMPT_KEY`, `StudioPromptWorker`;
  - stage 3: `SailorPrompt`, `PromptTakes`, `PromptChangesCard`, `PromptAnswerCard`, `shouldFocusPrompt`;
  - `AgentSweep`.
- Produces:
  - `StudioPromptHost.vue`:
    - prop `prompt: StudioPromptApi`
    - exposes `focus()`
    - root testid `studio-prompt`
  - `StudioToolBar.vue`: a default slot; testid `studio-tool-bar`.
  - `StudioToolButton.vue`:
    - props `label: string`, `active?: boolean`, `disabled?: boolean`, `title?: string`
    - an `icon` slot, which falls back to nothing
    - emits `click`
    - renders `<button type="button" :aria-pressed="active">` with the icon above the label (mockup `.bar button`: min-width 44px, 11px label)
  - `StudioModalShell.vue`:
    - props `agent?: StudioPromptWorker | null`, `promptLabel?: string | null`, `promptSuggestions?: string[]`, `promptPlace?: string` (the router selection kind), `promptHost?: 'studio' | 'scene3d'`, and the existing `title`, `breadcrumb`, `fullBleed`, `fullBleedBottomOffset`, `elevated`
    - **removed:** prop `agentPlaceholder`, and the slot `agentBar`
    - **new:** slot `tools`
    - it `provide`s the prompt api under `STUDIO_PROMPT_KEY`
    - testid `studio-shell-dock` on the dock (prompt + bar)

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/tests/unit/studio-prompt-host.unit.spec.ts
// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import StudioPromptHost from '~/components/prompt/StudioPromptHost.vue'

function api(over: Record<string, unknown> = {}) {
  return {
    chipLabel: ref('Water ripple'), suggestions: ref(['Warmer']), mode: ref(null), working: ref(false),
    workingLabel: ref('Working on “x”'), disabled: ref(false), focusTick: ref(0),
    card: ref(null), takes: ref(null), answerCard: ref(null),
    worker: () => ({ changes: ref([]), busy: ref(false), issues: ref([]), review: ref(null), reviewing: ref(false), hovered: ref(null), acceptChange: vi.fn(), rejectChange: vi.fn(), reroll: vi.fn() }),
    submit: vi.fn(), runKind: vi.fn(), setMode: vi.fn(), clearMode: vi.fn(), stop: vi.fn(), requestFocus: vi.fn(),
    previewTake: vi.fn(), chooseTake: vi.fn(), keepTake: vi.fn(), moreTakes: vi.fn(), closeTakes: vi.fn(),
    approve: vi.fn(), rejectAll: vi.fn(), dismissAnswer: vi.fn(), runFollowUp: vi.fn(),
    ...over,
  } as any
}

describe('StudioPromptHost', () => {
  it('renders the one prompt with the thing’s own name as the chip', () => {
    const w = mount(StudioPromptHost, { props: { prompt: api() } })
    expect(w.find('[data-testid="prompt-selection-chip"]').text()).toContain('Water ripple')
    expect(w.find('input[aria-label="Ask Sailor"]').attributes('placeholder')).toBe('Change or ask about Water ripple')
  })

  it('shows exactly one card, chosen by the api', () => {
    const takes = { nodeId: 'studio', nodeLabel: 'Water ripple', request: 'warmer', currentThumb: null, known: [], hovered: null, chosen: '__current__',
      tiles: [0, 1, 2].map(i => ({ state: 'ready', takeId: `take-${i}`, promptId: null, thumb: 'data:x' })) }
    const w = mount(StudioPromptHost, { props: { prompt: api({ card: ref('takes'), takes: ref(takes) }) } })
    expect(w.find('[data-testid="prompt-takes"]').exists()).toBe(true)
    expect(w.find('[data-testid="prompt-changes"]').exists()).toBe(false)
    const w2 = mount(StudioPromptHost, { props: { prompt: api({ card: ref('answer'), answerCard: ref({ kind: 'notice', text: 'Hi', reasoning: '', followUps: [] }) }) } })
    expect(w2.find('[data-testid="prompt-answer"]').text()).toContain('Hi')
  })

  it('sends on Enter and stops on Stop', async () => {
    const p = api()
    const w = mount(StudioPromptHost, { props: { prompt: p } })
    await w.find('input').setValue('warmer')
    await w.find('input').trigger('keydown', { key: 'Enter' })
    expect(p.submit).toHaveBeenCalledWith('warmer')
    const busyApi = api({ working: ref(true) })
    const busy = mount(StudioPromptHost, { props: { prompt: busyApi } })
    await busy.find('[data-testid="prompt-stop"]').trigger('click')
    expect(busyApi.stop).toHaveBeenCalled()
  })

  it('/ focuses it and the key does not reach the canvas below', async () => {
    const w = mount(StudioPromptHost, { props: { prompt: api() }, attachTo: document.body })
    const below = vi.fn()
    window.addEventListener('keydown', below)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }))
    await w.vm.$nextTick()
    expect(document.activeElement).toBe(w.find('input').element)
    expect(below).not.toHaveBeenCalled()
    window.removeEventListener('keydown', below)
    w.unmount()
  })
})
```

Rewrite `tests/unit/studio-modal-shell.unit.spec.ts` for the new dock. Keep every close-order test as it is. Only the stubs and the full-bleed cluster assertion change:
- **Stubs:** `global: { stubs: { StudioPromptHost: true, AgentSweep: true } }` (drop `AgentBar`, `AgentProgress`, `AgentProposal`).
- **`mounts the strip for a take-capable agent, and only then`** becomes **`mounts the prompt for an agent, and for a promptPlace with no agent`**:
  - `mountShell(takeAgent(calls), calls)` has `findComponent({ name: 'StudioPromptHost' })`;
  - a shell with neither `agent` nor `promptPlace` has none;
  - a shell with `promptPlace: 'scene3d-studio'` and no agent has one.
- **The Space Type test** (`no agent at all, own #agentBar`) becomes **`no agent and no promptPlace: no dock, closes byte-identically`**, without the `agentBar` slot.
- **`floats the takes + agent cluster bottom-centre…`**: the cluster now holds `StudioPromptHost` (`cluster.findComponent({ name: 'StudioPromptHost' }).exists()`), and the old `AgentBar` assertion goes.
- **Add** `it('renders #tools under the prompt, in the shared bar')`: mount with an agent and `slots: { tools: '<button data-testid="zoom-in">+</button>' }`, then assert that `[data-testid="studio-shell-dock"]` contains `[data-testid="studio-tool-bar"] [data-testid="zoom-in"]`, and that the prompt comes before the bar in document order.
- **Add** `it('never replaces the controls column')`: an agent with `busy: ref(true)` and `hasProposal: ref(true)` still renders the `#controls` slot content.

- [ ] **Step 2: Run them and see them fail**

Run: `cd frontend && npx vitest run tests/unit/studio-prompt-host.unit.spec.ts tests/unit/studio-modal-shell.unit.spec.ts`
Expected: FAIL (the host is missing, and the shell still has the takeover).

- [ ] **Step 3: Write the host and the bar**

```vue
<!-- frontend/app/components/prompt/StudioPromptHost.vue -->
<script setup lang="ts">
// The one prompt in a studio (spec §2.1a, §2.4). A thin template around
// SailorPrompt: the api (useStudioPrompt) owns the behaviour, the owner decides
// the width. Result cards sit in SailorPrompt's `above` slot, exactly as on the
// canvas. `/` and ⌘K focus it while mounted, and stop there so the canvas prompt
// under the modal never takes the key (plan ruling 11).
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import SailorPrompt from '~/components/prompt/SailorPrompt.vue'
import PromptTakes from '~/components/prompt/PromptTakes.vue'
import PromptChangesCard from '~/components/prompt/PromptChangesCard.vue'
import PromptAnswerCard from '~/components/prompt/PromptAnswerCard.vue'
import { shouldFocusPrompt } from '~/lib/prompt/sailorPrompt'
import type { StudioPromptApi } from '~/composables/useStudioPrompt'

const props = defineProps<{ prompt: StudioPromptApi }>()
const p = props.prompt
const promptRef = ref<InstanceType<typeof SailorPrompt> | null>(null)

function focus() { promptRef.value?.focus() }
watch(() => p.focusTick.value, () => focus())

function onKey(e: KeyboardEvent) {
  if (!shouldFocusPrompt(e) || !promptRef.value?.inputElement()) return
  e.preventDefault()
  e.stopImmediatePropagation()
  focus()
}
onMounted(() => window.addEventListener('keydown', onKey, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true))
defineExpose({ focus })
</script>

<template>
  <div data-testid="studio-prompt" class="w-full min-w-0">
    <SailorPrompt
      ref="promptRef"
      :selection-label="p.chipLabel.value"
      :mode="p.mode.value?.label ?? null"
      :suggestions="p.suggestions.value"
      :working="p.working.value"
      :working-label="p.workingLabel.value"
      :disabled="p.disabled.value"
      @submit="p.submit"
      @stop="p.stop"
      @clear-mode="p.clearMode"
      @clear-selection="p.clearMode"
    >
      <template v-if="p.card.value" #above>
        <PromptTakes
          v-if="p.card.value === 'takes' && p.takes.value"
          :session="p.takes.value"
          @hover="p.previewTake" @choose="p.chooseTake" @keep="p.keepTake" @more="p.moreTakes" @close="p.closeTakes"
        />
        <PromptChangesCard
          v-else-if="p.card.value === 'changes' && p.worker()"
          :changes="p.worker()!.changes.value" :busy="p.worker()!.busy.value"
          :issues="p.worker()!.issues?.value" :review="p.worker()!.review.value" :reviewing="p.worker()!.reviewing.value"
          :runnable="false"
          @accept="p.worker()!.acceptChange" @reject="p.worker()!.rejectChange" @reroll="p.worker()!.reroll"
          @approve="p.approve" @reject-all="p.rejectAll" @hover="(i: number | null) => (p.worker()!.hovered.value = i)"
        />
        <PromptAnswerCard
          v-else-if="p.card.value === 'answer' && p.answerCard.value"
          :card="p.answerCard.value"
          @close="p.dismissAnswer" @follow-up="p.runFollowUp"
        />
      </template>
    </SailorPrompt>
  </div>
</template>
```

Notes:
- In a studio the selection chip's × clears the **mode**, not a selection: a studio's chip is the thing being edited, and it can't be deselected from the prompt. If `SailorPrompt` hides × when no handler is bound, prefer that. Otherwise keep `clearMode`, which is harmless.
- Check `SailorPrompt` at HEAD for a `disabled` prop. It has one; the stopped-run state uses it.

```vue
<!-- frontend/app/components/vue-canvas/studio/StudioToolBar.vue -->
<script setup lang="ts">
// The small shared tool bar under a studio's prompt (spec §2.4): viewport
// controls only (zoom, repeat, play and scrub). Neutral — never pastel.
</script>

<template>
  <div data-testid="studio-tool-bar" class="flex max-w-full items-center gap-0.5 self-center overflow-x-auto rounded-[12px] border border-[#2a2a2a] bg-[#1a1a1a]/95 p-[5px] shadow-lg">
    <slot />
  </div>
</template>
```

```vue
<!-- frontend/app/components/vue-canvas/studio/StudioToolButton.vue -->
<script setup lang="ts">
defineProps<{ label: string; active?: boolean; disabled?: boolean; title?: string }>()
defineEmits<{ click: [e: MouseEvent] }>()
</script>

<template>
  <button
    type="button" :aria-pressed="active ? 'true' : 'false'" :disabled="disabled" :title="title ?? label"
    class="grid min-w-[44px] justify-items-center gap-px whitespace-nowrap rounded-[8px] px-2 pb-1 pt-[5px] text-[11px] text-white/75 transition hover:bg-white/[0.06] hover:text-white disabled:opacity-40"
    :class="active ? 'bg-white/[0.1] text-white' : ''"
    @click="$emit('click', $event)"
  >
    <span class="grid h-[18px] place-items-center text-[15px] leading-none"><slot name="icon" /></span>
    <span>{{ label }}</span>
  </button>
</template>
```

- [ ] **Step 4: Rewrite the shell's dock**

In `StudioModalShell.vue`:

1. **Imports.** Remove `AgentBar`, `AgentProgress`, `AgentProposal`, `TakeStrip`. Add:

```ts
import { provide } from 'vue'
import StudioPromptHost from '~/components/prompt/StudioPromptHost.vue'
import StudioToolBar from '~/components/vue-canvas/studio/StudioToolBar.vue'
import AgentSweep from '~/components/agent/AgentSweep.vue'
import { STUDIO_PROMPT_KEY, useStudioPrompt, type StudioPromptWorker } from '~/composables/useStudioPrompt'
```

2. **Props.** Replace `agent?: any` and `agentPlaceholder?: string` with the props below. Keep the rest.

```ts
  agent?: StudioPromptWorker | null
  /** The chip: the thing's own name or text (spec §1.2). */
  promptLabel?: string | null
  promptSuggestions?: string[]
  /** Router selection kind, e.g. 'shader-studio'. With no agent (3D), still mounts the prompt. */
  promptPlace?: string
  promptHost?: 'studio' | 'scene3d'
```

3. **Script.**
   - Delete `agentActive` and `hasTakes`.
   - Keep `requestClose` (it still calls `props.agent?.abandonTakes?.()` first).
   - Add:

```ts
const hasPrompt = computed(() => !!props.agent || !!props.promptPlace)
const prompt = useStudioPrompt({
  worker: () => props.agent ?? null,
  place: props.promptHost === 'scene3d' ? 'scene3d' : 'studio',
  selectionKind: props.promptPlace ?? 'studio',
  label: () => props.promptLabel ?? null,
  suggestions: () => props.promptSuggestions ?? [],
})
provide(STUDIO_PROMPT_KEY, prompt)
```

   `onKeydown`'s Escape branch already returns early on `e.defaultPrevented`. `SailorPrompt` prevents default on its own Esc, so Esc in the prompt leaves the prompt without closing the studio. Keep that.

4. **Template, full-bleed branch.** Replace the cluster (TakeStrip + AgentBar) with:

```html
<div v-if="hasPrompt || $slots.tools" data-testid="studio-shell-bottom-cluster"
     class="pointer-events-none absolute left-1/2 z-20 w-full max-w-[640px] -translate-x-1/2 px-4"
     :style="{ bottom: bottomOffset + 'px' }">
  <div data-testid="studio-shell-dock" class="pointer-events-auto flex flex-col gap-2">
    <StudioPromptHost v-if="hasPrompt" :prompt="prompt" />
    <StudioToolBar v-if="$slots.tools"><slot name="tools" /></StudioToolBar>
  </div>
</div>
```

5. **Template, boxed branch.** Replace the TakeStrip and `#agentBar` blocks with the same dock as a flow sibling under the preview. Also wrap the preview area so the sweep can cover it:

```html
<div v-if="hasPrompt || $slots.tools" data-testid="studio-shell-dock" class="mt-3 mb-3 flex w-full max-w-[640px] shrink-0 flex-col gap-2 self-center">
  <StudioPromptHost v-if="hasPrompt" :prompt="prompt" />
  <StudioToolBar v-if="$slots.tools"><slot name="tools" /></StudioToolBar>
</div>
```

   For the sweep over the preview (Ruling 10), add inside the preview container (both branches), as its last child:

```html
<div v-if="hasPrompt" class="pointer-events-none absolute inset-0 z-10"><AgentSweep :active="prompt.working.value" :period="3" palette="lagoon" /></div>
```

   Give the boxed preview container `relative` so the overlay is bounded. `AgentSweep` must stay mounted (not `v-if` on `working`), as `SailorPrompt`'s comment explains.

6. **Controls column.** Delete the `<template v-if="agentActive">…</template>` takeover. `<slot name="controls" />` always renders.

7. **Header comment.** Update it: the shell now docks the one prompt and the shared tool bar, and results show above the prompt.

- [ ] **Step 5: Delete `TakeStrip`, then run the tests**

- `grep -rn "TakeStrip" frontend/app frontend/tests`. If the only hits are `TakeStrip.vue` itself, its unit spec, comments in `takeThumbs.ts`/`useStudioAgent.ts`, and `reviewStripStyles.ts`/`ReviewTile.vue` (which are shared with the sketch review strip, so leave them), then `git rm` `TakeStrip.vue` and `tests/unit/take-strip.unit.spec.ts`, and change the comments to say `PromptTakes`.
- Any other importer: leave the file, and note it for Task 11.
- Run: `cd frontend && npx vitest run tests/unit/studio-prompt-host.unit.spec.ts tests/unit/studio-modal-shell.unit.spec.ts`
- Expected: PASS.

- [ ] **Step 6: Full suite, typecheck, commit**

- Run `cd frontend && npx vitest run`. The surfaces still pass `agent-placeholder` and `#agentBar`; Vue ignores an unknown attribute and an unused slot, so the suite stays green. Tasks 6–8 remove them.
- Typecheck the shell, the host and both bar components.
- Commit the paths, using `git rm --cached` for the two deletions.
- Message: `feat(studio): the one prompt and a shared tool bar dock under every studio preview; results above the prompt, never over the controls`

---

### Task 5: Inspector actions: the registry, the light rows and the head

**Files:**
- Create: `frontend/app/lib/studio/studioActions.ts`
- Create: `frontend/app/components/vue-canvas/studio/StudioActionRows.vue`
- Create: `frontend/app/components/vue-canvas/studio/StudioInspectorHead.vue`
- Test: `frontend/tests/unit/studio-actions.unit.spec.ts`

**Interfaces:**
- Consumes:
  - `ActionGroup`, `ActionLands`, `landsHint` from `~/lib/canvas/nodeActions`;
  - Task 3: `useStudioPromptApi`, `StudioPromptApi`;
  - `AiMark`.
- Produces:
  - `type StudioActionRun = { mode: string } | { kind: 'tweak'; fromMenu: true } | { call: () => void }`
  - `interface StudioAction { id: string; label: string; group: ActionGroup; ai: boolean; lands: ActionLands; run: StudioActionRun }`
  - `type StudioActionPlace = 'shader' | 'gradient' | 'shape' | 'texture' | 'vectortype' | 'spacetype' | 'frame'`
  - `studioActions(o: { place: StudioActionPlace; canTakes: boolean; local?: StudioAction[] }): StudioAction[]`, where `local` holds the non-AI rows a surface owns (re-rolls). They are placed by their own group.
  - `runStudioAction(a: StudioAction, prompt: Pick<StudioPromptApi, 'setMode' | 'runKind'> | null): void`
  - `REMIX_ACTION: StudioAction` (`{ id: 'remix', label: 'Remix…', group: 'develop', ai: true, lands: 'takes', run: { mode: 'Remix' } }`), for Shader's head (Ruling 16)
  - `StudioActionRows.vue`:
    - prop `actions: StudioAction[]`, an optional `prompt?: StudioPromptApi` (defaults to the injected one), and `bare?: boolean` (no headings, for a single row in a head)
    - testids `studio-actions`, `studio-action-row` (with `data-action-id`)
    - "Edit" / "Develop" headings, and a group with no rows is not rendered
  - `StudioInspectorHead.vue`:
    - props `title: string`, `subtitle?: string | null`
    - default slot for recipe buttons
    - testid `studio-inspector-head`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/unit/studio-actions.unit.spec.ts
// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { REMIX_ACTION, runStudioAction, studioActions } from '~/lib/studio/studioActions'
import StudioActionRows from '~/components/vue-canvas/studio/StudioActionRows.vue'

const ids = (a: { id: string }[]) => a.map(x => x.id)

describe('studioActions', () => {
  it('every studio with a worker can Tune; Vary only where there are takes', () => {
    expect(ids(studioActions({ place: 'gradient', canTakes: true }))).toEqual(['tune', 'vary'])
    expect(ids(studioActions({ place: 'texture', canTakes: false }))).toEqual(['tune'])
  })
  it('Shader adds a new layer from a description (Remix lives in the head)', () => {
    expect(ids(studioActions({ place: 'shader', canTakes: true }))).toEqual(['tune', 'vary', 'new-layer'])
  })
  it('Frame adds Write copy', () => {
    expect(ids(studioActions({ place: 'frame', canTakes: false }))).toEqual(['tune', 'write-copy'])
  })
  it('local rows join their group, after the AI rows of that group', () => {
    const reroll = { id: 'reroll', label: 'Re-roll', group: 'develop' as const, ai: false, lands: null, run: { call: vi.fn() } }
    const out = studioActions({ place: 'shape', canTakes: true, local: [reroll] })
    expect(ids(out)).toEqual(['tune', 'vary', 'reroll'])
  })
  it('the landing hint says 3 takes only where takes exist', () => {
    const [tuneT] = studioActions({ place: 'gradient', canTakes: true })
    const [tuneP] = studioActions({ place: 'texture', canTakes: false })
    expect(tuneT!.lands).toBe('takes')
    expect(tuneP!.lands).toBeNull()
  })
  it('labels are sentence case, with no identifiers', () => {
    for (const a of studioActions({ place: 'shader', canTakes: true })) {
      expect(a.label).toMatch(/^[A-Z]/)
      expect(a.label).not.toMatch(/tweak|new-effect|_/)
    }
  })
  it('runs: a mode chip, a kind, or the surface’s own call', () => {
    const p = { setMode: vi.fn(), runKind: vi.fn() }
    const [tune, vary, newLayer] = studioActions({ place: 'shader', canTakes: true })
    runStudioAction(tune!, p); expect(p.setMode).toHaveBeenCalledWith('Tune')
    runStudioAction(vary!, p); expect(p.runKind).toHaveBeenCalledWith('tweak', { fromMenu: true })
    runStudioAction(newLayer!, p); expect(p.setMode).toHaveBeenLastCalledWith('New effect')
    const call = vi.fn()
    runStudioAction({ id: 'x', label: 'X', group: 'develop', ai: false, lands: null, run: { call } }, null)
    expect(call).toHaveBeenCalled()
  })
})

describe('StudioActionRows', () => {
  it('renders Edit then Develop, light rows with the ✦ and hint on AI rows only', () => {
    const prompt = { setMode: vi.fn(), runKind: vi.fn() } as any
    const local = [{ id: 'reroll', label: 'Re-roll', group: 'develop' as const, ai: false, lands: null, run: { call: vi.fn() } }]
    const w = mount(StudioActionRows, { props: { actions: studioActions({ place: 'shape', canTakes: true, local }), prompt } })
    expect(w.findAll('h4').map(h => h.text())).toEqual(['Edit', 'Develop'])
    const rows = w.findAll('[data-testid="studio-action-row"]')
    expect(rows.map(r => r.attributes('data-action-id'))).toEqual(['tune', 'vary', 'reroll'])
    expect(rows[1]!.text()).toContain('3 takes')
    expect(rows[1]!.findComponent({ name: 'AiMark' }).exists()).toBe(true)
    expect(rows[2]!.findComponent({ name: 'AiMark' }).exists()).toBe(false)
  })
  it('bare: one row, no headings (Remix in Shader’s head)', () => {
    const w = mount(StudioActionRows, { props: { actions: [REMIX_ACTION], bare: true, prompt: { setMode: vi.fn(), runKind: vi.fn() } as any } })
    expect(w.findAll('h4')).toHaveLength(0)
    expect(w.find('[data-action-id="remix"]').text()).toContain('Remix…')
  })
  it('a click runs the action through the prompt', async () => {
    const prompt = { setMode: vi.fn(), runKind: vi.fn() } as any
    const w = mount(StudioActionRows, { props: { actions: studioActions({ place: 'gradient', canTakes: true }), prompt } })
    await w.find('[data-action-id="tune"]').trigger('click')
    expect(prompt.setMode).toHaveBeenCalledWith('Tune')
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd frontend && npx vitest run tests/unit/studio-actions.unit.spec.ts`
Expected: FAIL, because the modules are missing.

- [ ] **Step 3: Implement**

```ts
// frontend/app/lib/studio/studioActions.ts
// Studio inspector actions (spec §1.4, §2.4, §7.3): the same Edit / Develop
// vocabulary as the node toolbar, as light rows under the thing itself. AI rows
// go through the studio's one prompt: a mode chip that waits for words, or a
// kind that runs at once. A surface adds its own non-AI rows (re-rolls) as `local`.
import type { ActionGroup, ActionLands } from '~/lib/canvas/nodeActions'
import type { StudioPromptApi } from '~/composables/useStudioPrompt'

export type StudioActionRun = { mode: string } | { kind: 'tweak'; fromMenu: true } | { call: () => void }
export interface StudioAction { id: string; label: string; group: ActionGroup; ai: boolean; lands: ActionLands; run: StudioActionRun }
export type StudioActionPlace = 'shader' | 'gradient' | 'shape' | 'texture' | 'vectortype' | 'spacetype' | 'frame'

export function studioActions(o: { place: StudioActionPlace; canTakes: boolean; local?: StudioAction[] }): StudioAction[] {
  const takes: ActionLands = o.canTakes ? 'takes' : null
  const edit: StudioAction[] = [{ id: 'tune', label: 'Tune…', group: 'edit', ai: true, lands: takes, run: { mode: 'Tune' } }]
  if (o.place === 'frame') edit.push({ id: 'write-copy', label: 'Write copy…', group: 'edit', ai: true, lands: null, run: { mode: 'Write copy' } })
  const develop: StudioAction[] = []
  if (o.canTakes) develop.push({ id: 'vary', label: 'Vary', group: 'develop', ai: true, lands: 'takes', run: { kind: 'tweak', fromMenu: true } })
  if (o.place === 'shader') develop.push({ id: 'new-layer', label: 'New layer from a description…', group: 'develop', ai: true, lands: 'takes', run: { mode: 'New effect' } })
  const local = o.local ?? []
  return [...edit, ...local.filter(a => a.group === 'edit'), ...develop, ...local.filter(a => a.group === 'develop')]
}

/** Shader's Recipe → Remix (spec §7.3). A mode chip; stage 5 gives it a worker. */
export const REMIX_ACTION: StudioAction = { id: 'remix', label: 'Remix…', group: 'develop', ai: true, lands: 'takes', run: { mode: 'Remix' } }

export function runStudioAction(a: StudioAction, prompt: Pick<StudioPromptApi, 'setMode' | 'runKind'> | null): void {
  const r = a.run
  if ('call' in r) { r.call(); return }
  if ('mode' in r) { prompt?.setMode(r.mode); return }
  void prompt?.runKind(r.kind, { fromMenu: true })
}
```

`StudioActionRows.vue`:
- **Headings** `<h4>` in the inspector's small-caps style (copy `StudioSection`'s heading classes, 11px, `text-white/45`).
- **Rows** are `<button type="button" data-testid="studio-action-row" :data-action-id="a.id">`. From the mockup's `.arow`: `flex w-full items-center justify-between rounded-[7px] bg-white/[0.05] px-[9px] py-1.5 text-[12.5px] text-white/85 hover:bg-white/[0.08]`.
- **The right side** shows `landsHint(a.lands)` in 11px `text-white/45`, then `<AiMark v-if="a.ai" kind="star" class="size-3" />`. No primary button.
- **The prompt** is `props.prompt ?? useStudioPromptApi()`.

`StudioInspectorHead.vue`:
- The title is 13px medium `text-white/90`, truncated with a `title` attribute. The subtitle is 11px `text-white/45`.
- The slot renders under them in a `flex flex-wrap gap-1.5` row.
- Recipe buttons use `StudioButton` (the standing rule: StudioButton *is* the button).

- [ ] **Step 4: Run it and see it pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Full suite, typecheck, commit**

- Run `cd frontend && npx vitest run`. Expected: green.
- Typecheck the three files.
- Commit the four paths.
- Message: `feat(studio): inspector actions — one Edit / Develop registry, light rows with ✦ and landing hints, and a head for the thing itself`

---

### Task 6: Gradient, Shader, Shape and Vector type use the dock and the new inspector order

These four already use `useStudioAgent` with takes, so their change has the same shape.

**Files:**
- Modify: `frontend/app/components/vue-canvas/GradientStudioSurface.vue`
- Modify: `frontend/app/components/vue-canvas/ShaderStudioSurface.vue`
- Modify: `frontend/app/components/vue-canvas/ShapeStudioSurface.vue`
- Modify: `frontend/app/components/vue-canvas/VectorTypeSurface.vue`
- Test: `frontend/tests/unit/studio-surfaces-prompt.unit.spec.ts`

**Interfaces:**
- Consumes:
  - Task 4: the shell's `promptLabel`, `promptSuggestions`, `promptPlace` and `#tools`; `StudioToolButton`;
  - Task 5: `studioActions`, `StudioActionRows`, `StudioInspectorHead`.
- Produces: nothing new. Each surface passes `:agent`, `:prompt-label`, `:prompt-suggestions` and `prompt-place`, drops `agent-placeholder`, and opens its `#controls` with head → actions → the existing sections.

- [ ] **Step 1: Write the failing test (a source-level wiring guard)**

These surfaces are too large to mount in a unit test. This guard pins the wiring; the Playwright spec (Task 12) proves the behaviour.

```ts
// frontend/tests/unit/studio-surfaces-prompt.unit.spec.ts
// Stage 4 wiring guard: every simple studio docks the one prompt with its own
// chip and lists actions before its dials. Source-level on purpose — the surfaces
// are thousands of lines of WebGL; the Playwright spec proves the behaviour.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = (name: string) => readFileSync(fileURLToPath(new URL(`../../app/components/vue-canvas/${name}`, import.meta.url)), 'utf8')
const SIMPLE: Record<string, string> = {
  'GradientStudioSurface.vue': 'gradient-studio',
  'ShaderStudioSurface.vue': 'shader-studio',
  'ShapeStudioSurface.vue': 'shape-studio',
  'VectorTypeSurface.vue': 'vector-type-studio',
}

describe('simple studios dock the one prompt', () => {
  for (const [file, place] of Object.entries(SIMPLE)) {
    it(`${file}: chip, place, no bespoke placeholder`, () => {
      const s = src(file)
      expect(s).toContain(':prompt-label=')
      expect(s).toContain(`prompt-place="${place}"`)
      expect(s).not.toContain('agent-placeholder')
      expect(s).not.toContain('#agentBar')
    })
    it(`${file}: the inspector opens with the head, then actions`, () => {
      const s = src(file)
      const controls = s.slice(s.indexOf('<template #controls>'))
      const head = controls.indexOf('<StudioInspectorHead')
      const actions = controls.indexOf('<StudioActionRows')
      expect(head).toBeGreaterThan(-1)
      expect(actions).toBeGreaterThan(head)
      // nothing but the head sits before the actions
      expect(controls.slice(0, head)).not.toMatch(/<StudioSection|<StudioControlPanel/)
    })
  }
  it('Gradient’s zoom lives in the tool bar, not on the preview', () => {
    const s = src('GradientStudioSurface.vue')
    const tools = s.slice(s.indexOf('<template #tools>'), s.indexOf('</template>', s.indexOf('<template #tools>')))
    expect(tools).toContain('zoomBy(')
    expect(tools).toContain('resetZoom')
    const preview = s.slice(s.indexOf('<template #preview>'), s.indexOf('<template #tools>'))
    expect(preview).not.toContain('zoomBy(')
  })
  it('Vector type’s play and scrub live in the tool bar; the footer has no second Play', () => {
    const s = src('VectorTypeSurface.vue')
    const tools = s.slice(s.indexOf('<template #tools>'), s.indexOf('</template>', s.indexOf('<template #tools>')))
    expect(tools).toMatch(/playing/)
    expect(tools).toMatch(/onSeek|previewTime/)
    const footer = s.slice(s.indexOf('<template #actions>'))
    expect(footer.slice(0, footer.indexOf('</template>'))).not.toMatch(/Pause|togglePlay/)
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd frontend && npx vitest run tests/unit/studio-surfaces-prompt.unit.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Wire each surface**

In each surface, change the shell call and the `#controls` opening. Keep every existing section below the actions, in its current order; those are the Dials.

**Shared, all four:**
- Remove `agent-placeholder="…"`.
- Add `prompt-place="<place>"`, `:prompt-label="promptLabel"` and `:prompt-suggestions="['Warmer', 'Calmer', 'More contrast']"`. Suggestions are the same for every take studio (Ruling 20).
- Add a `promptLabel` computed as below. The same value is the head's title.
- At the top of `<template #controls>` add:

```html
<StudioInspectorHead :title="promptLabel" :subtitle="…">…recipe buttons…</StudioInspectorHead>
<StudioActionRows :actions="inspectorActions" />
```

  with `const inspectorActions = computed(() => studioActions({ place: '<place>', canTakes: true, local: [...] }))`.
- If a surface's inspector has Design/Motion tabs at the top, the head and actions go **above** the tabs.

**Shader** (`place: 'shader'`, `prompt-place="shader-studio"`):
- `promptLabel`: the active effect's label (the name the picker button shows today), else `'Shader'`.
- Head: `title=promptLabel`, `subtitle=` the effect's category (as the picker modal groups it). Slot:
  - `<StudioButton @click="openPicker">Change effect</StudioButton>`;
  - Remix… as a one-row `<StudioActionRows bare :actions="[REMIX_ACTION]" />` (Task 5 exports `REMIX_ACTION`).

  Why a row and not a `StudioButton` calling the prompt: the surface can't `useStudioPromptApi()`, because the shell (which provides it) is the surface's *child*. Components rendered inside the shell's slots are the shell's descendants, so `StudioActionRows` can inject it.
- Move the picker button out of "Stylized Effects" (it is now in the head); the effect's params stay there.
- `local`: `[{ id: 'new-variation', label: 'New variation', group: 'develop', ai: false, lands: null, run: { call: rerollSeed } }]`. Remove the "New variation" button from Source (the seed slider stays).
- No tool bar: nothing to move (Ruling 13).

**Gradient** (`place: 'gradient'`, `prompt-place="gradient-studio"`):
- `promptLabel`: the selected layer's name from the layer stack (the label `StudioLayerStack` shows), else `'Gradient'`.
- Head subtitle: none.
- `local`: `[{ id: 'randomize', label: 'Randomize', group: 'develop', ai: false, lands: null, run: { call: () => randomize('all') } }]`.
- Move the zoom toolbar (~L999–1011) out of `#preview` into a new `<template #tools>`, using `StudioToolButton`: "Zoom out" (icon `Minus`, `zoomBy(1/1.25)` or whatever the existing − does), a percentage button labelled `${Math.round(zoom*100)}%` that calls `resetZoom`, and "Zoom in". Keep the exact handlers the existing buttons call. The wheel zoom and pan stay on the preview.

**Shape** (`place: 'shape'`, `prompt-place="shape-studio"`):
- `promptLabel`: the selected layer's name, else `'Shape'`.
- `local`: `[{ id: 'reroll', label: 'Re-roll', group: 'develop', ai: false, lands: null, run: { call: rerollConfig } }]`. Remove the Re-roll button from the seed card; keep the card's seed display.
- No tool bar (Ruling 13).

**Vector type** (`place: 'vectortype'`, `prompt-place="vector-type-studio"`):
- `promptLabel`: the document's text (the value the Text section edits), whitespace collapsed and trimmed to 24 characters with "…", else `'Vector type'`.
- Head subtitle: the font family.
- `local`: none.
- `<template #tools>`, shown only when `animated`:
  - `StudioToolButton` "Pause"/"Play" bound to `playing`, doing what the footer's Play/Pause does today (find its handler around ~L1711);
  - a scrubber: `<input type="range" aria-label="Scrub preview" class="h-1 w-40 accent-white" :min="0" :max="duration" step="0.01" :value="previewTime" @input="onSeek(($event.target as HTMLInputElement).valueAsNumber)">`. Read `MoveTimeline`'s props to get the duration ref it is given, and use the same.
- Remove the footer's Play/Pause utility. `MoveTimeline` stays where it is under the canvas in the Motion tab: it is a timeline editor, not a viewport control.

- [ ] **Step 4: Run it and see it pass**

Run: `cd frontend && npx vitest run tests/unit/studio-surfaces-prompt.unit.spec.ts tests/unit/studio-actions.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Full suite, typecheck, commit**

- Run `cd frontend && npx vitest run`. Surface-specific specs (for example `gradient-*`, `shader-studio-*`, `vector-type-*`) that asserted the old footer Play, or the seed card's Re-roll, need updating to the new place. Change only what moved.
- Typecheck the four surfaces.
- Commit the paths.
- Message: `feat(studio): Gradient, Shader, Shape and Vector type dock the one prompt; zoom and play move into the tool bar; inspectors open with the thing, then actions`

---

### Task 7: Texture and Space type: the tool bar, and Space type leaves `VibeControlBar`

**Files:**
- Modify: `frontend/app/components/vue-canvas/TextureStudioSurface.vue`
- Modify: `frontend/app/components/vue-canvas/SpaceTypeSurface.vue`
- Delete: `frontend/app/components/vue-canvas/VibeControlBar.vue` (and any spec that mounts it: `grep -rln VibeControlBar frontend/tests`)
- Modify test: `frontend/tests/unit/studio-surfaces-prompt.unit.spec.ts`

**Interfaces:**
- Consumes: Tasks 4 and 5; `useStudioAgent` (for Space type, without `takes`).
- Produces: Space type's worker is `useStudioAgent({ controls: () => effect.value.controls, params, label: () => effect.value.label })`. Its request to `/api/vibe` is byte-identical to `onVibe`'s `requestPatch(effect.value.controls, params, effect.value.label, phrase)`.

- [ ] **Step 1: Extend the guard (failing)**

Add to `studio-surfaces-prompt.unit.spec.ts`:

```ts
describe('Texture and Space type', () => {
  it('Texture docks the prompt; repeat and seams are in the bar; the raster content prompt stays', () => {
    const s = src('TextureStudioSurface.vue')
    expect(s).toContain('prompt-place="pattern-studio"')
    expect(s).not.toContain('agent-placeholder')
    const tools = s.slice(s.indexOf('<template #tools>'), s.indexOf('</template>', s.indexOf('<template #tools>')))
    expect(tools).toContain('setRepeat(')
    expect(tools).toContain('toggleSeams')
    expect(s).toContain('Describe a texture to generate') // content prompt, stage 6
  })
  it('Space type uses useStudioAgent through the shell, and VibeControlBar is gone', () => {
    const s = src('SpaceTypeSurface.vue')
    expect(s).toContain('useStudioAgent(')
    expect(s).toContain(':agent="spaceTypeAgent"')
    expect(s).toContain('prompt-place="space-type-studio"')
    expect(s).not.toMatch(/VibeControlBar|onVibe\b|vibeProposal|#agentBar/)
  })
  it('Space type’s transport is in the bar, not floating on the preview', () => {
    const s = src('SpaceTypeSurface.vue')
    const tools = s.slice(s.indexOf('<template #tools>'), s.indexOf('</template>', s.indexOf('<template #tools>')))
    expect(tools).toContain('togglePlay')
    expect(tools).toContain('onScrub(')
    const preview = s.slice(s.indexOf('<template #preview>'), s.indexOf('<template #tools>'))
    expect(preview).not.toContain('onScrub(')
  })
})
```

Also add both files to the head-then-actions check: `'TextureStudioSurface.vue': 'pattern-studio'` and `'SpaceTypeSurface.vue': 'space-type-studio'` in `SIMPLE`.

- [ ] **Step 2: Run it and see it fail**

Run: `cd frontend && npx vitest run tests/unit/studio-surfaces-prompt.unit.spec.ts`
Expected: FAIL on the new cases.

- [ ] **Step 3: Texture**

- **Shell:**
  - drop `agent-placeholder`;
  - add `prompt-place="pattern-studio"`, `:prompt-label="promptLabel"` (the lattice's display name, as `TEXTURE_SECTIONS` names it; else `'Pattern'`) and `:prompt-suggestions="['Tighter cells', 'Two colours only']"`.
- **`<template #tools>`**, Design tab only (`v-if="inspectorTab === 'design'"` inside): three `StudioToolButton`s "1×", "2×", "3×" (`:active="repeat === n"`, `@click="setRepeat(n)"`), a separator (`<span class="mx-1 w-px self-stretch bg-white/10" />`), and "Seams" (`:active="seams"`, `@click="toggleSeams"`). Remove the old row (~L598–607).
- **The raster row** (~L609–639: Import image, the content prompt, Make seamless) stays under the canvas, unchanged (Ruling 14).
- **Inspector:** head (`title=promptLabel`) and `StudioActionRows` with `studioActions({ place: 'texture', canTakes: false, local: [{ id: 'roll', label: 'Roll', group: 'develop', ai: false, lands: null, run: { call: roll } }] })`, above the Design/Output tabs.
- **Footer:** remove the "Roll · seed N" utility, and show the seed in the head's subtitle: `Seed ${seed}`, using the same value the footer showed.

- [ ] **Step 4: Space type**

1. **The worker.** Replace the vibe state and handlers (`requestPatch` destructure, `vibeBusy`, `vibeProposal`, `vibeSnapshot`, `vibeMoved`, `fmt` if unused elsewhere, `onVibe`, `onVibeKeep`, `onVibeRevert`, `onVibeFocus`) with:

```ts
// The one prompt's worker (stage 4, plan ruling 15): the same /api/vibe tune the
// old VibeControlBar sent, now through useStudioAgent so its proposal shows above
// the prompt like every other studio's.
const spaceTypeAgent = useStudioAgent({
  controls: () => effect.value.controls,
  params,
  label: () => effect.value.label,
})
```

   Before deleting, grep the file for each removed name. `vibeMoved`, for example, may highlight moved controls in the inspector; if so, drop that highlight too. Note it in the report.
2. **Shell:**
   - add `:agent="spaceTypeAgent"`, `prompt-place="space-type-studio"`, `:prompt-label="promptLabel"` (the text the effect renders, `params.text` or whatever the Text control's key is, collapsed and trimmed to 24 characters, else the effect's label) and `:prompt-suggestions="['Slower', 'More spacing']"`;
   - delete the `#agentBar` template and the `VibeControlBar` import.
3. **Transport.** Move Play/Pause, the range scrubber and the frame counter from the preview pill (~L1789–1802) into `<template #tools v-if="webglOk">`:
   - Play/Pause is a `StudioToolButton` with the existing SVG icons in its `icon` slot;
   - the scrubber and counter are plain elements inside the bar: `class="h-1 w-48 cursor-pointer accent-white"` and `text-[10px] tabular-nums text-white/45`.

   The render-error and frozen-fields notices stay on the preview.
4. **Inspector.**
   - Head: `title=promptLabel`, `subtitle=effect.label`, with `<StudioButton @click="showEffectGallery = true">Change effect</StudioButton>` in the slot. It moves from the Design card, and that card keeps Reset, Make as default and Capture thumbnail.
   - Then `StudioActionRows` with `studioActions({ place: 'spacetype', canTakes: false })`. That is Tune only, since Space type has no takes.
   - Both go above the Design/Motion tabs.
5. **Delete** `VibeControlBar.vue` with `git rm`. First `grep -rn "VibeControlBar" frontend/app frontend/tests`. Update comments that name it (`AgentBar.vue`'s header comment names it; leave that file for Task 11).

- [ ] **Step 5: Run it and see it pass**

Run: `cd frontend && npx vitest run tests/unit/studio-surfaces-prompt.unit.spec.ts`
Expected: PASS.

- [ ] **Step 6: Full suite, typecheck, commit**

- Run `cd frontend && npx vitest run`. Expected: green.
- Typecheck both surfaces.
- `SpaceTypeSurface.vue` is on the shared-files list: save its `.before.patch` before your first edit, and commit only your hunks.
- Commit, with `git rm --cached` for `VibeControlBar.vue`.
- Message: `feat(studio): Texture and Space type dock the one prompt; repeat, seams and the transport move into the tool bar; VibeControlBar retires`

---

### Task 8: 3D: the one prompt above whichever bar shows

**Files:**
- Modify: `frontend/app/components/vue-canvas/Scene3DStudioSurface.vue`
- Modify test: `frontend/tests/unit/studio-surfaces-prompt.unit.spec.ts`

**Interfaces:**
- Consumes: Task 4's shell (`promptPlace`, `promptHost="scene3d"`, `fullBleedBottomOffset`).
- Produces: 3D mounts the prompt with no worker. Every request gives `STUDIO_MESSAGES.noWorker3d` (Ruling 1).

- [ ] **Step 1: Extend the guard (failing)**

```ts
describe('3D', () => {
  it('mounts the prompt with no worker, and lifts it above whichever bar shows', () => {
    const s = src('Scene3DStudioSurface.vue')
    expect(s).toContain('prompt-place="scene3d-studio"')
    expect(s).toContain('prompt-host="scene3d"')
    expect(s).toContain(':full-bleed-bottom-offset="promptOffset"')
    expect(s).not.toMatch(/:full-bleed-bottom-offset="72"/)
    expect(s).toMatch(/bottomBarEl/)
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd frontend && npx vitest run tests/unit/studio-surfaces-prompt.unit.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- **Shell:**
  - add `prompt-place="scene3d-studio"`, `prompt-host="scene3d"` and `:prompt-label="promptLabel"`, where `promptLabel` is the selected object's name as the object list shows it, else `null`;
  - no suggestions (Ruling 20);
  - replace `:full-bleed-bottom-offset="72"` with `:full-bleed-bottom-offset="promptOffset"`.
- **Measure the bar that shows.** All three bars (add ~L4947, sculpt ~L5225, Motion dock ~L4926) sit at the bottom of the viewport. Give each root `ref="bottomBarEl"` (only one is mounted at a time: their `v-if`s are exclusive), then:

```ts
// The prompt sits directly above whichever bottom bar is showing — the add bar,
// the sculpt bar or the Motion timeline (spec §2.4 "takeover modes"; plan ruling 1).
// One ref, because exactly one of the three is mounted at a time.
const bottomBarEl = ref<HTMLElement | null>(null)
const bottomBarHeight = ref(0)
let bottomBarObserver: ResizeObserver | null = null
watch(bottomBarEl, (el) => {
  bottomBarObserver?.disconnect()
  bottomBarHeight.value = el?.offsetHeight ?? 0
  if (el && typeof ResizeObserver !== 'undefined') {
    bottomBarObserver = new ResizeObserver(() => { bottomBarHeight.value = el.offsetHeight })
    bottomBarObserver.observe(el)
  }
}, { flush: 'post' })
onBeforeUnmount(() => bottomBarObserver?.disconnect())
/** bottom-3 (12px) + the bar + an 8px gap; 16 when no bar shows (WebGL off). */
const promptOffset = computed(() => (bottomBarHeight.value ? 12 + bottomBarHeight.value + 8 : 16))
```

  If the Motion dock uses a different bottom inset than `bottom-3`, read its class and use that number in `promptOffset` for that mode (`activeTab === 'motion'`). Don't guess.
- **Inspector:** unchanged (Ruling 1).
- **Content prompts** (Generate ~L5138, restyle ~L5390, texture ~L5848, relief ~L5931) stay; they're recipes (stage 6).

- [ ] **Step 4: Run it and see it pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Full suite, typecheck, commit**

- Run `cd frontend && npx vitest run`. Expected: green.
- Typecheck the surface.
- `Scene3DStudioSurface.vue` is on the shared-files list, so commit only your hunks.
- Message: `feat(3d): the one prompt sits above whichever bar shows (add, sculpt, Motion); 3D has no worker yet, so it answers plainly`

---

### Task 9: Frame: the one prompt replaces the pill, stays in Motion, and results leave the right panel

**Files:**
- Modify: `frontend/app/components/vue-canvas/CompositorModal.vue`
- Test: `frontend/tests/unit/compositor-prompt-wiring.unit.spec.ts`

**Interfaces:**
- Consumes:
  - Task 1: `frameSelectionLabel`;
  - Task 3: `useStudioPrompt`, `STUDIO_PROMPT_KEY`;
  - Task 4: `StudioPromptHost`;
  - Task 5: `studioActions`, `StudioActionRows`.
- Produces:
  - `CompositorModal` creates `framePrompt = useStudioPrompt({ worker: () => frameWorker, place: 'frame', selectionKind: 'frame-layer', label: () => frameChip.value, suggestions: () => frameSuggestions.value })` and provides it;
  - testid `compositor-prompt-dock` stays on the prompt's wrapper (existing Playwright specs use it);
  - `compositor-prompt-pill` is gone.

- [ ] **Step 1: Write the failing guard**

```ts
// frontend/tests/unit/compositor-prompt-wiring.unit.spec.ts
// Stage 4 wiring guard for Frame (spec §2.4, §2.5): the one prompt replaces the
// pill, stays in Motion mode, and the agent no longer takes over the right panel.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const s = readFileSync(fileURLToPath(new URL('../../app/components/vue-canvas/CompositorModal.vue', import.meta.url)), 'utf8')

describe('Frame’s prompt', () => {
  it('is the one prompt, not AgentBar, and has no pill', () => {
    expect(s).toContain('<StudioPromptHost')
    expect(s).not.toMatch(/import AgentBar|<AgentBar/)
    expect(s).not.toContain('compositor-prompt-pill')
    expect(s).not.toMatch(/promptExpanded/)
  })
  it('the agent no longer takes over the right panel', () => {
    expect(s).not.toMatch(/caPanelActive|<AgentProposal|<AgentProgress/)
  })
  it('the prompt is outside the motion v-if; only the tool bar is hidden in Motion', () => {
    const dock = s.indexOf('data-testid="compositor-prompt-dock"')
    const toolbar = s.indexOf('data-testid="compositor-toolbar"')
    expect(dock).toBeGreaterThan(-1)
    expect(toolbar).toBeGreaterThan(dock) // prompt first, then the bar
    expect(s.slice(Math.max(0, dock - 300), dock)).not.toContain("inspectorTab !== 'motion'")
    expect(s.slice(Math.max(0, toolbar - 200), toolbar)).toContain("inspectorTab !== 'motion'")
  })
  it('the chip quotes the layer, and the inspector lists actions', () => {
    expect(s).toContain('frameSelectionLabel(')
    expect(s).toContain('<StudioActionRows')
    expect(s).toContain("place: 'frame'")
  })
})
```

The third assertion needs the tool bar root to carry `data-testid="compositor-toolbar"`. Check whether it already has a testid, and add this one if not.

- [ ] **Step 2: Run it and see it fail**

Run: `cd frontend && npx vitest run tests/unit/compositor-prompt-wiring.unit.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Save the `.before.patch` first; this file is shared.

1. **Imports.** Remove `AgentBar`, `AgentProposal` and `AgentProgress` (~L79–81). Add `StudioPromptHost`, `StudioActionRows`, `useStudioPrompt` + `STUDIO_PROMPT_KEY`, `frameSelectionLabel` and `studioActions`, plus `provide` from vue.
2. **The worker.** Next to the `useCompositorAgent` destructure (~L1558), keep the whole return in one object as well:

```ts
const compositorAgent = useCompositorAgent({ /* existing options, unchanged */ })
const { busy: caBusy, /* …existing aliases, unchanged… */ } = compositorAgent
// The prompt's worker: Frame's own agent, with the snap-to-design-size step
// onAgentAsk has always done before an ask.
const frameWorker = { ...compositorAgent, ask: (phrase: string) => onAgentAsk(phrase) }
```

   If the existing code destructures `useCompositorAgent(...)` directly, change it to assign first and destructure from the variable. Keep every alias name, because the rest of the file uses them.
3. **The chip and suggestions:**

```ts
// The chip quotes the selected layer's own words (spec §1.2, §2.5; plan ruling 19).
const frameChip = computed(() => frameSelectionLabel(
  (selectedLayers.value ?? []).map((l: any) => ({ kind: String(l.kind), text: l.text ?? null, name: l.name ?? null })),
))
const frameSuggestions = computed(() => {
  const one = selectedLayers.value?.length === 1 ? selectedLayers.value[0] : null
  if (!one) return ['Tighten the layout', 'Warm the palette']
  if (one.kind === 'text') return ['Shorter', 'Bolder']
  if (isBackgroundLayer(one)) return ['Warmer background']
  return []
})
const framePrompt = useStudioPrompt({ worker: () => frameWorker, place: 'frame', selectionKind: 'frame-layer', label: () => frameChip.value, suggestions: () => frameSuggestions.value })
provide(STUDIO_PROMPT_KEY, framePrompt)
```

   `isBackgroundLayer`: use whatever the file already uses to tell the background layer apart (grep `background` near the layer kinds; the Background section at ~L12293 shows how). If there is no single predicate, use `one.kind === 'background'` only if that kind exists. Otherwise drop that branch and note it.
4. **Pill state.** Delete `promptFocused`, `promptDraft`, `promptExpanded`, `onPromptInput`, `onPromptFocusOut` and `focusPrompt` (~L1818–1848), and every reference to them. Grep each name. If `focusPrompt` is called by a Frame keyboard shortcut, replace that call with `framePrompt.requestFocus()`. Delete `caPanelActive` (~L1601).
5. **The bottom stack** (~L9108). Change the outer `v-if="inspectorTab !== 'motion'"` so the column always renders. Inside it:
   - the prompt dock first, always:

     ```html
     <div v-show="editMode === 'none'" data-testid="compositor-prompt-dock" class="pointer-events-auto w-full" :class="inspectorTab === 'motion' ? 'mx-auto max-w-[720px]' : ''"><StudioPromptHost :prompt="framePrompt" /></div>
     ```

   - then the existing tool bar, wrapped as `<div v-if="inspectorTab !== 'motion'" data-testid="compositor-toolbar">…</div>`, unchanged inside;
   - then move the Motion timeline block (~L9471–9474, `v-if="inspectorTab === 'motion'"`) **into** the column, after the tool bar, so the prompt sits directly above it. The timeline block is `absolute bottom-8` today. As a flow child of the column it must lose `absolute bottom-8` and keep its width logic (`gapLeft`/`gapRight`). If it measures itself for the panel insets, keep its ref.

   If moving the timeline breaks its layout in a way you can't resolve by reading it, stop and ask. Don't guess at `MotionBandTimeline`'s sizing.

   The edit-image prompt (~L9064–9103, `editMode !== 'none'`) is a **content** prompt ("Describe the change…"). It stays, and the dock is hidden while it shows (`v-show="editMode === 'none'"`, as today).
6. **The right panel.**
   - Delete the `<template v-if="caPanelActive">…</template>` block (~L9576–9595) and its `AgentProgress` / `AgentProposal`.
   - The tabs' `v-if="!caPanelActive"` (~L9564) becomes unconditional.
   - The `v-else-if` chain that followed now starts at `brandOpen`.
7. **Inspector actions.** In the layer-selected branch (~L11013), directly under the header row (kind icon, name, forward and backward buttons), add `<div class="px-4 pt-3"><StudioActionRows :actions="frameActions" /></div>` with:

```ts
const frameActions = computed(() => studioActions({ place: 'frame', canTakes: false, local: [
  { id: 'layouts', label: 'Try layouts', group: 'develop', ai: false, lands: null, run: { call: () => { inspectorTab.value = 'layout' } } },
] }))
```

   Add the same rows at the top of the no-selection branch (~L12248), above the Frame section. §2.4 puts the thing itself first: with nothing selected, the thing is the Frame, and its section follows the actions. So in that branch the order is **the Frame section header, then the actions, then the other sections**. Put the rows right after the Frame section's heading block, not inside its dials.
8. **The sweep.** `<AgentSweep :active="caBusy" />` (~L8184) becomes `:active="framePrompt.working.value"`. A stopped run should stop sweeping.

- [ ] **Step 4: Run it and see it pass**

Run: `cd frontend && npx vitest run tests/unit/compositor-prompt-wiring.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Existing Frame specs**

- `grep -rln "compositor-prompt-pill\|compositor-prompt-dock\|data-expanded" frontend/tests`. Update unit and Playwright specs that expected the pill: the dock is always a full row now, and `data-expanded` is gone.
- `tests/agent-compositor-vocab.spec.ts` (if it types into the Frame prompt) must now find the input by role (`getByRole('textbox', { name: 'Ask Sailor' })`) inside `compositor-prompt-dock`, and must mock `/api/prompt-route` as well as `/api/agent-plan`.

- [ ] **Step 6: Full suite, typecheck, commit**

- Run `cd frontend && npx vitest run`. Expected: green.
- Typecheck `CompositorModal.vue`, filtered to lines that name it, compared to BASE.
- Commit only your hunks (shared file).
- Message: `feat(frame): the one prompt replaces the Ask pill, stays above the Motion timeline, and its results show above it instead of taking over the inspector`

---

### Task 10: The template editor's prompt moves to the same component

**Files:**
- Modify: `frontend/app/components/templates/GridEditorShell.vue`
- Test: `frontend/tests/unit/grid-editor-prompt.unit.spec.ts`

**Interfaces:**
- Consumes: Tasks 3 and 4 (`useStudioPrompt` with `place: 'template'`, `StudioPromptHost`).
- Produces: the template editor's bottom cluster holds `StudioPromptHost` above its tool row (v3 templates only, as today). The right panel no longer has an Assistant takeover.

- [ ] **Step 1: Write the failing guard**

```ts
// frontend/tests/unit/grid-editor-prompt.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const s = readFileSync(fileURLToPath(new URL('../../app/components/templates/GridEditorShell.vue', import.meta.url)), 'utf8')

describe('template editor prompt', () => {
  it('is the one prompt, in the bottom cluster above the tools', () => {
    expect(s).toContain('<StudioPromptHost')
    expect(s).not.toMatch(/import AgentBar|<AgentBar|<AgentProposal|<AgentProgress|agentPanelActive/)
    const host = s.indexOf('<StudioPromptHost')
    const toolsRow = s.indexOf('Mode toggle', host)
    expect(toolsRow).toBeGreaterThan(host)
  })
  it('routes as a template (copy and layout go to its agent)', () => {
    expect(s).toContain("place: 'template'")
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd frontend && npx vitest run tests/unit/grid-editor-prompt.unit.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

1. Keep the `useLayoutAgent` call. Assign its return to `layoutAgent` first, then keep the existing destructure from it, so every alias survives.
2. Add:

```ts
const templatePrompt = useStudioPrompt({
  worker: () => layoutAgent,
  place: 'template',
  selectionKind: 'template-element',
  label: () => templateChip.value,
  suggestions: () => ['Tighten spacing', 'Apply brand'],
})
provide(STUDIO_PROMPT_KEY, templatePrompt)
```

   `templateChip` is the selected element's own text, trimmed to 24 characters (read the element inspector at ~L477 to see how the selected element and its text are reached), else its name, else `null`. Several selected → `"N elements"`.
3. **Bottom cluster** (~L605): replace `<div v-if="isV3(template)"><AgentBar …/></div>` with `<div v-if="isV3(template)" class="w-full"><StudioPromptHost :prompt="templatePrompt" /></div>`. The column already stretches to the tool row's width.
4. **Right panel:** delete the Assistant takeover (~L458–476) and `agentPanelActive`. Keep `onAgentHover` only if something else uses it.
5. **The sweep:** the file already imports `AgentSweep`. Bind it to `templatePrompt.working.value` wherever it is bound to `agentBusy`.
6. Remove the `AgentBar`, `AgentProposal` and `AgentProgress` imports.

- [ ] **Step 4: Run it and see it pass**

Run the Step 2 command. Expected: PASS. Also run any `grid-editor*` specs: `npx vitest run tests/unit -t "GridEditor"`.

- [ ] **Step 5: Full suite, typecheck, commit**

- Run `cd frontend && npx vitest run`. Expected: green.
- Typecheck `GridEditorShell.vue`.
- Commit the two paths.
- Message: `feat(templates): the template editor's prompt is the one prompt, above its tool bar; results show above it`

---

### Task 11: The guard test, and retiring `AgentBar`

**Files:**
- Create: `frontend/tests/unit/single-instruction-prompt.unit.spec.ts`
- Delete (conditionally, Ruling 21): `frontend/app/components/agent/AgentBar.vue`, `AgentProgress.vue`, `AgentProposal.vue`
- Modify: comments that name the deleted files (grep)

**Interfaces:**
- Consumes: the whole stage.
- Produces: the §2.1a guard.

- [ ] **Step 1: Write the guard**

```ts
// frontend/tests/unit/single-instruction-prompt.unit.spec.ts
// AI in Sailor spec §2.1a: one prompt component renders every INSTRUCTION prompt.
// This fails if any .vue outside components/prompt/ brings back a prompt of its
// own. Content prompts (the recipe on an element: "Describe a texture…") are a
// different thing (§1.5) and are allowed by name below until stage 6 gives them
// the shared content field.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = fileURLToPath(new URL('../../app', import.meta.url))
const PROMPT_DIRS = ['components/prompt/', 'lib/prompt/']

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (/\.(vue|ts)$/.test(name)) acc.push(p)
  }
  return acc
}
const files = walk(appRoot).map(p => ({ rel: relative(appRoot, p).split('\\').join('/'), text: readFileSync(p, 'utf8') }))
const outside = (rel: string) => !PROMPT_DIRS.some(d => rel.startsWith(d))
const vueOutside = files.filter(f => f.rel.endsWith('.vue') && outside(f.rel))

/**
 * Fields that sit next to an AI mark but are NOT instruction prompts. Each says
 * why. Stage 6 (the shared content field) replaces most of these; remove an
 * entry when its field moves. Never add an instruction prompt here.
 */
const CONTENT_FIELDS: Record<string, string> = {
  // Fill this from Step 2's first run: one line per file, with its reason, e.g.
  // 'components/vue-canvas/TextureStudioSurface.vue': 'content prompt: Describe a texture to generate (stage 6)',
}

describe('only the one prompt takes instructions (spec §2.1a)', () => {
  it('no component imports a retired prompt', () => {
    const bad = vueOutside.filter(f => /import\s+(AgentBar|VibeControlBar|CanvasPromptBar)\b/.test(f.text)).map(f => f.rel)
    expect(bad).toEqual([])
  })

  it('the prompt’s own words appear only in the prompt', () => {
    const sig = /aria-label="Ask Sailor"|['"`]Ask Sailor['"`]|Change or ask about/
    const bad = files.filter(f => outside(f.rel) && sig.test(f.text)).map(f => f.rel)
    expect(bad).toEqual([])
  })

  it('no text field sits beside an AI mark outside the prompt, unless it is a named content field', () => {
    const bad: string[] = []
    for (const f of vueOutside) {
      const tpl = f.text.slice(f.text.indexOf('<template'))
      const lines = tpl.split('\n')
      lines.forEach((line, i) => {
        if (!/<(input|textarea)\b/.test(line)) return
        if (/type="(range|checkbox|radio|color|file|number)"/.test(line)) return
        const near = lines.slice(Math.max(0, i - 6), i + 7).join('\n')
        if (/<AiMark\b|✦|<Sparkles\b/.test(near) && !CONTENT_FIELDS[f.rel]) bad.push(`${f.rel}:${i + 1}`)
      })
    }
    expect(bad).toEqual([])
  })

  it('every allowlisted content field still exists and still has a reason', () => {
    for (const [rel, why] of Object.entries(CONTENT_FIELDS)) {
      expect(files.some(f => f.rel === rel), rel).toBe(true)
      expect(why.length).toBeGreaterThan(10)
    }
  })
})
```

- [ ] **Step 2: Run it and fill the allowlist**

Run: `cd frontend && npx vitest run tests/unit/single-instruction-prompt.unit.spec.ts`

The third test lists every text field beside an AI mark. For each hit, open the file and decide:
- **An instruction prompt** ("tell Sailor what to change about this"): it is a bug this stage missed. Stop, and report it to the controller with the file and line. Don't allowlist it.
- **A content prompt, a search field or a label editor** (the planning-time list: Texture's "Describe a texture…", Frame's "Describe the element…" / "Describe the change…", `CompositorAnimatePanel` "What should move, and how", `InpaintModal`, `PoseEditorModal`, `PoseMannequinNode`, the Scene3D generate/restyle/texture/relief inputs, `GridPropertyPanel`'s copy brief, `LoraTrainerSurface`, `LoraGalleryModal`, `CharacterStudioModal`, `ProductShotApp`, `FontPicker` ×2, `PortIntentPopover` "What do you want to do?", which searches node types, §5): add it to `CONTENT_FIELDS` with a one-line reason naming the field.

The first two tests must pass with no allowlist. At planning time "Ask Sailor" and "Change or ask about" appeared only in `components/prompt/SailorPrompt.vue` and `lib/prompt/sailorPrompt.ts`. `CanvasPromptBar.vue`, if it still exists, imports `SailorPrompt`, which is not a retired prompt, so it passes.

Expected after filling: PASS.

- [ ] **Step 3: Retire the old components**

```bash
cd /Users/julien/Documents/GitHub/Sailor/frontend
grep -rn "AgentBar\b" app tests | grep -v "components/agent/AgentBar.vue"
grep -rn "AgentProgress\b" app tests | grep -v "components/agent/AgentProgress.vue"
grep -rn "AgentProposal\b" app tests | grep -v "components/agent/AgentProposal.vue"
```

For each component with **no importer left** (comments don't count), `git rm` it, and fix the comments that name it. `AgentProposal` is still imported by `CanvasPromptBar.vue` until stage 3 Task 9 lands; leave it if so, and write that in your report.

- [ ] **Step 4: Full suite, typecheck, commit**

- Run `cd frontend && npx vitest run`. Expected: green.
- Commit the guard and the deletions (`git rm --cached` inside the private-index call).
- Message: `test(prompt): only the one prompt takes instructions (spec §2.1a guard); AgentBar retires`

---

### Task 12: Playwright: the one prompt in the studios

**Files:**
- Create: `frontend/tests/studio-prompt.spec.ts`. The implementer writes it; the controller runs it.

**Interfaces:**
- Uses:
  - `sailor:addNode` (via `dropNode`), `sailor:openShaderStudio`, `sailor:openSpaceType`, `sailor:openScene3DStudio` with `{ nodeId }` (check each handler's detail shape in `VueNodeCanvas.vue` ~L5457–5486 before writing);
  - `openCompositor` from `_helpers`.
- Test ids used:
  - `studio-shell-dock`, `studio-tool-bar`, `studio-prompt`, `studio-actions`, `studio-action-row`
  - `prompt-takes`, `prompt-take-tile`, `prompt-changes`, `prompt-answer`, `prompt-mode-chip`, `prompt-stop`, `prompt-selection-chip`
  - `compositor-prompt-dock`

- [ ] **Step 1: Write the spec**

```ts
// frontend/tests/studio-prompt.spec.ts
import { expect, test, type Page } from '@playwright/test'
import { dropNode, openBlankWorkflow, openCompositor, waitForBackend } from './_helpers'

/**
 * AI in Sailor stage 4: the one prompt in the studios. /api/prompt-route,
 * /api/vibe and /api/agent-plan are all mocked — nothing here reaches a model.
 * Hover-to-preview and typing speed need the real-mouse pass (plan Task 13).
 */

const prompt = (page: Page) => page.getByTestId('studio-prompt').getByRole('textbox', { name: 'Ask Sailor' })

async function seedKey(page: Page) {
  await page.addInitScript(() => { try { localStorage.setItem('sailor:Sailor.AI.AnthropicApiKey', 'sk-ant-test-studio') } catch {} })
}
async function mockRouter(page: Page, kind: string, followUps: string[] = []) {
  const calls: any[] = []
  await page.route('**/api/prompt-route', async (r) => { calls.push(r.request().postDataJSON()); await r.fulfill({ json: { kind, followUps, credits: null } }) })
  return calls
}
/** /api/vibe answering in three takes. Keys are read from the request's own
 *  controls, so the takes are always valid for whatever studio asked. */
async function mockVibeTakes(page: Page) {
  const calls: any[] = []
  await page.route('**/api/vibe', async (r) => {
    const body = r.request().postDataJSON()
    calls.push(body)
    const num = (body.controls as any[]).find(c => c.type === 'number' || typeof c.value === 'number')
    const take = (label: string, f: number) => ({ label, rationale: '', changes: num ? [{ key: num.key, value: (num.min ?? 0) + ((num.max ?? 1) - (num.min ?? 0)) * f }] : [] })
    if (body.variants) await r.fulfill({ json: { takes: [take('Soft', 0.2), take('Mid', 0.5), take('Bold', 0.8)] } })
    else await r.fulfill({ json: { changes: num ? [{ key: num.key, value: num.max ?? 1 }] : [], rationale: 'Pushed it.' } })
  })
  return calls
}

async function openStudio(page: Page, nodeType: string, event: string) {
  await openBlankWorkflow(page)
  await waitForBackend(page)
  await dropNode(page, nodeType)
  const id = await page.locator('.vue-flow__node').last().getAttribute('data-id')
  await page.evaluate(([ev, nodeId]) => window.dispatchEvent(new CustomEvent(ev!, { detail: { nodeId } })), [event, id])
  await expect(page.getByTestId('studio-shell-dock')).toBeVisible({ timeout: 15_000 })
}

test.describe('the one prompt in studios', () => {
  test.beforeEach(async ({ page }) => { await seedKey(page) })

  test('Shader: the chip is the effect, / focuses the studio prompt, Esc leaves it without closing', async ({ page }) => {
    await mockRouter(page, 'tweak')
    await openStudio(page, 'ShaderStudio', 'sailor:openShaderStudio')
    await expect(page.getByTestId('studio-prompt').getByTestId('prompt-selection-chip')).not.toHaveText('')
    await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {})
    await page.keyboard.press('/')
    await expect(prompt(page)).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(prompt(page)).not.toBeFocused()
    await expect(page.getByTestId('studio-shell-dock')).toBeVisible() // the studio is still open
  })

  test('Shader: a request routes as a studio and three takes show above the prompt; Keep closes the strip', async ({ page }) => {
    const routed = await mockRouter(page, 'tweak')
    const vibe = await mockVibeTakes(page)
    await openStudio(page, 'ShaderStudio', 'sailor:openShaderStudio')
    await prompt(page).fill('warmer')
    await prompt(page).press('Enter')
    await expect(page.getByTestId('prompt-takes')).toBeVisible({ timeout: 15_000 })
    expect(routed[0]).toMatchObject({ request: 'warmer', host: 'studio' })
    expect(vibe[0].variants).toBe(3)
    await expect(page.getByTestId('prompt-take-tile')).toHaveCount(3)
    await page.getByTestId('prompt-take-tile').first().hover()
    await page.getByTestId('prompt-take-tile').first().getByRole('button', { name: 'Keep' }).click()
    await expect(page.getByTestId('prompt-takes')).toHaveCount(0)
  })

  test('Shader: Remix… sets a mode chip, and sending gives the plain "not yet" message', async ({ page }) => {
    const routed = await mockRouter(page, 'new-effect')
    await openStudio(page, 'ShaderStudio', 'sailor:openShaderStudio')
    await page.getByTestId('studio-inspector-head').getByTestId('studio-action-row').filter({ hasText: 'Remix' }).click()
    await expect(page.getByTestId('prompt-mode-chip')).toContainText('Remix')
    await prompt(page).fill('ink on paper')
    await prompt(page).press('Enter')
    await expect(page.getByTestId('prompt-answer')).toContainText('isn’t available yet')
    expect(routed[0].mode).toBe('Remix')
  })

  test('Shader: inspector reads the thing, then Edit and Develop rows', async ({ page }) => {
    await openStudio(page, 'ShaderStudio', 'sailor:openShaderStudio')
    // The head's bare Remix row is also a `studio-actions` list; pick the one with headings.
    const actions = page.getByTestId('studio-actions').filter({ has: page.getByRole('heading', { name: 'Edit' }) })
    await expect(actions.getByRole('heading', { name: 'Edit' })).toBeVisible()
    await expect(actions.getByRole('heading', { name: 'Develop' })).toBeVisible()
    await expect(actions.getByTestId('studio-action-row').filter({ hasText: 'Vary' })).toContainText('3 takes')
  })

  test('Space type: the transport is in the tool bar and a request comes back as a proposed change', async ({ page }) => {
    await mockRouter(page, 'tweak')
    await mockVibeTakes(page)
    await openStudio(page, 'SpaceType', 'sailor:openSpaceType')
    await expect(page.getByTestId('studio-tool-bar').getByRole('slider', { name: 'Scrub preview' })).toBeVisible()
    await prompt(page).fill('slower')
    await prompt(page).press('Enter')
    await expect(page.getByTestId('prompt-changes')).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('prompt-changes').getByRole('button', { name: 'Reject' }).click()
    await expect(page.getByTestId('prompt-changes')).toHaveCount(0)
  })

  test('Frame: a full row (no pill), still there in Motion, results above it', async ({ page }) => {
    await mockRouter(page, 'plan')
    await page.route('**/api/agent-plan', r => r.fulfill({ json: { text: JSON.stringify({ reasoning: '', commands: [], message: 'Nothing to change.' }) } }))
    await openCompositor(page)
    const dock = page.getByTestId('compositor-prompt-dock')
    await expect(dock.getByRole('textbox', { name: 'Ask Sailor' })).toBeVisible()
    await expect(page.getByTestId('compositor-prompt-pill')).toHaveCount(0)
    await dock.getByRole('textbox', { name: 'Ask Sailor' }).fill('tighten it')
    await dock.getByRole('textbox', { name: 'Ask Sailor' }).press('Enter')
    await expect(dock.getByTestId('prompt-answer')).toContainText('Nothing to change', { timeout: 15_000 })
    await page.getByRole('button', { name: 'Motion' }).first().click()
    await expect(dock.getByRole('textbox', { name: 'Ask Sailor' })).toBeVisible()
  })

  test('3D: the prompt sits above the add bar and answers plainly', async ({ page }) => {
    await mockRouter(page, 'tweak')
    await openStudio(page, 'Scene3DStudio', 'sailor:openScene3DStudio')
    await prompt(page).fill('make it glass')
    await prompt(page).press('Enter')
    await expect(page.getByTestId('prompt-answer')).toContainText('3D can’t take instructions yet')
  })
})
```

Before handing over, check each assumption against the code, and fix the spec rather than the app when the spec guessed wrong:
- the node type names `ShaderStudio`, `SpaceType` and `Scene3DStudio` (grep the `sailor:addNode` handler, or `agent-fastlane.spec.ts`, which uses `ShaderStudio`);
- each `sailor:open…` detail shape;
- `/api/agent-plan`'s reply shape: mirror `tests/agent-fastlane.spec.ts` or `prompt-results.spec.ts`;
- the Motion tab's accessible name in Frame;
- the Keep button's name inside a `PromptTakes` tile.

If the Space type proposal renders zero rows because the first numeric control is already at its max, pick the control's `min` in the no-variants branch instead.

- [ ] **Step 2: Hand it to the controller**

Don't run Playwright yourself. Report the file path. The controller runs `cd frontend && npx playwright test tests/studio-prompt.spec.ts` against the shared `:3002`.

- [ ] **Step 3: Commit**

- Commit `frontend/tests/studio-prompt.spec.ts`.
- Message: `test(e2e): the one prompt in studios — Shader takes, Remix chip, Space type proposal, Frame row in Motion, 3D message (all routes mocked)`

---

### Task 13: Verification (controller-run, not a subagent)

- [ ] **Step 1: Health first.**
  - Run `lsof -nP -iTCP -sTCP:LISTEN | grep node`, then `lsof -a -p <pid> -d cwd`, to find the main checkout's server on `:3002`.
  - **Don't restart it.** This stage adds no route.
  - If it is broken (a Nuxt 500, or esbuild's "The service is no longer running"), say so, and restart it **on :3002** only. Then check `curl -s http://127.0.0.1:8188/system_stats`, and relaunch ComfyUI if it has gone.
  - Confirm stage 3's route is reachable: `curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:3002/api/prompt-route -H 'content-type: application/json' -d '{}'` should return **400**. A 405 means stage 3's restart is still owed; do it first.
- [ ] **Step 2: Unit suite and typecheck.**
  - Run `cd frontend && npx vitest run`. It should be green, with counts compared to BASE (memory: vitest counts lie under load, so rerun a timed-out file alone).
  - Run `npx vue-tsc --noEmit` and filter to this stage's files.
- [ ] **Step 3: Playwright**, one spec at a time:

  ```bash
  cd frontend && npx playwright test tests/studio-prompt.spec.ts
  cd frontend && npx playwright test tests/agent-compositor-vocab.spec.ts tests/sailor-prompt.spec.ts
  ```

  Rerun a spec that times out on its own before calling it broken.
- [ ] **Step 4: A real-mouse pass in the browser pane** (synthetic events prove nothing).
  - Click by ref, and screenshot each check. Use **mocked** routes through the pane's network tools, or real routes only with Julien's OK.
  - **Every studio** (Shader, Gradient, Shape, Texture, Vector type, Space type, 3D, Frame, template editor):
    - the prompt looks identical, varying only in width;
    - the tool bar sits directly under it, with the moved controls working (zoom, repeat, seams, play, scrub);
    - `/` and ⌘K focus the studio prompt, never the canvas's;
    - Esc in the prompt doesn't close the studio.
  - **Takes (Gradient or Shader):**
    - hovering each tile previews it on the preview, and leaving returns;
    - Keep applies it; × restores;
    - closing the studio with the strip open restores the original.
  - **Stop:** press Stop mid-request. The row stops at once, the prompt stays disabled until the reply lands, and then nothing changes.
  - **Frame:** no pill; the chip quotes the headline; the prompt stays above the Motion timeline; the inspector shows the header, then the actions, then the sections; the right panel is never taken over.
  - **3D:** the prompt sits above the add bar, the sculpt bar and the Motion dock in turn, never overlapping them.
  - **Owed until then:** if the pane is hidden (a hidden pane pauses rAF), record the real-mouse pass as **owed**.
- [ ] **Step 5: Owed live checks.** Write these into STATE.md; do not run them without Julien's OK.
  - One real studio request on Gradient ("warmer"): router kind `tweak`, three takes from `/api/vibe`.
  - One real Frame request ("shorter headline"): router kind `copy`, a proposal from `/api/agent-plan`.
- [ ] **Step 6: Record it.**
  - Mark the spec's §9 stage 4 as built, with the commit range and "real-mouse pass owed" if applicable. Correct §2.4's claim that 3D already had a prompt row (Ruling 1).
  - Update `docs/STATE.md`.
  - Update the memory file `ai-surface-rethink-and-shader-gen.md`: stage 4 built, the rulings Julien should confirm (the list at the top of this plan, especially 1, 2, 6, 13 and 15), and the owed checks.
  - Update the build dashboard (standing rule: update it on every commit).
