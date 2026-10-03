import { defineConfig, devices } from '@playwright/test'

// Tests assume the dev server is already running (the only server; no
// ComfyUI or Python since step 4):
//   pnpm --dir frontend dev

export default defineConfig({
  testDir: './tests',
  testIgnore: ['**/unit/**'],
  fullyParallel: false,         // shared backend state — keep serial
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? 'line' : 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    // PW_BASE_URL lets worktree/CI runs target their own dev server.
    baseURL: process.env.PW_BASE_URL ?? 'http://127.0.0.1:3002',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    viewport: { width: 1600, height: 1000 },
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chromium',
        launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
      },
    },
    {
      // Safari-engine verification for the WebGL/WebCodecs engine ONLY.
      // The golden gate is excluded: its tolerances are calibrated on
      // Chromium's GPU stack (see timeline-golden.spec.ts) — per-engine
      // recalibration is deliberately deferred to M3 dogfooding.
      name: 'webkit-engine',
      use: { ...devices['Desktop Safari'] },
      testMatch: [
        '**/gl-blend-conformance.spec.ts',
        '**/video-source.spec.ts',
        '**/engine-playback.spec.ts',
      ],
    },
  ],
})
