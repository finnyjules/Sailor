/** Small helpers for the Gate's pick-the-best row. */
import type { GateChoice, GateChoiceFile } from '#shared/runner/messages'

export function initialTicks(choices: GateChoice[] | null | undefined, picked: number[] | null | undefined): number[] {
  const takes = new Set((choices ?? []).map(c => c.take))
  return (picked ?? []).filter(t => takes.has(t))
}

export function continueLabel(choiceCount: number, ticked: number): string {
  if (choiceCount <= 1) return 'Continue'
  return ticked > 0 ? `Continue with ${ticked}` : 'Tick to continue'
}

export function viewUrl(f: GateChoiceFile): string {
  const params = new URLSearchParams({ filename: f.filename, type: f.type })
  if (f.subfolder) params.set('subfolder', f.subfolder)
  return `/view?${params}`
}

export function isVideoFile(name: string): boolean {
  return /\.(mp4|webm|mov|m4v)$/i.test(name)
}

/**
 * R10.3: where a Gate's Continue / Redo / Restart goes. A runner run's Gate
 * goes to the runner (`sailor:runnerGateAction`). A Gate paused inside a run
 * the local engine is running (R10.2's explicit local-only route, e.g. a
 * KSampler graph) still resumes through the engine's own resume route, but
 * only locally: hosted never sends it (and its proxy refuses it, enginePath F1).
 */
export function gateResumeRoute(promptId: string | null | undefined, opts: { runner: boolean, hosted: boolean }): 'runner' | 'engine' | 'none' {
  if (opts.runner) return 'runner'
  if (opts.hosted || !promptId) return 'none'
  return 'engine'
}
