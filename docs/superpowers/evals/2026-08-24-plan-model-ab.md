# Canvas planner eval — model upgrade AND effort-cap latency, three arms

Generated 2026-08-25T06:25:06.225Z by `frontend/tests/unit/plan-model-ab.eval.unit.spec.ts`.

## How to run

```bash
cd frontend
NUXT_ANTHROPIC_API_KEY=sk-... npx vitest run tests/unit/plan-model-ab.eval.unit.spec.ts
```

Without the key the spec skips silently (one always-green gate assertion runs) and
this report is **not** rewritten. With the key it makes 10 prompts × 3 arms = **30**
real Anthropic calls (~2–4k input tokens, ≤2048 output each).

## What is being compared — THREE arms, two separate questions

Same PRODUCTION planner request every time: `describeCanvas` → `buildAgentPrompt` +
`buildCommandSchema` (app/lib/agent/…), posted to `/v1/messages` in the exact shape
`server/api/agent-plan.post.ts` uses (non-streaming, `output_config.format` =
`json_schema`, `max_tokens: 2048`, first text block). Only `output_config.effort`
and `model` vary across arms:

1. **claude-sonnet-4-6 (effort low)**
2. **claude-sonnet-5 (effort low — POST-FIX shape)** — what `agent-plan.post.ts` sends today (post-fix).
3. **claude-sonnet-5 (no effort — PRE-FIX shape, adaptive/uncapped)** — what it sent BEFORE this fix (no `effort` field at
   all → Sonnet 5 runs adaptive thinking with no cap).

**Arm 1 vs arm 2** isolates the MODEL-UPGRADE effect at matched effort (both capped
`low`) — this does NOT tell you anything about the effort cap itself, both arms have
it. **Arm 2 vs arm 3** isolates the EFFORT-CAP effect on the identical model — this is
the before/after for the latency fix. Read them separately; neither substitutes for
the other.

Snapshot: an EMPTY canvas — the first-prompt case — with a catalog assembled from the app's own
`AGENT_CAPABILITIES` through the real `buildCatalog` ranking pipeline.

**Synthetic-catalog caveat:** no raw /object_info nodes (empty "low-level" bucket), no widget defs/defaults/enums (widgets: [] on every entry), no trained-style library. Everything else (ranking,
caps, pins, preferred/raw split, prompt text, schema) is the shipped path.

## Results

First `addNode` agreement, arm 1 vs arm 2 (model upgrade, matched effort): **9/10**.
First `addNode` agreement, arm 2 vs arm 3 (effort cap, same model): **8/10**.

Average wall-clock per call (successful attempt only; retry sleep excluded; 0-ms
error rows excluded from the average):

- **claude-sonnet-4-6 (effort low)**: 7985ms avg (0/10 rows retried)
- **claude-sonnet-5 (effort low — POST-FIX shape)**: 6237ms avg (0/10 rows retried)
- **claude-sonnet-5 (no effort — PRE-FIX shape, adaptive/uncapped)**: 11201ms avg (0/10 rows retried)

**Effort-cap latency delta (arm 3 − arm 2, same model claude-sonnet-5):** 4964ms.

`retried` = yes means a transient 429/5xx forced a retry before the row's successful
attempt — that attempt's own ms is still clean (timed fresh, per-attempt), but a
retried row hit different network/server conditions than a clean one, so weight it
less when eyeballing latency.

| Prompt | claude-sonnet-4-6 (effort low) addNode | tune | ms | retried | claude-sonnet-5 (effort low — POST-FIX shape) addNode | tune | ms | retried | claude-sonnet-5 (no effort — PRE-FIX shape, adaptive/uncapped) addNode | tune | ms | retried |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a warm dreamy gradient background for a hero banner | `GradientStudio` | yes | 6241 |  | `GradientStudio` | yes | 6230 |  | `GradientStudio` | yes | 7252 |  |
| kinetic typography that says LAUNCH | `VectorType` | yes | 8780 |  | `VectorType` | yes | 5822 |  | `VectorType` | yes | 10692 |  |
| make me a seamless terrazzo pattern | `TextureStudio` | yes | 10171 |  | `TextureStudio` | yes | 4851 |  | `TextureStudio` | yes | 4622 |  |
| a glassy chrome 3D version of the word BLOOM | `GenerateImageNode` | no | 10210 |  | `GenerateImageNode` | no | 8241 |  | `GenerateImageNode` | no | 12047 |  |
| give it that 35mm film look | `none` | no | 5421 |  | `none` | no | 4943 |  | `none` | no | 6024 |  |
| a 1970s italian film poster vibe | `GenerateImageNode` | no | 6591 |  | `GenerateImageNode` | no | 5842 |  | `GenerateImageNode` | no | 13122 |  |
| moody berlin techno flyer background | `GenerateImageNode` | no | 6774 |  | `GenerateImageNode` | no | 4957 |  | `TRUNCATED` | no | 16494 |  |
| confetti burst around the product shot | `EditImageNode` | no | 6662 |  | `none` | no | 9376 |  | `ShaderStudio` | yes | 23441 |  |
| an underwater caustics effect on my logo | `ShaderStudio` | yes | 7799 |  | `ShaderStudio` | yes | 6367 |  | `ShaderStudio` | yes | 8330 |  |
| something calm for a meditation app splash | `GradientStudio` | yes | 11196 |  | `GradientStudio` | yes | 5740 |  | `GradientStudio` | yes | 9988 |  |

## Reasoning (first ~100 chars) and full op sequence

### a warm dreamy gradient background for a hero banner

- **claude-sonnet-4-6 (effort low)** (2 cmds: addNode → tuneNode, stop_reason: end_turn, 6241ms)  
  The user wants a warm dreamy gradient background for a hero banner. This is a gradient output best h
- **claude-sonnet-5 (effort low — POST-FIX shape)** (2 cmds: addNode → tuneNode, stop_reason: end_turn, 6230ms)  
  A warm dreamy gradient background matches GradientStudio's purpose exactly, so I'll add it and confi
- **claude-sonnet-5 (no effort — PRE-FIX shape, adaptive/uncapped)** (2 cmds: addNode → tuneNode, stop_reason: end_turn, 7252ms)  
  This is a verbless description of a gradient/colour field, which per the design rules belongs to Gra

### kinetic typography that says LAUNCH

- **claude-sonnet-4-6 (effort low)** (2 cmds: addNode → tuneNode, stop_reason: end_turn, 8780ms)  
  The user wants kinetic typography for the word 'LAUNCH'. VectorType is the preferred node for variab
- **claude-sonnet-5 (effort low — POST-FIX shape)** (2 cmds: addNode → tuneNode, stop_reason: end_turn, 5822ms)  
  Kinetic typography of glyph outlines with motion is exactly what VectorType (a preferred capability)
- **claude-sonnet-5 (no effort — PRE-FIX shape, adaptive/uncapped)** (2 cmds: addNode → tuneNode, stop_reason: end_turn, 10692ms)  
  Kinetic typography maps directly to the preferred VectorType capability (variable-font glyph outline

### make me a seamless terrazzo pattern

- **claude-sonnet-4-6 (effort low)** (2 cmds: addNode → tuneNode, stop_reason: end_turn, 10171ms)  
  The user wants a seamless terrazzo pattern, which fits perfectly into TextureStudio. I'll add a Text
- **claude-sonnet-5 (effort low — POST-FIX shape)** (2 cmds: addNode → tuneNode, stop_reason: end_turn, 4851ms)  
  A seamless terrazzo pattern is a tileable texture, which the design system routes to TextureStudio r
- **claude-sonnet-5 (no effort — PRE-FIX shape, adaptive/uncapped)** (2 cmds: addNode → tuneNode, stop_reason: end_turn, 4622ms)  
  A 'seamless terrazzo pattern' is a tileable texture request, which the design system routes to Textu

### a glassy chrome 3D version of the word BLOOM

- **claude-sonnet-4-6 (effort low)** (1 cmds: addNode, stop_reason: end_turn, 10210ms)  
  The user wants a glassy chrome 3D typographic treatment of the word BLOOM. VectorType handles glyph 
- **claude-sonnet-5 (effort low — POST-FIX shape)** (1 cmds: addNode, stop_reason: end_turn, 8241ms)  
  This is a descriptive scene (a glassy chrome 3D rendering of the word BLOOM) with no explicit edit v
- **claude-sonnet-5 (no effort — PRE-FIX shape, adaptive/uncapped)** (1 cmds: addNode, stop_reason: end_turn, 12047ms)  
  The request is a verbless description of a scene/image (glassy chrome 3D lettering) rather than an e

### give it that 35mm film look

- **claude-sonnet-4-6 (effort low)** (0 cmds: —, stop_reason: end_turn, 5421ms)  
  The user wants a '35mm film look' applied but there's no image on the canvas to apply it to. The gra
- **claude-sonnet-5 (effort low — POST-FIX shape)** (0 cmds: —, stop_reason: end_turn, 4943ms)  
  The graph is empty and there's no selected image node to apply a film-look effect to; the request na
- **claude-sonnet-5 (no effort — PRE-FIX shape, adaptive/uncapped)** (0 cmds: —, stop_reason: end_turn, 6024ms)  
  The request is a treatment ('35mm film look') to apply to an existing image, but the graph is curren

### a 1970s italian film poster vibe

- **claude-sonnet-4-6 (effort low)** (1 cmds: addNode, stop_reason: end_turn, 6591ms)  
  The user wants a 1970s Italian film poster aesthetic generated as an image. The canvas is empty, so 
- **claude-sonnet-5 (effort low — POST-FIX shape)** (1 cmds: addNode, stop_reason: end_turn, 5842ms)  
  This is a descriptive scene/style request with no editing verb and nothing existing on canvas to tar
- **claude-sonnet-5 (no effort — PRE-FIX shape, adaptive/uncapped)** (1 cmds: addNode, stop_reason: end_turn, 13122ms)  
  The message is a pure description of a desired image/vibe with no command verb and no existing node 

### moody berlin techno flyer background

- **claude-sonnet-4-6 (effort low)** (1 cmds: addNode, stop_reason: end_turn, 6774ms)  
  The user wants a moody Berlin techno flyer background. This is a verbless description of a gradient/
- **claude-sonnet-5 (effort low — POST-FIX shape)** (1 cmds: addNode, stop_reason: end_turn, 4957ms)  
  This is a descriptive scene request (moody Berlin techno flyer background), not a gradient/pattern o
- **claude-sonnet-5 (no effort — PRE-FIX shape, adaptive/uncapped)** (0 cmds: —, stop_reason: max_tokens, 16494ms)  
  {"reasoning":"This is a verbless scene description (no command verb), so it defaults to image genera

### confetti burst around the product shot

- **claude-sonnet-4-6 (effort low)** (1 cmds: addNode, stop_reason: end_turn, 6662ms)  
  The user wants a confetti burst effect around a product shot, but there's no product shot on the can
- **claude-sonnet-5 (effort low — POST-FIX shape)** (0 cmds: —, stop_reason: end_turn, 9376ms)  
  The request asks to add a confetti burst effect around a product shot, but there is no product shot 
- **claude-sonnet-5 (no effort — PRE-FIX shape, adaptive/uncapped)** (2 cmds: addNode → tuneNode, stop_reason: end_turn, 23441ms)  
  "Confetti burst around the product shot" is a decorative effect applied to content that isn't yet on

### an underwater caustics effect on my logo

- **claude-sonnet-4-6 (effort low)** (2 cmds: addNode → tuneNode, stop_reason: end_turn, 7799ms)  
  The user wants an underwater caustics effect applied to their logo, but there's no logo on the canva
- **claude-sonnet-5 (effort low — POST-FIX shape)** (2 cmds: addNode → tuneNode, stop_reason: end_turn, 6367ms)  
  The user wants an underwater caustics effect applied to their logo, but no logo image exists on the 
- **claude-sonnet-5 (no effort — PRE-FIX shape, adaptive/uncapped)** (2 cmds: addNode → tuneNode, stop_reason: end_turn, 8330ms)  
  An underwater caustics effect is a shader-type treatment, which ShaderStudio owns in the preferred p

### something calm for a meditation app splash

- **claude-sonnet-4-6 (effort low)** (5 cmds: addNode → tuneNode → addNode → tuneNode → connect, stop_reason: end_turn, 11196ms)  
  A meditation app splash needs something calm and serene — a soft gradient background works perfectly
- **claude-sonnet-5 (effort low — POST-FIX shape)** (2 cmds: addNode → tuneNode, stop_reason: end_turn, 5740ms)  
  A calm meditation splash is essentially a soft colour field/gradient, which is the GradientStudio's 
- **claude-sonnet-5 (no effort — PRE-FIX shape, adaptive/uncapped)** (2 cmds: addNode → tuneNode, stop_reason: end_turn, 9988ms)  
  The request is a verbless description of a mood/visual for a splash screen — calm, soft, meditation-
