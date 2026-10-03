/**
 * Step 3, R10.8 guard: the server stops calling the engine's port.
 *
 *   1. No server file names the engine's address (`127.0.0.1:8188`,
 *      `localhost:8188`, `[::1]:8188`) or `SAILOR_COMFY_ORIGIN`, except the
 *      one place that defines it (server/native/engineHealth.ts) and the
 *      local-only proxy (server/middleware/comfyui-proxy.ts).
 *   2. The engine's port reaches a file only through engineHealth.ts, and only
 *      the files listed here import it — each a local-only engine path (decision
 *      4) or one R10.9 removes for hosted. A new importer must be added here,
 *      with its reason, on purpose.
 *   3. The routes R10.8 moved off the engine never ask it for anything but a
 *      local-only run (the history routes, behind engineHealth).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const FRONTEND = join(__dirname, '..', '..')
const SERVER = join(FRONTEND, 'server')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.(ts|js|mjs|cjs)$/.test(name)) out.push(p)
  }
  return out
}

const files = walk(SERVER).map(p => ({ rel: relative(FRONTEND, p).split('\\').join('/'), text: readFileSync(p, 'utf8') }))

const NAMES_ENGINE = /(127\.0\.0\.1|localhost|\[::1\]):8188|SAILOR_COMFY_ORIGIN/

/** May name the engine's address. */
const ADDRESS_OK = new Set([
  'server/native/engineHealth.ts', // defines ENGINE_MAIN_PORT / ENGINE_ORIGIN, its health probe
  'server/middleware/comfyui-proxy.ts', // the local-only proxy
])

/** May import the engine's port or origin, and why. */
const PORT_IMPORTERS: Record<string, string> = {
  'server/middleware/comfyui-proxy.ts': 'the local-only proxy (/prompt, /ws for decision 4’s classes)',
  // R10.8 fix round 1 (M1): reachable from hosted through dispatchNative / handleHostedObjectInfo.
  'server/native/media.ts': 'HOSTED reaches the engine here (forwardToEngine while it is up) until R10.9 — R10.9 must remove it for hosted',
  'server/native/objectInfo.ts': 'HOSTED reaches the engine here (fromEngine while it is up) until R10.9 — R10.9 must remove it for hosted',
  'server/routes/history/index.get.ts': 'local only: the engine’s local-only runs, while it is up',
  'server/routes/history/[promptId].get.ts': 'local only: one local-only run, while it is up',
  'server/api/admin/console.get.ts': 'a link to the engine, shown only while it is up (never fetched)',
  'server/templates/safeFetch.ts': 'the port number Python’s /view URLs carry; the file is read off disk, never fetched',
  'server/utils/engineGate.ts': 'hosted engine paths — R10.9 removes them',
  'server/utils/meterGraphRun.ts': 'hosted engine-run metering — R10.9 removes it',
}

describe('the server stops calling the engine’s port (R10.8)', () => {
  it('reads the server tree', () => {
    expect(files.length).toBeGreaterThan(100)
    expect(files.some(f => f.rel === 'server/native/engineHealth.ts')).toBe(true)
  })

  it('no server file outside engineHealth and the local-only proxy names the engine’s address or SAILOR_COMFY_ORIGIN', () => {
    const offenders = files.filter(f => !ADDRESS_OK.has(f.rel) && NAMES_ENGINE.test(f.text)).map(f => f.rel)
    expect(offenders).toEqual([])
  })

  it('no server file writes the port as a literal next to an address', () => {
    const offenders = files
      .filter(f => f.rel !== 'server/native/engineHealth.ts')
      .filter(f => /['"`]https?:\/\/[^'"`]*:8188/.test(f.text))
      .map(f => f.rel)
    expect(offenders).toEqual([])
  })

  it('only the listed local-only paths import the engine’s port or origin', () => {
    const importers = files
      .filter(f => f.rel !== 'server/native/engineHealth.ts')
      .filter(f => /import\s*\{[^}]*\b(ENGINE_MAIN_PORT|ENGINE_ORIGIN)\b[^}]*\}\s*from\s*['"][^'"]*engineHealth['"]/.test(f.text))
      .map(f => f.rel)
      .sort()
    expect(importers).toEqual(Object.keys(PORT_IMPORTERS).sort())
  })

  it('only the listed files forward to the engine through media.ts (hosted-reachable until R10.9)', () => {
    const FORWARDERS: Record<string, string> = {
      'server/native/smallRoutes.ts': 'HOSTED reaches the engine here (font subset forward while it is up) until R10.9 — R10.9 must remove it for hosted',
    }
    const importers = files
      .filter(f => f.rel !== 'server/native/media.ts')
      .filter(f => /import\s*\{[^}]*\bforwardToEngine\b[^}]*\}\s*from/.test(f.text))
      .map(f => f.rel)
      .sort()
    expect(importers).toEqual(Object.keys(FORWARDERS).sort())
  })

  it('the routes R10.8 moved off the engine never use its port', () => {
    for (const rel of ['server/api/image-fetch.post.ts', 'server/api/scene3d/gen-3d.post.ts', 'server/native/viewRead.ts', 'server/native/viewGate.ts', 'server/native/history.ts']) {
      const f = files.find(x => x.rel === rel)
      expect(f, rel).toBeTruthy()
      expect(f!.text, rel).not.toMatch(/ENGINE_MAIN_PORT|ENGINE_ORIGIN|8188/)
    }
    // safeFetch's loopback /view is read off disk, never requested.
    const safe = files.find(f => f.rel === 'server/templates/safeFetch.ts')!.text
    expect(safe).toMatch(/readLoopbackView\(u,/)
    expect(safe).not.toMatch(/requestOnce\(u,\s*(true|loopbackOk)/)
  })

  it('the history routes ask the engine only behind its health check', () => {
    for (const rel of ['server/routes/history/index.get.ts', 'server/routes/history/[promptId].get.ts']) {
      const text = files.find(f => f.rel === rel)!.text
      const fetchAt = text.indexOf('ENGINE_MAIN_PORT}/history')
      const gateAt = text.lastIndexOf("engineHealth() === 'up'", fetchAt)
      expect(fetchAt, rel).toBeGreaterThan(0)
      expect(gateAt, rel).toBeGreaterThan(0)
      // Hosted returns before the engine is ever asked.
      expect(text.indexOf("deployMode() === 'hosted'"), rel).toBeLessThan(gateAt)
    }
  })
})
