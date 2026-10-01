/**
 * Karaoke (step 3, R8.2, the pilot app): Load audio → Vocal separator →
 * Save audio (MP3) × 2, run on the Sailor runner through useAppRun.
 *
 * - The price is quoted once the song is uploaded (Demucs is priced on the
 *   seconds sent, measured by the quote), and shown next to the run button.
 * - The two stems are taken by node id (KARAOKE_STEMS), never by file name.
 * - Stop ends the run (useAppRun.stop); closing the app stops it too.
 * - Ruling (d): with the app's families off, locally the workflow goes to the
 *   engine's /prompt as before R8 (a named stop-gap, removed by R10.1); in
 *   hosted the app says it is switched off.
 * - Ruling (i): locally, a song over the runner's longest (20 minutes) goes to
 *   the engine too (stop-gap until songs are cut into pieces, R11); in hosted
 *   a song over 10 minutes is refused plainly, before any hold.
 */
import { computed, ref, type Ref } from 'vue'
import type { ApiPrompt } from '#shared/runner/graph'
import { VOCALS_WORDS } from '#shared/runner/localModels'
import { AppRunCancelled, AppRunDeclined, useAppRun } from '~/composables/useAppRun'
import type { AppTakeInput } from '~/composables/useAppTakes'
import type { AwaitOutputsOptions, RunnerImage } from '~/lib/runner/awaitRunnerResult'

/** The nodes whose files are the two stems. */
export const KARAOKE_STEMS = { vocals: '3', instrumental: '4' } as const

export function buildKaraokePrompt(filename: string): ApiPrompt {
  return {
    1: { class_type: 'LoadAudio', inputs: { audio: filename } },
    2: { class_type: 'VocalSeparator', inputs: { audio: ['1', 0], model: 'htdemucs', shifts: 1 } },
    [KARAOKE_STEMS.vocals]: { class_type: 'SaveAudioMP3', inputs: { audio: ['2', 0], filename_prefix: 'karaoke_vocals', quality: 'V0' } },
    [KARAOKE_STEMS.instrumental]: { class_type: 'SaveAudioMP3', inputs: { audio: ['2', 1], filename_prefix: 'karaoke_instrumental', quality: 'V0' } },
  }
}

export const KARAOKE_WORDS = {
  failed: 'The separation didn’t work. Try again.',
  empty: 'The separation finished without both tracks. Try again.',
  slow: 'The separation took too long, so it was stopped.',
  noStart: 'The separation didn’t start. Try again.',
} as const

/** A long run's wait: a 10-minute song can take a while at the service. */
const WAIT_MS = 20 * 60_000

export function karaokeViewUrl(f: RunnerImage, now = Date.now()): string {
  return `/view?${new URLSearchParams({
    filename: f.filename,
    type: f.type,
    ...(f.subfolder ? { subfolder: f.subfolder } : {}),
    t: String(now),
  })}`
}

export interface KaraokeStems { promptId: string, vocals: RunnerImage, instrumental: RunnerImage }

/**
 * The engine stop-gap (ruling (d) and (i), this computer only): /prompt and
 * /history, the stems taken by node id. Gone with R10.1.
 */
export async function runOnEngine(prompt: ApiPrompt, o: { fetch?: typeof fetch, sleep?: (ms: number) => Promise<void>, waitMs?: number } = {}): Promise<KaraokeStems> {
  const f = o.fetch ?? fetch
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const res = await f('/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }) }).catch(() => null)
  if (!res?.ok) throw new Error(KARAOKE_WORDS.noStart)
  const promptId: string | undefined = (await res.json().catch(() => null))?.prompt_id
  if (!promptId) throw new Error(KARAOKE_WORDS.noStart)
  const deadline = Date.now() + (o.waitMs ?? WAIT_MS)
  while (Date.now() < deadline) {
    await sleep(800)
    const r = await f(`/history/${promptId}`).catch(() => null)
    if (!r?.ok) continue
    const entry = (await r.json().catch(() => null))?.[promptId]
    if (!entry) continue
    if (entry?.status?.status_str === 'error') throw new Error(KARAOKE_WORDS.failed)
    const first = (id: string): RunnerImage | undefined => entry?.outputs?.[id]?.audio?.[0]
    const vocals = first(KARAOKE_STEMS.vocals)
    const instrumental = first(KARAOKE_STEMS.instrumental)
    if (vocals && instrumental) return { promptId, vocals, instrumental }
    if (entry?.status?.completed) throw new Error(KARAOKE_WORDS.empty)
  }
  throw new Error(KARAOKE_WORDS.slow)
}

export type KaraokeStatus = 'idle' | 'running' | 'done' | 'error'

/**
 * The app's run: price, Run, Stop, and the result as one take holding both
 * stems [vocals, instrumental].
 */
export function useKaraokeRun(o: {
  song: Ref<{ filename: string } | null>
  addTake: (t: AppTakeInput) => unknown
  hosted?: boolean
  app?: ReturnType<typeof useAppRun>
  engine?: (prompt: ApiPrompt) => Promise<KaraokeStems>
  /** Passed to the runner wait (tests feed events through it). */
  wait?: Pick<AwaitOutputsOptions, 'target' | 'timeoutMs'>
}) {
  const hosted = o.hosted ?? false
  const app = o.app ?? useAppRun({ hosted })
  const engine = o.engine ?? (p => runOnEngine(p))
  const status = ref<KaraokeStatus>('idle')
  const errorMessage = ref<string | null>(null)
  /** This run went to the engine (no Stop there). */
  const onEngine = ref(false)

  /** Locally, the workflow the runner won't take (families off, or a song over its longest) goes to the engine. */
  const engineStopGap = computed(() => !hosted && (app.declined.value || app.refused.value === VOCALS_WORDS.tooLong))
  /** What shows in place of a price: the refusal's words, or "switched off" in hosted. */
  const blocked = computed<string | null>(() => {
    if (engineStopGap.value) return null
    if (app.declined.value) return new AppRunDeclined().message
    return app.refused.value
  })
  const priceText = computed(() => (engineStopGap.value ? null : app.priceText.value))
  const running = computed(() => status.value === 'running')
  const canRun = computed(() => !!o.song.value && !running.value && !app.quoting.value && !blocked.value
    && (engineStopGap.value || app.price.value !== null))
  /** Stop is offered while a runner run is going. */
  const canStop = computed(() => running.value && !onEngine.value)

  function quote(): Promise<void> {
    return app.quote(o.song.value ? buildKaraokePrompt(o.song.value.filename) : null)
  }

  function land(s: KaraokeStems): void {
    o.addTake({
      audios: [karaokeViewUrl(s.vocals), karaokeViewUrl(s.instrumental)],
      promptId: s.promptId,
      sig: `${s.vocals.subfolder || ''}/${s.vocals.filename}`,
    })
    status.value = 'done'
  }

  async function viaEngine(prompt: ApiPrompt): Promise<void> {
    onEngine.value = true
    try { land(await engine(prompt)) }
    finally { onEngine.value = false }
  }

  async function run(): Promise<void> {
    if (!canRun.value || !o.song.value) return
    const prompt = buildKaraokePrompt(o.song.value.filename)
    errorMessage.value = null
    status.value = 'running'
    try {
      if (engineStopGap.value) return await viaEngine(prompt)
      const { promptId, outputs } = await app.run(prompt, [KARAOKE_STEMS.vocals, KARAOKE_STEMS.instrumental], {
        timeoutMs: WAIT_MS, ...o.wait, words: { failed: KARAOKE_WORDS.failed, empty: KARAOKE_WORDS.empty, slow: KARAOKE_WORDS.slow },
      })
      const vocals = outputs[KARAOKE_STEMS.vocals]?.audio[0]
      const instrumental = outputs[KARAOKE_STEMS.instrumental]?.audio[0]
      if (!vocals || !instrumental) throw new Error(KARAOKE_WORDS.empty)
      land({ promptId, vocals, instrumental })
    }
    catch (e) {
      // The runner said no at the start: locally, the engine as before; hosted, "switched off".
      if (e instanceof AppRunDeclined && !hosted) {
        try { return await viaEngine(prompt) }
        catch (err) { e = err }
      }
      const name = e instanceof Error ? e.name : ''
      if (e instanceof AppRunCancelled || name === 'AppRunStopped') { status.value = 'idle'; return }
      errorMessage.value = e instanceof Error && e.message ? e.message : KARAOKE_WORDS.failed
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
