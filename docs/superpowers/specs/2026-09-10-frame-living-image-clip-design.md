# Frame: living image clip (animate a cutout with an image-to-video model)

**Date:** 2026-09-10
**Status:** design, awaiting Julien's review
**Scope:** one image layer in the Frame becomes a looping, transparent clip. The rose case: one generated rose cutout, cloned four times.

## The idea in one paragraph

An image layer keeps its still picture and may also hold a *clip*: a folder of frames with transparency. The Frame draws the frame that matches its clock, so the rose moves in the Design tab, the Motion tab and the video export, and each cloner copy starts at a different moment. The clip is made by sending the still to a video model as first and last frame on a flat key colour, then removing that colour from every frame so the transparency comes back.

## Why this shape

- Video models return opaque frames. Transparency has to be rebuilt after the fact, per frame. Generating on a colour we choose makes that removal reliable.
- The Frame has no video layer kind, and adding one would duplicate every image-layer path (masks, feather, torn edge, cloner, Vary tint, effects, displacement). Teaching the image layer to hold frames keeps all of that working untouched.
- A layer without a clip must paint byte-for-byte as it does today.

## 1. What the layer remembers

`ImageLayer` gains one optional field:

```ts
clip?: {
  dir: string        // folder under ComfyUI input/sailor_clips/<id>/
  frames: number     // how many PNGs: 000000.png … 
  fps: number        // the rate the model returned (24 or 25 today)
  speed: number      // playback multiplier, 0.25..4, default 1
  prompt: string     // what produced it, for re-runs
  model: string      // catalog id that produced it
}
```

`filename` is unchanged and remains the still: shown when there is no clip, while the clip loads, or if the folder is missing. Deleting `clip` returns the layer to the still exactly.

Cloner gains one optional number, `phase` (0..1, default 1): how far apart the copies start in the clip. See section 3.

## 2. How it plays

- Loading: `ensureLayerImages` also loads clip folders into a second cache keyed by `dir`: an array of decoded bitmaps. It loads once, in the same step that loads stills.
- Painting: the image branch in `paintLayer` asks for the frame at the current clock. Frame index = `floor(clockSeconds × speed × fps) mod frames`. `clockSeconds` is the value `paintLayerStack` already receives (the Motion playhead when set, else the idle wall clock). No new loop.
- Played length of a clip = `frames / fps / speed` seconds.
- Master clock: today `liveMasterClock` and `hasAnimatedSlot` in `CompositorModal.vue` derive only from wired studio slots (`l.live`). Both also count image layers with a clip, using the played length as the period. That is what keeps the idle live loop running, lights up "Generate as video", and lets `reconcileLoops` pick a whole-cycle duration so the export loops with no jump.
- Rate mismatch: the Frame's own fps lives in the Motion tab and is unchanged. A 24 fps clip in a 30 fps Frame picks the nearest frame per moment.
- The Frame card on the canvas (`ArtifactFrameNode`) uses the same paint path and so animates the same way. Its live-loop gate follows the same "has a clip" rule.

## 3. The four copies

`expandClones` already yields each copy's index `k`. Each copy draws the frame at `clock + k × step`, where `step = playedLength × phase / copyCount`. Phase 1 spreads the copies evenly around the loop, phase 0 plays them in unison. Vary tint, falloff and every other per-copy treatment apply to whichever frame was chosen.

## 4. What the server does when you press Animate

One new Nitro route, `server/api/frame/animate.post.ts`, beside the inpaint routes. Input: the still as a data URL, prompt, model id, length in seconds. Output: `{ dir, frames, fps }`. Steps:

1. **Key colour.** Flatten the still onto chroma green (`#00FF00`). If more than 3 % of the cutout's opaque pixels are within a small hue distance of green (leaves), use chroma blue (`#0000FF`) instead. The chosen colour is kept for step 3.
2. **Model call.** Through the existing metered helpers (`runFal` / `runReplicate`), which already place the ledger hold, moderate the prompt, poll and release on failure:
   - `seedance-2.0` and `hailuo-h3` on fal: the keyed still as both `image_url` and `end_image_url`.
   - `luma-ray-2-720p` on Replicate: the still as the image, `loop: true`.
   - Prompt sent = user prompt + `", plain flat green background, no shadows, camera locked, gentle motion"` (blue when blue was chosen).
   - Length is passed through; the panel only offers what the model accepts.
3. **Frames and keying.** Download the mp4, split it into PNG frames with the ffmpeg already in the repo venv (`scripts/`, same pattern as the voice-clone script). For each frame: alpha = soft threshold on the chroma distance from the key colour (YCbCr plane), spill suppression pulls the key hue out of edge pixels, then multiply by the still's own alpha dilated by 4 % of its width. Anything far outside the original rose is wiped. Frames are resized so the longest side matches the still, never larger.
4. **Save.** Write `input/sailor_clips/<id>/000000.png …` and a `clip.json` with frames, fps, model, prompt and key colour. Return the folder.

Price: added to `priceBook.ts` per model and length so the button can show it. Costs per attempt are in the tens of cents to about a dollar.

## 5. What you see in the panel

Design tab, image layer selected, under the existing image controls: an **Animate** section.

- Prompt (text).
- Model select with plain-language rows: "Luma, loops by itself", "Seedance", "Hailuo".
- Length select, limited to the chosen model's allowed values.
- Speed slider, 0.25× to 4×, default 1×. Only shown once a clip exists.
- Generate button with the price, behind the same cost confirmation the other paid Frame tools use. Shows progress while running; the rose stays still meanwhile. On success the clip attaches and the rose moves right away.
- "Remove clip" link, shown once a clip exists.

Cloner panel: one new **Phase** slider (0..1).

Copy follows the house rule: sentence case, no internal ids on screen.

## 6. When things go wrong, and export

- Model or keying failure: the layer is unchanged, the error shows in the Animate section, the ledger hold is released by the existing helpers.
- Clip folder missing on load: paint the still, show a small warning on the layer row.
- Frame video export (`generateVideo` and the card's `downloadVideo`) passes `alpha: true` to `encodeFrames` when the background is No Fill, so a transparent VP9 WebM comes out; otherwise an mp4 as today. The encoder already supports this flag.

## 7. Out of scope

Per-rose clips, motion brush or trajectory control, clip trimming or scrubbing beyond the Frame's own timeline, GIF export, video matting models (chroma key first; a matting model is the upgrade if edges disappoint), hosted-mode storage of clip folders.

## 8. Testing

Pure unit tests, no network:

- Keying maths on synthetic frames: a green pixel goes fully transparent, a rose pixel stays opaque, an edge pixel gets a soft alpha, spill is pulled.
- Guard dilation: a pixel outside the dilated still alpha is wiped even if not green.
- Frame index for a given clock, fps, speed and frame count, including wrap and the 24-in-30 nearest-frame case.
- Per-copy phase offsets for phase 0, 0.5 and 1.
- `reconcileLoops` with a clip period added beside a studio slot.
- Byte identity: a layer without a clip paints the same pixels as before, with and without a cloner.

By hand, once, cost noted in the write-up: the real model call on Julien's rose, then export a transparent WebM from the Frame and confirm the loop seam and the edge quality.
