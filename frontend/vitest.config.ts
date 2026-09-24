import { createRequire } from 'node:module'
import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'

// h3 is a transitive dep pnpm keeps out of frontend/node_modules, so server
// utils that `import ... from 'h3'` don't resolve in unit tests. Alias it to
// the copy nuxt itself resolves.
const require = createRequire(import.meta.url)
const h3Path = require.resolve('h3', { paths: [require.resolve('nuxt/package.json').replace('/package.json', '')] })

// Unit tests for shared timeline logic (types, interpolate, commands) — pure
// TS, no Vue/Nuxt runtime needed. E2E stays in Playwright (tests/*.spec.ts);
// this only picks up tests/unit/**.
export default defineConfig({
  // Compiles .vue SFCs for the handful of specs that mount a component with
  // @vue/test-utils (default `environment: 'node'` below is untouched — those
  // specs opt into a DOM via a `// @vitest-environment happy-dom` docblock).
  plugins: [vue()],
  resolve: {
    alias: {
      'h3': h3Path,
      '~~': fileURLToPath(new URL('.', import.meta.url)),
      '~': fileURLToPath(new URL('./app', import.meta.url)),
      '#shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  test: {
    include: ['tests/unit/**/*.unit.spec.ts'],
    environment: 'node',
    setupFiles: ['tests/unit/__setup__/vue-reactivity.ts', 'tests/unit/__setup__/engine-root-safety-net.ts'],
  },
})
