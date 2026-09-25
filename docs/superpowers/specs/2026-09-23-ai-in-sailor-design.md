# AI in Sailor: one prompt, results on the work, and AI-made shaders

**Date:** 2026-09-23 · **Status:** direction approved; open questions decided (§10); layout revised 2026-09-24 (prompt stays above the toolbar, no rail); stage 1 built
**Replaces:** the 11 separate AI surfaces and 5 prompt input components described in §5
**Visual reference (open in a browser):**
- `assets/2026-09-23-ai-in-sailor/sailor-ask-prototype.html` is the clickable prototype, version 11. It covers the canvas, the Shader studio, Frame and the effect gallery, all running live shaders.
- `assets/2026-09-23-ai-in-sailor/shader-takes-spike.html` holds the 24 AI-written shaders from the spike, rendered by Sailor's own renderer and checked automatically.
- `assets/2026-09-23-ai-in-sailor/open-questions.html` draws the six open questions as side-by-side options. They are decided in §10.

Neither page calls AI. The prototype's takes are canned from the spike, and its routing is keyword-based. It is the model for layout and behaviour, not for the engine.

---

## In plain words

**What is broken.** AI in Sailor was added one feature at a time, and it shows:

- **Many surfaces.** There are 11 AI surfaces and 5 different prompt boxes. The canvas bar, the bar under each studio preview, Space type's copy of that bar, Frame's pill, the template editor's side panel, copy assist, font suggestions, the "Ask AI" row at node connectors, Explain, and critique with auto-review each look and behave a little differently.
- **Results appear in different shapes and places.** Some requests give four takes, some a list of changes, some a direct change, some text. Some results appear inside a popup instead of on the thing you asked about.
- **No shortcut, and unclear abilities.** No shortcut opens AI, and nothing tells you what the prompt can do.
- **Shaders are a fixed library.** The 84 effects are a good library, but it's fixed: AI can move an effect's dials, but it can't make or change an effect.

**What changes.**

1. **One prompt.** It stays where the canvas prompt bar is today: a full-width row directly above the toolbar, always visible. (Decided 2026-09-24 after trying the app: this arrangement works; it just needs the new behaviour.)
   - What you've selected shows inside it as a chip. Press / or ⌘K to type; suggestions for the selection appear above it.
   - While a request runs, the prompt shows its progress, with Stop.
   - Studios use the same stack: the prompt row above their own tool bar, as Frame and 3D already do.
2. **Results land on the work.**
   - Three takes appear in a strip just above the prompt. On the canvas, the node they belong to glows and each take previews on the node itself when you hover it; in a studio, they preview on the preview. Nothing on the canvas moves or gets covered. Then Keep.
   - Changes to the graph appear on the canvas as dashed "proposed" nodes, for you to approve.
   - Answers, which are words about the work, appear above the prompt in a small card.
3. **AI actions are ordinary actions.**
   - Selecting a node shows a small toolbar with **Edit ▾** ("the same thing, better": fix, retouch, tune, write copy) and **Develop ▾** ("take it somewhere new": vary, restyle, remix, layouts, animate).
   - AI items sit among the others, marked with a small ✦ and a note on where the result lands ("3 takes" or "adds a step").
   - Studio inspectors list the same actions as light button rows, in the same two groups.
4. **The canvas toolbar stays as it is**, minus Explain. Nothing moves to a side rail, and nothing essential is hidden in menus.
5. **Content prompts stay where they are.** The prompt on a Generate node, a Frame element and so on is part of the recipe, so it stays visible on the thing. But all ~16 of them become one shared field, with an @reference picker, history and "Improve prompt".
6. **AI can write shaders.** Remix an effect, or describe a new one, and you get three new effects, each with 3–5 dials of its own. The one you keep goes into **My effects**, which is available in every effect picker in Sailor. Asking for changes later makes new versions and keeps the old ones.

**What falls out of it.**

- **Removed:** Explain (it was for explaining Comfy graphs), the orphaned "next steps" strip, the header Critique icon (it becomes Edit ▾ → Fix and a fixes badge on the node), and four of the five prompt components.
- **Tidied:** one prompt instead of five prompt components, and the toolbar loses Explain.
- **Consistent:** the canvas, the simple studios, Frame and 3D follow one rule. The bottom is for making and asking, the left is for structure and libraries, and the right is for details.

**What is risky.**

1. **Changing the most-used prompt.** The canvas prompt keeps its place, but it now carries chips, suggestions and progress. It has to stay as quick to type into as it is today.
2. **AI-written shaders can be bad without being broken.** The spike's automatic checks passed every bad take. Picking from three takes, and a model looking at each render, are what protect quality.
3. **AI-written shaders can hang the graphics card.** Loops must be capped, and compile failures handled, before anything reaches the canvas.
4. **Canvas takes sit above the prompt, away from their node** (§3.1). The link between them has to stay obvious: the node glows, and the strip names it.

**Built in seven stages, each shippable (§9).** In order: a real-model run of the shader engine (done); the new prompt behaviour and the node toolbar; results on the work; studios; shader generation and My effects; the shared content prompt field; cleanup.

---

## 1. The rules

These are the decisions the rest of the spec applies. Every placement in the prototype follows from them.

### 1.1 The bottom is for making and asking

- **The prompt row sits directly above the tool bar**, on the canvas and in every studio. You ask in the row above, and you make with the tools below.
- **The canvas toolbar keeps its buttons as they are today**, minus Explain. An earlier design moved the libraries (Assets, Styles, Characters, Templates, More) to a left rail to make room for a prompt inside the bar. With the prompt on its own row, that room isn't needed, so the rail is dropped (2026-09-24).

### 1.2 One prompt, and it knows the selection

- **There is only one place to type an instruction:** the prompt row above the tool bar, the same in every view.
- **The selection shows inside it as a chip.** The chip uses the thing's own name or text ("Rainy shop", "“Open late” · text"), never a guessed role. That follows the standing UI-copy rule.
- **Mode chips.** Menu items that need words (Remix…, Tune…, Restyle…, New effect…) put a mode chip ("Remix ×") in the prompt, focus it and wait. Esc on an empty field clears the mode.

### 1.3 Results land on the work

A result is always **shown on the thing it changes**: the node, the preview, the artboard or the prompt field. It is never shown only inside a popup. The controls for choosing (take tiles, Approve) sit just above the prompt.

| Kind of request | What appears | Where |
|---|---|---|
| A visual change you choose from (vary, restyle, remix, new effect, copy, layouts) | **Three takes**, each previewed on the thing itself when you hover it | A strip just above the prompt; the target node glows (canvas), or the preview or artboard shows it (studio) |
| A change to the graph (add, connect, remove a step) | **Proposed nodes and edges**, dashed | On the canvas; approve or reject in a card above the prompt |
| An instruction that edits a recipe ("add heavy rain to the prompt") | **The edit itself**, briefly highlighted | In the content prompt on the node, with Undo |
| A question | **An answer**, with follow-up chips | A card above the prompt |

### 1.4 Edit and Develop

These are the node toolbar's two menus, and the two groups of actions in every studio inspector. They split by **intent**, not by what the item does mechanically:

- **Edit** means the same thing, better: suggested fixes, Fix, retouch (remove background, inpaint, remove object, recolour), enhance (upscale, relight, enhance detail), Tune…, Improve prompt, Write copy, Change effect…
- **Develop** means taking it somewhere new: Variations / Vary, Restyle…, Remix…, New effect…, Layouts, and new formats (Reframe, Resize for every format, Animate, Send to Frame).

Today's menus already follow this intent, even though "Edit" items create new branch nodes (`spliceEffect(…, { branch: true })` in `ArtifactImageNode.vue`) and Develop → Variations adds takes in place. The menus keep their meaning; §1.3 now decides where each result lands, and the menu shows it as a hint.

Every item shows:
- a small **✦** if it uses AI;
- a grey hint for where the result lands: **"3 takes"** (on this node) or **"adds a step"** (a new node after it).

### 1.5 Instructions and content prompts are different things

- **An instruction** ("make it warmer") is said once and then it's done. It goes through the one prompt.
- **A content prompt** (what a generator should make) is part of the recipe. It stays visible and editable on its element, in the shared field of §6.
- **An instruction can edit a content prompt,** and the edit happens in the field, where you can see it.

---

## 2. Layout

### 2.1 The canvas prompt and toolbar

The arrangement is today's: a prompt row directly above the toolbar at the bottom centre, sharing its width (`layouts/default.vue` ~4152–4304, the `canvas-bottom-bar-stack` column). What changes is the behaviour of the prompt.

- **The toolbar is unchanged except that Explain is removed**, along with `ExplainOverlay`, `ExplainPanel`, `useExplain` and `/api/explain`, once nothing else uses them. "What does this do?" in the prompt replaces it. Every other button (Select, Hand, Add, Studios, Generate, Assets, Actions, Styles, Characters, Toolbox, More, Templates) stays where it is.
- **The prompt row is always visible**, the full width of the toolbar:
  - **At rest:** "Ask Sailor", or "Change or ask about ‹selection›", with the selection as a chip inside the field ("Rainy shop ×", "2 nodes ×") and a `/` hint.
  - **Focused:** opened by a click, `/` (when not typing in a field), ⌘K, or a menu item that needs words (which also adds a mode chip such as "Remix ×"). 2–3 suggestions for the current selection appear just above it.
  - **Working:** after you send, the field shows what's happening ("Writing three new effects…") with Stop. Results then land on the work (§3), and the takes strip sits just above the prompt.
- **Leaving:** Esc clears a mode chip first (on an empty field), then leaves the field. Clicking away leaves it.
- **It replaces `CanvasPromptBar`'s internals in the same place.** The zoom bar and minimap (bottom right) and the top bar (project menu, Run with its cost, the status pill) are unchanged.

### 2.1a One prompt component, identical everywhere (decided 2026-09-24)

The canvas, every studio, Frame, 3D and the template editor render **the same prompt component** (one Vue component; working name `SailorPrompt`), not look-alikes. It replaces `CanvasPromptBar`, `AgentBar` and `VibeControlBar`.

- **Identical in every place:** height, corner radius, colours and border, the ✦ mark, chip style (selection and mode), placeholder wording pattern, the suggestion row above it, the progress-with-Stop state, the takes strip above it, keyboard behaviour (/ and ⌘K to focus, Esc, Enter), and its answer and approval cards.
- **The look is Sailor's existing AI look, not a new one** (confirmed 2026-09-24):
  - the dark field (`#1a1a1a`, 12px corners) with the **pastel ring**: the rotating conic (`#ffd6e7 → #cfe8ff → #d6ffe0 → #fff4cc → #e7d6ff`, `--pastel-angle`, `main.css`), faint at rest and full when focused or working;
  - the Sparkles icon at 45% white and the white send button, as in today's `CanvasPromptBar`;
  - **while working, the glimm sweep** (`AgentSweep`, lagoon palette, 3 s period) runs over the prompt row *and* over the thing being changed (the node, the artboard, the preview); the target node carries the pastel ring, as proposed nodes already do.
  - Pastel stays reserved for AI. Selection chips and suggestions are neutral.
- **Allowed to differ, and only these:**
  - **width:** the toolbar's width on the canvas; the preview's or tool bar's width in a studio;
  - **what fills it:** the selection chip, the suggestions, and the placeholder, which follow what's selected where you are.
- **Where hosts plug in:** each host supplies its context (the selection label, suggestions, and where takes preview) through props or a small adapter, never through its own markup or styles. A host that needs a visual variation is a design change to the one component, not a local override.
- **Guard:** a unit test fails if any `.vue` file outside the component renders its own prompt input for instructions (content prompts use the shared content field, §6).

### 2.2 No libraries rail (dropped 2026-09-24)

The earlier design's left rail existed only to free room in the bar for a prompt. The prompt keeps its own row instead, so the libraries stay in the toolbar where they are today. The rail-related decisions (short-window folding, Annotate moving into Add, Toolbox moving into More) are withdrawn.

### 2.3 The node toolbar

- **A single selected node** shows a compact toolbar centred above it, containing **Edit ▾** and **Develop ▾** and nothing else. There's no AI button, because typing always goes to the prompt.
  - The toolbar stays the same size on screen at any canvas zoom. That's the main reason for a floating toolbar over node footers.
  - It generalises the audio node's `SelectionActionChips`, which is the only selection toolbar in the app today.
- **Several selected nodes** show ▶ Run N · Group · Combine into Frame. These come from today's right-click menu. The prompt's chip reads "N nodes".
- **Run/Render stays on the node itself,** in a slim row: status dot, status text (Live preview, Not run yet · $0.04, Rendered 2 min ago, Running…) and ▶. That's state you need to see without selecting. The existing split-button menu is unchanged.
- **Suggested fixes** from critique and auto-review show as a badge on the node header ("2 fixes"). Clicking it selects the node and opens Edit ▾, where the fixes lead the menu in a tinted "Suggested fixes" section. This replaces:
  - the header Critique icon (Critique moves to Edit ▾ → Fix);
  - the fixes buried inside the image node's Edit menu;
  - the orphaned `NextStepsStrip.vue`, which is deleted.
- **Unchanged:** the right-click menu (run from here, bypass, mute, duplicate, delete) and the image node's hover strip (replace, download, lock, @reference). They're utilities, not making.

### 2.4 Studios

The same stack applies everywhere: **the prompt row above the studio's tool bar, and results just above the prompt.**

- **Frame** (`CompositorModal.vue`) and **3D** (`Scene3DStudioSurface.vue`) already stack their prompt above their tool bar. They keep that arrangement and get the new prompt behaviour. Frame's prompt no longer collapses to an "Ask…" pill; it stays a full row, like the canvas.
- **Simple studios** (Shader, Gradient, Shape, Texture, Vector type, Space type): the prompt row sits under the preview, as today. Their scattered viewport controls (Gradient's zoom at the top, Texture's 1×/2×/3× repeat under the canvas, Vector and Space type's play/pause and scrub) move into a small tool bar below the prompt, so every studio has the same stack.
- **Modes that take over the bottom** (3D sculpting, the Motion timeline in Frame and 3D, the Timeline editor): the prompt row stays above whichever bar is showing, so it's always in the same spot.
- **The output footer** (`StudioActionsFooter`: Download, Render on canvas) is unchanged. It's output, not making.
- **The inspector** reads top to bottom:
  1. **The thing itself:**
     - A shader layer shows its **Recipe**. A built-in effect shows its name, category and a Remix button. A My effect shows its name (editable), what it was made from ("from Water Ripple"), the request that made it ("make it rain on a window"), version chips (v1, v2, …) and Remix.
     - A Frame layer shows Text, Background or Frame.
  2. **Actions, as light button rows:** a subtle filled row with an icon, the label, and the "3 takes" / "adds a step" hint plus ✦ on the right, grouped under **Edit** and **Develop**. There's no primary button.
  3. **Dials,** unchanged.
- **Retired:** `AgentBar`'s place under the preview, the agent panel taking over the right column, and `VibeControlBar` (Space type).

### 2.5 Frame specifics

The prompt's suggestions and results follow Frame's selection:

- **A headline selected** gives headline takes, previewed live on the artboard.
- **The background selected** gives new shader effects or dial versions behind the text.
- **Nothing selected** gives **layout takes**: mini posters, previewed on the artboard when you hover. They feed from the Frame layout system (`2026-09-23-frame-layout-system-design.md`); the prototype's five placements only stand in for it.

---

## 3. Results

### 3.1 Takes

- **Always three,** in a strip showing: the request in quotes, a status ("Working…", then "Three new effects · hover to preview, Keep one"), Three more, and ×. The strip holds the current version, then three tiles. (Decided 2026-09-24: three is enough choice, and it costs a quarter less than four.)
- **Tiles arrive one by one** as they're ready. Pending tiles pulse.
- **Hovering or focusing a tile** previews it in place: on the node's own thumbnail, the studio preview or the artboard. Leaving the strip goes back to the clicked tile, or to the current version.
- **Keep** applies the take. The other takes go into the node's existing take history (`TakesStrip`, the Light Table), so nothing is lost and any take can still be branched.
- **Where the strip goes** (decided: open question 1, option D). The strip always sits **just above the prompt**, in the canvas and in studios alike. Nothing on the canvas moves, and nothing gets covered.
  - **On the canvas,** the node the takes belong to **carries the pastel ring** (the proposed-node ring, §2.1a), and the strip's header names it with a chip ("Rainy shop"). Hovering a tile previews the take **on that node's own thumbnail**, and on anything downstream that shows it, such as the Poster. So the result still shows up on the work, even though the tiles don't sit next to it.
  - **In a studio,** the preview or artboard shows the hovered take. The preview shrinks to `min(520px, 100vh − 400px)` so that the preview, the strip and the bar all fit.
  - If the target node is off screen when the takes arrive, the canvas pans just enough to bring it into view, so the preview can be seen. That's a view change, not a node move.
- **The strip stays the same size on screen at any canvas zoom** (question 3, option B). Since it sits above the prompt, this comes for free.
- **v1 shows one set of takes at a time.** A new request replaces an unkept strip.
- **Later: several jobs at once** (decided: question 2, option B). Each node shows its own progress and then its own takes, and the prompt shows "N running". That opens a small list with Stop for each job.

### 3.2 Changes to the graph

- **The proposed nodes appear on the canvas** with a dashed accent border and a "Proposed" label. New edges are dashed in the accent colour; edges that would be removed are dashed red.
- **A card above the prompt** lists the change: `+ Add Upscale ×2`, `↳ Rainy shop → Upscale ×2 → Poster`, `− Rainy shop → Poster (replaced)`, with Approve and Reject.
- **Approve** makes the nodes real; they get a normal Run row, and the change is undoable. **Reject** removes them.
- **This reuses today's proposal model** (`ProposedChange`, `AgentProposal`), shown on the canvas instead of in a list.

### 3.3 Answers

- **A card above the prompt:** "✦ Answer", the text, optional follow-up chips (for example "Lower glass blur", "Render the poster at 1080"), and a close button ×.
- **Follow-up chips run as normal requests** against the same selection.

### 3.4 Progress and stopping

- **While working,** the prompt at rest shows the job ("Writing three new effects…", "Planning the change…") with Stop.
- **Stop** cancels the job and clears any partial takes.

---

## 4. How a request becomes a result

- **One router call** (Haiku, the `patch` tier in `server/lib/aiModels.ts`) takes:
  - the request;
  - the selection (node kinds and names, or studio and layer);
  - any mode chip;

  and returns one of: `answer`, `plan` (a graph change), `edit-recipe`, `tweak` (dial takes), `new-effect` (shader takes), `restyle`, `copy`, `layout`, `fix`.
  - It replaces today's split between `/api/agent-plan`, `/api/vibe*` and `/api/pipeline-suggest` at the entry point. Those routes stay as the workers behind each kind.
- **A mode chip decides the kind without the router** (Remix/New effect → `new-effect`, Tune → `tweak`, Restyle → `restyle`).
- **Menu items call their kind directly.** Vary → `tweak` with no text; Write copy → `copy`.
- **The prototype's keyword router** (`route()` in the prototype) documents the intended behaviour. It is not the implementation.

---

## 5. What replaces what

| Today | Becomes |
|---|---|
| `CanvasPromptBar.vue` (canvas, above the toolbar) | The prompt in the canvas bottom bar |
| `AgentBar.vue` + `TakeStrip.vue` under each studio preview (`StudioModalShell`) | The one prompt above the studio's small tool bar; takes just above the prompt (`TakeStrip` reused) |
| `VibeControlBar.vue` (Space type, a hand copy of AgentBar) | The prompt in Space type's bar; the file is deleted |
| Frame's agent pill (`CompositorModal` + `useCompositorAgent`) | The one prompt as a full row above Frame's tool bar (no pill) |
| Template editor agent (`GridEditorShell` side panel + `useLayoutAgent`) | The prompt in a bottom bar in the template editor (same component) |
| Copy assist textarea + Variations/Translate buttons (`GridPropertyPanel`) | **Write copy** / **Translate…** actions (Edit) → headline takes |
| Font suggest in the font pickers | Unchanged. It's a search inside a picker, and its results already land where the work is. It uses the shared field's styling. |
| "Ask AI" row in `PortIntentPopover` | The popover only searches node types. Its last row, "✦ Describe it instead…", opens the one prompt with the connector as a chip ("Rainy shop · output"). Decided: question 4, option B. |
| Explain tool + panel | **Removed.** "What does this do?" in the prompt, with the nodes selected. |
| Critique icon (ComfyNode header) + Fix in the image Edit menu | Edit ▾ → **Fix**; results as fixes |
| Auto-review after paid renders | Unchanged trigger; output becomes the fixes badge on the node (§2.3) |
| `NextStepsStrip.vue` (not rendered anywhere) | Deleted |
| Moodboard read, wardrobe describe, LoRA trainer captions | Unchanged. They fill fields automatically and aren't prompts. |

**Prompt input components go from 5 to 2, and the instruction prompt looks identical in every view (§2.1a):**
- **the prompt** (instructions);
- **the shared content field** (§6).

---

## 6. The shared content prompt field

All ~16 generation-prompt fields become one component. Frame's "Describe the element…" is one of them. It's the element's recipe, so it stays on the element, in its inspector, where you can edit it and regenerate (decided: question 5, option A). That's inpaint (fill and "describe the edit"), Frame's "Describe the element…" and "Describe the change…", Frame's animate prompt, Texture's "Describe a texture…", 3D restyle and surface, the product-shot backdrop, the pose prompt, outfit prompts, the LoRA gallery and trainer fields, the node inspector's style prefix, Shot Director beats, and the Generate node's prompt.

The component has:

- **@references with a picker.** Typing `@` lists the project's references (`lib/refs/registry.ts`) with their kind; known references show as chips under the field. Today `@name` is replaced silently and there is no picker.
- **History.** The last prompts for this field, one click to restore.
- **Improve prompt.** It rewrites the prompt into a fuller one, in place, with Undo. The prompt stays on the element.
- **The same look everywhere.** It's visually distinct from the ✦ prompt: no ✦, and it's part of its element, not floating.

Instructions can edit a content field (§1.5). The edit appears in the field, briefly highlighted, with Undo in the card.

---

## 7. Shader generation and My effects

### 7.1 What the spike showed

- **The test:** 24 first-draft shaders, 6 requests with 4 takes each, written under the contract below and rendered by `ShaderFxRenderer`.
- **Nothing broke.** 24 of 24 compiled first time, and the slowest added under 1 ms per 1024² frame over a plain copy.
- **About half were good.** 11 of 24 were keepers by eye, and **the automatic checks passed all five misses**: muddy, too dark, or losing the picture. Quality is the risk, not breakage.
- **Every request produced a keeper, but not predictably which take.** That's why the product offers several takes and a pick (three, decided 2026-09-24).
- **Creating from nothing did as well as transforming.** Concrete, physical requests predicted success, whether or not there was a base effect.
- **Caveat:** Claude stood in for the model. Stage 1 (§9) measures the real tiers.

### 7.2 The engine

1. **Contract given to the model:**
   - Sailor supplies the standard preamble (`u_image0`, `u_resolution`, `u_time`, `u_seed`, `v_texCoord`, `fragColor0`) and a helper include (hash, value noise, fbm, blur, luma, hsv, a thin-film palette).
   - The model writes the uniforms, `main()`, and a param list in the manifest shape (`EffectParamDef`). The list has **3–5 params**, of type float, enum or color, each with a label and a default. This follows the standing rule "defaults over dials, never add dials to chase a look".
   - For a remix, the model gets the base effect's source and params. For "new", it gets the 2–3 closest existing effects as references.
2. **Static checks before compiling:**
   - Loops must have constant bounds ≤ 64, and texture reads inside loops ≤ 32 per pixel.
   - Only the declared uniforms and the helpers may be used.
   - A take that fails is sent back once with the reason.
3. **Compile** in the browser with `ShaderFxRenderer`. On a compile error, send the error log back and retry, at most twice per take.
4. **Automatic checks,** the same as the spike page:
   - not black, blown out or flat;
   - it visibly changes the image, unless it's generative;
   - it moves, if it's marked animated;
   - it costs less than 8 ms extra per 1024² frame over a plain copy.

   A take that fails is regenerated once.
5. **A model looks at the three renders** (one image) and drops obvious misses, such as muddy results or ones that lose the subject. Replacements are generated to keep the count at three.
6. **Return three takes.**

- **Model (measured 2026-09-24, see `assets/2026-09-23-ai-in-sailor/engine-run-results.md`):** **Opus 5.5 writes the shaders at effort `medium`** (Opus 5.5's own default), and every request carries **the user's image and two good existing effects as examples**. There is **no look-and-revise pass**.
  - Sonnet 5 and Haiku 4.5 on their own were nowhere near the quality bar.
  - Sonnet with the image and examples was "OK".
  - Opus 5.5 was best. It was equally good with and without the extras.
  - Opus 5.5 is not one of today's `AI_TIERS`; stage 5 adds a dedicated shader-generation model setting rather than changing the `campaign` tier that other features use.
  - Dial-only takes (Tune…, Vary) stay on Haiku, as before.
  - **Cost estimate** (list prices, $4 / $20 per million tokens in/out; not yet measured): about 2¢ input and 4–8¢ output (thinking included) per take at medium effort; ×3 takes and about 1.3× for repairs gives **about 25–40¢ per request**. Metered per call from actual token usage (hold at the call's worst case, settle to real cost × 2, 1 credit = $0.01) — see server/utils/anthropicPrices.ts. The UI should show an estimate before a request runs (stage 5). Measure the real figure at the start of stage 5 by running one request.
- **Latency:** not yet measured for Opus 5.5 at medium effort (the takes run in parallel, so a request takes about as long as its slowest take); tiles appear as each passes.

### 7.3 Where it's used

- **Node toolbar:** Develop ▾ → Remix…, New effect…, Vary; Edit ▾ → Tune….
- **Studio inspector:** Recipe → Remix; Actions → Vary, Tune…, New layer from a description….
- **The effect gallery** (`CatalogModal`, everywhere it shows shader effects):
  - a **Make one ✦** card first;
  - **Remix ✦** on every card;
  - a **My effects** section and filter chip.
- **Frame:** the background layer's Vary and Remix; any request with the background selected.

### 7.4 My effects

- **A kept take becomes a normal `EffectDef`,** with `mine: true`, `from` (the base effect's name, if any) and `versions: [{ label, source?, values, note }]`.
  - A code change adds a version with new `source`; a dial change adds one with new `values`.
  - The version chips in the Recipe switch between them.
- **Storage:** there's no user library today, so this adds a per-user store behind `/api/my-effects` (list, get, save, rename, delete).
  - It lives in Nitro storage for local use, and in the hosted per-user store when hosted mode lands (see `hosting-after-comfy-removal`).
  - Projects keep a copy of any My effect they use, so a shared project renders without the owner's library.
- **Everywhere effects are picked:** the Shader studio, shader-as-fill (`ShaderFillEditor`), Frame's effect stack, and `ShaderEffectNode`. Each builds its own `CatalogModal` items today; add one shared helper that merges My effects into the list.
- **Embeds** already inline effect sources (`catalogStore`). My effects are inlined the same way.
- **Promote to library** (dev-only, later): writes the effect's `.frag` and manifest entry into `shader_effects/`.

### 7.5 Safety

- **The graphics card:** the static loop limits and the cost check keep runaway shaders off the canvas. WebGL context loss recovery (as in Scene3D) must cover a hung preview.
- **Cost:** studio AI calls have no cost gate today. Shader generation is cheap per call, so no gate is proposed, but the working state names what's happening.

---

## 8. Testing

- **Unit:**
  - the router's kind selection, with fixtures per selection kind;
  - the shader static checks (loop bounds, allowed uniforms);
  - the automatic render checks (black, flat, no change, not moving), using the spike page's thresholds;
  - My effects version handling.
- **E2E (Playwright):**
  - the prompt's states (at rest, focused, working);
  - `/` and ⌘K focus, and Esc clearing the mode, then closing;
  - selection chips;
  - take strip placement, hover preview and Keep, on a node and in a studio;
  - the proposed-node Approve and Reject flow;
- **Real-mouse check.** The standing rule is that synthetic pointer events prove nothing. Hover-to-preview and typing into the prompt must be checked by hand in the browser pane.
- **Engine run (stage 1):** the spike's 6 requests on the real tiers, scored the same way as the spike page.

---

## 9. Build order

1. **Engine run.** The spike's 6 requests through the real engine (§7.2) on Sonnet 5 and Haiku, shown next to the spike's takes on one page. It costs a few dollars, and needs **your OK before running**. It confirms the model tier and the checks.
2. **Canvas layout.** *(BUILT 2026-09-24, see `docs/STATE.md`; real-mouse pass owed.)*
   - The one prompt component (§2.1a), built once here and mounted on the canvas first.
   - The prompt row's new behaviour in place of `CanvasPromptBar` (selection chips, suggestions, progress with Stop), and Explain removed from the toolbar.
   - The node toolbar (Edit ▾ / Develop ▾, existing items regrouped by intent, landing hints).
   - The multi-selection toolbar, Run rows on nodes, and the fixes badge.
   - The prompt runs the existing agent flows at first; results still use today's shapes.
3. **Results on the work.** Take strips above the prompt, with the target node glowing and previewing each take (§3.1), proposed nodes on the canvas, the answer card, and progress in the prompt. `CanvasPromptBar` is retired.
4. **Studios.**
   - The one prompt (§2.1a) above a small shared tool bar in `StudioModalShell`.
   - Frame's and 3D's existing prompt rows swapped for the one prompt, above whichever bar shows (takeover modes included); Frame's pill removed.
   - The simple studios' scattered controls moved into the bar.
   - Inspectors reordered: Recipe or the thing itself, Actions as light rows, then Dials.
   - `AgentBar`'s old place and `VibeControlBar` retired; the template editor moved to the same bar.
5. **Shader generation and My effects:** the engine, the store, gallery entry points, versions, and pickers everywhere.
6. **The shared content prompt field** across the ~16 fields. Copy assist becomes actions.
7. **Cleanup:** delete `NextStepsStrip`, the Explain code and routes, and the retired prompt components.

---

## 10. Decisions on the open questions (2026-09-23)

The options were shown visually in `assets/2026-09-23-ai-in-sailor/open-questions.html`.

1. **Take strips on a crowded canvas:** **the strip sits above the prompt, and the preview is on the node** (option D). An earlier pick, pushing the nodes below out of the way, was dropped because nodes must never move when takes open. Details in §3.1.
2. **Parallel jobs:** one at a time in v1; **several later**, each shown on its own node, with "N running" in the prompt (option B).
3. **Canvas zoom:** take strips **stay the same size on screen**, like the node toolbar (option B).
4. **The port "Ask AI" popover:** the popover only searches node types; its last row **hands off to the one prompt** with the connector as a chip (option B).
5. **Frame's "Describe the element…":** it's the **recipe**, so it stays on the element in the shared content field (option A).
6. **The rail on short windows:** withdrawn. The rail itself was dropped on 2026-09-24 (§2.2).

No open questions remain that block stage 1 or 2.
