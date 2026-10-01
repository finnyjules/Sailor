/**
 * Auto subtitle (step 3, R8.3): Load video → Get video components → Whisper
 * transcribe → Caption track (the captions wired in from Whisper) → Create
 * video (the sound put back) → Save video, run on the Sailor runner through
 * useAppRun. Karaoke's pattern (./karaokeApp.ts):
 *
 * - The price is quoted once the video is uploaded (Wizper is priced on the
 *   seconds of sound sent, bounded by the quote from the file's header;
 *   Caption track is free), and shown next to the run button.
 * - The captioned video is Save video's file, taken by node id (6).
 * - Stop ends the run (useAppRun.stop); closing the app stops it too.
 * - Ruling (d): with the app's families off, locally the workflow goes to the
 *   engine's /prompt as before R8 (a named stop-gap, removed by R10.1); in
 *   hosted the app says it is switched off.
 * - A video whose sound is longer than Whisper takes here (an hour locally)
 *   goes to the engine locally, keyed on the refusal's reason code
 *   (RUNNER_SOUND_TOO_LONG); in hosted the 10-minute video cap refuses it
 *   plainly, before any hold.
 * - A price check that failed (not a refusal) shows its words and leaves Run
 *   on: pressing it prices the exact prompt again before anything starts.
 */
import { computed, ref, type Ref } from 'vue'
import type { ApiPrompt } from '#shared/runner/graph'
import { RUNNER_SOUND_TOO_LONG } from '#shared/runner/messages'
import { AppRunCancelled, AppRunDeclined, AppRunRefused, useAppRun } from '~/composables/useAppRun'
import type { AppTakeInput } from '~/composables/useAppTakes'
import type { AwaitOutputsOptions, RunnerImage } from '~/lib/runner/awaitRunnerResult'

/** The node whose file is the captioned video. */
export const AUTO_SUBTITLE_OUT = '6'

export const AUTO_SUBTITLE_LANGUAGES = ['auto', 'en', 'fr', 'es', 'de', 'ja', 'zh', 'pt', 'it', 'ko'] as const
export type AutoSubtitleLanguage = typeof AUTO_SUBTITLE_LANGUAGES[number]
export type AutoSubtitlePosition = 'bottom' | 'middle' | 'top'
export interface AutoSubtitleSettings { language: AutoSubtitleLanguage, position: AutoSubtitlePosition, fontSize: number }

export function buildAutoSubtitlePrompt(filename: string, s: AutoSubtitleSettings): ApiPrompt {
  return {
    1: { class_type: 'LoadVideo', inputs: { file: filename } },
    2: { class_type: 'GetVideoComponents', inputs: { video: ['1', 0] } },
    3: { class_type: 'WhisperTranscribe', inputs: { audio: ['2', 1], model_size: 'base', language: s.language, fps: ['2', 2] } },
    4: {
      class_type: 'CaptionTrack',
      inputs: {
        frames: ['2', 0],
        captions: ['3', 0],
        font_size: s.fontSize,
        color: '#ffffff',
        outline_color: '#000000',
        outline_width: 3,
        position: s.position,
        y_inset: 0.08,
      },
    },
    5: { class_type: 'CreateVideo', inputs: { images: ['4', 0], fps: ['2', 2], audio: ['2', 1] } },
    [AUTO_SUBTITLE_OUT]: { class_type: 'SaveVideo', inputs: { video: ['5', 0], filename_prefix: 'auto_subtitle', format: 'auto', codec: 'auto' } },
  }
}

export const AUTO_SUBTITLE_WORDS = {
  failed: 'Adding captions didn’t work. Try again.',
  empty: 'The video finished without its captions. Try again.',
  slow: 'Adding captions took too long, so it was stopped.',
  noStart: 'Adding captions didn’t start. Try again.',
} as const

/** A long run's wait: a 10-minute video can take a while. */
const WAIT_MS = 30 * 60_000

export function autoSubtitleViewUrl(f: RunnerImage, now = Date.now()): string {
  return `/view?${new URLSearchParams({
    filename: f.filename,
    type: f.type,
    ...(f.subfolder ? { subfolder: f.subfolder } : {}),
    t: String(now),
  })}`
}

export interface AutoSubtitleResult { promptId: string, video: RunnerImage }

/**
 * The engine stop-gap (ruling (d), and a sound longer than Whisper takes
 * here; this computer only): /prompt and /history, the video taken from Save
 * video by node id. Gone with R10.1.
 */
export async function runOnEngine(prompt: ApiPrompt, o: { fetch?: typeof fetch, sleep?: (ms: number) => Promise<void>, waitMs?: number } = {}): Promise<AutoSubtitleResult> {
  const f = o.fetch ?? fetch
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const res = await f('/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }) }).catch(() => null)
  if (!res?.ok) throw new Error(AUTO_SUBTITLE_WORDS.noStart)
  const promptId: string | undefined = (await res.json().catch(() => null))?.prompt_id
  if (!promptId) throw new Error(AUTO_SUBTITLE_WORDS.noStart)
  const deadline = Date.now() + (o.waitMs ?? WAIT_MS)
  while (Date.now() < deadline) {
    await sleep(1000)
    const r = await f(`/history/${promptId}`).catch(() => null)
    if (!r?.ok) continue
    const entry = (await r.json().catch(() => null))?.[promptId]
    if (!entry) continue
    if (entry?.status?.status_str === 'error') throw new Error(AUTO_SUBTITLE_WORDS.failed)
    const out = entry?.outputs?.[AUTO_SUBTITLE_OUT]
    // Save video's file, under whichever key this engine version uses.
    for (const key of ['images', 'video', 'videos', 'gifs']) {
      const first = out?.[key]?.[0] as RunnerImage | undefined
      if (first?.filename) return { promptId, video: first }
    }
    if (entry?.status?.completed) throw new Error(AUTO_SUBTITLE_WORDS.empty)
  }
  throw new Error(AUTO_SUBTITLE_WORDS.slow)
}

export type AutoSubtitleStatus = 'idle' | 'running' | 'done' | 'error'

/** The app's run: price, Run, Stop, and the captioned video as a take. */
export function useAutoSubtitleRun(o: {
  video: Ref<{ filename: string } | null>
  settings: () => AutoSubtitleSettings
  addTake: (t: AppTakeInput) => unknown
  hosted?: boolean
  app?: ReturnType<typeof useAppRun>
  engine?: (prompt: ApiPrompt) => Promise<AutoSubtitleResult>
  /** Passed to the runner wait (tests feed events through it). */
  wait?: Pick<AwaitOutputsOptions, 'target' | 'timeoutMs'>
}) {
  const hosted = o.hosted ?? false
  const app = o.app ?? useAppRun({ hosted })
  const engine = o.engine ?? (p => runOnEngine(p))
  const status = ref<AutoSubtitleStatus>('idle')
  const errorMessage = ref<string | null>(null)
  /** This run went to the engine (no Stop there). */
  const onEngine = ref(false)

  /** Locally, the workflow the runner won't take (families off, or a sound longer than Whisper takes here) goes to the engine. */
  const engineStopGap = computed(() => !hosted && (app.declined.value || app.refusedReason.value === RUNNER_SOUND_TOO_LONG))
  /** What shows in place of a price: the refusal's or failed check's words, or "switched off" in hosted. */
  const blocked = computed<string | null>(() => {
    if (engineStopGap.value) return null
    if (app.declined.value) return new AppRunDeclined().message
    return app.refused.value
  })
  const priceText = computed(() => (engineStopGap.value ? null : app.priceText.value))
  const running = computed(() => status.value === 'running')
  // A failed price check never leaves the button dead: Run asks for the price again (useAppRun.run).
  const canRun = computed(() => !!o.video.value && !running.value && !app.quoting.value
    && (engineStopGap.value || app.quoteFailed.value || (!blocked.value && app.price.value !== null)))
  /** Stop is offered while a runner run is going. */
  const canStop = computed(() => running.value && !onEngine.value)

  const promptNow = (): ApiPrompt | null => (o.video.value ? buildAutoSubtitlePrompt(o.video.value.filename, o.settings()) : null)

  function quote(): Promise<void> {
    return app.quote(promptNow())
  }

  function land(r: AutoSubtitleResult): void {
    o.addTake({ videos: [autoSubtitleViewUrl(r.video)], promptId: r.promptId, sig: `${r.video.subfolder || ''}/${r.video.filename}` })
    status.value = 'done'
  }

  async function viaEngine(prompt: ApiPrompt): Promise<void> {
    onEngine.value = true
    try { land(await engine(prompt)) }
    finally { onEngine.value = false }
  }

  async function run(): Promise<void> {
    const prompt = promptNow()
    if (!canRun.value || !prompt) return
    errorMessage.value = null
    status.value = 'running'
    try {
      if (engineStopGap.value) return await viaEngine(prompt)
      const { promptId, outputs } = await app.run(prompt, [AUTO_SUBTITLE_OUT], {
        timeoutMs: WAIT_MS, ...o.wait, words: { failed: AUTO_SUBTITLE_WORDS.failed, empty: AUTO_SUBTITLE_WORDS.empty, slow: AUTO_SUBTITLE_WORDS.slow },
      })
      const video = outputs[AUTO_SUBTITLE_OUT]?.videos[0]
      if (!video) throw new Error(AUTO_SUBTITLE_WORDS.empty)
      land({ promptId, video })
    }
    catch (e) {
      // The runner said no at the start, or the sound is longer than Whisper takes here: locally, the
      // engine as before; hosted, "switched off" or the refusal's words.
      const tooLong = e instanceof AppRunRefused && e.reason === RUNNER_SOUND_TOO_LONG
      if ((e instanceof AppRunDeclined || tooLong) && !hosted) {
        try { return await viaEngine(prompt) }
        catch (err) { e = err }
      }
      const name = e instanceof Error ? e.name : ''
      if (e instanceof AppRunCancelled || name === 'AppRunStopped') { status.value = 'idle'; return }
      errorMessage.value = e instanceof Error && e.message ? e.message : AUTO_SUBTITLE_WORDS.failed
      status.value = 'error'
    }
  }

  function reset(): void {
    errorMessage.value = null
    status.value = 'idle'
  }

  return {
    status, errorMessage, priceText, blocked, canRun, canStop, running, quoting: app.quoting,
    stopError: app.stopError, quote, run, stop: app.stop, reset,
  }
}
