/**
 * Operator console data — the vendor accounts and surfaces Sailor is run from.
 * Local mode only: in hosted mode this 404s (not 403 — the page should not
 * even be discoverable) until a real admin role exists (roadmap Stage 2's
 * admin surface). Links/IDs are operator-facing, not secrets; keys stay in
 * .env.hosted and vendor dashboards.
 */
import { isHosted } from '~~/server/utils/deployMode'
import { ENGINE_MAIN_PORT, engineHealth } from '~~/server/native/engineHealth'

export interface ConsoleLink { label: string; href: string }
export interface ConsoleCard {
  name: string
  status: 'live' | 'deciding' | { stage: number }
  blurb: string
  primary?: ConsoleLink
  links?: ConsoleLink[]
  meta?: string[]
}
export interface ConsoleSection { title: string; cards: ConsoleCard[] }

const NEON_PROJECT = 'raspy-night-08677137'
const CLERK_APP = 'app_3Hs5ZcD3mmK2Im7TXgVxuDAO0Sb'
const CLERK_INSTANCE = 'ins_3Hs5Zb29wlvttLPE8v2NyPOkJIJ'

const SECTIONS: ConsoleSection[] = [
  {
    title: 'Product infrastructure',
    cards: [
      {
        name: 'Neon',
        status: 'live',
        blurb: 'The money database — users, wallets, and the double-entry ledger. Point-in-time recovery is the backup story.',
        primary: { label: 'Open Neon console', href: `https://console.neon.tech/app/projects/${NEON_PROJECT}` },
        links: [
          { label: 'Branches & tables', href: `https://console.neon.tech/app/projects/${NEON_PROJECT}/branches` },
          { label: 'Settings', href: `https://console.neon.tech/app/projects/${NEON_PROJECT}/settings` },
        ],
        meta: [`project ${NEON_PROJECT} · aws-us-west-2 · PG 18`, 'ledger test rows live under users starting neontest-'],
      },
      {
        name: 'Clerk',
        status: 'live',
        blurb: 'Who your users are — sign-in methods, user list, sessions, and the webhooks that will sync users into Neon. Dev instance only so far.',
        primary: { label: 'Open Clerk dashboard', href: `https://dashboard.clerk.com/apps/${CLERK_APP}/instances/${CLERK_INSTANCE}` },
        links: [{ label: 'All apps', href: 'https://dashboard.clerk.com' }],
        meta: [`app ${CLERK_APP}`, `instance ${CLERK_INSTANCE} (development) · Email + Google`],
      },
    ],
  },
  {
    title: 'Provider spend',
    cards: [
      {
        name: 'Replicate',
        status: 'live',
        blurb: 'Image / video model runs. Check billing when the spend log looks unusual.',
        primary: { label: 'Account & usage', href: 'https://replicate.com/account' },
        links: [{ label: 'Billing', href: 'https://replicate.com/account/billing' }],
      },
      {
        name: 'fal',
        status: 'live',
        blurb: 'The other generation provider — FLUX, Hunyuan3D, and most of the newer model wiring.',
        primary: { label: 'Dashboard', href: 'https://fal.ai/dashboard' },
        links: [{ label: 'Billing', href: 'https://fal.ai/dashboard/billing' }],
      },
      {
        name: 'Anthropic',
        status: 'live',
        blurb: 'Powers the canvas agent, copy assist, and taste-profile writing.',
        primary: { label: 'Console', href: 'https://console.anthropic.com' },
        links: [{ label: 'Usage', href: 'https://console.anthropic.com/settings/usage' }],
      },
      {
        name: 'Local spend log',
        status: 'live',
        blurb: 'Every Replicate / fal call your own use makes, logged for the pricing decision. A file, not a link.',
        meta: ['frontend/.data/spend-events.jsonl'],
      },
    ],
  },
  {
    title: 'Code & deploy',
    cards: [
      {
        name: 'GitHub',
        status: 'live',
        blurb: 'The repository. Main-direct commits; docs of record in docs/.',
        primary: { label: 'finnyjules/sailor', href: 'https://github.com/finnyjules/sailor' },
      },
      {
        name: 'Fly.io',
        status: 'deciding',
        blurb: 'App "vessell" exists from the early deploy experiment, but the hosting provider (Fly vs Railway vs Hetzner) is an open decision — and the region must move cdg → US either way.',
        primary: { label: 'Fly dashboard', href: 'https://fly.io/apps/vessell' },
        meta: ['app vessell · primary_region cdg (stale)'],
      },
      {
        name: 'Build dashboard',
        status: 'live',
        blurb: 'The ⛵ State of the Build artifact — thesis, roadmap acts, surface maturity. Updated on every commit.',
        primary: { label: 'Open dashboard', href: 'https://claude.ai/code/artifact/beb788b5-493b-4597-aa66-ce8a5609df89' },
      },
    ],
  },
  {
    title: 'Coming signups — in roadmap order',
    cards: [
      {
        name: 'Stripe',
        status: { stage: 3 },
        blurb: 'Credit-pack checkout + webhooks. Blocked on the pricing call (pack sizes, credit-to-dollar rate) — not on any code.',
        primary: { label: 'Sign up when ready', href: 'https://dashboard.stripe.com/register' },
      },
      {
        name: 'Cloudflare R2',
        status: { stage: 6 },
        blurb: 'Object storage for per-user inputs and outputs, replacing the local input/ + output/ dirs.',
        primary: { label: 'Cloudflare dash', href: 'https://dash.cloudflare.com' },
      },
      {
        name: 'Sentry',
        status: { stage: 7 },
        blurb: 'Error reporting for hosted users, server + client. Hosted mode only.',
        primary: { label: 'sentry.io', href: 'https://sentry.io' },
      },
      {
        name: 'Analytics',
        status: { stage: 7 },
        blurb: 'Privacy-light product analytics — PostHog or Plausible, undecided.',
        links: [
          { label: 'PostHog', href: 'https://posthog.com' },
          { label: 'Plausible', href: 'https://plausible.io' },
        ],
      },
    ],
  },
]

/**
 * The local engine's card (step 3, R10.8): shown only while the engine is up —
 * it runs only the local-only nodes now, and a link to nothing helps nobody.
 */
export function engineCard(): ConsoleCard {
  return {
    name: 'Local engine',
    status: 'live',
    blurb: 'Runs the local-only nodes on this Mac, while it is on. Always 127.0.0.1, never localhost.',
    primary: { label: 'Open the local engine', href: `http://127.0.0.1:${ENGINE_MAIN_PORT}` },
  }
}

/** The console's sections; the engine's card joins "Code & deploy" when the engine is up. */
export function consoleSections(engineUp: boolean): ConsoleSection[] {
  if (!engineUp) return SECTIONS
  return SECTIONS.map(s => s.title === 'Code & deploy' ? { ...s, cards: [...s.cards, engineCard()] } : s)
}

export default defineEventHandler(async () => {
  if (isHosted())
    throw createError({ statusCode: 404, message: 'Not found' })
  return { sections: consoleSections(await engineHealth() === 'up') }
})
