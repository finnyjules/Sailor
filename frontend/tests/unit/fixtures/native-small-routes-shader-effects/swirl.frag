#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uniform float u_strength;
uniform float u_radius;
uniform float u_speed;
uniform float u_centerX;
uniform float u_centerY;

void main() {
    vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
    vec2 c = vec2(u_centerX, u_centerY);
    vec2 p = (v_texCoord - c) * asp;
    float r = length(p);
    float fall = smoothstep(u_radius, 0.0, r);
    float a = u_strength * fall * (1.0 + 0.15 * sin(u_time * u_speed * 6.2831853));
    mat2 R = mat2(cos(a), -sin(a), sin(a), cos(a));
    vec2 uv = c + (R * p) / asp;
    fragColor0 = vec4(texture(u_image0, clamp(uv, 0.0, 1.0)).rgb, 1.0);
}
