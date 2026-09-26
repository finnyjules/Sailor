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
 * `/view` URL (ComfyUI's, or the app's own, which the editor and Python send
 * for a wired picture). Hosted, loopback is refused like the rest.
 */
import { BlockList, isIP } from 'node:net'
import { lookup as dnsLookup } from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import type { LookupFunction } from 'node:net'
import type { ImageFetcher } from './inlineImages'

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
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32],
] as const) BLOCKED.addSubnet(net, bits, 'ipv6')
const LOOPBACK = new BlockList()
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4')
LOOPBACK.addAddress('::1', 'ipv6')

/** An IPv4 address mapped into IPv6 (::ffff:a.b.c.d), as its IPv4 address. */
function unmapped(address: string): { address: string; family: 'ipv4' | 'ipv6' } {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  if (m) return { address: m[1]!, family: 'ipv4' }
  return { address, family: isIP(address) === 6 ? 'ipv6' : 'ipv4' }
}

/** Whether an address may be fetched; `loopbackOk`: a loopback address is let through (local /view). */
export function addressAllowed(address: string, loopbackOk = false): boolean {
  const a = unmapped(address)
  if (loopbackOk && LOOPBACK.check(a.address, a.family)) return true
  return !BLOCKED.check(a.address, a.family)
}

export interface SafeFetchOptions {
  /** Hosted (a shared server): no loopback exception. */
  hosted: boolean
  timeoutMs?: number
  maxBytes?: number
}

/** The URL's host without IPv6 brackets. */
const hostOf = (u: URL) => u.hostname.replace(/^\[|\]$/g, '')

/** One request, its answer's status, headers and body (at most `maxBytes`). */
function requestOnce(u: URL, loopbackOk: boolean, o: { signal: AbortSignal; maxBytes: number }): Promise<{ status: number; location?: string; contentType: string; data: ArrayBuffer }> {
  const host = hostOf(u)
  if (isIP(host) && !addressAllowed(host, loopbackOk)) return Promise.reject(new FetchRefused(FETCH_REFUSED))
  const checkedLookup: LookupFunction = (hostname, options, cb) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return (cb as (e: Error) => void)(err)
      const list = addresses as unknown as { address: string; family: number }[]
      if (!list.length || list.some(a => !addressAllowed(a.address, loopbackOk))) return (cb as (e: Error) => void)(new FetchRefused(FETCH_REFUSED))
      if ((options as { all?: boolean }).all) return (cb as unknown as (e: null, a: typeof list) => void)(null, list)
      return (cb as (e: null, a: string, f: number) => void)(null, list[0]!.address, list[0]!.family)
    })
  }
  const lib = u.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const req = lib.request(u, { method: 'GET', lookup: checkedLookup, signal: o.signal, headers: { 'User-Agent': 'Sailor/1.0', Accept: 'image/*' } }, (res) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400) {
        res.resume()
        resolve({ status, location: res.headers.location, contentType: '', data: new ArrayBuffer(0) })
        return
      }
      const declared = Number(res.headers['content-length'])
      if (Number.isFinite(declared) && declared > o.maxBytes) {
        res.destroy()
        reject(new FetchRefused(FETCH_TOO_LARGE))
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (c: Buffer) => {
        size += c.length
        if (size > o.maxBytes) {
          res.destroy()
          reject(new FetchRefused(FETCH_TOO_LARGE))
          return
        }
        chunks.push(c)
      })
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        resolve({
          status,
          contentType: String(res.headers['content-type'] || 'image/png'),
          data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
        })
      })
      res.on('error', reject)
    })
    req.on('error', (e) => {
      if (o.signal.aborted) reject(new FetchRefused(FETCH_TIMEOUT))
      else reject(e instanceof FetchRefused ? e : (e as Error & { cause?: unknown }).cause instanceof FetchRefused ? (e as Error & { cause: FetchRefused }).cause : e)
    })
    req.end()
  })
}

/** The render's image fetcher under the policy above. */
export function safeImageFetcher(opts: SafeFetchOptions): ImageFetcher {
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS
  const maxBytes = opts.maxBytes ?? FETCH_MAX_BYTES
  return async (url) => {
    const signal = AbortSignal.timeout(timeoutMs)
    let u: URL
    try { u = new URL(url) }
    catch { throw new Error(`image fetch failed (bad address): ${url.slice(0, 100)}`) }
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new FetchRefused(FETCH_REFUSED)
      const loopbackOk = !opts.hosted && u.pathname === '/view'
      const r = await requestOnce(u, loopbackOk, { signal, maxBytes }).catch((e: unknown) => {
        if (signal.aborted && !(e instanceof FetchRefused)) throw new FetchRefused(FETCH_TIMEOUT)
        throw e
      })
      if (r.status >= 300 && r.status < 400 && r.location) {
        u = new URL(r.location, u)
        continue
      }
      if (r.status < 200 || r.status >= 300) throw new Error(`image fetch failed (${r.status}): ${url.slice(0, 100)}`)
      return { data: r.data, contentType: r.contentType }
    }
    throw new Error(`image fetch failed (too many redirects): ${url.slice(0, 100)}`)
  }
}
