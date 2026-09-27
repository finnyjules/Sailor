/**
 * What each paid-model call (step 3, R3: the Replicate classes, Pose
 * Mannequin, Lens reframe and Turntable) costs Sailor at its service, keyed by
 * the endpoint the call goes to (a fal app id or a Replicate slug). Each R3
 * task adds the cards for its own endpoints; the table is empty until then.
 *
 * Units, following the service:
 *  - `per_call`: dollars per call;
 *  - `per_token`: dollars per million input tokens and per million output
 *    tokens (the text models);
 *  - `per_input_second`: dollars per second of the sound or video sent, with
 *    a billed minimum where the service has one;
 *  - `per_output_second`: dollars per second of what comes back;
 *  - `per_thousand_chars`: dollars per thousand characters of text sent
 *    (speech), in proportion;
 *  - `gpu_ceiling`: a model billed by GPU time, priced at a stated ceiling
 *    (`note` says how it was reached). Its confidence is `estimate` until a
 *    live call measures it, and an estimate blocks the family's switch-on.
 *
 * An endpoint carded already elsewhere is priced by that card, so each rate
 * lives in one place: the edit cards (editRates.ts), the per-second clip
 * cards (clipRates.ts) and the Generate-a-video models (videoRates.ts, keyed
 * by model id, with its backup rule).
 *
 * A call's price basis (`paidCallUsd`) follows the one-call rule of
 * editRates.ts editMaxUsd: the first service's price (it carries the markup),
 * or each fallback covered at cost, whichever is higher. A node's credits are
 * the sum of its calls' own credits (pipelinePrice.ts callCredits, the R3.1
 * ruling), never the markup of a summed dollar figure: nodePrice.ts.
 *
 * Every card carries its source page, the date it was read and a confidence,
 * as editRates.ts does. Pure data and pure functions; relative imports only
 * (Nitro, the app and vitest all load it).
 */
import { usdChargedAtCost } from './markup'
import { editRate, editUsd } from './editRates'
import { clipRate, clipUsd } from './clipRates'
import { videoPriceUsd, videoRate } from './videoRates'

interface RateMeta {
  service: 'fal' | 'replicate'
  /** The page (or saved schema) the figure was read from. */
  source: string
  /** ISO date the page was read. */
  read: string
  confidence: 'verified' | 'estimate'
}

export type PaidRate =
  | (RateMeta & { unit: 'per_call', usd: number })
  | (RateMeta & { unit: 'per_token', inputPerMillion: number, outputPerMillion: number })
  | (RateMeta & { unit: 'per_input_second', perSecond: number, minSeconds?: number })
  | (RateMeta & { unit: 'per_output_second', perSecond: number })
  | (RateMeta & { unit: 'per_thousand_chars', perThousand: number })
  | (RateMeta & { unit: 'gpu_ceiling', usd: number, note: string })

/** One priced provider call: the endpoint and what it is billed by. */
export interface PaidCall {
  /** fal app id, Replicate slug, or a Generate-a-video model id — the key into the cards. */
  endpoint: string
  /** The resolution or quality tier sent, where the card prices by it ('1K', '720p'…), or null. */
  tier?: string | null
  /** Tokens sent and answered (per_token cards): the ceiling for a hold, the reported usage for a charge. */
  inputTokens?: number; outputTokens?: number
  /** Seconds of the sound or video sent, and of what comes back. */
  inputSeconds?: number; outputSeconds?: number
  /** Characters of text sent (per_thousand_chars cards). */
  chars?: number
  /** Pixels of the picture sent in and of the picture that comes back (the edit cards). */
  inputPixels?: number | null; outputPixels?: number | null
  /** Whether a clip comes back with sound (clip and video cards); absent, the dearer of the two. */
  audio?: boolean
  /** Every other call the node may make instead of this one, covered at cost (the one-call rule). */
  fallbacks?: PaidCall[]
}

/** The paid cards. Filled by each R3 task (R3.3–R3.17); empty until then. */
export const PAID_RATES: Record<string, PaidRate> = {}

const own = <T>(o: Record<string, T>, k: string): T | undefined =>
  (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined)

/** Round away binary float noise (a tenth of a micro-dollar), as editRates.ts does. */
const tidy = (usd: number) => Math.round(usd * 1e8) / 1e8

/** A count a unit needs: a finite number ≥ 0, else undefined (the call can't be priced). */
const count = (n: number | undefined): number | undefined => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined)

/** Dollars one paid card charges for this call, or null when the call lacks what the unit needs. */
function paidCardUsd(rate: PaidRate, call: PaidCall): number | null {
  switch (rate.unit) {
    case 'per_call':
    case 'gpu_ceiling':
      return rate.usd
    case 'per_token': {
      const i = count(call.inputTokens)
      const o = count(call.outputTokens)
      return i === undefined || o === undefined ? null : tidy(i * rate.inputPerMillion / 1e6 + o * rate.outputPerMillion / 1e6)
    }
    case 'per_input_second': {
      const s = count(call.inputSeconds)
      return s === undefined ? null : tidy(rate.perSecond * Math.max(rate.minSeconds ?? 0, s))
    }
    case 'per_output_second': {
      const s = count(call.outputSeconds)
      return s === undefined ? null : tidy(rate.perSecond * s)
    }
    case 'per_thousand_chars': {
      const c = count(call.chars)
      return c === undefined ? null : tidy(rate.perThousand * c / 1000)
    }
  }
}

/**
 * Dollars the service charges for this one call (its fallbacks aside): its
 * paid card, else the card that prices the endpoint already (edit, clip or
 * video model). Null when no card prices it.
 */
function ownUsd(call: PaidCall, rates: Readonly<Record<string, PaidRate>>): number | null {
  const paid = own(rates, call.endpoint)
  if (paid) return paidCardUsd(paid, call)
  if (editRate(call.endpoint)) {
    return editUsd({ endpoint: call.endpoint, tier: call.tier ?? null, inputPixels: call.inputPixels ?? null, outputPixels: call.outputPixels ?? null })
  }
  const seconds = count(call.outputSeconds)
  const audios = call.audio === undefined ? [false, true] : [call.audio]
  if (clipRate(call.endpoint)) {
    if (seconds === undefined) return null
    return Math.max(...audios.map(audio => clipUsd(call.endpoint, { seconds, resolution: call.tier ?? null, audio })!))
  }
  if (videoRate(call.endpoint)) {
    if (seconds === undefined) return null
    const inputVideoSeconds = count(call.inputSeconds) ?? 0
    const each = audios.map(audio => videoPriceUsd(call.endpoint, { seconds, resolution: call.tier ?? null, audio, inputVideoSeconds }))
    return each.some(u => u == null) ? null : Math.max(...(each as number[]))
  }
  return null
}

/**
 * The other card that prices an endpoint already (edit, clip or video
 * model), or null. A paid card must never duplicate one (each rate lives in
 * one place): a test holds PAID_RATES to that.
 */
export function otherCardFor(endpoint: string): 'edit' | 'clip' | 'video' | null {
  if (editRate(endpoint)) return 'edit'
  if (clipRate(endpoint)) return 'clip'
  if (videoRate(endpoint)) return 'video'
  return null
}

/**
 * The price basis of one call, in dollars: the first service's price (which
 * carries the markup), or each fallback covered at cost, whichever is higher
 * (editRates.ts editMaxUsd's rule). Its credits are `callCredits({ usd })`.
 * Null when the call, or any fallback, has no card or lacks what its card
 * needs. `rates`: the paid cards (the tests pass their own).
 */
export function paidCallUsd(call: PaidCall, rates: Readonly<Record<string, PaidRate>> = PAID_RATES): number | null {
  const first = ownUsd(call, rates)
  if (first == null) return null
  let usd = first
  for (const one of call.fallbacks ?? []) {
    const p = ownUsd(one, rates)
    if (p == null) return null
    usd = Math.max(usd, usdChargedAtCost(p))
  }
  return usd
}
