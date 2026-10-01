/**
 * Face swap (step 3, R8.4): Load image ×2 → Face swap, run on the Sailor
 * runner through useAppRun, with its price before the run and a Stop button.
 *
 * - The price is quoted once both pictures and a gender are chosen, and shown
 *   next to the run button (the node badge's format).
 * - The swapped picture is taken from the Face swap node by id
 *   (FACE_SWAP_NODE), never by file name.
 * - Stop ends the run (useAppRun.stop); closing the app stops it too.
 * - Ruling (d): Face swap has no engine fallback (its Python node fails on
 *   ComfyUI). When the runner declines it, in both places, the app says
 *   "Face swap is switched off right now." and sends nothing.
 */
import { computed, ref, type Ref } from 'vue'
import type { ApiPrompt } from '#shared/runner/graph'
import { FACE_SWAP_GENDER_DEFAULT } from '#shared/runner/faceSwap'
import { AppRunCancelled, AppRunDeclined, useAppRun } from '~/composables/useAppRun'
import type { AppTakeInput } from '~/composables/useAppTakes'
import { buildFaceSwapPrompt, type AwaitOutputsOptions, type RunnerImage } from '~/lib/runner/awaitRunnerResult'

/** The Face swap node: its picture is the result. */
export const FACE_SWAP_NODE = '3'

export const FACE_SWAP_WORDS = {
  off: 'Face swap is switched off right now.',
  failed: 'The swap didn’t work. Try again.',
  empty: 'The swap finished but made no picture.',
  slow: 'The swap took too long, so it was stopped.',
} as const

const WAIT_MS = 5 * 60_000

export interface FaceSwapChoice {
  face: { filename: string } | null
  target: { filename: string } | null
  gender: string
  keepHairFrom: string
}

/** The app's exact prompt, or null until both pictures and a gender are chosen. */
export function faceSwapPromptOf(c: FaceSwapChoice): ApiPrompt | null {
  if (!c.face || !c.target || !c.gender || c.gender === FACE_SWAP_GENDER_DEFAULT) return null
  return buildFaceSwapPrompt({ face: c.face.filename, target: c.target.filename, gender: c.gender, keepHairFrom: c.keepHairFrom })
}

export function faceSwapViewUrl(f: RunnerImage, now = Date.now()): string {
  return `/view?${new URLSearchParams({
    filename: f.filename,
    type: f.type,
    ...(f.subfolder ? { subfolder: f.subfolder } : {}),
    t: String(now),
  })}`
}

export type FaceSwapStatus = 'idle' | 'running' | 'done' | 'error'

/** The app's run: price, Run, Stop, and the swapped picture as a take. */
export function useFaceSwapRun(o: {
  choice: Ref<FaceSwapChoice>
  addTake: (t: AppTakeInput) => unknown
  hosted?: boolean
  app?: ReturnType<typeof useAppRun>
  /** Passed to the runner wait (tests feed events through it). */
  wait?: Pick<AwaitOutputsOptions, 'target' | 'timeoutMs'>
}) {
  const app = o.app ?? useAppRun({ hosted: o.hosted })
  const status = ref<FaceSwapStatus>('idle')
  const errorMessage = ref<string | null>(null)

  const prompt = computed(() => faceSwapPromptOf(o.choice.value))
  /** What shows in place of a price: "switched off", or the refusal's or failed check's words. */
  const blocked = computed<string | null>(() => (app.declined.value ? FACE_SWAP_WORDS.off : app.refused.value))
  const running = computed(() => status.value === 'running')
  // A failed price check never leaves the button dead: Run asks for the price again (useAppRun.run).
  const canRun = computed(() => !!prompt.value && !running.value && !app.quoting.value && !app.declined.value
    && (app.quoteFailed.value || (!blocked.value && app.price.value !== null)))
  const canStop = computed(() => running.value)

  function quote(): Promise<void> {
    return app.quote(prompt.value)
  }

  async function run(): Promise<void> {
    const p = prompt.value
    if (!canRun.value || !p) return
    errorMessage.value = null
    status.value = 'running'
    try {
      const { promptId, outputs } = await app.run(p, [FACE_SWAP_NODE], {
        timeoutMs: WAIT_MS, ...o.wait, words: { failed: FACE_SWAP_WORDS.failed, empty: FACE_SWAP_WORDS.empty, slow: FACE_SWAP_WORDS.slow },
      })
      const picture = outputs[FACE_SWAP_NODE]?.images[0]
      if (!picture) throw new Error(FACE_SWAP_WORDS.empty)
      o.addTake({ images: [faceSwapViewUrl(picture)], promptId, sig: `${picture.subfolder || ''}/${picture.filename}` })
      status.value = 'done'
    }
    catch (e) {
      const name = e instanceof Error ? e.name : ''
      if (e instanceof AppRunCancelled || name === 'AppRunStopped') { status.value = 'idle'; return }
      // No engine fallback (ruling (d)): a decline says so, in both places.
      errorMessage.value = e instanceof AppRunDeclined
        ? FACE_SWAP_WORDS.off
        : e instanceof Error && e.message ? e.message : FACE_SWAP_WORDS.failed
      status.value = 'error'
    }
  }

  function reset(): void {
    errorMessage.value = null
    status.value = 'idle'
  }

  return {
    status, errorMessage, priceText: app.priceText, blocked, canRun, canStop, running, quoting: app.quoting,
    stopError: app.stopError, quote, run, stop: app.stop, reset,
  }
}
