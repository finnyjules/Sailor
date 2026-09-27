# Characters rework: faces first, looks with clothes, checks that catch drift

**Date:** 2026-09-26
**Status:** Design agreed in conversation; not built.
**Builds on (and partly replaces):**
- [2026-08-12 character-system unification](2026-08-12-character-system-unification-design.md), which gave us the one `CharacterRecord` model (kept)
- [2026-08-13 Character Studio workbench](2026-08-13-character-studio-workbench-design.md), whose UI is replaced
- [2026-08-13 body builder](2026-08-13-body-reference-builder-design.md), whose data is kept and whose presentation changes

**Prototype:** [characters-prototype.html](assets/2026-09-26-characters/characters-prototype.html). It is a single file that is clickable offline and never saves or spends. Its images are stand-ins.
**Test images:**
- [Reva: Nano Banana 2 vs GPT Image 2.5](assets/2026-09-26-characters/reva-sheet-compare.jpg)
- [muscular / curvy](assets/2026-09-26-characters/reva-bodies.jpg)
- [overweight](assets/2026-09-26-characters/reva-overweight.jpg)

---

## Plain-language summary

**What's broken today**
- **The one finished sheet shows three different women.** Jene's sheet mixes a brunette portrait with blonde close-ups. The trouble started in her photos, which already show at least two different women. Then her portrait was redone on its own, and it came out as yet another woman.
- **Nothing noticed either problem.**
- **Sheila's photos have two people in them.** Three of her four photos show two women, and they were accepted anyway.
- **You can't invent a character.** Creating one needs a photo.
- **The readiness process goes unused.** None of the five characters has ever reached "Ready".
- **The sheet is sent to video in a form that works against us.** It goes as one combined grid image. Seedance's own guide warns that a picture showing several views of a person gets read as several people.
- **Veo can't take reference images** in Sailor: a Veo request with them is refused.

**What changes**
- **A character is a face, not a pile of photos.**
  - You approve one face.
  - Every sheet panel is made straight from that face, so no panel depends on another panel.
  - A face checker scores every picture of her automatically. Anything that isn't clearly her is flagged, with a one-click redo.
- **Looks own their clothes.**
  - Each look has its own clothing photos and its own sheet.
  - The clothes' photos are kept, so a shot can send the exact garment. That matters for ads.
- **Body is chosen by picture:** Slim, Average, Athletic, Muscular, Curvy, Heavy.
  - Each preset becomes strong, specific wording, which we tested and which works.
  - A look can override the body.
- **You can create a character three ways:** describe someone (a casting call of six faces), start from photos (checked as you add them), or pick an image already on the canvas.
- **One character page, read top to bottom:**
  - who she is: face, name, photos, body, voice
  - her looks, each with its clothes and its sheet
  - everything she has appeared in
- **One way to use a character everywhere.** A character node wired into any image or video generator. Sailor decides what to send each model, and never sends the combined grid.

**What falls out of this**
- The 10-pose test goes.
- The Ready/Not tested badges go.
- Ideogram Character goes.
- The chained "portrait first" pipeline goes.

**What's risky**
- **The face checker.** The model we tested with (InsightFace buffalo_l) is licensed for non-commercial research only, and no free face-matching model has clean commercial weights.
  - **Proposed:** AWS Rekognition "Compare faces", at $0.001 a picture. It needs a consent step and an opt-out from AWS training on our data. See Checks.
  - The same licence problem already affects three shipped features: Face Swap, Face restore and Lip-sync. That is a hosting blocker outside this spec; see "Also found" at the end.
- **GPT Image 2.5 refuses some prompts.**
  - It refused headless-body wording, which we worked around.
  - It refused changing a visible face to heavier. Nano Banana Pro did it.
  - So the fallback has to be automatic.
- **The thresholds are calibrated on two characters only.** They need widening as real use builds up.

---

## What we tested (2026-09-26, about $2.50 in total)

All tests used Reva's three photos, with every panel made straight from the photos (no chain).

| Question | Result |
|---|---|
| Which model keeps her face? | **GPT Image 2.5 Sunburst: face score 0.87–0.93.** Nano Banana 2: 0.66–0.72, which reads visibly as a lookalike. For comparison, Reva's own photos score 0.77–0.86 against each other. |
| Speed | Nano Banana 2 about 9 s a panel, GPT Sunburst about 30 s. Panels run in parallel, so a whole sheet takes about 30 s. |
| Refusals | GPT refused "head removed" wording on both body panels. "A fashion catalogue photo cropped so the top edge sits just below her chin" passed. GPT refused a heavier-*face* portrait twice; Nano Banana Pro made it. |
| Outfit consistency | With no clothes stated, **both** models dressed her differently on the front and the back. Stating the outfit fixed it. |
| Body type | Explicit words worked strongly for muscular, curvy and overweight. **Adding the 3D body figure as a reference made it weaker**, because the figure barely changes shape. |
| Face check on known-bad pictures | Jene's wrong-person close-ups scored 0.55–0.66 against her cover. Her third photo, which I had judged fine by eye, scored 0.41. After making Reva heavier, her real likeness scored 0.65. |

What the scores tell us: **0.6–0.75 is not a pass.** It covers both different people and the same person after a real change. Only about 0.8 and above is confidently the same person.

The model research is recorded in memory (`video-model-character-references-2026-09`, `character-sheet-image-models-2026-09`). Its short version is in "What gets sent" below.

---

## The model (data)

This extends `frontend/shared/characters/types.ts`. Old records are read the way they are today, by converting them at read time, with no migration script.

```ts
CharacterRecord {
  name, slug, createdAt, updatedAt, notes
  face: FaceRef | null            // NEW: the approved face (one filename + when approved)
  photos: Photo[]                 // NEW at character level (was per state: refImages)
  body: { preset: BodyPresetId, fine: Partial<Record<BodySliderId, number>> } | null
  voice: VoiceRef | null          // NEW: a trained voice, a picked stock voice, or none
  origin: 'described' | 'photos' | 'canvas'
  likenessConfirmed: boolean      // required for 'photos' / 'canvas' origins
  style: 'photo' | 'anime'        // set at creation, never changes; more styles later
  linkedFrom: string | null       // slug of the character this one was made from ("Make an anime version")
  loraName, trigger               // kept: an optional upgrade
  looks: Look[]                   // was `states`
}

Look {
  id, label
  description: string             // hair, clothes, makeup (was `descriptor`)
  clothes: Garment[]              // NEW: { id, filename, name } (the photo is kept)
  body: BodyOverride | null       // NEW: this look only
  face: FaceRef | null            // NEW: set when a body change moves the face (see Checks)
  panels: Panel[]                 // body-front, body-back, portrait, face-neutral, face-smile (+ optional profile)
  updatedAt
}

Panel { slot, filename, check: Check | null, madeFrom: { faceAt, clothesKey, bodyKey, model } }
Photo { filename, check: Check | null, crop?: FaceBox }  // crop = which person, for photos with two people
Check { verdict: 'match' | 'unsure' | 'different' | 'no-face', score?, lookFit?: 'ok' | 'off', note?, at }
```

**Retired:**
- `status` and `stressResult`, and with them `readiness.ts`'s four words
- the sheet grid as a thing that is *sent* anywhere (`sheetImage` stays only as a picture you can view)
- `coverIndex`, whose job the approved face now does

**Reading old records:**
- A state becomes a look.
- All states' `refImages` are merged into character `photos`.
- The face is the old cover.
- `descriptor` becomes `description`.
- Existing panels are kept, with `check: null`, and get checked the first time the page is opened. Checking is free.

**Staleness:** `madeFrom` records what each panel was made from: which face, which clothes, which body. If any of those has changed since, the panel is out of date ("Made from the old portrait", "Sheet doesn't show the new clothes"). This is the warning that would have caught Jene.

---

## Style: Photo and Anime (added 2026-09-26)

A character has **one style, chosen at creation**: **Photo** (the default) or **Anime**. More styles (3D animated, Illustrated, Comic) come later, once these two work well.

- **Style belongs to the character, not to a look.** An anime character's design *is* her identity; looks still change hair and clothes, not the rendering.
- **The same person in two styles is two characters.** "Make an anime version" on a Photo character creates a new Anime character linked to it (`linkedFrom`), built from her face. It never adds a second style to one character.
- **Creation:** Describe → a style choice (Photo · Anime) before "Show faces", and the casting call draws in that style. Start from photos → Photo, or turn her into an anime character (the likeness checkbox still applies).
- **Checking:** face matching only works on real faces, so Anime characters are checked by a vision model instead (see Checks).
- **The sheet:** Anime characters get an animation-style turnaround. The head stays on every body panel, and the side profile is standard, not optional (see Sheet panels).
- **Video:** the start-frame route (stage 3) matters most here, because video models drift towards realism and a drawn first frame holds the style.

## Making pictures of her

### Sheet panels
- **One model and one call per panel, all in parallel, each made straight from the approved face.**
- Inputs: her face, up to 2 of her best photos, the look's clothes photos (up to 3 pieces), and the look's face if it has one.
- The prompt always says who is in which image and **always states the outfit**, taken from the look's description plus the garment names.

| | Model | Why |
|---|---|---|
| Default | **GPT Image 2.5 Sunburst edit**, high quality (fal `openai/gpt-image-2.5/sunburst/edit`) | By far the best face score in our test. Takes up to 16 references. About $0.06 a panel. |
| On refusal | **Nano Banana Pro edit** (fal `fal-ai/nano-banana-pro/edit`) | Made what GPT refused. $0.15 a panel. |
| Redo of a flagged panel | The *other* model from the one that failed | Asking the same model again tends to repeat the same mistake. |

**Panel wording (tested):**
- Body panels say *"a full-length fashion catalogue photo … crop the photo so the top edge sits just below her chin / at the base of her neck"*. They never say "head removed".
- Body presets become explicit visual wording, for example Muscular: *"broad strong shoulders, defined arms, visible abdominal muscles and powerful thighs"*.
- `bodyPhrase.ts` bands get rewritten in that style. Today's strongest muscle phrase, *"a strongly muscular physique"*, is too weak.

**Side profile:** an optional sixth panel for Photo characters. It is only built and only sent for models that ask for it (Kling, Vidu). For Seedance and Gemini it adds risk.

**Anime sheet:** full-body front, three-quarter, side profile and back, **all with the head** (the headless panels were a workaround for photoreal video models), plus a face row: neutral and smiling. The wording is written and tested in stage 4, on GPT Image 2.5 and Nano Banana Pro. For heavy use of one anime character, a trained LoRA is the community standard, and Sailor already has the trainer.

### Casting-call faces
- **GPT Image 2.5 Flare**, text-to-image, medium quality: six faces for about $0.09.
- Each candidate gets its own explicit age, ethnicity and build, so the six actually differ.
- The picked face is remade once at high quality (about $0.06), because it becomes the anchor for everything that follows.
- "Change something" edits the picked face into six variations.

### Retired
Ideogram Character, the portrait-first chain, the 10-pose test, and the 3D body figure as a generation input. The figure may stay as a preview in the Body editor; that call is still open.

---

## Checks (the safety net)

Every picture of her is scored against **the right face**: the look's own face if it has one, otherwise the approved face. That includes photos, sheet panels, generated images and video frames.

**The checker: AWS Rekognition "Compare faces"** ([pricing](https://aws.amazon.com/rekognition/pricing/), [API](https://docs.aws.amazon.com/rekognition/latest/APIReference/API_CompareFaces.html)).
- **Cost:** $0.001 a picture.
- **Stateless:** nothing is stored at AWS.
- **Output:** a 0–100 similarity score. Called from Sailor's server.

Why this one:
- **InsightFace**, the model we tested with, is research-only. A commercial licence is negotiated by email with no public price.
- **No open face-embedding model has clean commercial weights.** SFace, facenet, AdaFace, EdgeFace and GhostFaceNets were all trained on research-only photo collections.
- **Azure Face** needs Microsoft's Limited Access approval.
- **Vision models** (Claude, GPT, Gemini) are limited by their biometric usage rules and give no calibrated score.

Conditions attached:
- **Opt out of training.** Set the AWS Organizations AI-services opt-out, so our inputs aren't used to train Amazon's models.
- **Get consent for real faces.** For characters made from real photos (the photos and canvas routes), a biometric notice and consent step that names AWS. It extends the likeness checkbox at creation. BIPA, GDPR Article 9 and similar laws treat a face embedding of a real person as biometric data.
- **Characters from a description need no consent step.** They are AI-made faces only.
- **Delete what we keep.** Scores are stored; face data is not. Deleting a character deletes its photos.

**Thresholds** are placeholders until re-measured on AWS's 0–100 scale. Our ArcFace numbers don't carry over. Re-measure on Jene, who must flag, and Reva, who must pass (a few cents), before any flag is shown:

| Score (ArcFace, as measured) | Verdict | What you see |
|---|---|---|
| ≥ 0.80 | match | nothing |
| 0.60–0.80 | unsure | amber: "May not be Reva", with Redo |
| < 0.60 | different | amber: "Different person", with Redo |
| no face found | no-face | nothing for body panels; a flag for close-ups |

- **Look fit** is a second, separate check: does the outfit or hair match the look's description and clothes photos? It needs a vision-model judgement, not a face score, and gives "Doesn't fit this look" or "Doesn't match the raincoat".
- **When a body change moves the face:** a look with a body override gets one confirm step, "Is this still Reva?", showing the new portrait. Once approved, that portrait becomes `look.face`. Checks for that look compare against it, so heavier Reva isn't flagged forever.
- **Photos on the way in:**
  - Two people in one photo: "Which one?", tap a face, and the crop is stored.
  - Someone else: left out, with "Use anyway".
  - If several flagged photos are the same other person: "Make a new character from these".
- **Face detection:** pad each image about 40% before detecting. The detector misses faces that fill the frame, as in the close-up panels.
- **Anime characters are checked by a vision model**, not AWS. Face matching is trained on real faces and gives no score, or a meaningless one, on drawn characters. So Claude compares the picture with her approved face against a checklist: face shape, eye style and colour, hair style and colour, distinctive marks, body proportions. Pose, expression, angle, lighting and clothing are ignored.
  - It answers with a verdict and a short note, such as "hair is shorter", and no score.
  - It costs about $0.01 a comparison and goes through the same assist metering as other Claude calls.
  - The usage limits that rule vision models out for real people (identifying people, biometrics) don't apply to fictional drawn characters.
  - To you, the flags and Redo look the same for both styles.

---

## What gets sent (per model)

The combined sheet grid is **never** sent.

**Image models** (GPT Image 2.5, Nano Banana Pro/2, Seedream 5): the look's face close-up and portrait, the full-body front, and each clothing photo. Sailor adds a line to the prompt: *"Reva is the woman in images 1–3, wearing the green waxed raincoat in image 4."* That allows up to about 3 characters in one picture.

**Video models:**

| Model | Send | Note |
|---|---|---|
| Any model, when the shot has a start frame | the start frame | Best everywhere. The start frame is an image of her made as above. |
| Seedance 2.0 / 2.5 | at most 2 images: portrait + full-body front | ByteDance warns that multi-view pictures read as several people. Can't mix references with a start frame. |
| Kling 3 / O3 | one "element": front face as the main image, plus 3/4, body front and back (4 at most), plus a start frame | Needs moving from Replicate to fal's Kling endpoints. |
| Veo 3.1 | up to 3 separate images | Today's code never sends them: "reference" mode points at image-to-video. Fix by routing to `veo3.1/reference-to-video`. |
| Wan 3.0, Hailuo H3, Gemini Omni | 1–2 clean images, named in the prompt | These can't group images as one person. Prefer a start frame. |
| Vidu Q3 (not in Sailor yet) | `subjects[{ name, images ≤3, voice_id }]` | The closest match to this model, voice included. |

**Voice:** stored on the character now. It reaches models that take it (Kling voice binding, Vidu `voice_id`, audio references on Seedance, Wan and H3) in a later stage.

---

## The screens

These follow the prototype.

- **Characters panel** (the existing 350 px side panel):
  - Face-first cards, 2 per row, with name and number of looks.
  - An amber count when pictures need attention.
  - Drag a face onto the canvas to use her.
  - "+ New character" is the last card.
- **Character page** (a modal, one column):
  1. Face, name, then three rows: **Photos** (thumbnails and flags; opens to manage them, "Use as face", "Make a new character from these"), **Body** (preset picture chips; "Fine-tune" shows the sliders in place, never in a second modal), **Voice** (picker and Play).
  2. **Looks.** One card per look: name, description, **Clothes** (tiles, "+" to add from a photo, the canvas or earlier pieces, × to remove, which also updates the description; an amber count past 3 pieces), and **Character sheet** (5 panels with flags and Redo, a status line with the cost, and "View as one image").
  3. **Appears in.** Everything made with her, with face scores. Star a picture to add it to her photos.
- **New character:** Describe someone / Start from photos / From the canvas, then Confirm. On Confirm: the name, the first look already filled in from your description or the photos, the likeness checkbox for the photo and canvas routes, and "Create and build sheet · $X" or "Just create".
- **Canvas:**
  - The character node shows her face large, a look picker, and an "Only in this project" field.
  - It is always a *link* to the library character, never a copy.
  - "+ Cast" on any image or video card makes or reuses the node and draws the wire. Every way of casting ends in that same visible wire.
  - Clicking the node's face opens the character page.

**Copy rules** (per the UI copy memories):
- Sentence case, and never an internal name such as a LoRA trigger chip.
- Label by the user's content: "Doesn't match the raincoat".
- No explanatory small text; hints go in tooltips.
- Costs on the buttons.
- The words "locked", "draft", "stress", "variant", "state" and "LoRA" never appear. A trained LoRA shows as "Trained".

---

## Build stages

Each stage ships on its own and is checked in the real app before the next one starts.

0. **Quick fix:** Seedance cast sends portrait + body front, never the grid (`lib/shotdirector/cast.ts`, a new `videoIdentityRefs`).
1. **Model and reading old records:** looks with clothes, character-level photos and face, the `madeFrom` stamps. Unit tests for converting all three past record formats.
2. **The face checker as a service:** AWS Compare faces behind one server route, with the training opt-out set, the consent step for real-photo characters, thresholds re-measured on Jene (must flag) and Reva (must pass), and checks run on read.
3. **Video, per model** (moved up from 7 on 2026-09-26, so better video lands before the character screens):
   - Shot Director profiles beyond Seedance, sending what the table in "What gets sent" says.
   - **Kling 3 through fal**, as an element plus a start frame (moves Kling off Replicate).
   - **Veo 3.1 references** through `veo3.1/reference-to-video`. Today the runner refuses a Veo request with reference pictures in plain words (`VEO_31_ONE_PICTURE`), and the Shot Director can only target Seedance, so this is new capability, not a silent bug. It needs a saved fal schema fixture first.
   - **The start-frame route:** make the shot's first frame as an image from the character, then animate it.
   - The face checker scores a few frames of every take, so models can be compared on real results.
4. **The sheet pipeline:** GPT Sunburst with automatic fallback to Nano Banana Pro, the tested wording, clothes stated, staleness, and redo with the other model. One live run per character route, about $0.50.
5. **The character page and panel:** the new UI from the prototype, with body presets and the voice row stored but not yet sent.
6. **Creation:** describe (casting call), photos (checks, "which one?", likeness), from the canvas.
7. **Canvas and images:** the character node as the only route in; any image generator accepts a character; "Appears in" and the star.
8. **Voice to models,** then consider Vidu Q3.

Tests at every stage:
- unit tests for the pure parts (prompt builders, the send plan per model, thresholds, staleness, reading old records)
- one end-to-end run with mocked routes
- at most one small paid live run
- a look at the real screen in the browser

---

## Open questions

1. **The face checker: AWS Compare faces proposed** (see Checks). Still to confirm:
   - the exact consent wording, and whether a lawyer should read it before hosting;
   - whether a paid InsightFace licence is worth asking about as an alternative that runs on our own server.
2. **Thresholds.** 0.80 and 0.60 come from two characters. Log every score with its verdict and your decision (Redo or keep), then tune.
3. **Does the 3D body figure stay** as a preview in the Body editor, or go? It can't be a generation input unless its shape range is rebuilt.
4. **A shared wardrobe library** for clothes and props across characters. Deferred until outfits actually get reused.
5. **GPT likeness refusals in the photo route.** Measure how often they happen. If it's often, Nano Banana Pro may be the better default for photo-origin characters.

---

## Also found: shipped features built on non-commercial models (a hosting blocker, separate job)

Checking the face checker's licence showed that three features Sailor already ships use models licensed for non-commercial use only. All three run on the local ComfyUI engine, which is being retired anyway. This is **not part of the character rework**. It must be settled before hosted launch.

| Feature (file) | Restricted model(s) | Replacement |
|---|---|---|
| Face Swap node and app (`comfy_extras/nodes_face.py`) | InsightFace buffalo_l + inswapper_128 ([licence](https://github.com/deepinsight/insightface)) | fal `easel-ai/advanced-face-swap` for images (~$0.05) and Pixverse Swap for video (~$0.15–0.40 per 5 s). A/B against GPT Image 2.5 / Nano Banana Pro "put this face here". |
| Face restore (`comfy_extras/nodes_face_restore.py`; also the Replicate `CodeformerRemoteNode` / `FixFacesNode`) | buffalo_l + CodeFormer, S-Lab non-commercial ([licence](https://github.com/sczhou/CodeFormer/blob/master/LICENSE)) | Topaz image upscale with face enhancement on fal (~$0.08) |
| Lip-sync, local (`comfy_extras/nodes_lip_sync.py`) | buffalo_l + Wav2Lip, "commercial use strictly prohibited" ([repo](https://github.com/Rudrabha/Wav2Lip)) | sync-3, already in the runner; optionally LatentSync (Apache 2.0, ~$0.20) as a cheap tier |

If face *detection* is still needed anywhere after this, OpenCV YuNet (MIT) or MediaPipe BlazeFace (Apache 2.0) replace InsightFace's detector.

Not yet checked:
- fal's own commercial terms for Easel and Topaz;
- what LatentSync was trained on;
- face-swap quality with the edit models.
