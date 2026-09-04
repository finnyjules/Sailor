/**
 * GET /api/scene3d/google-font-file?family=<name>&weight=<int>
 *
 * Thin re-export of the shared Google Fonts cut route at
 * server/api/fonts/google-file.get.ts (built for Vector Type's "any font"
 * program). The 3D Studio now inherits that route's catalog validation,
 * checked before any upstream fetch: `family` must exist in the server's
 * Google Fonts catalog (unknown → 400), while an unshipped `weight` SNAPS to
 * the family's nearest shipped one rather than failing — which is what keeps
 * this studio's hardcoded weight defaults working on a family like Archivo
 * Black, that ships only 400. See googleFontFile.ts for the fetch/cache details.
 */
export { default } from '../fonts/google-file.get'
