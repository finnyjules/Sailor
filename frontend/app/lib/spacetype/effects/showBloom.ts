import { makeShowcaseEffect } from './showcase'
import { bloomLayout } from '../layouts/bloom'

/** Orbit bloom — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showBloomEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showbloom', layout: bloomLayout })
