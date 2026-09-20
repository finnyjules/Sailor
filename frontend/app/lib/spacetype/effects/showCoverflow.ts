import { makeShowcaseEffect } from './showcase'
import { coverflowLayout } from '../layouts/coverflow'

/** Cover flow — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showCoverflowEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showcoverflow', layout: coverflowLayout })
