#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uniform float u_palette;      // enum: which Riso ink set
uniform float u_dotSize;      // halftone cell size (0 = continuous tone)
uniform float u_misreg;       // per-plate registration error
uniform float u_inkDensity;   // overall coverage multiplier
uniform float u_mottle;       // uneven ink coverage + roller streaks
uniform float u_grain;        // paper fibre showing through the ink
uniform float u_paperTone;    // white -> warm cream stock

// Riso spot inks, measured off the official ink chart. Note black is ~0.145,
// not 0.0 — a riso drum never lays down a true black, and faking one is the
// fastest way to make this look like a Photoshop filter instead of a print.
const vec3 INK_FPINK  = vec3(1.000, 0.282, 0.686);
const vec3 INK_BLUE   = vec3(0.000, 0.471, 0.749);
const vec3 INK_YELLOW = vec3(1.000, 0.910, 0.000);
const vec3 INK_RED    = vec3(1.000, 0.400, 0.369);
const vec3 INK_GREEN  = vec3(0.000, 0.663, 0.361);
const vec3 INK_TEAL   = vec3(0.000, 0.514, 0.541);
const vec3 INK_PURPLE = vec3(0.463, 0.357, 0.655);
const vec3 INK_ORANGE = vec3(1.000, 0.427, 0.184);
const vec3 INK_FEDBLU = vec3(0.239, 0.259, 0.541);
const vec3 INK_BLACK  = vec3(0.145, 0.145, 0.145);

const float EPS = 0.02;         // density floor; keeps -log() finite
const float TAU = 6.28318531;

// Classic separation angles, one per plate.
const float ANG0 = 0.261799388;  // 15deg
const float ANG1 = 0.785398163;  // 45deg
const float ANG2 = 1.308996939;  // 75deg

int inkSet(int idx, out vec3 a, out vec3 b, out vec3 c) {
    c = vec3(1.0);
    if (idx == 1)      { a = INK_FPINK;  b = INK_TEAL;   return 2; }
    else if (idx == 2) { a = INK_RED;    b = INK_BLUE;   return 2; }
    else if (idx == 3) { a = INK_YELLOW; b = INK_PURPLE; return 2; }
    else if (idx == 4) { a = INK_ORANGE; b = INK_FEDBLU; return 2; }
    else if (idx == 5) { a = INK_GREEN;  b = INK_FPINK;  return 2; }
    else if (idx == 6) { a = INK_BLACK;  b = INK_FPINK;  return 2; }
    else if (idx == 7) { a = INK_FPINK;  b = INK_BLUE;   c = INK_YELLOW; return 3; }
    else if (idx == 8) { a = INK_RED;    b = INK_YELLOW; c = INK_BLUE;   return 3; }
    else if (idx == 9) { a = INK_BLACK;  b = INK_RED;    c = INK_YELLOW; return 3; }
    a = INK_FPINK; b = INK_BLUE; return 2;
}

float hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    return fract(p * (p + p));
}
float hash21(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
               mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
    float v = 0.0, amp = 0.5;
    for (int i = 0; i < 4; i++) { v += amp * vnoise(p); p *= 2.02; amp *= 0.5; }
    return v;
}

// Least-squares coverage of two ink densities against a target density.
vec2 solve2(vec3 Da, vec3 Db, vec3 d) {
    float maa = dot(Da, Da), mab = dot(Da, Db), mbb = dot(Db, Db);
    float ba = dot(Da, d), bb = dot(Db, d);
    float det = maa * mbb - mab * mab;
    det = abs(det) < 1e-6 ? 1e-6 : det;
    float ca = (ba * mbb - bb * mab) / det;
    float cb = (maa * bb - mab * ba) / det;
    // Non-negativity refit: a plate can't lay down negative ink, so pin the
    // offender at zero and re-solve the other one alone.
    if (ca < 0.0) { ca = 0.0; cb = bb / max(mbb, 1e-6); }
    else if (cb < 0.0) { cb = 0.0; ca = ba / max(maa, 1e-6); }
    return max(vec2(ca, cb), vec2(0.0));
}

// Split a target density across 2 or 3 ink densities.
vec3 separate(vec3 d, vec3 D0, vec3 D1, vec3 D2, int n) {
    if (n == 2) return vec3(solve2(D0, D1, d), 0.0);

    mat3 M = mat3(D0, D1, D2);
    mat3 N = transpose(M) * M;
    N[0][0] += 1e-4; N[1][1] += 1e-4; N[2][2] += 1e-4;   // ridge, for near-collinear ink sets
    vec3 c = inverse(N) * (transpose(M) * d);

    if (c.x < 0.0)      return vec3(0.0, solve2(D1, D2, d));
    else if (c.y < 0.0) { vec2 r = solve2(D0, D2, d); return vec3(r.x, 0.0, r.y); }
    else if (c.z < 0.0) return vec3(solve2(D0, D1, d), 0.0);
    return c;
}

// Where plate `i` sits relative to the paper.
vec2 misOffset(int i) {
    float a = hash11(float(i) * 7.13 + u_seed * 0.017 + 0.31) * TAU;
    return vec2(cos(a), sin(a)) * u_misreg;
}

// Coverage -> screened coverage on a rotated dot grid. Area-correct (radius
// tracks sqrt of coverage) and derivative-free: fwidth() is the likeliest
// source of browser-vs-server drift and this has to hold the parity gate.
float screenDot(vec2 p, float cov, float ang, float cell) {
    if (cell <= 0.0) return cov;
    // Bare paper must stay bare: without this the smoothstep still resolves to
    // ~0.5 at each cell centre, stippling every unprinted area.
    if (cov <= 0.001) return 0.0;
    float s = sin(ang), c = cos(ang);
    vec2 g = (mat2(c, -s, s, c) * p) / cell;
    float d = length(fract(g) - 0.5);
    float r = sqrt(clamp(cov, 0.0, 1.0)) * 0.70710678;
    float px = 1.0 / max(cell * min(u_resolution.x, u_resolution.y), 1.0);
    // A cell only a pixel or two wide can't hold a dot: the AA band then spans
    // the whole cell and every plate settles at ~50% coverage, which reads as a
    // flat wash with the image gone. Below that size, fall back to continuous
    // tone — that's what a screen too fine to resolve actually looks like.
    float resolvable = 1.0 - smoothstep(0.2, 0.5, px);
    return mix(cov, smoothstep(r + min(px, 0.25), r - min(px, 0.25), d), resolvable);
}

// Blotchy density plus faint horizontal roller streaks, one field per plate.
float mottleField(vec2 uv, int i) {
    if (u_mottle <= 0.0) return 1.0;
    float fi = float(i);
    float blot = fbm(uv * 3.5 + vec2(fi * 11.7, u_seed * 0.013));
    float streak = vnoise(vec2(uv.x * 1.7 + fi * 3.1, uv.y * 190.0 + u_seed * 0.007));
    return mix(1.0, 0.62 + 0.76 * blot, u_mottle)
         * mix(1.0, 0.86 + 0.28 * streak, u_mottle * 0.6);
}

void main() {
    vec2 uv = v_texCoord;
    vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);

    vec3 ink0, ink1, ink2;
    int n = inkSet(int(u_palette + 0.5), ink0, ink1, ink2);

    vec3 D0 = -log(max(ink0, EPS));
    vec3 D1 = -log(max(ink1, EPS));
    vec3 D2 = -log(max(ink2, EPS));

    // Paper fibre: modulates how much ink takes, so grain reads as the stock
    // showing through rather than as noise laid over the top.
    float fib = hash21(floor(uv * u_resolution) + u_seed * 0.011);
    float clump = fbm(uv * u_resolution.y * 0.2 + u_seed * 0.019);
    float take = 1.0 + (fib - 0.5) * u_grain * 0.55 + (clump - 0.5) * u_grain * 0.35;

    // Each plate reads the source through its own registration error, so the
    // colour AND its screen shift together — that fringe is the whole tell.
    vec3 cov = vec3(0.0);
    for (int i = 0; i < 3; i++) {
        if (i >= n) break;
        vec2 off = misOffset(i);
        vec3 src = texture(u_image0, clamp(uv - off, 0.0, 1.0)).rgb;
        vec3 c = separate(-log(max(src, EPS)), D0, D1, D2, n);
        cov[i] = c[i];
    }

    cov *= u_inkDensity * take;
    cov = vec3(cov.x * mottleField(uv, 0), cov.y * mottleField(uv, 1), cov.z * mottleField(uv, 2));
    cov = clamp(cov, 0.0, 1.0);

    float cell = u_dotSize;
    vec3 scr = vec3(
        screenDot((uv - misOffset(0) - 0.5) * asp, cov.x, ANG0, cell),
        screenDot((uv - misOffset(1) - 0.5) * asp, cov.y, ANG1, cell),
        screenDot((uv - misOffset(2) - 0.5) * asp, cov.z, ANG2, cell)
    );

    // Separate hash from `fib`: if the paper's own texture and the ink's
    // take-up ride the same noise they cancel and the grain reads as flat.
    float tooth = hash21(floor(uv * u_resolution) + 91.7 + u_seed * 0.023);
    vec3 paper = mix(vec3(1.0), vec3(0.965, 0.945, 0.898), u_paperTone);
    paper *= 1.0 - (1.0 - tooth) * u_grain * 0.05;

    // Beer-Lambert stacking: the exact inverse of the separation above, which is
    // why a 3-ink set with no screen comes back to the source.
    vec3 outCol = paper;
    outCol *= pow(max(ink0, EPS), vec3(scr.x));
    outCol *= pow(max(ink1, EPS), vec3(scr.y));
    if (n > 2) outCol *= pow(max(ink2, EPS), vec3(scr.z));

    fragColor0 = vec4(clamp(outCol, 0.0, 1.0), 1.0);
}
