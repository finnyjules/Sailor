# Shader engine run: stage 1 (2026-09-24)

Run by Julien on `/dev/shader-gen-eval`, judged by eye against the 24 hand-written spike takes. The spike was written by Opus 5.5 in the design session, with full context. The first full run stopped partway when the API credits ran out, so there is no exported results JSON. This record is Julien's verdicts.

## Main run: 6 spike requests × 4 takes

| Setup | Verdict |
|---|---|
| Sonnet 5, `plan` tier (effort low) | None came close to the spike |
| Haiku 4.5, `patch` tier | None came close to the spike |

## Quality variants: rain and ink × 4 takes

| Variant | Setup | Verdict |
|---|---|---|
| A | Sonnet 5, effort high | Below Opus (credits ran out partway) |
| B | Opus 5.5, effort high | "Vastly superior", as good as E |
| C | Sonnet 5 + the test photo + 2 spike takes from other requests as examples | OK |
| D | Sonnet 5 + one look-and-revise pass | Terrible |
| E | Opus 5.5 + photo + examples + look-and-revise | Best, equal to B |

## What this says

1. **Model capability is the main lever.** The same model that wrote the spike (Opus 5.5) gets close to it through the engine. Sonnet and Haiku don't.
2. **Context helps a weaker model.** The image and the examples lifted Sonnet from far off to acceptable.
3. **Look-and-revise hurts.** On Sonnet the revision made takes worse. On Opus it added a call and latency for no visible gain (B equal to E).

## Decision

**Opus 5.5 writes the shaders, with the user's image and two good existing effects as examples, and no revise pass.** Dial-only takes stay on Haiku. Recorded in the spec, §7.2.

Ruling (the controller's, which Julien can overturn): photo and examples are kept for Opus even though B and E tied. They cost little next to Opus's output, they are what made the weaker model acceptable, and in the product the image is the user's own, which the model needs to choose good defaults.

Not measured, because the run stopped when the credits ran out: exact tokens and time per request per variant. Measure cost and latency for Opus with photo and examples at the start of stage 5.
