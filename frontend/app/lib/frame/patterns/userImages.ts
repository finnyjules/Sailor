import type { LocalLayer } from '~/composables/useCompositorLayers'
import { isOwned } from './kit/owned'

/** An image element: a local image, or a wired one (a studio's live output — the engine arranges
 *  it like any image). Owned or not: see `isUserImage` for the user's own. */
export const isImageKind = (l: { kind: string }): boolean => l.kind === 'image' || l.kind === 'wired'

/** A layer the user moved after a layout set it as its own words (Reasons why's "1"): no longer the
 *  layout's piece (a user edit clears `owner`), but not the user's content either (final review
 *  I3) — left out of role inference, content recognition and the Content section. */
export const isFromLayout = (l: { fromLayout?: unknown }): boolean => l.fromLayout != null

/** One of the user's own images: an image or a wired image that no layout owns and that is not
 *  the layout's own piece. What the Content section lists, what the planner places as an extra
 *  image and hides for Not used (rulings D3, D7), and what "Image n" counts. */
export const isUserImage = (l: LocalLayer): boolean =>
  isImageKind(l) && !isOwned(l as { owner?: { by: string } }) && !isFromLayout(l as { fromLayout?: unknown })

/** The user's own images, in document order. */
export const userImages = (layers: readonly LocalLayer[]): LocalLayer[] => layers.filter(isUserImage)

/** An image's place among the user's images, counted from 1 in document order ("Image n");
 *  0 when it is not one of them. */
export const imageNumber = (layers: readonly LocalLayer[], id: string): number =>
  userImages(layers).findIndex(l => l.id === id) + 1

/** An image's own name (trimmed), as the Layers panel shows it — a wired layer's name lives on
 *  the layer since Frame schema 2 (`wiredMigration`), like any layer's — or undefined. */
export const ownImageName = (l: LocalLayer): string | undefined =>
  (l as { name?: string }).name?.trim() || undefined

/** How the Layout tab names an image: its own name, else "Image n" (`imageNumber`). The Content
 *  row and "Not shown" both use it, so one image has one name in both. */
export const imageLabel = (layers: readonly LocalLayer[], l: LocalLayer): string =>
  ownImageName(l) ?? `Image ${imageNumber(layers, l.id)}`
