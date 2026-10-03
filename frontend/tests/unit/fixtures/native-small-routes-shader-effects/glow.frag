#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform sampler2D u_source;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
uniform float u_pass;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uniform float u_threshold;
uniform float u_radius;
uniform float u_intensity;

vec3 sampleBlur(vec2 dir, float sigma) {
    int K = int(clamp(sigma * 2.0, 1.0, 24.0));
    vec3 sum = texture(u_image0, v_texCoord).rgb;
    float wsum = 1.0;
    for (int i = 1; i <= 24; i++) {
        if (i > K) break;
        float w = exp(-0.5 * float(i * i) / (sigma * sigma));
        sum += texture(u_image0, clamp(v_texCoord + dir * float(i), 0.0, 1.0)).rgb * w;
        sum += texture(u_image0, clamp(v_texCoord - dir * float(i), 0.0, 1.0)).rgb * w;
        wsum += 2.0 * w;
    }
    return sum / wsum;
}

// Like bloom but screen-blended and lower threshold — a soft dreamy glow over
// the whole image rather than just clipped highlights.
void main() {
    vec2 texel = 1.0 / u_resolution;
    float sigma = max(u_radius * u_resolution.y, 1.0);
    int p = int(u_pass + 0.5);
    if (p == 0) {
        vec3 c = texture(u_image0, v_texCoord).rgb;
        // Max-channel brightness so saturated colour highlights glow (luma buries blue).
        float l = max(max(c.r, c.g), c.b);
        float b = smoothstep(u_threshold - 0.2, u_threshold + 0.2, l);
        fragColor0 = vec4(c * b, 1.0);
    } else if (p == 1) {
        fragColor0 = vec4(sampleBlur(vec2(texel.x, 0.0), sigma), 1.0);
    } else if (p == 2) {
        fragColor0 = vec4(sampleBlur(vec2(0.0, texel.y), sigma), 1.0);
    } else {
        vec3 orig = texture(u_source, v_texCoord).rgb;
        vec3 g = clamp(texture(u_image0, v_texCoord).rgb * u_intensity, 0.0, 1.0);
        fragColor0 = vec4(1.0 - (1.0 - orig) * (1.0 - g), 1.0);   // screen blend
    }
}
