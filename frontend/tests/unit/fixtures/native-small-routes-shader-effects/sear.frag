#version 300 es
precision highp float;
uniform sampler2D u_image0;   // pass 1 reads the heat field that pass 0 wrote
uniform sampler2D u_source;   // the original input image (for Image mix)
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
uniform float u_hasInput;
uniform float u_pass;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uint pcg(uint v) { v = v * 747796405u + 2891336453u; v = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u; return (v >> 22u) ^ v; }
float hash2(vec2 ip, float seed) {
    uvec2 q = uvec2(ivec2(ip) + 32768);
    uint h = pcg(q.x ^ pcg(q.y ^ pcg(uint(int(seed)))));
    return float(h) * (1.0 / 4294967295.0);
}
float vnoise(vec2 p, float seed) {
    vec2 i = floor(p), f = fract(p);
    vec2 u2 = f * f * (3.0 - 2.0 * f);
    float a = hash2(i, seed), b = hash2(i + vec2(1, 0), seed);
    float c = hash2(i + vec2(0, 1), seed), d = hash2(i + vec2(1, 1), seed);
    return mix(mix(a, b, u2.x), mix(c, d, u2.x), u2.y);
}
// Rougher than the usual fbm on purpose (gain 0.58, lacunarity 2.05): the extra weight on
// the fine octaves is what gives the colour blocks their ragged coastlines.
float fbmR(vec2 p, float seed, int oct) {
    float v = 0.0, a = 0.5, norm = 0.0;
    for (int i = 0; i < 5; i++) {
        if (i >= oct) break;
        v += a * vnoise(p, seed + float(i) * 131.0); norm += a;
        p *= 2.05; a *= 0.58;
    }
    return v / max(norm, 1e-5);
}

// The inks are read as a ramp, coolest first, EVENLY spaced by order (the stop positions
// are ignored, as in a thermal camera's lookup table).
#define MAXS 8
uniform vec3 u_ramp[MAXS];
uniform float u_rampPos[MAXS];
uniform float u_rampCount;
vec3 rampEven(float t) {
    int n = int(u_rampCount + 0.5);
    if (n < 2) return u_ramp[0];
    float u = clamp(t, 0.0, 1.0) * float(n - 1);
    int k = min(n - 2, int(floor(u)));
    return mix(u_ramp[k], u_ramp[min(k + 1, MAXS - 1)], u - float(k));
}

uniform float u_scale;
uniform float u_warp;
uniform float u_detail;
uniform float u_smear;
uniform float u_drag;
uniform float u_tear;
uniform float u_steps;
uniform float u_grain;
uniform float u_drift;
uniform float u_speed;
uniform float u_mix;

// ---------- pass 0: the heat field ----------
// `uv` is canvas space: x right, y DOWN, both 0..1.
float heat(vec2 uv) {
    float aspect = u_resolution.y / u_resolution.x;
    float span = 0.7 + (1.0 - u_scale) * 7.5;      // how many blobs across the width
    float k = u_warp * 2.6;
    int oct = int(clamp(u_detail, 1.0, 5.0) + 0.5);
    // Drift: the field orbits slowly; Speed sets the rate, Drift the radius.
    float ph = u_time * u_speed * 0.25;
    vec2 o = vec2(cos(ph), sin(ph)) * (u_drift * 1.4);
    float u = uv.x * span, v = uv.y * span * aspect;
    // Two warps: a slow one bends the whole field into lobes, the main fbm roughens it.
    float wx = fbmR(vec2(u * 0.55 + 11.3 + o.x, v * 0.55 + 4.1 + o.y), u_seed + 7.0, 2) - 0.5;
    float wy = fbmR(vec2(u * 0.55 + 2.7, v * 0.55 + 19.7 + o.y), u_seed + 13.0, 2) - 0.5;
    float t = fbmR(vec2(u + wx * k + o.x * 0.6, v + wy * k + o.y * 0.6), u_seed, oct);
    return t;
}

// The field is carried between passes as 16 bits split over red and green, because the
// intermediate texture is 8-bit and the streak threshold is finer than 1/255.
vec4 encode16(float h) {
    float v16 = floor(clamp(h, 0.0, 1.0) * 65535.0 + 0.5);
    return vec4(floor(v16 / 256.0) / 255.0, mod(v16, 256.0) / 255.0, 0.0, 1.0);
}
// Read the field at canvas pixel (cx, cy) (y DOWN). The coordinate is rounded to a whole
// pixel first: the field is carried in two 8-bit bytes, so a filtered read between texels
// would blend the bytes and decode to nonsense. The tool samples its 640-wide lattice with
// bilinear interpolation; here the field is full resolution, so the nearest pixel is fine.
float fieldAt(float cx, float cy) {
    cx = clamp(floor(cx + 0.5), 0.0, u_resolution.x - 1.0);
    cy = clamp(floor(cy + 0.5), 0.0, u_resolution.y - 1.0);
    vec2 tc = vec2((cx + 0.5) / u_resolution.x, 1.0 - (cy + 0.5) / u_resolution.y);
    vec4 s = texture(u_image0, tc);
    return (floor(s.r * 255.0 + 0.5) * 256.0 + floor(s.g * 255.0 + 0.5)) / 65535.0;
}

// Flatten the histogram so every slice of the ramp gets a fair share of the picture: that
// is what turns a soft gradient into flat blocks of one colour. The tool measures its whole
// frame; here the frame mean and spread are measured from a fixed 8x8 grid of taps. A
// logistic stands in for the CDF; a stretched raw value keeps 12% of the original shape, as
// the tool does.
float flatten(float t, float mu, float sd) {
    float raw = clamp((t - mu) / (5.2 * sd) + 0.5, 0.0, 1.0);
    float eq = 1.0 / (1.0 + exp(-1.702 * (t - mu) / sd));
    return clamp(mix(raw, eq, 0.88), 0.0, 1.0);
}

void main() {
    if (u_pass < 0.5) {
        fragColor0 = encode16(heat(vec2(v_texCoord.x, 1.0 - v_texCoord.y)));
        return;
    }

    // ---------- pass 1: the rows ----------
    float W = u_resolution.x, H = u_resolution.y;
    vec2 px = floor(v_texCoord * u_resolution);
    float x = px.x;
    float y = (H - 1.0) - px.y;                     // canvas y, downwards

    // Frame mean AND spread of the raw field from a fixed 8x8 grid. The tool measures its
    // whole frame; a table of spreads per octave count ran 12–15% high and left the end
    // inks under-used, and a regular 4x4 grid can lock onto the field's own period.
    float mu = 0.0, m2 = 0.0;
    for (int a = 0; a < 8; a++) {
        for (int b = 0; b < 8; b++) {
            float s = fieldAt((float(a) + 0.5) * W / 8.0, (float(b) + 0.5) * H / 8.0);
            mu += s; m2 += s * s;
        }
    }
    mu /= 64.0; m2 /= 64.0;
    float sd = max(0.03, sqrt(max(m2 - mu * mu, 0.0)));

    // Tear: some bands of rows are dragged so hard the whole row collapses into two or
    // three stripes of flat colour and slides sideways with it.
    float bandH = max(2.0, floor(H * 0.028 + 0.5));
    float band = floor(y / bandH);
    bool torn = hash2(vec2(band, 77.0), u_seed + 3.0) < u_tear * 0.62;
    float shift = torn ? (hash2(vec2(band, 91.0), u_seed + 5.0) - 0.5) * W * 1.4 * u_tear : 0.0;

    // Streak: how far a run of held colour may go, and how big a change breaks it. This is
    // the tool's own pairing: at Streak 1 the run limit stops mattering but the hold breaks
    // on tiny changes, so the visible streaking at the top of the dial comes from Drag; at
    // Streak 0 runs are short but hold firmly. Kept as the tool has it.
    float maxRun = max(2.0, floor((0.02 + u_smear * u_smear * 1.2) * W + 0.5));
    float thresh = 0.0015 + pow(1.0 - u_smear, 2.2) * 0.22;
    float rowRun = torn ? W : maxRun;
    float rowThr = torn ? thresh + 0.45 * u_tear : thresh;

    // Drag: the sample is pulled back along the row, and the pull wanders smoothly down the
    // picture rather than jumping row to row, so edges lean and melt in one piece.
    float pull = u_drag * W * 0.3
               * (0.15 + 0.85 * vnoise(vec2(y * 0.014, band * 0.37), u_seed + 17.0))
               * (0.5 + 0.5 * sin(y * 0.031));

    // The field value the row sees at canvas x, after pull and the torn shift (wrapping).
    #define FIELD(cx) flatten(fieldAt(mod(max((cx) - pull, 0.0) + shift, W), y), mu, sd)

    // The tool scans each row left to right, holding a colour until the heat under it moves
    // by `rowThr` from the HELD value or the run reaches `rowRun`. Per pixel: walk left on a
    // fixed lattice (so every pixel of a run sees the same anchor and runs come out flat),
    // accept each tap as the new anchor while the whole stretch back to x stays within
    // `rowThr` of it, and stop at `rowRun`. Runs therefore anchor on the field's own
    // iso-contours, which are coherent from row to row. 16 taps; more does not help.
    float v = FIELD(x);
    float held = v;
    float stride = max(1.0, rowRun / 16.0);
    float xa = floor(x / stride) * stride;
    float lo = v, hi = v;
    for (int k = 0; k < 16; k++) {
        float cx = xa - float(k) * stride;
        if (cx < 0.0 || x - cx > rowRun) break;
        float w = FIELD(cx);
        if (max(hi - w, w - lo) > rowThr) break;   // this tap cannot anchor a run that reaches x
        lo = min(lo, w); hi = max(hi, w);
        held = w;
    }

    // Grain only shows where a band ends, so it reads as a dithered coastline.
    float q = held + (hash2(vec2(x, y), u_seed + 29.0) - 0.5) * u_grain * 0.34;

    // Posterise: every step gets the same slice of the range, ends included.
    float steps = max(2.0, floor(u_steps + 0.5));
    float t = min(steps - 1.0, floor(clamp(q, 0.0, 0.9999) * steps)) / (steps - 1.0);
    vec3 col = rampEven(t);

    if (u_hasInput > 0.5 && u_mix > 0.0) {
        col = mix(col, texture(u_source, v_texCoord).rgb, u_mix);
    }
    fragColor0 = vec4(col, 1.0);
}
