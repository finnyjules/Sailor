#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

// Textured glass as a HEIGHT FIELD. Each pattern is only a height function; the
// normal is taken from it by central differences, and refraction, dispersion and
// sheen all fall out of that normal. Adding a tenth pattern is one more case in
// heightAt() — no new refraction maths.
uniform float u_mode;        // pattern: 0 reeded, 1 concentric, 2 pillows, 3 brick,
                             //   4 raindrops, 5 zigzag, 6 hex, 7 wobble, 8 frost
uniform float u_count;       // cell size, as cells across the frame
uniform float u_refraction;  // depth: how far the surface bends the image
uniform float u_relief;      // how steep the height field reads (normal strength)
uniform float u_chromatic;   // dispersion: per-channel split, strongest off-axis
uniform float u_blur;        // smear along the ridge
uniform float u_sheen;       // specular highlight off the normal
uniform float u_lightAngle;  // where the sheen comes from, in degrees
uniform float u_angle;       // pattern rotation in degrees (90 = vertical flutes)
uniform float u_mortar;      // brick only: gap between bricks
uniform float u_rainSeed;    // raindrops only: reshuffles the drops
uniform float u_centerX;     // concentric only
uniform float u_centerY;

const float PI = 3.14159265359;
const int NMAX = 16;

float g_aspect;   // set once in main(); heightAt() needs it for the ring centre

// ---------------------------------------------------------------- noise utils

float hash21(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

vec2 hash22(vec2 p) {
    vec2 k = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return fract(sin(k) * 43758.5453123);
}

float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * vnoise(p); p *= 2.02; a *= 0.5; }
    return v;
}

// ------------------------------------------------------------ height profiles

// A half-cylinder lying across the axis: 1 down the middle of the cell, 0 at the
// seam. The square root is what makes it a true cylinder — the surface turns away
// fastest at the edges, which is where glass bends light hardest.
float cylProfile(float x) {
    float f = fract(x) - 0.5;
    return sqrt(max(0.25 - f * f, 0.0)) * 2.0;
}

// -0.5..0.5 triangle wave, period 1.
float triWave(float x) {
    return abs(fract(x) - 0.5) * 2.0 - 0.5;
}

// Flat face with a chamfer round it, rows offset by half a brick. Flat means no
// bend at all across the middle of a brick, which is what stops it reading as a grid.
float brickHeight(vec2 q) {
    vec2 c = vec2(q.x * 0.5, q.y);              // a brick is 2 cells wide, 1 tall
    c.x += 0.5 * mod(floor(c.y), 2.0);
    vec2 f = fract(c) - 0.5;
    // distance to the nearest brick edge, back in q units
    float e = min((0.5 - abs(f.x)) * 2.0, 0.5 - abs(f.y));
    return smoothstep(u_mortar, u_mortar + 0.22, e);
}

// Rounded blobs sitting on the pane, each one its own little lens. Drops are
// spherical caps on a jittered grid, combined with max() so they sit on top of
// each other rather than piling up.
float rainHeight(vec2 q) {
    vec2 base = floor(q);
    float h = 0.0;
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            vec2 g = base + vec2(float(x), float(y));
            vec2 j = hash22(g + u_rainSeed * 7.31);
            vec2 c = g + 0.15 + j * 0.7;
            float rad = 0.16 + hash21(g * 1.37 + u_rainSeed * 3.7) * 0.30;
            float d = length(q - c) / max(rad, 1e-4);
            h = max(h, sqrt(max(1.0 - d * d, 0.0)));
        }
    }
    return h;
}

// Reeds whose lines zigzag as they go. The zigzag displaces the whole run rather
// than each reed on its own, so the reeds stay parallel and the run bends.
float zigzagHeight(vec2 q) {
    return cylProfile(q.x + triWave(q.y * 0.15) * 3.0);
}

// Three ridges at sixty degrees to each other. min() keeps the seams crisp, so
// they meet in hexagonal facets rather than blurring into bumps.
float hexHeight(vec2 q) {
    float a0 = cylProfile(q.x);
    float a1 = cylProfile(dot(q, vec2(0.5, 0.8660254)));
    float a2 = cylProfile(dot(q, vec2(-0.5, 0.8660254)));
    return min(min(a0, a1), a2);
}

// Noise pushed around by more noise, which is what turns blobs into something
// that flows.
float wobbleHeight(vec2 q) {
    vec2 w = vec2(fbm(q * 0.5 + 11.3), fbm(q * 0.5 + 41.7));
    return fbm(q * 0.5 + w * 2.0);
}

// The same texture at three sizes, the finest too small to read as a lens on its
// own. Not true frosting, which scatters rather than bends, but the same job.
float frostHeight(vec2 q) {
    return vnoise(q * 0.6) * 0.55 + vnoise(q * 1.7) * 0.30 + vnoise(q * 4.6) * 0.15;
}

// The height field, sampled in aspect-corrected square space.
float heightAt(vec2 s) {
    int mode = int(u_mode + 0.5);
    float n = max(u_count, 1.0);

    if (mode == 1) {                                       // concentric rings
        vec2 c = vec2(u_centerX * g_aspect, u_centerY);
        return cylProfile(length(s - c) * n);
    }

    float a = radians(u_angle);
    vec2 acrossUnit = vec2(-sin(a), cos(a));
    vec2 alongUnit = vec2(cos(a), sin(a));
    vec2 q = vec2(dot(s, acrossUnit), dot(s, alongUnit)) * n;

    if (mode == 2) return cylProfile(q.x) * cylProfile(q.y);   // pillows
    if (mode == 3) return brickHeight(q);
    if (mode == 4) return rainHeight(q);
    if (mode == 5) return zigzagHeight(q);
    if (mode == 6) return hexHeight(q);
    if (mode == 7) return wobbleHeight(q);
    if (mode == 8) return frostHeight(q);
    return cylProfile(q.x);                                    // 0: reeded
}

// -------------------------------------------------------------------- render

void main() {
    g_aspect = u_resolution.x / max(u_resolution.y, 1.0);
    vec2 s = vec2(v_texCoord.x * g_aspect, v_texCoord.y);
    float n = max(u_count, 1.0);

    // Slope by central differences. eps is a fraction of a CELL, not of a pixel,
    // so the surface reads the same at preview size and at bake size. It also
    // caps the slope at the seams, where a true cylinder's derivative runs away.
    float eps = 0.08 / n;
    vec2 grad = vec2(
        heightAt(s + vec2(eps, 0.0)) - heightAt(s - vec2(eps, 0.0)),
        heightAt(s + vec2(0.0, eps)) - heightAt(s - vec2(0.0, eps))
    ) / (2.0 * eps * n);   // /n keeps the slope scale-free as cell size changes

    vec3 nrm = normalize(vec3(-grad * u_relief, 1.0));

    // Refraction: push the sample along the surface tilt. depth/count reproduces
    // the old cylinder's displacement scale, so saved layers land where they were.
    vec2 moveS = nrm.xy * (u_refraction / n) * 0.5;
    vec2 base = v_texCoord + vec2(moveS.x / g_aspect, moveS.y);

    // Dispersion follows the same tilt, so it is strongest where the surface
    // turns away and vanishes flat-on — which is how glass actually behaves.
    vec2 crMove = nrm.xy * u_chromatic;
    vec2 crTex = vec2(crMove.x / g_aspect, crMove.y);

    // Smear runs perpendicular to the slope, i.e. ALONG the ridge. For reeded
    // flutes that is the flute axis, matching the old behaviour exactly.
    vec2 tang = (length(grad) > 1e-5) ? normalize(vec2(-grad.y, grad.x)) : vec2(1.0, 0.0);

    bool wantBlur = u_blur > 0.0005;
    bool wantDisp = u_chromatic > 0.0001;
    int taps = wantBlur ? NMAX : 1;

    vec3 col = vec3(0.0);
    for (int i = 0; i < NMAX; i++) {
        if (i >= taps) break;
        float t = (taps == 1) ? 0.0 : (float(i) / float(taps - 1) - 0.5);
        vec2 mS = tang * (t * u_blur);
        vec2 off = vec2(mS.x / g_aspect, mS.y);
        if (wantDisp) {
            col.r += texture(u_image0, clamp(base + off + crTex, 0.0, 1.0)).r;
            col.g += texture(u_image0, clamp(base + off, 0.0, 1.0)).g;
            col.b += texture(u_image0, clamp(base + off - crTex, 0.0, 1.0)).b;
        } else {
            col += texture(u_image0, clamp(base + off, 0.0, 1.0)).rgb;
        }
    }
    col /= float(taps);

    // Sheen: a specular glint off the same normal. Fixed viewer, light set by angle.
    if (u_sheen > 0.0001) {
        float la = radians(u_lightAngle);
        vec3 L = normalize(vec3(cos(la), sin(la), 0.85));
        vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
        col += pow(max(dot(nrm, H), 0.0), 48.0) * u_sheen;
    }

    fragColor0 = vec4(clamp(col, 0.0, 1.0), 1.0);
}
