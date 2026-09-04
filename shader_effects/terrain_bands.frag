#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
uniform float u_hasInput;
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
float fbmN(vec2 p, float seed, int oct) {
    float v = 0.0, a = 0.5, norm = 0.0;
    for (int i = 0; i < 8; i++) {
        if (i >= oct) break;
        v += a * vnoise(p, seed + float(i) * 1319.0); norm += a;
        p *= 2.0; a *= 0.5;
    }
    return v / max(norm, 1e-5);
}

// One band per ink, low to high; the stop positions are ignored.
#define MAXS 8
uniform vec3 u_ramp[MAXS];
uniform float u_rampPos[MAXS];
uniform float u_rampCount;

uniform float u_scale;
uniform float u_warp;
uniform float u_detail;
uniform float u_contrast;
uniform float u_balance;
uniform float u_grain;
uniform float u_block;
uniform float u_drift;
uniform float u_speed;
uniform float u_mix;

void main() {
    float W = u_resolution.x, H = u_resolution.y;
    float ar = H / W;
    vec2 dev = floor(v_texCoord * u_resolution);                       // device pixel (grain is per pixel)
    vec2 pxy = vec2(v_texCoord.x * W, (1.0 - v_texCoord.y) * H);       // canvas, y DOWN

    // Blockiness: the tool snaps to blocks of N preview pixels; scaled to the short side
    // so a 2400 px export carries the same block as the 700 px preview.
    float blk = floor(u_block + 0.5) * max(1.0, min(W, H) / 700.0);
    if (blk >= 1.0) pxy = floor(pxy / blk) * blk;
    vec2 uv = pxy / vec2(W, H);

    float u = uv.x * u_scale, v = uv.y * u_scale * ar;
    int oct = int(clamp(u_detail, 1.0, 7.0) + 0.5);
    // Drift: the tool walks a fourth noise axis on a circle; here the domain orbits.
    float ph = u_time * u_speed * 0.25;
    vec2 o = vec2(cos(ph), sin(ph)) * u_drift * 0.5;

    float wx = fbmN(vec2(u + 5.2, v + 1.3) + o, u_seed + 11.0, 2);
    float wy = fbmN(vec2(u + 9.1, v + 7.7) + o, u_seed + 29.0, 2);
    float val = fbmN(vec2(u + u_warp * (wx - 0.5) * 2.0, v + u_warp * (wy - 0.5) * 2.0) + o, u_seed, oct);
    val = clamp((val - 0.5) * u_contrast + 0.5, 0.0, 1.0);

    // Grain straight into the value, per device pixel, before the cut into bands.
    val = clamp(val + (hash2(dev, u_seed) - 0.5) * u_grain, 0.0, 1.0);
    // Spread skews the bands toward the low or the high inks.
    float q = pow(val, pow(2.0, -u_balance));

    int n = max(1, int(u_rampCount + 0.5));
    int idx = clamp(int(floor(q * float(n))), 0, n - 1);
    vec3 col = u_ramp[clamp(idx, 0, MAXS - 1)];

    if (u_hasInput > 0.5 && u_mix > 0.0) {
        col = mix(col, texture(u_image0, v_texCoord).rgb, u_mix);
    }
    fragColor0 = vec4(col, 1.0);
}
