// RELIGHT_FRAG (lib/relight/relightPass.ts at 0bfb560b9), from G() to toSrgb(): the maths
// the stage 2 facing pass ports verbatim. A test checks FACING_FRAG still contains it.
// Lighting runs in top-down layer fractions p; textures are FLIP_Y-uploaded, so vUv.y = 1 is the top.
vec2 G(vec2 p) { return vec2(p.x, 1.0 - p.y); }
// The depth field (and the normals field, same coverage) cover the whole source image; only
// the lookup is remapped through the crop. uDepthTexel is one field texel expressed in p (box)
// units, so slopes still step one texel.
vec2 fieldUv(vec2 p) { return G(uDepthRect.xy + p * uDepthRect.zw); }
float H(vec2 p) { return texture(uDepth, fieldUv(p)).r; }

vec2 slopeAt(vec2 p) {
  vec2 e = uDepthTexel * 2.0;
  float dx = (H(p + vec2(e.x, 0.)) - H(p - vec2(e.x, 0.))) / (2.0 * e.x * uAspect);
  float dy = (H(p + vec2(0., e.y)) - H(p - vec2(0., e.y))) / (2.0 * e.y);
  return vec2(dx, dy) * uRelief * 0.05;
}

vec3 normalAt(vec2 p) {
  vec2 g = slopeAt(p);
  // A depth edge is a cliff, not a surface; where the photo can't separate the two sides it is
  // smeared into a ramp that lights up as a ridge line. On a cliff, borrow the slope from a few
  // texels away on the side whose depth matches this pixel.
  float cliff = smoothstep(0.6, 1.2, length(g));
  if (cliff > 0.0) {
    vec2 o = normalize(g) * uDepthTexel * 6.0;
    float hc = H(p);
    vec2 side = abs(H(p - o) - hc) < abs(H(p + o) - hc) ? p - o : p + o;
    vec2 gs = slopeAt(side);
    gs *= 1.0 - smoothstep(0.6, 1.2, length(gs));
    g = mix(g, gs, cliff);
  }
  // Fine relief from the photo itself: brighter reads raised.
  vec2 t = uImgTexel * 1.5;
  vec3 W = vec3(0.299, 0.587, 0.114);
  float lx = dot(texture(uColor, G(p + vec2(t.x, 0.))).rgb - texture(uColor, G(p - vec2(t.x, 0.))).rgb, W);
  float ly = dot(texture(uColor, G(p + vec2(0., t.y))).rgb - texture(uColor, G(p - vec2(0., t.y))).rgb, W);
  vec2 detailSlope = vec2(lx, ly) * uDetail;
  if (uHasNormals > 0.5) {
    // A normals model's map (MoGe-2): red = right, green = UP, blue = toward the camera.
    vec3 m = texture(uNormals, fieldUv(p)).rgb * 2.0 - 1.0;
    m.y = -m.y;                                   // model map: green = up; lighting space: y down
    vec3 N = normalize(vec3(m.xy * (uRelief / 4.0), m.z) + vec3(-detailSlope * 0.5, 0.0));
    return N;
  }
  g += detailSlope;
  return normalize(vec3(-g, 1.0));
}

// Contact shadows only (a depth map can't place a long cast shadow), and occluders far in
// front of this pixel are skipped (subject vs wall would draw a wrong shifted silhouette).
float shadowTo(vec3 P, vec3 Lp) {
  vec3 d = normalize(Lp - P) * 0.06; float s = 1.0;
  float hP = P.z / max(uRelief * 0.05, 1e-4);
  for (int i = 1; i <= 24; i++) {
    float f = float(i) / 24.0;
    float t = f * f;                         // dense near the pixel: no bright sliver at edges
    vec3 q = P + d * t;
    vec2 p = vec2(q.x / uAspect, q.y);
    if (p.x < 0. || p.x > 1. || p.y < 0. || p.y > 1.) break;
    float hr = H(p);
    float near = 1.0 - smoothstep(0.06, 0.14, hr - hP);
    if (near <= 0.0) continue;
    float h = hr * uRelief * 0.05;
    s = min(s, mix(1.0, clamp(1.0 - (h - q.z - 0.003) * 40.0 * (1.0 - t), 0.0, 1.0), near));
  }
  return mix(0.45, 1.0, s);                  // never black: bounce light fills a shadow
}

vec3 toLin(vec3 c) { return pow(c, vec3(2.2)); }
vec3 toSrgb(vec3 c) { return pow(c, vec3(1.0 / 2.2)); }
