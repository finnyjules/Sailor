#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uniform float u_size;
uniform float u_angle;
uniform float u_softness;

void main() {
    vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
    float ang = radians(u_angle);
    mat2 R = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
    vec2 p = (v_texCoord - 0.5) * asp;
    vec2 g = (R * p) / u_size;
    vec2 cell = floor(g) + 0.5;
    vec2 cuv = (transpose(R) * (cell * u_size)) / asp + 0.5;
    vec3 col = texture(u_image0, clamp(cuv, 0.0, 1.0)).rgb;
    float lum = dot(col, vec3(0.299, 0.587, 0.114));
    float radius = sqrt(max(1.0 - lum, 0.0)) * 0.7071;
    float d = length(g - cell);
    float m = smoothstep(radius, radius - max(u_softness, 0.001) * 0.7071, d);
    fragColor0 = vec4(mix(vec3(1.0), col, m), 1.0);
}
