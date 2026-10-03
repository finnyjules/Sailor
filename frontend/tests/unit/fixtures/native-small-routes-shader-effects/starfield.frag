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

uniform float u_density;
uniform float u_speed;
uniform float u_hue;

void main() {
    vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
    vec3 col = mix(vec3(0.02, 0.02, 0.05), vec3(0.0, 0.0, 0.02), v_texCoord.y);
    for (int layer = 0; layer < 3; layer++) {
        float fl = float(layer);
        float scale = 18.0 + fl * 26.0;
        vec2 uv = v_texCoord * asp * scale + vec2(11.0 * fl, u_time * u_speed * (0.15 + fl * 0.1) * 6.0);
        vec2 cell = floor(uv), f = fract(uv);
        float h = hash2(cell, u_seed + fl * 13.0);
        if (h > 1.0 - u_density * 0.12) {
            vec2 sp = vec2(hash2(cell, u_seed + fl + 2.0), hash2(cell, u_seed + fl + 5.0));
            float d = length(f - sp);
            float tw = 0.5 + 0.5 * sin(u_time * 3.0 + h * 40.0);
            float star = smoothstep(0.09, 0.0, d) * tw;
            col += mix(vec3(1.0), pal(h, u_hue), 0.3) * star * (1.0 - fl * 0.25);
        }
    }
    fragColor0 = vec4(clamp(col, 0.0, 1.0), 1.0);
}
