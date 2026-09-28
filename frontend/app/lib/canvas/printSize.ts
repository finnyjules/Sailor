/** The quiet label beside a Frame's name: "4:5 · 1080 × 1350". */
export function formatPrintSize(w: number, h: number, opts: { responsive?: boolean; loopSec?: number } = {}): string {
  if (!(w > 0 && h > 0)) return 'Set size'
  const g = gcd(Math.round(w), Math.round(h))
  const a = Math.round(w) / g, b = Math.round(h) / g
  const ratio = opts.responsive
    ? 'Responsive'
    : a <= 32 && b <= 32 ? `${a}:${b}`
      : w >= h ? `${trim(w / h)}:1` : `1:${trim(h / w)}`
  const loop = opts.loopSec && opts.loopSec > 0 ? ` · loops ${Math.round(opts.loopSec)}s` : ''
  return `${ratio} · ${Math.round(w)} × ${Math.round(h)}${loop}`
}

function gcd(a: number, b: number): number { return b ? gcd(b, a % b) : a }
function trim(n: number): string { return String(Math.round(n * 100) / 100) }
