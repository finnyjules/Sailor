import { makeShowcaseEffect } from './showcase'
import { filmstripLayout } from '../layouts/filmstrip'

/** Film strip — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showFilmstripEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showfilmstrip', layout: filmstripLayout })
