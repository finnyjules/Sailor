/**
 * SAM 3's request builder moved to #shared/runner/samInput (step 3, R7.4), so
 * the runner's Mask extractor sends the same call as /api/inpaint/segment.
 * Re-exported here for the callers that import it from this path.
 */
export { buildSamInput, type SamRequestBody, type SamRequestBox, type SamRequestPoint } from '../../shared/runner/samInput'
