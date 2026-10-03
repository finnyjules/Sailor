#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uniform float u_spacing;
uniform float u_thickness;

float line(float coord, float sp, float th) {
    return smoothstep(0.0, th, abs(fract(coord / sp) - 0.5));
}

void main() {
    vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
    vec2 p = v_texCoord * asp;
    float lum = dot(texture(u_image0, v_texCoord).rgb, vec3(0.299, 0.587, 0.114));
    float sp = max(u_spacing, 0.004);
    float th = max(u_thickness, 0.02);

    float ink = 1.0;
    if (lum < 0.85) ink = min(ink, line(p.x + p.y, sp, th));
    if (lum < 0.65) ink = min(ink, line(p.x - p.y, sp, th));
    if (lum < 0.45) ink = min(ink, line(p.x, sp, th));
    if (lum < 0.25) ink = min(ink, line(p.y, sp, th));

    fragColor0 = vec4(vec3(ink), 1.0);   // dark hatch lines on paper white
}
