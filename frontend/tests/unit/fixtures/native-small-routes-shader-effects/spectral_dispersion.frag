#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uniform float u_amount;     // dispersion strength
uniform float u_centerX;
uniform float u_centerY;
uniform float u_edgeBoost;  // concentrate dispersion on high-contrast edges
uniform float u_falloff;    // 0 uniform .. 1 strong toward the frame edges

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

// Compact visible-spectrum approximation, t in 0..1 (blue -> green -> red).
vec3 spectral(float t) {
    t = clamp(t, 0.0, 1.0);
    vec3 c;
    c.r = smoothstep(0.30, 0.58, t);
    c.g = exp(-pow((t - 0.52) * 3.0, 2.0));
    c.b = 1.0 - smoothstep(0.42, 0.68, t);
    return c;
}

void main() {
    vec2 c = vec2(u_centerX, u_centerY);
    vec2 rel = v_texCoord - c;
    float rlen = length(rel);
    vec2 dir = rlen > 1e-4 ? rel / rlen : vec2(1.0, 0.0);

    float amt = u_amount * mix(1.0, rlen * 2.0, u_falloff);

    // Edge boost: scale dispersion by the local luminance gradient magnitude.
    if (u_edgeBoost > 0.0) {
        vec2 texel = 1.0 / u_resolution;
        float lx = luma(texture(u_image0, v_texCoord + vec2(texel.x, 0.0)).rgb)
                 - luma(texture(u_image0, v_texCoord - vec2(texel.x, 0.0)).rgb);
        float ly = luma(texture(u_image0, v_texCoord + vec2(0.0, texel.y)).rgb)
                 - luma(texture(u_image0, v_texCoord - vec2(0.0, texel.y)).rgb);
        float grad = clamp(length(vec2(lx, ly)) * 4.0, 0.0, 1.0);
        amt *= mix(1.0, grad, u_edgeBoost);
    }

    const int N = 16;
    vec3 sum = vec3(0.0);
    vec3 wsum = vec3(0.0);
    for (int i = 0; i < N; i++) {
        float t = float(i) / float(N - 1);
        vec3 sc = spectral(t);
        vec2 off = dir * amt * (t - 0.5);
        vec3 s = texture(u_image0, clamp(v_texCoord + off, 0.0, 1.0)).rgb;
        sum += s * sc;
        wsum += sc;
    }
    fragColor0 = vec4(sum / max(wsum, vec3(1e-3)), 1.0);
}
