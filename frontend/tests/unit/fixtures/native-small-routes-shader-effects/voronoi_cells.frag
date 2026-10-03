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
vec3 pal(float t, float hue) { return 0.5 + 0.5 * cos(6.28318 * (vec3(1.0) * t + vec3(0.0, 0.33, 0.66) + hue)); }

uniform float u_scale;
uniform float u_speed;
uniform float u_border;
uniform float u_hue;
uniform float u_colored;

void main() {
    vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
    vec2 p = v_texCoord * asp * u_scale;
    vec2 ip = floor(p), fp = fract(p);
    float t = u_time * u_speed;
    float f1 = 1e9, f2 = 1e9;
    vec2 cell1 = ip;
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            vec2 cell = ip + vec2(x, y);
            vec2 jit = vec2(hash2(cell, u_seed), hash2(cell, u_seed + 1.0));
            jit = 0.5 + 0.45 * sin(t + 6.28318 * jit);
            float d = length(vec2(x, y) + jit - fp);
            if (d < f1) { f2 = f1; f1 = d; cell1 = cell; }
            else if (d < f2) { f2 = d; }
        }
    }
    float ch = hash2(cell1, u_seed + 7.0);
    vec3 base = u_colored > 0.5 ? pal(ch, u_hue) : vec3(0.4 + 0.6 * ch);
    float border = smoothstep(0.0, max(u_border, 0.001), f2 - f1);   // dark seams
    fragColor0 = vec4(base * border, 1.0);
}
