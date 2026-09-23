export interface ImageBuildArgs {
  prompt: string
  aspectRatio: string
  seed: number
  adv: Record<string, unknown>
  /** fal URLs of moodboard reference pictures, or null. */
  refs: string[] | null
}

export interface ImageModelDesc {
  id: string
  label: string
  /** fal endpoint for text-to-image. */
  app: string
  /** fal endpoint that takes reference pictures (`image_urls`), or null. */
  refsApp: string | null
  build(a: ImageBuildArgs): Record<string, unknown>
}

export interface VideoBuildArgs {
  prompt: string
  aspectRatio: string
  duration: number
  seed: number
  /** fal URL of the first frame, or null. */
  image: string | null
  adv: Record<string, unknown>
}

export interface VideoModelDesc {
  id: string
  label: string
  /** fal app (the part before the function). */
  app: string
  defaultDuration: number
  /** fal function per mode, as in video_models.py fal_fn_by_mode. '' submits to the app itself. */
  fnByMode: { t2v: string, firstLast: string, reference?: string }
  build(a: VideoBuildArgs): Record<string, unknown>
}
