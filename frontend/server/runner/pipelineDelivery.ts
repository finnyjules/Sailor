/**
 * Pipeline calls that delivered nothing usable (step 3, R3.17 fix round 1):
 * the helpers a pipeline plan uses to mark such a call undelivered through
 * PipelineIO.undelivered (charged 0, reported), then fail. A leaf module, so
 * the generators can use it without importing the executors.
 */
import type { PipelineIO } from './executors'

/** A finished call's answer named no file: the call is marked undelivered (charged 0), then the node fails with `message`. */
export async function failNoFile(io: PipelineIO, key: string, message: string): Promise<never> {
  await io.undelivered?.(key, 'no-file')
  throw new Error(message)
}

/**
 * `make()` keeps (downloads, keeps, saves) what call `key` delivered; if that
 * fails, the call is marked undelivered ('not-kept': charged 0) and the error
 * goes on. After Stop the call stays charged (it was delivered; the person
 * stopped the node).
 */
export async function keptOrUndelivered<T>(io: PipelineIO, key: string, make: () => Promise<T>): Promise<T> {
  try { return await make() }
  catch (e) {
    if (!io.signal.aborted) await io.undelivered?.(key, 'not-kept')
    throw e
  }
}
