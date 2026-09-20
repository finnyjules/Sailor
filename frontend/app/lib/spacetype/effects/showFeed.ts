import { makeShowcaseEffect } from './showcase'
import { feedLayout } from '../layouts/feed'

/** Feed scroll — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showFeedEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showfeed', layout: feedLayout })
