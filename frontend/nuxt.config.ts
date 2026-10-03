import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { isHosted } from './server/utils/deployMode'

// img-fx bundles an optional React component alongside its framework-agnostic
// core. We only use the core, so `react` + `react/jsx-runtime` are aliased to a
// no-op stub — React never installs and never ships. See app/lib/imgfx/react-stub.ts.
const imgfxReactStub = fileURLToPath(new URL('./app/lib/imgfx/react-stub.ts', import.meta.url))

export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },

  app: {
    head: {
      title: 'Sailor',
      link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    },
  },

  runtimeConfig: {
    // Server-only. Set via NUXT_REPLICATE_TOKEN env var.
    // Used by /api/cloud-train/* routes; never exposed to the browser.
    replicateToken: '',
    // Server-only fal.ai key. Set via NUXT_FAL_TOKEN (FAL_KEY in frontend/.env
    // still works as a fallback — see server/utils/falStorage.ts).
    falToken: '',
    // Max trainings the queue runner keeps in flight on Replicate at once.
    // Override via NUXT_TRAINING_MAX_CONCURRENCY. Default 2.
    trainingMaxConcurrency: '2',
    // Server-only shared Anthropic key powering all AI-assist routes.
    // Set via NUXT_ANTHROPIC_API_KEY. Users may still paste their own key in
    // Settings → AI as a per-browser override; that one is sent per-request.
    anthropicApiKey: '',
    // Server-only AWS credentials for the character face checker (AWS
    // Rekognition CompareFaces, $0.001/image). NUXT_AWS_REGION /
    // NUXT_AWS_ACCESS_KEY_ID / NUXT_AWS_SECRET_ACCESS_KEY. Empty keys → the
    // SDK's default chain (env AWS_*, profile). Account must have the
    // Organizations AI-services opt-out set (spec: Checks).
    awsRegion: 'us-east-1',
    awsAccessKeyId: '',
    awsSecretAccessKey: '',
    public: {
      // Mirrors server deployMode at build/dev start: hosted iff Clerk keys present
      // (the shared check, so the two can never disagree — R10.10 review L4).
      hostedMode: isHosted(),
      // Sailor runner routing (docs/superpowers/specs/2026-09-22-sailor-runner-and-gate-design.md).
      // Off by default; NUXT_PUBLIC_RUNNER_ENABLED=true turns it on at runtime.
      runnerEnabled: false,
      // Runner families the browser routes to the runner: a comma list, e.g.
      // fal-edit. Empty = none. Works only with runnerEnabled on. Defaults to
      // the server's NUXT_RUNNER_FAMILIES (the authority), so one env var
      // normally drives both; NUXT_PUBLIC_RUNNER_FAMILIES still overrides it.
      // A browser list wider than the server's is refused as not-eligible and
      // the run is refused in plain words (isRunnerDeclined).
      runnerFamilies: process.env.NUXT_RUNNER_FAMILIES ?? '',
      // Client Sentry DSN — present ONLY when NUXT_PUBLIC_SENTRY_DSN is set
      // (hosted). Conditionally spread so local boot carries no sentry key and
      // stays byte-identical; sentry.client.config.ts reads it. See below.
      ...(process.env.NUXT_PUBLIC_SENTRY_DSN
        ? { sentry: { dsn: process.env.NUXT_PUBLIC_SENTRY_DSN } }
        : {}),
    },
  },

  modules: [
    // Clerk loads ONLY in hosted mode (deployMode contract: no Clerk keys in
    // env ⇒ local mode, exactly the pre-accounts behavior). Loading it
    // without keys either 500s every request (keyless disabled) or silently
    // creates a throwaway "keyless" Clerk app with an onboarding popup.
    ...(process.env.NUXT_CLERK_SECRET_KEY ? ['@clerk/nuxt'] : []),
    // Sentry client instrumentation loads ONLY when NUXT_PUBLIC_SENTRY_DSN is
    // set (hosted). Absent env ⇒ module never registered ⇒ no init, no resolve
    // warnings ⇒ local boot byte-identical. Client init lives in
    // sentry.client.config.ts (module convention); server init is our own
    // server/plugins/sentry.ts, so no server config file here (no double-init).
    ...(process.env.NUXT_PUBLIC_SENTRY_DSN ? ['@sentry/nuxt/module'] : []),
    '@nuxtjs/color-mode',
    '@nuxt/fonts',
    // Inline module: strip dev harness routes (pages/dev/**, engine-test,
    // sgtest, …) from production builds so hosted deploys don't ship debug
    // surfaces. `nuxt dev` keeps them all.
    function (_options, nuxt) {
      if (nuxt.options.dev) return
      const DEV_PAGES = /^\/(dev(\/|$)|engine-test|sgtest|streamertest|timeline-harness|gl-conformance)/
      nuxt.hook('pages:extend', (pages) => {
        for (let i = pages.length - 1; i >= 0; i--) {
          if (DEV_PAGES.test(pages[i]!.path)) pages.splice(i, 1)
        }
      })
    },
  ],

  css: [
    '~/assets/css/main.css',
    '~/assets/css/node-surfaces.css',
    '~/assets/css/comfyhub/global.scss',
    '~/assets/css/comfy-partner-icons.css',
  ],

  colorMode: {
    classSuffix: '',
    preference: 'dark',
    fallback: 'dark',
  },

  components: [
    {
      path: '~/components/ui',
      extensions: ['.vue'],
      prefix: 'Ui',
    },
    {
      path: '~/components',
      extensions: ['.vue'],
      ignore: ['ui/**', 'community/**'],
    },
  ],

  devServer: {
    host: '127.0.0.1',
  },

  // Engine-style paths (/object_info, /view, /upload, /sailor/…) are answered by
  // Sailor itself (server/middleware/comfyui-proxy.ts); there is no engine to
  // proxy to (step 4, C5).

  vite: {
    plugins: [tailwindcss()],
    resolve: {
      // Exact-match regex (array form) so the bare `react` alias doesn't also
      // swallow `react/jsx-runtime` as a prefix (→ `<stub>/jsx-runtime`).
      alias: [
        { find: /^react$/, replacement: imgfxReactStub },
        { find: /^react\/jsx-runtime$/, replacement: imgfxReactStub },
      ],
    },
    css: {
      preprocessorOptions: {
        scss: {
          additionalData: `@import "@/assets/css/comfyhub/_variables";\n@import "@/assets/css/comfyhub/_mixins";\n`,
        },
      },
    },
    // Pre-bundle the deps Vite would otherwise discover on first use. Without
    // this, hitting an un-bundled dep mid-session makes Vite re-optimize and
    // force a full page reload — the "click New workflow, nothing happens,
    // then it randomly works a minute later" stall. This list is exactly what
    // Vite's "discovered new dependencies at runtime" warning recommends.
    optimizeDeps: {
      include: [
        '@vue-flow/core',
        '@vue-flow/background',
        '@vue-flow/minimap',
        '@vueuse/core',
        'gsap',
        'jszip',
        'lucide-vue-next',
        'reka-ui',
        '@faker-js/faker',
        'clsx',
        'tailwind-merge',
        'img-fx',
      ],
    },
    // Vite 7 defaults `allowedHosts` to localhost variants only — anything
    // else gets "Upgrade Required". Allow all hosts in dev so headless
    // preview tooling (which sends a non-localhost Host header) can drive
    // the page for debugging.
    server: {
      allowedHosts: true,
      // shader_effects/ lives at the repo root; the post chain imports its .frag
      // files with ?raw so post never depends on the backend catalog endpoint at
      // render time. Scoped to that ONE directory: '..' would grant the dev
      // server read access to the whole repo root (user/, input/, output/,
      // models/, .venv/, .superpowers/), and `allowedHosts: true` above has
      // already dropped the Host-header check that guards against DNS rebinding.
      fs: { allow: ['../shader_effects'] },
    },
  },

  future: {
    compatibilityVersion: 4,
  },
})
