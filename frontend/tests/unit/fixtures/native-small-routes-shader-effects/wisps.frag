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
    for (int i = 0; i < 5; i++) { v += a * vnoise(p, seed + float(i) * 17.0); p *= 2.03; a *= 0.5; }
    return v;
}

uniform float u_density;
uniform float u_speed;
uniform float u_scale;
uniform float u_hue;

vec3 pal(float t) {
    return 0.5 + 0.5 * cos(6.28318 * (vec3(1.0) * t + vec3(0.0, 0.4, 0.7) + u_hue));
}

void main() {
    vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
    vec2 p = (v_texCoord - 0.5) * asp * u_scale;
    float t = u_time * u_speed * 0.3;

    // Flow field: advect the sample point along a curl-ish noise direction,
    // accumulating brightness to draw streaming wisps.
    vec3 col = vec3(0.0);
    vec2 q = p;
    float amp = 1.0;
    for (int i = 0; i < 5; i++) {
        float ang = fbm(q * 1.3 + vec2(t, -t), u_seed) * 6.28318 * 2.0;
        q += vec2(cos(ang), sin(ang)) * 0.13;
        float strand = fbm(q * 2.0 + t * 0.5, u_seed + 13.0);
        float line = smoothstep(0.55, 0.62, strand) * smoothstep(0.78, 0.66, strand);
        col += pal(0.2 + float(i) * 0.08 + strand * 0.4) * line * amp;
        amp *= 0.82;
    }
    col *= mix(0.5, 1.6, u_density);
    col += vec3(0.02, 0.025, 0.04);   // faint haze
    fragColor0 = vec4(clamp(col, 0.0, 1.0), 1.0);
}
