import { makeShowcaseEffect } from './showcase'
import { turnstileLayout } from '../layouts/turnstile'

/** Revolving door — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showTurnstileEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showturnstile', layout: turnstileLayout })
