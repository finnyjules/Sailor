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

uniform float u_thickness;
uniform float u_threshold;
uniform float u_intensity;
uniform float u_hue;
uniform float u_background;

float lum(vec2 uv) { return dot(texture(u_image0, clamp(uv, 0.0, 1.0)).rgb, vec3(0.299, 0.587, 0.114)); }

void main() {
    vec2 s = vec2(max(u_thickness * u_resolution.y, 0.5)) / u_resolution;
    float tl = lum(v_texCoord + vec2(-s.x, s.y)), tt = lum(v_texCoord + vec2(0.0, s.y)), tr = lum(v_texCoord + vec2(s.x, s.y));
    float ll = lum(v_texCoord + vec2(-s.x, 0.0)), rr = lum(v_texCoord + vec2(s.x, 0.0));
    float bl = lum(v_texCoord + vec2(-s.x, -s.y)), bb = lum(v_texCoord + vec2(0.0, -s.y)), br = lum(v_texCoord + vec2(s.x, -s.y));
    float gx = (tr + 2.0 * rr + br) - (tl + 2.0 * ll + bl);
    float gy = (tl + 2.0 * tt + tr) - (bl + 2.0 * bb + br);
    float e = smoothstep(u_threshold, u_threshold + 0.15, length(vec2(gx, gy)));
    vec3 src = texture(u_image0, v_texCoord).rgb;
    vec3 neon = mix(src, pal(0.0, u_hue) + 0.3, 0.6);
    fragColor0 = vec4(clamp(src * u_background + neon * e * u_intensity, 0.0, 1.0), 1.0);
}
