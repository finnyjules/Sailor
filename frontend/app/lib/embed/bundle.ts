import type { EmbedSnapshot } from './contract'

/**
 * Literals that the reachable-form patterns in externalRefs() below correctly
 * still match, but which are third-party DATA, not a request anything in the
 * product ever issues: a DOM namespace string, a code-attribution comment, and
 * font-licence metadata baked into a vendored typeface JSON. Nothing reads these
 * fields as a URL to fetch/navigate/load — they just happen to look like one to
 * a text scanner.
 *
 * Every entry is the EXACT string externalRefs() finds, not a prefix or a bare
 * domain — matching on e.g. "sil.org" as a substring would silently wave through
 * "https://sil.org/evil.js" too, which defeats the entire point of this list.
 * Add an entry here ONLY when you can point at the exact source line that embeds
 * it and explain why nothing can ever fetch it — never to make a failing build
 * pass. Applies inside externalRefs() itself (not a second, looser scanner some
 * bundle-scan test reimplements), so the export-time gate and any bundle scan
 * agree by construction — see this file's own module doc above externalRefs.
 */
const INERT_LITERALS: ReadonlySet<string> = new Set<string>([
  // three.js's WebGLRenderer creates its fallback 2D canvas via
  // document.createElementNS(NAMESPACE, 'canvas') (see WebGLRenderer.js /
  // OffscreenCanvas fallback path). This is the XHTML XML namespace identifier
  // the DOM spec mandates for that call — an opaque string key the DOM API
  // compares against, never a URL any code fetches or navigates to.
  'http://www.w3.org/1999/xhtml',

  // three.js's DigitalGlitch shader (examples/jsm/shaders/DigitalGlitch.js)
  // carries a code-attribution comment inside its GLSL source string
  // ("...effect based on https://github.com/staffantan/unityglitch..."). Part
  // of a shader source string compiled by WebGL, never read as a URL.
  'https://github.com/staffantan/unityglitch',

  // ~/lib/spacetype/effects/boost.ts statically imports three's bundled
  // helvetiker_bold / optimer_bold / gentilis_bold typeface JSONs (for
  // extruded 3D text glyphs). Each carries its own font foundry's licence
  // metadata as plain JSON string fields — vendor_url / designer_url /
  // license_url / license_description — that Sailor never reads, let alone
  // fetches; they ride along as inert data baked into the typeface file
  // three.js ships. One entry per distinct literal across the three fonts:
  'http://www.magenta.gr',                          // helvetiker_bold.typeface.json vendor_url
  'http://www.magenta.gr/',                         // optimer_bold.typeface.json vendor_url (trailing-slash variant)
  'http://www.ellak.gr/fonts/MgOpen/license.html',   // both Magenta fonts' license_url (MgOpen licence)
  'http://scripts.sil.org/',                        // gentilis_bold.typeface.json vendor_url
  'http://www.sil.org/~gaultney',                   // gentilis_bold.typeface.json designer_url
  'http://scripts.sil.org/OFL',                     // gentilis_bold.typeface.json license_url
  'http://www.sil.org/',                            // gentilis_bold.typeface.json license_description, embedded copyright line
  // The same OFL URL recurs inside license_description's body text ("...FAQ
  // at: http://scripts.sil.org/OFL\r\n..."). The absolute-URL pattern below
  // stops at the first real whitespace byte, but the source CR was serialized
  // as a literal two-character "\r" escape (backslash + r), not an actual
  // control byte, so that escape gets swept into the match too. Same inert
  // field, same reason — the trailing `\\r` here is 2 literal characters
  // (backslash, "r"), matching what actually appears in the built bundle.
  'http://scripts.sil.org/OFL\\r',

  // ~/lib/vector/svg.ts writes the SVG namespace into the `xmlns` attribute of SVG it serialises
  // (the Frame painter's cone reaches this module for path-data helpers). A namespace identifier
  // compared as a string, never fetched.
  'http://www.w3.org/2000/svg',

  // paper's dist/paper-full.js (0.12.18), `var SvgElement = new function() {…}` near line 14648,
  // keeps the XML namespace table its SVG import/export hands to document.createElementNS /
  // getAttributeNS / setAttributeNS (the Frame painter's cone reaches paper for path booleans).
  // Namespace identifiers the DOM compares as strings, never fetched. (The same table also holds
  // the SVG namespace above.)
  'http://www.w3.org/2000/xmlns',                   // paper-full.js SvgElement `xmlns`
  'http://www.w3.org/1999/xlink',                   // paper-full.js SvgElement `xlink`
])

/**
 * Scans the HTML this bundler itself generates for references that would make
 * the exported file reach the network. It targets first-party generated
 * output — the config JSON, the inlined poster, and the adapter bundle we
 * control — not arbitrary third-party JS. It does NOT catch `new Worker()`,
 * `EventSource`, `XMLHttpRequest.open`, or schemeless-relative references like
 * `fetch("api/x")`. Returns what it found so a failure can say WHAT matched,
 * not just that something did.
 *
 * Scrubbing first is essential: base64 payloads routinely contain "//", and the
 * minifier emits //# sourceMappingURL comments. Scanning raw HTML for a bare "//"
 * reports both as network references and fails every genuine export.
 */
export function externalRefs(html: string): string[] {
  const scrubbed = html
    // Inlined assets are the mechanism, not a violation. Collapse them first.
    // Bounded to the base64 alphabet (which cannot contain ":") so a URL
    // immediately following a payload's terminal "=" padding is not absorbed
    // into the match and hidden from the scan below.
    //
    // The base64 alphabet also contains h, t, t, p, s — so when a payload is
    // glued directly to a URL with NO delimiter (no "=" padding, no quote),
    // the greedy alphabet class happily eats the scheme letters as if they
    // were payload, leaving a schemeless "://host/x" that none of the scan
    // patterns below recognize (they all require an explicit "http(s):" or
    // an attribute/CSS/JS wrapper). The trailing lookahead anchors the match
    // to a real terminator (a quote, paren, whitespace, or end of string)
    // instead of trusting the alphabet to self-delimit. When no such
    // terminator exists, the whole data: URI is left unscrubbed rather than
    // partially consumed — so the smuggled URL survives intact into the scan
    // and gets caught by the absolute-URL pattern. Do not remove this
    // lookahead to "simplify" the regex: without it this scrub reintroduces
    // a false negative on the export's sole network-reachability gate.
    .replace(/data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]*={0,2}(?=["')\s]|$)/gi, 'data:INLINED')
    // Minifier sourcemap comments are not network references.
    .replace(/\/\/[#@]\s*sourceMappingURL=[^\s*]*/g, '')

  const patterns: RegExp[] = [
    /https?:\/\/[^\s"')]+/gi, // absolute URL
    /(?:src|href)\s*=\s*["']\/\/[^"']*/gi, // protocol-relative in an attribute
    /(?:src|href)\s*=\s*["']\/(?!\/)[^"']*/gi, // root-relative in an attribute
    /\burl\(\s*["']?(?:(?:https?:)?\/\/|\/(?!\/))[^)]*/gi, // CSS url(), protocol-relative or root-relative
    /@import\s+["'][^"']*/gi, // CSS @import
    /\bfetch\(\s*["']\/[^"']*/gi, // root-relative fetch from adapter JS
    /\bnew\s+WebSocket\(\s*["'][^"']*/gi, // websocket
  ]

  const found: string[] = []
  for (const re of patterns) {
    for (const m of scrubbed.matchAll(re)) {
      if (INERT_LITERALS.has(m[0])) continue
      found.push(m[0])
    }
  }
  return found
}

/** Neutralize sequences that would break out of the inline <script> block. */
function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/**
 * Neutralize sequences that would break out of an HTML attribute. The poster
 * is a base64 data: URI, and its alphabet is `[A-Za-z0-9+/=]` plus the
 * `data:...;base64,` prefix, so it cannot actually contain a quote or `&`.
 * Escaping defensively anyway means this stays correct if that ever stops
 * being true (an SVG poster with a literal, non-base64 payload, say).
 */
function safeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

export function buildEmbedHtml(snapshot: EmbedSnapshot, adapterJs: string): string {
  if (!(snapshot.duration > 0)) {
    throw new Error(`embed: duration must be positive, got ${snapshot.duration}`)
  }
  if (!snapshot.posterDataUrl.startsWith('data:')) {
    throw new Error('embed: poster must be a data: URI — an external poster would break self-containment')
  }
  // adapterJs is spliced verbatim into an inline <script> block below (unlike
  // the config JSON, which safeJson escapes). A literal "</script" anywhere in
  // it — in a string constant, a regex, or even a comment — terminates that
  // block early in the HTML parser, silently truncating the page to a
  // poster-only export with no runtime error. Escaping raw JavaScript for a
  // script context is subtle and easy to get wrong, so fail loudly instead:
  // today's bundle doesn't contain this sequence, but nothing guarantees a
  // future adapter build won't.
  if (/<\\?\/script/i.test(adapterJs)) {
    throw new Error(
      `embed: adapter bundle for "${snapshot.kind}" contains a "</script" sequence, which would terminate ` +
        'the inline <script> block early and ship a poster-only export. The adapter bundle must not contain that sequence.',
    )
  }

  const backdrop = typeof snapshot.backdrop === 'string' && /^#[0-9a-f]{3,8}$/i.test(snapshot.backdrop) ? snapshot.backdrop : '#000'
  const bg = snapshot.transparent ? 'transparent' : backdrop
  const posterFit = snapshot.posterFit === 'cover' ? 'cover' : 'contain'

  // Framing policy: CONTAIN, for both the poster and the live canvas — unless
  // the snapshot asks for 'box'.
  //
  // The renderers draw a fullscreen triangle with no aspect correction, so
  // handing them the host window's dimensions squashes the piece to whatever
  // shape that window happens to be (a 1536x1536 export in a 1512x760 window
  // became a 2:1 squash the moment the poster hid). snapshot.width/height is
  // the exported aspect and it governs: #sailor-stage is letterboxed to that
  // ratio and centred, and the area around it is left to the page background
  // (transparent when the surface declared alpha, otherwise the export's own
  // backdrop). The poster is object-fit:${posterFit} against the same box and
  // its intrinsic aspect IS snapshot.width/height, so it lands on exactly the
  // same rectangle — the poster→live swap must not visibly jump, which rules
  // out cover on one side and contain on the other for the default policy.
  //
  // 'box' is the escape hatch a Frame export needs: the adapter is handed the
  // page's whole box — its own fit()/fill() logic (see frame/fit.ts) frames
  // the piece, not this runtime — so the background can reach the box's edges
  // instead of being letterboxed to the exported aspect.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sailor embed</title>
<style>
  html,body{margin:0;padding:0;background:${bg};overflow:hidden}
  #sailor-embed{position:relative;width:100vw;height:100vh;overflow:hidden}
  #sailor-stage{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%)}
  #sailor-embed canvas{display:block;width:100%;height:100%}
  #sailor-poster{position:absolute;inset:0;width:100%;height:100%;object-fit:${posterFit}}
  #sailor-poster[hidden]{display:none}
</style>
</head>
<body>
<div id="sailor-embed"><div id="sailor-stage"></div><img id="sailor-poster" alt="" src="${safeAttr(snapshot.posterDataUrl)}"></div>
<script>
window.__SAILOR_SNAPSHOT__ = ${safeJson({ ...snapshot, posterDataUrl: '' })};
</script>
<script>
${adapterJs}
</script>
<script>
(function () {
  var box = document.getElementById('sailor-embed');
  var stage = document.getElementById('sailor-stage');
  var poster = document.getElementById('sailor-poster');
  var snap = window.__SAILOR_SNAPSHOT__;
  var surface = window.__SAILOR_SURFACE__;

  function t01At(ms, dur) {
    if (!(dur > 0)) return 0;
    var d = dur * 1000, w = ms % d;
    return (w < 0 ? w + d : w) / d;
  }

  // Backing store is sized in DEVICE pixels; the CSS box stays in layout
  // pixels. Without this the piece renders at 1/DPR of its linear resolution
  // and looks softer than the MP4 it is meant to beat. Capped at 2 so a 3x
  // phone does not pay for 9x the fragments it can actually show.
  var dpr = Math.min(2, window.devicePixelRatio || 1);

  // Letterbox the exported aspect ratio inside whatever box the page gives us,
  // and report the resulting DEVICE-pixel dimensions. See the framing note in
  // bundle.ts — the poster is object-fit:contain over the same box, so both
  // land on the same rectangle.
  function fit() {
    if (snap.framing === 'box') {
      var fw = box.clientWidth || snap.width, fh = box.clientHeight || snap.height;
      stage.style.width = fw + 'px';
      stage.style.height = fh + 'px';
      return [Math.max(1, Math.round(fw * dpr)), Math.max(1, Math.round(fh * dpr))];
    }
    var bw = box.clientWidth || snap.width, bh = box.clientHeight || snap.height;
    var sw = snap.width > 0 ? snap.width : bw, sh = snap.height > 0 ? snap.height : bh;
    var k = Math.min(bw / sw, bh / sh);
    var cw = Math.max(1, Math.round(sw * k)), ch = Math.max(1, Math.round(sh * k));
    stage.style.width = cw + 'px';
    stage.style.height = ch + 'px';
    return [Math.max(1, Math.round(cw * dpr)), Math.max(1, Math.round(ch * dpr))];
  }
  // Before mount, so the adapter's first draw already has the right box.
  fit();

  // Poster stays visible until the live renderer has actually produced a frame.
  // If anything below throws, it simply never hides — a still frame, never a
  // blank rectangle and never an error in someone else's console.
  if (!surface || typeof surface.mount !== 'function') return;

  surface.mount(stage, snap.config).then(function (handle) {
    poster.hidden = true;
    // elapsed accumulates completed play spans; resumedAt anchors the current one.
    // Phase = elapsed + (now - resumedAt), so pause/resume never rewinds to 0.
    var elapsed = 0, resumedAt = 0, raf = 0, visible = true, dead = false;
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var now2 = function () { return (window.performance && performance.now) ? performance.now() : Date.now(); };

    // The renderer died after the poster was hidden. Stop the loop and put the
    // still frame back. Deliberately silent: this runs inside someone else's
    // page and must never print into their console.
    function fail() {
      if (dead) return;
      dead = true;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      poster.hidden = false;
    }

    function size() {
      var d = fit();
      try { handle.setSize(d[0], d[1]); } catch (e) { fail(); }
    }
    size();
    window.addEventListener('resize', size);

    // Ten embeds on one page is ten live WebGL contexts; past the browser's cap
    // (~16 in Chrome) the oldest is force-lost. Fall back to the poster rather
    // than freeze on a stale frame and spray GL errors into the host page.
    var cv = stage.querySelector('canvas');
    if (cv && cv.addEventListener) {
      cv.addEventListener('webglcontextlost', function (e) {
        if (e && e.preventDefault) e.preventDefault();
        fail();
      }, false);
    }

    // Deterministic still mode: an explicit frozen frame, or the reduced-motion
    // still. Both render exactly once and never start the loop.
    var frozen = typeof window.__SAILOR_FREEZE_T01__ === 'number'
      ? window.__SAILOR_FREEZE_T01__
      : null;
    if (frozen !== null || reduce || snap.still) {
      try { handle.setTime(frozen === null ? 0 : frozen); } catch (e) { fail(); }
      return;
    }

    function tick(now) {
      try { handle.setTime(t01At(elapsed + (now - resumedAt), snap.duration)); }
      catch (e) { fail(); return; }
      raf = requestAnimationFrame(tick);
    }
    // Guarded by 'raf', which is only ever non-zero between a play() call and its
    // matching pause(). The synchronous 'if (visible) play()' below and the
    // IntersectionObserver's first (always-async) callback therefore cannot
    // both start a loop: whichever runs first sets raf, so the other is a no-op.
    function play() { if (raf || dead) return; resumedAt = now2(); raf = requestAnimationFrame(tick); }
    function pause() { if (!raf) return; cancelAnimationFrame(raf); raf = 0; elapsed += now2() - resumedAt; }

    // Ten embeds on one page should not cook a laptop.
    if (window.IntersectionObserver) {
      new IntersectionObserver(function (es) {
        visible = es[0].isIntersecting;
        visible ? play() : pause();
      }).observe(box);
    } else { play(); }
    if (visible) play();
  }).catch(function () { /* poster remains visible */ });
})();
</script>
</body>
</html>
`
}
