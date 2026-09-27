/**
 * A picture wired into an IMAGE input that Python sends with
 * `_image_tensor_to_data_url`, as the provider's link (step 3, R3.H): the
 * engine's `imageToUrl` when it gives one (a loader's picture is handed off
 * as the PNG of the loader's tensor, ./pictureHandoff.ts), else `toUrl`.
 * A leaf module, so the generators and the executors can both use it.
 */
import { isLink, type ApiLink } from '#shared/runner/graph'
import type { PlanContext } from './executors'
import type { OutputFile } from './types'

export function imageUrlOf(ctx: Pick<PlanContext, 'toUrl' | 'imageToUrl'>, file: OutputFile, link: unknown): Promise<string> {
  return ctx.imageToUrl && isLink(link) ? ctx.imageToUrl(file, link as ApiLink) : ctx.toUrl(file)
}
