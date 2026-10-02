# Image model benchmark in the picker — design

Date: 2026-10-02. Status: agreed in chat, awaiting review.

## What we're building

The "Generate an image" picker gets a **Show** menu next to its search box. It defaults to **Model's own picture**, which is
today's card cover. Choosing one of seven test prompts (for example "Redhead close-up") swaps every card's cover for the
picture that model made from that exact prompt. You scan the grid and see who does faces, lettering, products or anime well.

The pictures are made once, by us, with a script, and shipped with the app as plain image files. Opening the picker costs
nothing and every user sees the same set.

Before the benchmark runs, two new models join the picker: **Ideogram 4.5** and **FLUX 3 Image**.

Already done (`9dc8aa1aa`): nine overlapping models were hidden from the picker. They were Imagen 4 and 4 Fast, GPT Image 2,
Bria Fibo and Image 3.2, Ideogram 4, Reve 2.1, and Recraft V4 and V4 Pro.

## Step 1 — Ideogram 4.5 and FLUX 3 Image in the picker

Each one is a new runner family, switched off by default. Each follows the line-up's family contract
(`.superpowers/sdd/2026-09-24-model-lineup/family-contract.md`), which covers:

- a catalogue entry;
- a verified price;
- a schema snapshot;
- a builder in `server/runner/generators/`;
- an eligibility row;
- tests, including that the gallery hides the model while its switch is off and that badge = charge.

| | Ideogram 4.5 | FLUX 3 Image |
|---|---|---|
| Family | `ideogram-4.5` | `flux-3-image` |
| Service | fal, Ideogram 4.5 text-to-image (endpoint id confirmed from the fal schema snapshot) | fal `blackforestlabs/flux-3/text-to-image` |
| Settings shown | Aspect ratio, Quality (default Medium) | Aspect ratio, Size (1K default, 2K) |
| Price | Set by quality only: $0.008 / $0.03 / $0.06 / $0.22 | $0.048 per megapixel. Charge the full rate, never the 50%-off rate that ends 8 Oct, so we never charge less than it costs us |
| Note | | Slow, 45–75 s a picture. The canvas stall timer already allows for this |

Settings are kept to what people use, with no dial for every schema field.

**Live check:** one cheapest-setting job each, about 10¢ in total, run through the runner on :3002 after the user's go.
Then each switch goes on in the local `.env`, which needs a full dev-server restart.

Neither model becomes the default. Nano Banana 2 stays.

## Step 2 — the test prompts

These go in a new file, `frontend/app/data/model-benchmark.ts`, as a list of `{ id, label, prompt }`. The label is what
the Show menu lists.

| id | Menu label | Prompt |
|---|---|---|
| `redhead` | Redhead close-up | A close-up portrait of a redhead woman in soft natural window light, freckles, looking just past the camera. |
| `neon-sign` | Neon sign | A neon shop sign on a brick wall at night that reads "OPEN LATE", glowing pink and blue. |
| `perfume` | Perfume bottle | A glass perfume bottle on wet black stone, studio product photo, soft reflections, dark background. |
| `rainy-market` | Rainy market | A busy market street in the rain at dusk, glowing stalls, umbrellas, reflections on the wet ground. |
| `laughing-man` | Older man laughing | An older man laughing at a café table, both hands around a coffee cup, warm afternoon light. |
| `fox` | Watercolour fox | A fox in a watercolour children's-book illustration, sitting in a meadow of wildflowers. |
| `anime` | Anime | An anime girl with short silver hair waiting on a train platform at sunset, wind in her hair, cel-shaded in a 90s anime style. |

The ids are part of the file paths, so they never change once pictures exist. Changing a prompt's wording means a new id.

## Step 3 — making the pictures

A script, `frontend/scripts/model-benchmark.ts`, run by hand with `npx tsx`.

- **Which models:** every model the picker shows, read from the same `galleryEntries` the picker uses with the local
  family switches, minus the Recraft SVG models, which make vectors. Today that's 25 models including the two new ones.
  The `--models` and `--prompts` flags narrow a run.
- **How:** each picture is a normal "Generate an image" → Save workflow posted to the dev server at `127.0.0.1:3002`.
  Every model is run with its own default settings, square (1:1), no extra options, and seed 1 where the model takes a
  seed. It goes through the same runner, price and hold as a real run, so nothing is special-cased.
- **Saving:** the result becomes a 640 px square WebP (quality 80) at
  `frontend/public/model-benchmark/<prompt-id>/<model-id>.webp`. 175 pictures at about 50 KB each is roughly 9 MB in git.
- **Manifest:** `frontend/public/model-benchmark/manifest.json` records, for each prompt and model, either the file and
  the date it was made, or why it failed (refused, service error). The picker reads only this file to know what exists,
  so there are no missing-image requests.
- **Skips what exists:** a picture already in the manifest is not made again, so adding a prompt or a model pays only for
  what's missing. `--redo` remakes the selected ones.
- **Failures:** a refusal or service error is logged in the manifest and the run carries on. The script prints a summary
  at the end: made, failed, and the total charged according to the local ledger.
- **Cost guard:** before running, the script prints how many pictures it will make and the estimated cost from the price
  book, then asks y/N.

The first full run is 25 models × 7 prompts = 175 pictures, about **$7.50**. It runs only after the user's go, ideally
before 8 Oct while FLUX 3 is half price.

## Step 4 — the picker

This goes in `ModelGalleryModal.vue`.

- **Show menu:** a small dropdown in the header area next to the search box. Its options are "Model's own picture", then
  the seven prompt labels in list order. It is in sentence case and uses the menu labels above, not ids.
- **Card picture:** with a prompt chosen, each card's picture area becomes square, not 16:10, so the benchmark picture
  isn't cropped, and it shows `/model-benchmark/<prompt>/<model>.webp`. A model with no picture for that prompt (failed,
  or not run yet) keeps its usual cover with a small "Not tested" tag.
- **Remembered:** the choice is kept per viewer in localStorage (wrapped in try/catch) and restored when the picker next
  opens.
- **Nothing else changes:** search, filters, price badges, selection and "Use this model" work as today.
- **No manifest:** if it is missing or fails to load, the Show menu is not drawn and the picker is exactly as today.

## Not included

- Side-by-side compare of 2–4 models.
- Benchmarks in the edit, video or other model menus.
- Scores or rankings.
- Running the benchmark from inside the app.

The data shape (prompt id → model id → file) leaves room for any of these later.

## Testing

- **Step 1:** the family contract's tests. Then one live call each, with the user's go.
- **Step 2:** a unit test that prompt ids are unique, path-safe and non-empty, and labels are sentence case.
- **Step 3:** unit tests for model selection (shown models, SVG left out, flags narrow the run), for the skip-existing
  logic and for manifest writing, with the network call stubbed. The real run is the paid step.
- **Step 4:** a component test that the Show menu lists the prompts, that choosing one swaps covers to the benchmark path,
  that a model missing from the manifest keeps its cover with "Not tested", and that a missing manifest hides the menu.
  Then a browser check on :3002 with a screenshot.
