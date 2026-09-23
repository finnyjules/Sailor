# Sailor runner and the Gate — design

Date: 2026-09-22, revised 2026-09-23. Status: approved in conversation, awaiting a read of this
document.

## In plain words

Today every workflow you run goes to ComfyUI, the Python app. For generations, ComfyUI does
almost nothing: it builds a request, sends it to fal, waits, and saves the file. We are building
a small **runner inside Sailor's own server** that does that job itself.

The first release makes one workflow work properly — **make an image → check it at a Gate →
pay for a video only if you like it** — and takes the chance to fix how runs feel everywhere
around it.

What you get:

- **The Gate works online**, survives restarts, and never charges twice.
- **Pick the best at the Gate.** Re-roll ×4 on a gated workflow makes 4 images, pauses once, and
  you tick the ones worth turning into video. You pay only for those.
- **Pay one stage at a time.** The video is charged only when you press Continue.
- **Nothing is lost when the server restarts.** Every step is written down as it happens.
- **Exact cost on every result**, instead of a guess from your balance moving.
- **Every result remembers how it was made**, so "Open workflow" brings back the exact graph.
- **Never pay twice for the same request.** An identical request reuses the earlier result.
- **A real Stop** that cancels the job at fal, so you stop paying.
- **Better waiting:** "3rd in line" and real progress on the node.
- **A heads-up when a job finishes** in a background tab: the tab title and icon change.
- **Several runs at once** without starting extra Python programs.

What changes on screen: small things only — the Gate shows the pictures to pick from, nodes
show their place in line, the tab title and icon change when a job finishes. No new screens.

What's risky: a second copy of each model's request builder (Python and Sailor) while both
paths exist; and the size of shipping all of this at once (see Risks).

## Scope

In this release:

- **Four node types:** Generate an image (`GenerateImageNode`), Generate a video
  (`GenerateVideoNode`), Gate (`ComfyGateNode`), and the result cards (`Image`, `Video`).
- **The models that already default to fal:** 12 image models — Flux 1.1 Pro, Flux Schnell,
  Nano Banana Pro, Nano Banana 2, Ideogram V3 (Quality, Balanced, Turbo), Seedream 5 Pro,
  Seedream 5 Lite, Seedream 4, Krea 2 Large, Krea 2 Medium — and 6 video models: Veo 3.1,
  Veo 3.1 Fast, FLUX 3, Seedance 2.0, Hailuo H3, Hailuo H3 Max.
- **Moodboards:** both the saved style that becomes words in the prompt, and reference
  pictures. Reference pictures stay on fal (the current Python code sends them to Replicate only
  because its fal builders were never written to accept them; that is not a fal limit).
- **Several Gates in a row**, parallel branches, several runs at once.
- Items 1–9 from the conversation: one description per generator, full run records, exact
  cost, no double paying, a storage doorway, real Stop, server wake-up and the tab heads-up,
  queue position and progress, pick-at-the-Gate.

Not in this release (a workflow that needs any of these goes to Python whole, unchanged):

- Every other node type (Toolbox, shaders, audio, video effects, edit, upscale, LoRA nodes).
- Image or video models that don't default to fal.
- Automatic switching to Replicate when fal fails. Today's silent fallback has billed people on
  the wrong provider; if we want a fallback, it will be a visible choice later.
- Saving node settings by name in projects (see "One description per generator").
- Push notifications or email when Sailor is closed.
- Cloud file storage itself (the doorway is built; the cloud side comes later).

**Built behind a switch.** Everything lands on the main branch with the runner switched off, and
is turned on in one go when the whole release is done and checked. Until then, every workflow
goes to Python exactly as today.

## How a workflow finds its way

Before sending a workflow, the app checks every node **and the model it uses** against the
runner's list. If everything is on the list, it goes to the runner. If even one thing isn't, the
whole workflow goes to Python exactly as today. A workflow is never split between the two.

Detail: `useDirectExecution.queueSmart`/`queueParallel` already consult `isPoolEligible`
(`app/lib/graph/cloudOnly.ts`). A sibling `isRunnerEligible(prompt)` checks each node's
`class_type` against the runner's generator descriptions and, for `GenerateImageNode`/
`GenerateVideoNode`, its `model` widget against their model lists. Eligible → `POST /api/runs`;
otherwise the existing `/prompt` path. The graph format is the unchanged `ApiPrompt` from
`app/lib/graph/graphToPrompt.ts`.

## 1. One description per generator

Each generator node the runner handles is described once, in Sailor's code: its settings (by
name, with types and defaults), its models, each model's provider and endpoint, how a request is
built, and **its price**. The runner builds requests from it, and the price book reads prices
from it — so a model cannot ship without a price.

While Python still defines the same nodes for the fallback path, a test compares the two:
the settings must match, and for each model the request Sailor builds must match the one Python
builds for the same inputs (fixtures generated from the Python side).

Not yet: the canvas still gets node shapes from ComfyUI and still saves settings as a
position-ordered list in projects. Moving the canvas onto these descriptions and saving by name
is what ends the off-by-one and stale-definition bugs; it touches every saved project and is its
own job.

## 2. How a run works

A run is a written-down to-do list, not a program held in memory.

1. The runner receives the workflow and writes the run down: every node, all "waiting".
2. It starts every node whose inputs are ready — two independent nodes start at the same time.
3. Before calling fal it writes "sent, request id X". When fal answers it saves the file and
   writes "done, file Y".
4. At a Gate it writes "paused" and stops that branch. Other independent branches carry on.
5. When the server starts, it reads every run that was mid-flight and asks fal again for each
   request id it had sent.

Where the list is written: Postgres in hosted (a new `runner_runs` table), a JSON file per run
under `.data/runs/` locally, behind one small storage interface.

Files are handed from one node to the next by our own saved copy, uploaded to fal storage when
the next model needs it (`server/utils/falStorage.ts`), never as base64 pasted into the request.
fal's own links can expire while a Gate waits; our saved file doesn't.

## 3. Full run records

The record for a run keeps, for every node: the settings it ran with, the model and provider,
fal's request id, the output files, the exact cost, and timings — plus the whole workflow as it
was when you pressed Run.

- **Open workflow** on a runner result reopens that exact workflow, not the project's latest
  version.
- The generation history (Assets) gets a record per finished stage, written by the runner, with
  the exact cost. Records are de-duplicated by run id, so the browser's own save doesn't double
  them. (To confirm while planning: how the browser's save behaves for runs that aren't in
  ComfyUI's history.)

## 4. The Gate

A run is split into **stages** at each Gate. The runner charges and runs one stage at a time.

- **Run:** runs the first stage (the image), then pauses at the Gate.
- **Continue:** runs the next stage (the video) from the saved image.
- **Redo:** re-makes the stage before the Gate with new seeds (a seed of 0 already means
  random; any other seed goes up by one, as today). Later stages are untouched.
- **Restart:** throws away every result and runs from the start.
- **Continue after the run has finished:** runs everything after the Gate again from the kept
  image — "another video from the same picture".
- **A Gate with pass-through on** doesn't pause.

**Pick at the Gate.** Re-roll ×N on a workflow with a Gate becomes one run: the stage before the
Gate makes N results at once (N requests in parallel, each with its own seed) and pauses once.
The Gate shows the N pictures with a tick box each. Continue runs the next stage once per ticked
picture and charges for those only. Redo re-makes all N. Re-roll ×N on a workflow **without** a
Gate is unchanged: N complete versions, cost confirmed first, as today.

The pause survives restarts. When you reopen a project, the app asks the runner which Gates are
paused and shows their pictures and buttons again.

The Gate stays switched off for workflows that go to Python in the hosted product.

## 5. Money

Hosted only. Local mode has no credits, as today.

Each stage is priced from the generator descriptions (through `priceGraph` in
`server/utils/priceBook.ts`, over just that stage's nodes). The flat per-render credit is
charged once per run, not once per stage.

Before a stage runs, in this order, as `meterGraphSubmit` does for a whole workflow today:
spending pause check → are the moodboard files yours → content check → price → **hold** the
credits. When the stage finishes, the hold becomes a charge. If it fails, times out or is
stopped, the hold is dropped. Nothing is held while a run is paused.

The runner must not use the helpers that already charge per provider call (`runFal` in
`server/utils/falRun.ts` takes its own hold). We split out a fal client that only submits,
checks, fetches and cancels, and have `runFal` use it too, with no change to `runFal`'s
behaviour.

Each finished stage is recorded as a row in the existing `graph_runs` table with its output
files, so the image viewer's ownership check (`ownedOutputKeys`) lets you — and only you — see
the results.

**Exact cost:** the charge for each stage is written into the run record and the generation
history, and sent to the browser with the result, so the places that show a run's cost show the
real figure.

**Never pay twice.** Before sending a request, the runner makes a fingerprint of it: the model,
every setting, and the contents of every input file. If the same user already has a successful
result with that fingerprint, the runner reuses the saved file and charges nothing. A request
with a random seed (seed 0) is never reused — asking again should give something new.

## 6. Where files are saved

All saving goes through one small doorway: "store these bytes for this user, give me back a
name the viewer can show". Today it writes into ComfyUI's output folder
(`engineDirForType('output')`, with the per-user subfolder in hosted), named like today's
(`generate_image_00001_.png`, …), so Assets, the result cards and `/view` work unchanged.
Moving to cloud storage later changes only the doorway and `/view`.

## 7. Results and progress on the canvas

The runner announces events in exactly the shape ComfyUI uses today (`execution_start`,
`executing`, `progress`, `executed` with `{images:[{filename, subfolder, type}]}`,
`execution_complete`, `execution_error`, `gate_paused`). The browser receives them from a live
stream (`GET /api/runs/:id/events`, server-sent events) and passes them into the same in-page
pipe the canvas already listens to. Reopening a tab reconnects and replays the current state.

New events:

- **Place in line:** while fal has a request queued, the node and the status bar show
  "3rd in line"; when it starts, real progress replaces it where the model reports any.
- **Choices at a Gate:** the pictures to pick from, and which are ticked.

**The tab heads-up:** when a run finishes (or pauses at a Gate) while Sailor is in a background
tab, the tab title changes (for example "✓ Video ready · Sailor") and the icon gets a dot.
Both clear when you return to the tab.

## 8. Stop

Stop on a runner workflow cancels every request that's still at fal, drops the credit holds for
stages that haven't finished, and marks the run stopped. Results already made are kept and paid
for. Workflows on Python keep today's Stop.

## 9. Server wake-up

In hosted, the runner asks fal to call a Sailor address when each job finishes (a webhook). That
call wakes the server if it was asleep, and the run carries on without waiting for your next
visit. The runner checks fal's signature on each call and ignores anything unsigned. Checking
fal directly still happens too, so a missed call only means a delay. Locally there is no public
address, so the runner just keeps checking.

## 10. Several runs at once

Every provider call is just an outstanding request, so one process can run many. A per-user
limit (start at 4 calls in flight) queues anything beyond it in order. For these workflows the
extra Python worker processes are not used.

## When things go wrong

| What happens | What you see | What you pay |
|---|---|---|
| fal returns an error | Red ring and a plain message on the node; later nodes don't run | Nothing for that stage |
| fal is too slow (5 min image, 30 min video) | Same as an error | Nothing |
| Server restarts mid-run | A short delay, then it carries on | Once |
| You close the tab | Results are there when you return | Once |
| You press Stop | Unfinished jobs cancelled; finished results kept | Only what finished |
| A Gate is left paused | Pictures and buttons still there next time | Nothing extra |
| Not enough credits at Continue | "This needs X credits"; the run stays paused | Nothing |
| Prompt flagged by the content check | Refused before starting | Nothing |
| The same request was already made | The earlier result appears straight away | Nothing |

## Risks

- **Two copies of the request builders.** 18 models get a Sailor copy while Python keeps its
  own for the fallback path. The comparison test catches drift; the Python copies for these
  models can be deleted once the runner has carried them for a while.
- **One big release.** Many pieces ship together, so the checking at the end is larger. The
  switch keeps unfinished work away from users, and each piece gets its own tests as it lands.
- **Reference pictures on fal.** The exact fal endpoint and field for moodboard pictures on each
  of the five reference-capable models needs one cheap paid call each to confirm.
- **Reusing results.** A fingerprint that misses a setting would hand back a wrong result. The
  fingerprint is built from the full request that would be sent, not from a hand-picked list.

## How we'll prove it

1. Automated tests with a fake fal, no money spent: image → Gate → video; a restart halfway
   picks up the job; Continue after a restart; Redo; Restart; Continue after finishing; pick 2
   of 4 at a Gate and pay for 2; Stop cancels and drops holds; a failure drops the hold; each
   stage charged exactly once; an identical request is reused and a seed-0 one is not; two
   branches run at once; the per-user limit queues the fifth call; the webhook wakes a paused
   poll and unsigned calls are ignored; the request builders match Python's.
2. Real runs in the browser, after asking: Flux Schnell and the cheapest video model through a
   Gate with Re-roll ×4; one reference-picture request per reference-capable model.
3. A workflow containing a Toolbox node still goes to Python and behaves as before.
