#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uniform float u_thickness;
uniform float u_threshold;
uniform float u_softness;
uniform float u_intensity;
uniform float u_background;

float lum(vec2 uv) {
    return dot(texture(u_image0, clamp(uv, 0.0, 1.0)).rgb, vec3(0.299, 0.587, 0.114));
}

void main() {
    vec2 s = vec2(max(u_thickness * u_resolution.y, 0.5)) / u_resolution;
    float tl = lum(v_texCoord + vec2(-s.x,  s.y)), t = lum(v_texCoord + vec2(0.0,  s.y)), tr = lum(v_texCoord + vec2(s.x,  s.y));
    float l  = lum(v_texCoord + vec2(-s.x,  0.0)),                                        r  = lum(v_texCoord + vec2(s.x,  0.0));
    float bl = lum(v_texCoord + vec2(-s.x, -s.y)), b = lum(v_texCoord + vec2(0.0, -s.y)), br = lum(v_texCoord + vec2(s.x, -s.y));
    float gx = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl);
    float gy = (tl + 2.0 * t + tr) - (bl + 2.0 * b + br);
    float e = length(vec2(gx, gy));
    float m = smoothstep(u_threshold, u_threshold + max(u_softness, 1e-3), e) * u_intensity;
    vec3 base = texture(u_image0, v_texCoord).rgb * u_background;
    fragColor0 = vec4(clamp(base + vec3(m), 0.0, 1.0), 1.0);
}
