/**
 * Frame light layers, stage 4: which timeline bands are lighting bands. Tiny and import-free, so
 * the full painter (./motion.ts), its `frame-lean` stand-in (lightMotionLean.embed.ts) and the
 * export router (embed/frame/needs.ts) all read the one definition.
 */

/** The light dials a band can drive (`layers.<id>.light.<key>`). Type and Edge are not animated. */
export const LIGHT_MOTION_KEYS = ['height', 'color', 'brightness', 'reach', 'aimX', 'aimY', 'cone'] as const
export type LightMotionKey = typeof LIGHT_MOTION_KEYS[number]

/** The Frame's Darkness band path. */
export const DARKNESS_PATH = 'frame.darkness'

/** A lighting band: a light dial, a layer's Lift, or the Frame's Darkness. */
export const isLightBandPath = (path: string): boolean =>
  /^layers\.[^.]+\.(light\.[a-zA-Z]+|lift)$|^frame\.darkness$/.test(path)
