#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uniform float u_radius;
uniform float u_highlight;

// Single-pass disc blur (golden-angle spiral sampling) for a soft defocus.
// u_highlight biases toward bright samples so highlights round out like bokeh.
void main() {
    vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
    const int K = 48;
    const float GA = 2.39996323;   // golden angle
    vec3 sum = vec3(0.0);
    float wsum = 0.0;
    for (int i = 0; i < K; i++) {
        float fi = float(i);
        float rr = sqrt((fi + 0.5) / float(K)) * u_radius;
        float a = fi * GA;
        vec2 off = vec2(cos(a), sin(a)) * rr / asp;
        vec3 c = texture(u_image0, clamp(v_texCoord + off, 0.0, 1.0)).rgb;
        float w = 1.0 + u_highlight * dot(c, vec3(0.333));
        sum += c * w;
        wsum += w;
    }
    fragColor0 = vec4(sum / wsum, 1.0);
}
