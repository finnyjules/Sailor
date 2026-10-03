#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
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
float fbm(vec2 p, float seed) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * vnoise(p, seed + float(i) * 17.0); p *= 2.03; a *= 0.5; }
    return v;
}

uniform float u_depth;
uniform float u_border;
uniform float u_wobble;
uniform float u_speed;

void main() {
    vec2 lo = vec2(0.0), hi = vec2(1.0);
    for (int i = 0; i < 8; i++) {
        if (float(i) >= u_depth) break;
        vec2 key = floor((lo * 977.0 + hi * 389.0) * 64.0) + float(i);
        float h1 = hash2(key, u_seed);
        float ratio = mix(0.3, 0.7, hash2(key + 31.0, u_seed + 5.0));
        ratio += u_wobble * 0.15 * sin(u_time * u_speed * 6.2831853 + h1 * 6.2831853);
        ratio = clamp(ratio, 0.15, 0.85);
        if (h1 > 0.5) {
            float s = mix(lo.x, hi.x, ratio);
            if (v_texCoord.x < s) hi.x = s; else lo.x = s;
        } else {
            float s = mix(lo.y, hi.y, ratio);
            if (v_texCoord.y < s) hi.y = s; else lo.y = s;
        }
    }
    vec3 col = texture(u_image0, (lo + hi) * 0.5).rgb;
    vec2 dEdge = min(v_texCoord - lo, hi - v_texCoord) * u_resolution;
    float border = step(u_border * u_resolution.y, min(dEdge.x, dEdge.y));
    fragColor0 = vec4(col * border, 1.0);
}
