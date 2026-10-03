#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uniform float u_amplitude;
uniform float u_wavelength;
uniform float u_speed;
uniform float u_decay;
uniform float u_centerX;
uniform float u_centerY;

void main() {
    vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
    vec2 c = vec2(u_centerX, u_centerY);
    vec2 p = (v_texCoord - c) * asp;
    float r = length(p);
    float phase = (r / max(u_wavelength, 1e-4) - u_time * u_speed) * 6.2831853;
    float att = exp(-u_decay * r);
    vec2 dir = r > 0.0 ? p / r : vec2(0.0);
    vec2 off = dir * sin(phase) * u_amplitude * att;
    fragColor0 = vec4(texture(u_image0, clamp(v_texCoord + off / asp, 0.0, 1.0)).rgb, 1.0);
}
