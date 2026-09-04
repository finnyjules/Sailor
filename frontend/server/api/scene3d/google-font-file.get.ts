/**
 * GET /api/scene3d/google-font-file?family=<name>&weight=<int>
 *
 * Thin re-export of the shared, fail-closed Google Fonts cut route at
 * server/api/fonts/google-file.get.ts (built for Vector Type's "any font"
 * program). The 3D Studio now inherits that route's catalog validation:
 * `family` must exist in the server's Google Fonts catalog and `weight`
 * must be one of that family's shipped weights, checked before any
 * upstream fetch. See googleFontFile.ts for the fetch/cache details.
 */
export { default } from '../fonts/google-file.get'
