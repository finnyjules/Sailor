// Asset settling for export (spec Part 1). The engine starts every asset load without waiting and
// draws a placeholder meanwhile; an export must instead wait for all of them, and must say which
// one failed rather than bake a placeholder. Pure — no three.js — so it is unit-tested alone.

export type AssetKind = 'model' | 'font' | 'mesh' | 'hdri' | 'texture' | 'decal' | 'restyle' | 'shader'
export interface AssetFailure { kind: AssetKind; name: string; reason: string }
/** An asset by what a person recognises — a load still in flight has no reason yet. */
export interface AssetRef { kind: AssetKind; name: string }

/** The reason given for a load still in flight when the deadline passed. */
export const REASON_DIDNT_FINISH = "didn't finish loading"
/** The reason given for a load still in flight after every round — finished loads kept starting more. */
export const REASON_KEPT_RELOADING = 'kept reloading'

const reasonOf = (err: unknown): string =>
  err instanceof Error ? err.message : typeof err === 'string' ? err : 'failed to load'

const keyOf = (kind: AssetKind, name: string): string => `${kind}:${name}`

/** One entry per asset (`kind:name`), later entries winning: N materials sharing one missing
 *  file, or a load both failed earlier and still pending now, read as ONE failure. */
export function mergeFailures(list: Iterable<AssetFailure>): AssetFailure[] {
  const out = new Map<string, AssetFailure>()
  for (const f of list) {
    const k = keyOf(f.kind, f.name)
    out.delete(k) // re-insert, so the order is "most recent last"
    out.set(k, f)
  }
  return [...out.values()]
}

/** Resolves true when `p` settles before `deadline` (epoch ms), false when the deadline comes
 *  first. `p` keeps running either way — this only stops waiting for it. No deadline: waits. */
export async function beforeDeadline(p: Promise<unknown>, deadline?: number): Promise<boolean> {
  if (deadline === undefined) { await p; return true }
  const left = deadline - Date.now()
  if (left <= 0) return false
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), left) })
  try {
    return await Promise.race([p.then(() => true as const), late])
  } finally {
    clearTimeout(timer)
  }
}

/** What `settle` / `waitRound` / `failures` look at. `owner` narrows to loads and failures
 *  tagged with that owner (an engine's `id`) — a shared tracker serves several engines, and one
 *  engine must neither wait on nor report another's loads. `since` (a `mark` value) narrows
 *  failures to those recorded after that mark. */
export interface AssetScope { owner?: string; since?: number }
export interface SettleOptions extends AssetScope {
  /** Rounds of "wait for everything in flight now" (a finished load may start more). Default 20. */
  maxRounds?: number
  /** Epoch ms. Past it, settle stops waiting and names what is still loading. */
  deadline?: number
}

/** A watched load. `addOwner` tags a load another owner is now also waiting on (a shared cache
 *  hit on a file still downloading) — a no-op once the load has settled. */
export interface AssetLoad { addOwner(owner: string): void }

interface InFlight { kind: AssetKind; name: string; owners: Set<string> }
interface FailureRecord {
  kind: AssetKind; name: string; reason: string
  /** The sequence number of this asset's latest failure, whoever it was for. */
  seq: number
  /** Owner → the sequence number of this asset's latest failure for that owner. */
  owners: Map<string, number>
}

export class AssetTracker {
  private readonly inFlight = new Map<Promise<void>, InFlight>()
  /** Keyed `kind:name` — one record per asset, so a retry that fails again (a broken decal
   *  re-tried on every sync) replaces its record instead of growing the list. */
  private readonly failureRecords = new Map<string, FailureRecord>()
  /** Monotonic; never reset (not even by `clearFailures`), so a `mark` taken earlier stays
   *  meaningful however the records change. */
  private seq = 0

  /** Watch a load. Never changes the caller's promise; records a failure if it rejects —
   *  against every owner waiting on it at that moment. */
  observe(kind: AssetKind, name: string, p: Promise<unknown>, owner?: string): AssetLoad {
    const entry: InFlight = { kind, name, owners: new Set(owner === undefined ? [] : [owner]) }
    const settled: Promise<void> = p.then(
      () => undefined,
      (err) => { this.record(kind, name, reasonOf(err), entry.owners) },
    )
    this.inFlight.set(settled, entry)
    void settled.finally(() => this.inFlight.delete(settled))
    return {
      addOwner: (o: string) => { if (this.inFlight.has(settled)) entry.owners.add(o) },
    }
  }

  /** Record a failure a site handled (and swallowed) itself. */
  fail(kind: AssetKind, name: string, err: unknown, owner?: string): void {
    this.record(kind, name, reasonOf(err), owner === undefined ? [] : [owner])
  }

  private record(kind: AssetKind, name: string, reason: string, owners: Iterable<string>): void {
    const seq = ++this.seq
    const k = keyOf(kind, name)
    let rec = this.failureRecords.get(k)
    if (rec) this.failureRecords.delete(k) // re-inserted below: the most recent failure reads last
    else rec = { kind, name, reason, seq, owners: new Map() }
    rec.reason = reason
    rec.seq = seq
    for (const o of owners) rec.owners.set(o, seq)
    this.failureRecords.set(k, rec)
  }

  /** The failures in scope, one per asset, most recent last. Cheap when nothing new has failed
   *  since `scope.since`, so a per-frame caller pays almost nothing. */
  failures(scope: AssetScope = {}): AssetFailure[] {
    const since = scope.since ?? 0
    if (this.seq <= since) return []
    const out: AssetFailure[] = []
    for (const rec of this.failureRecords.values()) {
      const s = scope.owner === undefined ? rec.seq : rec.owners.get(scope.owner)
      if (s !== undefined && s > since) out.push({ kind: rec.kind, name: rec.name, reason: rec.reason })
    }
    return out
  }

  private inScope(e: InFlight, owner?: string): boolean {
    return owner === undefined || e.owners.has(owner)
  }

  /** How many loads are in flight in scope (all of them when `owner` is omitted). */
  pendingFor(owner?: string): number {
    if (owner === undefined) return this.inFlight.size
    let n = 0
    for (const e of this.inFlight.values()) if (e.owners.has(owner)) n++
    return n
  }

  /** The loads still in flight in scope, one per asset. */
  pendingLoads(owner?: string): AssetRef[] {
    const out = new Map<string, AssetRef>()
    for (const e of this.inFlight.values()) {
      if (this.inScope(e, owner)) out.set(keyOf(e.kind, e.name), { kind: e.kind, name: e.name })
    }
    return [...out.values()]
  }

  /** ONE round: wait for every load in scope that is in flight right now, or until `deadline`.
   *  False when the deadline cut it short. Loads started meanwhile are the next round's. */
  async waitRound(opts: { owner?: string; deadline?: number } = {}): Promise<boolean> {
    const waiting: Promise<void>[] = []
    for (const [p, e] of this.inFlight) if (this.inScope(e, opts.owner)) waiting.push(p)
    if (!waiting.length) return true
    return beforeDeadline(Promise.all(waiting), opts.deadline)
  }

  /** Wait until nothing in scope is in flight (loads may start more loads), up to `maxRounds`
   *  rounds and never past `deadline`. Returns the failures in scope plus, when it stopped
   *  early, every load still in flight: "didn't finish loading" at the deadline, "kept
   *  reloading" when the rounds ran out. Those two are reported, not stored — the loads keep
   *  running, and one that lands later is not a failure to a later settle. */
  async settle(opts: SettleOptions = {}): Promise<AssetFailure[]> {
    const maxRounds = opts.maxRounds ?? 20
    let stopped: string | null = null
    for (let r = 0; ; r++) {
      if (!this.pendingFor(opts.owner)) break
      if (r >= maxRounds) { stopped = REASON_KEPT_RELOADING; break }
      if (!(await this.waitRound(opts))) { stopped = REASON_DIDNT_FINISH; break }
    }
    const failed = this.failures(opts)
    if (!stopped) return failed
    const reason = stopped
    return mergeFailures([...failed, ...this.pendingLoads(opts.owner).map((p) => ({ ...p, reason }))])
  }

  /** Loads in flight, across every owner. */
  get pending(): number { return this.inFlight.size }
  /** A point in this tracker's history: `failures({ since: mark })` later reads only the
   *  failures recorded after it. Monotonic — `clearFailures` never moves it back. */
  get mark(): number { return this.seq }
  clearFailures(): void { this.failureRecords.clear() }
  /** Drop an owner that is gone (a disposed engine): its failure tags go, a record left with no
   *  owner at all goes too, and its in-flight loads stop counting for it. Keeps a long session's
   *  shared tracker bounded by the engines still alive. Unowned records are untouched. */
  forgetOwner(owner: string): void {
    for (const [k, rec] of this.failureRecords) {
      if (!rec.owners.delete(owner)) continue
      if (!rec.owners.size) this.failureRecords.delete(k)
    }
    for (const e of this.inFlight.values()) e.owners.delete(owner)
  }
}
