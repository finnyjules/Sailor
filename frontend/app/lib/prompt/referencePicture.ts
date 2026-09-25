/**
 * A reference picture in the prompt (stage 5 follow-up): an image pasted (⌘V)
 * or dropped on the prompt of a shader-generation host is sent to the shader
 * model as the look to aim for — a second picture, apart from the one the
 * effect runs over. It lives with the take set, never in a project, a My effect
 * or a node.
 */
import { imageForModel } from '~/lib/shadergen/productRequest'

/** The request when a picture is sent with no words. */
export const REFERENCE_ONLY_REQUEST = 'Match the look of the reference picture'

const isImageType = (t: string | undefined) => !!t && t.startsWith('image/')

/** The first image file a paste or drop carries, or null (text, other files). A copied
 *  image often carries markup too; the file still wins. A plain text paste has no file. */
export function imageFileFrom(dt: DataTransfer | null | undefined): File | null {
  if (!dt) return null
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind === 'file' && isImageType(item.type)) {
      const f = item.getAsFile()
      if (f) return f
    }
  }
  for (const f of Array.from(dt.files ?? [])) if (isImageType(f.type)) return f
  return null
}

/** A drag over the prompt carries an image file (its files' types are readable during dragover). */
export function carriesImage(dt: DataTransfer | null | undefined): boolean {
  if (!dt || !Array.from(dt.types ?? []).includes('Files')) return false
  return Array.from(dt.items ?? []).some(i => i.kind === 'file' && isImageType(i.type))
}

/** The picture as the model will see it: a JPEG data URL, long edge ≤ 512 px (imageForModel);
 *  null when it can't be read. The chip shows the same small copy. */
export async function referenceFromFile(file: Blob): Promise<string | null> {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    return imageForModel(img)
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}
