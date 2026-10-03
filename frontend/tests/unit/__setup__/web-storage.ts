// Node 25+ ships its own Web Storage: `localStorage` / `sessionStorage` are
// getters on globalThis that return undefined (with a warning) unless node runs
// with `--localstorage-file`. Vitest's happy-dom environment won't overwrite a
// global that already exists, so DOM specs see undefined instead of a Storage.
// Give DOM specs a fresh happy-dom Storage per name. No-op on Node 22 (no
// built-in getter, happy-dom's storage is already there) and in the plain
// `node` environment (no document).
const g = globalThis as Record<string, unknown>
if (typeof g.document !== 'undefined' && typeof g.Storage === 'function') {
  const StorageCtor = g.Storage as new () => Storage
  for (const key of ['localStorage', 'sessionStorage'] as const) {
    if (g[key] == null) {
      Object.defineProperty(globalThis, key, { value: new StorageCtor(), configurable: true, writable: true, enumerable: true })
    }
  }
}
