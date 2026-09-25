// frontend/app/lib/canvas/runRowStatus.ts
// The slim Run row's status line (spec §2.3): state you need to see without selecting.
export type RunTone = 'idle' | 'running' | 'done' | 'error' | 'live'

function ago(ms: number): string {
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} h ago`
  return `${Math.floor(h / 24)} d ago`
}

export function runRowStatus(s: { running: boolean; error?: boolean; live?: boolean; hasRun: boolean; costLabel?: string | null; lastRunAt?: number | null; now: number }): { tone: RunTone; text: string } {
  if (s.running) return { tone: 'running', text: 'Running…' }
  if (s.error) return { tone: 'error', text: 'Failed · run again' }
  if (s.live) return { tone: 'live', text: 'Live preview' }
  if (s.hasRun) return { tone: 'done', text: s.lastRunAt ? `Rendered ${ago(s.now - s.lastRunAt)}` : 'Rendered' }
  return { tone: 'idle', text: s.costLabel ? `Not run yet · ${s.costLabel}` : 'Not run yet' }
}
