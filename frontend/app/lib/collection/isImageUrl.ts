/** Whether a Collection cell value is a usable image URL: an image file extension,
 *  a ComfyUI `/view?` link, or any http(s) URL. Shared by the Collection table
 *  (CollectionDrawer) and the Collection card (CollectionNode). */
export function isImageUrl(v: unknown): boolean {
  const s = String(v ?? '')
  return /(\.(png|jpe?g|webp|gif|svg)(\?|#|$))|(^\/view\?)/i.test(s) || /^https?:\/\//i.test(s)
}
