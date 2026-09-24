/** A file size for a person: "636 KB", "2.4 MB". One wording for every export sheet (the
 *  Frame's web export, 3D Studio's Export embed). Pure — safe in any bundle. */
export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
