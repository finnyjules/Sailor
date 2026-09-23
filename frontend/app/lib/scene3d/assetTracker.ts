// Asset settling for export (spec Part 1). The engine starts every asset load without waiting and
// draws a placeholder meanwhile; an export must instead wait for all of them, and must say which
// one failed rather than bake a placeholder. Pure — no three.js — so it is unit-tested alone.

export type AssetKind = 'model' | 'font' | 'mesh' | 'hdri' | 'texture' | 'decal' | 'restyle'
export interface AssetFailure { kind: AssetKind; name: string; reason: string }

const reasonOf = (err: unknown): string =>
  err instanceof Error ? err.message : typeof err === 'string' ? err : 'failed to load'

export class AssetTracker {
  private readonly inFlight = new Set<Promise<void>>()
  private failures: AssetFailure[] = []

  /** Watch a load. Never changes the caller's promise; records a failure if it rejects. */
  observe(kind: AssetKind, name: string, p: Promise<unknown>): void {
    const settled: Promise<void> = p.then(
      () => undefined,
      (err) => { this.failures.push({ kind, name, reason: reasonOf(err) }) },
    )
    this.inFlight.add(settled)
    void settled.finally(() => this.inFlight.delete(settled))
  }

  /** Record a failure a site handled (and swallowed) itself. */
  fail(kind: AssetKind, name: string, err: unknown): void {
    this.failures.push({ kind, name, reason: reasonOf(err) })
  }

  /** Wait until nothing is in flight (loads may start more loads), up to `maxRounds` rounds. */
  async settle(maxRounds = 20): Promise<AssetFailure[]> {
    for (let r = 0; r < maxRounds && this.inFlight.size; r++) await Promise.all([...this.inFlight])
    return [...this.failures]
  }

  get pending(): number { return this.inFlight.size }
  /** How many failures are recorded so far — a mark, so a caller sharing a long-lived tracker
   *  (the module-level texture one) can read only the failures that came after it. */
  get failureCount(): number { return this.failures.length }
  clearFailures(): void { this.failures = [] }
}
