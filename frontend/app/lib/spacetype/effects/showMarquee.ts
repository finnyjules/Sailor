import { makeShowcaseEffect } from './showcase'
import { marqueeLayout } from '../layouts/marquee'

/** Mosaic marquee — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showMarqueeEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showmarquee', layout: marqueeLayout })
