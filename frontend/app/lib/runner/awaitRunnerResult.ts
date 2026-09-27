/**
 * A mini app's run on the Sailor runner: the prompt it sends and the wait for
 * its picture on the runner's event pipe (useRunnerEvents posts each event on
 * window as a `sailor-bridge` envelope). The Face Swap app is the first app on
 * the runner (spec 2026-09-26-non-commercial-face-models-replacement).
 *
 * `gender`/`keepHairFrom` are the FaceSwap node's own human-readable combo
 * values (#shared/runner/faceSwap: FACE_SWAP_GENDER_OPTIONS,
 * FACE_SWAP_HAIR_OPTIONS) — the canvas shows a stored combo value raw, so the
 * app passes them straight through rather than translating to an identifier.
 *
 * Fix round 1: server/runner/engine.ts starts the leg before POST /api/runs
 * returns (app/layouts/default.vue's runnerEventBuffer/sendRunnerPost hazard
 * documents the same race), so the run's events can land on window before the
 * caller even knows its own prompt id. `awaitRunnerImage` therefore takes the
 * id as `string | Promise<string>`, attaches its window listener immediately
 * (synchronously, before the id promise can settle), and buffers every
 * sailor-bridge envelope until the id is known — then replays the buffer
 * against it and keeps matching live envelopes the same way.
 */
import type { ApiPrompt } from '#shared/runner/graph'

export interface RunnerImage { filename: string; subfolder: string; type: string }

export function buildFaceSwapPrompt(a: { face: string, target: string, gender: string, keepHairFrom: string }): ApiPrompt {
  return {
    1: { class_type: 'LoadImage', inputs: { image: a.face } },
    2: { class_type: 'LoadImage', inputs: { image: a.target } },
    3: { class_type: 'FaceSwap', inputs: { source_face: ['1', 0], target_frames: ['2', 0], gender: a.gender, keep_hair_from: a.keepHairFrom } },
  } as ApiPrompt
}

type Target = Pick<Window, 'addEventListener' | 'removeEventListener'>

export function awaitRunnerImage(promptId: string | Promise<string>, opts: { timeoutMs?: number, target?: Target } = {}): Promise<RunnerImage> {
  const target = opts.target ?? window
  return new Promise((resolve, reject) => {
    let picture: RunnerImage | null = null
    let resolvedId: string | null = null
    let finished = false
    // Envelopes seen before the id is known — replayed once it resolves.
    const buffer: Record<string, any>[] = []

    const finish = (fn: () => void) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      target.removeEventListener('message', onMessage as EventListener)
      fn()
    }

    const process = (d: Record<string, any>) => {
      if (finished || resolvedId === null || d.prompt_id !== resolvedId) return
      if (d.event === 'executed') {
        const img = d.output?.images?.[0]
        if (img?.filename) { picture = { filename: img.filename, subfolder: img.subfolder ?? '', type: img.type ?? 'output' }; finish(() => resolve(picture!)) }
      } else if (d.event === 'execution_error') {
        finish(() => reject(new Error(d.exception_message || 'The swap failed.')))
      } else if (d.event === 'execution_complete') {
        finish(() => picture ? resolve(picture) : reject(new Error('The swap finished but made no picture.')))
      }
    }

    const onMessage = (e: MessageEvent) => {
      const d = e.data as Record<string, any> | null
      if (!d || d.type !== 'sailor-bridge') return
      if (resolvedId === null) { buffer.push(d); return }
      process(d)
    }

    // The timeout starts at call time, same as before — an id that never
    // resolves (or resolves too late) still gives up after opts.timeoutMs.
    const timer = setTimeout(() => finish(() => reject(new Error('The swap took too long. Try again.'))), opts.timeoutMs ?? 5 * 60_000)
    // Attached synchronously, before `promptId` (even an already-settled
    // promise) can resolve — nothing posted between call time and id
    // resolution is missed.
    target.addEventListener('message', onMessage as EventListener)

    Promise.resolve(promptId).then(
      (id) => {
        if (finished) return
        resolvedId = id
        for (const d of buffer) {
          if (finished) break
          process(d)
        }
      },
      (err) => {
        finish(() => reject(err instanceof Error ? err : new Error(String(err))))
      },
    )
  })
}
