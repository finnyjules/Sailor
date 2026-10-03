#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uniform float u_amplitude;
uniform float u_frequency;
uniform float u_speed;
uniform float u_angle;

void main() {
    float ang = radians(u_angle);
    vec2 dir = vec2(cos(ang), sin(ang));
    float phase = dot(v_texCoord, dir) * u_frequency * 6.2831853 + u_time * u_speed * 6.2831853;
    vec2 off = vec2(-dir.y, dir.x) * sin(phase) * u_amplitude;
    fragColor0 = vec4(texture(u_image0, clamp(v_texCoord + off, 0.0, 1.0)).rgb, 1.0);
}
