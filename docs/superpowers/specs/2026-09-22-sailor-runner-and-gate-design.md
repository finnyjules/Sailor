# Sailor runner and the Gate — design

Date: 2026-09-22. Status: approved in conversation, awaiting a read of this document.

## In plain words

Today every workflow you run goes to ComfyUI, the Python app. For generations, ComfyUI does
almost nothing: it builds a request, sends it to fal, waits, and saves the file. We are building
a small **runner inside Sailor's own server** that does that job itself, for the simple cases.

The first version exists to make one workflow work properly: **make an image → check it at a
Gate → pay for a video only if you like it.** Today that Gate:

- is **switched off in the hosted product**;
- **forgets it was paused** whenever ComfyUI restarts, which is often;
- can **charge you twice** for the image if ComfyUI has forgotten it.

The runner fixes all three. It writes every step down as it goes, so a restart just picks up
where it left off. It charges one stage at a time, so you pay for the video only when you press
Continue.

What changes for you: nothing on screen. The Gate starts working in the hosted product, it
survives restarts, and Re-roll ×4 no longer starts extra Python processes.

What's risky: a second copy of the model request builders (Python and Sailor) while both paths
exist; and on the hosted server, which sleeps when idle, a run can wait for the next visit
before it finishes (see Risks).

## Scope

In the first version:

- **Four node types:** Generate an image (`GenerateImageNode`), Generate a video
  (`GenerateVideoNode`), Gate (`ComfyGateNode`), and the result cards (`Image`, `Video`).
- **The models that already default to fal:** 12 image models — Flux 1.1 Pro, Flux Schnell,
  Nano Banana Pro, Nano Banana 2, Ideogram V3 (Quality, Balanced, Turbo), Seedream 5 Pro,
  Seedream 5 Lite, Seedream 4, Krea 2 Large, Krea 2 Medium — and 6 video models: Veo 3.1,
  Veo 3.1 Fast, FLUX 3, Seedance 2.0, Hailuo H3, Hailuo H3 Max.
- **Moodboards:** both the saved style that becomes words in the prompt, and reference
  pictures. Reference pictures stay on fal (the current Python code sends them to Replicate only
  because its fal builders were never written to accept them; that is not a fal limit).
- **Several Gates in a row**, parallel branches, and several runs at once.

Not in the first version (a workflow that needs any of these goes to Python whole, unchanged):

- Every other node type (Toolbox, shaders, audio, video effects, edit, upscale, LoRA nodes).
- Image or video models that don't default to fal.
- Automatic switching to Replicate when fal fails. Today's silent fallback has billed people on
  the wrong provider; if we want a fallback, it will be a visible, deliberate choice later.

## How a workflow finds its way

Before sending a workflow, the app checks every node **and the model it uses** against the
runner's list. If everything is on the list, it goes to the runner. If even one thing isn't, the
whole workflow goes to Python exactly as today. A workflow is never split between the two.

Detail: `useDirectExecution.queueSmart`/`queueParallel` already consult `isPoolEligible`
(`app/lib/graph/cloudOnly.ts`). A sibling `isRunnerEligible(prompt)` checks each node's
`class_type` against the runner registry and, for `GenerateImageNode`/`GenerateVideoNode`, its
`model` widget against the registry's model list. Eligible → `POST /api/runs`; otherwise the
existing `/prompt` path. The graph format is the unchanged `ApiPrompt` from
`app/lib/graph/graphToPrompt.ts`.

## How a run works

A run is a written-down to-do list, not a program held in memory.

1. The runner receives the workflow and writes the run down: every node, all "waiting".
2. It starts every node whose inputs are ready — two independent nodes start at the same time.
3. Before calling fal it writes "sent, request id X". When fal answers it saves the file and
   writes "done, file Y".
4. At a Gate it writes "paused" and stops that branch. Other independent branches carry on.
5. When the server starts, it reads every run that was mid-flight and asks fal again for each
   request id it had sent. fal never stopped; only our note-taking did.

Where the list is written: Postgres in hosted (a new `runner_runs` table), a JSON file per run
under `.data/runs/` locally. Both behind one small storage interface, so the runner doesn't know
which it's using.

Files are handed from one node to the next by our own saved copy, uploaded to fal storage when
the next model needs it (`server/utils/falStorage.ts`), never as base64 pasted into the request.
This matters after a Gate: fal's own links can expire while you think it over; our saved file
doesn't.

## The Gate

A run is split into **stages** at each Gate. The runner charges and runs one stage at a time.

- **Run:** runs the first stage (the image), then pauses at the Gate.
- **Continue:** runs the next stage (the video) using the saved image.
- **Redo:** re-makes the stage before the Gate with a new seed (a seed of 0 already means
  random; any other seed goes up by one, as today). Later stages are untouched.
- **Restart:** throws away every result and runs from the start.
- **Continue after the run has finished:** runs everything after the Gate again from the kept
  image — "another video from the same picture".
- **A Gate with pass-through switched on** doesn't pause.

The pause survives restarts because it's written down. When you reopen a project, the app asks
the runner which Gates are paused and shows their buttons again.

The Gate stays switched off for workflows that go to Python in the hosted product; the runner's
own Gate is the one that works there.

## Money

Hosted only. Local mode has no credits, as today.

Each stage is priced with the existing price book (`server/utils/priceBook.ts`, `priceGraph`
over just that stage's nodes). The flat per-render credit is charged once per run, not once per
stage.

Before a stage runs, in this order, exactly like `meterGraphSubmit` does for a whole workflow
today: spending pause check → are the moodboard files yours → content check → price → **hold**
the credits. When the stage finishes, the hold becomes a charge. If it fails or times out, the
hold is dropped. Nothing is held while a run sits paused.

The runner must not use the helpers that already charge per provider call (`runFal` in
`server/utils/falRun.ts` takes its own hold). We will split out a fal client that only
submits, checks and fetches, and have `runFal` use it too, with no change to `runFal`'s
behaviour.

Each finished stage is recorded as a row in the existing `graph_runs` table with its output
files, so the image viewer's ownership check (`ownedOutputKeys`) lets you — and only you — see
the results.

## Results on the canvas

The runner saves files into the same output folder ComfyUI uses (`engineDirForType('output')`,
with the per-user subfolder in hosted), named like today's (`generate_image_00001_.png`, …).
So Assets, the image and video cards, and `/view` work unchanged.

It announces results in exactly the message shape ComfyUI uses today (`execution_start`,
`executing`, `executed` with `{images:[{filename, subfolder, type}]}`, `execution_complete`,
`execution_error`, `gate_paused`). The browser receives them from a live stream
(`GET /api/runs/:id/events`, server-sent events) and passes them into the same in-page pipe the
canvas already listens to. Reopening a tab reconnects and replays the current state.

Generation history: the runner saves the record for each finished stage itself, since it knows
the exact files and cost. Records are de-duplicated by run id, so the browser's own save doesn't
double them. (To confirm while planning: how the browser's save behaves for runs that aren't in
ComfyUI's history.)

## Several runs at once

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
| A Gate is left paused | Buttons still there next time | Nothing extra |
| Not enough credits at Continue | "This needs X credits"; the run stays paused | Nothing |
| Prompt flagged by the content check | Refused before starting | Nothing |

## Risks

- **Two copies of the request builders.** Each model's request is built in Python today; the
  runner needs a TypeScript copy for its 18 models. While both exist, a test compares their
  output for the same inputs, generated from the Python side. The Python copies for these models
  can be deleted once the runner has carried them for a while.
- **The hosted server sleeps when idle.** If nobody is connected, it can stop mid-run; the run
  resumes when the server next wakes. fal keeps finished results for a while but not forever.
  Later fix: ask fal to call us when a job finishes (a webhook), which wakes the server. Not in
  the first version.
- **Reference pictures on fal.** The exact fal endpoint and field for moodboard pictures on each
  of the five reference-capable models needs one cheap paid call each to confirm.

## How we'll prove it

1. Automated tests with a fake fal, no money spent: image → Gate → video; a restart halfway
   picks up the job; Continue after a restart; Redo; Restart; Continue after finishing; a
   failure drops the hold; each stage charged exactly once; two branches run at once; the
   per-user limit queues the fifth call; the request builders match Python's.
2. One real run in the browser with Flux Schnell and the cheapest video model, after asking.
3. A workflow containing a Toolbox node still goes to Python and behaves as before.
