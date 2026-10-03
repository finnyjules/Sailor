#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uniform float u_radius;    // brush size (fraction of image height)
uniform float u_sharpness; // how strongly low-variance sectors win (stroke crispness)
uniform float u_richness;  // saturation boost of the painted result

const float PI = 3.14159265359;
const vec3 LUMA = vec3(0.299, 0.587, 0.114);

float luma(vec2 uv) { return dot(texture(u_image0, clamp(uv, 0.0, 1.0)).rgb, LUMA); }

// Anisotropic generalised Kuwahara: orient the brush disc ALONG image contours
// (from a Sobel structure estimate) and split it into 8 sectors, then softly
// favour the lowest-variance sectors. Produces flowing oriented oil brushstrokes
// that follow edges, not the rounded blobs of an isotropic filter.
void main() {
    vec2 texel = 1.0 / u_resolution;
    int R = int(clamp(u_radius * u_resolution.y, 1.0, 8.0));
    float q = mix(3.0, 18.0, clamp(u_sharpness, 0.0, 1.0));

    // 3x3 Sobel → local gradient = stroke orientation + strength.
    float tl = luma(v_texCoord + vec2(-1.0, -1.0) * texel);
    float tc = luma(v_texCoord + vec2(0.0, -1.0) * texel);
    float tr = luma(v_texCoord + vec2(1.0, -1.0) * texel);
    float ml = luma(v_texCoord + vec2(-1.0, 0.0) * texel);
    float mr = luma(v_texCoord + vec2(1.0, 0.0) * texel);
    float bl = luma(v_texCoord + vec2(-1.0, 1.0) * texel);
    float bc = luma(v_texCoord + vec2(0.0, 1.0) * texel);
    float br = luma(v_texCoord + vec2(1.0, 1.0) * texel);
    vec2 grad = vec2((tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl),
                     (bl + 2.0 * bc + br) - (tl + 2.0 * tc + tr));
    float gmag = length(grad);
    float A = clamp(gmag * 2.5, 0.0, 1.0);                 // anisotropy
    vec2 across = gmag > 1e-4 ? grad / gmag : vec2(0.0, 1.0);
    vec2 along = vec2(-across.y, across.x);                // edge tangent
    float elong = mix(1.0, 3.0, A);                        // stretch along the stroke

    vec3 sumC[8];
    float sumL2[8];
    float cnt[8];
    for (int s = 0; s < 8; s++) { sumC[s] = vec3(0.0); sumL2[s] = 0.0; cnt[s] = 0.0; }

    for (int j = -8; j <= 8; j++) {
        if (j < -R || j > R) continue;
        for (int i = -8; i <= 8; i++) {
            if (i < -R || i > R) continue;
            vec2 d = vec2(float(i), float(j));
            if (dot(d, d) > float(R * R) + 0.5) continue;
            vec2 off = along * (d.x * elong) + across * d.y;   // oriented brush
            vec3 c = texture(u_image0, clamp(v_texCoord + off * texel, 0.0, 1.0)).rgb;
            float l = dot(c, LUMA);
            int s = (i == 0 && j == 0) ? 0 : int(floor((atan(d.y, d.x) + PI) / 0.78539816)) & 7;
            sumC[s] += c;
            sumL2[s] += l * l;
            cnt[s] += 1.0;
        }
    }

    vec3 outC = vec3(0.0);
    float wSum = 0.0;
    for (int s = 0; s < 8; s++) {
        if (cnt[s] < 0.5) continue;
        vec3 mean = sumC[s] / cnt[s];
        float lm = dot(mean, LUMA);
        float var = max(sumL2[s] / cnt[s] - lm * lm, 0.0);
        float w = 1.0 / (1.0 + pow(var * 64.0, q * 0.25));    // soft min-variance
        outC += mean * w;
        wSum += w;
    }
    outC /= max(wSum, 1e-4);

    // Richer pigment: push saturation a touch, like layered oil.
    float lout = dot(outC, LUMA);
    outC = clamp(mix(vec3(lout), outC, 1.0 + u_richness), 0.0, 1.0);

    fragColor0 = vec4(outC, 1.0);
}
