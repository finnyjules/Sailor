/**
 * The one image fetcher a layout render uses (R1.6 fix round 1): the
 * /api/render-template route and the runner's Smart Layout card. A layout
 * names its own image URLs, so the server must not become a way into the
 * machine's own network (SSRF):
 *   - http and https only;
 *   - every address the host resolves to is checked, and the connection is
 *     made to the checked address (the check runs inside the socket's own
 *     lookup, so a second DNS answer can't swap it); an IP written in the URL
 *     is checked as it is;
 *   - loopback, private (10/8, 172.16/12, 192.168/16, 100.64/10),
 *     link-local (169.254/16, fe80::/10), unique-local (fc00::/7),
 *     unspecified, multicast and reserved addresses are refused;
 *   - redirects are followed by hand (at most 3), each one checked again;
 *   - 20 seconds in all, and at most 30 MB.
 * Locally (not hosted) one exception keeps the canvas working: a loopback
 * `/view` URL on the ports the caller names (the route: the port its own
 * request came in on and the app's configured port, which the editor's
 * absolute /view URLs use; never the Host header's). Step 4, C5: the engine's
 * own port is no longer one (no saved project names it). Step 3, R10.8: such a
 * URL is never fetched — Sailor reads the file it names off disk, by name,
 * exactly as GET /view resolves it (server/native/view.ts), under the same
 * byte cap and budget; no connection is made to any port. Hosted, loopback
 * is refused like the rest.
 *
 * Fix round 2: no connection is ever reused (`agent: false`), so every
 * request resolves and checks its address, and the connected socket's
 * address is checked once more; the IPv6 forms that carry an IPv4 address
 * (::/96, ::ffff:0:0:0/96, 6to4, Teredo, NAT64) and site-local are refused.
 * Round 3: also 2001:20::/28 (ORCHIDv2), 3fff::/20 and 5f00::/16 (reserved);
 * the caller's signal ends a fetch, and a render's byte budget is taken from
 * as bytes arrive.
 * Round 4: `localhost` connects over IPv4 first (its addresses still all checked).
 *
 * The policy itself is `safeFetch` (step 3, R3.1 fix round 1): the runner's
 * provider-answer downloads take it too (server/runner/answerDownload.ts),
 * with their own words, byte cap and time limit, and no loopback exception.
 */
import { BlockList, isIP } from 'node:net'
import { lookup as dnsLookup } from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import type { LookupFunction } from 'node:net'
import type { ByteBudget, ImageFetcher } from './inlineImages'
import { readViewFile, viewQueryOf } from '../native/viewRead'
import { LAYOUT_IMAGES_TOO_LARGE } from '../../shared/template-grid/limits'

export const FETCH_REFUSED = 'An image in this layout points at a private network address, which is not allowed'
export const FETCH_TOO_LARGE = 'An image in this layout is larger than 30 MB'
export const FETCH_TIMEOUT = 'An image in this layout took longer than 20 seconds to download'
export const FETCH_MAX_BYTES = 30 * 1024 * 1024
export const FETCH_TIMEOUT_MS = 20_000
const MAX_REDIRECTS = 3

/** The fetch was refused by policy (not a network failure). */
export class FetchRefused extends Error {}

const BLOCKED = new BlockList()
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) BLOCKED.addSubnet(net, bits, 'ipv4')
for (const [net, bits] of [
  ['::', 96], ['::ffff:0:0:0', 96], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
  ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['2002::', 16],
  ['2001:20::', 28], ['3fff::', 20], ['5f00::', 16],
] as const) BLOCKED.addSubnet(net, bits, 'ipv6')
// IPv4-mapped addresses (::ffff:a.b.c.d) are matched by the IPv4 rules above
// (BlockList checks a mapped address against them); a ::ffff:0:0/96 rule
// would match every IPv4 address.
const LOOPBACK = new BlockList()
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4')
LOOPBACK.addAddress('::1', 'ipv6')

/** An IPv4 address mapped into IPv6 (::ffff:a.b.c.d), as its IPv4 address. */
function unmapped(address: string): { address: string; family: 'ipv4' | 'ipv6' } {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  if (m) return { address: m[1]!, family: 'ipv4' }
  return { address, family: isIP(address) === 6 ? 'ipv6' : 'ipv4' }
}

/** Whether an address may be fetched; `loopbackOk`: a loopback address is let through. */
export function addressAllowed(address: string, loopbackOk = false): boolean {
  const a = unmapped(address)
  if (loopbackOk && LOOPBACK.check(a.address, a.family)) return true
  return !BLOCKED.check(a.address, a.family)
}

/** A host that is this machine: `localhost`, or a loopback address written as one. */
function isLoopbackHost(host: string): boolean {
  if (/^localhost\.?$/i.test(host)) return true
  if (!isIP(host)) return false
  const a = unmapped(host)
  return LOOPBACK.check(a.address, a.family)
}

/**
 * A loopback `/view` URL, read off disk by name (R10.8): the file GET /view
 * would serve, or the status it would answer. The caller's cap, budget and
 * signal apply as to a download.
 */
async function readLoopbackView(u: URL, o: { maxBytes: number; budget?: ByteBudget; words: SafeFetchWords; stopped: () => boolean }): Promise<{ status: number; contentType: string | null; data: ArrayBuffer }> {
  const r = await readViewFile(viewQueryOf(u.searchParams), o.maxBytes)
  if (o.stopped()) throw new Error('Stopped')
  if (r.kind === 'tooLarge') throw new FetchRefused(o.words.tooLarge)
  if (r.kind === 'status') return { status: r.status, contentType: null, data: new ArrayBuffer(0) }
  if (o.budget) {
    if (r.data.byteLength > o.budget.left) throw new FetchRefused(LAYOUT_IMAGES_TOO_LARGE)
    o.budget.left -= r.data.byteLength
  }
  return { status: 200, contentType: r.contentType, data: r.data.buffer.slice(r.data.byteOffset, r.data.byteOffset + r.data.byteLength) as ArrayBuffer }
}

/**
 * The loopback ports whose `/view` the route may fetch locally, besides
 * ComfyUI's configured one (fix rounds 3 and 4): the port its request really
 * came in on (the socket's; none over the Unix socket `nuxi dev` listens on)
 * and the app's configured port (NUXT_PORT, NITRO_PORT, PORT). Round 4: the
 * Host header is no longer read — a caller could name any loopback port in it.
 * Only local mode reads these (safeImageFetcher ignores them hosted).
 */
export function localViewPorts(o: { localPort?: unknown; env?: NodeJS.ProcessEnv } = {}): number[] {
  const env = o.env ?? process.env
  const out = new Set<number>()
  const add = (v: unknown) => {
    const n = Number(v)
    if (Number.isInteger(n) && n > 0 && n < 65536) out.add(n)
  }
  if (typeof o.localPort === 'number') add(o.localPort)
  for (const k of ['NUXT_PORT', 'NITRO_PORT', 'PORT']) if (env[k]) add(env[k])
  return [...out]
}

export interface SafeFetchOptions {
  /** Hosted (a shared server): no loopback exception. */
  hosted: boolean
  /** Locally, loopback ports whose `/view` is read besides the engine's (the route's own). */
  viewPorts?: readonly number[]
  timeoutMs?: number
  maxBytes?: number
}

/** The URL's host without IPv6 brackets. */
const hostOf = (u: URL) => u.hostname.replace(/^\[|\]$/g, '')

/** What a refusal says, for the caller's own kind of file. */
export interface SafeFetchWords { refused: string; tooLarge: string; timeout: string }

const LAYOUT_WORDS: SafeFetchWords = { refused: FETCH_REFUSED, tooLarge: FETCH_TOO_LARGE, timeout: FETCH_TIMEOUT }

/** One request, its answer's status, headers and body (at most `maxBytes`). */
function requestOnce(u: URL, o: { signal: AbortSignal; maxBytes: number; budget?: ByteBudget; stopped: () => boolean; words: SafeFetchWords; accept: string }): Promise<{ status: number; location?: string; contentType: string | null; data: ArrayBuffer }> {
  const { words } = o
  const host = hostOf(u)
  if (isIP(host) && !addressAllowed(host)) return Promise.reject(new FetchRefused(words.refused))
  const checkedLookup: LookupFunction = (hostname, options, cb) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return (cb as (e: Error) => void)(err)
      const list = addresses as unknown as { address: string; family: number }[]
      if (!list.length || list.some(a => !addressAllowed(a.address))) return (cb as (e: Error) => void)(new FetchRefused(words.refused))
      // `localhost` over IPv4 first (fix round 4): on this kind of machine
      // [::1] can be another listener on the same port (a 426 answer).
      if (/^localhost\.?$/i.test(hostname)) list.sort((a, b) => (a.family === 4 ? 0 : 1) - (b.family === 4 ? 0 : 1))
      if ((options as { all?: boolean }).all) return (cb as unknown as (e: null, a: typeof list) => void)(null, list)
      return (cb as (e: null, a: string, f: number) => void)(null, list[0]!.address, list[0]!.family)
    })
  }
  const lib = u.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    // agent: false — a pooled keep-alive socket would skip the lookup, and so the check.
    const req = lib.request(u, { method: 'GET', agent: false, lookup: checkedLookup, signal: o.signal, headers: { 'User-Agent': 'Sailor/1.0', Accept: o.accept } }, (res) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400) {
        res.resume()
        resolve({ status, location: res.headers.location, contentType: null, data: new ArrayBuffer(0) })
        return
      }
      const declared = Number(res.headers['content-length'])
      if (Number.isFinite(declared) && declared > o.maxBytes) {
        res.destroy()
        reject(new FetchRefused(words.tooLarge))
        return
      }
      if (o.budget && Number.isFinite(declared) && declared > o.budget.left) {
        res.destroy()
        reject(new FetchRefused(LAYOUT_IMAGES_TOO_LARGE))
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (c: Buffer) => {
        size += c.length
        if (size > o.maxBytes) {
          res.destroy()
          reject(new FetchRefused(words.tooLarge))
          return
        }
        // The render's total, shared by its fetches (fix round 3).
        if (o.budget) {
          o.budget.left -= c.length
          if (o.budget.left < 0) {
            res.destroy()
            reject(new FetchRefused(LAYOUT_IMAGES_TOO_LARGE))
            return
          }
        }
        chunks.push(c)
      })
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        resolve({
          status,
          contentType: res.headers['content-type'] ? String(res.headers['content-type']) : null,
          data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
        })
      })
      res.on('error', reject)
    })
    // The connected socket's own address, checked once more.
    req.on('socket', (sock) => {
      sock.once('connect', () => {
        const at = sock.remoteAddress
        if (at && !addressAllowed(at)) req.destroy(new FetchRefused(words.refused))
      })
    })
    req.on('error', (e) => {
      if (o.stopped()) reject(new Error('Stopped'))
      else if (o.signal.aborted) reject(new FetchRefused(words.timeout))
      else reject(e instanceof FetchRefused ? e : (e as Error & { cause?: unknown }).cause instanceof FetchRefused ? (e as Error & { cause: FetchRefused }).cause : e)
    })
    req.end()
  })
}

/** How one caller fetches under the policy above. */
export interface SafeFetchPolicy {
  /** Hosted (a shared server): no loopback exception. */
  hosted: boolean
  /** Locally, a loopback `/view` on the engine's port (or these) is read off disk; false for callers that never need it. */
  loopbackView: boolean
  viewPorts?: readonly number[]
  timeoutMs: number
  maxBytes: number
  words: SafeFetchWords
  /** The Accept header. */
  accept: string
}

/** A fetch whose redirects went past the limit. */
export class TooManyRedirects extends Error {}

/**
 * The policy: http(s) only, every hop's address checked (and pinned), at
 * most 3 redirects, `timeoutMs` in all, `maxBytes`, the caller's signal ends
 * it ('Stopped'). The final answer's status is the caller's to judge.
 */
export async function safeFetch(url: string, p: SafeFetchPolicy, o: { signal?: AbortSignal; budget?: ByteBudget } = {}): Promise<{ status: number; contentType: string | null; data: ArrayBuffer }> {
  const timeout = AbortSignal.timeout(p.timeoutMs)
  // The caller's signal (a render's or a run's Stop, a disconnect, a deadline) ends the fetch too.
  const signal = o.signal ? AbortSignal.any([timeout, o.signal]) : timeout
  const stopped = () => !!o.signal?.aborted && !timeout.aborted
  if (stopped()) throw new Error('Stopped')
  let u = new URL(url)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new FetchRefused(p.words.refused)
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80))
    const localView = p.loopbackView && !p.hosted && u.pathname === '/view' && !!p.viewPorts?.includes(port)
    // R10.8: a loopback /view is read by name, never fetched over a port.
    if (localView && isLoopbackHost(hostOf(u))) return readLoopbackView(u, { maxBytes: p.maxBytes, budget: o.budget, words: p.words, stopped })
    const r = await requestOnce(u, { signal, maxBytes: p.maxBytes, budget: o.budget, stopped, words: p.words, accept: p.accept }).catch((e: unknown) => {
      if (stopped()) throw new Error('Stopped')
      if (signal.aborted && !(e instanceof FetchRefused)) throw new FetchRefused(p.words.timeout)
      throw e
    })
    if (r.status >= 300 && r.status < 400 && r.location) {
      u = new URL(r.location, u)
      continue
    }
    return { status: r.status, contentType: r.contentType, data: r.data }
  }
  throw new TooManyRedirects('too many redirects')
}

/** The render's image fetcher under the policy above. */
export function safeImageFetcher(opts: SafeFetchOptions): ImageFetcher {
  const policy: SafeFetchPolicy = {
    hosted: opts.hosted, loopbackView: true, viewPorts: opts.viewPorts,
    timeoutMs: opts.timeoutMs ?? FETCH_TIMEOUT_MS, maxBytes: opts.maxBytes ?? FETCH_MAX_BYTES,
    words: LAYOUT_WORDS, accept: 'image/*',
  }
  return async (url, o = {}) => {
    if (o.signal?.aborted) throw new Error('Stopped')
    try { new URL(url) }
    catch { throw new Error(`image fetch failed (bad address): ${url.slice(0, 100)}`) }
    let r: Awaited<ReturnType<typeof safeFetch>>
    try { r = await safeFetch(url, policy, o) }
    catch (e) {
      if (e instanceof TooManyRedirects) throw new Error(`image fetch failed (too many redirects): ${url.slice(0, 100)}`)
      throw e
    }
    if (r.status < 200 || r.status >= 300) throw new Error(`image fetch failed (${r.status}): ${url.slice(0, 100)}`)
    return { data: r.data, contentType: r.contentType ?? 'image/png' }
  }
}
